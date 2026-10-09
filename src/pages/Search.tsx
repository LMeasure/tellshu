import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search as SearchIcon, Sparkles, ArrowLeft, Loader2, ScanLine } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { repository, type SearchHit } from '@/data/repository'
import {
  searchGlobal,
  type DictSearchHit,
  type GlobalWordHit,
} from '@/data/dictClient'
import { searchDictLocal, type DictHit } from '@/domain/dict'
import { addToVocab, removeFromVocab, isInVocab } from '@/domain/learning'
import { IconForward, IconStarMark } from '@/components/icons/shushu'
import { cn } from '@/lib/utils'

/**
 * 搜索 / AI 切换页（见 05 §2.2）：
 *  - 搜索模式 = 全局搜索（2026-10-06 起）：
 *      主路径走服务端 /api/search —— 内置 5 本词库（words 表）与词典扫描库
 *      （entries 表）一次返回，不再依赖本地词包加载与扫描数据手动同步；
 *      服务端不可达（离线 / 未启动）时回退本地检索（词包索引 + 已同步扫描库）。
 *  - AI 模式 = 联网问答（Phase 2 真实能力，此处占位）。
 *
 * 点结果 → 进单词详情页 /word/:word（详情页自己按需加载完整词条）。
 *
 * 单词卡图标（需求 17 / 19）：
 *  - 右上角 8 号星 = 收藏（加入生词本）：实心橙=已收藏，空心=未收藏；
 *  - 右侧 6 号细右箭头 = 去详情页。
 */

/** 结果卡所需的最小字段：服务端命中与本地回退命中统一映射到这，渲染层不再分叉 */
interface WordCardHit {
  id: string
  word: string
  ipa: string | null
  pos: string | null
  zh: string
  bookName: string
  bookNames: string[]
  /** 收藏（加入生词本）用：主词本 id */
  book: string
}

interface DictCardHit {
  key: string
  word: string
  pos: string
  phonetic: string | null
  definitionZh: string
}

function fromGlobalWord(w: GlobalWordHit): WordCardHit {
  return {
    id: w.id,
    word: w.word,
    ipa: w.ipa,
    pos: w.pos,
    zh: w.definitionZh,
    bookName: w.books[0]?.name ?? '',
    bookNames: w.books.map((b) => b.name),
    book: w.books[0]?.id ?? '',
  }
}

function fromLocalHit(h: SearchHit): WordCardHit {
  return {
    id: h.id,
    word: h.word,
    ipa: h.ipa,
    pos: h.pos,
    zh: h.zh ?? '',
    bookName: h.bookName,
    bookNames: h.bookNames,
    book: h.book,
  }
}

function fromServerEntry(h: DictSearchHit): DictCardHit {
  return {
    key: h.id,
    word: h.word,
    pos: h.pos,
    phonetic: h.phonetic,
    definitionZh: h.definitionZh,
  }
}

function fromLocalDict(h: DictHit): DictCardHit {
  return {
    key: h.entry.key,
    word: h.entry.word,
    pos: h.entry.pos,
    phonetic: h.entry.phonetic,
    definitionZh: h.entry.definition_zh,
  }
}

export function Search() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const mode = params.get('mode') === 'ai' ? 'ai' : 'search'

  const [wordHits, setWordHits] = useState<WordCardHit[] | null>(null)
  /** 词典扫描库命中（服务端或本地回退，与内置词库相互独立） */
  const [dictHits, setDictHits] = useState<DictCardHit[] | null>(null)
  /** 收藏状态（词 id → 是否已在生词本），随结果批量查一次 */
  const [favMap, setFavMap] = useState<Record<string, boolean>>({})
  /** true = 服务端不可达，本次结果是本地回退（空态文案要如实说明） */
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (mode !== 'search') return
    let alive = true
    setWordHits(null)
    setDictHits(null)
    setFavMap({})
    setOffline(false)

    /** 结果就绪后的公共收尾：批量查收藏态（词数最多几十条，IndexedDB 足够快） */
    function finishWords(words: WordCardHit[]) {
      setWordHits(words)
      Promise.all(words.map(async (h) => [h.id, await isInVocab(h.id)] as const))
        .then((pairs) => {
          if (!alive) return
          setFavMap(Object.fromEntries(pairs))
        })
        .catch(() => undefined)
    }

    // 主路径：服务端全局搜索
    searchGlobal(q, 40)
      .then((r) => {
        if (!alive) return
        finishWords(r.words.map(fromGlobalWord))
        setDictHits(r.hits.map(fromServerEntry))
      })
      .catch(() => {
        // 回退：服务端不可达（离线 / 未启动）→ 本地词库索引 + 已同步扫描库
        if (!alive) return
        setOffline(true)
        Promise.all([repository.searchAllWords(q), searchDictLocal(q, 6)])
          .then(([localHits, localDict]) => {
            if (!alive) return
            finishWords(localHits.map(fromLocalHit))
            setDictHits(localDict.map(fromLocalDict))
          })
          .catch(() => {
            if (!alive) return
            setWordHits([])
            setDictHits([])
          })
      })
    return () => {
      alive = false
    }
  }, [q, mode])

  /** 需求 17：再点一次真的取消收藏（星变空心），不是只改 UI */
  async function toggleFav(hit: WordCardHit) {
    if (favMap[hit.id]) {
      await removeFromVocab(hit.id)
      setFavMap((m) => ({ ...m, [hit.id]: false }))
      return
    }
    await addToVocab({
      id: hit.id,
      word: hit.word,
      book: hit.book,
      ipa: hit.ipa ?? undefined,
      definition_zh: hit.zh || undefined,
      pos: hit.pos ?? undefined,
    })
    setFavMap((m) => ({ ...m, [hit.id]: true }))
  }

  /** 点某条结果：跳到该单词的详情页 */
  function openDetail(hit: WordCardHit) {
    navigate(`/word/${encodeURIComponent(hit.word)}`)
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <ArrowLeft className="h-4 w-4" />
        {mode === 'ai' ? (
          <span className="flex items-center gap-1">
            <Sparkles className="h-4 w-4 text-accent" /> AI 问答
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <SearchIcon className="h-4 w-4" /> 搜索：{q || '（空）'}
          </span>
        )}
      </div>

      {mode === 'ai' ? (
        <EmptyState
          icon={Sparkles}
          title="AI 问答即将上线"
          description="AI 模式需联网调用大模型（解释单词、生成例句、对话陪练）。Phase 0 用静态模板兜底，真实能力在 Phase 2 接入。"
        />
      ) : !q.trim() ? (
        <EmptyState
          icon={SearchIcon}
          title="输入关键词开始搜索"
          description="一次搜索覆盖全部 5 个词本（22,791 词）与词典扫描库，支持英文单词与中文释义。"
        />
      ) : wordHits === null || dictHits === null ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在搜索全部词库…
        </div>
      ) : wordHits.length === 0 && dictHits.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title="该词暂未收录"
          description={
            offline
              ? '服务端不可达，已检索本地缓存。恢复联网后再试，或换个拼写 / 只输入词根。'
              : '换个拼写或只输入词根试试；新扫描的词典页确认入库后即可搜到。'
          }
        />
      ) : (
        <>
          {wordHits.length > 0 ? (
            <>
              <div className="mb-2 text-xs text-muted-foreground">
                全词库命中 {wordHits.length} 条
              </div>
              <div className="space-y-2">
                {wordHits.map((h) => {
                  const fav = favMap[h.id] === true
                  return (
                    <div
                      key={h.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openDetail(h)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openDetail(h)
                      }}
                      className="relative w-full cursor-pointer rounded-lg border border-border/60 bg-card p-3 pr-12 text-left shadow-soft touch-target"
                    >
                      {/* 右上角收藏星（8 号：实心橙=已收藏 / 空心=未收藏） */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void toggleFav(h)
                        }}
                        className="absolute right-2.5 top-2 flex h-9 w-9 items-center justify-center rounded-full"
                        aria-label={fav ? '已收藏' : '收藏'}
                        title={fav ? '已收藏（在生词本）' : '收藏（加入生词本）'}
                      >
                        <IconStarMark
                          filled={fav}
                          className={cn('h-[18px] w-[18px]', fav ? 'text-accent' : 'text-muted-foreground')}
                        />
                      </button>

                      <div className="flex items-baseline gap-2">
                        <span className="text-lg font-semibold">{h.word}</span>
                        {h.pos && <span className="text-xs text-muted-foreground">{h.pos}</span>}
                        <span className="ml-auto mr-8 flex shrink-0 items-center gap-1">
                          <Badge>{h.bookName}</Badge>
                          {h.bookNames.length > 1 && <Badge>+{h.bookNames.length - 1}</Badge>}
                        </span>
                      </div>
                      {h.ipa && <div className="text-xs text-muted-foreground">/{h.ipa}/</div>}
                      {h.zh && (
                        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-foreground/90">
                          {h.zh}
                        </p>
                      )}

                      {/* 右侧去详情页（6 号细右箭头） */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openDetail(h)
                        }}
                        className="absolute bottom-2.5 right-2 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                        aria-label={`查看「${h.word}」详情`}
                        title="去详情页"
                      >
                        <IconForward className="h-4 w-4" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <p className="mb-3 text-xs text-muted-foreground">
              内置词库没有命中，以下来自词典扫描库。
            </p>
          )}

          {/* 词典扫描库命中：点击进同一个详情页，扫描数据以「词典扫描」分区展示 */}
          {dictHits.length > 0 ? (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
                <ScanLine className="h-3.5 w-3.5" aria-hidden />
                词典扫描库命中 {dictHits.length} 条
              </div>
              <div className="space-y-2">
                {dictHits.map((h) => (
                  <div
                    key={h.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/word/${encodeURIComponent(h.word)}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/word/${encodeURIComponent(h.word)}`)
                    }}
                    className="w-full cursor-pointer rounded-lg border border-border/60 bg-card p-3 text-left shadow-soft touch-target"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-semibold">{h.word}</span>
                      {h.pos !== '' && (
                        <span className="text-xs text-muted-foreground">{h.pos}</span>
                      )}
                      <span className="ml-auto">
                        <Badge>词典扫描</Badge>
                      </span>
                    </div>
                    {h.phonetic !== null && h.phonetic !== '' && (
                      <div className="text-xs text-muted-foreground">/{h.phonetic}/</div>
                    )}
                    {h.definitionZh !== '' && (
                      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-foreground/90">
                        {h.definitionZh}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
