/**
 * 阅读器分页（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 把段落数组按字符预算切成一页页。以「段落」为最小单位断页，
 * 不切断句子 —— 长段落允许独占一整页（不强行压缩），保证可读性。
 *
 * 页码与段落下标的映射用于目录跳转：章节记录的是起始段落下标，
 * 因此目录跳转只需换算成页号，不存在字符偏移误差。
 */

export interface Page {
  /** 段落区间 [from, to) */
  from: number
  to: number
  /** 本页包含的段落文本 */
  paragraphs: string[]
}

export const DEFAULT_PAGE_CHARS = 900

/** 按段落切页；空输入返回空数组。 */
export function paginate(paragraphs: string[], maxChars = DEFAULT_PAGE_CHARS): Page[] {
  if (paragraphs.length === 0) return []
  const pages: Page[] = []
  let from = 0
  let chars = 0

  for (let i = 0; i < paragraphs.length; i++) {
    const len = paragraphs[i].length
    // 当前页已有内容，且再放一段会超预算 → 在此断页
    if (i > from && chars + len > maxChars) {
      pages.push({ from, to: i, paragraphs: paragraphs.slice(from, i) })
      from = i
      chars = 0
    }
    chars += len
  }
  pages.push({ from, to: paragraphs.length, paragraphs: paragraphs.slice(from) })
  return pages
}

/** 段落下标 → 页下标（找不到返回 0）。 */
export function pageOfParagraph(pages: Page[], para: number): number {
  if (pages.length === 0) return 0
  for (let i = 0; i < pages.length; i++) {
    if (para >= pages[i].from && para < pages[i].to) return i
  }
  return para < pages[0].from ? 0 : pages.length - 1
}

/** 收敛页码到合法范围；用于从本地存档恢复上次阅读位置。 */
export function clampPage(pages: Page[], page: number | undefined): number {
  if (pages.length === 0) return 0
  const p = Number.isFinite(page) ? Math.floor(page as number) : 0
  return Math.min(Math.max(p, 0), pages.length - 1)
}
