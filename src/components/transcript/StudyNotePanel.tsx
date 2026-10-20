import { useEffect, useRef, useState } from 'react'
import { BookOpenCheck, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { getStudyNoteByTranscriptId } from '@/domain/transcript/store'
import { generateAndSaveStudyNote } from '@/domain/studyNote/generate'
import type { StudyNoteRecord } from '@/domain/transcript/types'
import type { Transcript } from '@/domain/transcript/types'
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
                <ul className="flex flex-wrap gap-2">
                  {note.vocabulary.map((item, index) =>
                    item.segment_start === undefined ? (
                      <li
                        key={`${item.word}-${index}`}
                        title={`${item.gloss}（未在字幕中定位到 ${item.word}，无法跳转）`}
                      >
                        <Badge className="h-auto py-1">
                          <span className="font-semibold">{item.word}</span>
                          {item.pos !== '' && (
                            <span className="ml-1 text-muted-foreground">{item.pos}</span>
                          )}
                          <span className="ml-1">{item.gloss}</span>
                        </Badge>
                      </li>
                    ) : (
                      <li key={`${item.word}-${index}`}>
                        <button
                          type="button"
                          onClick={() => onSeek(item.segment_start as number)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs',
                            'font-medium text-primary transition-colors hover:bg-primary/20 touch-target',
                          )}
                          aria-label={`${item.word}：${item.gloss}，跳转到对应时间段`}
                          title={`${item.gloss} · 点按跳转到字幕位置`}
                        >
                          <span className="font-semibold">{item.word}</span>
                          {item.pos !== '' && (
                            <span className="text-muted-foreground">{item.pos}</span>
                          )}
                          <span>{item.gloss}</span>
                        </button>
                      </li>
                    ),
                  )}
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
