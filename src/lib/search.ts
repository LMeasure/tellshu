/**
 * 全词库搜索（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 输入是预计算好的搜索索引（search-index.json），不含任何网络与 DOM 依赖。
 *
 * 排序优先级：词首前缀 > 词内包含 > 中文释义包含。
 * 归并规则：同一单词常被多个词本收录（如 continent 同时在 CET4/TOEFL/GRE8000），
 * 列表里应只出现一条，并把所属词本合并展示，否则用户会看到重复条目。
 */

import type { DifficultyLevel } from '../data/types'

/** 搜索索引中的一条词 */
export interface SearchIndexWord {
  id: string
  word: string
  ipa: string | null
  pos: string | null
  /** 中文释义 */
  zh: string | null
  book: string
  dl: DifficultyLevel
  tid: string
}

/** 搜索命中（归并后） */
export interface SearchHit extends SearchIndexWord {
  bookName: string
  /** 收录该词的全部词本名（去重） */
  bookNames: string[]
}

/**
 * 按优先级挑出候选（每档最多 cap 条，避免大结果集全量扫描后排序的开销）。
 * 已经命中 cap 条前缀的极端情况下仍会继续补齐其余档位。
 */
export function rankSearchMatches(
  words: SearchIndexWord[],
  query: string,
  cap: number,
): SearchIndexWord[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const starts: SearchIndexWord[] = []
  const contains: SearchIndexWord[] = []
  const zhHit: SearchIndexWord[] = []

  for (const w of words) {
    const lw = w.word.toLowerCase()
    if (lw.startsWith(q)) {
      if (starts.length < cap) starts.push(w)
    } else if (lw.includes(q)) {
      if (contains.length < cap) contains.push(w)
    } else if (w.zh && w.zh.includes(q)) {
      if (zhHit.length < cap) zhHit.push(w)
    }
  }
  return [...starts, ...contains, ...zhHit]
}

/** 按单词归并同形词条（保留首个出现的释义，合并词本标签），再截断到 limit。 */
export function mergeSearchHits(
  items: SearchIndexWord[],
  nameOf: Map<string, string>,
  limit: number,
): SearchHit[] {
  const merged = new Map<string, SearchHit>()
  for (const w of items) {
    const key = w.word.toLowerCase()
    const name = nameOf.get(w.book) ?? w.book
    const exist = merged.get(key)
    if (!exist) {
      merged.set(key, { ...w, bookName: name, bookNames: [name] })
    } else {
      if (!exist.bookNames.includes(name)) exist.bookNames.push(name)
      // 首个词条释义缺失时用后续词本补全（同一词各词本释义一致，仅作兜底）
      if (!exist.zh && w.zh) exist.zh = w.zh
    }
  }
  return [...merged.values()].slice(0, limit)
}
