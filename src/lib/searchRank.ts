/**
 * 全局搜索浮层的相似度打分（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 背景：`lib/search.ts` 的 rankSearchMatches 只有三档（词首先缀 > 词内包含 >
 * 中文释义包含），档内按索引文件顺序排 —— 「谁更接近」完全没保证，也没有
 * 精确匹置顶、拼写容错、词形还原。本模块补上连续打分，供搜索浮层
 * （components/search/GlobalSearchDock.tsx）使用；/search 页仍走旧档位，
 * 是否迁移另议（不混用两套语义）。
 *
 * 分档（分数越高越匹配，同分按词长升序 + 字母序）：
 *   1000  精确相等
 *    900  词首先缀（+ 查询占词长比例 ×80，短词更近："in" > "indoor"）
 *    700  词内包含（+ 比例 ×60）
 *    500  拼写容错（编辑距离 ≤2，查询 ≥4 字母；500 - 距离×80 + 比例×40）
 *    450  词形还原命中（"running" → "run"；450 - 50 前缀变体）
 *    300  中文释义包含（仅查询含中文时；纯 ASCII 查询不走这档 ——
 *         否则 "adv" 会命中所有释义里带 "adv." 缩写词的词，纯噪音）
 *
 * 排序方向：本模块返回「最匹配在前」（desc）；UI 层反转为「最匹配在最底、
 * 紧挨输入框」，职责分离。
 */

import { lemmaCandidates } from '../domain/dict/lemma'
import type { SearchIndexWord } from './search'

/** 匹配档位分（导出供测试与 UI 展示「匹配原因」用） */
export const SCORE = {
  exact: 1000,
  prefix: 900,
  contains: 700,
  fuzzy: 500,
  lemma: 450,
  zh: 300,
} as const

/** 拼写容错：最大编辑距离 */
export const FUZZY_MAX_DIST = 2
/** 拼写容错：查询至少这么长才值得做（短查询歧义大） */
export const FUZZY_MIN_QLEN = 4
/** 词形还原档：查询至少这么长 */
export const LEMMA_MIN_QLEN = 3
/** 中文释义档：只在查询含 CJK 字符时启用（见文件头说明） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 一次查询的预计算上下文：小写查询 + 词形还原候选（每个查询只算一次） */
export interface QueryContext {
  q: string
  /** 词形还原候选（已小写、去重、不含原词） */
  lemmas: string[]
}

export function buildQueryContext(query: string): QueryContext {
  const q = query.trim().toLowerCase()
  if (!q) return { q: '', lemmas: [] }
  const lemmas =
    q.length >= LEMMA_MIN_QLEN
      ? [...new Set(lemmaCandidates(q).map((c) => c.toLowerCase()).filter((c) => c && c !== q))]
      : []
  return { q, lemmas }
}

/**
 * 编辑距离（双行 DP + 行内早退）。
 * 任一行最小值 > max 时直接返回 max + 1（调用方只关心 ≤ max 的判定）。
 */
export function levenshtein(a: string, b: string, max = FUZZY_MAX_DIST): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1)
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    prev = curr
  }
  return prev[b.length]
}

/** 单个词对查询的匹配分；0 = 不匹配 */
export function scoreMatch(ctx: QueryContext, word: SearchIndexWord): number {
  const q = ctx.q
  if (!q) return 0
  const lw = word.word.toLowerCase()
  if (!lw) return 0

  // ① 精确
  if (lw === q) return SCORE.exact

  // ② 词首先缀（查询占比越高越近，短词更近）
  if (lw.startsWith(q)) return SCORE.prefix + Math.round((q.length / lw.length) * 80)

  // ③ 词内包含
  if (lw.includes(q)) return SCORE.contains + Math.round((q.length / lw.length) * 60)

  // ④ 词形还原（"running" → "run" / "leaves" → "leaf"）
  if (ctx.lemmas.length > 0) {
    let best = 0
    for (const lc of ctx.lemmas) {
      if (lc === lw) best = Math.max(best, SCORE.lemma)
      else if (lw.startsWith(lc)) best = Math.max(best, SCORE.lemma - 50)
    }
    if (best > 0) return best
  }

  // ⑤ 拼写容错（仅 ≥4 字母查询；长度差 > 2 直接跳过 —— 距离上限的必然结论）
  if (q.length >= FUZZY_MIN_QLEN && Math.abs(lw.length - q.length) <= FUZZY_MAX_DIST) {
    const d = levenshtein(lw, q, FUZZY_MAX_DIST)
    if (d <= FUZZY_MAX_DIST) {
      const ratio = Math.round((Math.min(lw.length, q.length) / Math.max(lw.length, q.length)) * 40)
      return SCORE.fuzzy - d * 80 + ratio
    }
  }

  // ⑥ 中文释义包含（仅查询含中文；纯 ASCII 查询会命中 "adv." 之类缩写，不收）
  if (CJK_RE.test(q) && word.zh && word.zh.includes(q)) {
    return SCORE.zh + Math.round((q.length / word.zh.length) * 20)
  }
  return 0
}

/**
 * 全量打分排序（desc：最匹配在前）。
 * 单次线性扫描 22,791 词 + 仅对通过预过滤的词算编辑距离，实测个位数毫秒。
 */
export function rankByScore(
  words: SearchIndexWord[],
  query: string,
  limit: number,
): SearchIndexWord[] {
  const ctx = buildQueryContext(query)
  if (!ctx.q) return []
  const scored: Array<{ w: SearchIndexWord; s: number }> = []
  for (const w of words) {
    const s = scoreMatch(ctx, w)
    if (s > 0) scored.push({ w, s })
  }
  scored.sort(
    (a, b) =>
      b.s - a.s ||
      a.w.word.length - b.w.word.length ||
      a.w.word.localeCompare(b.w.word),
  )
  return scored.slice(0, limit).map((x) => x.w)
}
