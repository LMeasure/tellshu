/**
 * AI 学习稿生成后端 API 客户端（Phase 2 M2）
 * ------------------------------------------------------------------
 * 只做 HTTP：POST /api/ai/study-notes 带字幕 JSON，返回 SSE 流
 * （delta 逐字 / done 完成 / error 失败）。不含业务规则（编排与契约
 * 校验在 src/domain/studyNote/generate.ts），不碰平台 API。
 *
 * 为什么不能 EventSource：EventSource 只能发 GET，本接口是 POST
 * （字幕全文在 body 里），必须 fetch + ReadableStream 手工解析 SSE。
 *
 * 与 asrClient 的关系：同为 VITE_API_BASE_URL 基址（默认 /api）；
 * 错误复用 ApiRequestError（503 = AI 未接入，UI 走空态引导）。
 * SSE error 事件的 code（服务端 LlmError.kind）透传给上层：
 *   unconfigured/timeout_first_token/timeout_stream/upstream/unavailable。
 *
 * 环境变量：VITE_API_BASE_URL（默认 /api；本地联调 http://127.0.0.1:8787/api）
 */

import type { Transcript } from '@/domain/transcript/types'
import { ApiRequestError } from './asrClient'

/** 与 asrClient 同源同口径（独立定义，避免学习稿链路依赖 ASR 命名）。 */
const API_BASE: string = import.meta.env?.VITE_API_BASE_URL ?? '/api'

/** SSE error 事件携带的服务端错误码（LlmError.kind 透传）。 */
export class StudyNoteRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'StudyNoteRequestError'
  }
}

export interface StudyNoteStreamHandlers {
  /** 每个增量 token；参数为已累加的全文（供进度展示） */
  onDelta?: (fullText: string) => void
  signal?: AbortSignal
}

/**
 * 流式生成学习稿：resolve 时返回 done 事件的 note（unknown，
 * 契约校验由 domain 层负责）；error 事件 / 网络失败 → reject。
 * 无整体超时：流式时长由服务端双超时兜底（首 token 30s / 总流式 120s，
 * 超时以 SSE error 事件回来，见 routes/ai.ts）。
 */
export async function generateStudyNoteStream(
  transcript: Transcript,
  handlers: StudyNoteStreamHandlers = {},
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${API_BASE.replace(/\/+$/, '')}/ai/study-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
      signal: handlers.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiRequestError(0, '已取消生成')
    }
    throw new ApiRequestError(0, `请求失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    // 503 未接入 / 400 坏请求：读 JSON 错误体（与 asrClient 口径一致）
    const text = await response.text().catch(() => '')
    let message = `请求失败（HTTP ${response.status}）`
    if (text !== '') {
      try {
        const payload = JSON.parse(text) as { error?: { message?: string } }
        if (payload.error?.message !== undefined) message = payload.error.message
      } catch {
        /* 非 JSON 错误体：用默认文案，不把原始响应透给用户 */
      }
    }
    throw new ApiRequestError(response.status, message)
  }
  if (response.body === null) {
    throw new ApiRequestError(response.status, '服务返回了空响应体')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 事件以空行分隔；最后一块可能不完整，留在 buffer 里
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
      if (data === '') continue
      let event: { type?: string; text?: string; note?: unknown; code?: string; message?: string }
      try {
        event = JSON.parse(data) as typeof event
      } catch {
        continue // 心跳 / 坏行：忽略，不断流
      }
      if (event.type === 'delta' && typeof event.text === 'string') {
        fullText += event.text
        handlers.onDelta?.(fullText)
      } else if (event.type === 'done') {
        return event.note
      } else if (event.type === 'error') {
        throw new StudyNoteRequestError(event.code ?? 'unknown', event.message ?? '生成失败')
      }
    }
  }
  // 流正常关闭但没有 done 事件：服务端异常结束，不当成成功
  throw new StudyNoteRequestError('incomplete_stream', '生成中断：服务端未返回完成事件')
}
