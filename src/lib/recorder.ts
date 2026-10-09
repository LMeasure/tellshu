/**
 * 录音相关展示逻辑（平台无关）
 * ------------------------------------------------------------------
 * 这里只留**纯函数**：时长格式化、自动命名 —— 可在 Node 里直接单测。
 * 真正的录音（MediaRecorder / getUserMedia）在 `services/recording`：
 * 页面改成 `recordingService.createSession()` 后，本文件不再持有麦克风逻辑。
 */

import { recordingService } from '../services/recording'
import type { Recording, RecordingSession } from '../services/recording'

export type { Recording, RecordingSession }

/** 是否会话来获取录音器（等价于 recordingService.createSession()） */
export function createRecorderSession(): RecordingSession {
  return recordingService.createSession()
}

/** 当前环境是否具备录音能力（含 https / localhost 安全上下文检查） */
export function isRecordingSupported(): boolean {
  return recordingService.isSupported()
}

/** 时长格式化 mm:ss（用于音频条与自动命名） */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 背诵音频标题：当前日期-背诵时长（如 2026-10-02-01:23） */
export function recitationTitle(ms: number, at: number = Date.now()): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return `${date}-${fmtDuration(ms)}`
}

/** 字节 → 可读大小（背诵列表展示用） */
export function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
