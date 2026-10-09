/**
 * 音频仲裁（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 需求：听书正在朗读时，用户去查单词（点读）或播放别的音频，
 *       要**自动让位**——暂停原来的、播放当前的，当前的播完再接着原来的。
 *
 * 规则（同一时刻只允许一个音源出声）：
 *   1. 新的音源 claim 时，把当前音源 suspend 并压入挂起栈；
 *   2. 新音源播完 release 时，弹出栈顶（最近被挂起的那个）resume 恢复；
 *   3. 音源自己停止（用户点「停止」）也要 release，否则听书永远不会恢复。
 *
 * 这里只管**谁能让谁暂停**的策略，不碰任何浏览器 API —— 挂起/恢复动作由
 * 持有者自己实现（TTS 会话见 listenSession.ts，<audio> 见 useMediaAudio.ts）。
 */

export type AudioRole = 'book' | 'word' | 'media'

export interface AudioHolder {
  role: AudioRole
  /** 被抢占：暂停自己（TTS 停合成 / <audio> pause） */
  suspend(): void
  /** 重获焦点：继续（TTS 从当前句重读 / <audio> play） */
  resume(): void
}

export class AudioArbiter {
  private current: AudioHolder | null = null
  private suspended: AudioHolder[] = []

  /** 当前正在出声的角色 */
  get currentRole(): AudioRole | null {
    return this.current?.role ?? null
  }

  /** 已被挂起、等待恢复的角色（栈顶=最近挂起的） */
  get suspendedRoles(): AudioRole[] {
    return this.suspended.map((h) => h.role)
  }

  /** 请求发声：当前有别人在播就把它挂起 */
  claim(h: AudioHolder): void {
    if (this.current === h) return
    // 若它正躺在挂起栈里（还没播完），先取出来，避免重复
    const i = this.suspended.indexOf(h)
    if (i >= 0) this.suspended.splice(i, 1)
    if (this.current) {
      this.current.suspend()
      this.suspended.push(this.current)
    }
    this.current = h
  }

  /** 播完或主动停止：交出焦点，并恢复最近被挂起的那个 */
  release(h: AudioHolder): AudioRole | null {
    const i = this.suspended.indexOf(h)
    if (i >= 0) this.suspended.splice(i, 1)
    if (this.current === h) this.current = null
    const next = this.suspended.pop() ?? null
    if (next) {
      this.current = next
      next.resume()
    }
    return next?.role ?? null
  }

  /** 该持有者此刻是否持有焦点 */
  isActive(h: AudioHolder): boolean {
    return this.current === h
  }

  /** 全部清空（切页 / 卸载时兜底，避免残留挂起导致永远静音） */
  reset(): void {
    this.current = null
    this.suspended = []
  }
}

import { splitLangSpans } from './textLang'

/**
 * 全局单例：整个 App 共用一套仲裁状态 */
export const audioBus = new AudioArbiter()

/**
 * 常见缩写：这些点后面不是句子结尾（Mr. / Dr. / e.g. 等）。
 * 不多收录 —— 漏了顶多让听书恢复时多读半句，误判才会把句子切碎。
 */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'inc', 'ltd', 'co',
  'eg', 'ie', 'etc', 'al', 'no', 'fig', 'approx', 'dept', 'est', 'vol', 'pp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

const CJK_TERMINATOR = /[。！？；]/
const ASCII_TERMINATOR = /[.!?;]/

/**
 * 把段落切成句子 —— 听书被抢占后要**从当前句重读**，粒度越细恢复越自然。
 * 规则：
 *   · 中文句末标点（。！？；）后面通常没有空格，见到就切；
 *   · 英文 . ! ? ; 后面必须是空白或结尾才切，且 `.` 前面的词不能是缩写/单字母缩写；
 *   · 传 `{ crossLanguage: true }` 时，中英混排的句子还会在**语言边界**处再切一刀
 *     （见函数下方说明）。默认关闭：开关默认值的语义必须保守，
 *     否则老断点 (`splitSentences('等一下。好的！')`) 的行为会悄悄改变。
 */
export function splitSentences(
  text: string,
  options: { crossLanguage?: boolean } = {},
): string[] {
  const sentences = splitByPunctuation(text)
  if (!options.crossLanguage) return sentences
  // 中英混排：在语言边界上再切一刀
  const out: string[] = []
  for (const s of sentences) {
    out.push(...splitCrossLanguage(s))
  }
  return out
}

/**
 * 语言边界切分。
 * "今天学了 apple 这个单词" → ["今天学了", "apple", "这个单词"]
 *
 * 为什么必须切：中英混排的一句只能交给**一种**嗓音念，
 * 硬塞给英文嗓音会把中文念成怪声，塞给中文嗓音又会把英文单词念成拼音腔。
 * 切开之后每片用自己的嗓音读，听感正常。
 */
function splitCrossLanguage(sentence: string): string[] {
  const spans = splitLangSpans(sentence)
  if (spans.length <= 1) return [sentence]
  const out: string[] = []
  for (const span of spans) {
    const t = span.text.trim()
    if (t) out.push(t)
  }
  return out.length > 0 ? out : [sentence]
}

function splitByPunctuation(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    const isCjk = CJK_TERMINATOR.test(ch)
    const isAscii = !isCjk && ASCII_TERMINATOR.test(ch)
    if (!isCjk && !isAscii) continue

    if (isCjk) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    const next = text[i + 1]
    if (next !== undefined && !/\s/.test(next)) continue
    if (ch === '.') {
      // "Mr." / "e.g." / "J." —— 缩写点不切
      const prev = buf.slice(0, -1).match(/[A-Za-z]+$/)?.[0].toLowerCase() ?? ''
      if (prev.length <= 1 || ABBREV.has(prev)) continue
    }
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
