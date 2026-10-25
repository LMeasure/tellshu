/**
 * 单词默写 · 阶段 E 全量业务验收
 * ------------------------------------------------------------------
 * 目的：按阶段 E 任务书 §4「核心业务验收」逐条取证。
 * 每条断言都打印**实际值**，结论只认「库里读出来的状态」，不认函数返回值本身。
 *
 * 与既有 5 套的分工：
 *   test_spelling.ts            纯状态机
 *   test_spelling_session.ts    持久化层 happy path
 *   test_spelling_migration.ts  v9→v10 数据不丢
 *   test_spelling_srs_handoff.ts C1~C4 故障注入
 *   test_spelling_ui.ts         jsdom 前端渲染
 *   本文件（阶段 E）            端到端业务口径 + 已知限制的**复现固化**
 *
 * ⚠️ 已知限制的呈现方式：Group E 故意把「重复交接」重新复现一遍并断言它**确实会发生**。
 *    这不是bug回归测试的失败，而是把「当前保证 = at-least-once」变成可回归的事实，
 *    防止后人误以为已经修成恰好一次。改动这里前先读阶段 C 报告 §方案评估。
 *
 * 运行：tsx scripts/test_spelling_acceptance_e.ts
 */

import 'fake-indexeddb/auto'
import {
  abandon,
  createSession,
  getAllSessions,
  getActiveSessions,
  getResumableSession,
  getSessionById,
  pause,
  repairSrsHandoff,
  resume,
  refreshAvailability,
  submitAttempt,
  skip,
  SpellingSessionError,
  currentWord,
  aggregateSession,
  sessionProgress,
  pendingSrsWords,
} from '../src/domain/spellingSession'
import { addToVocab, removeFromVocab, recordQuiz } from '../src/domain/learning'
import { storage } from '../src/services/storage'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string, evidence = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${msg}${evidence ? `  [${evidence}]` : ''}`)
  } else {
    failed += 1
    failures.push(msg)
    console.log(`  ✗ ${msg}${evidence ? `  [${evidence}]` : ''}`)
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  ok(actual === expected, msg, `期望 ${String(expected)}，实际 ${String(actual)}`)
}

async function group(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${name}`)
  await fn()
}

/* ---------------- 存储原型：定点故障注入（复用阶段 C 手法） ---------------- */

type Proto = Record<string, (this: { name: string }, ...args: unknown[]) => Promise<unknown>>
const proto = Object.getPrototypeOf(storage.table('spellingSessions')) as unknown as Proto

function inject(opts: {
  table: string
  method: 'put' | 'get' | 'add'
  nth: number
  message: string
  when?: (args: unknown[]) => boolean
}): () => void {
  const original = proto[opts.method]
  let n = 0
  proto[opts.method] = async function (this: { name: string }, ...args: unknown[]) {
    if (this.name === opts.table && (!opts.when || opts.when(args))) {
      n += 1
      if (n === opts.nth) throw new Error(opts.message)
    }
    return original.apply(this, args)
  }
  return () => {
    proto[opts.method] = original
  }
}

/* ---------------- 观测辅助 ---------------- */

let WORDS: Record<string, string> = {}

async function seedVocab(): Promise<void> {
  await addToVocab({ word: 'abandon', book: 'CET4', definition_zh: 'v. 抛弃；放弃' })
  await addToVocab({ word: 'benefit', book: 'CET4', definition_zh: 'n. 利益；好处' })
  await addToVocab({ word: 'cabbage', book: 'CET4', definition_zh: 'n. 卷心菜' })
  WORDS = {}
  for (const v of await storage.table('vocab').toArray()) WORDS[v.word_id] = v.word
}

async function reset(): Promise<void> {
  await storage.clearAll()
}

async function wordIdOf(word: string): Promise<string> {
  const rows = await storage.table('vocab').toArray()
  const hit = rows.find((v) => v.word === word)
  if (!hit) throw new Error(`种子里没有 ${word}`)
  return hit.word_id
}

/** 直接读库，不经过任何领域函数 —— 证据必须来自持久化结果 */
async function spellingLogs(wordId: string): Promise<number> {
  const rows = (await storage.table('reviewLog').toArray()).filter(
    (l) => l.word_id === wordId && l.quiz_form === 'spelling',
  )
  return rows.length
}

async function vocabOf(wordId: string) {
  const rows = await storage.table('vocab').toArray()
  const hit = rows.find((v) => v.word_id === wordId)
  return hit ?? null
}

/** 从库里取「当前词」的答案。刻意不走 vocab.get，避免和注入点相撞 */
function answerOf(wordId: string): string {
  const w = WORDS[wordId]
  if (!w) throw new Error(`WORDS 缓存里没有 ${wordId}`)
  return w
}

/* ================================================================== */

async function main(): Promise<void> {
  await group('A · 练习与计数', async () => {
    /* ---- A1 连续答对达标：词条只完成一次 ---- */
    await reset()
    await seedVocab()
    const { session } = await createSession({ mode: 'recent', count: 3 })
    const w0 = session.queue[0]
    const ans = answerOf(w0.word_id)

    for (let i = 1; i <= 5; i += 1) {
      await submitAttempt({ word_id: w0.word_id, input: ans, request_id: `a1-${i}` })
    }
    const after = (await getSessionById(session.id))!
    const word = after.queue.find((w) => w.word_id === w0.word_id)!
    eq(word.status, 'COMPLETED', 'A1 连续答对达标后状态为 COMPLETED')
    eq(word.total_attempts, 3, 'A1 达到目标后不再累计尝试次数（5 次提交只计 3 次）')
    eq(word.correct_attempts, 3, 'A1 正确次数 = 目标次数')
    eq(word.consecutive_correct, 3, 'A1 会话内连对计数停在目标值')
    eq(await spellingLogs(w0.word_id), 1, 'A1 该词只产生 1 次 SRS 交接')

    /* ---- A2 错误答案 ---- */
    const w1 = after.queue[1]
    const ans1 = answerOf(w1.word_id)
    await submitAttempt({ word_id: w1.word_id, input: ans1, request_id: 'a2-correct' })
    await submitAttempt({ word_id: w1.word_id, input: 'zzzzz', request_id: 'a2-wrong' })
    const s2 = (await getSessionById(session.id))!
    const word1 = s2.queue.find((w) => w.word_id === w1.word_id)!
    eq(word1.consecutive_correct, 0, 'A2 错误答案把连对计数归零')
    eq(word1.total_attempts, 2, 'A2 错误答案计入尝试次数')
    eq(word1.wrong_attempts, 1, 'A2 错误答案计入错误次数')
    eq(word1.correct_attempts, 1, 'A2 正确次数单独累计')

    /* ---- A3 空答案 = invalid ---- */
    await submitAttempt({ word_id: w1.word_id, input: '', request_id: 'a3-empty' })
    await submitAttempt({ word_id: w1.word_id, input: '   ', request_id: 'a3-blank' })
    const s3 = (await getSessionById(session.id))!
    const word1b = s3.queue.find((w) => w.word_id === w1.word_id)!
    eq(word1b.total_attempts, 2, 'A3 空答案不增加尝试次数')
    eq(word1b.consecutive_correct, 0, 'A3 空答案不重置连对计数（先答对一次再验证）')
    await submitAttempt({ word_id: w1.word_id, input: ans1, request_id: 'a3-c' })
    const s3b = (await getSessionById(session.id))!
    const word1c = s3b.queue.find((w) => w.word_id === w1.word_id)!
    eq(word1c.consecutive_correct, 1, 'A3 空答案之后连对从 1 起算（证明没被空答案打断）')

    /* ---- A4 重复 request_id ---- */
    // 注意：processed_requests 是**会话级**映射表（不是词级）。
    // 必须分三次采样：首次用该 id 会正常入表，**重复用同一个 id** 才不许新增键。
    const before4 = (await getSessionById(session.id))!.queue.find(
      (w) => w.word_id === w1.word_id,
    )!
    const keysBefore = Object.keys((await getSessionById(session.id))!.processed_requests).length
    const r4 = await submitAttempt({
      word_id: w1.word_id,
      input: ans1,
      request_id: 'a4-dup',
    })
    const keysAfterFirstUse = Object.keys(
      (await getSessionById(session.id))!.processed_requests,
    ).length
    const r4again = await submitAttempt({
      word_id: w1.word_id,
      input: ans1,
      request_id: 'a4-dup',
    })
    const after4 = (await getSessionById(session.id))!.queue.find(
      (w) => w.word_id === w1.word_id,
    )!
    const keysAfter = Object.keys((await getSessionById(session.id))!.processed_requests).length
    eq(after4.total_attempts, before4.total_attempts + 1, 'A4 同一 request_id 只累计一次')
    eq(
      r4again.result.request_id,
      r4.result.request_id,
      'A4 重复请求回放的是原结果（同 request_id）',
    )
    eq(
      keysAfterFirstUse,
      keysBefore + 1,
      'A4 首次使用的 request_id 正常入表（证明前面的比较有意义）',
    )
    eq(keysAfter, keysAfterFirstUse, 'A4 重复 request_id 不新增 processed_requests 键')
    ok(
      keysAfter >= 8,
      'A4 会话级 processed_requests 确实累积了本组全部请求',
      `实际 ${keysAfter} 个键`,
    )
  })

  await group('B · 会话持久化与恢复', async () => {
    /* ---- B1 刷新恢复同一会话 ---- */
    await reset()
    await seedVocab()
    const { session } = await createSession({ mode: 'recent', count: 3 })
    await submitAttempt({
      word_id: session.queue[0].word_id,
      input: answerOf(session.queue[0].word_id),
      request_id: 'b1-1',
    })
    const stored = (await getSessionById(session.id))!
    const resumed = await getResumableSession()
    ok(resumed !== null && resumed.id === session.id, 'B1 重新读取恢复的是同一会话 id')
    eq(resumed!.queue.length, stored.queue.length, 'B1 队列长度一致')
    eq(resumed!.current_position, stored.current_position, 'B1 出题位置一致')
    eq(
      resumed!.queue[0].consecutive_correct,
      1,
      'B1 已作答的连对进度被持久化（不是从 0 开始）',
    )

    /* ---- B2 暂停后继续：PAUSED → IN_PROGRESS ---- */
    const paused = await pause()
    eq((await getSessionById(session.id))!.status, 'PAUSED', 'B2 暂停后库里确实是 PAUSED')
    const afterResume = await resume()
    eq(afterResume.status, 'IN_PROGRESS', 'B2 resume() 返回 IN_PROGRESS')
    eq((await getSessionById(session.id))!.status, 'IN_PROGRESS', 'B2 库里也确实变成 IN_PROGRESS')
    const r2 = await getResumableSession()
    eq(r2!.status, 'IN_PROGRESS', 'B2 恢复后仍被识别为可恢复会话')

    /* ---- B3 放弃后不会意外恢复 ---- */
    await abandon()
    const ab = (await getSessionById(session.id))!
    eq(ab.status, 'ABANDONED', 'B3 放弃后库里是 ABANDONED')
    eq(await getResumableSession(), null, 'B3 放弃后不再是可恢复会话')
    eq((await getActiveSessions()).length, 0, 'B3 放弃后不再算进行中会话')
    // 再点「继续」这类入口也不能把它救回来
    let threw = false
    try {
      await resume()
    } catch (e) {
      threw = e instanceof SpellingSessionError && e.code === 'NO_ACTIVE_SESSION'
    }
    ok(threw, 'B3 放弃后再调 resume() 报 NO_ACTIVE_SESSION，不会意外恢复')

    /* ---- B4 已完成词条不因恢复重新计数 ---- */
    await reset()
    await seedVocab()
    const { session: s4 } = await createSession({ mode: 'recent', count: 3 })
    const t = s4.queue[0]
    for (let i = 1; i <= 3; i += 1) {
      await submitAttempt({ word_id: t.word_id, input: answerOf(t.word_id), request_id: `b4-${i}` })
    }
    const doneBefore = (await getSessionById(s4.id))!.queue.find((w) => w.word_id === t.word_id)!
    await pause()
    await resume()
    // 恢复后原封不动
    const doneAfter = (await getSessionById(s4.id))!.queue.find((w) => w.word_id === t.word_id)!
    eq(doneAfter.total_attempts, doneBefore.total_attempts, 'B4 恢复后尝试次数不变')
    eq(doneAfter.correct_attempts, doneBefore.correct_attempts, 'B4 恢复后正确次数不变')
    eq(doneAfter.status, doneBefore.status, 'B4 恢复后终态不变')
    eq(doneAfter.srs_reported, doneBefore.srs_reported, 'B4 恢复后交接标记不变（不会补第二次）')
    // 再提交一次：返回 terminal，什么都不改
    const t4 = await submitAttempt({
      word_id: t.word_id,
      input: answerOf(t.word_id),
      request_id: 'b4-extra',
    })
    eq(t4.result.result, 'terminal', 'B4 对已完成词再提交返回 terminal')
    const doneAfter2 = (await getSessionById(s4.id))!.queue.find((w) => w.word_id === t.word_id)!
    eq(doneAfter2.total_attempts, doneBefore.total_attempts, 'B4 terminal 提交不改变任何计数')

    /* ---- B5 结果页重开：统计与持久化一致 ---- */
    // ⚠️ duration_ms = (ended_at ?? now) - started_at。会话未结束时它随 `now` 增长，
    //    这是**正确行为**（进行中的会话用时就该在走），所以比对必须固定时间基准，
    //    不能拿两次默认 now 的完整 JSON 直接比。
    const FIXED_NOW = 1_800_000_000_000
    const read1 = (await getSessionById(s4.id))!
    const read2 = (await getSessionById(s4.id))!
    const agg1 = aggregateSession(read1, FIXED_NOW)
    const agg2 = aggregateSession(read2, FIXED_NOW)
    ok(
      JSON.stringify(agg1) === JSON.stringify(agg2),
      'B5 固定时间基准下，两次独立读库的聚合结果完全一致',
      `completed=${agg1.completed} attempts=${agg1.total_attempts}`,
    )
    const aggDefault = aggregateSession(read2)
    ok(
      aggDefault.total_attempts === agg1.total_attempts &&
        aggDefault.correct_attempts === agg1.correct_attempts &&
        aggDefault.completed === agg1.completed &&
        aggDefault.accuracy === agg1.accuracy &&
        aggDefault.completion_rate === agg1.completion_rate,
      'B5 计数类指标不随读取时间漂移（只有 duration_ms 随 now 增长）',
    )
    const p1 = sessionProgress(read2)
    const sum = read2.queue.reduce((acc, w) => acc + w.total_attempts, 0)
    eq(agg1.total_attempts, sum, 'B5 聚合的提交次数 = 队列逐词之和（无独立汇总字段）')
    eq(p1.total, read2.queue.length, 'B5 sessionProgress 的总数 = 队列长度')

    /* ---- B6 边界 ---- */
    // B6-a 空词库
    await reset()
    let emptyPool = false
    try {
      await createSession({ mode: 'recent', count: 3 })
    } catch (e) {
      emptyPool = e instanceof SpellingSessionError && e.code === 'SESSION_CONFLICT'
    }
    ok(emptyPool, 'B6a 空词库创建会话抛 SESSION_CONFLICT')
    eq((await getAllSessions()).length, 0, 'B6a 空池不会落一份空会话占位')

    // B6-b 词条被删除 → UNAVAILABLE
    await reset()
    await seedVocab()
    const { session: s6 } = await createSession({ mode: 'recent', count: 3 })
    const gone = s6.queue[1]
    await removeFromVocab(gone.word_id)
    const { session: fixed } = await refreshAvailability()
    const g = fixed.queue.find((w) => w.word_id === gone.word_id)!
    eq(g.status, 'UNAVAILABLE', 'B6b 词条被删除后转为 UNAVAILABLE')
    eq(g.unavailable_reason, 'vocab-entry-deleted', 'B6b 记录了失效原因')
    ok(
      (await vocabOf(gone.word_id)) === null,
      'B6b 词条确实已从生词本硬删除（removeFromVocab 无墓碑）',
    )

    // B6-c 会话不存在
    eq(await getSessionById('no-such-id'), null, 'B6c 读取不存在的会话返回 null')
  })

  await group('C · SRS 交接', async () => {
    /* ---- C1 第 1、2 次答对不交接 ---- */
    await reset()
    await seedVocab()
    const { session } = await createSession({ mode: 'recent', count: 3 })
    const w = session.queue[0]
    const ans = answerOf(w.word_id)
    const v0 = await vocabOf(w.word_id)

    await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'c1-1' })
    eq(await spellingLogs(w.word_id), 0, 'C1 第 1 次答对不写 reviewLog')
    const v1 = await vocabOf(w.word_id)
    eq(v1!.consecutive_correct, v0!.consecutive_correct, 'C1 第 1 次答对不改 VocabEntry.consecutive_correct')
    eq(v1!.srs_step, v0!.srs_step, 'C1 第 1 次答对不推进 srs_step')
    eq(v1!.next_review, v0!.next_review, 'C1 第 1 次答对不推后 next_review')

    await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'c1-2' })
    eq(await spellingLogs(w.word_id), 0, 'C1 第 2 次答对仍不写 reviewLog')
    const v2 = await vocabOf(w.word_id)
    eq(v2!.consecutive_correct, v0!.consecutive_correct, 'C1 第 2 次答对仍不改 VocabEntry 连对计数')
    eq(v2!.srs_step, v0!.srs_step, 'C1 第 2 次答对仍不推进 srs_step')

    /* ---- C2 COMPLETED 后产生义务 ---- */
    const r3 = await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'c1-3' })
    eq(r3.result.result, 'correct', 'C2 第 3 次答对正确')
    eq(r3.result.word_status, 'COMPLETED', 'C2 第 3 次答对后词条 COMPLETED')
    eq(await spellingLogs(w.word_id), 1, 'C2 此时恰好产生 1 次交接')
    eq(r3.srs, 'reported', 'C2 submitAttempt 返回 srs=reported')
    const s2 = (await getSessionById(session.id))!
    const w2 = s2.queue.find((x) => x.word_id === w.word_id)!
    eq(w2.srs_reported, true, 'C2 交接后 srs_reported 置真')
    eq(pendingSrsWords(s2).length, 0, 'C2 不再有待交接词条')
    const v3 = await vocabOf(w.word_id)
    eq(v3!.consecutive_correct, v0!.consecutive_correct + 1, 'C2 VocabEntry 连对 +1（只加这一次）')
    eq(v3!.last_quiz_form, 'spelling', 'C2 记录 quiz_form=spelling')

    /* ---- C4 交接失败不得显示成功 ---- */
    await reset()
    await seedVocab()
    const { session: s4 } = await createSession({ mode: 'recent', count: 3 })
    const w4 = s4.queue[0]
    const a4 = answerOf(w4.word_id)
    await submitAttempt({ word_id: w4.word_id, input: a4, request_id: 'c4-1' })
    await submitAttempt({ word_id: w4.word_id, input: a4, request_id: 'c4-2' })
    // 让 recordQuiz 的第一步 vocab.get 失败
    const restore = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: recordQuiz 失败',
    })
    const rFail = await submitAttempt({ word_id: w4.word_id, input: a4, request_id: 'c4-3' })
    restore()
    eq(rFail.result.result, 'correct', 'C4 答案本身仍然有效（不是假失败）')
    eq(rFail.result.word_status, 'COMPLETED', 'C4 词条仍然 COMPLETED')
    ok(
      rFail.srs === 'failed' || rFail.srs === 'partial',
      'C4 交接失败时如实返回 failed/partial，绝不返回 reported',
      `实际 srs=${rFail.srs}`,
    )
    const s4b = (await getSessionById(s4.id))!
    const w4b = s4b.queue.find((x) => x.word_id === w4.word_id)!
    eq(w4b.srs_reported, false, 'C4 交接失败不落 srs_reported（下次会重试）')
    eq(await spellingLogs(w4.word_id), 0, 'C4 没有伪造任何 SRS 记录')
    eq(pendingSrsWords(s4b).length, 1, 'C4 待交接义务被保留')

    /* ---- C5 会话结束 / 放弃后仍能发现义务 ---- */
    // C5-a 自然结束（阶段 B 曾在这里永久丢积分）
    await reset()
    await seedVocab()
    const { session: s5 } = await createSession({ mode: 'recent', count: 1 })
    const w5 = s5.queue[0]
    const a5 = answerOf(w5.word_id)
    await submitAttempt({ word_id: w5.word_id, input: a5, request_id: 'c5-1' })
    await submitAttempt({ word_id: w5.word_id, input: a5, request_id: 'c5-2' })
    const restore5 = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: 最后一词交接失败',
    })
    const r5 = await submitAttempt({ word_id: w5.word_id, input: a5, request_id: 'c5-3' })
    restore5()
    eq((await getSessionById(s5.id))!.status, 'SESSION_COMPLETED', 'C5a 会话已自然结束')
    ok(r5.srs !== 'reported', 'C5a 结束时交接是失败的', `srs=${r5.srs}`)
    const repair5 = await repairSrsHandoff()
    eq(repair5.outcome, 'reported', 'C5a 结束后 repairSrsHandoff 仍能补交成功')
    eq(await spellingLogs(w5.word_id), 1, 'C5a 补交后恰好 1 条记录')
    const s5b = (await getSessionById(s5.id))!
    eq(pendingSrsWords(s5b).length, 0, 'C5a 补交后无遗留义务')

    // C5-b 放弃会话（D2 义务不随放弃消失）
    await reset()
    await seedVocab()
    const { session: s5c } = await createSession({ mode: 'recent', count: 2 })
    const w5c = s5c.queue[0]
    const a5c = answerOf(w5c.word_id)
    await submitAttempt({ word_id: w5c.word_id, input: a5c, request_id: 'c5b-1' })
    await submitAttempt({ word_id: w5c.word_id, input: a5c, request_id: 'c5b-2' })
    const restore5b = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: 放弃前交接失败',
    })
    await submitAttempt({ word_id: w5c.word_id, input: a5c, request_id: 'c5b-3' })
    restore5b()
    await abandon()
    eq((await getSessionById(s5c.id))!.status, 'ABANDONED', 'C5b 会话已放弃')
    eq(pendingSrsWords((await getSessionById(s5c.id))!).length, 1, 'C5b 放弃后义务仍在')
    const repair5b = await repairSrsHandoff()
    ok(
      repair5b.reported.includes(w5c.word_id),
      'C5b 放弃后 repairSrsHandoff 仍能补交该词',
      `outcome=${repair5b.outcome}`,
    )

    /* ---- C6 批量恢复不漏其他会话 ---- */
    await reset()
    await seedVocab()
    // ⚠️ 两份会话**会选到同一个词**（recent 模式排序确定、种子相同）—— 这是允许的，
    //    会话之间相互独立。所以断言不能按 word_id 数 reviewLog（会两份叠加），
    //    必须断言「两个会话各自的 srs_reported 都置真」。
    // 会话甲：词1 完成但交接失败
    const { session: sa } = await createSession({ mode: 'recent', count: 2 })
    const wa = sa.queue[0]
    const aa = answerOf(wa.word_id)
    await submitAttempt({ word_id: wa.word_id, input: aa, request_id: 'c6a-1' })
    await submitAttempt({ word_id: wa.word_id, input: aa, request_id: 'c6a-2' })
    const ra = inject({ table: 'vocab', method: 'get', nth: 1, message: 'x' })
    await submitAttempt({ word_id: wa.word_id, input: aa, request_id: 'c6a-3' })
    ra()
    // 让甲变成 PAUSED，腾出活跃位给乙（模拟「另一个标签页早先开的会话」）
    await pause()
    // 会话乙：词1 完成但交接失败
    const { session: sb } = await createSession({ mode: 'recent', count: 2 })
    const wb = sb.queue[0]
    const ab = answerOf(wb.word_id)
    await submitAttempt({ word_id: wb.word_id, input: ab, request_id: 'c6b-1' })
    await submitAttempt({ word_id: wb.word_id, input: ab, request_id: 'c6b-2' })
    const rb = inject({ table: 'vocab', method: 'get', nth: 1, message: 'x' })
    await submitAttempt({ word_id: wb.word_id, input: ab, request_id: 'c6b-3' })
    rb()

    const owingBefore = (await getAllSessions()).filter((s) => pendingSrsWords(s).length > 0)
    eq(owingBefore.length, 2, 'C6 库里确实有 2 份会话带未交接义务')
    const repair6 = await repairSrsHandoff()
    eq(repair6.reported.length, 2, 'C6 一次补交了 2 个待交接词（横跨两个会话）')
    eq(repair6.sessions.length, 2, 'C6 参与补交的会话数是 2')
    const saAfter = (await getSessionById(sa.id))!
    const sbAfter = (await getSessionById(sb.id))!
    eq(
      saAfter.queue.find((x) => x.word_id === wa.word_id)!.srs_reported,
      true,
      'C6 会话甲的待交接词已标记',
    )
    eq(
      sbAfter.queue.find((x) => x.word_id === wb.word_id)!.srs_reported,
      true,
      'C6 会话乙的待交接词已标记（不会被漏掉）',
    )
    const owingAfter = (await getAllSessions()).filter((s) => pendingSrsWords(s).length > 0)
    eq(owingAfter.length, 0, 'C6 补交后无任何遗留义务')
    console.log(
      `    [证据] 两会话选了同一个词（${wa.word_id === wb.word_id ? '是' : '否'}），` +
        `该词 reviewLog 现有 ${await spellingLogs(wa.word_id)} 条 = 两会话各交接一次`,
    )
  })

  await group('D · 多标签页（Node 侧：存储层真实冲突态）', async () => {
    await reset()
    await seedVocab()
    // 直接塞两份 IN_PROGRESS —— 这就是两个标签页各写一份的真实后果。
    // 注意：createSession 不传 id 时生成的是 uuid，所以「较早那份」的 id 必须从返回值取，
    // 不能写死（UI 测试里之所以能写死，是因为它显式传了 id）。
    const { session } = await createSession({ mode: 'recent', count: 3 })
    const olderId = session.id
    await storage
      .table('spellingSessions')
      .put({ ...session, id: 'tab-b', started_at: session.started_at + 1000 })

    const all = await getActiveSessions()
    eq(all.length, 2, 'D1 读取时不假定唯一：两份都暴露出来')
    eq(all[0].id, 'tab-b', 'D1 列表按开始时间倒序（新的在前）')
    ok(all[1].id === olderId, 'D1 较旧的那份排在第二位', `实际 ${all[1].id}`)

    let conflict = false
    try {
      await createSession({ mode: 'recent', count: 3 })
    } catch (e) {
      conflict = e instanceof SpellingSessionError && e.code === 'SESSION_CONFLICT'
    }
    ok(conflict, 'D2 已存在活跃会话时拒绝再建（写前检查）')

    // 复现 UI 的裁决算法：循环放弃最新的，直到选中那个变成最新
    const picked = olderId // 故意选**较旧**的那份，这样才能真的走到 abandon 分支
    for (let guard = 0; guard < 3; guard += 1) {
      const latest = await getResumableSession()
      if (!latest || latest.id === picked) break
      await abandon()
    }
    eq((await getSessionById(olderId))!.status, 'IN_PROGRESS', 'D3 选中的那份被保留')
    eq((await getSessionById('tab-b'))!.status, 'ABANDONED', 'D3 其余的被放弃')
    eq((await getActiveSessions()).length, 1, 'D3 裁决后只剩一份活跃会话')
    ok(
      currentWord((await getSessionById(olderId))!) !== null,
      'D3 保留的会话可以正常出题',
    )
  })

  await group('E · 已知限制复现固化（at-least-once，不得表述为已修复）', async () => {
    await reset()
    await seedVocab()
    const { session } = await createSession({ mode: 'recent', count: 2 })
    const w = session.queue[0]
    const ans = answerOf(w.word_id)
    await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'e-1' })
    await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'e-2' })

    // 第 3 次提交：让「标记写库」失败（spellingSessions.put 的第 2 次 = ③标记那一次）
    // 此时 recordQuiz 已经成功 —— 正是阶段 C 实测出的故障窗口
    const restore = inject({
      table: 'spellingSessions',
      method: 'put',
      nth: 2,
      message: 'injected: srs_reported 标记写库失败',
    })
    const r = await submitAttempt({ word_id: w.word_id, input: ans, request_id: 'e-3' })
    restore()

    eq(r.result.result, 'correct', 'E1 答案有效（窗口内不假报失败）')
    ok(r.srs !== 'reported', 'E1 标记写失败时如实报非成功', `srs=${r.srs}`)
    const sMid = (await getSessionById(session.id))!
    const wMid = sMid.queue.find((x) => x.word_id === w.word_id)!
    eq(wMid.srs_reported, false, 'E1 标记未落库（与库状态一致）')
    eq(await spellingLogs(w.word_id), 1, 'E1 recordQuiz 其实已经成功写过 1 条')

    // 恢复 → 补交 → 重复副作用**确实发生**。这是已知限制，不是回归失败。
    const repair = await repairSrsHandoff()
    eq(await spellingLogs(w.word_id), 2, 'E1 复现：补交后 reviewLog 变 2 条（多调度一次）')
    const v = await vocabOf(w.word_id)
    ok(
      repair.outcome === 'reported' || repair.outcome === 'partial',
      'E1 补交机制本身工作正常',
      `outcome=${repair.outcome}`,
    )
    const sEnd = (await getSessionById(session.id))!
    eq(
      sEnd.queue.find((x) => x.word_id === w.word_id)!.srs_reported,
      true,
      'E1 补交后标记最终落地（不会无限重试）',
    )
    console.log(
      '\n  ⚠️ E 组是**已知限制的可回归复现**：当前保证 = 可恢复的至少一次交接（at-least-once），',
    )
    console.log(
      '     不是恰好一次。上述「1 → 2 条」正是该限制的实测证据，禁止把本组改成期望 1 条来「修绿」。',
    )
    console.log(
      `     实测副作用：reviewLog +1 行、consecutive_correct ${v!.consecutive_correct}、srs_step ${v!.srs_step}。`,
    )
  })

  console.log('\n────────────────────────────────────────────────────────')
  if (failed === 0) {
    console.log(`✅ 阶段 E 业务验收全部通过：${passed} 项断言`)
  } else {
    console.log(`❌ 阶段 E 业务验收失败：${failed} 项失败 / ${passed} 项通过`)
    for (const f of failures) console.log(`   - ${f}`)
    process.exitCode = 1
  }
}

void main()
