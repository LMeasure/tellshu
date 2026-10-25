/**
 * 数据仓库（Repository）
 * ------------------------------------------------------------------
 * 只读内容访问层。真实内容来自 OpenEtymology 五个词本 + Linguabase 全量词库，
 * 经 `scripts/*.py` 解析后产出**分片**的 bundle（现存放于仓库根 data/linguabase/v1/）：
 *   index.json                  # 极小索引（~1KB，首屏加载）
 *   books/<BOOK>.json           # 单本词包（2-8MB，按需懒加载）
 *   themes/index.json + <id>.json  # 45 个日常主题
 *   bank/index.json + L*.json   # 难度档（L3 百万级按首字母分片）
 *   defs/<shard>.json           # 英文释义（353MB，一律懒加载）
 *
 * ⚠️ 数据**不在** public/ 下，不参与打包。所有抓取统一走 `dataClient`：
 * 基址由 VITE_DATA_BASE_URL 决定（默认同源 /data/linguabase/v1/，
 * 由 vite dev/preview 中间件直出本地 data/ 目录）。
 *
 * 不编造数据：bundle 不存在（或拉取失败）时，所有内容返回空集合，
 * 页面据此渲染空状态。
 */

import { fetchData } from './dataClient'
import { buildDiagnostics } from '../lib/diagnostic'
import { mergeSearchHits, rankSearchMatches } from '../lib/search'
import { rankByScore } from '../lib/searchRank'
import type { SearchHit, SearchIndexWord } from '../lib/search'
import type {
  BookMeta,
  BookId,
  ContentCourse,
  ContentDiagnostic,
  ContentLetter,
  ContentPattern,
  ContentTopic,
  ContentWord,
  DifficultyLevel,
  LinguaBankLevel,
  LinguaTheme,
  LinguaWordTuple,
  WordBundleIndex,
} from './types'

/** 词库来源与授权信息（CC BY-SA 4.0 署名用，取自 index.json，绝不本地硬编码） */
export interface SourceAttribution {
  source: string
  attribution: string
  license: string
  total: number
  generated_at: string
  books: { id: string; name: string; count: number }[]
}

export interface ContentRepository {
  getTopics(): Promise<ContentTopic[]>
  getLetters(): Promise<ContentLetter[]>
  /** 按词本懒加载单词；不传 bookId 则加载全部（慢路径，慎用） */
  getWords(bookId?: BookId | string): Promise<ContentWord[]>
  getPatterns(topicId?: string): Promise<ContentPattern[]>
  /** 首屏仅加载此 ~1KB 索引：返回词本清单（含路径/词数） */
  getBookIndex(): Promise<BookMeta[]>
  /** 按难度梯度抽取诊断题；真实实现应保证 L1/L2/L3 各取对应题 */
  getDiagnostics(): Promise<ContentDiagnostic[]>
  getCourses(): Promise<ContentCourse[]>
  /** CC BY-SA 4.0 署名信息；取不到返回 null（由 UI 决定是否隐藏） */
  getAttribution(): Promise<SourceAttribution | null>
  /** 全词库搜索（跨全部词本，不需要用户选词本） */
  searchAllWords(query: string, limit?: number): Promise<SearchHit[]>
  /** 相似度排序版全词库搜索（全局搜索浮层用，打分规则见 lib/searchRank.ts） */
  searchRanked(query: string, limit?: number): Promise<SearchHit[]>
  /** 学习路径目录（词本 × 难度档统计，几 KB 预计算产物） */
  getCatalog(): Promise<CatalogBook[]>
  /* ---- 全量词库层（Linguabase 百万级，主题 + 难度双层） ---- */
  /** 45 个日常主题（一级分类） */
  getLinguaThemes(): Promise<LinguaTheme[]>
  /** 某主题的词；limit 限制条数（大主题约 1 千词，默认全给） */
  getLinguaThemeWords(id: string, limit?: number): Promise<ContentWord[]>
  /** 难度档清单（L1/L2 单文件；L3 百万级，按首字母分片） */
  getLinguaBank(): Promise<LinguaBankLevel[]>
  /** 某难度档 / L3 字母分片的词（传 file 相对路径，如 bank/L1.json、bank/L3_a.json） */
  getLinguaBankWords(file: string, limit?: number): Promise<ContentWord[]>
  /** 英文释义懒加载；shard 形如 themes_animals / bank_L1 / bank_L3_a */
  getLinguaDefs(shard: string): Promise<Record<string, string>>
}

/** 搜索相关类型与纯逻辑见 lib/search.ts，此处再导出供页面使用。 */
export type { SearchIndexWord, SearchHit } from '../lib/search'

export interface CatalogLevel {
  level: DifficultyLevel
  label: string
  count: number
}

export interface CatalogBook {
  id: string
  name: string
  total: number
  levels: CatalogLevel[]
}

let indexCache: Promise<WordBundleIndex | null> | null = null
const bookCache = new Map<string, Promise<ContentWord[]>>()

/** 加载极小索引（~1KB）；失败/缺失返回 null（绝不用假数据兜底）。 */
/**
 * 只在**拿到内容**时才写进缓存。
 *
 * ⚠️ 以前这里是无条件 set，失败时也会把「解析出空数组」的 Promise 永久缓存：
 *    一次超时 / 断网 → 该词本在本会话内永远返回 []，
 *    复习闯关就再也组不出题，直到用户整页刷新。
 *    注意 dataClient 内部已经「只缓存成功」，但那是它自己的那层；
 *    本函数是 repository 层的第二层缓存，同样不能把失败结果固化。
 */
function cacheWhenNonEmpty<K, V extends { length: number }>(
  cache: Map<K, Promise<V>>,
  key: K,
  promise: Promise<V>,
): Promise<V> {
  const guarded = promise.then((value) => {
    if (value && value.length > 0) cache.set(key, Promise.resolve(value))
    return value
  })
  return guarded
}

/**
 * 同样只在拿到内容时才缓存：一次失败（断网 / 超时）不能让整个 App
 * 在本会话内永远读不到词本索引 —— 那样所有页面都会显示空状态直到刷新。
 * 并发安全由 dataClient 的 `inflight` 去重保证（并发调用共享同一个请求）。
 */
function loadIndex(): Promise<WordBundleIndex | null> {
  const cached = indexCache
  if (cached) return cached
  const p = fetchData<WordBundleIndex | null>('index.json', null)
  const guarded = p.then((idx) => {
    if (idx && idx.books && idx.books.length > 0) indexCache = Promise.resolve(idx)
    return idx
  })
  return guarded
}

/** 按 file 懒加载单本词包；失败返回空数组（**且不缓存失败结果**，下次调用会重试）。 */
function loadBookFile(file: string): Promise<ContentWord[]> {
  const cached = bookCache.get(file)
  if (cached) return cached
  const p = fetchData<unknown>(file, null).then((rows) => {
    const list = Array.isArray(rows) ? (rows as ContentWord[]) : []
    return list.filter((w) => w && typeof w.word === 'string')
  })
  return cacheWhenNonEmpty(bookCache, file, p)
}

export const repository: ContentRepository = {
  async getTopics() {
    return []
  },
  async getLetters() {
    return []
  },
  async getWords(bookId?: BookId | string) {
    const idx = await loadIndex()
    if (!idx) return []
    if (bookId) {
      const b = idx.books.find((x) => x.id === bookId)
      return b ? loadBookFile(b.file) : []
    }
    // 未指定词本：加载全部（慢路径，约 19MB），仅在确实需要全量时调用
    const all = await Promise.all(idx.books.map((b) => loadBookFile(b.file)))
    return all.flat()
  },
  async getPatterns() {
    return []
  },
  async getBookIndex() {
    const idx = await loadIndex()
    return idx?.books ?? []
  },
  async getDiagnostics() {
    const idx = await loadIndex()
    if (!idx || idx.books.length === 0) return []
    // 诊断只考「高频基础词 → 难词」的梯度，用 CET4 一本即可覆盖；缺失则退到第一本
    const book = idx.books.find((b) => b.id === 'CET4') ?? idx.books[0]
    const words = await loadBookFile(book.file)
    return buildDiagnostics(words)
  },
  async getCourses() {
    return []
  },
  async getAttribution() {
    const idx = await loadIndex()
    if (!idx) return null
    return {
      source: idx.source,
      attribution: idx.attribution,
      license: idx.license,
      total: idx.total,
      generated_at: idx.generated_at,
      books: idx.books.map((b) => ({ id: b.id, name: b.name, count: b.count })),
    }
  },
  async searchAllWords(query: string, limit = 60) {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const idx = await loadIndex()
    if (!idx) return []
    const words = await loadSearchIndex()
    const nameOf = new Map<string, string>(idx.books.map((b) => [b.id, b.name]))
    // 每档多取一些留出归并余量（同一单词可能被多本收录）
    const candidates = rankSearchMatches(words, q, limit * 3)
    return mergeSearchHits(candidates, nameOf, limit)
  },
  /**
   * 相似度排序版搜索（全局搜索浮层用，2026-10-21）：打分规则见 lib/searchRank.ts
   * （精确 > 前缀 > 包含 > 拼写容错 > 词形还原 > 中文释义），归并逻辑与
   * searchAllWords 完全一致，只是候选取自打分排序而非三档截取。
   */
  async searchRanked(query: string, limit = 30) {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const idx = await loadIndex()
    if (!idx) return []
    const words = await loadSearchIndex()
    const nameOf = new Map<string, string>(idx.books.map((b) => [b.id, b.name]))
    // 多取一倍留归并余量（同一单词被多本收录时只展示一条）
    const candidates = rankByScore(words, q, limit * 2)
    return mergeSearchHits(candidates, nameOf, limit)
  },
  async getCatalog() {
    const c = await loadCatalog()
    return c?.books ?? []
  },
  async getLinguaThemes() {
    return loadLinguaThemes()
  },
  async getLinguaThemeWords(id, limit) {
    const themes = await loadLinguaThemes()
    const t = themes.find((x) => x.id === id)
    if (!t) return []
    return loadLinguaTuples(t.file, limit ?? 0, id)
  },
  async getLinguaBank() {
    return loadLinguaBank()
  },
  async getLinguaBankWords(file, limit) {
    return loadLinguaTuples(file, limit ?? 0, file)
  },
  async getLinguaDefs(shard) {
    return loadLinguaDefs(shard)
  },
}

/* ------------------------------------------------------------------
 * 搜索索引 / 路径目录（由 scripts/build_search_index.py 预计算产出）
 * ------------------------------------------------------------------ */

let searchIndexCache: Promise<SearchIndexWord[]> | null = null

/** 加载全词搜索索引（约 4MB，gzip 后 ~1.2MB）；失败返回空数组，不编造。 */
export function loadSearchIndex(): Promise<SearchIndexWord[]> {
  if (!searchIndexCache) {
    searchIndexCache = fetchData<{ words?: unknown } | null>('search-index.json', null).then((d) =>
      Array.isArray(d?.words) ? (d.words as SearchIndexWord[]) : [],
    )
  }
  return searchIndexCache
}

let catalogCache: Promise<{ books: CatalogBook[] } | null> | null = null

/** 加载路径目录（约 1.4KB）。 */
export function loadCatalog(): Promise<{ books: CatalogBook[] } | null> {
  if (!catalogCache) {
    catalogCache = fetchData<{ books: CatalogBook[] } | null>('catalog.json', null)
  }
  return catalogCache
}

/* ------------------------------------------------------------------
 * 全量词库层（Linguabase CC0，108 万单词）
 *   themes/ 45 个日常主题；bank/ 按难度 L1/L2/L3（L3 百万级按首字母分片）
 *   defs/   英文释义分片，**一律懒加载**，绝不进首屏
 * ---------------------------------------------------------------- */

let linguaThemesCache: Promise<LinguaTheme[]> | null = null
let linguaBankCache: Promise<LinguaBankLevel[]> | null = null
const linguaTupleCache = new Map<string, Promise<ContentWord[]>>()
const linguaDefsCache = new Map<string, Promise<Record<string, string>>>()

/**
 * 紧凑元组 [word, level, rank] → ContentWord。
 * 只填真实字段：Linguabase 不提供中文释义与音标，故 definition_zh / ipa 留空，
 * 由 UI 显示英文释义（defs 分片）并明确标注来源，绝不编造。
 */
function tupleToWord(t: LinguaWordTuple, topicId: string): ContentWord {
  const [word, difficulty_level, rank] = t
  return {
    id: `lb-${word.toLowerCase()}`,
    word,
    difficulty_level,
    frequency_rank: rank,
    topic_id: topicId,
  }
}

/** 主题清单（约 8KB）。 */
export function loadLinguaThemes(): Promise<LinguaTheme[]> {
  if (!linguaThemesCache) {
    linguaThemesCache = fetchData<{ themes?: unknown } | null>('themes/index.json', null).then((d) =>
      Array.isArray(d?.themes) ? (d.themes as LinguaTheme[]) : [],
    )
  }
  return linguaThemesCache
}

/** 难度档清单（约 1KB）。 */
export function loadLinguaBank(): Promise<LinguaBankLevel[]> {
  if (!linguaBankCache) {
    linguaBankCache = fetchData<{ bank?: unknown } | null>('bank/index.json', null).then((d) =>
      Array.isArray(d?.bank) ? (d.bank as LinguaBankLevel[]) : [],
    )
  }
  return linguaBankCache
}

/**
 * 加载词包分片（themes/<id>.json 或 bank/L*.json）。
 * limit>0 时只把前 N 条交给调用方——L3 单分片可达数万词，直接全量渲染会卡死。
 */
export function loadLinguaTuples(
  file: string,
  limit = 0,
  topicId = '',
): Promise<ContentWord[]> {
  let p = linguaTupleCache.get(file)
  if (!p) {
    p = fetchData<unknown>(file, null).then((d) =>
      Array.isArray(d) ? (d as LinguaWordTuple[]).map((t) => tupleToWord(t, topicId)) : [],
    )
    linguaTupleCache.set(file, p)
  }
  return p.then((all) => (limit > 0 ? all.slice(0, limit) : all))
}

/** 懒加载英文释义 {word: definition}；失败返回 {}（UI 隐藏释义区，不报错）。 */
export function loadLinguaDefs(shard: string): Promise<Record<string, string>> {
  let p = linguaDefsCache.get(shard)
  if (!p) {
    p = fetchData<unknown>(`defs/${shard}.json`, null).then((d) =>
      d && typeof d === 'object' ? (d as Record<string, string>) : {},
    )
    linguaDefsCache.set(shard, p)
  }
  return p
}

/** 把搜索命中还原成词卡所需的 ContentWord 形状（仅核心字段，其余静默降级）。 */
export function toContentWord(hit: SearchIndexWord): ContentWord {
  return {
    id: hit.id,
    word: hit.word,
    ipa: hit.ipa ?? undefined,
    pos: hit.pos ?? undefined,
    definition_zh: hit.zh ?? undefined,
    book: hit.book,
    difficulty_level: hit.dl,
    topic_id: hit.tid,
  }
}

/**
 * 数据来源说明（给开发者 / 未来接 Linguabase 时参考）：
 * 诊断抽题梯度（见 01-PRD §5、04 §1.2）：
 *   第 1-2 题 difficulty_level = 1（字母辨识）
 *   第 3-4 题 difficulty_level = 2（高频词认读）
 *   第 5 题   difficulty_level = 3（句型理解）
 * 卡片排序（见 03 用户流程图 §0）：
 *   difficulty_level 升序 → 词长升序（短词先学）→ 真实词频升序（同长度里更常用的先学）
 *   → 字母序兜底。
 *   ⚠️ 旧 frequency_rank 在本词包里等于字母序下标（CET4 实测 1..4515），已用 Linguabase
 *   真实 core_rank 修正；此处直接消费修正后的值即可，缺失时退到字母序（原行为）。
 */
export function sortWords(words: ContentWord[]): ContentWord[] {
  return [...words].sort((a, b) => {
    if (a.difficulty_level !== b.difficulty_level) {
      return a.difficulty_level - b.difficulty_level
    }
    if (a.word.length !== b.word.length) {
      return a.word.length - b.word.length
    }
    const ra = a.frequency_rank ?? Number.POSITIVE_INFINITY
    const rb = b.frequency_rank ?? Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    return a.word.localeCompare(b.word)
  })
}

/** 闯关干扰项来源（见 05 §5.7）：同 difficulty_level 随机抽 3 个释义，不足则降级相邻难度 */
export function pickDistractors(
  pool: ContentWord[],
  answer: ContentWord,
  count = 3,
): string[] {
  const sameLevel = pool.filter(
    (w) => w.id !== answer.id && w.difficulty_level === answer.difficulty_level,
  )
  const source = sameLevel.length >= count ? sameLevel : pool.filter((w) => w.id !== answer.id)
  const shuffled = [...source].sort(() => Math.random() - 0.5)
  return shuffled
    .map((w) => w.definition_zh ?? w.definition_en ?? '')
    .filter(Boolean)
    .slice(0, count)
}

export type { DifficultyLevel }

/**
 * 词库查词（用于阅读器「点/长按单词」时回显音标/释义）。
 * 懒加载全部词本建 Map，缓存一次；22k 词内存占用可接受。
 */
let wordMapCache: Promise<Map<string, ContentWord>> | null = null

export function getWordMap(): Promise<Map<string, ContentWord>> {
  if (!wordMapCache) {
    wordMapCache = (async () => {
      const idx = await loadIndex()
      if (!idx) return new Map()
      const all = (await Promise.all(idx.books.map((b) => loadBookFile(b.file)))).flat()
      const m = new Map<string, ContentWord>()
      for (const w of all) m.set(w.word.toLowerCase(), w)
      return m
    })()
  }
  return wordMapCache
}

/** 按单词（大小写不敏感）查词库条目；命中返回 ContentWord，否则 null。 */
export async function lookupWord(word: string): Promise<ContentWord | null> {
  const m = await getWordMap()
  return m.get(word.toLowerCase()) ?? null
}

/**
 * 按单词加载**完整**词条（单词详情页用）。
 *
 * 路径：先用搜索索引定位所属词本 → 只加载那本（2-8MB）。
 * 不走 `getWordMap` 是因为它会 `Promise.all` 五本全量（约 19MB），
 * 详情页这种一次只看一个词的场景没必要。
 *
 * @param opts.fullScan 索引里查不到时，是否回退到全量建 Map（默认 true）
 */
export async function loadWordDetail(
  word: string,
  opts?: { fullScan?: boolean },
): Promise<ContentWord | null> {
  const q = word.trim().toLowerCase()
  if (!q) return null
  const hits = await repository.searchAllWords(q, 20).catch(() => [] as SearchHit[])
  const exact = hits.find((h) => h.word.toLowerCase() === q)
  if (exact) {
    const list = await repository.getWords(exact.book).catch(() => [] as ContentWord[])
    const full = list.find((w) => w.id === exact.id)
    if (full) return full
  }
  if (opts?.fullScan === false) return null
  return lookupWord(q)
}

/**
 * 依次尝试一组候选词形（例句中点击的常是 books / went 这类屈折形式）。
 * 先走便宜的索引路径，全部落空才做一次全量建 Map。
 * 查不到就返回 null，由 UI 如实显示「词库未收录」——不猜释义。
 */
export async function lookupWordVariants(
  candidates: readonly string[],
): Promise<ContentWord | null> {
  for (const c of candidates) {
    const hit = await loadWordDetail(c, { fullScan: false })
    if (hit) return hit
  }
  const m = await getWordMap().catch(() => null)
  if (!m) return null
  for (const c of candidates) {
    const hit = m.get(c.toLowerCase())
    if (hit) return hit
  }
  return null
}
