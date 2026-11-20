import { Volume2, Mic, Square, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { tokenize } from '@/lib/masking'
import { stripWordPunct } from '@/lib/wordSense'
import { speakFocused, isSpeechSupported } from '@/lib/speech'
import { scoreRemark } from '@/lib/followScore'
import { useFollowMic } from '@/hooks/useFollowMic'
import { useAppStore } from '@/store/useAppStore'

/**
 * 一条例句（需求 11 / 12 + 本轮版式）
 * ------------------------------------------------------------------
 * 版式：
 *  - 句子在左、**完整展示不截断**（长句换行、超长单词可断行）；
 *  - 播放 / 录音按钮在**右侧**，与例句同行（原来是左侧下方）；
 *  - 不自带圆角边框卡片：由外层用淡灰横线分隔（需求 8：横线、无阴影）；
 *  - 按钮 44×44，符合触摸目标下限。
 * 交互：
 *  - 喇叭：播放这句英文（走 audioBus 抢占，正在听书时先让位；口音跟随设置）；
 *  - 麦克风：跟读评分，逻辑见 hooks/useFollowMic（真实识别优先，降级标注「模拟」）；
 *  - 句子里每个单词可点：交给父组件弹释义窗。
 */
export function ExampleRow({
  en,
  zh,
  index,
  score,
  realScore,
  onScore,
  onWordClick,
  activeWord,
}: {
  en: string
  zh?: string
  index: number
  score: number | null
  /** true = 真实识别分；false = 模拟分（UI 必须标注） */
  realScore: boolean
  onScore: (score: number, real: boolean) => void
  onWordClick: (token: string, rect: DOMRect) => void
  activeWord?: string | null
}) {
  const slow = useAppStore((s) => s.settings.speed === 'slow')
  const accent = useAppStore((s) => s.settings.accent)
  const { phase, msg, toggle } = useFollowMic(onScore)

  const canSpeak = isSpeechSupported()

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2">
        {/* 句子：完整展示，不截断 */}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
            {tokenize(en, 'en').map((tk, i) => {
              if (!tk.word) return <span key={i}>{tk.t}</span>
              const raw = stripWordPunct(tk.t)
              if (!raw) return <span key={i}>{tk.t}</span>
              const active =
                activeWord !== null &&
                activeWord !== undefined &&
                raw.toLowerCase() === activeWord.toLowerCase()
              return (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onWordClick(raw, e.currentTarget.getBoundingClientRect())
                  }}
                  className={cn(
                    'rounded px-0.5 transition-colors',
                    active ? 'bg-primary/15 text-primary' : 'hover:bg-primary/10 hover:text-primary',
                  )}
                >
                  {tk.t}
                </button>
              )
            })}
          </p>
          {zh ? (
            <p data-testid="example-zh" className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
              {zh}
            </p>
          ) : null}
        </div>

        {/* 播放 / 录音：右侧、与例句同行（需求 11） */}
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => void speakFocused(en, slow, undefined, accent)}
            disabled={!canSpeak}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-primary disabled:opacity-40"
            aria-label={`播放第 ${index + 1} 句英文`}
            title="播放这句英文"
          >
            <Volume2 className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => void toggle(en)}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-full',
              phase === 'recording'
                ? 'bg-destructive text-white'
                : phase === 'recognizing'
                  ? 'bg-primary text-white'
                  : 'bg-secondary text-primary',
            )}
            aria-label={
              phase === 'recording'
                ? '停止录音并评分'
                : phase === 'recognizing'
                  ? '正在识别'
                  : `跟读第 ${index + 1} 句并评分`
            }
            title={
              phase === 'recording'
                ? '停止录音并评分'
                : phase === 'recognizing'
                  ? '正在识别'
                  : '跟读这句并评分'
            }
          >
            {phase === 'recognizing' ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            ) : phase === 'recording' ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>
      </div>

      {score !== null ? (
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold',
              score >= 80
                ? 'bg-primary/12 text-primary'
                : score >= 60
                  ? 'bg-amber-500/12 text-amber-600'
                  : 'bg-destructive/12 text-destructive',
            )}
          >
            {score} 分
            {!realScore && <span className="font-normal opacity-70">·模拟</span>}
          </span>
          <span className="text-xs text-muted-foreground">{scoreRemark(score)}</span>
        </div>
      ) : null}

      {msg ? <p className="mt-1.5 text-xs text-muted-foreground">{msg}</p> : null}
      {phase === 'recording' ? (
        <p className="mt-1.5 text-xs text-destructive">正在录音…再点一次麦克风结束</p>
      ) : null}
      {phase === 'recognizing' ? (
        <p className="mt-1.5 text-xs text-primary">正在听你读…</p>
      ) : null}
    </div>
  )
}
