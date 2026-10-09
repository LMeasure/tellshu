import { useEffect, useState } from 'react'
import { Check, Pencil, Trash2 } from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { annotationCss, ANNOTATION_COLOR_HEX } from '@/lib/annotate'
import type { ReadingAnnotation } from '@/domain/types'

/**
 * 笔记模块 V3.0（2026-10-09 需求五）
 * ------------------------------------------------------------------
 *   NotesPanel —— 控制中心「笔记」页内容（想法 / 划线两组，可跳转/编辑/删除）。
 *   NoteDetail —— 点正文里的**虚线笔记标识**弹出的详情卡片：可编辑、可删除，
 *                 并标注来源（我的笔记 / 他人笔记）。他人笔记会以不同颜色虚线区分
 *                 （由 annotation.author 驱动；无账号体系时不产生他人数据，绝不编造）。
 */

export interface NotesPanelProps {
  annotations: ReadingAnnotation[] | null
  onJump: (ann: ReadingAnnotation) => void
  onDelete: (id: string) => void
  onUpdateThought: (id: string, thought: string) => void
}

export function NotesPanel({ annotations, onJump, onDelete, onUpdateThought }: NotesPanelProps) {
  const [tab, setTab] = useState<'thought' | 'underline'>('thought')
  const [editing, setEditing] = useState<ReadingAnnotation | null>(null)
  const [editText, setEditText] = useState('')

  const thoughts = (annotations ?? []).filter((a) => a.kind === 'thought')
  const underlines = (annotations ?? []).filter((a) => a.kind === 'underline')

  function startEdit(a: ReadingAnnotation) {
    setEditing(a)
    setEditText(a.thought ?? '')
  }

  function saveEdit() {
    if (!editing) return
    const text = editText.trim()
    if (text && text !== editing.thought) onUpdateThought(editing.id, text)
    setEditing(null)
  }

  return (
    <div>
      <Segmented<'thought' | 'underline'>
        className="mb-3"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'thought', label: `想法 ${thoughts.length}` },
          { key: 'underline', label: `划线 ${underlines.length}` },
        ]}
      />

      {annotations === null ? (
        <div className="p-3 text-sm text-muted-foreground">加载中…</div>
      ) : tab === 'thought' ? (
        thoughts.length === 0 ? (
          <EmptyState
            icon={Pencil}
            title="还没有想法"
            description="阅读时长按选中一段文字，点「写想法」，就能把笔记记在这里。"
          />
        ) : (
          <ul className="space-y-2 pb-2">
            {thoughts.map((a) => (
              <li key={a.id} className="rounded-xl border border-border p-3">
                <button onClick={() => onJump(a)} className="w-full text-left">
                  <p className="mb-1 line-clamp-2 border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground">
                    {a.text}
                  </p>
                  <p className="whitespace-pre-wrap text-sm">{a.thought}</p>
                </button>
                <div className="mt-2 flex justify-end gap-1">
                  <IconMiniBtn label="编辑想法" icon={Pencil} onClick={() => startEdit(a)} />
                  <IconMiniBtn label="删除想法" icon={Trash2} danger onClick={() => onDelete(a.id)} />
                </div>
              </li>
            ))}
          </ul>
        )
      ) : underlines.length === 0 ? (
        <EmptyState
          icon={Check}
          title="还没有划线"
          description="长按选中正文文字，选颜色和线型即可划线，划过的都会汇总在这里。"
        />
      ) : (
        <ul className="space-y-2 pb-2">
          {underlines.map((a) => (
            <li key={a.id} className="rounded-xl border border-border p-3">
              <button onClick={() => onJump(a)} className="w-full text-left">
                <p className="line-clamp-3 text-sm">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
                    style={{ backgroundColor: ANNOTATION_COLOR_HEX[a.color ?? 'yellow'] }}
                  />
                  <span style={annotationCss(a)}>{a.text}</span>
                </p>
              </button>
              <div className="mt-2 flex justify-end">
                <IconMiniBtn label="删除划线" icon={Trash2} danger onClick={() => onDelete(a.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 列表内编辑想法 */}
      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑想法"
        footer={
          <>
            <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button className="flex-1" disabled={!editText.trim()} onClick={saveEdit}>
              保存
            </Button>
          </>
        }
      >
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={4}
          aria-label="想法内容"
          className="w-full rounded-lg bg-muted p-3 text-sm outline-none"
          placeholder="写点什么…"
        />
      </Dialog>
    </div>
  )
}

/**
 * 笔记详情面板（点正文虚线标识弹出）。可编辑、可删除；标注来源。
 * 不再打开设置面板（V3.0 需求五）。
 */
export function NoteDetail({
  ann,
  onClose,
  onSave,
  onDelete,
}: {
  ann: ReadingAnnotation | null
  onClose: () => void
  onSave: (id: string, thought: string) => void
  onDelete: (id: string) => void
}) {
  const [text, setText] = useState('')

  useEffect(() => {
    setText(ann?.thought ?? '')
  }, [ann])

  const isOther = !!ann?.author
  const dirty = !!ann && text.trim() !== (ann.thought ?? '').trim()

  return (
    <Dialog
      open={!!ann}
      onClose={onClose}
      title="笔记"
      className="text-left"
      footer={
        <>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              关闭
            </Button>
            <Button
              className="flex-1"
              disabled={!dirty || !text.trim()}
              onClick={() => {
                if (ann && text.trim()) onSave(ann.id, text.trim())
              }}
            >
              保存
            </Button>
          </div>
          <Button
            variant="outline"
            className="w-full text-destructive"
            onClick={() => {
              if (ann) onDelete(ann.id)
            }}
          >
            <Trash2 className="h-4 w-4" /> 删除笔记
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <p className="border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground">{ann?.text}</p>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full align-middle"
            style={{ backgroundColor: isOther ? '#8b6df0' : '#45b649' }}
          />
          来源：{isOther ? ann?.author : '我的笔记'}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          aria-label="笔记内容"
          className="w-full rounded-lg bg-muted p-3 text-sm outline-none"
          placeholder="记下此刻的理解或疑问…"
        />
      </div>
    </Dialog>
  )
}

function IconMiniBtn({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Trash2
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg hover:bg-secondary ${
        danger ? 'text-muted-foreground hover:text-destructive' : 'text-muted-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
