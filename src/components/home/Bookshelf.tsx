import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BookOpen,
  Check,
  Import,
  ListPlus,
  Pin,
  PinOff,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Sheet } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import {
  getAllBooklists,
  getShelfBooks,
  setDocBooklists,
  setOnShelf,
  toggleShelfPin,
  type ReadingDoc,
} from '@/domain/learning'

/**
 * 首页书架（2026-10-07 改版，需求 3）：
 *  - 「管理」入口换成「导入」，直达导入页书籍页签；
 *  - 书籍**长按 500ms** 进多选模式，多选中点按切换选中；
 *  - 多选工具栏：分享（Web Share API，不可用时降级复制）/ 移出书架 /
 *    加入书单（勾选已有书单或新建）/ 置顶（置顶在前，组内按最近阅读倒序，
 *    排序在 domain/learning.getShelfBooks 内做）。
 *  - 长按前点书 = 直接进阅读器，行为不变。
 */
export function Bookshelf() {
  const navigate = useNavigate()
  const [shelf, setShelf] = useState<ReadingDoc[] | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [listSheetOpen, setListSheetOpen] = useState(false)
  const [lists, setLists] = useState<string[]>([])
  const [newListName, setNewListName] = useState('')
  const [toast, setToast] = useState('')
  const pressTimer = useRef<number | null>(null)

  const load = useCallback(() => {
    getShelfBooks().then(setShelf).catch(() => setShelf([]))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 2000)
  }

  /* ---------------- 长按进多选 ---------------- */
  function startPress(id: string) {
    clearPress()
    pressTimer.current = window.setTimeout(() => {
      setSelecting(true)
      setSelected(new Set([id]))
      pressTimer.current = null
    }, 500)
  }
  function clearPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelect() {
    setSelecting(false)
    setSelected(new Set())
  }

  function selectedDocs(): ReadingDoc[] {
    return (shelf ?? []).filter((b) => selected.has(b.id))
  }

  /* ---------------- 多选操作 ---------------- */
  async function shareSelected() {
    const docs = selectedDocs()
    if (docs.length === 0) return
    const text = docs
      .map((d) => `《${d.title}》\n${d.content.slice(0, 140)}${d.content.length > 140 ? '…' : ''}`)
      .join('\n\n')
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> }
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: '述树 · 书架分享', text })
        return
      } catch (e) {
        // 用户取消分享不算失败
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(text)
      showToast('当前环境不支持直接分享，已复制到剪贴板')
    } catch {
      showToast('当前环境不支持分享')
    }
  }

  async function removeSelected() {
    for (const id of selected) await setOnShelf(id, false)
    setConfirmRemove(false)
    exitSelect()
    load()
    showToast('已移出书架（素材仍保留在导入列表）')
  }

  async function pinSelected(pinned: boolean) {
    for (const id of selected) await toggleShelfPin(id, pinned)
    exitSelect()
    load()
    showToast(pinned ? '已置顶，置顶的书排在前' : '已取消置顶')
  }

  function openListSheet() {
    getAllBooklists().then(setLists)
    setListSheetOpen(true)
  }

  /** 把选中的书并入指定书单（不影响其他选中书的其它书单归属） */
  async function addToLists(target: string[]) {
    const docs = selectedDocs()
    for (const d of docs) {
      const merged = [...new Set([...(d.booklists ?? []), ...target])]
      await setDocBooklists(d.id, merged)
    }
    setListSheetOpen(false)
    exitSelect()
    load()
    showToast(target.length > 0 ? `已加入书单：${target.join('、')}` : '已移出全部书单')
  }

  async function createAndAdd() {
    const name = newListName.trim()
    if (!name) return
    setNewListName('')
    await addToLists([name])
  }

  const firstPinned = selectedDocs()[0]?.pinned_at !== undefined
  const allPinned = selectedDocs().length > 0 && selectedDocs().every((d) => d.pinned_at !== undefined)

  if (shelf === null) {
    return <div className="p-3 text-sm text-muted-foreground">加载中…</div>
  }

  return (
    <div>
      {/* 标题行：多选时显示「已选 N 项 + 取消」；平时显示书名 + 导入入口 */}
      <div className="mb-2 flex items-center justify-between px-1">
        {selecting ? (
          <>
            <div className="flex items-center gap-2 text-base font-semibold">
              已选 {selected.size} 本
              <button
                className="text-xs font-normal text-muted-foreground"
                onClick={() =>
                  setSelected(selected.size === shelf.length ? new Set() : new Set(shelf.map((b) => b.id)))
                }
              >
                {selected.size === shelf.length ? '取消全选' : '全选'}
              </button>
            </div>
            <button className="flex items-center gap-1 text-xs text-muted-foreground" onClick={exitSelect}>
              <X className="h-4 w-4" /> 退出管理
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-base font-semibold">
              <BookOpen className="h-5 w-5 text-primary" /> 书架
            </div>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground"
              onClick={() => navigate('/import?tab=book')}
            >
              <Import className="h-4 w-4" /> 导入
            </button>
          </>
        )}
      </div>

      {/* 多选工具栏（需求 7：不与标题行重复出现，只在多选态存在） */}
      {selecting && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-secondary/60 p-2">
          <ToolbarBtn icon={Share2} label="分享" onClick={shareSelected} />
          <ToolbarBtn icon={Trash2} label="移出" onClick={() => setConfirmRemove(true)} />
          <ToolbarBtn icon={ListPlus} label="书单" onClick={openListSheet} />
          {selected.size > 0 &&
            (allPinned ? (
              <ToolbarBtn icon={PinOff} label="取消置顶" onClick={() => pinSelected(false)} />
            ) : (
              <ToolbarBtn
                icon={Pin}
                label={firstPinned ? '保持置顶' : '置顶'}
                onClick={() => pinSelected(true)}
              />
            ))}
        </div>
      )}

      {shelf.length === 0 ? (
        <Card className="cursor-pointer" onClick={() => navigate('/import?tab=book')}>
          <CardBody className="text-sm text-muted-foreground">
            书架还是空的，去「导入 → 书籍」上传 TXT/EPUB 并加入书架。
          </CardBody>
        </Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {shelf.map((b) => {
            const isSelected = selected.has(b.id)
            return (
              <button
                key={b.id}
                onPointerDown={() => !selecting && startPress(b.id)}
                onPointerUp={clearPress}
                onPointerLeave={clearPress}
                onPointerMove={clearPress}
                onContextMenu={(e) => {
                  // 桌面端右键等价长按：直接进多选
                  if (!selecting) {
                    e.preventDefault()
                    setSelecting(true)
                    setSelected(new Set([b.id]))
                  }
                }}
                onClick={() => (selecting ? toggleSelect(b.id) : navigate(`/reader/${b.id}`))}
                className={cn(
                  'shelf-card w-28 shrink-0 rounded-lg text-left',
                  isSelected && 'ring-2 ring-primary',
                )}
              >
                <div className="relative mb-2 flex h-20 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 text-primary">
                  <BookOpen className="h-7 w-7" />
                  {/* 置顶角标（排在前的原因要可见） */}
                  {b.pinned_at !== undefined && (
                    <span className="absolute left-1 top-1 flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                      <Pin className="h-3 w-3" /> 置顶
                    </span>
                  )}
                  {selecting && (
                    <span
                      className={cn(
                        'absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border',
                        isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card',
                      )}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5" />}
                    </span>
                  )}
                </div>
                <div className="truncate text-sm font-medium">{b.title}</div>
                <div className="text-[11px] text-muted-foreground">
                  {b.booklists && b.booklists.length > 0 ? b.booklists[0] : `${b.word_count} 词`}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {selecting && (
        <p className="mt-1 px-1 text-[11px] text-muted-foreground">
          长按书籍进入管理；点按可多选。排序规则：置顶在前，其余按最近阅读时间排列。
        </p>
      )}

      {/* 移出确认 */}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="移出书架"
        footer={
          <>
            <Button variant="outline" className="flex-1" onClick={() => setConfirmRemove(false)}>
              取消
            </Button>
            <Button variant="primary" className="flex-1" onClick={removeSelected}>
              移出
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          把选中的 {selected.size} 本书移出书架？书籍本身不会删除，可随时在「导入 → 书籍」重新上架。
        </p>
      </Dialog>

      {/* 书单 Sheet：勾选已有书单 / 新建 */}
      <Sheet open={listSheetOpen} onClose={() => setListSheetOpen(false)} title="加入书单">
        <div className="space-y-3">
          {lists.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有书单，先在下面新建一个。</p>
          ) : (
            <div className="space-y-1">
              {lists.map((l) => (
                <button
                  key={l}
                  onClick={() => addToLists([l])}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm hover:bg-secondary touch-target"
                >
                  <span>{l}</span>
                  <span className="text-xs text-muted-foreground">加入</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2 border-t border-border pt-3">
            <input
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="新书单名称"
              aria-label="新书单名称"
              className="flex-1 rounded-lg bg-muted px-3 py-2 text-sm outline-none"
            />
            <Button size="sm" disabled={!newListName.trim()} onClick={createAndAdd}>
              新建并加入
            </Button>
          </div>
        </div>
      </Sheet>

      {/* 轻提示 */}
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

function ToolbarBtn({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Share2
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex items-center gap-1 rounded-lg bg-card px-3 py-2 text-xs font-medium shadow-soft touch-target hover:bg-secondary"
    >
      <Icon className="h-4 w-4 text-primary" />
      {label}
    </button>
  )
}
