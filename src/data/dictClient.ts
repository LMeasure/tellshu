/**
 * 词典后端 API 客户端
 * ------------------------------------------------------------------
 * 只做 HTTP：提交扫描 / 轮询任务 / 增量同步 / 检索 / 翻译。
 * 不含任何业务规则（业务在 src/domain/dict.ts），不碰平台 API。
 *
 * ⚠️ PaddleOCR 令牌只在后端；这里最多带「管理员密钥」头，且只存在内存里。
 *
 * 环境变量：VITE_API_BASE_URL（默认 /api；本地联调设为 http://127.0.0.1:8787/api）
 */

/** 后端基址 */
export const DICT_API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? '/api'

/** 'parsed' = 解析完成、待人工确认（npm run db:confirm 后才入库） */
export type ScanStatus = 'queued' | 'pending' | 'running' | 'parsed' | 'done' | 'failed'
export type PageKind = 'material' | 'toc' | 'entry' | 'table' | 'instruction' | 'unknown'

export interface ScanError {
  code: string
  message: string
}

export interface ScanItem {
  scanId: string
  jobId: string | null
  status: ScanStatus
  imagePath: string | null
  error?: ScanError | null
}

export interface SubmitScansResponse {
  batchId: string
  count: number
  scans: ScanItem[]
}

export interface ScanProcessSummary {
  pageKind: PageKind
  entriesUpserted: number
  tocUpserted: number
  grammarUpserted: number
  blocks: number
  tables: number
  parserRulesUpdated: boolean
}

export interface JobStatusResponse {
  scanId: string
  batchId: string
  jobId: string | null
  status: ScanStatus
  sourceBook: string
  pageKind: PageKind
  text: string | null
  summary: ScanProcessSummary | null
  error: ScanError | null
}

export interface BatchStatusResponse {
  batchId: string
  total: number
  processed: number
  summary: ScanProcessSummary
  scans: Array<{ scanId: string; status: ScanStatus; text: string | null; error: ScanError | null }>
}

export interface DictExample {
  en: string
  zh: string | null
}

export interface DictPhrase {
  text: string
  meaning: string | null
}

export interface DictSense {
  definitionEn: string | null
  definitionZh: string
  examples: DictExample[]
}

export interface SyncEntry {
  id: string
  syncSeq: string
  word: string
  phonetic: string | null
  pos: string
  definitionEn: string
  definitionZh: string
  /** 义项分组（例句挂在自己所属的释义下；空数组 = 该词条未产出分组） */
  senses: DictSense[]
  examples: DictExample[]
  synonyms: string[]
  antonyms: string[]
  phrases: DictPhrase[]
  tags: string[]
  rootAffix: string | null
  sourcePage: number | null
  sourceBook: string
  updatedAt: string
}

export interface SyncToc {
  id: string
  syncSeq: string
  sourceBook: string
  title: string
  parentId: string | null
  pageStart: number
  pageEnd: number | null
  orderIndex: number
  updatedAt: string
}

export interface SyncGrammarRule {
  id: string
  syncSeq: string
  type: string
  baseForm: string
  pastTense: string | null
  pastParticiple: string | null
  extra: Record<string, string>
  sourceBook: string
  sourcePage: number | null
  updatedAt: string
}

export interface DictSyncResponse {
  since: string
  nextSince: string
  limit: number
  truncated: boolean
  entries: SyncEntry[]
  toc: SyncToc[]
  grammarRules: SyncGrammarRule[]
}

export interface DictSearchHit {
  id: string
  word: string
  phonetic: string | null
  pos: string
  definitionEn: string
  definitionZh: string
  matchKind: 'exact' | 'prefix' | 'fulltext' | 'fuzzy'
  score: number
}

export interface DictSearchResponse {
  query: string
  limit: number
  total: number
  hits: DictSearchHit[]
}

/** 内置词本引用（服务端已解析 name，前端直接展示） */
export interface GlobalWordBook {
  id: string
  name: string
}

/** 内置词库命中（words 表，随 /api/search 一起返回） */
export interface GlobalWordHit {
  id: string
  word: string
  ipa: string | null
  pos: string | null
  definitionZh: string
  books: GlobalWordBook[]
  matchKind: 'exact' | 'prefix' | 'contains' | 'zh'
}

/** 全局搜索响应：内置词库 + 词典扫描库一次返回 */
export interface GlobalSearchResponse {
  query: string
  limit: number
  total: number
  hits: DictSearchHit[]
  words: GlobalWordHit[]
}

/** 按单词取完整扫描词条（含 senses/examples，详情页服务端回退用） */
export interface EntriesByWordResponse {
  word: string
  entries: SyncEntry[]
}

export interface TranslateResult {
  translatedText: string
  source: string
  target: string
  detectedSource: string | null
}

const DEFAULT_TIMEOUT_MS = 30_000

function endpoint(path: string): string {
  return `${DICT_API_BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let payload: unknown = null
    if (text !== '') {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = null
      }
    }
    if (!response.ok) {
      const body =
        payload !== null && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: { message?: string; code?: string } }).error
          : undefined
      throw new Error(body?.message ?? `请求失败（HTTP ${response.status}）`)
    }
    if (payload === null) {
      // 200 但 body 不是 JSON —— 典型场景：前端服务器没配 /api 代理时，
      // GET /api/* 被 SPA 回退接住返回 index.html。明确报错，
      // 绝不让 null 流进上层把 TypeError 暴露给用户。
      throw new Error('服务返回异常（响应不是 JSON），请确认后端服务已启动')
    }
    return payload as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试')
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function appendImages(form: FormData, images: Array<{ blob: Blob; name: string }>): void {
  for (const image of images) {
    form.append('images', image.blob, image.name)
  }
}

/** 管理端密钥（仅内存；刷新即失效，不落 localStorage） */
let adminToken = ''

export function setAdminToken(token: string): void {
  adminToken = token.trim()
}

export function getAdminToken(): string {
  return adminToken
}

/* ------------------------------------------------------------------ */
/* 功能 A：素材识别 + 在线翻译                                          */
/* ------------------------------------------------------------------ */

/** 提交素材图片（公开接口，后端可通过 OCR_PUBLIC_ENABLED 关闭） */
export async function submitMaterialScans(
  images: Array<{ blob: Blob; name: string }>,
  sourceBook = '',
): Promise<SubmitScansResponse> {
  const form = new FormData()
  appendImages(form, images)
  if (sourceBook !== '') form.append('sourceBook', sourceBook)
  return requestJson<SubmitScansResponse>(endpoint('/ocr/material'), { method: 'POST', body: form })
}

/** 轮询单个任务；done 且用途为 material 时返回识别文本 */
export async function fetchScanJob(scanId: string): Promise<JobStatusResponse> {
  return requestJson<JobStatusResponse>(endpoint(`/ocr/jobs/${encodeURIComponent(scanId)}`), {
    timeoutMs: 60_000,
  })
}

/** 在线翻译；后端未配置翻译服务时抛错（503），调用方需显示「未接入」而不是造假 */
export async function translateText(
  q: string,
  source = 'en',
  target = 'zh',
): Promise<TranslateResult> {
  return requestJson<TranslateResult>(endpoint('/translate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, source, target }),
  })
}

/* ------------------------------------------------------------------ */
/* 功能 B：词典扫描入库 + 检索                                          */
/* ------------------------------------------------------------------ */

/** 批量提交词典扫描页（需管理员密钥） */
export async function submitDictionaryScans(input: {
  images: Array<{ blob: Blob; name: string }>
  sourceBook: string
  pageKind: PageKind
  pageNumbers?: Array<number | null>
}): Promise<SubmitScansResponse> {
  const form = new FormData()
  appendImages(form, input.images)
  form.append('sourceBook', input.sourceBook)
  form.append('pageKind', input.pageKind)
  const pageNumbers = input.pageNumbers ?? []
  if (pageNumbers.length > 0) {
    form.append('pageNumbers', pageNumbers.map((n) => (n === null ? '' : String(n))).join(','))
  }
  return requestJson<SubmitScansResponse>(endpoint('/admin/dictionary/scans'), {
    method: 'POST',
    body: form,
    headers: adminToken === '' ? {} : { Authorization: `Bearer ${adminToken}` },
  })
}

/** 批量任务状态（会顺带把已完成的页解析入库） */
export async function fetchDictionaryBatch(batchId: string): Promise<BatchStatusResponse> {
  return requestJson<BatchStatusResponse>(
    endpoint(`/admin/dictionary/batches/${encodeURIComponent(batchId)}`),
    {
      headers: adminToken === '' ? {} : { Authorization: `Bearer ${adminToken}` },
      timeoutMs: 120_000,
    },
  )
}

/** 增量同步：拉取 since 之后的变更，写入本地 Dexie */
export async function fetchDictionarySync(since: number, limit = 300): Promise<DictSyncResponse> {
  const query = new URLSearchParams({ since: String(since), limit: String(limit) })
  return requestJson<DictSyncResponse>(endpoint(`/sync/dictionary?${query.toString()}`), {
    timeoutMs: 60_000,
  })
}

/**
 * 全局搜索（2026-10-06 起搜索主路径）：
 * 服务端一次检索「内置 5 本词库（words 表）+ 词典扫描库（entries 表）」。
 * 搜索页在服务端不可达时才回退本地索引（PWA 离线兜底）。
 */
export async function searchGlobal(query: string, limit = 40): Promise<GlobalSearchResponse> {
  const qs = new URLSearchParams({ q: query.trim(), limit: String(limit) })
  return requestJson<GlobalSearchResponse>(endpoint(`/search?${qs.toString()}`), {
    timeoutMs: 8_000,
  })
}

/** 按单词取扫描库完整词条（详情页：本地没同步过时从服务端拿，不落本地缓存） */
export async function fetchDictionaryEntriesByWord(word: string): Promise<EntriesByWordResponse> {
  const qs = new URLSearchParams({ word: word.trim() })
  return requestJson<EntriesByWordResponse>(endpoint(`/dictionary/entries?${qs.toString()}`), {
    timeoutMs: 8_000,
  })
}

/** 后端检索（本地缓存为空 / 需要模糊匹配时使用） */
export async function searchDictionary(q: string, limit = 30): Promise<DictSearchResponse> {
  const query = new URLSearchParams({ q, limit: String(limit) })
  return requestJson<DictSearchResponse>(endpoint(`/search?${query.toString()}`))
}
