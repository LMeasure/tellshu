/**
 * 发音业务门面（平台无关）
 * ------------------------------------------------------------------
 * 两层职责，都不含平台 API：
 *   1. **音频仲裁**：一次性发音要先通过 audioBus 抢占焦点（正在听书就先暂停听书），
 *      念完再交还焦点让听书接着读。规则见 audioBus.ts。
 *   2. **跟读评分**：归一化 + 编辑距离算相似度（纯函数，可单测）。
 *
 * 真正的合成/识别在 `services/speech`（Web Speech API 只在那个文件里出现）。
 * 页面继续 import 本文件即可，不必关心底层换成了什么。
 */

import { audioBus, type AudioHolder } from './audioBus'
import { speechService, type SpeakOptions } from '../services/speech'

/* 平台能力的透明转发：页面用 isSpeechSupported() 判断按钮是否可点 */
export function isSpeechSupported(): boolean {
  return speechService.isSynthesisSupported()
}

export function isRecognitionSupported(): boolean {
  return speechService.isRecognitionSupported()
}

/**
 * 是否在微信内置浏览器里（Android X5 / iOS WKWebView）。
 * 微信 WebView 对 Web Speech 合成支持极不稳定：多数情况 speechSynthesis 存在
 * 但不出声（无可用嗓音 / 被内核拦截），且页面拿不到任何错误回调 ——
 * 只能靠 UA 识别后引导用户「在浏览器中打开」。
 */
export function isWeChatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /micromessenger/i.test(navigator.userAgent)
}

/**
 * 语音能力体检：给 UI 决定「能不能听书 / 要不要提示」。
 *   ok          —— 正常
 *   unsupported —— 完全没有 speechSynthesis
 *   wechat      —— 微信内置浏览器（即使检测通过也常常无声，建议换浏览器）
 */
export function speechStatus(): 'ok' | 'unsupported' | 'wechat' {
  if (isWeChatBrowser()) return 'wechat'
  if (!speechService.isSynthesisSupported()) return 'unsupported'
  return 'ok'
}

/** 朗读（不等待结束）。slow=true 降速便于跟读；rate 显式指定倍速（听书用）。 */
export function speak(text: string, slow = false, rate?: number): boolean {
  return speechService.speak(text, { slow, rate })
}

/** 朗读并等待结束（听书逐句高亮用）。被打断时同样 resolve。lang 可指定英美口音。 */
export function speakAsync(text: string, slow = false, rate?: number, lang?: string): Promise<void> {
  return speechService.speakAsync(text, { slow, rate, lang })
}

/** 带参数对象的版本，便于新代码直接传 lang 等选项 */
export function speakWith(text: string, options?: SpeakOptions): boolean {
  return speechService.speak(text, options)
}

/** 中断当前朗读 */
export function cancelSpeech(): void {
  speechService.cancel()
}

/**
 * 实时识别一次跟读。返回最终识别文本。
 * onPartial 可选，用于实时显示中间结果。
 */
export function listen(opts?: {
  lang?: string
  onPartial?: (text: string) => void
}): Promise<string> {
  return speechService.listen(opts)
}

/**
 * 单词/例句这类「一次性」发音：先通过 audioBus 抢占焦点（正在听书就先暂停听书），
 * 念完再交还焦点让听书接着读。见 audioBus.ts 的规则说明。
 */
const oneShotHolder: AudioHolder = {
  role: 'word',
  suspend() {
    /* 一次性发音本身不保留进度，被抢占时无需处理 */
  },
  resume() {
    /* 同上 */
  },
}

/**
 * 一次性发音（可带口音）：先通过 audioBus 抢占焦点（正在听书就先暂停听书），
 * 念完再交还焦点让听书接着读。见 audioBus.ts 的规则说明。
 * lang 可传 'en-GB' / 'en-US' 指定英美口音（单词详情页的英音/美音切换）。
 */
export async function speakFocused(
  text: string,
  slow = false,
  rate?: number,
  lang?: string,
): Promise<boolean> {
  if (!isSpeechSupported() || !text) return false
  audioBus.claim(oneShotHolder)
  try {
    await speechService.speakAsync(text, { slow, rate, lang })
    return true
  } finally {
    audioBus.release(oneShotHolder)
  }
}

/**
 * 「连续朗读全部例句」的句间停顿（需求定死 0.5s = 500ms）。
 * 导出常量而不是散落魔法数字，便于单测锁定。
 */
export const SEQUENTIAL_GAP_MS = 500

/** SpeechSynthesis 的 rate 合法区间约 0.1–10，这里收敛到可用范围 */
export { clampRate } from '../services/speech'

/* ------------------------------------------------------------------
 * 跟读相似度（纯逻辑，无平台依赖）
 * ------------------------------------------------------------------ */

/** 归一化：小写、去标点、压缩空白 */
export function normalizeSpoken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

/** 跟读相似度（0-100），基于归一化编辑距离。 */
export function pronunciationScore(target: string, spoken: string): number {
  const t = normalizeSpoken(target)
  const s = normalizeSpoken(spoken)
  if (!t || !s) return 0
  const dist = levenshtein(t, s)
  const maxLen = Math.max(t.length, s.length) || 1
  return Math.max(0, Math.round((1 - dist / maxLen) * 100))
}
