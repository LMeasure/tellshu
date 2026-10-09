/**
 * 滑动选词的判定逻辑（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 需求【3】：自主选择隐藏哪些词时，只监听 click 的话**滑动不生效** ——
 * 手机上手指一划就变成页面滚动，根本选不中一串词。
 *
 * 交互约定：
 *   mousedown / touchstart  —— 开始选择，起点那个词立刻切换
 *   mousemove / touchmove   —— 经过的词逐个切换（同一个词在一次拖拽里只切一次）
 *   mouseup  / touchend     —— 结束选择
 *   已经选中的词再滑过一次   —— 取消选中（toggle 语义天然满足）
 *
 * 手机上的关键区分：**横向滑动 = 选词，纵向滑动 = 滚动页面**。
 * 判定放在纯函数 `resolveDragAxis` 里，方便单测钉死阈值行为：
 *   · 位移没超过阈值 → 'none'（还不能判定，继续等）
 *   · 横向位移 ≥ 纵向位移 → 'x'（选词）
 *   · 纵向位移更大 → 'y'（滚页面，本次拖拽作废）
 */

/** 判定方向所需的最小位移（px）。太小会抖，太大要划很久才有反应 */
export const DRAG_AXIS_THRESHOLD = 8

export type DragAxis = 'none' | 'x' | 'y'

/**
 * 由位移判定这次拖拽的意图。
 * @param dx 横向位移绝对值
 * @param dy 纵向位移绝对值
 * @param threshold 阈值，默认 8px
 */
export function resolveDragAxis(dx: number, dy: number, threshold = DRAG_AXIS_THRESHOLD): DragAxis {
  const x = Math.abs(dx)
  const y = Math.abs(dy)
  if (x < threshold && y < threshold) return 'none'
  return x >= y ? 'x' : 'y'
}

/** 该方向是否进入「选词」模式（只有横向才是；纵向要留给页面滚动） */
export function isSelectingAxis(axis: DragAxis): boolean {
  return axis === 'x'
}

/**
 * 一次拖拽里「这个词是否还没被处理过」。
 * 返回 true 表示应当切换它，并顺手把它记进 visited。
 *
 * 为什么必须去重：手指在词 A 上停留不动时，touchmove 会连续触发几十次，
 * 不去重的话 A 会被来回切换，表现为「疯狂闪烁」。
 */
export function markVisited(visited: Set<string>, key: string): boolean {
  if (visited.has(key)) return false
  visited.add(key)
  return true
}

/** 命中判定：`data-slot` 属性值（空串 / null 都算没命中） */
export function pickSlotKey(value: string | null | undefined): string | null {
  return value ? value : null
}
