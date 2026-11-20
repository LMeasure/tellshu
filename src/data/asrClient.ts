/**
 * 音视频转字幕后端 API 客户端
 * ------------------------------------------------------------------
 * 只做 HTTP：提交转录任务 / 轮询任务。不含业务规则（编排在
 * src/domain/transcript/transcribe.ts），不碰平台 API。
 *
 * 与 dictClient 的关系：requestJson 沿用其超时 / AbortController /
 * 非 JSON 防护 / 错误消息提取范式，但有两处必要差异：
 *   1. 定时器走 globalThis.setTimeout —— dictClient 用 window.setTimeout，
 *      在 Node 单测（tsx scripts/test_transcript.ts）里会直接 ReferenceError；
 *   2. 错误带 HTTP status（ApiRequestError）—— 调用方需要区分
 *      503「未接入」（显示空态引导）与其他失败（显示重试）。
 *
 * 环境变量：VITE_API_BASE_URL（默认 /api；本地联调设为 http://127.0.0.1:8787/api）
 */

import type { AsrJobResponse, AsrSubmitResponse } from '@/domain/transcript/types'

/**
 * 后端基址（与词典 API 同源同口径）。
 * 可选链是必须的：tsx 跑单测时 import.meta.env 为 undefined，
 * 直接取属性会 TypeError（与 dataClient 同一口径，见其文件头注释）。
 */
export const ASR_API_BASE: string = import.meta.env?.VITE_API_BASE_URL ?? '/api'

const DEFAULT_TIMEOUT_MS = 30_000

/** 带 HTTP 状态的请求错误：503 = 服务未接入，其他 = 常规失败。 */
export class ApiRequestError extends Error {
  readonly status: number
  /** 服务端/代理层错误码（如 service_unavailable / backend_unreachable）；无则 undefined */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

function endpoint(path: string): string {
  return `${ASR_API_BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
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
      throw new ApiRequestError(
        response.status,
        body?.message ?? `请求失败（HTTP ${response.status}）`,
        body?.code,
      )
    }
    if (payload === null) {
      // 200 但 body 不是 JSON —— 典型场景：前端服务器没配 /api 代理时，
      // GET /api/* 被 SPA 回退接住返回 index.html。明确报错，
      // 绝不让 null 流进上层把 TypeError 暴露给用户。
      throw new ApiRequestError(response.status, '服务返回异常（响应不是 JSON），请确认后端服务已启动')
    }
    return payload as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiRequestError(0, '请求超时，请稍后重试')
    }
    throw error
  } finally {
    globalThis.clearTimeout(timer)
  }
}

export interface SubmitAsrJobInput {
  file: Blob
  fileName: string
  /** 语言代码或 'auto'；不传按服务端默认 auto */
  language?: string
}

/**
 * 提交转录任务。
 * 大文件上传 + 供应商提交可能耗时较久，超时放到 180s
 * （服务端单次供应商调用默认 120s，见 ASR_TIMEOUT_MS）。
 */
export async function submitAsrJob(input: SubmitAsrJobInput): Promise<AsrSubmitResponse> {
  const form = new FormData()
  form.append('media', input.file, input.fileName)
  if (input.language !== undefined && input.language !== '') {
    form.append('language', input.language)
  }
  return requestJson<AsrSubmitResponse>(endpoint('/asr/jobs'), {
    method: 'POST',
    body: form,
    timeoutMs: 180_000,
  })
}

/** 轮询任务状态；done 时带回 transcript。404 = 不存在，410 = 已过期。 */
export async function fetchAsrJob(jobId: string): Promise<AsrJobResponse> {
  return requestJson<AsrJobResponse>(endpoint(`/asr/jobs/${encodeURIComponent(jobId)}`), {
    timeoutMs: 30_000,
  })
}
