/**
 * 阅读器「一页即一屏」分页（V3.0 需求三）
 * ------------------------------------------------------------------
 * 与字符预算分页（lib/paging.ts）不同，本模块按**真实渲染高度**切页：
 * 调用方注入 `heightOf(para, start, end)` 返回该片段渲染高度（px），
 * 本模块贪心地把段落流装进「每页高度预算」里；超长段落会被切成多个
 * 片段（fragment）跨页，从而保证整页内容完全适应屏幕、不需上下滑动。
 *
 * 纯逻辑（不碰 DOM）：真实测量由 Reader 侧注入，便于单测与复用。
 */

export interface PageFrag {
  /** 段落全局下标 */
  para: number
  /** 段内字符区间 [start, end) */
  start: number
  end: number
}

export interface FitPage {
  frags: PageFrag[]
}

/** 段落之间的垂直间距（与渲染时的 space-y-4 一致，1rem = 16px） */
export const PARA_GAP = 16

/** 英文尽量不切断单词：从 end 往回找最近的空白（返回切点，找不到返回 start） */
function lastBreak(text: string, start: number, end: number): number {
  for (let i = end; i > start; i -= 1) {
    const ch = text[i - 1]
    if (ch === ' ' || ch === '\n' || ch === '\t') return i
  }
  return start
}

/** 二分找「起点 start、剩余高度 remain」下能放下的最大结束下标 */
function maxFit(
  text: string,
  para: number,
  start: number,
  remain: number,
  heightOf: (para: number, start: number, end: number) => number,
): number {
  if (remain <= 0) return start
  // 整段（余下部分）放得下 → 直接收下，省掉二分
  if (heightOf(para, start, text.length) <= remain) return text.length

  let lo = start + 1
  let hi = text.length
  let best = start
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const h = heightOf(para, start, mid)
    if (h <= remain) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  // 切在词中间会很难看：能退回空白就退回
  if (best > start && best < text.length) {
    const b = lastBreak(text, start, best)
    if (b > start) best = b
  }
  return best
}

/**
 * 把段落流按高度预算切成整页。
 * @param paragraphs 全部段落文本
 * @param heightOf   片段高度测量函数（para=段落下标，[start,end) 为段内字符区间）
 * @param pageHeight 单页可用高度（px，已扣除上下内边距）
 * @param gap        段落间距（px）
 */
export function packByHeight(
  paragraphs: string[],
  heightOf: (para: number, start: number, end: number) => number,
  pageHeight: number,
  gap = PARA_GAP,
): FitPage[] {
  const pages: FitPage[] = []
  if (paragraphs.length === 0 || pageHeight <= 0) return pages

  let frags: PageFrag[] = []
  let used = 0
  const flush = () => {
    if (frags.length) pages.push({ frags })
    frags = []
    used = 0
  }

  for (let para = 0; para < paragraphs.length; para += 1) {
    const full = paragraphs[para]
    if (!full) continue
    let start = 0
    while (start < full.length) {
      const remain = pageHeight - used - (frags.length ? gap : 0)
      let end = maxFit(full, para, start, remain, heightOf)
      if (end <= start) {
        // 当前页放不下任何字符：非空页 → 翻页重试；空页 → 强制放 1 个字符（防死循环）
        if (frags.length) {
          flush()
          continue
        }
        end = Math.min(start + 1, full.length)
      }
      const h = Math.max(1, heightOf(para, start, end))
      used += (frags.length ? gap : 0) + h
      frags.push({ para, start, end })
      start = end
      // 本段没放完 → 立刻翻页（片段不与其他段落混排）
      if (start < full.length) flush()
    }
  }
  flush()
  return pages
}

/** 由实测页表推导「段落下标 → 页下标」（取该段首次出现的页） */
export function paraToPageMap(pages: FitPage[], paragraphCount: number): number[] {
  const map = new Array<number>(paragraphCount).fill(-1)
  for (let i = 0; i < pages.length; i += 1) {
    for (const f of pages[i].frags) {
      if (f.para >= 0 && f.para < paragraphCount && map[f.para] === -1) map[f.para] = i
    }
  }
  for (let p = 0; p < paragraphCount; p += 1) if (map[p] === -1) map[p] = 0
  return map
}

/** 字符预算分页结果 → 实测页表（测量未就绪时的兜底，整段不拆） */
export function wholeParaPages(paragraphs: string[], buckets: { from: number; to: number }[]): FitPage[] {
  return buckets.map((b) => ({
    frags: Array.from({ length: b.to - b.from }, (_, k) => ({
      para: b.from + k,
      start: 0,
      end: (paragraphs[b.from + k] ?? '').length,
    })),
  }))
}
