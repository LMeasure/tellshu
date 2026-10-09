import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, Highlighter, MessageSquarePlus, Volume2, Mail } from 'lucide-react'
import {
  ANNOTATION_COLOR_HEX,
  ANNOTATION_COLOR_OPTIONS,
  ANNOTATION_STYLE_OPTIONS,
} from '@/lib/annotate'
import type { AnnotationColor, AnnotationStyle } from '@/domain/types'
import { cn } from '@/lib/utils'

/**
 * 划词浮窗（2026-10-07 需求 5；2026-10-08 V2.0 修复定位）
 * ------------------------------------------------------------------
 * 长按滑动选中正文文字后浮出小弹窗：
 *   听书（朗读选区）· 复制 · 划线（样式 × 五色）· 写想法 · 反馈（mailto）
 *
 * 定位修复（Bug：与系统选择菜单重叠 / 划线面板出框）：
 *   · 默认放在**选区下方**（系统自带的「复制/全选/搜一搜」菜单占据选区上方，
 *     放下方即可避开重叠）；下方放不下时才翻到上方。
 *   · 展开划线样式行后重新测量高度，横纵都夹在视口内，绝不出框。
 *   · 宽度上限 92vw，内容自动换行。
 * 交互期间 onInteract 通知父级「不要因 selectionchange 清空选区」。
 */

interface Props {
  /** 选区位置（视口坐标） */
  rect: DOMRect
  defaultStyle: AnnotationStyle
  defaultColor: AnnotationColor
  onListen: () => void
  onCopy: () => void
  onAnnotate: (style: AnnotationStyle, color: AnnotationColor) => void
  onThought: () => void
  onFeedback: () => void
  /** 用户开始与弹窗交互（父级据此冻结选区，避免被 selectionchange 清空） */
  onInteract?: () => void
}

export const FEEDBACK_MAILTO = 'mailto:2878747585@qq.com?subject=%E8%BF%B0%E6%A0%91%E5%8F%8D%E9%A6%88'

const GAP = 12
const EDGE = 8

export function SelectionPopup({
  rect,
  defaultStyle,
  defaultColor,
  onListen,
  onCopy,
  onAnnotate,
  onThought,
  onFeedback,
  onInteract,
}: Props) {
  const [styleOpen, setStyleOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // 渲染后（含展开样式行后）重新测量并夹紧到视口内
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const h = el.offsetHeight || 48
    const w = el.offsetWidth || 260
    const vw = window.innerWidth
    const vh = window.innerHeight

    // 纵向：优先放选区下方（避开系统菜单），放不下再放上方，都放不下则夹住
    let top: number
    if (rect.bottom + GAP + h <= vh - EDGE) {
      top = rect.bottom + GAP
    } else if (rect.top - GAP - h >= EDGE) {
      top = rect.top - GAP - h
    } else {
      top = Math.max(EDGE, Math.min(rect.bottom + GAP, vh - h - EDGE))
    }
    const left = Math.min(Math.max(EDGE, rect.left + rect.width / 2 - w / 2), Math.max(EDGE, vw - w - EDGE))
    setPos({ top, left })
  }, [rect, styleOpen])

  return (
    <div
      ref={boxRef}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="fixed z-50 max-w-[92vw] rounded-xl border border-border bg-card p-1.5 shadow-soft"
      onPointerDown={(e) => {
        e.stopPropagation()
        onInteract?.()
      }}
      data-testid="selection-popup"
    >
      {/* 主行：听书 / 复制 / 划线 / 写想法 / 反馈 */}
      <div className="flex items-center gap-0.5">
        <PopBtn icon={Volume2} label="听书" onClick={onListen} />
        <PopBtn icon={Copy} label="复制" onClick={onCopy} />
        <PopBtn
          icon={Highlighter}
          label="划线"
          active={styleOpen}
          onClick={() => setStyleOpen((v) => !v)}
        />
        <PopBtn icon={MessageSquarePlus} label="写想法" onClick={onThought} />
        <PopBtn icon={Mail} label="反馈" onClick={onFeedback} />
      </div>

      {/* 划线行：三种样式 + 五种颜色，点按即应用（记住最近一次选择） */}
      {styleOpen && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-border px-1 pt-1.5">
          <div className="flex gap-1">
            {ANNOTATION_STYLE_OPTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => onAnnotate(s.key, defaultColor)}
                aria-label={`划线：${s.label}`}
                title={`划线：${s.label}`}
                className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary touch-target-sm"
              >
                <svg viewBox="0 0 28 8" className="h-2 w-7">
                  {s.key === 'highlight' ? (
                    <rect x="0" y="1" width="28" height="6" rx="2" fill={ANNOTATION_COLOR_HEX[defaultColor]} opacity="0.45" />
                  ) : s.key === 'underline' ? (
                    <line x1="1" y1="5" x2="27" y2="5" stroke={ANNOTATION_COLOR_HEX[defaultColor]} strokeWidth="2.5" />
                  ) : (
                    <path
                      d="M1 5 Q5 1.5 9 5 T17 5 T25 5"
                      fill="none"
                      stroke={ANNOTATION_COLOR_HEX[defaultColor]}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-1.5">
            {ANNOTATION_COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => onAnnotate(defaultStyle, c)}
                aria-label={`划线颜色：${c}`}
                title={`划线颜色：${c}`}
                className={cn(
                  'h-5 w-5 rounded-full border-2 touch-target-sm',
                  defaultColor === c ? 'border-foreground' : 'border-transparent',
                )}
                style={{ backgroundColor: ANNOTATION_COLOR_HEX[c] }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PopBtn({
  icon: Icon,
  label,
  onClick,
  active,
}: {
  icon: typeof Copy
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] touch-target-sm',
        active ? 'bg-secondary text-primary' : 'text-muted-foreground hover:bg-secondary',
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
      {label}
    </button>
  )
}
