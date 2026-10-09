/**
 * 默写 / 跟读比对（纯函数，无副作用，便于单测）
 * ------------------------------------------------------------------
 * 记忆模式用：把用户默写（打字或录音转写）的文本与原文逐词比对，
 * 错误的词标红。对零基础用户而言，这是一种直观的「背诵/默写」校验。
 *
 * 不编造：只做字符串归一化 + 按位比对，绝不生成假释义。
 */

/** 单词分词正则（与阅读器一致） */
const WORD_RE = /([A-Za-z]+(?:['’\-][A-Za-z]+)*)|(\s+)|([^\sA-Za-z]+)/g

export interface DictationToken {
  /** 原文片段（含标点与空白） */
  raw: string
  /** 是否为英文单词 */
  isWord: boolean
  /** 该词在用户默写中是否命中（仅 isWord 时有意义） */
  correct: boolean
  /** 归一化后的原文词（小写），用于调试 */
  norm?: string
  /** 用户该位置写出的词（小写），命中时等于 norm */
  userWord?: string
}

export interface DictationResult {
  /** 原文词数 */
  totalWords: number
  /** 正确词数 */
  correctCount: number
  /** 与原文对齐的 token 序列（用于逐词渲染标红） */
  tokens: DictationToken[]
  /** 命中率 0-100 */
  accuracy: number
}

/** 归一化：小写、去标点、压缩空白、按空格分词 */
export function normalizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/**
 * 比对用户默写与原文。
 * - 按原文顺序生成 token（保留标点/空白用于原样渲染）。
 * - 每个原文单词按其在原文中的「词序号」与用户对应位置的词比较。
 * - 用户多写/少写的词，缺失位置判为错误。
 */
export function compareDictation(original: string, user: string): DictationResult {
  const userWords = normalizeWords(user)
  const origWords = normalizeWords(original)

  // 先把原文拆成 token（单词/空白/标点），并对单词维护一个自增词序号
  const tokens: DictationToken[] = []
  let wordIdx = 0
  let m: RegExpExecArray | null
  WORD_RE.lastIndex = 0
  while ((m = WORD_RE.exec(original))) {
    if (m[1]) {
      const norm = m[1].toLowerCase()
      const userWord = userWords[wordIdx]
      const correct = !!userWord && userWord === norm
      tokens.push({ raw: m[1], isWord: true, correct, norm, userWord })
      wordIdx++
    } else {
      tokens.push({ raw: m[0], isWord: false, correct: true })
    }
  }

  const correctCount = tokens.filter((t) => t.isWord && t.correct).length
  const totalWords = origWords.length
  const accuracy = totalWords === 0 ? 0 : Math.round((correctCount / totalWords) * 100)

  return { totalWords, correctCount, tokens, accuracy }
}
