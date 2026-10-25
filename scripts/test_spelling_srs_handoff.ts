/**
 * 单词默写 · SRS 交接与故障恢复测试（阶段 C）
 * ------------------------------------------------------------------
 * 目标：把「交接到底在什么时机发生、故障窗口有多宽、恢复后实际副作用是什么」
 * 全部变成可回归的断言，**不把风险尚存的实现标记成恰好一次**。
 *
 * 与另外两套的分工：
 *   test_spelling.ts          纯状态机（零 storage）
 *   test_spelling_session.ts  持久化层 happy path（fake-indexeddb）
 *   本文件                    故障注入：C1~C4 四类中断 + 真实调用时序 + 重复交接复现
 *
 * 故障注入手法（重要，说明为什么这样注入）：
 *   `storage.table()` 每次 `new DexieTableService(...)`，所以打对象实例没用，
 *   必须打 `DexieTableService.prototype` 上的方法。本文件用 `this.name`（运行时可见）
 *   区分表名，实现「只让某张表的某一次写失败」，而不是笼统地让函数抛错。
 *   注入点全部落在**真实的 IndexedDB 读写调用**上（get/put/add），
 *   不是 mock 业务函数 —— 否则测不到「写库失败」与「业务异常」的区别。
 *
 * 运行：tsx scripts/test_spelling_srs_handoff.ts
 */

import 'fake-indexeddb/auto'
import {
  abandon,
  createSession,
  getAllSessions,
  getResumableSession,
  getSessionById,
  handoffOutcome,
  pause,
  repairSrsHandoff,
  resume,
  submitAttempt,
} from '../src/domain/spellingSession'
import { addToVocab, recordQuiz } from '../src/domain/learning'
import { pendingSrsWords } from '../src/domain/spelling'
import { storage } from '../src/services/storage'

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

/* ------------------------------------------------------------------
 * 存储层原型：调用记录 + 定点故障注入
 * ------------------------------------------------------------------ */

type Proto = Record<string, (this: { name: string }, ...args: unknown[]) => Promise<unknown>>
const proto = Object.getPrototypeOf(storage.table('spellingSessions')) as unknown as Proto

interface Call {
  table: string
  method: string
  detail: string
}

let recording = false
let calls: Call[] = []

/** 包装全部读写方法，记录「表名 + 方法 + 关键参数」。装在原型上，对所有实例生效 */
function installRecorder(): void {
  const methods = [
    'get',
    'put',
    'add',
    'delete',
    'bulkGet',
    'bulkPut',
    'whereIndex',
    'toArray',
    'count',
  ]
  for (const m of methods) {
    const original = proto[m]
    proto[m] = async function (this: { name: string }, ...args: unknown[]) {
      if (recording) calls.push({ table: this.name, method: m, detail: describe(m, args) })
      return original.apply(this, args)
    }
  }
}

function describe(method: string, args: unknown[]): string {
  const v = args[0] as Record<string, unknown> | undefined
  if (method === 'put') return `id=${String(v?.id ?? v?.word_id ?? '?')} type=${String(v?.type ?? v?.quiz_form ?? '?')}`
  if (method === 'add') return `quiz_form=${String(v?.quiz_form ?? '?')}`
  if (method === 'get') return `key=${String(args[0])}`
  if (method === 'whereIndex') return `${String(args[0])}=${String(args[1])}`
  return ''
}

/**
 * 只让「某张表的第 N 次指定方法」抛错。N 从注入安装时开始计数。
 * `when` 可进一步限定参数（例如只拦某个 word_id 的 vocab.get）。
 */
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

/* ------------------------------------------------------------------
 * 观测辅助
 * ------------------------------------------------------------------ */

interface SrsSnap {
  cc: number
  step: number
  next: number
  layer: string
  mastered: number | undefined
  wrongPool: boolean
  lastForm: string | undefined
}

async function snap(wordId: string): Promise<SrsSnap> {
  const v = (await storage.table('vocab').toArray()).find((x) => x.word_id === wordId)
  if (!v) throw new Error(`vocab 里没有 ${wordId}`)
  return {
    cc: v.consecutive_correct,
    step: v.srs_step,
    next: v.next_review,
    layer: v.layer,
    mastered: v.mastered_at,
    wrongPool: v.in_wrong_pool,
    lastForm: v.last_quiz_form,
  }
}

async function spellingLogs(wordId: string): Promise<number> {
  const rows = (await storage.table('reviewLog').toArray()).filter(
    (l) => l.word_id === wordId && l.quiz_form === 'spelling',
  )
  return rows.length
}

async function reset(): Promise<void> {
  await storage.clearAll()
}

/**
 * word_id → 英文原词的缓存。
 * 存在的意义：测试助手不能再调 `vocab.get()` 去取答案，否则会和
 * `recordQuiz` 内部的 `vocab.get` 撞在同一个注入点上，让故障注入失去精度。
 */
let WORDS: Record<string, string> = {}

async function seedVocab(): Promise<void> {
  await addToVocab({ word: 'abandon', book: 'CET4', definition_zh: 'v. 抛弃；放弃' })
  await addToVocab({ word: 'benefit', book: 'CET4', definition_zh: 'n. 利益；好处' })
  await addToVocab({ word: 'cabbage', book: 'CET4', definition_zh: 'n. 卷心菜' })
  WORDS = {}
  for (const v of await storage.table('vocab').toArray()) WORDS[v.word_id] = v.word
}

async function wordIdOf(word: string): Promise<string> {
  const rows = await storage.table('vocab').toArray()
  const hit = rows.find((v) => v.word === word)
  if (!hit) throw new Error(`种子里没有 ${word}`)
  return hit.word_id
}

/** 连对 3 次完成一个词 */
async function completeWord(wordId: string, prefix: string): Promise<void> {
  await completeWordAndGetResult(wordId, prefix)
}

/** 同上，但返回最后一次提交的结果（便于断言交接 outcome） */
async function completeWordAndGetResult(wordId: string, prefix: string) {
  const word = WORDS[wordId]
  if (!word) throw new Error(`WORDS 缓存里没有 ${wordId}（seedVocab 没跑？）`)
  let last
  for (let i = 1; i <= 3; i += 1) {
    last = await submitAttempt({ word_id: wordId, input: word, request_id: `${prefix}-${i}`, now: NOW + i })
  }
  return last!
}

/* ------------------------------------------------------------------
 * 测试
 * ------------------------------------------------------------------ */

async function run() {
  installRecorder()

  /* ---------- 0. 真实调用时序（故障窗口的实证，不是推测） ---------- */

  await group('调用时序实测：交接到底发生在哪两步之间', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'seq-1' })

    // 第 1、2 次答对：不应有任何 SRS 副作用
    recording = true
    calls = []
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'sq1', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'sq2', now: NOW + 2 })
    const mid = calls.map((c) => `${c.table}.${c.method}`)
    recording = false
    eq(await spellingLogs(a), 0, '未完成的词不写 reviewLog')
    ok(
      !mid.some((c) => c === 'reviewLog.add'),
      '未完成时整条链路没有 reviewLog.add',
    )
    ok(
      !mid.some((c) => c === 'vocab.put'),
      '未完成时整条链路没有 vocab.put（recordQuiz 未被调用）',
    )

    // 第 3 次答对：触发交接
    recording = true
    calls = []
    const r = await submitAttempt({ word_id: a, input: 'abandon', request_id: 'sq3', now: NOW + 3 })
    const seq = calls.map((c) => `${c.table}.${c.method}${c.detail ? `(${c.detail})` : ''}`)
    recording = false

    eq(r.srs, 'reported', '第 3 次对 → 交接成功')

    const putIdx = seq.findIndex((c) => c.startsWith('spellingSessions.put'))
    const addIdx = seq.findIndex((c) => c.startsWith('reviewLog.add'))
    const vocabPutIdx = seq.findIndex((c) => c.startsWith('vocab.put'))
    const putIdx2 = seq.findIndex(
      (c, i) => c.startsWith('spellingSessions.put') && i > putIdx,
    )
    ok(putIdx >= 0 && addIdx > putIdx, '① 会话 put（计数/状态）先于 reviewLog.add —— 窗口前边界')
    ok(addIdx >= 0 && vocabPutIdx > addIdx, '② reviewLog.add 先于 vocab.put（recordQuiz 内部顺序）')
    ok(putIdx2 > vocabPutIdx, '③ 第二次会话 put（落 srs_reported 标记）在最后 —— 窗口后边界')
    ok(putIdx2 > putIdx, '确认有两次会话 put：一次写计数、一次写标记')

    console.log('    实测时序：')
    seq.forEach((c, i) => console.log(`      ${i + 1}. ${c}`))
    console.log('    ⇒ 故障窗口 = ① 与 ③ 之间：recordQuiz 的 reviewLog.add + vocab.put 已生效，')
    console.log('       而 srs_reported 标记尚未落库。窗口内中断 ⇒ 恢复后重复交接。')
  })

  /* ---------- C1：词条完成已持久化、recordQuiz 前中断 ---------- */

  await group('C1：词条完成已持久化，recordQuiz 之前中断', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'c1-1' })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c1a', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c1b', now: NOW + 2 })

    const before = await snap(a)

    // 注入点：vocab.get —— recordQuiz 的第一个操作。让它抛错，
    // 等价于「进程在 recordQuiz 之前死掉」：词条已完成并落库，SRS 一行未写。
    const restore = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: 进程在 recordQuiz 之前中断',
    })
    let srs = ''
    try {
      const r = await submitAttempt({
        word_id: a,
        input: 'abandon',
        request_id: 'c1c',
        now: NOW + 3,
      })
      srs = r.srs
    } finally {
      restore()
    }

    eq(srs, 'failed', '交接未执行 → outcome=failed（不谎报成功）')
    const stored = (await getSessionById('c1-1'))!.queue.find((x) => x.word_id === a)!
    eq(stored.status, 'COMPLETED', '词条保持 COMPLETED')
    eq(stored.srs_reported, false, 'srs_reported 保持 false')
    eq(await spellingLogs(a), 0, 'reviewLog 一行未写')
    const after = await snap(a)
    eq(after.cc, before.cc, 'consecutive_correct 未变')
    eq(after.step, before.step, 'srs_step 未变')
    eq(after.next, before.next, 'next_review 未变')
    eq(after.layer, before.layer, 'layer 未变')
    eq(after.mastered, before.mastered, 'mastered_at 未变')

    // 恢复：pendingSrsWords 必须能重新发现这个义务
    const session = (await getSessionById('c1-1'))!
    eq(pendingSrsWords(session).length, 1, '恢复后 pendingSrsWords 重新发现该交接义务')

    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'reported', '补交成功')
    eq(await spellingLogs(a), 1, '补交后 reviewLog 恰好 1 行')
    const fixed = await snap(a)
    eq(fixed.cc, before.cc + 1, 'consecutive_correct 补上 +1')
    eq(fixed.step, before.step + 1, 'srs_step 前进一档')
    ok(fixed.next > before.next, 'next_review 推后')
    eq(fixed.lastForm, 'spelling', 'last_quiz_form = spelling')
    eq(
      (await getSessionById('c1-1'))!.queue.find((x) => x.word_id === a)!.srs_reported,
      true,
      '补交后标记落库',
    )

    // 再补交一次：不应重复调度
    const again = await repairSrsHandoff()
    eq(again.outcome, 'none', '二次补交无待交接词条')
    eq(await spellingLogs(a), 1, 'reviewLog 仍是 1 行（不重复调度）')
  })

  /* ---------- C2：recordQuiz 成功后、标记保存前中断 ---------- */

  await group('C2：recordQuiz 成功后、保存 srs_reported 前中断（已复现的重复交接风险）', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'c2-1' })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c2a', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c2b', now: NOW + 2 })

    const before = await snap(a)

    // 注入点：spellingSessions 的第 2 次 put。
    // 第 1 次 = mutate 写计数/状态（必须成功，否则测不到窗口）；
    // 第 2 次 = fulfillSrsHandoff 写 srs_reported 标记 —— 让它失败。
    const restore = inject({
      table: 'spellingSessions',
      method: 'put',
      nth: 2,
      message: 'injected: 标记保存失败（模拟进程在 recordQuiz 之后、标记之前中断）',
    })
    let srs = ''
    try {
      const r = await submitAttempt({
        word_id: a,
        input: 'abandon',
        request_id: 'c2c',
        now: NOW + 3,
      })
      srs = r.srs
    } finally {
      restore()
    }

    eq(srs, 'failed', '如实报 failed（不把已发生但未落标记的交接说成成功）')
    const stored = (await getSessionById('c2-1'))!.queue.find((x) => x.word_id === a)!
    eq(stored.status, 'COMPLETED', '词条仍为 COMPLETED')
    eq(stored.srs_reported, false, '标记没落库')

    // recordQuiz 的副作用**已经发生了** —— 这就是窗口的代价
    eq(await spellingLogs(a), 1, 'reviewLog 已有 1 行（recordQuiz 已生效）')
    const mid = await snap(a)
    eq(mid.cc, before.cc + 1, 'consecutive_correct 已 +1')
    eq(mid.step, before.step + 1, 'srs_step 已前进一档')
    ok(mid.next > before.next, 'next_review 已推后')

    // 恢复补交：重复调度 —— 必须如实记录为「已复现的重复交接风险」
    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'reported', '补交自身成功')
    eq(await spellingLogs(a), 2, '⚠ reviewLog 变成 2 行 —— 重复交接已复现')
    const after = await snap(a)
    eq(after.cc, before.cc + 2, '⚠ consecutive_correct 多推进 1（应为 +1）')
    eq(after.step, before.step + 2, '⚠ srs_step 多进一档（应为 +1）')
    ok(after.next > mid.next, '⚠ next_review 再次推后')
    eq(
      (await getSessionById('c2-1'))!.queue.find((x) => x.word_id === a)!.srs_reported,
      true,
      '补交后标记落库，之后不再重试',
    )
  })

  await group('C2b：重复交接在最坏情况下会连跳两级（new→apply→mastered）', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    // 先把该词推到 consecutive_correct = 4（PASS_THRESHOLD-1）
    for (let i = 0; i < 4; i += 1) await recordQuiz(a, true, 'choose-meaning')
    const seeded = await snap(a)
    eq(seeded.cc, 4, '前置条件：consecutive_correct = 4')
    eq(seeded.layer, 'new', '前置条件：layer = new')

    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'c2b-1' })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c2ba', now: NOW + 1 })
    await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c2bb', now: NOW + 2 })

    const restore = inject({
      table: 'spellingSessions',
      method: 'put',
      nth: 2,
      message: 'injected: 标记保存失败',
    })
    try {
      await submitAttempt({ word_id: a, input: 'abandon', request_id: 'c2bc', now: NOW + 3 })
    } finally {
      restore()
    }

    const afterFirst = await snap(a)
    eq(afterFirst.cc, 5, '第一次交接：4→5，跨过晋级线')
    eq(afterFirst.layer, 'apply', '第一次交接：new → apply（正常）')
    eq(afterFirst.mastered, undefined, '此时还没 mastered')

    await repairSrsHandoff()
    const afterDup = await snap(a)
    eq(afterDup.cc, 6, '重复交接：5→6')
    eq(afterDup.layer, 'mastered', '⚠ 重复交接导致 apply → mastered，直接跳到已掌握')
    ok(afterDup.mastered !== undefined, '⚠ 并写下 mastered_at')
    console.log('    ⇒ 一次崩溃窗口可以让一个词跳过「应用层」直接进「已掌握」。')
  })

  /* ---------- C3：markSrsReported 写入失败 ---------- */

  await group('C3：SRS 已更新，但标记写入失败（与 C2 同一窗口，不同触发路径）', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'c3-1' })

    // 先制造一个「待补交」的词：3 次答对让它完成，但 recordQuiz 全程失败
    const blockRecord = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: recordQuiz 失败',
      when: (args) => args[0] === a,
    })
    try {
      for (let i = 1; i <= 3; i += 1) {
        await submitAttempt({ word_id: a, input: 'abandon', request_id: `c3-${i}`, now: NOW + i })
      }
    } finally {
      blockRecord()
    }
    const preRepair = await snap(a)
    eq(await spellingLogs(a), 0, '此时 SRS 一行未写')
    eq(
      (await getSessionById('c3-1'))!.queue.find((x) => x.word_id === a)!.status,
      'COMPLETED',
      '词条已完成',
    )
    eq(
      (await getSessionById('c3-1'))!.queue.find((x) => x.word_id === a)!.srs_reported,
      false,
      '但未标记',
    )

    // 恢复补交：让**标记写入**失败（repair 路径上第 1 次 session put 就是标记 put）
    const breakMark = inject({
      table: 'spellingSessions',
      method: 'put',
      nth: 1,
      message: 'injected: markSrsReported 写入失败',
    })
    let repair
    try {
      repair = await repairSrsHandoff()
    } finally {
      breakMark()
    }

    eq(repair.outcome, 'failed', '补交报 failed，不返回虚假成功')
    eq(repair.lost.length, 1, '该词进入 lost（下次仍会重试）')
    eq(repair.reported.length, 0, '不计入 reported')
    eq(await spellingLogs(a), 1, '⚠ recordQuiz 已生效：reviewLog 有 1 行')
    const postRepair = await snap(a)
    eq(postRepair.cc, preRepair.cc + 1, '⚠ consecutive_correct 已 +1')
    eq(
      (await getSessionById('c3-1'))!.queue.find((x) => x.word_id === a)!.srs_reported,
      false,
      '标记仍未落库 —— 与返回值一致，没有假报',
    )

    // 重试：明确记录「重试会导致重复 SRS 副作用」
    const retry = await repairSrsHandoff()
    eq(retry.outcome, 'reported', '重试成功')
    eq(await spellingLogs(a), 2, '⚠ 重试导致 reviewLog 变 2 行 —— 重复副作用')
    eq((await snap(a)).cc, preRepair.cc + 2, '⚠ consecutive_correct 累计 +2（应为 +1）')
    console.log('    ⇒ C3 的结论：标记写失败时，重试必然重复 SRS 副作用；')
    console.log('       当前结构无法同时保证「不丢」和「不重」。')
  })

  /* ---------- C4：恢复时重复发现待交接词条 ---------- */

  await group('C4：恢复时已标记词不重复调度、未标记词进入待处理', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'c4-1' })

    // A 正常完成并交接（已标记）
    await completeWord(a, 'c4a')
    eq((await getSessionById('c4-1'))!.queue.find((x) => x.word_id === a)!.srs_reported, true, 'A 已标记')
    eq(await spellingLogs(a), 1, 'A 交接 1 次')

    // B 完成但交接失败（未标记）
    const blockRecord = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: recordQuiz 失败',
    })
    try {
      for (let i = 1; i <= 3; i += 1) {
        await submitAttempt({ word_id: b, input: 'benefit', request_id: `c4b-${i}`, now: NOW + 10 + i })
      }
    } finally {
      blockRecord()
    }
    eq((await getSessionById('c4-1'))!.queue.find((x) => x.word_id === b)!.srs_reported, false, 'B 未标记')
    eq(await spellingLogs(b), 0, 'B 未交接')

    // 恢复补交：只应调度 B
    const r1 = await repairSrsHandoff()
    eq(r1.outcome, 'reported', '补交成功')
    eq(r1.reported.length, 1, '只补交 1 个词')
    ok(r1.reported[0] === b, '补交的是 B（未标记的那个）')
    eq(await spellingLogs(a), 1, 'A 的 reviewLog 仍是 1 行（未重复调度）')
    eq(await spellingLogs(b), 1, 'B 的 reviewLog 变成 1 行')

    // 多次恢复：结果一致，不再调度
    const r2 = await repairSrsHandoff()
    eq(r2.outcome, 'none', '二次恢复无待交接词条')
    const r3 = await repairSrsHandoff()
    eq(r3.outcome, 'none', '三次恢复仍无待交接词条')
    eq(await spellingLogs(a), 1, 'A 仍 1 行')
    eq(await spellingLogs(b), 1, 'B 仍 1 行')

    // resume / pause 本身不得触发交接
    await pause(NOW + 100)
    const before = await spellingLogs(a) + (await spellingLogs(b))
    await resume(NOW + 101)
    await resume(NOW + 102)
    eq(await spellingLogs(a) + (await spellingLogs(b)), before, 'resume 不触发任何交接')
    eq((await getResumableSession())!.status, 'IN_PROGRESS', 'resume 后回到 IN_PROGRESS')
  })

  /* ---------- 阶段 C 修掉的缺陷：自然结束后永不补交 ---------- */

  await group('缺陷回归：最后一个词交接失败时，会话结束后必须仍能补交', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    const c = await wordIdOf('cabbage')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'def-1' })

    // A、B 正常完成并标记
    await completeWord(a, 'dfa')
    await completeWord(b, 'dfb')
    eq((await getSessionById('def-1'))!.queue.find((x) => x.word_id === a)!.srs_reported, true, 'A 已标记')
    eq((await getSessionById('def-1'))!.queue.find((x) => x.word_id === b)!.srs_reported, true, 'B 已标记')

    // 最后一个词 C：完成本身成功，但交接失败（只拦 C 的 recordQuiz）
    const blockC = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: 最后一个词的 recordQuiz 失败',
      when: (args) => args[0] === c,
    })
    try {
      await completeWord(c, 'dfc')
    } finally {
      blockC()
    }

    const done = (await getSessionById('def-1'))!
    eq(done.status, 'SESSION_COMPLETED', '会话已自然结束')
    eq(done.queue.find((x) => x.word_id === c)!.status, 'COMPLETED', 'C 已完成')
    eq(done.queue.find((x) => x.word_id === c)!.srs_reported, false, 'C 未标记')
    eq((await getResumableSession()), null, '此时没有「可恢复」会话')
    eq(await spellingLogs(c), 0, 'C 一行 SRS 都没写')

    // 原实现到这里 repairSrsHandoff 直接抛 NO_ACTIVE_SESSION，C 的 SRS 积分永久丢失
    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'reported', '补交成功（不再受会话状态阻挡）')
    eq(repair.sessions.length, 1, '扫到 1 个有未交接词的会话')
    eq(repair.reported.length, 1, '只补交 C 一个')
    ok(repair.reported[0] === c, '补交的确实是 C')
    eq(await spellingLogs(c), 1, 'C 的 SRS 积分补上了')
    eq(
      (await getSessionById('def-1'))!.queue.find((x) => x.word_id === c)!.srs_reported,
      true,
      'C 的标记已落库',
    )
    // 其余词不受影响
    eq(await spellingLogs(a), 1, 'A 仍只交接 1 次')
    eq(await spellingLogs(b), 1, 'B 仍只交接 1 次')
  })

  /* ---------- 已放弃会话是否补交（当前策略的显式记录） ---------- */

  await group('策略记录：已放弃会话的未交接词也会补交（D2 义务不随放弃消失）', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'ab-1' })

    const blockRecord = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: recordQuiz 失败',
    })
    try {
      for (let i = 1; i <= 3; i += 1) {
        await submitAttempt({ word_id: a, input: 'abandon', request_id: `aba-${i}`, now: NOW + i })
      }
    } finally {
      blockRecord()
    }
    // 用户放弃会话
    await pause(NOW + 50)
    const abandoned = await abandon(NOW + 60)
    eq(abandoned.status, 'ABANDONED', '会话已放弃')

    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'reported', '放弃会话里未交接的词仍被补交')
    eq(await spellingLogs(a), 1, 'A 的 SRS 积分仍在')
    console.log('    ⇒ 当前策略：D2 的义务在词条转 COMPLETED 时产生，不因放弃而消失。')
    console.log('       若产品侧认为「放弃=丢弃积分」，改 repairSrsHandoff 的过滤条件即可。')
  })

  /* ---------- 批量清扫：一次交接顺带补上历史遗留 ---------- */

  await group('批量清扫：本次交接会顺带补上更早遗留的未标记词', async () => {
    await reset()
    await seedVocab()
    const a = await wordIdOf('abandon')
    const b = await wordIdOf('benefit')
    await createSession({ mode: 'recent', count: 3, now: NOW, id: 'sweep-1' })

    // A 完成但交接失败（只拦 A）
    const blockA = inject({
      table: 'vocab',
      method: 'get',
      nth: 1,
      message: 'injected: recordQuiz 失败',
      when: (args) => args[0] === a,
    })
    try {
      await completeWord(a, 'swa')
    } finally {
      blockA()
    }
    eq(await spellingLogs(a), 0, 'A 未交接')
    eq((await getSessionById('sweep-1'))!.queue.find((x) => x.word_id === a)!.srs_reported, false, 'A 未标记')

    // B 完成：fulfillSrsHandoff 扫的是**整份队列**，应把 A 一起补上
    const r = await completeWordAndGetResult(b, 'swb')
    eq(r.srs, 'reported', 'B 完成 → 交接成功')
    eq(await spellingLogs(a), 1, 'A 被顺带补交（不必等用户下次打开页面）')
    eq(await spellingLogs(b), 1, 'B 自己也交接了')
    const stored = (await getSessionById('sweep-1'))!
    eq(stored.queue.find((x) => x.word_id === a)!.srs_reported, true, 'A 的标记也落库了')

    // 之后再补交：无待交接词条
    const repair = await repairSrsHandoff()
    eq(repair.outcome, 'none', '无遗留')
    eq(await spellingLogs(a), 1, 'A 仍 1 行')
  })

  /* ---------- 汇总 ---------- */

  console.log(`\n${'─'.repeat(56)}`)
  if (failed === 0) {
    console.log(`✅ SRS 交接与故障恢复测试全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ SRS 交接与故障恢复测试失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run()
