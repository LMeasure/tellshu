/**
 * 划词选区捕获（2026-10-07 需求 5）
 * ------------------------------------------------------------------
 * 把浏览器 Selection 换算成「段索引 + 段内字符偏移」区间，供划线/想法定位。
 * 坐标系 = 段落元素 textContent（渲染与捕获同系，偏移自洽）。
 *
 * 仅在浏览器事件处理器中调用（SSR / 单测不会走到）。
 */

export interface CapturedSpan {
  para: number
  /** 段内字符区间 [start, end) */
  start: number
  end: number
}

export interface CapturedSelection {
  /** 用户看到的选中文本（含跨段换行，展示用） */
  text: string
  /** 每个被覆盖段落的区间（跨段选择会产生多条） */
  spans: CapturedSpan[]
  /** 选区首屏位置（弹窗定位用） */
  rect: DOMRect
  /** 逐行矩形（自绘高亮用：只染色文字本体，不含行距） */
  rects: DOMRect[]
}

function closestParagraph(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null =
    node === null ? null : node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  while (el && el !== root) {
    if (el.dataset?.para !== undefined) return el
    el = el.parentElement
  }
  return null
}

/** node+offset 在段落文本里的字符偏移（按文本节点累加） */
function offsetInParagraph(p: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
  let pos = 0
  while (walker.nextNode()) {
    const cur = walker.currentNode
    if (cur === node) return pos + offset
    pos += cur.textContent?.length ?? 0
  }
  // 兜底：没找到（如选区边界在段落外）按段落末尾处理
  return pos
}

/**
 * 一个段落元素覆盖的「段内字符窗口」。
 * V3.0 起段落可能被拆成片段跨页渲染：element 只含片段文本，
 * 因此用 data-para-start 记下它在整段里的起点，坐标统一换算到**整段**。
 */
function windowOf(el: HTMLElement): { base: number; len: number } {
  const base = Number(el.dataset.paraStart ?? 0)
  return { base: Number.isFinite(base) ? base : 0, len: el.textContent?.length ?? 0 }
}

/**
 * 从当前窗口选区提取划线定位；选区无效或不在容器内时返回 null。
 */
export function captureSelection(root: HTMLElement): CapturedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)

  const startEl = closestParagraph(range.startContainer, root)
  const endEl = closestParagraph(range.endContainer, root)
  if (!startEl || !endEl) return null

  const startPara = Number(startEl.dataset.para)
  const endPara = Number(endEl.dataset.para)
  if (!Number.isFinite(startPara) || !Number.isFinite(endPara)) return null

  // 换算到「整段」坐标系（片段起点 + 段内偏移）
  const ws = windowOf(startEl)
  const we = windowOf(endEl)
  const startOffset = ws.base + offsetInParagraph(startEl, range.startContainer, range.startOffset)
  const endOffset = we.base + offsetInParagraph(endEl, range.endContainer, range.endOffset)

  const lo = Math.min(startPara, endPara)
  const hi = Math.max(startPara, endPara)
  const spans: CapturedSpan[] = []
  for (let p = lo; p <= hi; p += 1) {
    const el = root.querySelector<HTMLElement>(`[data-para="${p}"]`)
    if (!el) continue
    const { base, len } = windowOf(el)
    const lo2 = base
    const hi2 = base + len
    let s = lo2
    let e = hi2
    if (p === startPara) s = Math.min(Math.max(startOffset, lo2), hi2)
    if (p === endPara) e = Math.min(Math.max(endOffset, lo2), hi2)
    if (startPara === endPara) {
      s = Math.min(Math.max(Math.min(startOffset, endOffset), lo2), hi2)
      e = Math.min(Math.max(Math.max(startOffset, endOffset), lo2), hi2)
    }
    if (e > s) spans.push({ para: p, start: s, end: e })
  }
  if (spans.length === 0) return null

  return {
    text: sel.toString(),
    spans,
    rect: range.getBoundingClientRect(),
    rects: Array.from(range.getClientRects()),
  }
}

/** 清掉当前选区（生成划线/想法后调用，避免高亮残留） */
export function clearSelection(): void {
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    /* 忽略 */
  }
}
