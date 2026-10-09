/**
 * 诊断：抽题 + 定级（纯逻辑层）
 * ------------------------------------------------------------------
 * 刻意不依赖 Vite 环境变量（import.meta.env）与 Dexie/IndexedDB，
 * 因此可在 Node 下直接单测（scripts/test_features.ts）。
 * 所有题目素材均来自调用方传入的真实词条，**不内置也不编造任何词**。
 */

import type { ContentDiagnostic, ContentWord, DifficultyLevel } from '../data/types'

/** 诊断定级：1=字母/最基础，2=基础词汇，3=难词（见 01-PRD §5） */
export type DiagnoseLevel = 1 | 2 | 3

export interface DiagnoseAnswer {
  level: DiagnoseLevel
  correct: boolean
}

/** 五题梯度：L1 最基础 ×2 / L2 基础词汇 ×2 / L3 难词 ×1 */
export const DIAGNOSE_PLAN: { level: DifficultyLevel; count: number }[] = [
  { level: 1, count: 2 },
  { level: 2, count: 2 },
  { level: 3, count: 1 },
]

/** 稳定伪随机（同 seed 同结果，便于单测复现）；不用于安全场景。 */
function shuffle<T>(list: T[], rand: () => number): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 释义去重（不同词可能共享同一释义，直接入选项会出现两个正确答案） */
function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

/**
 * 按真实可观测特征把词条切成三个难度档。
 * ------------------------------------------------------------------
 * 档位成员由词长 + 语素数决定（确定性、可复现、受单测守护）：
 *   - 词长：短词多为零基础最先接触的基础词，长词多为派生/学术词
 *   - 语素数（morphemes）：单词素 = 不可再拆的基础词；多语素 = 派生词，更晚学
 * 两者都是词库里真实存在的字段，不含任何主观打分。
 *
 * 关于 frequency_rank（词频）：
 *   旧词包里该字段实为词本内字母序下标（CET4 实测 1..4515），用作分档毫无意义，
 *   故档位成员不依赖它。该陷阱已在数据层修正（export_to_shushu.py 用 Linguabase
 *   真实 core_rank 重写 frequency_rank），因此这里仅把它作为「档内排序」的
 *   次级信号（同档同词长时更常用的词排在前面），不改变档位成员。
 */
export function bucketByDifficulty(words: ContentWord[]): Record<
  DifficultyLevel,
  ContentWord[]
> {
  const morph = (w: ContentWord) => (Array.isArray(w.morphemes) ? w.morphemes.length : 0)
  const byLen = (pred: (n: number) => boolean) => words.filter((w) => pred(w.word.length))

  // 主档位；任一档样本不足（<4）时逐级放宽，保证能出题
  const l1 = byLen((n) => n <= 4).filter((w) => morph(w) <= 1)
  const l2 = byLen((n) => n >= 5 && n <= 8).filter((w) => morph(w) <= 2)
  const l3 = words.filter((w) => w.word.length >= 9 || morph(w) >= 3)

  const relax = (cur: ContentWord[], fallback: () => ContentWord[]) =>
    cur.length >= 4 ? cur : fallback()

  // 档内排序：真实词频优先（frequency_rank 现已来自 Linguabase core_rank，越小越常用），
  // 缺失则退到字母序。仅影响档内顺序、不改变档位成员（受单测守护，成员由词长/语素数决定）。
  const orderPool = (pool: ContentWord[]): ContentWord[] =>
    [...pool].sort((a, b) => {
      const ra = a.frequency_rank ?? Number.POSITIVE_INFINITY
      const rb = b.frequency_rank ?? Number.POSITIVE_INFINITY
      if (ra !== rb) return ra - rb
      return a.word.localeCompare(b.word)
    })

  return {
    1: orderPool(relax(l1, () => byLen((n) => n <= 5))),
    2: orderPool(relax(l2, () => byLen((n) => n >= 5 && n <= 8))),
    3: orderPool(relax(l3, () => byLen((n) => n >= 8))),
  }
}

/**
 * 由真实词条生成 5 道梯度诊断题（L1×2 / L2×2 / L3×1）。
 * 词量不足（<20）或某档取不到合格选项时，返回已凑齐的题目（可能少于 5 道），
 * 调用方按实际长度渲染——绝不用假题补足。
 */
export function buildDiagnostics(
  words: ContentWord[],
  rand: () => number = Math.random,
): ContentDiagnostic[] {
  if (words.length < 20) return []

  const pools = bucketByDifficulty(words)
  const out: ContentDiagnostic[] = []
  for (const step of DIAGNOSE_PLAN) {
    const pool = pools[step.level]
    if (pool.length === 0) continue
    for (let i = 0; i < step.count; i++) {
      const q = makeQuestion(step.level, pool, out.length, rand)
      if (q) out.push(q)
    }
  }
  return out
}

/** 单题：正确答案取自该词真实释义，干扰项取自同档其他真实词的真实释义。 */
function makeQuestion(
  level: DifficultyLevel,
  pool: ContentWord[],
  seq: number,
  rand: () => number,
): ContentDiagnostic | null {
  const candidates = shuffle(pool, rand)
  // 同档其他词的释义，先备好候选池，按整题取用
  for (const w of candidates) {
    const answer = (w.definition_zh ?? w.definition_en ?? '').trim()
    if (!answer) continue
    const distractors = uniq(
      shuffle(pool, rand)
        .filter((o) => o.word !== w.word)
        .map((o) => (o.definition_zh ?? o.definition_en ?? '').trim()),
    ).filter((d) => d !== answer)
    if (distractors.length < 3) continue
    const options = shuffle([...distractors.slice(0, 3), answer], rand)
    return {
      id: `diag-${level}-${seq}-${w.id}`,
      difficulty_level: level,
      question: `「${w.word}」是什么意思？`,
      options,
      answer,
      topic_id: w.topic_id,
    }
  }
  return null
}

/**
 * 由逐题作答推导等级与建议起始词本。
 *   - L3 答对且 L1/L2 全对 → L3（直接进 CET6）
 *   - L1 全对且 L2 至少对 1 → L2
 *   - 其余 → L1（从最基础起步）
 * 低档失手即停留在该档：错基础词说明该档仍需补，不靠高档题拉分。
 */
export function gradeDiagnosis(answers: DiagnoseAnswer[]): {
  level: DiagnoseLevel
  start_book: string
} {
  const hitOf = (lv: DiagnoseLevel) => answers.filter((a) => a.level === lv && a.correct).length
  const totalOf = (lv: DiagnoseLevel) => answers.filter((a) => a.level === lv).length

  const l1 = hitOf(1)
  const l2 = hitOf(2)
  const l3 = hitOf(3)

  let level: DiagnoseLevel = 1
  if (l1 === totalOf(1) && l2 === totalOf(2) && l3 > 0) {
    level = 3
  } else if (l1 === totalOf(1) && l2 > 0) {
    level = 2
  }
  return { level, start_book: level === 3 ? 'CET6' : 'CET4' }
}
