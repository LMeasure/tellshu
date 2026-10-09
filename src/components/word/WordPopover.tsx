import { Loader2, Volume2 } from 'lucide-react'
import { IconForward } from '@/components/icons/shushu'
import type { ContentWord } from '@/data/types'
import { speakFocused, isSpeechSupported } from '@/lib/speech'

/**
 * 例句里点某个单词后的小弹窗（需求 6 / 7）
 * ------------------------------------------------------------------
 *  - 显示该单词（查词库得到的）音标 + 中文释义；
 *  - 「查看详情」跳到该单词的详情页；
 *  - 词库没收录就如实说没收录，不猜释义（项目铁律）。
 *
 * 定位：以被点词的矩形为锚点，默认挂在下方；下方空间不够就翻到上方。
 * 用 fixed + viewport 坐标，不受父容器滚动影响。
 */

const WIDTH = 268
const EST_HEIGHT = 168

export function WordPopover({
  raw,
  matched,
  data,
  loading,
  rect,
  onClose,
  onDetail,
}: {
  /** 用户点的原词（可能是 books 这种屈折形式） */
  raw: string
  /** 实际在词库里查到的词形（可能已还原） */
  matched: string | null
  data: ContentWord | null
  loading: boolean
  rect: DOMRect
  onClose: () => void
  onDetail: (word: string) => void
}) {
  const vw = typeof window === 'undefined' ? 375 : window.innerWidth
  const vh = typeof window === 'undefined' ? 667 : window.innerHeight
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - WIDTH / 2), Math.max(8, vw - WIDTH - 8))
  const below = rect.bottom + 8
  const top = below + EST_HEIGHT > vh ? Math.max(8, rect.top - EST_HEIGHT - 8) : below

  const target = data?.word ?? null

  return (
    <>
      {/* 点空白处关闭；用 pointerdown 避免和单词自身的 click 打架 */}
      <div className="fixed inset-0 z-40" onPointerDown={onClose} />
      <div
        className="fixed z-50 rounded-xl border border-border bg-card p-3 shadow-soft"
        style={{ left, top, width: WIDTH }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold text-foreground">{raw}</span>
          {data?.ipa ? <span className="text-xs text-muted-foreground">/{data.ipa}/</span> : null}
          {target && isSpeechSupported() ? (
            <button
              type="button"
              onClick={() => void speakFocused(target, false)}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-primary"
              aria-label="朗读这个单词"
              title="朗读"
            >
              <Volume2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="mt-1.5 min-h-[42px] text-sm leading-relaxed text-foreground">
          {loading ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在查词…
            </span>
          ) : data?.definition_zh ? (
            <span>{data.definition_zh}</span>
          ) : data?.definition_en ? (
            <span>{data.definition_en}</span>
          ) : (
            <span className="text-muted-foreground">词库未收录这个词，暂时没有释义</span>
          )}
        </div>

        {matched && matched.toLowerCase() !== raw.toLowerCase() ? (
          <p className="mt-1 text-[11px] text-muted-foreground">按原形「{matched}」查到</p>
        ) : null}

        <button
          type="button"
          disabled={!target}
          onClick={() => target && onDetail(target)}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          查看详情 <IconForward className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}
