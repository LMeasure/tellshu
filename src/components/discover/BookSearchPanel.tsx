import { useEffect, useRef, useState } from 'react'
import { BookOpen, BookmarkPlus, Check, Loader2, Search as SearchIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { OfflineNotice } from '@/components/OfflineNotice'
import { useOnline } from '@/lib/offline'
import {
  DISCOVER_SOURCE_SITE,
  isShelfableBookId,
  searchBooks,
  BookSearchError,
  type BookHit,
} from '@/domain/discover/search'
import { isBookShelved, shelveDiscoveredBook } from '@/domain/learning'

/**
 * 找书面板（Discover 页第 4 Tab，M4 之后接入）
 * ------------------------------------------------------------------
 * 产品行为口径：
 *   - 入口：语义 query 输入框（中英皆可，上限 500 字符 = 服务端口径），
 *     空 query 按钮禁用、回车不触发——本地拦截，不发请求。
 *   - 加载：Loader2 + 「正在检索 30 本公版书…」；进行中新请求顶掉旧请求
 *     （AbortController），按钮禁用防重复提交。
 *   - 空结果：EmptyState 建议换说法（当前 46,563 个章节块在库，
 *     结构上不易为空，但契约允许 results=[]，如实处理不伪造）。
 *   - 错误：ErrorState + 重试按钮；按失败分类给文案——
 *     unavailable（服务未启动）/ timeout（超时）/ bad_request（参数），
 *     5xx 由域层自动重试（最多 3 次尝试），到这里已是重试后仍失败。
 *   - 离线：OfflineNotice 提示需联网；按 lib/offline 口径，onLine
 *     只决定文案、不拦截请求（请求照发，失败自然走错误态）。
 *   - 无书籍详情页：卡片仍不可跳转（不造路由）。唯一动作是「入架」，
 *     把发现书快照写入本地书架；正文不在本地，成功 toast 写明待接入。
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; hits: BookHit[]; e2eMs: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; retryable: boolean }

const BOOKS_HINT = '30 本公版英文原著'

/** 失败分类 → 用户可读文案（4xx 不重试的结论也如实说明） */
function errorMessage(error: BookSearchError): { message: string; retryable: boolean } {
  switch (error.kind) {
    case 'unavailable':
      return {
        message: '检索服务未启动。本地联调需先启动检索 API（api/ 目录 uvicorn 8000）。',
        retryable: true,
      }
    case 'timeout':
      return { message: '检索超时，请稍后重试。', retryable: true }
    case 'bad_request':
      return { message: `检索请求被拒绝：${error.message}`, retryable: false }
    case 'server_error':
      return { message: '检索服务暂时不可用（已自动重试 3 次）。', retryable: true }
    case 'bad_response':
      return { message: '检索响应异常，请稍后重试或联系反馈。', retryable: true }
    default:
      return { message: error.message, retryable: true }
  }
}

export function BookSearchPanel() {
  const [text, setText] = useState('')
  /** 已提交并触发的 query（空 = 还没搜过；与输入框文本解耦，便于重试） */
  const [submitted, setSubmitted] = useState('')
  /** 重试次数：点「重试」时自增，变化即重新触发检索（setSubmitted 同值不触发） */
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /** 本轮已入架的 book_id。按钮据此在「入架 / 已在书架」之间切换。 */
  const [shelved, setShelved] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const shelvePendingRef = useRef<Set<string>>(new Set())
  const offline = !useOnline()

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2600)
  }

  useEffect(() => {
    if (submitted === '') return
    const controller = new AbortController()
    abortRef.current?.abort() // 上一轮没结束也要顶掉
    abortRef.current = controller
    setPhase({ kind: 'loading' })

    searchBooks(submitted, { signal: controller.signal })
      .then((outcome) => {
        if (controller.signal.aborted) return
        setPhase(
          outcome.hits.length === 0
            ? { kind: 'empty' }
            : { kind: 'done', hits: outcome.hits, e2eMs: outcome.e2eMs },
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof BookSearchError) {
          const { message, retryable } = errorMessage(error)
          setPhase({ kind: 'error', message, retryable })
        } else {
          setPhase({ kind: 'error', message: '检索失败，请稍后重试。', retryable: true })
        }
      })
    return () => controller.abort()
  }, [submitted, attempt])

  useEffect(() => {
    if (phase.kind !== 'done') return
    let alive = true
    const ids = [
      ...new Set(phase.hits.map((h) => h.bookId).filter((id) => isShelfableBookId(id))),
    ]
    void Promise.all(
      ids.map(async (bookId) => ((await isBookShelved(DISCOVER_SOURCE_SITE, bookId)) ? bookId : null)),
    )
      .then((flags) => {
        if (!alive) return
        setShelved((prev) => {
          const next = new Set(prev)
          for (const id of flags) if (id) next.add(id)
          return next
        })
      })
      .catch(() => {
        // 读书架失败不挡住检索结果；入架按钮仍可点，失败另有 toast。
      })
    return () => {
      alive = false
    }
  }, [phase])

  function submit() {
    if (text.trim() === '') return
    setSubmitted(text.trim())
  }

  async function onShelve(hit: BookHit) {
    // 不只拒绝 ''。非字符串、null/undefined、空串、纯空白都不进入入架。
    const bookId = hit.bookId
    if (!isShelfableBookId(bookId)) return
    if (shelved.has(bookId) || shelvePendingRef.current.has(bookId)) return
    shelvePendingRef.current.add(bookId)
    try {
      await shelveDiscoveredBook({
        title: hit.title,
        author: hit.author,
        source_site: DISCOVER_SOURCE_SITE,
        source_id: bookId,
      })
      setShelved((prev) => {
        const next = new Set(prev)
        next.add(bookId)
        return next
      })
      showToast('已加入书架，可在首页书架查看（正文待接入）')
    } catch {
      showToast('加入书架失败，请稍后重试')
    } finally {
      shelvePendingRef.current.delete(bookId)
    }
  }

  const loading = phase.kind === 'loading'

  return (
    <div className="space-y-3">
      {offline && (
        <OfflineNotice>找书需要联网检索（{BOOKS_HINT}在服务端）。恢复联网后再试。</OfflineNotice>
      )}

      <div className="flex gap-2">
        <input
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="用一句话描述想找的情节，如：为爱复仇的贵族青年"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <Button onClick={submit} disabled={text.trim() === '' || loading} className="shrink-0">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SearchIcon className="h-4 w-4" />
          )}
          搜索
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        中文或英文描述均可，在{BOOKS_HINT}里做语义检索（来自 Project Gutenberg 公版库）。
      </p>

      {phase.kind === 'idle' ? (
        <EmptyState
          icon={BookOpen}
          title="描述情节，找一本想读的书"
          description="例如「沙漠岛屿上的沉船求生」「两大家族的世仇爱情」。检索按语义匹配，不必精确说出书名。"
        />
      ) : phase.kind === 'loading' ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在检索{BOOKS_HINT}…
        </div>
      ) : phase.kind === 'empty' ? (
        <EmptyState
          icon={BookOpen}
          title="没有找到相关的书"
          description="换个说法试试：多描述情节、人物或场景，少用抽象主题词。"
        />
      ) : phase.kind === 'error' ? (
        <ErrorState
          message={phase.message}
          onRetry={phase.retryable ? () => setAttempt((n) => n + 1) : undefined}
        />
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>命中 {phase.hits.length} 个片段</span>
            <span>本次检索 {phase.e2eMs.toFixed(0)} ms</span>
          </div>
          <div className="space-y-2">
            {phase.hits.map((h, i) => {
              const shelfable = isShelfableBookId(h.bookId)
              const onShelf = shelfable && shelved.has(h.bookId)
              const shelveLabel = onShelf ? '已在书架' : '入架'
              return (
                <div
                  key={`${h.bookId}-${h.chunkId}-${h.chunkIndex}-${i}`}
                  className="w-full rounded-lg border border-border/60 bg-card p-3 text-left shadow-soft"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{h.title}</span>
                    <span className="ml-auto shrink-0">
                      <Badge>相似度 {h.score.toFixed(2)}</Badge>
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {h.author}
                    {h.chapterTitle !== null && h.chapterTitle !== '' && ` · ${h.chapterTitle}`}
                  </div>
                  <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-foreground/90">
                    {h.content}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2 h-9 px-3 text-xs"
                    disabled={onShelf || !shelfable}
                    aria-label={onShelf ? `《${h.title}》已在书架` : `将《${h.title}》入架`}
                    title={shelveLabel}
                    onClick={() => void onShelve(h)}
                  >
                    {onShelf ? <Check className="h-4 w-4" /> : <BookmarkPlus className="h-4 w-4" />}
                    {shelveLabel}
                  </Button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-6">
          <div className="rounded-full bg-foreground/90 px-4 py-2 text-xs text-background shadow-soft">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}
