/**
 * 单词默写 P0 单测（纯函数，无需浏览器 / 无需 IndexedDB）
 * ------------------------------------------------------------------
 * 覆盖方案 §九 P0 全部条目 + 阶段二引入的三条新规则：
 *   1. 计数：初始 0 / 连对 3 才完成 / 错即归零 / 错误与总次数准确
 *   2. 口径：会话级 = 单词级聚合，跳过不进正确率分母，分母为 0 返回 null（渲染 "—"）
 *   3. 幂等：request_id 重复不计数；终态词条不重复推进
 *   4. D6：连字符严格比对、大小写不敏感、脏数据选词阶段过滤
 *   5. D2：仅 COMPLETED 产生 SRS 交接义务，srs_reported 防重复
 *   6. 单文档写入的前提：状态机函数**不修改入参** —— 一旦偷偷改了入参，
 *      「一次 put 原子替换」就不再成立，半截状态会悄悄留在内存里。
 *
 * 运行：tsx scripts/test_spelling.ts
 */

import {
  DEFAULT_TARGET_CORRECT,
  STALE_PAUSE_MS,
  abandonSession,
  aggregateSession,
  applyAttempt,
  createSessionDraft,
  currentWord,
  hasValidAnswer,
  isSessionStale,
  judgeSpelling,
  markSrsReported,
  markUnavailable,
  pauseSession,
  pendingSrsWords,
  resumeSession,
  selectWords,
  sessionProgress,
  skipWord,
  type SpellingSession,
  type SpellingWordState,
} from '../src/domain/spelling'
import type { ReviewLog, VocabEntry } from '../src/domain/types'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    failures.push(msg)
    console.error(`  ❌ ${msg}`)
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  ok(
    actual === expected,
    `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`,
  )
}

function group(name: string, fn: () => void) {
  console.log(`\n▶ ${name}`)
  fn()
}

/* ------------------------------------------------------------------
 * 夹具
 * ------------------------------------------------------------------ */

const NOW = 1_700_000_000_000

function entry(word: string, extra: Partial<VocabEntry> = {}): VocabEntry {
  return {
    word_id: `CET4:${word.toLowerCase()}`,
    word,
    book: 'CET4',
    ipa: '/test/',
    definition_zh: `n. ${word}的中文释义`,
    pos: 'n.',
    layer: 'new',
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: NOW + 600_000,
    added_at: NOW,
    updated_at: NOW,
    owner: 'guest',
    ...extra,
  }
}

/** 固定 rng：mock 顺序乱序但可复现（0.1/0.2/0.3…） */
function seqRng(): () => number {
  let i = 0
  const vals = [0.9, 0.1, 0.7, 0.3, 0.5, 0.2, 0.8, 0.4, 0.6, 0.05]
  return () => vals[i++ % vals.length]
}

function buildSession(words: string[], opts: Partial<VocabEntry>[] = []): SpellingSession {
  const { session } = createSessionDraft({
    entries: words.map((w, i) => entry(w, opts[i] ?? {})),
    mode: 'random',
    count: words.length,
    now: NOW,
    rng: seqRng(),
    id: 'sess-test',
  })
  return session
}

function word(session: SpellingSession, w: string): SpellingWordState {
  const found = session.queue.find((x) => x.word === w)
  if (!found) throw new Error(`夹具里没有这个词：${w}`)
  return found
}

/** 连着答对 n 次 */
function answerRight(
  session: SpellingSession,
  w: string,
  n: number,
  start = 0,
): { session: SpellingSession; lastResult: ReturnType<typeof applyAttempt>['result'] } {
  let cur = session
  let lastResult!: ReturnType<typeof applyAttempt>['result']
  for (let i = 0; i < n; i += 1) {
    const r = applyAttempt(cur, {
      word_id: word(cur, w).word_id,
      input: w,
      request_id: `req-${start + i}`,
      now: NOW + (start + i) * 1000,
    })
    cur = r.session
    lastResult = r.result
  }
  return { session: cur, lastResult }
}

/* ------------------------------------------------------------------
 * 1. 拼写判定（D6）
 * ------------------------------------------------------------------ */

group('拼写判定 §2.3 / D6', () => {
  ok(judgeSpelling('abandon', 'abandon'), '完全相同判对')
  ok(judgeSpelling('  Abandon  ', 'abandon'), 'trim + 大小写不敏感')
  ok(judgeSpelling('AIDS', 'aids'), '含大写词条大小写不敏感（词库实测 56 条）')
  ok(!judgeSpelling('abanon', 'abandon'), '近似拼写不判对')

  ok(judgeSpelling('baby-sit', 'baby-sit'), '连字符词原样判对')
  ok(!judgeSpelling('baby sit', 'baby-sit'), '连字符严格比对：空格 ≠ 连字符')
  ok(!judgeSpelling('babysit', 'baby-sit'), '连字符严格比对：缺连字符判错')
  ok(!judgeSpelling('co-pilot', 'copilot'), 'co-pilot 与 copilot 是两个拼写')

  ok(hasValidAnswer('abandon'), '普通词是有效答案')
  ok(hasValidAnswer('baby-sit'), '连字符词是有效答案')
  ok(!hasValidAnswer('discombobulated['), '脏数据 discombobulated[ 不是有效答案')
  ok(!hasValidAnswer(''), '空串不是有效答案')
  ok(!hasValidAnswer('abc def'), '含空格不是有效答案（词库实测 0 条，不构成短语答案）')
})

/* ------------------------------------------------------------------
 * 2. 核心计数（P0）
 * ------------------------------------------------------------------ */

group('P0-1 初始状态', () => {
  const s = buildSession(['abandon'])
  const w = word(s, 'abandon')
  eq(w.consecutive_correct, 0, '初始连续正确为 0')
  eq(w.total_attempts, 0, '初始总提交为 0')
  eq(w.correct_attempts, 0, '初始正确次数为 0')
  eq(w.wrong_attempts, 0, '初始错误次数为 0')
  eq(w.status, 'PENDING', '初始状态 PENDING')
  eq(w.target_correct, DEFAULT_TARGET_CORRECT, '目标次数取统一配置 3')
  eq(s.status, 'IN_PROGRESS', '会话初始 IN_PROGRESS')
  eq(currentWord(s)?.word, 'abandon', '当前词是队列首个')
})

group('P0-2 连续正确达到 targetCorrect 才完成', () => {
  const { session: s1, lastResult: r1 } = answerRight(buildSession(['abandon']), 'abandon', 1)
  eq(word(s1, 'abandon').consecutive_correct, 1, '第 1 次对：连续正确 1')
  eq(word(s1, 'abandon').status, 'IN_PROGRESS', '第 1 次对：仍未完成')

  const { session: s2 } = answerRight(s1, 'abandon', 1, 1)
  eq(word(s2, 'abandon').consecutive_correct, 2, '第 2 次对：连续正确 2')
  eq(word(s2, 'abandon').status, 'IN_PROGRESS', '第 2 次对：仍未完成')

  const { session: s3, lastResult: r3 } = answerRight(s2, 'abandon', 1, 2)
  eq(word(s3, 'abandon').consecutive_correct, 3, '第 3 次对：连续正确 3')
  eq(word(s3, 'abandon').status, 'COMPLETED', '第 3 次对：状态转 COMPLETED')
  eq(r1.result, 'correct', '正确提交 result=correct')
  eq(r3.next_word_id, null, '没有剩余待练词 → next_word_id 为 null')
  eq(r3.session_status, 'SESSION_COMPLETED', '全部处理完 → 会话自然结束')
})

group('P0-3 任意错误立即重置连续正确', () => {
  let { session } = answerRight(buildSession(['abandon']), 'abandon', 2)
  eq(word(session, 'abandon').consecutive_correct, 2, '先连续对 2 次')

  const wrongRes = applyAttempt(session, {
    word_id: word(session, 'abandon').word_id,
    input: 'abanon',
    request_id: 'req-wrong',
    now: NOW + 3_000,
  })
  session = wrongRes.session
  eq(word(session, 'abandon').consecutive_correct, 0, '答错 → 连续正确立即归零')
  eq(word(session, 'abandon').status, 'IN_PROGRESS', '答错不推进，仍在 IN_PROGRESS')
  eq(wrongRes.result.result, 'wrong', '错误提交 result=wrong')
  eq(word(session, 'abandon').wrong_attempts, 1, '错误次数累计')

  // 归零后必须重新连对 3 次
  const again = answerRight(session, 'abandon', 2, 4)
  eq(word(again.session, 'abandon').consecutive_correct, 2, '重新连对 2 次')
  eq(word(again.session, 'abandon').status, 'IN_PROGRESS', '2 次不足以完成')
  const third = answerRight(again.session, 'abandon', 1, 6)
  eq(word(third.session, 'abandon').status, 'COMPLETED', '补满 3 次才 COMPLETED')
})

group('P0-4 错误累计与总提交次数准确', () => {
  let session = buildSession(['abandon'])
  const wid = () => word(session, 'abandon').word_id
  for (let i = 0; i < 3; i += 1) {
    session = applyAttempt(session, {
      word_id: wid(),
      input: 'abanon',
      request_id: `w-${i}`,
      now: NOW + i * 1000,
    }).session
  }
  const w = word(session, 'abandon')
  eq(w.total_attempts, 3, '有效提交次数 = 3')
  eq(w.wrong_attempts, 3, '错误次数 = 3')
  eq(w.correct_attempts, 0, '正确次数 = 0')
  eq(w.consecutive_correct, 0, '连续正确仍为 0')
})

group('P0-4b 空白提交不计入任何计数', () => {
  let session = buildSession(['abandon'])
  for (const input of ['', '   ', '\t\n']) {
    const r = applyAttempt(session, {
      word_id: word(session, 'abandon').word_id,
      input,
      request_id: `blank-${input.length}-${input.trim().length || 'ws'}`,
      now: NOW,
    })
    session = r.session
    eq(r.result.result, 'invalid', '空白提交 result=invalid')
  }
  const w = word(session, 'abandon')
  eq(w.total_attempts, 0, '空白提交不计入总提交')
  eq(w.wrong_attempts, 0, '空白提交不计入错误次数（不污染 SRS / 不上报）')
  eq(w.status, 'PENDING', '空白提交不改变词条状态')
})

/* ------------------------------------------------------------------
 * 3. 幂等与终态保护（P0）
 * ------------------------------------------------------------------ */

group('P0-5 request_id 幂等：重复请求不重复计数', () => {
  let session = buildSession(['abandon'])
  const wid = word(session, 'abandon').word_id
  const first = applyAttempt(session, {
    word_id: wid,
    input: 'abandon',
    request_id: 'same-req',
    now: NOW,
  })
  session = first.session
  const replay = applyAttempt(session, {
    word_id: wid,
    input: 'abandon',
    request_id: 'same-req',
    now: NOW + 5_000,
  })

  eq(word(replay.session, 'abandon').consecutive_correct, 1, '重复请求不再 +1')
  eq(word(replay.session, 'abandon').total_attempts, 1, '重复请求不再累计提交次数')
  eq(replay.result.at, first.result.at, '重复请求回放的是原结果（时间戳一致）')
  eq(replay.result.word_id, first.result.word_id, '回放结果与原结果同一词条')
  eq(replay.session, session, '幂等命中时不产出新会话文档（引用相同，无需再写库）')
})

group('P0-6 终态词条不能重复推进 / 重复计数', () => {
  const { session: done } = answerRight(buildSession(['abandon']), 'abandon', 3)
  const after = applyAttempt(done, {
    word_id: word(done, 'abandon').word_id,
    input: 'abandon',
    request_id: 'after-complete',
    now: NOW + 9_000,
  })
  eq(after.result.result, 'terminal', '完成后再提交 → terminal')
  eq(word(after.session, 'abandon').total_attempts, 3, '完成后的提交不计数')
  eq(word(after.session, 'abandon').consecutive_correct, 3, '连续正确停在 3')
  eq(after.session.status, 'SESSION_COMPLETED', '会话状态不被二次改写')

  // 跳过的词同样不能复活
  let skipped = skipWord(buildSession(['abandon', 'benefit']), {
    word_id: 'CET4:abandon',
    request_id: 'skip-1',
    now: NOW,
  }).session
  const replaySkip = skipWord(skipped, {
    word_id: 'CET4:abandon',
    request_id: 'skip-1',
    now: NOW + 1_000,
  })
  eq(replaySkip.result.result, 'skipped', '重复跳过回放原结果')
  eq(replaySkip.session.current_position, word(skipped, 'benefit').position, '队列没有被二次推进')

  const tryAgain = applyAttempt(skipped, {
    word_id: 'CET4:abandon',
    input: 'abandon',
    request_id: 'after-skip',
    now: NOW + 2_000,
  })
  eq(tryAgain.result.result, 'terminal', '已跳过的词不能再作答')
  eq(tryAgain.session.current_position, word(skipped, 'benefit').position, '当前位置不受影响')
})

group('P0-7 不修改入参（单文档原子替换的前提）', () => {
  const before = buildSession(['abandon'])
  const snapshot = JSON.stringify(before)
  applyAttempt(before, {
    word_id: 'CET4:abandon',
    input: 'abandon',
    request_id: 'pure-1',
    now: NOW,
  })
  eq(JSON.stringify(before), snapshot, 'applyAttempt 不得修改入参 session')
  skipWord(before, { word_id: 'CET4:abandon', request_id: 'pure-2', now: NOW })
  eq(JSON.stringify(before), snapshot, 'skipWord 不得修改入参 session')
  markUnavailable(before, { word_ids: ['CET4:abandon'], reason: 'deleted', now: NOW })
  eq(JSON.stringify(before), snapshot, 'markUnavailable 不得修改入参 session')
})

/* ------------------------------------------------------------------
 * 4. 统计口径（P0）
 * ------------------------------------------------------------------ */

group('P0-8 会话级统计 = 单词级聚合；跳过不进分母', () => {
  let session = buildSession(['abandon', 'benefit', 'cabbage'])
  session = answerRight(session, 'abandon', 3).session // 3 次全对（req-0..2）
  session = answerRight(session, 'benefit', 1, 10).session // 1 次对（req-10，换号避免幂等命中）
  session = applyAttempt(session, {
    // cabbage 错 2 次
    word_id: 'CET4:cabbage',
    input: 'cabage',
    request_id: 'cab-1',
    now: NOW + 10,
  }).session
  session = applyAttempt(session, {
    word_id: 'CET4:cabbage',
    input: 'cabeg',
    request_id: 'cab-2',
    now: NOW + 11,
  }).session
  session = skipWord(session, {
    word_id: 'CET4:benefit',
    request_id: 'skip-b',
    now: NOW + 12,
  }).session

  const st = aggregateSession(session, NOW + 20_000)
  eq(st.total_attempts, 6, '总提交 = 3 + 1 + 2')
  eq(st.correct_attempts, 4, '正确提交 = 3 + 1')
  eq(st.wrong_attempts, 2, '错误提交 = 2')
  eq(st.accuracy, 67, '正确率 = 4/6 ≈ 67%（跳过未进分母）')
  eq(sessionProgress(session).completed, 1, '完成数 = 1')
  eq(sessionProgress(session).skipped, 1, '跳过数 = 1')
  eq(st.completion_rate, 33, '完成率 = 1/3 ≈ 33%（跳过不计入完成）')
  eq(st.remaining, 1, '剩余未终态 = cabbage')
  eq(st.duration_ms, 20_000, '耗时按 (ended ?? now) - started')

  // 关键对照：跳过没能把总提交变成 7（跳过不属于答题提交）
  ok(st.total_attempts < 7, '跳过操作不进入正确率分母')
})

group('P0-8b 分母为 0 → null（前端渲染 "—"）', () => {
  const session = buildSession(['abandon'])
  const st = aggregateSession(session, NOW)
  eq(st.accuracy, null, '没有提交时正确率为 null')
  eq(st.completion_rate, 0, '完成率仍可算（0/1 = 0%）')

  const empty: SpellingSession = { ...session, total_words: 0, queue: [] }
  eq(aggregateSession(empty, NOW).completion_rate, null, '没有词条时完成率为 null')
  eq(aggregateSession(empty, NOW).accuracy, null, '没有词条时正确率为 null')
})

/* ------------------------------------------------------------------
 * 5. SRS 交接（D2）
 * ------------------------------------------------------------------ */

group('D2 SRS 交接点：仅 COMPLETED 触发，且只触发一次', () => {
  let session = buildSession(['abandon', 'benefit'])

  const first = answerRight(session, 'abandon', 1, 0)
  session = first.session
  eq(first.lastResult.srs_due, false, '未达标的正确提交不产生交接义务')

  const second = answerRight(session, 'abandon', 1, 1)
  session = second.session
  eq(second.lastResult.srs_due, false, '第 2 次对仍不产生交接义务')

  const third = answerRight(session, 'abandon', 1, 2)
  session = third.session
  eq(third.lastResult.srs_due, true, '第 3 次对 → 产生交接义务')
  eq(pendingSrsWords(session).length, 1, '待交接队列里有这个词')

  const reported = markSrsReported(session, 'CET4:abandon', NOW + 20)
  eq(word(reported, 'abandon').srs_reported, true, '交接后落标记')
  eq(pendingSrsWords(reported).length, 0, '落标记后不再需要重复调用 recordQuiz')
  const again = markSrsReported(reported, 'CET4:abandon', NOW + 30)
  eq(again, reported, '重复标记幂等，不产出新文档')

  // 跳过 / 失效 / 错误都不产生交接
  const skipped = skipWord(session, {
    word_id: 'CET4:benefit',
    request_id: 'skip-srs',
    now: NOW + 40,
  })
  eq(skipped.result.srs_due, false, 'SKIPPED 不产生交接义务')
  const wrongOnly = buildSession(['abandon'])
  const wrongRes = applyAttempt(wrongOnly, {
    word_id: 'CET4:abandon',
    input: 'abanon',
    request_id: 'wrong-srs',
    now: NOW,
  })
  eq(wrongRes.result.srs_due, false, '答错不产生交接义务')
})

group('失效词条：只转 PENDING / IN_PROGRESS，终态不动', () => {
  let session = buildSession(['abandon', 'benefit', 'cabbage'])
  session = answerRight(session, 'abandon', 3).session // abandon 完成
  session = applyAttempt(session, {
    // cabbage 进入 IN_PROGRESS
    word_id: 'CET4:cabbage',
    input: 'cabage',
    request_id: 'cab-1',
    now: NOW,
  }).session

  const after = markUnavailable(session, {
    word_ids: ['CET4:abandon', 'CET4:cabbage', 'CET4:benefit'],
    reason: 'entry-deleted',
    now: NOW + 100,
  })
  eq(word(after, 'abandon').status, 'COMPLETED', 'COMPLETED 词条即使被删也保持完成状态')
  eq(word(after, 'cabbage').status, 'UNAVAILABLE', 'IN_PROGRESS 词条转 UNAVAILABLE')
  eq(word(after, 'cabbage').unavailable_reason, 'entry-deleted', '记录失效原因')
  eq(word(after, 'benefit').status, 'UNAVAILABLE', 'PENDING 词条转 UNAVAILABLE')

  const stats = aggregateSession(after, NOW + 200)
  eq(stats.completed, 1, '失效不改写完成数')
  eq(stats.unavailable, 2, '不可用语数按唯一当前状态计，不重复累计')
  eq(after.status, 'SESSION_COMPLETED', '全部终态后会话结束')

  // 不在队列里的 word_id 静默忽略
  const untouched = markUnavailable(after, { word_ids: ['CET4:nope'], reason: 'x', now: NOW })
  eq(untouched, after, '未见词条时原样返回（不写库）')
})

/* ------------------------------------------------------------------
 * 6. 选词（D5 / D6）
 * ------------------------------------------------------------------ */

group('选词模式与过滤（D5 / D6）', () => {
  const entries: VocabEntry[] = [
    entry('abandon', { added_at: NOW - 3_000 }),
    entry('benefit', { added_at: NOW - 1_000, in_wrong_pool: true }),
    entry('cabbage', { added_at: NOW - 2_000 }),
    entry('discombobulated[', { word_id: 'GRE:dirty' }),
    entry('hello', { definition_zh: undefined }),
    entry('abandon', { word_id: 'CET4:abandon' }), // 与上一条重复（同 word_id）
  ]
  const logs: ReviewLog[] = [
    { word_id: 'CET4:cabbage', at: NOW, correct: false, quiz_form: 'choose-meaning' },
    { word_id: 'CET4:cabbage', at: NOW, correct: false, quiz_form: 'choose-meaning' },
  ]

  const random = selectWords({ entries, mode: 'random', count: 3, now: NOW, rng: seqRng() })
  eq(random.entries.length, 3, '随机模式取 3 个')
  eq(random.available, 3, '可用词条 3 个（脏数据 / 无释义 / 重复被过滤）')
  ok(
    random.dropped.some((d) => d.reason === 'invalid-word' && d.word === 'discombobulated['),
    '脏数据在选词阶段被排除（D6）',
  )
  ok(
    random.dropped.some((d) => d.reason === 'no-meaning' && d.word === 'hello'),
    '无释义词条被排除并如实上报',
  )
  ok(
    random.dropped.some((d) => d.reason === 'duplicate'),
    '重复 word_id 被去重并如实上报',
  )
  ok(
    random.entries.every((e) => hasValidAnswer(e.word) && (e.definition_zh ?? '').trim()),
    '进入队列的词条全部可练',
  )

  const recent = selectWords({ entries, mode: 'recent', count: 3, now: NOW, rng: seqRng() })
  eq(recent.entries[0].word, 'benefit', '最近新增：按 added_at 倒序')

  const wrong = selectWords({
    entries,
    review_logs: logs,
    mode: 'wrong',
    count: 3,
    now: NOW,
    rng: seqRng(),
  })
  eq(wrong.entries[0].word, 'cabbage', '易错词：错得最多的排最前')

  const shortage = selectWords({ entries, mode: 'recent', count: 50, now: NOW, rng: seqRng() })
  eq(shortage.entries.length, 3, '请求数量 > 可用数量时按实际可用数量选')
})

group('会话构造：数量不足按实际可用量', () => {
  const { session, requested, dropped } = createSessionDraft({
    entries: [entry('abandon'), entry('discombobulated[', { word_id: 'GRE:dirty' })],
    mode: 'recent',
    count: 10,
    now: NOW,
    rng: seqRng(),
  })
  eq(requested, 10, '记录了用户请求的数量')
  eq(session.total_words, 1, '按实际可用数量建会话')
  eq(session.selection_mode, 'recent', '记录选词模式')
  eq(session.owner, 'guest', '本地实现 owner = guest（与 vocab 一致）')
  eq(session.type, 'spelling', '会话文档类型固定 spelling')
  ok(dropped.length === 1, '被排除的词条带出给调用方提示')
  eq(Object.keys(session.processed_requests).length, 0, '新会话没有已处理请求')
})

/* ------------------------------------------------------------------
 * 7. 会话生命周期
 * ------------------------------------------------------------------ */

group('暂停 / 恢复 / 放弃 / 过期判定', () => {
  const base = buildSession(['abandon', 'benefit'])
  const paused = pauseSession(base, NOW)
  eq(paused.status, 'PAUSED', '暂停 → PAUSED')
  eq(paused.paused_at, NOW, '记录暂停时间')
  eq(base.status, 'IN_PROGRESS', '暂停不改原文档')

  const resumed = resumeSession(paused, NOW + 1_000)
  eq(resumed.status, 'IN_PROGRESS', '恢复 → IN_PROGRESS')
  eq(resumed.paused_at, undefined, '恢复后清除暂停时间')

  ok(!isSessionStale(paused, NOW + STALE_PAUSE_MS - 1), '未满 7 天不算过期')
  ok(isSessionStale(paused, NOW + STALE_PAUSE_MS), '暂停满 7 天判定过期')
  ok(!isSessionStale(base, NOW + STALE_PAUSE_MS), '非暂停状态不参与过期判定')

  const abandoned = abandonSession(resumed, NOW + 2_000)
  eq(abandoned.status, 'ABANDONED', '放弃 → ABANDONED')
  eq(abandoned.ended_at, NOW + 2_000, '放弃记录结束时间')
  eq(abandonSession(abandoned, NOW + 3_000), abandoned, '重复放弃幂等')

  let failure = false
  try {
    applyAttempt(paused, { word_id: 'CET4:abandon', input: 'abandon', request_id: 'x', now: NOW })
  } catch {
    failure = true
  }
  ok(failure, '非 IN_PROGRESS 会话拒绝提交')
})

group('completed 后会话自然收尾', () => {
  let session = buildSession(['abandon', 'benefit'])
  const { session: doneAll } = answerRight(session, 'abandon', 3)
  session = doneAll
  const last = answerRight(session, 'benefit', 3, 3)
  eq(last.session.status, 'SESSION_COMPLETED', '最后一个词完成 → 会话结束')
  eq(last.session.ended_at, NOW + 5_000, '自然结束时写入 ended_at（最后一次提交的时间）')
  eq(aggregateSession(last.session, NOW + 100).accuracy, 100, '全对时正确率 100%')
  eq(currentWord(last.session), null, '结束后没有当前词')
})

/* ------------------------------------------------------------------
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(56)}`)
if (failed === 0) {
  console.log(`✅ 单词默写 P0 单测全部通过：${passed} 项断言`)
} else {
  console.error(`❌ 单词默写 P0 单测失败：${failed} 项失败 / ${passed} 项通过`)
  failures.forEach((f) => console.error(`   - ${f}`))
  process.exit(1)
}
