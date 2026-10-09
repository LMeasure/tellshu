/**
 * 词典扫描库 · UI 状态（zustand）
 * ------------------------------------------------------------------
 * 只放**轻量 UI 状态**：查询词、结果、加载态、管理员解锁状态。
 * 词条 / 目录 / 语法数据一律落 Dexie（见 domain/dict.ts），不进 store，
 * 避免把几万条数据塞进内存与 localStorage。
 *
 * 管理员密钥只存在内存里（刷新即失效），不落 localStorage。
 */

import { create } from 'zustand'

import {
  applySyncPayload,
  countDictCache,
  getSyncCursor,
  searchDictLocal,
  searchGrammar,
  suggestDictWords,
  type DictHit,
} from '@/domain/dict'
import type { DictEntry, DictGrammarRule } from '@/domain/types'
import {
  fetchDictionarySync,
  setAdminToken,
  type PageKind,
  type ScanItem,
  type ScanProcessSummary,
} from '@/data/dictClient'

export type DictTab = 'search' | 'toc' | 'grammar' | 'upload'

interface CacheCount {
  entries: number
  toc: number
  grammar: number
}

interface DictState {
  tab: DictTab
  query: string
  hits: DictHit[]
  suggestions: string[]
  searching: boolean
  error: string | null

  /** 语法规则检索结果 */
  grammarRules: DictGrammarRule[]
  grammarQuery: string

  /** 权限入口：输入管理员密钥后解锁上传 */
  hasAdmin: boolean
  adminError: string | null

  /** 上传进度 */
  uploading: boolean
  uploadError: string | null
  lastBatchId: string | null
  uploadedScans: ScanItem[]
  uploadSummary: ScanProcessSummary | null

  /** 增量同步 */
  syncing: boolean
  syncError: string | null
  lastSync: (CacheCount & { at: number }) | null
  cacheCount: CacheCount

  setTab(tab: DictTab): void
  setQuery(q: string): void
  runSearch(q: string): Promise<void>
  runSuggest(q: string): Promise<void>
  clearSearch(): void
  runGrammarSearch(q: string): Promise<void>

  unlock(tokenInput: string): void
  markUploadStarted(): void
  markUploadDone(batchId: string, scans: ScanItem[]): void
  markUploadFailed(message: string): void
  setUploadSummary(summary: ScanProcessSummary): void
  markUploadIdle(): void

  syncFromServer(): Promise<void>
  refreshCacheCount(): Promise<void>
  reset(): void
}

const EMPTY_COUNT: CacheCount = { entries: 0, toc: 0, grammar: 0 }

export const useDictStore = create<DictState>((set, get) => ({
  tab: 'search',
  query: '',
  hits: [],
  suggestions: [],
  searching: false,
  error: null,

  grammarRules: [],
  grammarQuery: '',

  hasAdmin: false,
  adminError: null,

  uploading: false,
  uploadError: null,
  lastBatchId: null,
  uploadedScans: [],
  uploadSummary: null,

  syncing: false,
  syncError: null,
  lastSync: null,
  cacheCount: EMPTY_COUNT,

  setTab(tab) {
    set({ tab })
  },

  setQuery(q) {
    set({ query: q })
  },

  async runSearch(q) {
    const query = q.trim()
    set({ query, searching: true, error: null })
    if (query === '') {
      set({ hits: [], searching: false })
      return
    }
    try {
      const hits = await searchDictLocal(query, 30)
      set({ hits, searching: false })
    } catch (error) {
      set({
        hits: [],
        searching: false,
        error: error instanceof Error ? error.message : '本地检索失败',
      })
    }
  },

  async runSuggest(q) {
    const query = q.trim()
    if (query === '') {
      set({ suggestions: [] })
      return
    }
    try {
      const suggestions = await suggestDictWords(query, 8)
      set({ suggestions })
    } catch {
      set({ suggestions: [] })
    }
  },

  clearSearch() {
    set({ query: '', hits: [], suggestions: [], error: null })
  },

  async runGrammarSearch(q) {
    set({ grammarQuery: q })
    if (q.trim() === '') {
      set({ grammarRules: [] })
      return
    }
    try {
      const grammarRules = await searchGrammar(q.trim(), '')
      set({ grammarRules })
    } catch {
      set({ grammarRules: [] })
    }
  },

  unlock(tokenInput) {
    const token = tokenInput.trim()
    if (token === '') {
      set({ adminError: '请输入管理员密钥', hasAdmin: false })
      return
    }
    setAdminToken(token)
    set({ hasAdmin: true, adminError: null })
  },

  markUploadStarted() {
    set({ uploading: true, uploadError: null, uploadSummary: null })
  },

  markUploadDone(batchId, scans) {
    set({ uploading: false, lastBatchId: batchId, uploadedScans: scans })
  },

  markUploadFailed(message) {
    set({ uploading: false, uploadError: message })
  },

  setUploadSummary(summary) {
    set({ uploadSummary: summary })
  },

  markUploadIdle() {
    set({ uploading: false })
  },

  async syncFromServer() {
    set({ syncing: true, syncError: null })
    try {
      const since = await getSyncCursor()
      const payload = await fetchDictionarySync(since, 300)
      const result = await applySyncPayload(payload)
      const cacheCount = await countDictCache()
      set({
        syncing: false,
        lastSync: {
          entries: result.entries,
          toc: result.toc,
          grammar: result.grammar,
          at: Date.now(),
        },
        cacheCount,
      })
      // 同步后若正在搜索，刷新一次结果
      const { query } = get()
      if (query.trim() !== '') await get().runSearch(query)
    } catch (error) {
      set({
        syncing: false,
        syncError: error instanceof Error ? error.message : '同步失败',
      })
    }
  },

  async refreshCacheCount() {
    try {
      const cacheCount = await countDictCache()
      set({ cacheCount })
    } catch {
      set({ cacheCount: EMPTY_COUNT })
    }
  },

  reset() {
    set({
      query: '',
      hits: [],
      suggestions: [],
      error: null,
      grammarRules: [],
      grammarQuery: '',
      uploadSummary: null,
      uploadedScans: [],
      lastBatchId: null,
    })
  },
}))

/** 供上传面板复用的页面类型选项 */
export const PAGE_KIND_OPTIONS: ReadonlyArray<{ value: PageKind; label: string }> = [
  { value: 'toc', label: '目录页' },
  { value: 'entry', label: '单词正文页' },
  { value: 'table', label: '表格页（不规则动词 / 语法）' },
  { value: 'instruction', label: '使用说明页' },
  { value: 'unknown', label: '未分类（让后端自动判断）' },
]

/** 供词条详情复用的空值兜底文案（不编造内容） */
export function firstEntryOf(hits: readonly DictHit[]): DictEntry | null {
  return hits[0]?.entry ?? null
}
