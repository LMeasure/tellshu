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
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
 * 综合控制中心（V3.3 交互）
 * ------------------------------------------------------------------
 * 底部导航栏 fixed 在屏幕最底部（icon-only，无文字），不被内容顶起：
 *   · 默认只显示正文；点击正文 Toggle 显示 / 隐藏整个控制中心；
 *   · 点击导航栏内部按钮 → 切换对应面板，不隐藏导航栏；
 *   · 长按划词（活跃选区）不触发显隐（由 PageFlipContainer 的单击阈值拦截）。
 * 面板 fixed 在导航栏上方（bottom-14），点击正文空白处 / 全局遮罩 → 清空
 * 导航栏 + 面板 + 划线菜单，恢复纯阅读；弹窗内部一律 stopPropagation 防误关。
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
  tab: PanelTab | null
  onTabChange: (t: PanelTab) => void
  onClose: () => void
  toc: TocPanelProps
  notes: NotesPanelProps
  progress: ProgressPanelProps
  listen: ListenPanelProps
  settings: {
    mode: 'read' | 'memo'
    onModeChange: (m: 'read' | 'memo') => void
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
  function handleNav(key: PanelTab) {
    if (open && tab === key) onClose()
    else onTabChange(key)
  }

  if (!open) return null
  return (
    <>
      {/* 底部导航栏：fixed 图标栏（无文字），点击正文才显示；不被内容顶起；点击内部不隐藏 */}
      <nav
        className="fixed inset-x-0 bottom-0 z-50 flex h-14 items-stretch border-t border-border/60 bg-card safe-bottom"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="阅读器导航"
      >
        {NAV.map((n) => {
          const active = tab === n.key
          const Icon = n.icon
          return (
            <button
              key={n.key}
              onClick={() => handleNav(n.key)}
              aria-label={n.label}
              aria-pressed={active}
              title={n.label}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0 transition-colors touch-target',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className={cn('h-6 w-6', active && 'drop-shadow-[0_0_6px_hsl(var(--primary)/0.5)]')} />
            </button>
          )
        })}
      </nav>

      {/* 面板：仅当选了某个导航图标（tab !== null）才显示，fixed 在导航栏上方（bottom-14）；点击内部不关闭 */}
      {tab !== null && (
      <div
        className="fixed inset-x-0 bottom-14 z-50 max-h-[76vh] overflow-y-auto rounded-t-2xl bg-card shadow-soft animate-slide-up safe-bottom"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pb-4 pt-3">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
          {tab === 'toc' && <TocPanel {...toc} />}
          {tab === 'notes' && <NotesPanel {...notes} />}
          {tab === 'progress' && <ProgressPanel {...progress} />}
          {tab === 'listen' && <ListenPanel {...listen} />}
          {tab === 'settings' && (
            <SettingsPanel
              mode={settings.mode}
              onModeChange={settings.onModeChange}
              prefs={settings.prefs}
              onChange={settings.onChange}
              memo={settings.memo}
              onCloseAll={onClose}
            />
          )}
        </div>
      </div>
      )}
    </>
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
 * Bug 6 修复：改用 window 级 pointermove/up 监听 + touch-action:none，
 * 避免触摸设备把横向拖动识别为滚动手势、触发 pointercancel 导致拖不动。
 */
function ProgressPanel({ page, pageCount, onGoto }: ProgressPanelProps) {
  const [text, setText] = useState(String(page + 1))
  const draggingRef = useRef<{ x: number; page: number } | null>(null)
  const moveRef = useRef<(e: PointerEvent) => void>(() => {})
  const upRef = useRef<(e: PointerEvent) => void>(() => {})

  useEffect(() => {
    setText(String(page + 1))
  }, [page])

  // 卸载时清理可能残留的 window 监听
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', moveRef.current)
      window.removeEventListener('pointerup', upRef.current)
      window.removeEventListener('pointercancel', upRef.current)
    },
    [],
  )

  const clamp = (p: number) => Math.min(Math.max(p, 0), Math.max(0, pageCount - 1))

  function jump(e: React.FormEvent) {
    e.preventDefault()
    const n = Number(text)
    if (!Number.isFinite(n)) return
    onGoto(clamp(Math.round(n) - 1))
  }

  function onDown(e: React.PointerEvent) {
    e.stopPropagation()
    draggingRef.current = { x: e.clientX, page }
    const move = (ev: PointerEvent) => {
      const d = draggingRef.current
      if (!d) return
      const delta = Math.round((ev.clientX - d.x) / 22)
      onGoto(clamp(d.page + delta))
    }
    const up = () => {
      draggingRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    moveRef.current = move
    upRef.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
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
          onPointerDown={onDown}
          className="flex items-center justify-center rounded-full border-2 border-primary bg-card touch-target"
          style={{ width: CIRCLE, height: CIRCLE, touchAction: 'none' }}
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
