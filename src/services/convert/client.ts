/**
 * 格式转换·后端客户端（唯一允许 fetch /api/convert/* 的地方）
 * 页面不直接 fetch；统一走本模块。
 * 后端不可达时如实抛错，调用方显示「服务端不可达」，绝不伪造结果。
 */
import type { ConvertFormat } from '@/domain/convert'

const BASE: string = import.meta.env.VITE_API_BASE_URL ?? '/api'

export type ConvertTaskStatus = 'waiting' | 'processing' | 'success' | 'failed'

export interface UploadFileResponse {
  fileId: string
  format: ConvertFormat
  originalName: string
  sizeBytes: number
}

export interface CreateTaskResponse {
  taskId: string
  status: ConvertTaskStatus
}

export interface ConvertTaskStatusResponse {
  taskId: string
  status: ConvertTaskStatus
  progress: number
  sourceFormat: ConvertFormat | null
  targetFormat: ConvertFormat | null
  errorMessage: string | null
  /** 完成后可下载结果的文件 id（用于 /api/convert/files/:id/download） */
  resultFileId: string | null
}

export interface ConvertHealthResponse {
  ok: boolean
  engineEnabled: boolean
}

/** 转换结果 OCR 成文章：按页码顺序拼接的识别文本 */
export interface ConvertOcrResponse {
  taskId: string
  text: string
  pages: number
}

function endpoint(path: string): string {
  return `${BASE.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 30_000
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
      // 503 = 转换服务未接入（后端有意返回），前端应显示「未接入」而非编造
      if (response.status === 503) {
        throw new Error('转换引擎未接入（后端未部署转换 Worker）')
      }
      const body =
        payload !== null && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: { message?: string } }).error
          : undefined
      throw new Error(body?.message ?? `请求失败（HTTP ${response.status}）`)
    }
    if (payload === null) {
      // 200 但非 JSON：典型是前端服务器没配 /api 代理，GET 被 SPA 回退接住返回 index.html
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

/** 上传待转换文件，返回 fileId 与识别出的格式 */
export async function uploadConvertFile(file: File): Promise<UploadFileResponse> {
  const form = new FormData()
  form.append('file', file, file.name)
  return requestJson<UploadFileResponse>(endpoint('/convert/files/upload'), {
    method: 'POST',
    body: form,
    timeoutMs: 60_000,
  })
}

/** 创建转换任务 */
export async function createConvertTask(
  fileId: string,
  targetFormat: ConvertFormat,
): Promise<CreateTaskResponse> {
  return requestJson<CreateTaskResponse>(endpoint('/convert/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, targetFormat }),
    timeoutMs: 30_000,
  })
}

/** 轮询任务状态 */
export async function getConvertTask(taskId: string): Promise<ConvertTaskStatusResponse> {
  return requestJson<ConvertTaskStatusResponse>(
    endpoint(`/convert/tasks/${encodeURIComponent(taskId)}`),
    { timeoutMs: 30_000 },
  )
}

/** 结果下载地址（完成后的 resultFileId） */
export function convertResultDownloadUrl(resultFileId: string): string {
  return endpoint(`/convert/files/${encodeURIComponent(resultFileId)}/download`)
}

/** 后端健康探测（用于 UI 初始态，避免每次都走长超时） */
export async function pingConvertService(): Promise<boolean> {
  try {
    await requestJson<ConvertHealthResponse>(endpoint('/convert/health'), { timeoutMs: 5_000 })
    return true
  } catch {
    return false
  }
}

/** 转换结果打包下载地址（ZIP，含全部结果文件；仅成功任务可用） */
export function convertZipDownloadUrl(taskId: string): string {
  return endpoint(`/convert/tasks/${encodeURIComponent(taskId)}/zip`)
}

/**
 * 转换结果 OCR 成文章文本（仅 PDF→PNG 的图片结果支持）。
 * 后端逐页识别并拼接返回；OCR 未接入时后端返回 503，本函数如实抛出「OCR 服务未接入」。
 * OCR 可能耗时数秒（逐页识别），故放宽超时到 120s。
 */
export async function requestConvertOcr(taskId: string): Promise<ConvertOcrResponse> {
  return requestJson<ConvertOcrResponse>(
    endpoint(`/convert/tasks/${encodeURIComponent(taskId)}/ocr`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
      timeoutMs: 120_000,
    },
  )
}
