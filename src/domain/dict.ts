/**
 * 词典扫描库 · 领域层
 * ------------------------------------------------------------------
 * 只写业务规则：本地缓存的读写、三种检索（精确 / 前缀 / 全文）、增量同步落库。
 * 不直接 import dexie（走 storage），不直接 fetch（走 data/dictClient）。
 *
 * 检索优先级：
 *   1. 精确匹配  whereIndex('word_lower', q)
 *   2. 前缀匹配  whereStartsWith('word_lower', q)      ← 搜索建议 / 自动补全主力
 *   3. 全文匹配  索引结果不足时在候选集内做子串兜底（释义 / 例句 / 同反义 / 标签）
 */

import { fetchDictionaryEntriesByWord } from '@/data/dictClient'
import { storage } from '@/services/storage'
import type {
  DictEntry,
  DictGrammarRule,
  DictMeta,
  DictSense,
  DictTocNode,
} from '@/domain/types'
import type {
  DictSyncResponse,
  SyncEntry,
  SyncGrammarRule,
  SyncToc,
} from '@/data/dictClient'

/** 与后端 shutree_normalize_key 对齐：折叠空白 + 小写 */
export function dictKey(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function entryKeyOf(word: string, pos: string): string {
  return `${dictKey(word)}|${dictKey(pos)}`
}

export function grammarKeyOf(type: string, baseForm: string): string {
  return `${dictKey(type)}|${dictKey(baseForm)}`
}

const SYNC_CURSOR_KEY = 'sync_cursor'
const META_BOOK_KEY = 'last_book'

/* ------------------------------------------------------------------ */
/* 增量同步                                                            */
/* ------------------------------------------------------------------ */

/** 后端 senses jsonb -> DictSense[]（逐条守卫：脏数据丢弃，绝不整条崩） */
function toSenses(value: unknown): DictSense[] {
  if (!Array.isArray(value)) return []
  const out: DictSense[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const zh = record['definitionZh']
    if (typeof zh !== 'string' || zh.trim() === '') continue
    const en = record['definitionEn']
    const examples = Array.isArray(record['examples']) ? record['examples'] : []
    const parsedExamples = examples
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        const exEn = item['en']
        const exZh = item['zh']
        return {
          en: typeof exEn === 'string' ? exEn : '',
          zh: typeof exZh === 'string' && exZh.trim() !== '' ? exZh : null,
        }
      })
      .filter((item) => item.en !== '')
    out.push({
      definition_en: typeof en === 'string' && en.trim() !== '' ? en : null,
      definition_zh: zh,
      examples: parsedExamples,
    })
  }
  return out
}

function toEntry(row: SyncEntry): DictEntry {
  return {
    key: entryKeyOf(row.word, row.pos),
    id: row.id,
    word: row.word,
    word_lower: dictKey(row.word),
    phonetic: row.phonetic,
    pos: row.pos,
    definition_en: row.definitionEn,
    definition_zh: row.definitionZh,
    senses: toSenses(row.senses),
    examples: row.examples.map((e) => ({ en: e.en, zh: e.zh })),
    phrases: row.phrases.map((p) => ({ text: p.text, zh: p.meaning })),
    synonyms: row.synonyms,
    antonyms: row.antonyms,
    tags: row.tags,
    root_affix: row.rootAffix,
    source_page: row.sourcePage,
    source_book: row.sourceBook,
    updated_at: Date.parse(row.updatedAt) || Date.now(),
  }
}

function toToc(row: SyncToc): DictTocNode {
  return {
    id: row.id,
    book: row.sourceBook,
    title: row.title,
    parent_id: row.parentId,
    page_start: row.pageStart,
    page_end: row.pageEnd,
    order_index: row.orderIndex,
    level: 0, // 树层级在渲染时按 parent_id 推导，不落库
    updated_at: Date.parse(row.updatedAt) || Date.now(),
  }
}

function toGrammar(row: SyncGrammarRule): DictGrammarRule {
  return {
    key: grammarKeyOf(row.type, row.baseForm),
    id: row.id,
    type: row.type,
    base_form: row.baseForm,
    base_lower: dictKey(row.baseForm),
    past_tense: row.pastTense,
    past_participle: row.pastParticiple,
    extra: row.extra ?? {},
    source_book: row.sourceBook,
    source_page: row.sourcePage,
    updated_at: Date.parse(row.updatedAt) || Date.now(),
  }
}

export interface SyncApplyResult {
  entries: number
  toc: number
  grammar: number
  nextSince: number
  truncated: boolean
}

/** 把后端增量同步结果写入本地缓存（upsert：同键覆盖，不做字段级合并——后端已合并过） */
export async function applySyncPayload(payload: DictSyncResponse): Promise<SyncApplyResult> {
  const entries = payload.entries.map(toEntry)
  const toc = payload.toc.map(toToc)
  const grammar = payload.grammarRules.map(toGrammar)

  if (entries.length > 0) await storage.table('dictEntries').bulkPut(entries)
  if (toc.length > 0) await storage.table('dictToc').bulkPut(toc)
  if (grammar.length > 0) await storage.table('dictGrammar').bulkPut(grammar)

  const nextSince = Number(payload.nextSince) || 0
  await setMeta(SYNC_CURSOR_KEY, nextSince)

  const firstBook = payload.entries[0]?.sourceBook ?? payload.toc[0]?.sourceBook ?? ''
  if (firstBook !== '') await setMeta(META_BOOK_KEY, Number(nextSince))

  return {
    entries: entries.length,
    toc: toc.length,
    grammar: grammar.length,
    nextSince,
    truncated: payload.truncated,
  }
}

async function readMeta(key: string): Promise<DictMeta | undefined> {
  return storage.table('dictMeta').get(key)
}

export async function getSyncCursor(): Promise<number> {
  const row = await readMeta(SYNC_CURSOR_KEY)
  return row?.since ?? 0
}

export async function setMeta(key: string, since: number): Promise<void> {
  await storage.table('dictMeta').put({ key, since, updated_at: Date.now() })
}

export async function resetDictCache(): Promise<void> {
  await storage.table('dictEntries').clear()
  await storage.table('dictToc').clear()
  await storage.table('dictGrammar').clear()
  await storage.table('dictMeta').clear()
}

/* ------------------------------------------------------------------ */
/* 检索：精确 / 前缀 / 全文                                             */
/* ------------------------------------------------------------------ */

/** 全文兜底时最多扫多少条（避免在超大缓存里做无界过滤） */
const FULLTEXT_SCAN_LIMIT = 5000

export type DictMatchKind = 'exact' | 'prefix' | 'fulltext'

export interface DictHit {
  entry: DictEntry
  match: DictMatchKind
  /** 越大越相关：精确 100 / 前缀 60 / 全文 10~30 */
  score: number
}

function fulltextScore(entry: DictEntry, q: string): number {
  let score = 0
  if (entry.word_lower.includes(q)) score += 30
  if (entry.definition_zh.toLowerCase().includes(q)) score += 20
  if (entry.definition_en.toLowerCase().includes(q)) score += 15
  if (entry.tags.some((t) => t.toLowerCase().includes(q))) score += 10
  if (entry.synonyms.some((s) => s.toLowerCase().includes(q))) score += 8
  if (entry.antonyms.some((s) => s.toLowerCase().includes(q))) score += 8
  if (entry.examples.some((e) => e.en.toLowerCase().includes(q) || (e.zh ?? '').includes(q))) {
    score += 6
  }
  return score
}

/** 本地三档检索 */
export async function searchDictLocal(query: string, limit = 30): Promise<DictHit[]> {
  const q = dictKey(query)
  if (q === '') return []

  const table = storage.table('dictEntries')

  // 1) 精确
  const exact = await table.whereIndex('word_lower', q)
  const hits: DictHit[] = exact.slice(0, limit).map((entry) => ({
    entry,
    match: 'exact' as DictMatchKind,
    score: 100,
  }))

  // 2) 前缀（搜索建议主力）
  if (hits.length < limit) {
    const prefixed = await table.whereStartsWith('word_lower', q)
    for (const entry of prefixed) {
      if (hits.length >= limit) break
      if (hits.some((h) => h.entry.key === entry.key)) continue
      hits.push({ entry, match: 'prefix', score: 60 })
    }
  }

  // 3) 全文兜底（只在精确+前缀不够时做，且限制扫描条数）
  if (hits.length < limit) {
    const all = await table.toArray()
    const scanned = all.slice(0, FULLTEXT_SCAN_LIMIT)
    const scored = scanned
      .filter((entry) => !hits.some((h) => h.entry.key === entry.key))
      .map((entry) => ({ entry, score: fulltextScore(entry, q) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    for (const item of scored) {
      if (hits.length >= limit) break
      hits.push({ entry: item.entry, match: 'fulltext', score: Math.min(30, item.score) })
    }
  }

  return hits
}

/** 搜索建议 / 自动补全：只返回词形，按前缀优先 */
export async function suggestDictWords(query: string, limit = 8): Promise<string[]> {
  const q = dictKey(query)
  if (q === '') return []
  const table = storage.table('dictEntries')

  const seen = new Set<string>()
  const out: string[] = []
  const push = (word: string): void => {
    const key = dictKey(word)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    out.push(word)
  }

  for (const entry of await table.whereIndex('word_lower', q)) push(entry.word)
  if (out.length < limit) {
    for (const entry of await table.whereStartsWith('word_lower', q)) {
      if (out.length >= limit) break
      push(entry.word)
    }
  }
  return out.slice(0, limit)
}

/* ------------------------------------------------------------------ */
/* 词条 / 目录 / 语法规则读取                                           */
/* ------------------------------------------------------------------ */

export async function getDictEntry(key: string): Promise<DictEntry | undefined> {
  return storage.table('dictEntries').get(key)
}

export async function getDictEntryByWord(word: string): Promise<DictEntry[]> {
  return storage.table('dictEntries').whereIndex('word_lower', dictKey(word))
}

/**
 * 详情页用（2026-10-06 搜索改全局后配套）：
 * 本地已同步过 → 直接用本地；本地没有 → 回退服务端按词取完整词条。
 * 服务端结果**不落本地缓存**——本地 dictEntries 由同步链路（syncSeq 游标）管理，
 * 绕过游标写会造成增量同步语义混乱；回退结果只作当次展示。
 */
export async function lookupDictEntries(word: string): Promise<DictEntry[]> {
  const local = await getDictEntryByWord(word).catch(() => [] as DictEntry[])
  if (local.length > 0) return local
  const remote = await fetchDictionaryEntriesByWord(word).catch(() => null)
  if (remote === null || remote.entries.length === 0) return []
  return remote.entries.map(toEntry)
}

export interface DictTocTreeNode extends DictTocNode {
  children: DictTocTreeNode[]
}

/** 取某本书的目录树；无数据返回空数组（由页面显示 EmptyState，不造假） */
export async function getDictTocTree(book: string): Promise<DictTocTreeNode[]> {
  const rows = await storage.table('dictToc').whereIndex('book', book)
  if (rows.length === 0) return []

  const nodes = new Map<string, DictTocTreeNode>()
  for (const row of rows) nodes.set(row.id, { ...row, children: [] })

  const roots: DictTocTreeNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id)
    if (!node) continue
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortRec = (list: DictTocTreeNode[]): void => {
    list.sort((a, b) => a.order_index - b.order_index)
    for (const child of list) sortRec(child.children)
  }
  sortRec(roots)
  return roots
}

/** 已缓存的书目列表（用于目录树切换） */
export async function listDictBooks(): Promise<string[]> {
  const rows = await storage.table('dictToc').toArray()
  return [...new Set(rows.map((r) => r.book))].filter((b) => b !== '').sort()
}

/** 语法 / 变形规则：先精确，再前缀 */
export async function searchGrammar(baseForm: string, type = ''): Promise<DictGrammarRule[]> {
  const q = dictKey(baseForm)
  if (q === '') return []
  const table = storage.table('dictGrammar')
  const exact = await table.whereIndex('base_lower', q)
  const filtered = type === '' ? exact : exact.filter((r) => r.type === type)
  if (filtered.length > 0) return filtered
  const prefixed = await table.whereStartsWith('base_lower', q)
  return type === '' ? prefixed : prefixed.filter((r) => r.type === type)
}

export async function countDictCache(): Promise<{
  entries: number
  toc: number
  grammar: number
}> {
  const [entries, toc, grammar] = await Promise.all([
    storage.table('dictEntries').count(),
    storage.table('dictToc').count(),
    storage.table('dictGrammar').count(),
  ])
  return { entries, toc, grammar }
}
