/**
 * 录音服务 · 空实现
 * ------------------------------------------------------------------
 * SSR / 不支持录音的环境 / 原生壳接入前的占位。
 * `isSupported()` 返回 false，界面据此隐藏或禁用录音按钮，
 * 而不是让用户点下去才报错。
 */

import type { Recording, RecordingService, RecordingSession } from './types'

class NoopRecordingSession implements RecordingSession {
  readonly isRecording = false

  async start(): Promise<void> {
    throw new Error('当前环境不支持录音')
  }

  async stop(): Promise<Recording> {
    throw new Error('尚未开始录音')
  }

  cancel(): void {
    /* 无操作 */
  }

  dispose(): void {
    /* 无操作 */
  }
}

export const noopRecordingService: RecordingService = {
  driver: 'none',
  isSupported(): boolean {
    return false
  },
  createSession(): RecordingSession {
    return new NoopRecordingSession()
  },
}
