/**
 * 语音服务 · 空实现
 * ------------------------------------------------------------------
 * 用于：
 *   1. SSR / 无 speechSynthesis 的环境（能力探测一律返回 false，界面自动隐藏相关按钮）
 *   2. 原生壳接入前的占位：先在 native 实现里挂它，保证「接口齐全、功能未接」时也能构建
 *   3. 单测：让依赖语音的业务逻辑可以在 Node 里跑通
 *
 * 注意 speakAsync 必须 resolve 而不是 reject：listenSession 的推进依赖它 resolve。
 */

import type { ListenOptions, SpeakOptions, SpeechService } from './types'
import { resolveRate } from './types'

/** 记录「朗读」，单测可用它断言调用次序与参数（含 natural 是否透传） */
export interface NoopSpeechLog {
  spoken: { text: string; rate: number; natural: boolean }[]
  cancelled: number
}

export const noopSpeechLog: NoopSpeechLog = { spoken: [], cancelled: 0 }

/** 每次 import 重置日志（单测隔离用） */
export function resetNoopSpeechLog(): void {
  noopSpeechLog.spoken.length = 0
  noopSpeechLog.cancelled = 0
}

export const noopSpeechService: SpeechService = {
  driver: 'none',

  isSynthesisSupported(): boolean {
    return false
  },

  isRecognitionSupported(): boolean {
    return false
  },

  speak(): boolean {
    return false
  },

  async speakAsync(text: string, options?: SpeakOptions): Promise<void> {
    noopSpeechLog.spoken.push({
      text,
      rate: resolveRate(options),
      natural: options?.natural === true,
    })
  },

  cancel(): void {
    noopSpeechLog.cancelled += 1
  },

  async listen(_options?: ListenOptions): Promise<string> {
    throw new Error('unsupported')
  },
}
