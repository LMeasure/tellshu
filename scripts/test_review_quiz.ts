/**
 * 复习组题单测（纯函数，无需浏览器）
 * ------------------------------------------------------------------
 * 重点覆盖这次修掉的缺陷：
 *   1. 词本取不到（离线 / 未缓存）时，**不能**把所有到期词静默丢弃
 *   2. 正确答案必须优先取「入生词本时已持久化的释义」
 *   3. 干扰项不能重复、不能等于正确答案
 *   4. 组不出题时必须如实上报原因，而不是返回一个空数组了事
 *
 * 运行：tsx scripts/test_review_quiz.ts
 */

import { buildQuizQuestions, shuffle, type QuizQuestion } from '../src/lib/reviewQuiz'
import type { VocabEntry } from '../src/domain/learning'
import type { ContentWord } from '../src/data/types'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

/** 固定 rng：每次洗牌结果确定，便于断言 */
function makeRng(seq: number[]): () => number {
  let i = 0
  return () => {
    const v = seq[i % seq.length] ?? 0.5
    i += 1
    return v
  }
}

function entry(word: string, definition_zh?: string, book = 'CET4'): VocabEntry {
  const now = Date.now()
  return {
    word_id: `${book}:${word}`,
    word,
    book,
    ipa: undefined,
    definition_zh,
    pos: undefined,
    layer: 'new',
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: now - 1000,
    added_at: now,
  }
}

function contentWord(word: string, definition_zh: string): ContentWord {
  return {
    id: `oe-${word}`,
    word,
    definition_zh,
    difficulty_level: 2,
    topic_id: 'CET4',
    book: 'CET4',
  } as ContentWord
}

console.log('复习组题单测（含离线场景）\n')

// ---------------------------------------------------------------- 基础：洗牌
console.log('【基础】shuffle')
{
  const src = [1, 2, 3, 4, 5]
  const out = shuffle(src, makeRng([0.1, 0.9, 0.2, 0.7, 0.4]))
  check('不丢失元素', out.length === src.length && [...out].sort().join() === src.join())
  check('不修改入参', src.join() === '1,2,3,4,5')
  check('空数组安全', shuffle([], makeRng([0.5])).length === 0)
}

// ------------------------------------------------- 核心：词本取不到（离线）
console.log('\n【核心】词本完全取不到（离线且未缓存）')
{
  const entries = [
    entry('abandon', 'vt. 抛弃；放弃'),
    entry('benefit', 'n. 益处；vt. 有益于'),
    entry('cabin', 'n. 小屋'),
    entry('damage', 'n./vt. 损害'),
  ]
  const { questions, dropped } = buildQuizQuestions(entries, [], makeRng([0.3, 0.6, 0.1, 0.8]))
  check('仍能组出题目', questions.length === 4, `组出 ${questions.length}/4`)
  check('没有被丢弃的词', dropped.length === 0, dropped.map((d) => `${d.word}(${d.reason})`).join('、'))
  const q0 = questions[0] as QuizQuestion
  check('正确答案取自已持久化的释义', q0.correct === 'vt. 抛弃；放弃', `correct=${q0.correct}`)
  check('每题 4 个选项（1 正确 + 3 干扰）', questions.every((q) => q.options.length === 4))
  check(
    '干扰项都来自其他到期词且不重复',
    questions.every((q) => {
      const unique = new Set(q.options)
      return unique.size === q.options.length && q.options.includes(q.correct)
    }),
  )
}

// --------------------------------------- 只有 1 个到期词且词本取不到（最坏情况）
console.log('\n【边界】只有 1 个到期词 + 词本取不到')
{
  const { questions, dropped } = buildQuizQuestions(
    [entry('abandon', 'vt. 抛弃；放弃')],
    [],
    makeRng([0.3]),
  )
  check('组不出题（孤零零一个选项）', questions.length === 0)
  check('如实上报原因，而非静默返回空', dropped.length === 1 && dropped[0].reason === 'too-few-options',
    `dropped=${JSON.stringify(dropped)}`)
}

// ---------------------------------------------------- 词本可用时应补位提高质量
console.log('\n【联网】词本可用时')
{
  const entries = [entry('abandon', 'vt. 抛弃；放弃'), entry('benefit', 'n. 益处')]
  const words = [
    contentWord('abandon', 'vt. 抛弃；放弃'),
    contentWord('benefit', 'n. 益处；vt. 有益于'),
    contentWord('cancel', 'vt. 取消'),
    contentWord('decay', 'vi. 腐朽'),
  ]
  const { questions, dropped } = buildQuizQuestions(entries, words, makeRng([0.2, 0.5, 0.9, 0.1]))
  check('全部成题', questions.length === 2 && dropped.length === 0)
  check('每题有 4 个选项', questions.every((q) => q.options.length === 4))
  const q = questions[0] as QuizQuestion
  check('正确答案仍优先用持久化释义', q.correct === 'vt. 抛弃；放弃')
}

// ---------------------------------------------------- 入库时没带释义（历史脏数据）
console.log('\n【边界】入库时没带释义')
{
  const { questions, dropped } = buildQuizQuestions(
    [entry('mystery'), entry('abandon', 'vt. 抛弃；放弃'), entry('cabin', 'n. 小屋')],
    [],
    makeRng([0.4, 0.2, 0.7]),
  )
  check('无释义的词被丢弃', dropped.some((d) => d.word === 'mystery' && d.reason === 'no-meaning'),
    `dropped=${JSON.stringify(dropped)}`)
  check('其余词正常成题', questions.length === 2)
}

// ---------------------------------------------------- 词本有、但入库释义缺失
console.log('\n【边界】入库没释义，但词本能补')
{
  const { questions, dropped } = buildQuizQuestions(
    [entry('orphan'), entry('cabin', 'n. 小屋'), entry('abandon', 'vt. 抛弃；放弃')],
    [contentWord('orphan', 'n. 孤儿'), contentWord('cabin', 'n. 小屋')],
    makeRng([0.15, 0.65, 0.35]),
  )
  const orphan = questions.find((q) => q.word === 'orphan')
  check('能从词本补到释义并成题', !!orphan && orphan.correct === 'n. 孤儿',
    orphan ? `correct=${orphan.correct}` : '未组出题')
  check('总体无丢弃', dropped.length === 0, JSON.stringify(dropped))
}

// ---------------------------------------------------------------- 空输入
console.log('\n【边界】空输入')
{
  const r = buildQuizQuestions([], [], makeRng([0.5]))
  check('空到期列表不抛异常', r.questions.length === 0 && r.dropped.length === 0)
}

console.log(`\n通过 ${passed} / 共 ${passed + failed}`)
if (failed > 0) {
  console.log(`失败 ${failed} 项：${failures.join('；')}`)
  process.exit(1)
}
console.log('✅ 复习组题单测全部通过')
