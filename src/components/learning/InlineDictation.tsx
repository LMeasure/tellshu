import { memo, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { inlineState, slotKey, tokenize, type SlotKey } from '@/lib/masking'
import type { LangKind } from '@/lib/textLang'
import { isSelectingAxis, markVisited, pickSlotKey, resolveDragAxis } from '@/lib/dragSelect'
import type { DragAxis } from '@/lib/dragSelect'

/**
 * 就地默写：**不用单独的输入框**，直接在原文位置输入。
 * 被隐藏的词就地变成一个小输入框（宽度按词长自适应），其余文字照常显示，
 * 用户对着真实排版默写，而不是把整段抄到一个空文本框里。
 *
 * 实时监督：输入过程中逐字比对，偏离答案立即标红（inlineState）。
 * 按空格 / Tab 跳到下一个空位，避免手机上一个个手点。
 * 中英文都走同一套**字符匹配**逻辑：中文一个空位可能是一个词组或单个字。
 *
 * 【滑动选词】需求【3】：自主选择阶段不再只靠 click ——
 *   · 鼠标：mousedown 起手 → mousemove 经过的词逐个切换 → mouseup 收尾
 *   · 触屏：touchstart 起手 → touchmove 逐词切换 → touchend 收尾
 *   · 触屏上**横向滑动才选词，纵向滑动交还给页面滚动**（判定见 lib/dragSelect）
 *   · 一次拖拽里同一个词只切换一次（markVisited），否则手指停在上面会疯狂闪烁
 *   · 已选中的词再滑过一次即取消（toggle 语义天然满足）
 */

interface Props {
  paragraphs: string[]
  /** 需要默写的空位 */
  hidden: Set<SlotKey>
  /** 空位 → 已输入内容 */
  values: Record<string, string>
  onChange: (key: SlotKey, value: string) => void
  /** 自主选择模式：允许点词切换隐藏 */
  selectable?: boolean
  /** 自主选择模式下是否处于「选择阶段」 */
  selecting?: boolean
  onToggleSlot?: (key: SlotKey) => void
  /** 文档语言：决定英文空格分词还是中文词级分词 */
  lang?: LangKind | 'auto'
  /** 睁眼：默写阶段临时显示被隐藏的单词（答案），闭眼恢复输入框 */
  reveal?: boolean
  /** 焦点进入某个默写输入框时回调（用于自动恢复计时器） */
  onInputFocus?: () => void
}

export function InlineDictation({
  paragraphs,
  hidden,
  values,
  onChange,
  selectable = false,
  selecting = false,
  onToggleSlot,
  lang = 'auto',
  reveal = false,
  onInputFocus,
}: Props) {
  const inputRefs = useRef(new Map<SlotKey, HTMLInputElement>())

  // 记录空位顺序，用于按空格跳到下一个
  const order: SlotKey[] = []
  paragraphs.forEach((p, pi) => {
    tokenize(p, lang).forEach((tk, ti) => {
      const k = slotKey(pi, ti)
      if (hidden.has(k)) order.push(k)
    })
  })

  const focusBy = useCallback(
    (key: SlotKey, delta: number) => {
      const idx = order.indexOf(key)
      const next = order[idx + delta]
      if (next) inputRefs.current.get(next)?.focus()
    },
    // order 每次渲染重建，但只在事件里读取，闭包捕获当次渲染的顺序即可
    [order],
  )

  // 稳定的回调（用 ref 转发），避免每个输入框因回调变化而重渲染
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const toggleRef = useRef(onToggleSlot)
  toggleRef.current = onToggleSlot
  const focusRef = useRef(focusBy)
  focusRef.current = focusBy

  const stableChange = useCallback((k: SlotKey, v: string) => changeRef.current(k, v), [])
  const stableToggle = useCallback((k: SlotKey) => toggleRef.current?.(k), [])
  const stableFocus = useCallback((k: SlotKey, d: number) => focusRef.current(k, d), [])

  /* ---------------- 滑动选词（需求【3】） ---------------- */
  const rootRef = useRef<HTMLDivElement>(null)
  const dragToggleRef = useRef(stableToggle)
  dragToggleRef.current = stableToggle
  // 最近一次切换 { 词, 时刻 }：手势 toggle 与 onClick 兜底共用它做**同键**去重。
  // 关键：touchend 后移动端内核会补发合成 mousedown + click（compat 事件），
  // 两者都会再走一次切换——不去重就会「选中又立刻取消」，表现即单点选不中。
  const lastToggleAtRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const dragActive = selectable && selecting

  /** 同一个词 600ms 内只切一次；不同词不受影响（快速连滑照常逐词切换） */
  const toggleGuarded = useCallback((key: string | null) => {
    if (!key) return
    const last = lastToggleAtRef.current
    if (last.key === key && Date.now() - last.at < 600) return
    dragToggleRef.current(key)
    lastToggleAtRef.current = { key, at: Date.now() }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !dragActive) return

    /** 一次拖拽里已经处理过的词 */
    const visited = new Set<string>()
    let dragging = false
    let axis: DragAxis = 'none'
    let startX = 0
    let startY = 0

    const toggle = (key: string | null) => {
      if (!key) return
      // markVisited：一次拖拽内同词只切一次；toggleGuarded：跨事件类型（合成 mousedown/click）同键去重
      if (markVisited(visited, key)) toggleGuarded(key)
    }

    /**
     * 触屏上 touchmove 的 target 永远是 touchstart 那个元素
     * （这是touch 事件的隐式捕获），所以必须用坐标反查当前手指压在哪个词上。
     */
    const keyAtPoint = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      const holder = el?.closest('[data-slot]') as HTMLElement | null
      return pickSlotKey(holder?.dataset.slot)
    }

    const keyOfEventTarget = (e: Event): string | null => {
      const el = e.target as HTMLElement | null
      const holder = el?.closest?.('[data-slot]') as HTMLElement | null
      return pickSlotKey(holder?.dataset.slot)
    }

    /* ---- 鼠标 ---- */
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      dragging = true
      visited.clear()
      // 起手就切一个：单击 = mousedown + mouseup，等价于原来的点选
      toggle(keyOfEventTarget(e))
      // 阻止浏览器原生拖选文字，否则会选中一片文本
      e.preventDefault()
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      toggle(keyOfEventTarget(e))
    }
    const onMouseUp = () => {
      dragging = false
    }

    /* ---- 触屏 ---- */
    /**
     * 起点的词**先记下、不立刻切换**。
     * 因为手指落在文字上再往上划是再常见不过的「滚页面」动作 ——
     * 若 touchstart 就切，每滚一次屏幕都会误选一个词。
     * 只有确认是「原地轻点」或「横向滑动」时才真正切换它。
     */
    let startKey: string | null = null
    const flushStart = () => {
      if (startKey === null) return
      toggle(startKey)
      startKey = null
    }

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      dragging = true
      axis = 'none'
      startX = t.clientX
      startY = t.clientY
      visited.clear()
      startKey = keyAtPoint(t.clientX, t.clientY)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!dragging) return
      const t = e.touches[0]
      if (!t) return
      if (axis === 'none') {
        axis = resolveDragAxis(t.clientX - startX, t.clientY - startY)
        // 纵向为主 → 判定为「用户想滚页面」：本次作废，起点那个词也不切
        if (axis === 'y') {
          dragging = false
          startKey = null
          return
        }
        if (isSelectingAxis(axis)) flushStart()
      }
      if (!isSelectingAxis(axis)) return
      // 横向选词期间吃掉滚动，否则手指一偏页面就跟着跑
      e.preventDefault()
      toggle(keyAtPoint(t.clientX, t.clientY))
    }
    const onTouchEnd = () => {
      // 全程没怎么动 = 轻点一下：切起点那个词
      if (axis === 'none') flushStart()
      dragging = false
      axis = 'none'
      startKey = null
    }

    root.addEventListener('mousedown', onMouseDown)
    root.addEventListener('touchstart', onTouchStart, { passive: true })
    // 必须 passive:false —— 横向选词时要 preventDefault 掉页面滚动
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    root.addEventListener('touchend', onTouchEnd)
    root.addEventListener('touchcancel', onTouchEnd)
    // 鼠标要挂在 window 上：手指/鼠标拖出容器再松开也能正常收尾
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      root.removeEventListener('mousedown', onMouseDown)
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchend', onTouchEnd)
      root.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragActive, toggleGuarded])

  return (
    <div
      ref={rootRef}
      className={cn('space-y-4 text-[17px] leading-9', dragActive && 'select-none')}
      onFocusCapture={() => onInputFocus?.()}
    >
      {paragraphs.map((p, pi) => (
        <p key={pi} className="whitespace-pre-wrap break-words">
          {tokenize(p, lang).map((tk, ti) => {
            const k = slotKey(pi, ti)
            const isHidden = hidden.has(k)

            // 选择阶段：全部词可选，已选的词高亮。
            // 选中主要靠上面的滑动/按下处理器；同时保留一个「受保护的 onClick 兜底」——
            // 个别内核手势链路不触发时靠 click 选词（否则「点按/再点取消」会失效）。
            // 兜底与手势共用 toggleGuarded 的同键 600ms 去重：touchend 后内核补发的
            // 合成 mousedown/click 不会把刚选中的词再切回去（二者互斥，不双切）。
            if (selectable && selecting) {
              if (!tk.word) return <span key={k}>{tk.t}</span>
              return (
                <button
                  key={k}
                  type="button"
                  data-slot={k}
                  onClick={() => toggleGuarded(k)}
                  className={cn(
                    'rounded px-0.5 transition-colors',
                    isHidden
                      ? 'bg-primary/25 font-medium text-primary underline decoration-dotted'
                      : 'hover:bg-secondary',
                  )}
                >
                  {tk.t}
                </button>
              )
            }

            if (!isHidden) return <span key={k}>{tk.t}</span>

            // 睁眼（reveal）：临时显示被隐藏的单词，样式对齐核验视图的「未填」态；
            // 闭眼恢复输入框，已输入内容不受影响
            if (reveal) {
              return (
                <span
                  key={k}
                  className="rounded px-0.5 text-muted-foreground underline decoration-dotted"
                >
                  {tk.t}
                </span>
              )
            }

            return (
              <SlotInput
                key={k}
                slot={k}
                target={tk.t}
                value={values[k] ?? ''}
                onChange={stableChange}
                onJump={stableFocus}
                register={(el) => {
                  if (el) inputRefs.current.set(k, el)
                  else inputRefs.current.delete(k)
                }}
              />
            )
          })}
        </p>
      ))}
    </div>
  )
}

/**
 * 输入框要按答案长度自适应，而中日韩全角字符宽度约等于两个西文字符。
 * 直接用 `答案.length` 会让中文空位窄一半，字打到一半就被截断看不见。
 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(
      ch,
    )
      ? 2
      : 1
  }
  return w
}

/** 单个空位输入框：宽度随答案长度自适应，实时按对错着色 */
const SlotInput = memo(
  function SlotInput({
    slot,
    target,
    value,
    onChange,
    onJump,
    register,
  }: {
    slot: SlotKey
    target: string
    value: string
    onChange: (key: SlotKey, value: string) => void
    onJump: (key: SlotKey, delta: number) => void
    register: (el: HTMLInputElement | null) => void
  }) {
    const state = inlineState(target, value)
    const width = `${Math.max(2, displayWidth(target)) + 1.5}ch`

    return (
      <input
        ref={register}
        value={value}
        onChange={(e) => onChange(slot, e.target.value)}
        onKeyDown={(e) => {
          // 空格 / Tab 跳下一个空位，Shift+Tab 回上一个
          if (e.key === ' ' || e.key === 'Tab') {
            e.preventDefault()
            onJump(slot, e.shiftKey ? -1 : 1)
          }
        }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={`默写空位（${target.length} 个字符）`}
        style={{ width }}
        className={cn(
          'mx-0.5 rounded-md border-b-2 bg-transparent px-1 text-center outline-none transition-colors',
          state === 'empty' && 'border-muted-foreground/40 bg-secondary/30',
          state === 'typing' && 'border-primary/60 bg-primary/5 text-foreground',
          state === 'ok' && 'border-emerald-500 bg-emerald-500/10 text-emerald-600',
          state === 'wrong' && 'border-rose-500 bg-rose-500/10 text-rose-600',
        )}
      />
    )
  },
  (a, b) => a.target === b.target && a.value === b.value && a.slot === b.slot,
)
