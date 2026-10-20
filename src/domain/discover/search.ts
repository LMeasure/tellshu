/**
 * 书籍语义检索 · 领域编排（M4 之后接入）
 * ------------------------------------------------------------------
 * 职责：query 校验 → 带重试地调用 discoverClient → 响应契约校验 →
 * 映射为 UI 友好的 BookHit。页面只面对这里的类型，不碰 HTTP 细节。
 *
 * 重试口径（与 dataClient 的 isRetryable 同源，写死在这里避免页面各写一套）：
 *   4xx 不重试（400 参数问题、503 未接入都是明确结论，重试无意义）；
 *   503 也不自动重试——它表示检索服务未启动/编码器未就绪，是明确结论，
 *     自动重试只会让用户多等 1.2s 才看到引导（需要时用户可点「重试」）；
 *   500/502/504 与网络错误重试——共 3 次尝试（首次 + 2 次重试，退避 400ms×n）。
 *
 * 契约校验（红线：坏数据不进 UI）：results 必须是数组、每项必须带
 * title/content/score 且 score 是有限数；meta.returned 必须等于
 * results.length。任何一条不符 → bad_response，页面走错误态，
 * 绝不用半截数据渲染卡片。
 */

import {
  searchBooks as requestSearchBooks,
  type DiscoverResponse,
  type DiscoverResultItem,
} from '@/data/discoverClient'
import { ApiRequestError } from '@/data/asrClient'

/** UI 友好的检索命中（snake_case → camelCase 在域层一次做完） */
export interface BookHit {
  title: string
  author: string
  /** 章节名；front matter 块为 null，如实不显示该行（不编造章节） */
  chapterTitle: string | null
  chunkIndex: number
  content: string
  /** 余弦相似度（0~1，保留 6 位） */
  score: number
}

export interface BookSearchOutcome {
  query: string
  hits: BookHit[]
  /** 服务端 e2e（编码 + 检索，ms）；头部展示用 */
  e2eMs: number
}

/** 失败分类：页面按 kind 选文案与是否显示重试按钮 */
export type BookSearchFailureKind =
  | 'empty_query' // 空 query：本地拦截，不发请求
  | 'timeout' // 超时（含重试后仍超时）
  | 'unavailable' // 503 / 连接失败：检索服务未启动
  | 'bad_request' // 4xx：服务端拒绝（参数越界等）
  | 'server_error' // 5xx 重试后仍失败
  | 'bad_response' // 200 但契约不符

export class BookSearchError extends Error {
  constructor(
    readonly kind: BookSearchFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'BookSearchError'
  }
}

/** 是否值得自动重试：网络层失败（status 0）与 500/502/504。503 与 4xx 不重试。 */
function isRetryable(status: number): boolean {
  if (status === 0) return true
  if (status === 503) return false // 检索服务未启动：明确结论，不自动重试（手动重试按钮兜底）
  return status >= 500
}

const MAX_ATTEMPTS = 3 // 共 3 次尝试（首次 + 2 次重试）；口径同 dataClient 循环 attempt <= retries

function toBookHit(item: DiscoverResultItem): BookHit {
  return {
    title: item.title,
    author: item.author,
    chapterTitle: item.chapter_title,
    chunkIndex: item.chunk_index,
    content: item.content,
    score: item.score,
  }
}

/** 200 响应的契约校验；不合法抛 BookSearchError('bad_response')。 */
function validateResponse(body: DiscoverResponse): void {
  if (!Array.isArray(body?.results)) {
    throw new BookSearchError('bad_response', '检索响应缺少 results 数组')
  }
  for (const item of body.results) {
    if (typeof item?.title !== 'string' || typeof item?.content !== 'string') {
      throw new BookSearchError('bad_response', '检索响应存在缺少 title/content 的结果项')
    }
    if (typeof item?.score !== 'number' || !Number.isFinite(item.score)) {
      throw new BookSearchError('bad_response', '检索响应存在非法 score')
    }
  }
  if (typeof body.meta?.returned !== 'number' || body.meta.returned !== body.results.length) {
    throw new BookSearchError('bad_response', '检索响应 meta.returned 与结果条数不符')
  }
}

/** 把 client 的 ApiRequestError 映射为领域错误分类。 */
function classify(error: unknown): BookSearchError {
  if (error instanceof BookSearchError) return error
  if (error instanceof ApiRequestError) {
    if (error.status === 0) return new BookSearchError('timeout', error.message)
    if (error.status === 503) return new BookSearchError('unavailable', error.message)
    if (error.status >= 500) return new BookSearchError('server_error', error.message)
    return new BookSearchError('bad_request', error.message)
  }
  return new BookSearchError('server_error', error instanceof Error ? error.message : String(error))
}

/**
 * 语义检索书籍。
 *
 * @param query 中文或英文语义 query（空串/纯空白直接拦截，不发请求）
 * @param opts.signal 外部取消信号（组件卸载 / 新一轮搜索顶掉上一轮）
 */
export async function searchBooks(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<BookSearchOutcome> {
  const trimmed = query.trim()
  if (trimmed === '') {
    throw new BookSearchError('empty_query', '请输入想找的书或情节')
  }

  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new BookSearchError('timeout', '已取消本次检索')
    }
    try {
      const body = await requestSearchBooks(trimmed, { top_k: 10 }, opts.signal)
      validateResponse(body)
      return {
        query: trimmed,
        hits: body.results.map(toBookHit),
        e2eMs: body.latency?.e2e_ms ?? 0,
      }
    } catch (error) {
      if (error instanceof BookSearchError && error.kind === 'bad_response') throw error
      // 外部取消（新一轮搜索顶掉上一轮 / 组件卸载）：不等重试，直接收摊
      if (opts.signal?.aborted) {
        throw new BookSearchError('timeout', '已取消本次检索')
      }
      lastError = error
      const status = error instanceof ApiRequestError ? error.status : 0
      if (!isRetryable(status)) break
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
      }
    }
  }
  throw classify(lastError)
}
