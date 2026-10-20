/**
 * 书籍语义检索后端 API 客户端（M4 之后接入）
 * ------------------------------------------------------------------
 * 只做 HTTP：POST /api/discover 提交中文/英文语义 query，返回 HNSW
 * 检索命中的书籍片段。不含任何业务规则（编排、重试与错误分类在
 * src/domain/discover/search.ts），不碰平台 API。
 *
 * 与 dictClient / asrClient 的关系：同为 VITE_API_BASE_URL 基址
 * （默认 /api）。requestJson 沿用 asrClient 范式——globalThis.setTimeout
 * （tsx 单测可跑）+ ApiRequestError 带 HTTP status（503 = 检索服务
 * 未启动，UI 走空态引导）+ 非 JSON 响应显式报错（SPA 回退防护）。
 *
 * ⚠️ 基址走 /api 同源路径：dev/preview 由 vite 代理把 /api/discover
 * 转发到本机 8000 的检索 API（见 vite.config.ts 的 apiProxy 键序注释，
 * /api/discover 必须先于 /api 注册，否则会被 8787 的 Node 后端接走）。
 * FastAPI 侧未配 CORS，所以前端绝不直连 8000 绝对地址。
 *
 * 服务端契约（api/main.py，M4 已验收，不改）：
 *   200 → { results, latency:{encode_ms,retrieve_ms,e2e_ms}, meta:{...} }
 *   400 → { error:{ code, message } }（含 not_implemented）
 *   503 → { error:{ code:'service_unavailable' } }
 *   500 → { error:{ code:'internal_error' } }
 */

import { ApiRequestError } from './asrClient'

/**
 * 后端基址（与词典/ASR/学习稿 API 同源同口径）。
 * 可选链是必须的：tsx 跑单测时 import.meta.env 为 undefined，
 * 直接取属性会 TypeError（与 asrClient / dictClient 同一口径）。
 */
export const DISCOVER_API_BASE: string = import.meta.env?.VITE_API_BASE_URL ?? '/api'

/**
 * 默认超时。检索 e2e 实测 ~28ms（B.12/M4），但冷启动与连接池排队
 * 可能到几百 ms；15s 对「一次编码 + 一次 HNSW」足够宽裕，
 * 又不至于让用户在真故障时空等。
 */
const DEFAULT_TIMEOUT_MS = 15_000

/** 检索命中的一个书籍片段（API 响应逐字透传，snake_case 不改写） */
export interface DiscoverResultItem {
  chunk_id: number
  book_id: string
  title: string
  author: string
  chapter_title: string | null
  chunk_index: number
  content: string
  score: number
}

export interface DiscoverLatency {
  encode_ms: number
  retrieve_ms: number
  e2e_ms: number
}

export interface DiscoverMeta {
  top_k: number
  returned: number
  ef_search: string
  iterative_scan: string
  include_front_matter: boolean
  explain_sampled: boolean
  sampled_plan_type: string | null
}

export interface DiscoverResponse {
  results: DiscoverResultItem[]
  latency: DiscoverLatency
  meta: DiscoverMeta
}

/** 请求体可选参数（契约子集：top_k 固定 10，ef 走连接池默认 800，不暴露给 UI） */
export interface DiscoverRequestInput {
  top_k?: number
}

function endpoint(path: string): string {
  return `${DISCOVER_API_BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  // 外部取消（新一轮搜索顶掉上一轮 / 组件卸载）必须真正取消在途请求，
  // 光在调用方抛弃 promise 不够——请求照发，白白占用服务端连接池。
  const external = init.signal
  const onExternalAbort = () => controller.abort()
  if (external !== undefined) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
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
      throw new ApiRequestError(response.status, body?.message ?? `请求失败（HTTP ${response.status}）`)
    }
    if (payload === null) {
      // 200 但 body 不是 JSON —— 典型场景：vite 代理没把 /api/discover
      // 转到 8000 时，路径被 SPA history 回退接住返回 index.html。
      // 明确报错，绝不让 null 流进上层把 TypeError 暴露给用户。
      throw new ApiRequestError(response.status, '服务返回异常（响应不是 JSON），请确认检索服务已启动')
    }
    return payload as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiRequestError(0, '请求超时，请稍后重试')
    }
    throw error
  } finally {
    globalThis.clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 语义检索书籍。query 用中文或英文均可（BGE-M3 跨语言；
 * query set 106 条锚点全部中文 query 检索英文书）。
 *
 * @param signal 外部取消信号：abort 时真正取消在途请求（不是只抛弃 promise）
 */
export async function searchBooks(
  query: string,
  input: DiscoverRequestInput = {},
  signal?: AbortSignal,
): Promise<DiscoverResponse> {
  return requestJson<DiscoverResponse>(endpoint('/discover'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: input.top_k ?? 10 }),
    signal,
  })
}
