/**
 * 朗读文本清洗（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 界面上看着正常的一段文字，直接喂给 TTS 常常念出来一塌糊涂：
 *   · `{词根}`、`{注释}` 这类花括号元信息会被逐字念出来（"花括号 词根 花括号"）；
 *   · `e.g.` / `i.e.` / `etc.` 有些引擎会念成字母串；
 *   · 中文标点混在英文里，英文嗓音往往直接跳过或念出奇怪的停顿；
 *   · 词根拆解用的 `un- + pre- + dict + -able`，加号和连字符会被念成 "加号""减号"。
 *
 * 这里按需求做四项清洗。**只用于送进 TTS 的文本**，绝不改动原文：
 *   1. 去掉花括号 {...} 及花括号本身
 *   2. 展开缩写：e.g. → for example，i.e. → that is，etc. → and so on
 *   3. 中文标点转英文标点（**仅非中文句**，中文句子保留原标点）
 *   4. 词根拆解符号 → `un, pre, dict, able`
 */

import { dominantLang, type LangKind } from './textLang'

/** 中文标点 → 英文标点对照表。逐字符替换，键必须是单字符。 */
const ZH_PUNCT_TO_EN: Record<string, string> = {
  '，': ', ',
  '、': ', ',
  '。': '. ',
  '；': '; ',
  '：': ': ',
  '？': '? ',
  '！': '! ',
  '（': ' (',
  '）': ') ',
  '【': ' [',
  '】': '] ',
  '《': ' "',
  '》': '" ',
  '「': ' "',
  '」': '" ',
  '『': ' "',
  '』': '" ',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '—': ' — ',
  '…': '...',
  '～': ' ',
}

/**
 * 缩写展开表。
 * 注意替换结果**不带句末的句号**：原文 ` apples, etc.` 里的那个点要保留下来，
 * 否则展开后句子会失去句读（`apples, and so on`）。
 */
const ABBREV_EXPANSIONS: { re: RegExp; to: string }[] = [
  { re: /\be\.g\./gi, to: 'for example' },
  { re: /\bi\.e\./gi, to: 'that is' },
  // etc. 常见于一串列举的末尾，它的点往往同时就是**句号**，
  // 因此这里补一个点回去，句子不会被读成没有停顿的一长串
  { re: /\betc\./gi, to: 'and so on.' },
  // 常见称谓：引擎偶尔会把 Mr. 念成 "M r"，这里给出全称
  { re: /\bMr\./g, to: 'Mister' },
  { re: /\bMrs\./g, to: 'Missus' },
  { re: /\bDr\./g, to: 'Doctor' },
  { re: /\bvs\./gi, to: 'versus' },
]

/** 1. 去掉 {...} 及其内容；残留的单个花括号也一并删掉，避免被念出来 */
export function stripBraces(text: string): string {
  let out = text
  // 闭合的花括号连同内容一起删；最多迭代 3 轮以应付嵌套（真文本里极少见）
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/\{[^{}]*\}/g, '')
    if (next === out) break
    out = next
  }
  // 没有闭合的花括号也算元信息，直接删掉符号本身，保留其内容
  return out.replace(/[{}]/g, '')
}

/** 2. 展开常见缩写 */
export function expandAbbreviations(text: string): string {
  let out = text
  for (const { re, to } of ABBREV_EXPANSIONS) out = out.replace(re, to)
  return out
}

/** 3. 中文标点 → 英文标点 */
export function zhPunctToEn(text: string): string {
  let out = ''
  for (const ch of text) {
    const mapped = ZH_PUNCT_TO_EN[ch]
    out += mapped === undefined ? ch : mapped
  }
  return out
}

/**
 * 4. 词根拆解符号 → 逗号分隔清单
 * 例：`un- + pre- + dict + -able` → `un, pre, dict, able`
 *
 * 只在文本里**存在加号**时才启用这条规则：加号就是词根记号的指纹。
 * 普通英文里的连字符单词（well-known、mother-in-law）不含加号，
 * 因此不会被拆开 —— 这是刻意的设计，否则正常课文会被念得支离破碎。
 */
export function flattenRootSymbols(text: string): string {
  if (!text.includes('+')) return text
  const parts = text
    .replace(/\+/g, ' ')
    .split(/\s+/)
    .map((p) => p.replace(/^-+/, '').replace(/-+$/, ''))
    .filter((p) => p.length > 0)
  if (parts.length === 0) return text
  return parts.join(', ')
}

/**
 * 完整清洗。
 * @param lang 该句的语言：中文句只做花括号/缩写处理，**不转标点**
 *             （中文嗓音念中文标点是正常的）；英文与混排句全部处理。
 */
export function cleanForSpeech(text: string, lang: LangKind | 'zh' | 'en' = 'en'): string {
  let out = stripBraces(text)
  out = expandAbbreviations(out)
  out = flattenRootSymbols(out)
  if (lang !== 'zh') out = zhPunctToEn(out)
  // 压缩多余空白（替换可能产生连续空格），再把句内换行压成空格
  out = out.replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
  return out
}

/** 按文本自动判断语言后清洗（调用方懒得判断时用这个） */
export function cleanForSpeechAuto(text: string): string {
  return cleanForSpeech(text, dominantLang(text))
}
