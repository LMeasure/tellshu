import type { ContentWord } from '@/data/types'
import type { VocabEntry } from '@/domain/learning'

/**
 * 复习闯关组题（纯函数，可单测）
 * ==================================================================
 * 为什么单独抽出来
 * ------------------------------------------------------------------
 * 原先这段逻辑写在 ChallengeScreen 里，并且**强依赖联网拉取词本**：
 *   repository.getWords(book) → 拿到全量词条 → 取 definition_zh 当正确答案
 * 一旦词本取不到（离线且未缓存 / 请求超时 / dataClient 返回兜底空数组），
 * 到期词条会被 `continue` 静默丢弃，界面渲染成「暂无可复习」——
 * 用户完全无法区分「真的没有到期词」还是「词组了但没组出来」。
 *
 * 这对本产品是致命的：述树主打**离线优先**，复习是核心闭环，
 * 它不应该依赖任何网络请求。
 *
 * 而入生词本时（`addToVocab` / `addManyToVocab`）已经把
 * `definition_zh` **持久化到 VocabEntry 上了**，所以：
 *   - 正确答案 ---- 优先取生词本里已存的释义，离线必然可用
 *   - 干扰项 ------ 优先用同一批到期词之间的释义互相干扰，词本只作补充
 *
 * 这样即便一个词本分片都没缓存，只要有 >= 2 个到期词，题目照样能组出来。
 */

export interface QuizQuestion {
  entry: VocabEntry
  word: string
  ipa?: string
  correct: string
  options: string[]
}

/** 被丢弃的词及原因 —— 让「有到期词却没题」这件事可观测，而不是黑盒静默 */
export interface QuizDrop {
  word: string
  reason: 'no-meaning' | 'too-few-options'
}

export interface QuizBuildResult {
  questions: QuizQuestion[]
  dropped: QuizDrop[]
}

/** Fisher–Yates 洗牌；rng 可注入，便于单测确定性验证 */
export function shuffle<T>(input: readonly T[], rng: () => number = Math.random): T[] {
  const a = [...input]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 从候选释义里挑 n 个既不等于正确答案、又互不相同的干扰项 */
function pickDistinctMeanings(
  pool: readonly string[],
  correct: string,
  n: number,
  rng: () => number,
): string[] {
  const out: string[] = []
  const used = new Set<string>([correct])
  for (const m of shuffle(pool, rng)) {
    if (out.length >= n) break
    if (used.has(m)) continue
    used.add(m)
    out.push(m)
  }
  return out
}

/**
 * 组题主函数。
 *
 * @param entries 到期词条（来自 getDueReviews）
 * @param words   词本全量词条；**可以为空数组**（离线拿不到时）
 * @param rng     随机源，测试时注入固定序列
 */
export function buildQuizQuestions(
  entries: readonly VocabEntry[],
  words: readonly ContentWord[] = [],
  rng: () => number = Math.random,
): QuizBuildResult {
  const byWord = new Map<string, ContentWord>()
  for (const w of words) {
    if (w && typeof w.word === 'string') byWord.set(w.word.toLowerCase(), w)
  }

  // 生词入库时已落盘的释义 —— 离线也能用，是正确答案的第一来源
  const stored = new Map<string, string>()
  for (const e of entries) {
    if (e.definition_zh) stored.set(e.word.toLowerCase(), e.definition_zh)
  }

  // 干扰项候选池：到期词之间互相干扰（离线可用） + 词本补位（联网时质量更高）
  const meaningPool = new Set<string>()
  for (const e of entries) if (e.definition_zh) meaningPool.add(e.definition_zh)
  for (const w of byWord.values()) {
    const m = w.definition_zh ?? w.definition_en ?? ''
    if (m) meaningPool.add(m)
  }
  const pool = Array.from(meaningPool)

  const questions: QuizQuestion[] = []
  const dropped: QuizDrop[] = []

  for (const entry of entries) {
    const key = entry.word.toLowerCase()
    const cw = byWord.get(key)
    const correct = stored.get(key) ?? cw?.definition_zh ?? cw?.definition_en ?? ''
    if (!correct) {
      // 入库时没带释义、词本又取不到 —— 确实没法出题，如实上报
      dropped.push({ word: entry.word, reason: 'no-meaning' })
      continue
    }
    const distractors = pickDistinctMeanings(pool, correct, 3, rng)
    const options = shuffle([correct, ...distractors], rng)
    if (options.length < 2) {
      // 只有自己一个选项，选择题不成立；同样如实上报而非静默丢弃
      dropped.push({ word: entry.word, reason: 'too-few-options' })
      continue
    }
    questions.push({
      entry,
      word: entry.word,
      ipa: entry.ipa ?? cw?.ipa,
      correct,
      options,
    })
  }

  return { questions, dropped }
}
