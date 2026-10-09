/**
 * 听书计划：把一页文字拆成「可读单元」（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 需求【1】英文听书：不挑嗓音、不设 rate / pitch，全部交给浏览器默认。
 *   → 英文单元标 `natural: true`，speech 服务见到它就只设 lang，其余一律不碰。
 *   这么做的原因：挑嗓音在不同系统上结果差异极大（Windows 上常被挑到一个
 *   带口音或非本语言的嗓音），而浏览器默认嗓音是各家内核调过的、最稳的那一个。
 *
 * 需求【2】中文停顿：。！？ 后停 150ms，、，；： 后停 100ms；
 *   感叹号再叠一点 pitch（Web Speech API 无法真正控制语气，只能升调，效果有限）；
 *   「-」这类符号不读，直接跳过。
 *   → 中文单元按标点再切成小段，每段自带 `pauseAfter` 与 `pitch`，
 *     由 ListenSession 在段与段之间 sleep 出真实停顿。
 *
 * 为什么停顿要靠 sleep 而不是让引擎自己处理：
 *   Web Speech API 没有 SSML，引擎对中文标点的处理各家不一致（有的读成"句号"、
 *   有的完全不停）。自己 sleep 才能得到可预期的节奏。
 *
 * 需求【8】相关的双语判断放在 textLang.detectBilingual，本文件只管朗读。
 */

import { splitSentences } from './audioBus'
import { DEFAULT_PAUSE_MS, type ListenUnit } from './listenSession'
import { cleanForSpeech } from './speechText'
import { dominantLang } from './textLang'

/** 中文朗读的标点停顿（毫秒）—— 需求【2】定死的档位 */
export const ZH_PAUSE_LONG_MS = 150
export const ZH_PAUSE_SHORT_MS = 100

/** 标点 → 停顿。没有列出的标点不停顿（直接跟着读下去）。 */
export const ZH_PAUSE_BY_PUNCT: Record<string, number> = {
  '。': ZH_PAUSE_LONG_MS,
  '！': ZH_PAUSE_LONG_MS,
  '？': ZH_PAUSE_LONG_MS,
  '，': ZH_PAUSE_SHORT_MS,
  '、': ZH_PAUSE_SHORT_MS,
  '；': ZH_PAUSE_SHORT_MS,
  '：': ZH_PAUSE_SHORT_MS,
}

/**
 * 感叹句的 pitch 微调。
 * 需求明确写了「效果有限」：Web Speech API 只能改基频，改不了重音和语势，
 * 真正要控制语气得上支持 SSML 的 TTS —— 那时只需替换 speech 服务，本文件不动。
 */
export const EXCLAM_PITCH = 1.15

/** 中文朗读要跳过的符号：念出来是噪音（「杠」「波浪号」「井号」） */
export const UNREADABLE_PUNCT = new Set([
  '-', '‐', '‑', '‒', '–', '—', '―', '－',
  '~', '～', '*', '#', '|', '_', '^', '•', '·',
])

/** 没有句末标点时（段落结尾 / 没打标点的句子）用的兜底停顿 */
export const FALLBACK_PAUSE_MS = DEFAULT_PAUSE_MS

export interface ZhChunk {
  text: string
  /** 读完这段后要停多久（毫秒） */
  pauseAfter: number
  /** 这段的音调；感叹句略高 */
  pitch: number
}

/** 去掉不该被念出来的符号 */
export function stripUnreadablePunct(text: string): string {
  let out = ''
  for (const ch of text) {
    out += UNREADABLE_PUNCT.has(ch) ? '' : ch
  }
  return out
}

/**
 * 中文句子 → 若干带停顿的小段。
 * 「你好，世界。」→ [{你好，,100}, {世界。,150}]
 *
 * 标点**保留在文本里**：中文嗓音把 。，当停顿处理，保留能让问号保留上扬语调；
 * 我们的 sleep 只负责把停顿补到需求规定的时长。
 */
export function splitChineseByPunct(sentence: string): ZhChunk[] {
  const out: ZhChunk[] = []
  let buf = ''
  for (const ch of sentence) {
    buf += ch
    const pause = ZH_PAUSE_BY_PUNCT[ch]
    if (pause === undefined) continue
    const text = buf.trim()
    if (text) {
      out.push({ text, pauseAfter: pause, pitch: ch === '！' ? EXCLAM_PITCH : 1 })
    }
    buf = ''
  }
  const tail = buf.trim()
  if (tail) out.push({ text: tail, pauseAfter: 0, pitch: 1 })
  return out
}

export interface BuildUnitsOptions {
  /**
   * 中文朗读的倍速（英文单元**不使用**它 —— 需求【1】要求英文保持浏览器默认）。
   */
  rate: number
  /** 中英混排是否在语言边界处再切一刀（默认 true） */
  crossLanguage?: boolean
}

/**
 * 生成一页的朗读单元。
 * @param sentences 每段已切好的展示用句子（`段 → 句[]`），用来定位高亮与「双击重读」
 *
 * 单元粒度：
 *   英文句 —— 一句一个单元（不加标点停顿规则，句间沿用 200ms 呼吸）
 *   中文句 —— 再按标点切成小段，段间按需求停 150 / 100ms
 *   混排句 —— 先按语言边界切开，各自按自己的规则处理
 */
export function buildListenUnits(
  sentences: readonly (readonly string[])[],
  options: BuildUnitsOptions,
): ListenUnit[] {
  const rate = options.rate
  const crossLanguage = options.crossLanguage !== false
  const units: ListenUnit[] = []

  sentences.forEach((sents, pi) => {
    sents.forEach((raw, si) => {
      /**
       * 中文主导的句子先剥掉破折号之类再切语言边界。
       * 不这么做的话：破折号（U+2014）既不在汉字区也不在 CJK 标点区，
       * 会被判成「拉丁字符」，于是语言边界切分切出一个只有破折号的假英文片段，
       * 朗读时多出一个空单元（表现为莫名其妙的停顿）。
       */
      const source = dominantLang(raw) === 'zh' ? stripUnreadablePunct(raw) : raw
      const spans = crossLanguage ? splitSentences(source, { crossLanguage: true }) : [source]
      spans.forEach((span) => {
        const lang = dominantLang(span)
        if (lang === 'zh') {
          const chunks = splitChineseByPunct(span)
          chunks.forEach((chunk, ci) => {
            const isLast = ci === chunks.length - 1
            const text = cleanForSpeech(stripUnreadablePunct(chunk.text), 'zh')
            // 清洗后为空（整段都是要跳过的符号）就不要生成单元
            if (!text) return
            units.push({
              text,
              para: pi,
              sent: si,
              sub: ci,
              lang: 'zh',
              // 最后一段若没有标点（段落结尾），用兜底停顿，避免下一句贴上来
              pauseAfter: chunk.pauseAfter > 0 ? chunk.pauseAfter : isLast ? FALLBACK_PAUSE_MS : 0,
              natural: false,
              rate,
              pitch: chunk.pitch,
            })
          })
          return
        }
        const text = cleanForSpeech(span, 'en')
        if (!text) return
        units.push({
          text,
          para: pi,
          sent: si,
          sub: 0,
          lang: 'en',
          pauseAfter: FALLBACK_PAUSE_MS,
          // 需求【1】：英文不挑嗓音、不设 rate / pitch
          natural: true,
        })
      })
    })
  })

  return units
}

/**
 * 找出「某一段某一句」对应的最后一个单元下标 —— 「只读这一句」的终点。
 * 找不到返回 -1（调用方据此放弃设置终点）。
 */
export function lastUnitIndexOfSentence(units: readonly ListenUnit[], para: number, sent: number): number {
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const u = units[i]
    if (u.para === para && u.sent === sent) return i
  }
  return -1
}

/** 某个「段:句」对应的第一个单元下标（双击重读的起点） */
export function firstUnitIndexOfSentence(
  units: readonly ListenUnit[],
  para: number,
  sent: number,
): number {
  return units.findIndex((u) => u.para === para && u.sent === sent)
}
