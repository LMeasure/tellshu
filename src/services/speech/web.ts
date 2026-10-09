/**
 * 语音服务 · Web 实现（Web Speech API）
 * ------------------------------------------------------------------
 * ⚠️ 全项目**唯一**允许直接引用 `window.speechSynthesis` /
 * `SpeechRecognition` / `webkitSpeechRecognition` 的文件。
 *
 * 已知平台坑（都在这里兜住，上层不用管）：
 *   1. `getVoices()` 首次常返回空数组 —— 语音列表是异步加载的，
 *      必须监听 `onvoiceschanged`；否则第一次点击发音可能用默认嗓音（甚至中文腔）。
 *   2. `speechSynthesis` 内部有队列，连续 speak 会排队朗读；
 *      所以每次 speak 前先 cancel()，保证「点哪个念哪个」。
 *   3. Chrome 有个长文本 >15s 后 onend 不触发的老问题；
 *      听书按句子推进（每句都短）天然规避。
 *   4. `onend` 在被打断（cancel）时也可能触发，因此 speakAsync 一律 resolve，
 *      由调用方用「代号」判断是自然读完还是被打断。
 *   5. 嗓音按语言显式挑选且中英分开（见 buildUtterance），禁止依赖系统默认嗓 ——
 *      默认嗓的语言和内容是随机的，中文文章被英文嗓念 = 完全听不懂。
 *      **唯一例外**：`options.natural = true`（英文听书，需求【1】）时不挑嗓音、
 *      不设 rate/pitch，刻意退回浏览器默认 —— 挑嗓音在 Windows 等系统上常常挑歪。
 */

import { resolvePitch, resolveRate, type ListenOptions, type SpeakOptions, type SpeechService } from './types'
import { pickVoice, pickVoiceByTag, type VoicePref } from '../../lib/voicePicker'
import { dominantLang, langTag } from '../../lib/textLang'

/* 识别 API 在 TS 标准库里没有类型，这里给出最小可用声明 */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

type RecognitionCtor = new () => SpeechRecognitionLike

function win(): (Window & typeof globalThis) | null {
  return typeof window === 'undefined' ? null : window
}

function getRecognitionCtor(): RecognitionCtor | null {
  const w = win() as (Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }) | null
  if (!w) return null
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as RecognitionCtor | null
}

let cachedVoices: SpeechSynthesisVoice[] = []
let voicesHooked = false

/** 语音列表异步加载：首次调用为空时必须挂一次监听，否则语音永远选不到 */
function refreshVoices(): SpeechSynthesisVoice[] {
  const w = win()
  if (!w || !('speechSynthesis' in w)) return []
  if (cachedVoices.length === 0) cachedVoices = w.speechSynthesis.getVoices()
  return cachedVoices
}

function hookVoicesChanged(): void {
  const w = win()
  if (voicesHooked || !w || !('speechSynthesis' in w)) return
  voicesHooked = true
  try {
    w.speechSynthesis.onvoiceschanged = () => {
      cachedVoices = w.speechSynthesis.getVoices()
    }
  } catch {
    /* 个别内核不支持该事件，忽略 */
  }
}

/**
 * 按目标语言挑嗓音。
 *
 * 中英文**必须分开挑**：共用一个嗓音的话，
 * 中文会被英文嗓音念成怪腔、英文会被中文嗓音念成拼音腔，两边都听不懂。
 *
 * `localService` 的取舍交给 voicePicker：联网时优先云端嗓音（自然），
 * 断网时优先本地嗓音（否则云端嗓音一句也念不出来 —— 本产品离线优先）。
 */
function pickVoiceFor(pref: VoicePref): SpeechSynthesisVoice | undefined {
  const online = win()?.navigator?.onLine !== false
  return pickVoice(refreshVoices(), pref, online) as SpeechSynthesisVoice | undefined
}

/** 文本 → 目标语言：混排时按字符数占优的一方决定 */
function prefOfText(text: string): VoicePref {
  return dominantLang(text)
}

function buildUtterance(text: string, options?: SpeakOptions): SpeechSynthesisUtterance | null {
  const w = win()
  if (!w) return null
  const u = new SpeechSynthesisUtterance(text)
  const pref: VoicePref =
    options?.lang && /^zh/i.test(options.lang)
      ? 'zh'
      : options?.lang && /^en/i.test(options.lang)
        ? 'en'
        : prefOfText(text)

  // 需求【1】英文听书：不挑嗓音、不设 rate / pitch，只给语言标签，
  // 剩下的全部交给浏览器默认。别在这里"顺手"优化 —— 挑嗓音正是要避开的坑。
  if (options?.natural) {
    u.lang = options.lang ?? langTag(pref)
    return u
  }

  /**
   * 英美口音（单词详情页需求）：lang 给到 en-GB / en-US 时，
   * 先挑**正好这个口音**的嗓音；系统里没有再退回通用英文挑选策略，
   * 同时把 u.lang 钉在口音标签上，让引擎兜底。宁可口音近似，不哑。
   */
  const accentTag =
    options?.lang && /^en-(gb|us)$/i.test(options.lang) ? options.lang.toLowerCase() : null

  const v =
    (accentTag
      ? (pickVoiceByTag(
          refreshVoices(),
          accentTag,
          win()?.navigator?.onLine !== false,
        ) as SpeechSynthesisVoice | undefined)
      : undefined) ?? pickVoiceFor(pref)
  if (v) {
    // 显式指定嗓音（需求：不要用默认 voice）
    u.voice = v
    // 嗓音正好是目标口音就用嗓音自己的标签；否则钉在口音标签上让引擎兜底
    u.lang = accentTag
      ? normLangOf(v.lang).startsWith(accentTag)
        ? v.lang
        : accentTag
      : v.lang
  } else {
    // 一个匹配嗓音都没有：至少把 lang 钉死在该语言上，
    // 让引擎按语言挑嗓音，也好过退回系统默认（可能完全不对语言）
    u.lang = options?.lang ?? langTag(pref)
  }
  u.rate = resolveRate(options)
  u.pitch = resolvePitch(options)
  return u
}

/** 本文件内部使用：语言标签归一（与 voicePicker 同规则） */
function normLangOf(lang: string): string {
  return lang.replace(/_/g, '-').toLowerCase()
}

export const webSpeechService: SpeechService = {
  driver: 'web',

  isSynthesisSupported(): boolean {
    const w = win()
    const ok = !!w && 'speechSynthesis' in w && typeof w.SpeechSynthesisUtterance === 'function'
    if (ok) hookVoicesChanged()
    return ok
  },

  isRecognitionSupported(): boolean {
    return getRecognitionCtor() !== null
  },

  speak(text: string, options?: SpeakOptions): boolean {
    if (!text || !this.isSynthesisSupported()) return false
    const w = win()!
    try {
      // 清队列：保证「点哪个念哪个」，而不是排队等上一条念完
      w.speechSynthesis.cancel()
      // 个别内核（部分 WebView / Safari）会把合成器停在 paused 态 → resume 一下再念
      try {
        w.speechSynthesis.resume()
      } catch {
        /* 忽略 */
      }
      const u = buildUtterance(text, options)
      if (!u) return false
      w.speechSynthesis.speak(u)
      return true
    } catch {
      return false
    }
  },

  speakAsync(text: string, options?: SpeakOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!text || !this.isSynthesisSupported()) {
        resolve()
        return
      }
      const w = win()!
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        w.speechSynthesis.cancel()
        try {
          w.speechSynthesis.resume()
        } catch {
          /* 忽略：个别内核需要 resume 才出声 */
        }
        const u = buildUtterance(text, options)
        if (!u) {
          done()
          return
        }
        u.onend = done
        u.onerror = done
        w.speechSynthesis.speak(u)
        // 兜底：个别内核既不触发 onend 也不触发 onerror（如标签页被挂起），
        // 用「文本长度 × 最慢语速」估一个上限，超时就放行，避免听书卡死。
        const budget = Math.max(4000, text.length * 220)
        setTimeout(done, budget)
      } catch {
        done()
      }
    })
  },

  cancel(): void {
    const w = win()
    if (!w || !('speechSynthesis' in w)) return
    try {
      w.speechSynthesis.cancel()
    } catch {
      /* 忽略：cancel 在未初始化时可能抛错 */
    }
  },

  listen(options?: ListenOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const Ctor = getRecognitionCtor()
      if (!Ctor) {
        reject(new Error('unsupported'))
        return
      }
      let rec: SpeechRecognitionLike
      try {
        rec = new Ctor()
      } catch (err) {
        reject(err instanceof Error ? err : new Error('recognition-init-failed'))
        return
      }
      rec.lang = options?.lang ?? 'en-US'
      rec.interimResults = true
      rec.continuous = false
      rec.maxAlternatives = 1

      let finalText = ''
      let settled = false

      rec.onresult = (e) => {
        let text = ''
        for (let i = 0; i < e.results.length; i += 1) {
          text += e.results[i][0].transcript
        }
        finalText = text
        options?.onPartial?.(text)
      }
      rec.onerror = (e) => {
        if (settled) return
        settled = true
        reject(new Error(e?.error ?? 'recognition-error'))
      }
      rec.onend = () => {
        if (settled) return
        settled = true
        resolve(finalText.trim())
      }
      try {
        rec.start()
      } catch (err) {
        if (settled) return
        settled = true
        reject(err instanceof Error ? err : new Error('recognition-start-failed'))
      }
    })
  },
}
