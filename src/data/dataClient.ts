/**
 * 数据访问客户端（P0：词库数据外置）
 * ------------------------------------------------------------------
 * 背景：词库数据 410MB（含 353MB 英文释义分片）原先放在 `public/` 下，
 * vite 会在 build 时把它整包复制进 `dist`，构建产物爆炸且无法做灰度/换源。
 * 现在数据移到仓库根的 `data/linguabase/v1/`，**不参与打包**：
 *
 *   - 开发 / 本地预览：vite 中间件以同源路径 `/data/linguabase/v1/` 直出本地文件
 *   - 生产部署：由 `VITE_DATA_BASE_URL` 指向 Cloudflare R2 等对象存储
 *     （例：https://data.shushu.app/linguabase/v1/，需开启 CORS）
 *
 * 本模块是**唯一**的数据出口，统一负责：
 *   1. 基址解析（运行期覆盖 → 构建期 env → 同源回退）
 *   2. 相对路径拼接 + 目录穿越防护
 *   3. 超时（AbortController）/ 有限重试 / 并发请求去重
 *   4. 有界 LRU 缓存：释义分片上百 MB，绝不能无限驻留内存
 *
 * 约定：`fetchData` **永不抛异常**，失败返回调用方给的 fallback，
 * 与 repository 层"取不到就返回空集合、绝不编造假数据"的既有语义一致。
 */

/**
 * 数据版本号：数据目录带版本号（v1/v2…），前端发新版时新旧数据可并存，避免缓存串味。
 * 由 `VITE_DATA_VERSION` 覆盖，默认 `v1`。
 *
 * **路径即版本**：发新版数据 = 上传一份到 `linguabase/v2/`，再把本变量改成 `v2` 重新部署。
 * 老客户端继续读 `v1`，互不影响，可灰度、可秒回滚 —— 这是当初把版本号写进路径的用意，
 * 所以这里必须能靠环境变量切，而不是改代码。
 */
export const DATA_VERSION = (import.meta.env?.VITE_DATA_VERSION as string | undefined) || 'v1'

/**
 * 应用基址。写成 `import.meta.env?.BASE_URL` 而不是 `import.meta.env.BASE_URL`，
 * 是为了让本模块能在 Node（tsx 单测）里被 import —— 那里没有 vite 注入的 env。
 */
const APP_BASE = (import.meta.env?.BASE_URL as string | undefined) || '/'

/** 同源回退基址（开发中间件 / 自托管时数据就挂在这个路径下）。 */
const SAME_ORIGIN_BASE = `${APP_BASE}data/linguabase/${DATA_VERSION}/`

/** 运行期覆盖：允许不重新构建就切换数据源（写在 index.html 的 inline script 里）。 */
type RuntimeOverride = { __SHUSHU_DATA_BASE__?: string }

function normalizeBase(raw: string): string {
  const base = raw.trim()
  if (!base) return SAME_ORIGIN_BASE
  return base.endsWith('/') ? base : `${base}/`
}

function resolveBase(): string {
  const runtime = (globalThis as unknown as RuntimeOverride).__SHUSHU_DATA_BASE__
  if (runtime) return normalizeBase(runtime)
  const env = import.meta.env?.VITE_DATA_BASE_URL
  if (env) return normalizeBase(env)
  return SAME_ORIGIN_BASE
}

let cachedBase: string | null = null

/** 当前数据基址（惰性解析并缓存，末尾一定带 `/`）。 */
export function dataBaseUrl(): string {
  if (cachedBase === null) cachedBase = resolveBase()
  return cachedBase
}

/** 测试用：重置基址缓存（运行期覆盖可能在测试中途被改写）。 */
export function resetDataBaseUrl(): void {
  cachedBase = null
}

/**
 * 相对路径 → 完整 URL。
 * 传入的 rel 形如 `index.json` / `books/CET4.json` / `defs/bank_L1.json`。
 * 只允许仓库内生成的相对路径：去掉前导 `/`，出现 `..` 视为非法。
 */
export function dataUrl(rel: string): string {
  const clean = rel.replace(/^\/+/, '')
  if (clean.includes('..')) {
    throw new Error(`[dataClient] 非法数据路径（含 ..）：${rel}`)
  }
  return `${dataBaseUrl()}${clean}`
}

/** 是否有界缓存之外的自定义抓取选项。 */
export interface DataFetchOptions {
  /** 超时毫秒数，默认 30s（释义分片最大约 10MB，弱网下需要放宽）。 */
  timeoutMs?: number
  /** 额外重试次数（不含首次），默认 1；仅对网络错误与 5xx 生效。 */
  retries?: number
  /** 是否写入 LRU 缓存，默认 true。 */
  cache?: boolean
  /** 外部取消信号（如组件卸载）。 */
  signal?: AbortSignal
}

/** 飞行中请求表：仅用于并发去重，落地后立刻移除，不复用失败结果。 */
const inflight = new Map<string, Promise<unknown>>()

/**
 * 有界 LRU 缓存。**只缓存成功结果**——网络抖动导致的空结果如果被缓存，
 * 用户刷新前就再也拿不到数据了。
 */
class LruPromiseCache {
  private readonly map = new Map<string, unknown>()

  constructor(private readonly maxEntries: number) {}

  get<T>(key: string): Promise<T> | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as Promise<T>
    // 重新插入以刷新到最新（Map 保持插入顺序）
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set<T>(key: string, value: Promise<T>): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/**
 * 缓存上限 48 条。
 * 覆盖：索引类 4 + 词本 5 + 主题 46 + bank 30 + 常用释义若干；
 * 超出后淘汰最久未用，避免用户连刷 L3 时释义分片把内存吃满。
 */
const cache = new LruPromiseCache(48)

/** 测试 / 内存告警时用：清空数据缓存。 */
export function clearDataCache(): void {
  cache.clear()
  inflight.clear()
}

/** 当前缓存条目数（调试用）。 */
export function dataCacheSize(): number {
  return cache.size
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 1

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 超时 + 外部取消合并成一个 signal。 */
function createTimeoutSignal(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/** 是否值得重试：网络错误、超时、5xx。4xx（尤其 404）不重试——那是数据缺失。 */
function isRetryable(error: unknown, status?: number): boolean {
  if (status !== undefined) return status >= 500
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
}

/**
 * 抓取一个 JSON 数据分片。
 * @param rel     相对数据根目录的路径，如 `bank/L1.json`
 * @param fallback 失败时的返回值（空数组 / null / {}），**绝不编造真实词数据**
 * @param opts    超时、重试、缓存开关
 */
export async function fetchData<T>(
  rel: string,
  fallback: T,
  opts: DataFetchOptions = {},
): Promise<T> {
  const useCache = opts.cache !== false
  if (useCache) {
    const hit = cache.get<T>(rel)
    if (hit) return hit
    const pending = inflight.get(rel)
    if (pending) return pending as Promise<T>
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_RETRIES
  const url = dataUrl(rel)

  const task = runFetch<T>(url, fallback, timeoutMs, retries, opts.signal).then((result) => {
    inflight.delete(rel)
    // 只有拿到数据（非 fallback）才入缓存；失败让下一次调用重新尝试
    if (useCache && result !== fallback) cache.set(rel, Promise.resolve(result))
    return result
  })

  inflight.set(rel, task)
  return task
}

/** 真正的抓取循环：超时 / 重试 / 错误分类。 */
async function runFetch<T>(
  url: string,
  fallback: T,
  timeoutMs: number,
  retries: number,
  external?: AbortSignal,
): Promise<T> {
  let lastStatus: number | undefined
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt)
    const { signal, dispose } = createTimeoutSignal(timeoutMs, external)
    try {
      const res = await fetch(url, { signal })
      if (!res.ok) {
        lastStatus = res.status
        // 404/403 等：数据确实不存在，重试没有意义
        if (!isRetryable(undefined, res.status)) return fallback
        continue
      }
      return (await res.json()) as T
    } catch (error) {
      if (external?.aborted) return fallback // 调用方主动取消
      if (!isRetryable(error)) {
        console.error(`[dataClient] 读取失败 ${url}`, error)
        return fallback
      }
      lastStatus = undefined
      if (attempt === retries) {
        console.error(`[dataClient] 拉取失败（已重试 ${retries} 次）${url}`, error)
      }
    } finally {
      dispose()
    }
  }
  console.warn(`[dataClient] 数据不可用 ${url}${lastStatus ? ` (HTTP ${lastStatus})` : ''}`)
  return fallback
}

/**
 * 预取（不等待结果，供鼠标悬停 / 空闲时预热）。
 * 命中缓存则不发请求。
 */
export function prefetchData(rel: string): void {
  void fetchData<unknown>(rel, null).catch(() => undefined)
}
