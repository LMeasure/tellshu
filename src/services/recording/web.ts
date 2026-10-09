/**
 * 录音服务 · Web 实现（MediaRecorder）
 * ------------------------------------------------------------------
 * ⚠️ 全项目**唯一**允许直接引用 `MediaRecorder` / `getUserMedia` 的文件。
 *
 * 编码格式按浏览器能力择优，而不是写死一个：
 *   Chrome/Edge/Firefox → audio/webm;codecs=opus（体积最小）
 *   Safari(iOS/macOS)   → audio/mp4（Safari 不支持 webm，写死会导致录不出文件）
 */

import type { Recording, RecordingService, RecordingSession } from './types'

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const supported = (MediaRecorder as unknown as { isTypeSupported?: (m: string) => boolean })
    .isTypeSupported
  if (typeof supported !== 'function') return undefined
  for (const m of MIME_CANDIDATES) {
    try {
      if (supported.call(MediaRecorder, m)) return m
    } catch {
      /* 个别实现会对某些 mime 抛错，跳过 */
    }
  }
  return undefined
}

/** 是否处于安全上下文 —— getUserMedia 在 http 非 localhost 下直接不可用 */
function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext === true
}

class WebRecordingSession implements RecordingSession {
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null
  private startedAt = 0
  private mime = ''
  private cancelled = false

  get isRecording(): boolean {
    return this.rec?.state === 'recording'
  }

  async start(): Promise<void> {
    if (!isRecordingSupported()) {
      throw new Error(
        isSecureContext()
          ? '当前浏览器不支持录音'
          : '录音需要安全上下文（https 或 localhost），当前页面不满足',
      )
    }
    if (this.rec) throw new Error('录音已在进行中')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.stream = stream
    this.chunks = []
    this.cancelled = false
    const mime = pickMime()
    this.mime = mime ?? ''
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    this.rec = rec
    this.startedAt = Date.now()
    rec.start()
  }

  stop(): Promise<Recording> {
    return new Promise<Recording>((resolve, reject) => {
      const rec = this.rec
      if (!rec) {
        reject(new Error('尚未开始录音'))
        return
      }
      rec.onstop = () => {
        if (this.cancelled) {
          this.cleanup()
          reject(new Error('cancelled'))
          return
        }
        const durationMs = Date.now() - this.startedAt
        const type = this.mime || rec.mimeType || 'audio/webm'
        const blob = new Blob(this.chunks, { type })
        this.cleanup()
        resolve({ blob, durationMs, mediaType: type })
      }
      rec.onerror = () => {
        this.cleanup()
        reject(new Error('录音失败'))
      }
      try {
        rec.stop()
      } catch (err) {
        this.cleanup()
        reject(err instanceof Error ? err : new Error('录音停止失败'))
      }
    })
  }

  cancel(): void {
    this.cancelled = true
    try {
      this.rec?.stop()
    } catch {
      /* 已经停了 */
    }
    this.cleanup()
  }

  dispose(): void {
    this.cancel()
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.rec = null
    this.chunks = []
  }
}

function isRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    isSecureContext()
  )
}

export const webRecordingService: RecordingService = {
  driver: 'web',
  isSupported: isRecordingSupported,
  createSession(): RecordingSession {
    return new WebRecordingSession()
  },
}
