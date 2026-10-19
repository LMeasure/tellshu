/**
 * 转写编排：提交 -> 轮询 -> Transcript
 * ------------------------------------------------------------------
 * 服务端是异步任务（与 PaddleOCR 同构），必须轮询。
 * 锁定参数（方案 §3.4）：3s × 100 次 = 5 分钟；超时任务在服务端 TTL 2h
 * 内仍在，但前端无 jobId 恢复机制，超时即丢，文案如实告知。
 *
 * 错误映射：
 *   · 503「未接入」—— 原样透出，UI 显示空态引导而不是重试；
 *   · failed        —— 抛服务端给的 error.message；
 *   · 轮询超时      —— 明确告知「结果不保留」。
 *
 * Phase 2 M1 起：`transcribeAndSave` 在成功后把字幕落前端 Dexie
 * （用户拍板：transcript 是用户资产起点，永久留存）。落库失败不阻断
 * 结果展示——持久化是增强，不是转写成功的前提。
 */

import { ApiRequestError, fetchAsrJob, submitAsrJob } from '@/data/asrClient'
import { saveTranscriptRecord } from './store'
import type { AsrJobResponse, AsrJobStatus, Transcript } from './types'

export const ASR_POLL_INTERVAL_MS = 3_000
export const ASR_POLL_MAX_TIMES = 100

export interface TranscribeHooks {
  /** 阶段回调：status='submit' 表示提交中，其余为轮询到的任务状态 */
  onStage?: (stage: string, status: 'submit' | AsrJobStatus) => void
}

export interface TranscribeOptions {
  intervalMs?: number
  maxTimes?: number
}

const STAGE_TEXT: Record<AsrJobStatus, string> = {
  queued: '排队中…',
  running: '转写中…',
  done: '转写完成',
  failed: '转写失败',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

/** 服务端 jobId + 归一化结果 -> 领域 Transcript。 */
function toTranscript(jobId: string, transcript: NonNullable<AsrJobResponse['transcript']>): Transcript {
  return {
    id: jobId,
    language: transcript.language,
    duration: transcript.duration,
    segments: transcript.segments,
  }
}

export async function transcribeMedia(
  input: { file: Blob; fileName: string; language?: string },
  hooks: TranscribeHooks = {},
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const intervalMs = options.intervalMs ?? ASR_POLL_INTERVAL_MS
  const maxTimes = options.maxTimes ?? ASR_POLL_MAX_TIMES

  hooks.onStage?.('提交中…', 'submit')
  const submitted = await submitAsrJob({
    file: input.file,
    fileName: input.fileName,
    language: input.language,
  })
  if (submitted.status === 'failed') {
    throw new ApiRequestError(0, submitted.error?.message ?? '提交失败，请稍后重试')
  }

  for (let attempt = 0; attempt < maxTimes; attempt += 1) {
    const job = await fetchAsrJob(submitted.jobId)
    hooks.onStage?.(STAGE_TEXT[job.status], job.status)
    if (job.status === 'done') {
      if (job.transcript === null) {
        throw new ApiRequestError(0, '任务完成但服务端未返回转录结果')
      }
      return toTranscript(submitted.jobId, job.transcript)
    }
    if (job.status === 'failed') {
      throw new ApiRequestError(0, job.error?.message ?? '转写失败，请稍后重试')
    }
    await sleep(intervalMs)
  }
  throw new ApiRequestError(0, '任务仍在服务端处理，请稍后重新提交（结果不保留）')
}

/**
 * 转写并在成功后落库（Phase 2 M1 起的默认入口）。
 * 落库失败只记告警：会话内结果已到手，展示 / 导出不依赖持久化成功。
 */
export async function transcribeAndSave(
  input: { file: Blob; fileName: string; language?: string },
  hooks: TranscribeHooks = {},
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const result = await transcribeMedia(input, hooks, options)
  try {
    await saveTranscriptRecord(result)
  } catch (e) {
    console.warn('[transcript] 字幕落库失败（结果仍可查看 / 导出）：', e)
  }
  return result
}
