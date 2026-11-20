/**
 * 左右滑动切换（真实手势，非点击模拟）
 * ------------------------------------------------------------------
 * 用于单词学习页的手势翻卡。设计要点：
 *   1. **真实拖拽**：走 Pointer Events（touch / mouse / pen 统一），手指跟手位移
 *      实时反馈，松手才判定；不是把整卡当按钮点一下就算切换。
 *   2. **轴向锁定**：移动超过 10px 时按 |dx| 与 |dy| 的关系锁定一次方向 ——
 *      锁横向则本次手势归翻卡，锁纵向则彻底放手（长释义照常上下滚），
 *      绝不出现「看长内容被误切成下一个词」。
 *   3. **阈值**：位移需 ≥ max(56px, 容器宽 × 14%)，轻触 / 抖动不触发。
 *   4. **单次手势只出一次结果**：一个 pointerdown→up 序列最多触发一次切换，
 *      松手后立刻上锁 COOLDOWN_MS，快速连滑不会跳词、不会重复切换。
 *   5. 容器需带 `touch-action: pan-y`（CSS 类 touch-pan-y）：把纵向滚动留给
 *      浏览器、横向留给本 hook，这样手机上既滑得动也滚得动。
 *
 * 只做「识别」，不做业务：触发什么由调用方决定（切词 / 结算 / 边界提示）。
 */

import { useEffect, useRef } from 'react'

/** 轴向判定门槛（px） */
const AXIS_LOCK_PX = 10
/** 纵向优先系数：|dx| 必须大于 |dy| 的这么多倍才判为横向 */
const AXIS_RATIO = 1.3
/** 触发切换的最小水平位移（px） */
const MIN_DISTANCE = 56
/** 最小位移占容器宽度的比例（小屏不至于难滑，大屏不至于误触） */
const MIN_RATIO = 0.14
/** 手势最长有效时长（ms）：慢慢拖过去也算，但超过 1.5s 视为犹豫，不切 */
const MAX_DURATION = 1500
/** 两次切换之间的冷却（ms）：防连发 */
const COOLDOWN_MS = 180
/** 跟手位移的阻尼系数（手指走 100px，卡片走 35px） */
const FOLLOW_DAMP = 0.35

export type SwipeDirection = 1 | -1

export interface SwipeSwitchOptions {
  /** 触发切换；dir=1 下一个（左滑），dir=-1 上一个（右滑） */
  onSwitch: (dir: SwipeDirection) => void
  /** 是否启用（加载中 / 结算弹窗打开时关掉） */
  enabled?: boolean
}

/**
 * 把 ref 挂到要做手势的容器上即可。
 * 拖拽位移直接改 DOM transform（不走 React state），避免每次 move 都重渲染。
 */
export function useSwipeSwitch({ onSwitch, enabled = true }: SwipeSwitchOptions) {
  const ref = useRef<HTMLDivElement | null>(null)
  /** 用 ref 持有回调：回调变化不重建监听，也不至于在手势中途拿到旧闭包 */
  const onSwitchRef = useRef(onSwitch)
  onSwitchRef.current = onSwitch

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let startAt = 0
    let axis: 'none' | 'x' | 'y' = 'none'
    let consumed = false
    let captured = false
    let lastSwitchAt = 0

    function reset() {
      pointerId = null
      axis = 'none'
      consumed = false
      el!.style.transition = 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)'
      el!.style.transform = ''
      window.setTimeout(() => {
        if (el) el.style.transition = ''
      }, 200)
    }

    function onDown(e: PointerEvent) {
      // 多指（捏合 / 第二根手指）直接放弃本次手势
      if (pointerId !== null || !e.isPrimary) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      pointerId = e.pointerId
      startX = e.clientX
      startY = e.clientY
      startAt = Date.now()
      axis = 'none'
      consumed = false
      captured = false
      el!.style.transition = ''
      // 注意：这里**不**立刻 setPointerCapture。若一上来就捕获，纯「点按」也会被
      // 容器抢走指针，导致子元素（如例句里的点词查词按钮）的 click 收不到。
      // 改为锁定为横向滑动的瞬间才捕获（见 onMove），点按因此能正常触发子元素点击。
    }

    function onMove(e: PointerEvent) {
      if (pointerId === null || e.pointerId !== pointerId) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (axis === 'none') {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return
        axis = Math.abs(dx) >= AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y'
        // 判为纵向：本次手势彻底交给页面滚动，不再干预
        if (axis === 'y') {
          pointerId = null
          return
        }
        // 锁定为横向滑动的瞬间才捕获指针：鼠标拖出容器也能收到 up；
        // 纯点按（无位移）不会捕获，子元素点击得以正常触发。
        if (!captured) {
          try {
            el!.setPointerCapture(e.pointerId)
            captured = true
          } catch {
            /* 某些环境不支持捕获，退化为容器内手势 */
          }
        }
      }
      if (axis !== 'x') return
      // 跟手位移（带阻尼 + 轻微淡出），不 preventDefault：纵向滚动权还在浏览器
      el!.style.transform = `translateX(${dx * FOLLOW_DAMP}px)`
      el!.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 900))
    }

    function onUp(e: PointerEvent) {
      if (pointerId === null || e.pointerId !== pointerId) return
      const dx = e.clientX - startX
      const dt = Date.now() - startAt
      const width = el!.getBoundingClientRect().width || MIN_DISTANCE / MIN_RATIO
      const threshold = Math.max(MIN_DISTANCE, width * MIN_RATIO)
      const horizontal = axis === 'x'
      const far = Math.abs(dx) >= threshold
      const quick = dt <= MAX_DURATION
      const cool = Date.now() - lastSwitchAt >= COOLDOWN_MS
      reset()
      pointerId = null
      if (!horizontal || !far || !quick || consumed || !cool) return
      consumed = true
      lastSwitchAt = Date.now()
      onSwitchRef.current(dx < 0 ? 1 : -1)
    }

    function onCancel(e: PointerEvent) {
      if (pointerId === null || e.pointerId !== pointerId) return
      reset()
      pointerId = null
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
    }
  }, [enabled])

  return ref
}
