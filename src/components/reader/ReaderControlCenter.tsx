import { useEffect, useRef, useState } from 'react'
import {
  Bookmark,
  Gauge,
  List,
  Music,
  SlidersHorizontal,
  StickyNote,
  Trash2,
} from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { NotesPanel, type NotesPanelProps } from '@/components/reader/NotesSheet'
import {
  ListenPanel,
  SettingsPanel,
  type ListenPanelProps,
  type MemoPanelProps,
} from '@/components/reader/ReaderSettingsSheet'
import type { ReaderPrefs } from '@/store/useAppStore'
import type { ReadingBookmark } from '@/domain/types'

/**
 * 综合控制中心 V3.0（2026-10-09 需求一）
 * ------------------------------------------------------------------
 * 底部弹窗升级为「综合控制中心」：顶部固定 5 项导航 ——
 *   目录 / 笔记 / 进度 / 听书 / 设置，点击切换下方内容区。
 * 显隐：单击正文 Toggle 呼出/隐藏；点击面板外空白关闭；面板内部一律
 * stopPropagation，避免拖滑块 / 输页码 / 切导航时误关。
 */

export type PanelTab = 'toc' | 'notes' | 'progress' | 'listen' | 'settings'

const NAV: { key: PanelTab; label: string; icon: typeof List }[] = [
  { key: 'toc', label: '目录', icon: List },
  { key: 'notes', label: '笔记', icon: StickyNote },
  { key: 'progress', label: '进度', icon: Gauge },
  { key: 'listen', label: '听书', icon: Music },
  { key: 'settings', label: '设置', icon: SlidersHorizontal },
]

export interface TocPanelProps {
  page: number
  /** 章节（已解析出所属页码） */
  chapters: { title: string; page: number }[]
  bookmarks: ReadingBookmark[]
  pageBookmark: ReadingBookmark | undefined
  paraPreview: (para: number) => string
  onToggleBookmark: () => void
  onJumpPage: (page: number) => void
  onRemoveBookmark: (id: string) => void
}

export interface ProgressPanelProps {
  page: number
  pageCount: number
  onGoto: (page: number) => void
}

interface Props {
  open: boolean
  tab: PanelTab
  onTabChange: (t: PanelTab) => void
  onClose: () => void
  toc: TocPanelProps
  notes: NotesPanelProps
  progress: ProgressPanelProps
  listen: ListenPanelProps
  settings: {
    tab: 'read' | 'memo'
    onTabChange: (t: 'read' | 'memo') => void
    prefs: ReaderPrefs
    onChange: (patch: Partial<ReaderPrefs>) => void
    memo: MemoPanelProps
  }
}

export function ReaderControlCenter({
  open,
  tab,
  onTabChange,
  onClose,
  toc,
  notes,
  progress,
  listen,
  settings,
}: Props) {
  return (
    <Sheet open={open} onClose={onClose} className="!px-0 !pt-0">
      {/* 面板内部一律 stopPropagation：拖滑块 / 输页码 / 切导航不触发关闭 */}
      <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <div className="px-4 pt-1">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
          {/* 顶部 5 项导航 */}
          <div className="flex items-center justify-between gap-1" role="tablist">
            {NAV.map((n) => {
              const active = n.key === tab
              const Icon = n.icon
              return (
                <button
                  key={n.key}
                  role="tab"
                  aria-selected={active}
                  aria-label={n.label}
                  title={n.label}
                  onClick={() => onTabChange(n.key)}
                  className={cn(
                    'flex flex-1 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors touch-target',
                    active ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-secondary',
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {n.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="max-h-[62vh] overflow-y-auto px-4 pb-4 pt-4">
          {tab === 'toc' && <TocPanel {...toc} />}
          {tab === 'notes' && <NotesPanel {...notes} />}
          {tab === 'progress' && <ProgressPanel {...progress} />}
          {tab === 'listen' && <ListenPanel {...listen} />}
          {tab === 'settings' && (
            <SettingsPanel
              tab={settings.tab}
              onTabChange={settings.onTabChange}
              prefs={settings.prefs}
              onChange={settings.onChange}
              memo={settings.memo}
            />
          )}
        </div>
      </div>
    </Sheet>
  )
}

/* ============================ 目录面板 ============================ */

function TocPanel({
  page,
  chapters,
  bookmarks,
  pageBookmark,
  paraPreview,
  onToggleBookmark,
  onJumpPage,
  onRemoveBookmark,
}: TocPanelProps) {
  const sorted = [...bookmarks].sort((a, b) => a.page - b.page)
  return (
    <div className="space-y-3">
      <button
        onClick={onToggleBookmark}
        className="flex w-full items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2.5 text-left text-sm touch-target"
      >
        <Bookmark
          className={cn('h-4 w-4', pageBookmark ? 'fill-primary text-primary' : 'text-muted-foreground')}
        />
        {pageBookmark ? '移除本页书签' : '给本页加书签（也可在页顶下拉）'}
      </button>

      {sorted.length > 0 && (
        <ul className="space-y-1 border-b border-border pb-3">
          {sorted.map((b) => (
            <li key={b.id} className="flex items-center gap-1">
              <button
                onClick={() => onJumpPage(b.page)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary touch-target"
              >
                <Bookmark className="h-3.5 w-3.5 shrink-0 fill-primary text-primary" />
                <span className="min-w-0 flex-1 truncate">{paraPreview(b.para)}…</span>
                <span className="shrink-0 text-xs text-muted-foreground">P{b.page + 1}</span>
              </button>
              <button
                onClick={() => onRemoveBookmark(b.id)}
                aria-label="删除书签"
                title="删除书签"
                className="text-muted-foreground hover:text-destructive touch-target-sm"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {chapters.length === 0 ? (
        <p className="text-sm text-muted-foreground">这本书没有解析出章节结构。</p>
      ) : (
        <ul className="space-y-1">
          {chapters.map((c, i) => (
            <li key={i}>
              <button
                onClick={() => onJumpPage(c.page)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm touch-target',
                  c.page === page ? 'bg-primary/10 text-primary' : 'hover:bg-secondary',
                )}
              >
                <span className="min-w-0 flex-1 truncate pr-2">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ============================ 进度面板（极简 UI） ============================ */

/**
 * 需求六：中间一个空心圆，左右各一条横杠（减号样式，不贯穿圆，
 * 与圆距约 2-4px，长度等于圆的直径），水平居中 flex。
 * 交互：输入框输入目标页码跳转；直接滑动中间的空心圆快速翻页。
 */
function ProgressPanel({ page, pageCount, onGoto }: ProgressPanelProps) {
  const [text, setText] = useState(String(page + 1))
  const draggingRef = useRef<{ x: number; page: number } | null>(null)

  useEffect(() => {
    setText(String(page + 1))
  }, [page])

  const clamp = (p: number) => Math.min(Math.max(p, 0), Math.max(0, pageCount - 1))

  function jump(e: React.FormEvent) {
    e.preventDefault()
    const n = Number(text)
    if (!Number.isFinite(n)) return
    onGoto(clamp(Math.round(n) - 1))
  }

  const CIRCLE = 28 // 直径
  const DASH = 28 // 长度 = 圆的直径
  const GAP = 3 // 圆与横杠的间距 2-4px

  return (
    <div className="space-y-6 py-2">
      {/* 页码输入跳转 */}
      <form onSubmit={jump} className="flex items-center justify-center gap-2">
        <span className="text-sm text-muted-foreground">第</span>
        <input
          type="number"
          inputMode="numeric"
          aria-label="跳转到页码"
          min={1}
          max={Math.max(1, pageCount)}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-9 w-16 rounded-lg border border-border bg-card text-center text-sm tabular-nums outline-none focus:border-primary"
        />
        <span className="text-sm text-muted-foreground">/ {pageCount} 页</span>
        <Button type="submit" variant="secondary" size="sm">
          跳转
        </Button>
      </form>

      {/* — ◯ —：左右横杠 + 中间空心圆（可拖动快速翻页） */}
      <div className="flex items-center justify-center select-none">
        <span
          aria-hidden
          className="rounded-full bg-muted-foreground/50"
          style={{ width: DASH, height: 3, marginRight: GAP }}
        />
        <button
          type="button"
          aria-label={`当前第 ${page + 1} 页，左右滑动快速翻页`}
          title="左右滑动快速翻页"
          onPointerDown={(e) => {
            e.stopPropagation()
            draggingRef.current = { x: e.clientX, page }
            ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = draggingRef.current
            if (!d) return
            e.stopPropagation()
            const delta = Math.round((e.clientX - d.x) / 48)
            onGoto(clamp(d.page + delta))
          }}
          onPointerUp={() => {
            draggingRef.current = null
          }}
          onPointerCancel={() => {
            draggingRef.current = null
          }}
          className="flex items-center justify-center rounded-full border-2 border-primary bg-card touch-target"
          style={{ width: CIRCLE, height: CIRCLE }}
        >
          <span className="sr-only">拖动翻页</span>
        </button>
        <span
          aria-hidden
          className="rounded-full bg-muted-foreground/50"
          style={{ width: DASH, height: 3, marginLeft: GAP }}
        />
      </div>

      <p className="text-center text-xs text-muted-foreground">
        第 <b className="text-foreground">{page + 1}</b> / {pageCount} 页 · 拖动圆点左右滑动快速翻页
      </p>
    </div>
  )
}
