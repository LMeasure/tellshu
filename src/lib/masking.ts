/**
 * 默写：隐藏策略 + 逐字实时校验（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 三种隐藏方式（对应产品需求）：
 *   random —— 随机隐藏指定比例的词（15% / 30% / 45% / 65% / 90%）
 *   full   —— 完全隐藏：本页所有词都要默写；可再选是否连标点一起默写
 *   manual —— 自主选择：用户点选要隐藏哪些词（英文单词 / 中文词组）
 *
 * 随机结果必须**可复现**：同一页 + 同一 seed 永远得到同一套空位，
 * 否则每次输入都会让空位跳动，用户没法写。因此用确定性伪随机（seed），
 * 「换一批」通过改 seed 实现。
 *
 * 【中英文兼容】分词按语言分两条路：
 *   英文 —— 空格 / 标点分词（原有行为，一个字符都不变）
 *   中文 —— Intl.Segmenter('zh', {granularity:'word'}) 词级切分，
 *           环境不支持时降级为逐字切分（带6220的 Sogou 之类老内核也能用）
 *   mixed —— 先按语言边界切成片段，各片段按自己的方式分词后顺序拼回
 * 校验统一用字符比对（inlineState），MVP 不做拼音匹配 —— 见需求第三部分。
 */

import { detectLanguage, splitLangSpans, tokenLang, type LangKind } from './textLang'

/* tsconfig 的 lib 只到 ES2020，不含 Intl.Segmenter 的声明，这里补最小可用描述 */
interface SegmenterWordLike {
  segment: string
  isWordLike?: boolean
}

interface IntlSegmenterLike {
  segment(input: string): Iterable<SegmenterWordLike>
}

interface IntlWithSegmenter {
  Intl?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Segmenter?: new (locale: string, options?: { granularity?: string }) => IntlSegmenterLike
  }
}

export interface Token {
  t: string
  word: boolean
}

/**
 * 英文分词：一个 token 要么是词（含撇号/连字符的复合词），
 * 要么是空白/标点串。**这个正则自上线以来从未改动，也不要改** ——
 * 它与 inlineState、buildMaskPlan、测试断言全部耦合。
 */
function tokenizeEnglish(text: string): Token[] {
  const re = /([A-Za-z]+(?:['’\-][A-Za-z]+)*)|(\s+)|([^\sA-Za-z]+)/g
  const out: Token[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ t: m[1], word: true })
    else out.push({ t: m[0], word: false })
  }
  return out
}

/** 空白与各类标点（逐字降级时用来判定「这个字符不算一个词」） */
const ZH_NON_WORD_RE = /^[\s\u3000-\u303f\uff01-\uff60\p{P}\p{S}]+$/u

/** 缓存 Segmenter 实例：构造有开销，别每句 new 一个 */
let zhSegmenter: IntlSegmenterLike | null | undefined

function getZhSegmenter(): IntlSegmenterLike | null {
  if (zhSegmenter !== undefined) return zhSegmenter
  const g = globalThis as unknown as IntlWithSegmenter
  try {
    zhSegmenter = g.Intl?.Segmenter ? new g.Intl.Segmenter('zh', { granularity: 'word' }) : null
  } catch {
    zhSegmenter = null
  }
  return zhSegmenter
}

/**
 * 中文分词。
 * 有 Intl.Segmenter → 词级切分（"我喜欢apple" 会切成 我 / 喜欢 / apple，
 *   其中 latin 片段由 tokenizeMixed 交给英文分词器处理，不会串味）；
 * 没有 → 逐字切分（每个汉字独立成为一个可隐藏的单位，仍然可用，只是碎一点）。
 */
export function tokenizeChinese(text: string): Token[] {
  const seg = getZhSegmenter()
  if (!seg) {
    const out: Token[] = []
    for (const ch of text) {
      out.push({ t: ch, word: !ZH_NON_WORD_RE.test(ch) })
    }
    return out
  }
  const out: Token[] = []
  /** 连续的非词片段（标点、空白）归并成一个 token；词逐个单独成 token */
  let nonWord = ''
  const flushNonWord = () => {
    if (nonWord !== '') {
      out.push({ t: nonWord, word: false })
      nonWord = ''
    }
  }
  try {
    for (const part of seg.segment(text)) {
      if (part.isWordLike === true) {
        // 每个中文词都是**独立**的可隐藏单位：
        // 若像英文那样把连续同类片段合并，整句会变成一个空位，默写无从下手
        flushNonWord()
        out.push({ t: part.segment, word: true })
      } else {
        nonWord += part.segment
      }
    }
  } catch {
    // 极端情况下 Segmenter 抛错：退回逐字，绝不让页面崩
    return tokenizeChineseByChar(text)
  }
  flushNonWord()
  return out
}

/**
 * 逐字降级。Intl.Segmenter 不可用时用它；也单独导出以便在单测里直接验证
 * （运行环境有 Segmenter 时，正常路径不会走到这里）。
 */
export function tokenizeChineseByChar(text: string): Token[] {
  const out: Token[] = []
  let nonWord = ''
  const flush = () => {
    if (nonWord !== '') {
      out.push({ t: nonWord, word: false })
      nonWord = ''
    }
  }
  for (const ch of text) {
    if (ZH_NON_WORD_RE.test(ch)) nonWord += ch
    else {
      flush()
      out.push({ t: ch, word: true })
    }
  }
  flush()
  return out
}

/** 混合文本：按语言边界切段后分别分词 */
function tokenizeMixed(text: string): Token[] {
  const out: Token[] = []
  for (const span of splitLangSpans(text)) {
    out.push(...(span.lang === 'zh' ? tokenizeChinese(span.text) : tokenizeEnglish(span.text)))
  }
  return out
}

/** 自动判断语言后分词 */
function tokenizeAuto(text: string): Token[] {
  const kind = detectLanguage(text)
  if (kind === 'zh') return tokenizeChinese(text)
  if (kind === 'en') return tokenizeEnglish(text)
  return tokenizeMixed(text)
}

/**
 * 切词：保留标点与空白为独立 token，便于按位置渲染。
 * @param lang  'en' 严格走英文逻辑；'zh' 走中文；'mixed' 按边界分段处理；
 *              省略（'auto'）时先判断语言再选 —— 对纯英文文本结果与 'en' 完全一致。
 */
export function tokenize(text: string, lang?: LangKind | 'auto'): Token[] {
  switch (lang) {
    case 'en':
      return tokenizeEnglish(text)
    case 'zh':
      return tokenizeChinese(text)
    case 'mixed':
      return tokenizeMixed(text)
    default:
      return tokenizeAuto(text)
  }
}

export type MaskMode = 'random' | 'full' | 'manual'

/**
 * 双语素材下「隐藏谁」（需求【8】）：
 *   all —— 不区分语言（默认，与普通素材一致）
 *   zh  —— 隐藏中文，保留英文（对着英文默写中文意思）
 *   en  —— 隐藏英文，保留中文（对着中文默写英文单词）
 */
export type MaskTarget = 'all' | 'zh' | 'en'

export interface MaskConfig {
  mode: MaskMode
  /** 随机隐藏比例（random 模式生效） */
  ratio: number
  /** 完全隐藏时是否连标点一起要求默写（full 模式生效） */
  hidePunctuation: boolean
  /** 双语素材下只隐藏某一种语言；默认 all */
  target?: MaskTarget
}

export const RATIO_OPTIONS = [0.15, 0.3, 0.45, 0.65, 0.9] as const
export const DEFAULT_MASK_CONFIG: MaskConfig = {
  mode: 'random',
  ratio: 0.3,
  hidePunctuation: false,
}

/** 空位 key：`段落下标:token下标`，与页内容一一对应 */
export type SlotKey = string

export function slotKey(paraIdx: number, tokenIdx: number): SlotKey {
  return `${paraIdx}:${tokenIdx}`
}

/** 确定性伪随机（mulberry32）——同 seed 同结果，保证空位不跳动 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 计算需要隐藏的 token 集合。
 * @param paragraphs 当前页的段落
 * @param config     隐藏方式
 * @param manualKeys 自主选择模式下用户勾选的 key
 * @param seed       随机种子（random 模式用；「换一批」时改变它）
 */
export function buildMaskPlan(
  paragraphs: string[],
  config: MaskConfig,
  manualKeys: Iterable<SlotKey> = [],
  seed = 1,
  lang?: LangKind | 'auto',
): Set<SlotKey> {
  const hidden = new Set<SlotKey>()
  const rng = makeRng(seed)
  const manual = new Set(manualKeys)
  // 需求【8】：指定语言时只在该语言的词里抽空位，另一种语言原样保留
  const target = config.target ?? 'all'
  const wanted = (t: Token): boolean => (target === 'all' ? true : tokenLang(t.t) === target)

  paragraphs.forEach((p, pi) => {
    const tokens = tokenize(p, lang)
    tokens.forEach((tk, ti) => {
      const key = slotKey(pi, ti)
      if (config.mode === 'manual') {
        if (manual.has(key)) hidden.add(key)
        return
      }
      if (config.mode === 'full') {
        // 完全隐藏：词必隐藏；标点按开关决定
        if (tk.word) hidden.add(key)
        else if (config.hidePunctuation && tk.t.trim() !== '') hidden.add(key)
        return
      }
      // random：只对词随机，标点保持可见（避免标点也空一片、无从下手）
      if (tk.word && wanted(tk) && rng() < config.ratio) hidden.add(key)
    })

    // random 模式下若整段一个空位都没有，强制空一个词，避免这一段完全不用写
    if (config.mode === 'random') {
      const hasBlank = tokens.some((tk, ti) => tk.word && hidden.has(slotKey(pi, ti)))
      if (!hasBlank) {
        const firstWord = tokens.findIndex((tk) => tk.word && wanted(tk))
        if (firstWord >= 0) hidden.add(slotKey(pi, firstWord))
      }
    }
  })

  return hidden
}

/* ------------------------------------------------------------------
 * 逐字实时校验
 * ------------------------------------------------------------------ */

export type InlineState = 'empty' | 'typing' | 'ok' | 'wrong'

/**
 * 判断某个空位当前输入的状态（大小写不敏感）：
 *   empty  —— 未输入
 *   typing —— 输入的内容是答案的前缀，还在正确的路上
 *   ok     —— 完全正确
 *   wrong  —— 已经偏离答案（实时标红）
 * 注意「超过答案长度」也判为 wrong，避免用户多打了还显示正常。
 */
export function inlineState(target: string, value: string): InlineState {
  if (!value) return 'empty'
  const t = target.toLowerCase()
  const v = value.toLowerCase()
  if (v === t) return 'ok'
  return t.startsWith(v) ? 'typing' : 'wrong'
}

export interface DictationStats {
  /** 需要默写的空位总数 */
  total: number
  /** 已填写的空位 */
  filled: number
  /** 完全正确的空位 */
  correct: number
  /** 已判定错误的空位 */
  wrong: number
  /** 正确率（0-100，按已填空位算；未填不扣分） */
  accuracy: number
}

export function dictationStats(
  pairs: { target: string; value: string }[],
): DictationStats {
  let filled = 0
  let correct = 0
  let wrong = 0
  for (const { target, value } of pairs) {
    const st = inlineState(target, value)
    if (st === 'empty') continue
    filled += 1
    if (st === 'ok') correct += 1
    if (st === 'wrong') wrong += 1
  }
  return {
    total: pairs.length,
    filled,
    correct,
    wrong,
    accuracy: filled === 0 ? 0 : Math.round((correct / filled) * 100),
  }
}

/** 生成「空位 → 答案」的对照表，用于统计与比对 */
export function collectSlots(
  paragraphs: string[],
  hidden: Set<SlotKey>,
  lang?: LangKind | 'auto',
): { key: SlotKey; target: string }[] {
  const out: { key: SlotKey; target: string }[] = []
  paragraphs.forEach((p, pi) => {
    tokenize(p, lang).forEach((tk, ti) => {
      const key = slotKey(pi, ti)
      if (hidden.has(key)) out.push({ key, target: tk.t })
    })
  })
  return out
}
