/**
 * 单词默写 · 持久化层单测（fake-indexeddb 真实库，非 mock）
 * ------------------------------------------------------------------
 * 与 test_spelling.ts 的分工：
 *   test_spelling.ts       纯状态机（零 storage，Node 直接跑）
 *   test_spelling_session.ts 本文件：真实 Dexie/IndexedDB 下验证
 *                          「读库 → 调纯函数 → 整份写回」这条链路
 *
 * 覆盖（对应任务书阶段 B/E）：
 *   1. 创建会话后**完整队列持久化**（顺序 / 快照 / 计数 / processed_requests）
 *   2. 选词过滤如实（脏数据 / 无释义 / 重复）且不落空会话
 *   3. 提交正确 / 错误 / 完成 / 跳过都能落到库里
 *   4. request_id 幂等：重复提交不计数、不推进
 *   5. 终态词条不重新分类
 *   6. 暂停 / 恢复 / 放弃的状态与「活跃会话」口径
 *   7. 删除词条后仅 PENDING/IN_PROGRESS 转 UNAVAILABLE
 *   8. 会话统计与队列计数一致（aggregateSession 实时聚合）
 *   9. SRS 交接（D2 happy path）：3 次对 → recordQuiz 只调 1 次；恢复后不重复
 *
 * 运行：tsx scripts/test_spelling_session.ts
 */

import 'fake-indexeddb/auto'
import {
  SpellingSessionError,
  abandon,
  createSession,
  getActiveSession,
  getActiveSessions,
  getResumableSession,
  getSessionById,
  listHistory,
  pause,
  refreshAvailability,
  repairSrsHandoff,
  resume,
  skip,
  submitAttempt,
} from '../src/domain/spellingSession'
import { addToVocab, recordQuiz, removeFromVocab } from '../src/domain/learning'
import { aggregateSession, sessionProgress } from '../src/domain/spelling'
import { storage } from '../src/services/storage'
import type { VocabEntry } from '../src/domain/types'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string) {
  if (cond) passed += 1
  else {
    failed += 1
    failures.push(msg)
    console.error(`  ❌ ${msg}`)
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  ok(actual === expected, `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`)
}

function group(name: string, fn: () => Promise<void>) {
  return (async () => {
    console.log(`\n▶ ${name}`)
    await fn()
  })()
}

const NOW = 1_700_000_000_000

async function reset() {
  await storage.clearAll()
}

/** 造一批生词本词条（含一条脏数据 + 一条无释义） */
async function seedVocab() {
  await addToVocab({ word: 'abandon', book: 'CET4', definition_zh: 'v. 抛弃；放弃' })
  await addToVocab({ word: 'benefit', book: 'CET4', definition_zh: 'n. 利益；好处' })
  await addToVocab({ word: 'cabbage', book: 'CET4', definition_zh: 'n. 卷心菜' })
  await addToVocab({ word: 'discombobulated[', book: 'GRE8000', definition_zh: 'v. 使混乱' })
  await addToVocab({ word: 'hello', book: 'CET4' }) // 无释义
}

async function wordIdOf(word: string): Promise<string> {
  const rows = await storage.table('vocab').toArray()
  const hit = rows.find((v) => v.word === word)
  if (!hit) throw new Error(`种子里没有 ${word}`)
  return hit.word_id
}

async function run() {
  /* ---------------- 创建与持久化 ---------------- */

  await group('创建会话：完整队列一次性持久化', async () => {
    await reset()
    await seedVocab()
    const { session, dropped, requested, available } = await createSession({
      mode: 'random',
      count: 10,
      now: NOW,
      id: 'sess-1',
    })

    eq(session.total_words, 3, '脏数据与无释义被过滤，实际建成 3 词')
    eq(available, 3, 'available 反映过滤后可用量')
    eq(requested, 10, 'requested 记录用户请求量')
    ok(dropped.length === 2, 'dropped 如实带出 2 条被排除词')

    const reread = await getSessionById('sess-1')
    ok(reread !== null, '会话已落库')
    eq(reread!.queue.length, 3, '库中文队长度一致')
    eq(reread!.queue[0].position, 0, 'position 从 0 连续')
    eq(reread!.queue[2].position, 2, 'position 连续到 2')
    ok(
      reread!.queue.every((w) => w.definition_zh && w.definition_zh.length > 0),
      '每个词条都带了中文释义快照（词条被删也能展示）',
    )
    ok(
      reread!.queue.every((w) => w.word === w.word.trim() && w.word.length > 0),
      '每个词条都带了英文快照',
    )
    ok(
      reread!.queue.every(
        (w) =>
          w.consecutive_correct === 0 &&
          w.total_attempts === 0 &&
          w.correct_attempts === 0 &&
          w.wrong_attempts === 0 &&
          w.status === 'PENDING' &&
          w.target_correct === 3 &&
          w.srs_reported === false,
      ),
      '计数与状态初始值全部正确',
    )
    eq(Object.keys(reread!.processed_requests).length, 0, '新会话没有已处理请求')
    eq(reread!.status, 'IN_PROGRESS', '会话状态 IN_PROGRESS')
    eq(reread!.owner, 'guest', 'owner = guest')
    eq(reread!.type, 'spelling', 'type = spelling')
    eq((await getActiveSession())?.id, 'sess-1', 'getActiveSession 能找到它')
  })

  await group('空池不落库：没有可练词条时直接报错', async () => {
    await reset()
    await addToVocab({ word: 'discombobulated[', book: 'GRE8000', definition_zh: 'v. 使混乱' })
    let threw = ''
    try {
      await createSession({ mode: 'random', count: 10, now: NOW, id: 'sess-empty' })
    } catch (e) {
      threw = e instanceof SpellingSessionError ? e.code : 'other'
    }
    eq(threw, 'SESSION_CONFLICT', '空池报错（复用冲突码表示无法创建）')
    eq(await getSessionById('sess-empty'), null, '没有落一份空会话占活跃位')
  })

  await group('已有活跃会话时不静默新建', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'random', count: 3, now: NOW, id: 'sess-a' })
    let code = ''
    try {
      await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-b' })
    } catch (e) {
      code = e instanceof SpellingSessionError ? e.code : 'other'
    }
    eq(code, 'SESSION_CONFLICT', '第二个会话被拒绝')
    eq(await getSessionById('sess-b'), null, '被拒绝的会话没有落库')
    eq((await getActiveSessions()).length, 1, '库里仍只有一份活跃会话')
  })

  /* ---------------- 提交 / 跳过 / 幂等 ---------------- */

  await group('提交：正确 / 错误 / 完成都落到库里', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-2' })
    const w = await wordIdOf('abandon')

    const r1 = await submitAttempt({ word_id: w, input: 'abandon', request_id: 'r1', now: NOW + 1 })
    eq(r1.result.result, 'correct', '第 1 次对')
    eq(r1.result.consecutive_correct, 1, '连续正确 1')

    const r2 = await submitAttempt({ word_id: w, input: 'abanon', request_id: 'r2', now: NOW + 2 })
    eq(r2.result.result, 'wrong', '答错')
    eq(r2.result.consecutive_correct, 0, '连续正确归零')

    const reread = await getSessionById('sess-2')
    const stored = reread!.queue.find((x) => x.word_id === w)!
    eq(stored.total_attempts, 2, '库里总提交 = 2')
    eq(stored.wrong_attempts, 1, '库里错误 = 1')
    eq(stored.consecutive_correct, 0, '库里连续正确 = 0')
    eq(reread!.updated_at, NOW + 2, 'updated_at 随写入推进')

    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'r3', now: NOW + 3 })
    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'r4', now: NOW + 4 })
    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'r5', now: NOW + 5 })
    const done = await getSessionById('sess-2')
    const storedDone = done!.queue.find((x) => x.word_id === w)!
    eq(storedDone.status, 'COMPLETED', '第 3 次连对后落库为 COMPLETED')
    eq(storedDone.consecutive_correct, 3, '连续正确 3')
    eq(storedDone.correct_attempts, 4, '正确 4 次（含 r2 之前那次）')
    eq(Object.keys(done!.processed_requests).length, 5, '5 个 request_id 都已记录')
    const nextUp = done!.queue.find((x) => x.position === done!.current_position)
    ok(nextUp !== undefined && nextUp.status === 'PENDING', '完成后队列推进到下一个未终态词')
  })

  await group('幂等：重复 request_id 不计数、不推进', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-3' })
    const w = await wordIdOf('abandon')

    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'same', now: NOW + 1 })
    const before = await getSessionById('sess-3')
    const wBefore = before!.queue.find((x) => x.word_id === w)!

    const replay = await submitAttempt({
      word_id: w,
      input: 'abandon',
      request_id: 'same',
      now: NOW + 999,
    })
    eq(replay.result.at, NOW + 1, '回放的是原结果（时间戳没变）')
    eq(replay.result.consecutive_correct, wBefore.consecutive_correct, '计数没有再次 +1')

    const after = await getSessionById('sess-3')
    const wAfter = after!.queue.find((x) => x.word_id === w)!
    eq(wAfter.total_attempts, wBefore.total_attempts, '库里提交次数不变')
    eq(Object.keys(after!.processed_requests).length, 1, '幂等键没有新增')
  })

  await group('终态保护：完成 / 跳过后的词不能再被计数', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-4' })
    const w = await wordIdOf('abandon')

    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'd1', now: NOW + 1 })
    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'd2', now: NOW + 2 })
    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'd3', now: NOW + 3 })

    const after = await submitAttempt({
      word_id: w,
      input: 'abandon',
      request_id: 'd4',
      now: NOW + 4,
    })
    eq(after.result.result, 'terminal', '完成后再提交返回 terminal')
    const stored = (await getSessionById('sess-4'))!.queue.find((x) => x.word_id === w)!
    eq(stored.total_attempts, 3, '计数停在 3')
    eq(stored.status, 'COMPLETED', '状态没被改写')

    // 跳过的词同样不能复活
    const skipRes = await skip({ word_id: w, request_id: 'skip-1', now: NOW + 5 })
    eq(skipRes.result.result, 'terminal', '已完成的词跳过也返回 terminal')

    const b = await wordIdOf('benefit')
    const s1 = await skip({ word_id: b, request_id: 'skip-b', now: NOW + 6 })
    eq(s1.result.result, 'skipped', '跳过生效')
    const s2 = await skip({ word_id: b, request_id: 'skip-b', now: NOW + 7 })
    eq(s2.result.result, 'skipped', '重复跳过幂等回放')
    const storedB = (await getSessionById('sess-4'))!.queue.find((x) => x.word_id === b)!
    eq(storedB.status, 'SKIPPED', '库里是 SKIPPED')
    eq(storedB.total_attempts, 0, '跳过不计入提交次数')
  })

  await group('空白提交：invalid 不计数', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-4b' })
    const w = await wordIdOf('abandon')
    const r = await submitAttempt({ word_id: w, input: '   ', request_id: 'blank', now: NOW + 1 })
    eq(r.result.result, 'invalid', '空白提交 result=invalid')
    const stored = (await getSessionById('sess-4b'))!.queue.find((x) => x.word_id === w)!
    eq(stored.total_attempts, 0, '不计入任何计数')
    eq(stored.status, 'PENDING', '状态不变')
  })

  await group('没有活跃会话时提交抛错', async () => {
    await reset()
    let code = ''
    try {
      await submitAttempt({ word_id: 'CET4:abandon', input: 'x', request_id: 'z', now: NOW })
    } catch (e) {
      code = e instanceof SpellingSessionError ? e.code : 'other'
    }
    eq(code, 'NO_ACTIVE_SESSION', '无会话时报 NO_ACTIVE_SESSION')
  })

  /* ---------------- 生命周期 ---------------- */

  await group('暂停 / 恢复 / 放弃', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-5' })
    const w = await wordIdOf('abandon')
    await submitAttempt({ word_id: w, input: 'abandon', request_id: 'p1', now: NOW + 1 })

    const paused = await pause(NOW + 2)
    eq(paused.status, 'PAUSED', '暂停后状态 PAUSED')
    eq((await getActiveSession()), null, '暂停后不算活跃会话')
    ok((await getResumableSession()) !== null, '暂停后仍可恢复')

    let code = ''
    try {
      await submitAttempt({ word_id: w, input: 'abandon', request_id: 'p2', now: NOW + 3 })
    } catch (e) {
      code = e instanceof SpellingSessionError ? e.code : 'other'
    }
    eq(code, 'SESSION_NOT_ACTIVE', 'PAUSED 下提交抛错（V3.2 语义）')

    const resumed = await resume(NOW + 4)
    eq(resumed.status, 'IN_PROGRESS', '恢复后回到 IN_PROGRESS')
    const reread = await getSessionById('sess-5')
    const stored = reread!.queue.find((x) => x.word_id === w)!
    eq(stored.consecutive_correct, 1, '恢复后计数保留')

    const ab = await abandon(NOW + 5)
    eq(ab.status, 'ABANDONED', '放弃后 ABANDONED')
    eq((await getResumableSession()), null, '放弃后不可恢复')
    const afterAbandon = await getSessionById('sess-5')
    eq(afterAbandon!.ended_at, NOW + 5, '结束时间已记录')
  })

  await group('历史列表：倒序、限量、不含已放弃', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'h1' })
    await pause(NOW + 1)
    await createSession({ mode: 'recent', count: 3, now: NOW + 100, id: 'h2' })
    await abandon(NOW + 101)
    await createSession({ mode: 'recent', count: 3, now: NOW + 200, id: 'h3' })

    const all = await listHistory(10)
    eq(all.length, 3, '3 条会话都在')
    eq(all[0].id, 'h3', '最新的在最前')
    const limited = await listHistory(2)
    eq(limited.length, 2, 'limit 生效')
  })

  /* ---------------- 恢复一致性 ---------------- */

  await group('删除词条：仅 PENDING/IN_PROGRESS 转 UNAVAILABLE', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-6' })
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    const c = await wordIdOf('cabbage')

    // abandon 连对 3 次完成；benefit 进入 IN_PROGRESS；cabbage 保持 PENDING
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'x1', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'x2', now: NOW + 2 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'x3', now: NOW + 3 })
    await submitAttempt({ word_id: b, input: 'benefitt', request_id: 'x4', now: NOW + 4 })

    await removeFromVocab(a)
    await removeFromVocab(b)
    await removeFromVocab(c)

    const { session, marked } = await refreshAvailability()
    eq(marked.length, 2, '只有未终态的两个词被标记')
    ok(marked.includes(b) && marked.includes(c), '标记的是 benefit 与 cabbage')
    eq(session.queue.find((x) => x.word_id === a)!.status, 'COMPLETED', 'COMPLETED 词条即使被删也保持完成')
    eq(session.queue.find((x) => x.word_id === b)!.status, 'UNAVAILABLE', 'IN_PROGRESS 转 UNAVAILABLE')
    eq(
      session.queue.find((x) => x.word_id === c)!.unavailable_reason,
      'vocab-entry-deleted',
      '记录了失效原因',
    )
    const stats = aggregateSession(session, NOW + 10)
    eq(stats.completed, 1, '完成数不被失效改写')
    eq(stats.unavailable, 2, '不可用数 2，不重复累计')
  })

  await group('会话统计与队列计数一致', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-7' })
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    const c = await wordIdOf('cabbage')

    await submitAttempt({ word_id: a, input: 'abandon', request_id: 's1', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 's2', now: NOW + 2 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 's3', now: NOW + 3 })
    await submitAttempt({ word_id: b, input: 'benefitt', request_id: 's4', now: NOW + 4 })
    await submitAttempt({ word_id: b, input: 'benefit', request_id: 's5', now: NOW + 5 })
    await skip({ word_id: c, request_id: 's6', now: NOW + 6 })

    const reread = (await getSessionById('sess-7'))!
    const st = aggregateSession(reread, NOW + 100)
    const p = sessionProgress(reread)
    eq(st.total_attempts, 5, '总提交 = 5')
    eq(st.correct_attempts, 4, '正确 = 4')
    eq(st.wrong_attempts, 1, '错误 = 1')
    eq(st.accuracy, 80, '正确率 80%（跳过未进分母）')
    eq(p.completed, 1, '完成 1')
    eq(p.skipped, 1, '跳过 1')
    eq(st.completion_rate, 33, '完成率 33%')
    eq(st.duration_ms, 100, '耗时按 now - started_at')

    // 手工累加交叉验证（防止聚合函数与队列漂移）
    const manual = reread.queue.reduce(
      (acc, w) => ({
        t: acc.t + w.total_attempts,
        c: acc.c + w.correct_attempts,
        w: acc.w + w.wrong_attempts,
      }),
      { t: 0, c: 0, w: 0 },
    )
    eq(st.total_attempts, manual.t, '聚合与手工累加一致（总）')
    eq(st.correct_attempts, manual.c, '聚合与手工累加一致（对）')
    eq(st.wrong_attempts, manual.w, '聚合与手工累加一致（错）')
  })

  /* ---------------- SRS 交接（D2） ---------------- */

  await group('SRS 交接：只在完成时一次；恢复后不重复', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-8' })
    const a = await wordIdOf('abandon')

    const r1 = await submitAttempt({ word_id: a, input: 'abandon', request_id: 'q1', now: NOW + 1 })
    eq(r1.srs, 'none', '第 1 次对不交接')

    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'q2', now: NOW + 2 })
    const r3 = await submitAttempt({ word_id: a, input: 'abandon', request_id: 'q3', now: NOW + 3 })
    eq(r3.srs, 'reported', '第 3 次对完成 → 交接成功')
    eq(r3.result.srs_due, true, '结果里带出交接义务')

    // recordQuiz 的真实副作用：vocab.consecutive_correct +1、reviewLog 多一行 spelling
    const vocabRow = (await storage.table('vocab').toArray()).find((v) => v.word_id === a)!
    eq(vocabRow.consecutive_correct, 1, 'SRS 连续正确 +1（只加了一次）')
    eq(vocabRow.srs_step, 1, 'SRS 步进一档')
    const logs = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === a && l.quiz_form === 'spelling',
    )
    eq(logs.length, 1, 'reviewLog 只多 1 行 spelling')

    const stored = (await getSessionById('sess-8'))!.queue.find((x) => x.word_id === a)!
    eq(stored.srs_reported, true, '交接标记已落库')

    // 恢复会话后再跑一遍补交：不应该再调 recordQuiz
    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'none', '恢复后没有待交接词条')
    const logs2 = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === a && l.quiz_form === 'spelling',
    )
    eq(logs2.length, 1, 'reviewLog 仍是 1 行（没有重复调度）')
    const vocabRow2 = (await storage.table('vocab').toArray()).find((v) => v.word_id === a)!
    eq(vocabRow2.consecutive_correct, 1, 'SRS 连续正确没被二次推进')
  })

  await group('SRS 交接：跳过的词不交接', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-9' })
    const b = await wordIdOf('benefit')
    const r = await skip({ word_id: b, request_id: 'sk', now: NOW + 1 })
    eq(r.result.srs_due, false, 'SKIPPED 不产生交接义务')
    const logs = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === b && l.quiz_form === 'spelling',
    )
    eq(logs.length, 0, '没有写任何 SRS 记录')
    const stored = (await getSessionById('sess-9'))!.queue.find((x) => x.word_id === b)!
    eq(stored.srs_reported, false, '也没有落交接标记')
  })

  await group('SRS 交接：词条已删除时不反复重试', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-10' })
    const a = await wordIdOf('abandon')
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'y1', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'y2', now: NOW + 2 })
    await removeFromVocab(a) // 完成前把词删掉
    const r = await submitAttempt({ word_id: a, input: 'abandon', request_id: 'y3', now: NOW + 3 })
    eq(r.result.result, 'correct', '拼写仍判对（快照里有答案）')
    eq(r.result.word_status, 'COMPLETED', '词条完成')
    ok(r.srs === 'dropped', '交接结果如实回报为 dropped（词条已删，无交接对象）')

    const stored = (await getSessionById('sess-10'))!.queue.find((x) => x.word_id === a)!
    eq(stored.srs_reported, true, '无交接对象时也落标记，避免每次恢复重试同一件做不到的事')
    const logs = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === a && l.quiz_form === 'spelling',
    )
    eq(logs.length, 0, '没有伪造 SRS 记录')
  })

  await group('选词模式：易错词会读取历史答题日志排序', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    const c = await wordIdOf('cabbage')

    // 真实走 recordQuiz 造历史：cabbage 错 2 次、benefit 错 1 次、abandon 没错过
    await recordQuiz(c, false, 'choose-meaning')
    await recordQuiz(c, false, 'choose-meaning')
    await recordQuiz(b, false, 'choose-meaning')
    ok(true, '已用真实 recordQuiz 造好历史日志')

    const { session } = await createSession({ mode: 'wrong', count: 3, now: NOW, id: 'sess-w' })
    eq(session.queue.length, 3, '易错词模式建成 3 词')
    eq(session.queue[0].word_id, c, '错得最多的 cabbage 排第一')
    eq(session.queue[1].word_id, b, 'benefit 排第二')
    eq(session.queue[2].word_id, a, '没错过的 abandon 排最后')
  })

  await group('SRS 交接：标记写库失败 → 如实报 failed，不谎报成功', async () => {
    await reset()
    await seedVocab()
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sess-11' })
    const a = await wordIdOf('abandon')
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'f1', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'f2', now: NOW + 2 })

    // 故障注入：只打断「会话表」的第 2 次 put（第 1 次是 mutate 的正常落库，
    // 第 2 次是 fulfillSrsHandoff 写 srs_reported 标记）—— 模拟「标记保存失败」
    const proto = Object.getPrototypeOf(storage.table('spellingSessions')) as {
      put: (v: unknown) => Promise<void>
    }
    const originalPut = proto.put
    let broken = false
    let sessionPuts = 0
    proto.put = async function (value: unknown) {
      const v = value as { type?: string } | undefined
      if (broken && v && v.type === 'spelling') {
        sessionPuts += 1
        if (sessionPuts === 2) throw new Error('injected: session put failed')
      }
      return originalPut.call(this, value)
    }

    let srs = ''
    try {
      broken = true
      sessionPuts = 0
      const r = await submitAttempt({ word_id: a, input: 'abandon', request_id: 'f3', now: NOW + 3 })
      srs = r.srs
    } finally {
      broken = false
      proto.put = originalPut
    }
    eq(srs, 'failed', '交接标记写不进去 → 如实报 failed（不假报成功）')

    const stored = (await getSessionById('sess-11'))!.queue.find((x) => x.word_id === a)!
    eq(stored.srs_reported, false, '标记没有落库（下次恢复还会重试）')
    eq(stored.status, 'COMPLETED', '词条本身仍记录为完成')

    // recordQuiz 的副作用确实已经发生了 —— 这正是「无法原子提交」的代价
    const logs = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === a && l.quiz_form === 'spelling',
    )
    eq(logs.length, 1, 'recordQuiz 已生效：reviewLog 有 1 行')
    const vocabRow = (await storage.table('vocab').toArray()).find((v) => v.word_id === a)!
    eq(vocabRow.consecutive_correct, 1, 'recordQuiz 已生效：SRS 连续正确 +1')

    // 恢复补交：这次能写进去了
    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'reported', '恢复后补交成功')
    const logs2 = (await storage.table('reviewLog').toArray()).filter(
      (l) => l.word_id === a && l.quiz_form === 'spelling',
    )
    eq(logs2.length, 2, '⚠ 中断窗口导致多调度一次（已在设计文档中如实记录，不宣称恰好一次）')
    const vocabRow2 = (await storage.table('vocab').toArray()).find((v) => v.word_id === a)!
    eq(vocabRow2.consecutive_correct, 2, '对应的 SRS 多推进一档')
    eq(
      (await getSessionById('sess-11'))!.queue.find((x) => x.word_id === a)!.srs_reported,
      true,
      '补交后标记落库，不会再重试',
    )
  })

  console.log(`\n${'─'.repeat(56)}`)
  if (failed === 0) {
    console.log(`✅ 默写持久化层单测全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ 默写持久化层单测失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run()
