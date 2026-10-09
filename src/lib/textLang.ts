/**
 * 文本语言判断（纯逻辑，可在 Node 下单测）
 * ------------------------------------------------------------------
 * 为什么必须判断：粘贴进来的素材可能是纯英文（背单词的主力场景）、
 * 纯中文（读中文材料顺便记英文注释），也可能是中英混排（教材、双语读物）。
 * 三者要用**不同的分词/朗读策略**：
 *   · 分词 —— 英文按空格、中文没有空格要用词级切分；
 *   · 朗读 —— 英文句子要用英文嗓音、中文句子要用中文嗓音，
 *             否则会出现「中文用英文嗓音念」这种完全听不懂的结果。
 *
 * 判断依据按需求采用**字符占比**（而不是试错式地调 API）：
 *   中文占比 = 中文字符数 / (中文字符数 + 英文字母数)
 *   中文占比 > 80% → 'zh'；英文占比 > 80% → 'en'；否则 'mixed'
 * 分母只统计中英文字母，是因为标点/数字/空白对判断语言毫无贡献，
 * 把它们算进来会让「标点很多的一篇短文」被误判成 mixed。
 */

export type LangKind = 'zh' | 'en' | 'mixed'

/** 需求规定的统计口径字符范围 */
export const ZH_CHAR_RE = /[\u4e00-\u9fa5]/g
export const EN_CHAR_RE = /[a-zA-Z]/g

/** 中文（含 CJK 扩展区）判断用：比上面的统计口径宽，用于分词/切句时的归档 */
const CJK_IDEOGRAPH_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** CJK 标点：、 。 《 》 「 」 （ ） ， ！ ？ 等 */
const CJK_PUNCT_RE = /[\u3000-\u303f\uff01-\uff60]/

export interface LangStats {
  /** 中文字符数（只统计常用区 \u4e00-\u9fa5） */
  zh: number
  /** 英文字母数 */
  en: number
  /** 有效字符总数 = zh + en */
  meaningful: number
  zhRatio: number
  enRatio: number
}

export function countChars(text: string): LangStats {
  if (!text) return { zh: 0, en: 0, meaningful: 0, zhRatio: 0, enRatio: 0 }
  const zh = (text.match(ZH_CHAR_RE) || []).length
  const en = (text.match(EN_CHAR_RE) || []).length
  const meaningful = zh + en
  return {
    zh,
    en,
    meaningful,
    zhRatio: meaningful === 0 ? 0 : zh / meaningful,
    enRatio: meaningful === 0 ? 0 : en / meaningful,
  }
}

/**
 * 判断整段文本的语言类型。
 * @param threshold 占比阈值，需求定为 0.8（>80%）
 *
 * 边界处理：完全没有任何中英文字母（纯数字/标点/空白）时返回 'en' ——
 * 这种行为与改造前完全一致（原先所有文本都走英文路径），避免回归。
 */
export function detectLanguage(text: string, threshold = 0.8): LangKind {
  const s = countChars(text)
  if (s.meaningful === 0) return 'en'
  if (s.zhRatio > threshold) return 'zh'
  if (s.enRatio > threshold) return 'en'
  return 'mixed'
}

/**
 * 给一小段文本挑一个**非此即彼**的语言（用于选嗓音）。
 * 与 detectLanguage 的差别：混排时也必须选一个，这里选字符数占优的那个，
 * 两者相等或都没有时按 'en' 兜底。
 */
export function dominantLang(text: string): 'zh' | 'en' {
  const s = countChars(text)
  if (s.meaningful === 0) return 'en'
  return s.zh >= s.en ? 'zh' : 'en'
}

/** 语言 → BCP-47 标签（给 SpeechSynthesisUtterance.lang 用） */
export function langTag(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US'
}

/** 文本 → 语言标签：混排取占优语言 */
export function langTagForText(text: string): string {
  return langTag(dominantLang(text))
}

/** 单个 token / 小片段的归类：含汉字即算中文（双语隐藏按 token 判断用） */
export function tokenLang(text: string): 'zh' | 'en' {
  return /[\u4e00-\u9fa5]/.test(text) ? 'zh' : 'en'
}

export interface BilingualStats {
  /** 中文为主的段落数（中英混排的段落两边都算） */
  zhParas: number
  /** 英文为主的段落数 */
  enParas: number
  /** 相邻段落语言发生切换的次数 —— 「交替出现」的量化 */
  switches: number
  /** 是否是双语素材（两种语言都出现） */
  bilingual: boolean
}

/**
 * 判断是否双语素材（需求【8】：中英段落交替出现）。
 *
 * 判定口径：**两种语言的段落都存在**即算双语。
 * 一段里同时有中英文（'mixed'）时两边各计一次 —— 教材里常见
 * 「整段中文 + 整段英文」和「一段里夹着英文单词」两种排版，都要覆盖。
 * `switches` 只是附加信息，用来判断"交替"的频繁程度，不参与判定。
 */
export function bilingualStats(paragraphs: readonly string[]): BilingualStats {
  let zhParas = 0
  let enParas = 0
  let switches = 0
  let prev: LangKind | null = null
  for (const raw of paragraphs) {
    const p = raw.trim()
    if (!p) continue
    const kind = detectLanguage(p)
    if (kind === 'zh' || kind === 'mixed') zhParas += 1
    if (kind === 'en' || kind === 'mixed') enParas += 1
    if (prev !== null && prev !== kind) switches += 1
    prev = kind
  }
  return { zhParas, enParas, switches, bilingual: zhParas > 0 && enParas > 0 }
}

/** 只要两种语言都出现过，就当作双语素材（展示「中/英」切换按钮的依据） */
export function detectBilingual(paragraphs: readonly string[]): boolean {
  return bilingualStats(paragraphs).bilingual
}

/* ------------------------------------------------------------------
 * 语言片段切分：把一段文本按「语言边界」拆开
 * ------------------------------------------------------------------
 * 例："今天我们学习 apple 这个单词。" →
 *     [{今天我们要学习, zh}, { apple , en}, {这个单词。, zh}]
 * 分词/切句都依赖它：这样英文片段仍按空格分词、中文片段用词级切分，
 * 两边互不干扰 —— 混合时也能各自用对的方式处理。
 */

export type ScriptClass = 'zh' | 'latin'

export interface LangSpan {
  text: string
  lang: ScriptClass
}

/**
 * 单字符的脚本归类。空白与标点默认归到「拉丁」一侧：在它们身上判断语言没有
 * 意义，让它们跟着相邻字符走即可，效果上等价于「中性」。
 *
 * 西里尔 / 阿拉伯文 / emoji 等无法归类的字符同样按拉丁处理 ——
 * 它们在原文里本来就不是「可查的词」，走英文分词器会原样成为非词 token。
 */
export function scriptClassOf(ch: string): ScriptClass {
  if (CJK_IDEOGRAPH_RE.test(ch)) return 'zh'
  if (CJK_PUNCT_RE.test(ch)) return 'zh'
  return 'latin'
}

export function splitLangSpans(text: string): LangSpan[] {
  const out: LangSpan[] = []
  let buf = ''
  let cls: ScriptClass | null = null
  for (const ch of text) {
    const c = scriptClassOf(ch)
    if (cls !== null && cls !== c) {
      // 语言切换：先结算已经累积的片段
      out.push({ text: buf, lang: cls })
      buf = ''
    }
    cls = c
    buf += ch
  }
  if (buf !== '') out.push({ text: buf, lang: cls ?? 'latin' })
  return out
}
