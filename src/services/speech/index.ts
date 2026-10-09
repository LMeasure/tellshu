/**
 * 语音服务出口
 * ------------------------------------------------------------------
 * 选择规则：
 *   - 有 speechSynthesis → Web 实现
 *   - 没有（SSR / 老旧内核 / 原生壳未接语音）→ 空实现，能力探测返回 false
 *
 * 注意：Web 实现是**能力探测型**的 —— `driver === 'web'` 只代表运行在浏览器里，
 * 不代表「跟读识别」可用（Firefox 就不支持识别）。判断能不能用请一律调
 * `speechService.isRecognitionSupported()`。
 */

import { webSpeechService } from './web'
import { noopSpeechService } from './noop'
import type { SpeechService } from './types'

export type { ListenOptions, SpeakOptions, SpeechService } from './types'
export { clampRate, resolveRate } from './types'

function pickDriver(): SpeechService {
  const hasSynthesis =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  return hasSynthesis ? webSpeechService : noopSpeechService
}

export const speechService: SpeechService = pickDriver()

/** 别名，便于在业务代码里写成 `speech.speak(...)` 这种短句 */
export const speech = speechService
