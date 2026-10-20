import { useEffect, useRef, useState } from 'react'
import { BookOpenCheck, Clock3, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { getStudyNoteByTranscriptId } from '@/domain/transcript/store'
import { generateAndSaveStudyNote } from '@/domain/studyNote/generate'
import { resolveVocabDictEntriesByKey } from '@/domain/studyNote/vocabDict'
import { addToVocab, isInVocab, makeWordId } from '@/domain/learning'
import type { StudyNoteRecord } from '@/domain/transcript/types'
import type { StudyNoteVocabulary } from '@/domain/transcript/types'
import type { Transcript } from '@/domain/transcript/types'
import type { DictEntry } from '@/domain/types'
import { ApiRequestError } from '@/data/asrClient'
import { cn } from '@/lib/utils'

/**
 * 学习稿面板（Phase 2 M2）
 * ------------------------------------------------------------------
 * 状态机：loading（挂载读库） -> idle / ready；
 * 生成：generating -> ready / failed；503 未接入 -> 空态引导（不造假）。
 *
 * 覆盖口径（评审冻结）：已有学习稿且被用户改过（source=user_modified
 * 或 status=modified）时，「重新生成」必须弹确认——upsert 会原地重置，
 * 用户修改会被覆盖，没有确认就是无声丢数据。
 *
 * 词汇跳转：segment_start 命中（生成时回匹字幕段）才可点；
 * 未命中的词点不动也不报错——如实降级（title 说明原因）。
 */

type PanelStatus = 'loading' | 'idle' | 'generating' | 'ready' | 'failed'

export function StudyNotePanel({
  transcript,
  onSeek,
}: {
  transcript: Transcript
  onSeek: (seconds: number) => void
}) {
  const [status, setStatus] = useState<PanelStatus>('loading')
  const [note, setNote] = useState<StudyNoteRecord | null>(null)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState('')
  const [notConfigured, setNotConfigured] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // 挂载读取已存学习稿（字幕幂等覆盖后 id 不变，按 transcript_id 命中）
  useEffect(() => {
    let cancelled = false
    void getStudyNoteByTranscriptId(transcript.id).then((record) => {
      if (cancelled) return
      if (record === undefined) {
        setStatus('idle')
        return
      }
      setNote(record)
      setStatus('ready')
    })
    return () => {
      cancelled = true
    }
  }, [transcript.id])

  // 卸载时中断进行中的生成（不白烧服务端 token）
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  async function generate(): Promise<void> {
    setConfirmOpen(false)
    setStatus('generating')
    setStreamText('')
    setError('')
    setNotConfigured(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const record = await generateAndSaveStudyNote(transcript, {
        onDelta: (full) => setStreamText(full),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setNote(record)
      setStatus('ready')
    } catch (e) {
      if (controller.signal.aborted) return
      if (e instanceof ApiRequestError && e.status === 503) {
        // AI 未接入：空态引导，绝不显示假学习稿
        setNotConfigured(true)
        setStatus('idle')
        return
      }
      setError(e instanceof Error ? e.message : '生成失败')
      setStatus('failed')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function requestGenerate(): void {
    // 用户改过的学习稿：重新生成会覆盖修改，先确认
    const userModified =
      note !== null && (note.source === 'user_modified' || note.status === 'modified')
    if (userModified) {
      setConfirmOpen(true)
      return
    }
    void generate()
  }

  const generating = status === 'generating'

  return (
    <Card>
      <CardBody className="space-y-3">
        {/* 头部：标题 + 来源徽标 + 操作 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">学习稿</span>
            {note !== null && (
              <Badge className={note.source === 'user_modified' ? 'bg-accent/15 text-accent' : ''}>
                {note.source === 'user_modified' ? '已修改' : 'AI 生成'}
              </Badge>
            )}
          </div>
          {status === 'ready' && (
            <Button
              variant="outline"
              size="sm"
              onClick={requestGenerate}
              aria-label="重新生成学习稿"
              title="重新生成会覆盖当前学习稿"
            >
              <RotateCcw className="h-4 w-4" /> 重新生成
            </Button>
          )}
        </div>

        {notConfigured ? (
          <EmptyState
            icon={Sparkles}
            title="AI 学习稿生成未接入"
            description="字幕转学习稿需要服务端配置 OpenAI 兼容 LLM（AI_BASE_URL / AI_API_KEY / AI_MODEL）。未接入时不返回任何结果，也不会编造学习稿。"
          />
        ) : status === 'loading' ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : status === 'idle' ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              把这份字幕交给 AI 整理为结构化学习稿：摘要、逐句双语解释、知识要点、重点词汇
              （词汇可点按跳转到对应时间段）。生成需要调用云端大模型，请耐心等待。
            </p>
            <Button className="w-full" onClick={requestGenerate} aria-label="生成学习稿">
              <Sparkles className="h-4 w-4" /> 生成学习稿
            </Button>
          </div>
        ) : generating ? (
          <div className="space-y-3" aria-live="polite">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
              AI 正在生成学习稿（已接收 {streamText.length} 字符）…
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => abortRef.current?.abort()}
              aria-label="取消生成"
            >
              <X className="h-4 w-4" /> 取消
            </Button>
          </div>
        ) : status === 'failed' ? (
          <ErrorState
            message={error || '生成失败'}
            onRetry={() => {
              setError('')
              void generate()
            }}
          />
        ) : note === null ? (
          <EmptyState
            icon={BookOpenCheck}
            title="学习稿记录为空"
            description="本地记录读取异常，请重新生成。"
          />
        ) : (
          /* 四要素分区（乳白底 divide-y，无卡片阴影——对齐视觉样板） */
          <div className="divide-y divide-border/60">
            {note.summary !== '' && (
              <section className="py-3 first:pt-0">
                <h3 className="mb-1 text-xs font-semibold text-muted-foreground">摘要</h3>
                <p className="text-sm leading-relaxed">{note.summary}</p>
              </section>
            )}

            {note.bilingual_notes.length > 0 && (
              <section className="py-3">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">双语解释</h3>
                <ul className="space-y-2">
                  {note.bilingual_notes.map((item, index) => (
                    <li key={`${item.en}-${index}`} className="text-sm leading-relaxed">
                      <p className="font-medium">{item.en}</p>
                      <p className="text-muted-foreground">{item.zh}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {note.key_points.length > 0 && (
              <section className="py-3">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">知识要点</h3>
                <ul className="list-inside list-disc space-y-1 text-sm leading-relaxed">
                  {note.key_points.map((point, index) => (
                    <li key={`${index}-${point.slice(0, 8)}`}>{point}</li>
                  ))}
                </ul>
              </section>
            )}

            {note.vocabulary.length > 0 && (
              <section className="py-3 last:pb-0">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                  重点词汇（{note.vocabulary.length}）
                </h3>
                <ul className="space-y-2">
                  {note.vocabulary.map((item, index) => (
                    <VocabCard key={`${item.word}-${index}`} item={item} onSeek={onSeek} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </CardBody>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="覆盖当前学习稿？"
        footer={
          <div className="space-y-2">
            <Button className="w-full" onClick={() => void generate()}>
              覆盖并重新生成
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
          </div>
        }
      >
        当前学习稿含你的手动修改，重新生成会覆盖这些修改，且无法撤销。
      </Dialog>
    </Card>
  )
}

/**
 * 词汇卡（M3）：dict_key 命中 → 词库权威释义/音标/例句 + AI gloss 降级为
 * 语境补充；未命中 → AI gloss + 「AI 生成」徽标。公共能力：点词跳转
 * 字幕段（有 segment_start 时）、入生词本（复用 learning 链路，幂等）。
 *
 * 多义项展开（M3 遗留回填）：落库契约只存首条 dict_key（不变），展示层
 * 用 resolveVocabDictEntriesByKey 按该词形补查全部词条——LLM pos 精确
 * 匹配的排最前，其余不同 pos 依次并列展示；同 key 去重。词条缺失
 * （dict_key 被后续 sync 变更/删除）时退出加载明示缺失，保留 AI gloss，
 * 绝不用 AI 内容冒充词典释义、也绝不永久骨架屏。
 */
function VocabCard({
  item,
  onSeek,
}: {
  item: StudyNoteVocabulary
  onSeek: (seconds: number) => void
}) {
  const [entries, setEntries] = useState<DictEntry[] | null>(null)
  const [added, setAdded] = useState(false)
  const [error, setError] = useState('')

  const fromDict = item.dict_key !== undefined

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setAdded(false)
    setError('')
    // 先取词条再按「命中词形」检查生词本——写入用的是 entry.word，
    // 检查也必须用它，否则词形不一致时（looking vs look）刷新后状态会丢
    const load = async (): Promise<void> => {
      const rows =
        item.dict_key !== undefined
          ? await resolveVocabDictEntriesByKey(item.dict_key, item.pos).catch(() => [] as DictEntry[])
          : []
      if (cancelled) return
      setEntries(rows)
      const checkWord = rows[0]?.word ?? item.word
      const v = await isInVocab(makeWordId({ word: checkWord })).catch(() => false)
      if (!cancelled) setAdded(v)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [item.dict_key, item.word, item.pos])

  async function add(): Promise<void> {
    setError('')
    try {
      // 权威优先：命中词库用词条原形/释义/音标；未命中回落 LLM 产物
      const entry = entries?.[0]
      await addToVocab({
        word: entry?.word ?? item.word,
        pos: entry?.pos ?? item.pos,
        ipa: entry?.phonetic ?? undefined,
        definition_zh: entry?.definition_zh ?? item.gloss,
      })
      setAdded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入生词本失败')
    }
  }

  // 三态：entries=null 加载中；[]词库缺失（诚实降级）；非空命中展开
  const missing = fromDict && entries !== null && entries.length === 0

  return (
    <li className="rounded-lg border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.segment_start === undefined ? (
          <span className="text-sm font-semibold" title={`未在字幕中定位到 ${item.word}，无法跳转`}>
            {item.word}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSeek(item.segment_start as number)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary transition-colors hover:text-primary/80 touch-target"
            aria-label={`${item.word}：${item.gloss}，跳转到对应时间段`}
            title={`${item.gloss} · 点按跳转到字幕位置`}
          >
            <Clock3 className="h-3.5 w-3.5" />
            {item.word}
          </button>
        )}
        {item.pos !== '' && <span className="text-xs text-muted-foreground">{item.pos}</span>}
        <Badge className={fromDict && !missing ? 'bg-primary/10 text-primary' : 'bg-accent/15 text-accent'}>
          {fromDict && !missing ? '词库' : 'AI 生成'}
        </Badge>
        <div className="ml-auto">
          {added ? (
            <span className="text-xs text-muted-foreground">已在生词本</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void add()}
              aria-label={`把 ${item.word} 加入生词本`}
              title="加入生词本（进入 SRS 复习）"
            >
              <Plus className="h-4 w-4" /> 入生词本
            </Button>
          )}
        </div>
      </div>

      <div className="mt-1.5 space-y-1 text-sm leading-relaxed">
        {!fromDict ? (
          <p>{item.gloss}</p>
        ) : entries === null ? (
          <Skeleton className="h-4 w-2/3" />
        ) : entries.length === 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              本地词库查不到该词条（词典同步后可能已变更），以下为 AI 释义：
            </p>
            <p>{item.gloss}</p>
          </>
        ) : (
          <>
            {entries.map((entry, index) => (
              <div key={entry.key} className={index > 0 ? 'border-t border-border/40 pt-1.5' : ''}>
                <div className="flex flex-wrap items-baseline gap-1.5">
                  {entry.pos !== '' && (
                    <span className="text-xs font-medium text-primary">{entry.pos}</span>
                  )}
                  {entry.phonetic !== null && entry.phonetic !== '' && (
                    <span className="font-mono text-xs text-muted-foreground">/{entry.phonetic}/</span>
                  )}
                </div>
                <p>
                  {entry.definition_zh !== '' ? entry.definition_zh : entry.definition_en}
                </p>
                {entry.examples[0] !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    {entry.examples[0].en}
                    {entry.examples[0].zh !== null && ` —— ${entry.examples[0].zh}`}
                  </p>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">AI 语境补充：{item.gloss}</p>
          </>
        )}
        {item.context !== undefined && (
          <p className="text-xs text-muted-foreground">字幕语境：{item.context}</p>
        )}
        {error !== '' && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </li>
  )
}
