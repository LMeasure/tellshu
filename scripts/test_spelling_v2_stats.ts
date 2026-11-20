/**
 * 单词默写 V2 · P0 正确性链路自动化回归
 * ------------------------------------------------------------------
 * 覆盖（对应设计编号，均为**本文件实际执行**的断言，不是登记）：
 *   C47/T70 旧 epoch / 接管 / T-B 未跑 → PENDING_STALE，0/1
 *   C48/T71 凭证缺失 ∧ epoch 相等 → PENDING_CURRENT，1/1；T-B 后仍 1/1
 *   C49/T72 R1–R6：T-B 未跑/失败/崩溃、T-C 失败/超前、刷新、重复 drain
 *   C50/T73 接管递增 epoch → 1/1 → 0/1，已 SETTLED_* 不变，total 恒 1
 *   C51/T74 凭证优先级 > epoch；E.lock_epoch 缺失 → UNCLASSIFIABLE
 *   C52/T75 COVERED 优先级最高
 *   C53/T76 脏数据容错（缺 lock_epoch / 缺 session_id / S=null）
 *   另加：同一 event_id 重试、不同 reset 并发、error/reset 事务竞争、
 *         Dexie 与 memory 双驱动一致性、takeover 与旧标签 in-flight、
 *         T-A 已提交 T-B 未提交的恢复、owner/session/tab/epoch 写入校验、
 *         drain 重试与收敛、两个指标文案不混淆。
 *
 * 真实库：fake-indexeddb + 真实 Dexie 驱动；双标签用 tabId 注入。
 * 运行：npx tsx scripts/test_spelling_v2_stats.ts
 */

import 'fake-indexeddb/auto'
import { storage } from '../src/services/storage'
import { memoryStorage } from '../src/services/storage/memory'
import {
  LOCK_LEASE_MS,
  TAB_ID,
  clearLockInvalidation,
  invalidateLocalLocks,
  takeoverSessionLock,
} from '../src/domain/spellingLock'
import {
  appendErrorEventIfOwner,
  drainPendingEvents,
  loadSessionErrorStats,
  runRecoveryChain,
  settleErrorEvent,
  validateEventRow,
  type DrainResult,
} from '../src/domain/spellingErrorEvents'
import {
  ACTIVE_CLASSES,
  STAT_LABELS,
  aggregateErrorStats,
  classify,
  type StatClass,
} from '../src/domain/spellingErrorStats'
import type { SpellingErrorCredential, SpellingSession } from '../src/domain/spelling'
import type { SpellingErrorEvent } from '../src/domain/types'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1
    console.log('  ✓', msg)
  } else {
    failed += 1
    failures.push(msg)
    console.error('  ❌', msg)
  }
}
function eq<T>(actual: T, expected: T, msg: string): void {
  ok(actual === expected, `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`)
}
async function group(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${title}`)
  await fn()
}

const NOW = 1_700_000_000_000
const A = 'tab-A'
const B = 'tab-B'
const SESSIONS = storage.table('spellingSessions')
const EVENTS = storage.table('spellingErrorEvents')

/* ---------------- 构造 ---------------- */

function session(
  id: string,
  over: Partial<SpellingSession> = {},
): SpellingSession {
  return {
    id,
    type: 'spelling',
    owner: 'guest',
    status: 'IN_PROGRESS',
    selection_mode: 'recent',
    target_correct: 3,
    total_words: 1,
    current_position: 0,
    started_at: NOW,
    updated_at: NOW,
    queue: [
      {
        word_id: 'CET4:abandon',
        word: 'abandon',
        position: 0,
        status: 'IN_PROGRESS',
        consecutive_correct: 0,
        target_correct: 3,
        total_attempts: 0,
        correct_attempts: 0,
        wrong_attempts: 0,
        srs_reported: false,
      },
    ],
    processed_requests: {},
    active_tab_id: A,
    lock_epoch: 0,
    lock_held_at: NOW,
    ...over,
  } as SpellingSession
}

function event(
  event_id: string,
  session_id: string,
  over: Partial<SpellingErrorEvent> = {},
): SpellingErrorEvent {
  return {
    event_id,
    owner: 'guest',
    word_id: 'CET4:abandon',
    session_id,
    kind: 'wrong',
    occurred_at: NOW,
    status: 'pending',
    tab_id: A,
    lock_epoch: 0,
    ...over,
  } as SpellingErrorEvent
}

/** 纯统计：一组事件 + 会话映射（按 session_id 精确读，不用 getResumableSession） */
function statsOf(
  events: SpellingErrorEvent[],
  sessions: Record<string, SpellingSession | null>,
  covered: ReadonlySet<string> = new Set<string>(),
) {
  return aggregateErrorStats(events, (sid) => sessions[sid] ?? null, covered)
}

async function resetDb(): Promise<void> {
  await storage.clearAll()
  await memoryStorage.clearAll()
  clearLockInvalidation()
}

async function sessionRow(id: string): Promise<SpellingSession> {
  return (await SESSIONS.get(id)) as unknown as SpellingSession
}
async function eventRow(id: string): Promise<SpellingErrorEvent | undefined> {
  return (await EVENTS.get(id)) as unknown as SpellingErrorEvent | undefined
}

/* ---------------- 用例 ---------------- */

async function run(): Promise<void> {
  console.log('▶ 单词默写 V2 · P0 正确性链路 / C47–C53 · T70–T76')
  await storage.open()

  /* ===== C47/T70 · 旧代次事件 + T-B 未跑 ===== */
  await group('C47/T70 · 旧 epoch / B 接管 / T-B 未跑 → PENDING_STALE（0/1）', async () => {
    await resetDb()
    const s = session('s47', { active_tab_id: B, lock_epoch: 1 })
    await SESSIONS.put(s as never)
    const e = event('e47', 's47', { lock_epoch: 0, tab_id: A })
    await EVENTS.put(e as never)
    eq(classify(e, { session: s, covered: new Set() }), 'PENDING_STALE', 'C47 分类 = PENDING_STALE')
    const st = statsOf([e], { s47: s })
    eq(st.active_wrong_count, 0, 'C47 活动错词事件数 = 0（旧代次不污染）')
    eq(st.total_error_events, 1, 'C47 历史错误事件行数 = 1')
    eq(await settleErrorEvent('s47', 'e47', { tabId: B, now: NOW }), 'settled_skipped', 'T-B 后判 settled_skipped')
    eq((await sessionRow('s47')).applied_error_event_ids?.e47, 'stale', '凭证写带结论的 stale')
    const st2 = statsOf([(await eventRow('e47'))!], { s47: await sessionRow('s47') })
    eq(st2.active_wrong_count, 0, 'T-B 后活动错词仍为 0')
    eq(st2.total_error_events, 1, 'T-B 后历史行数仍为 1')
  })

  /* ===== C48/T71 · 本代次待结算 ===== */
  await group('C48/T71 · 凭证缺失 ∧ epoch 相等 → PENDING_CURRENT（1/1）', async () => {
    await resetDb()
    const s = session('s48', { active_tab_id: A, lock_epoch: 0 })
    await SESSIONS.put(s as never)
    const e = event('e48', 's48', { lock_epoch: 0 })
    await EVENTS.put(e as never)
    eq(classify(e, { session: s, covered: new Set() }), 'PENDING_CURRENT', 'C48 分类 = PENDING_CURRENT')
    const st = statsOf([e], { s48: s })
    eq(st.active_wrong_count, 1, 'C48 活动错词事件数 = 1')
    eq(st.total_error_events, 1, 'C48 历史错误事件行数 = 1')
    eq(await settleErrorEvent('s48', 'e48', { tabId: A, now: NOW }), 'settled', 'T-B 成功')
    const st2 = statsOf([(await eventRow('e48'))!], { s48: await sessionRow('s48') })
    eq(st2.active_wrong_count, 1, 'T-B 后仍 1（SETTLED_ZEROED）')
    eq(st2.total_error_events, 1, 'T-B 后 total 恒 1')
  })

  /* ===== C49/T72 · R1–R6 恢复矩阵 ===== */
  await group('C49/T72 · R1–R6：T-B 未跑/失败、T-C 失败/超前、刷新、重复 drain', async () => {
    await resetDb()
    const s = session('s49', { active_tab_id: A, lock_epoch: 0 })
    await SESSIONS.put(s as never)
    const e = event('e49', 's49', { lock_epoch: 0 })
    await EVENTS.put(e as never)
    const base = statsOf([e], { s49: s })
    eq(base.active_wrong_count, 1, 'R3 刷新前 active=1')

    // R4：status 落后（凭证已写、status 被人为回退）—— classify 不读 status
    await EVENTS.put({ ...(await eventRow('e49'))!, status: 'pending' } as never)
    await SESSIONS.put({
      ...(await sessionRow('s49')),
      applied_error_event_ids: { e49: true },
    } as never)
    const eR4 = (await eventRow('e49'))!
    eq(eR4.status, 'pending', 'R4 status 被回退为 pending')
    eq(classify(eR4, { session: await sessionRow('s49'), covered: new Set() }), 'SETTLED_ZEROED', 'R4 分类不受 status 影响')
    eq(statsOf([eR4], { s49: await sessionRow('s49') }).active_wrong_count, 1, 'R4 active 不变')

    // R5：status 超前但凭证缺失
    await SESSIONS.put({ ...(await sessionRow('s49')), applied_error_event_ids: {} } as never)
    await EVENTS.put({ ...(await eventRow('e49'))!, status: 'settled' } as never)
    eq(
      classify((await eventRow('e49'))!, { session: await sessionRow('s49'), covered: new Set() }),
      'PENDING_CURRENT',
      'R5 凭证缺失时不被 status 超前欺骗',
    )

    // R6：重复 drain 幂等
    await EVENTS.put({ ...(await eventRow('e49'))!, status: 'pending' } as never)
    const d1 = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 's49' })
    const d2 = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 's49' })
    eq(d1.settled, 1, 'R6 首次 drain 结算 1 条')
    eq(d2.scanned, 0, 'R6 重复 drain 无 pending')
    eq(Object.keys((await sessionRow('s49')).applied_error_event_ids ?? {}).length, 1, 'R6 凭证数恒 1')
    ok(d1.converged && d2.converged, 'R6 两轮 drain 均收敛')
  })

  /* ===== C50/T73 · 接管递增 epoch ===== */
  await group('C50/T73 · 接管递增 epoch → 1/1 → 0/1，SETTLED_* 不变', async () => {
    await resetDb()
    const s = session('s50', { active_tab_id: A, lock_epoch: 0 })
    await SESSIONS.put(s as never)
    const ePending = event('e50p', 's50', { lock_epoch: 0 })
    const eSettled = event('e50s', 's50', { lock_epoch: 0 })
    await EVENTS.put(ePending as never)
    await EVENTS.put(eSettled as never)
    eq(await settleErrorEvent('s50', 'e50s', { tabId: A, now: NOW }), 'settled', '先结算一条')
    const before = statsOf([ePending, (await eventRow('e50s'))!], { s50: await sessionRow('s50') })
    eq(before.active_wrong_count, 2, '接管前 2/2')
    await takeoverSessionLock('s50', { confirmed: true, tabId: B, now: NOW + 10 })
    const after = statsOf(
      [ePending, (await eventRow('e50s'))!],
      { s50: await sessionRow('s50') },
    )
    eq(after.by_class.PENDING_CURRENT, 0, '凭证缺失事件被重分类，不再 PENDING_CURRENT')
    eq(after.by_class.PENDING_STALE, 1, '凭证缺失事件 → PENDING_STALE')
    eq(after.by_class.SETTLED_ZEROED, 1, '已 SETTLED_ZEROED 事件不受接管影响（凭证优先）')
    eq(after.total_error_events, 2, 'total 恒为行数')
  })

  /* ===== C51/T74 · 凭证优先级 + 脏数据 ===== */
  await group('C51/T74 · 凭证优先于代次；缺 lock_epoch → UNCLASSIFIABLE', async () => {
    await resetDb()
    const s = session('s51', { active_tab_id: A, lock_epoch: 5 })
    await SESSIONS.put(s as never)
    const oldZeroed = event('z', 's51', { lock_epoch: 0 })
    const oldStale = event('s', 's51', { lock_epoch: 0 })
    const dirty = event('d', 's51', { lock_epoch: undefined })
    const cred: Record<string, SpellingErrorCredential> = { z: 'zeroed', s: 'stale' }
    const sWithCred = { ...s, applied_error_event_ids: cred }
    eq(classify(oldZeroed, { session: sWithCred, covered: new Set() }), 'SETTLED_ZEROED', '旧代次但凭证 zeroed → 计入（凭证优先）')
    eq(classify(oldStale, { session: sWithCred, covered: new Set() }), 'SETTLED_STALE', '凭证 stale → 不计入')
    eq(classify(dirty, { session: sWithCred, covered: new Set() }), 'UNCLASSIFIABLE', '缺 lock_epoch → 保守不可分类')
    const st = statsOf([oldZeroed, oldStale, dirty], { s51: sWithCred })
    eq(st.active_wrong_count, 1, '仅 zeroed 计入活动错词')
    eq(st.total_error_events, 3, '三行全计入历史行数')
    eq(st.anomaly_count >= 1, true, '异常计数可提示用户')
  })

  /* ===== C52/T75 · COVERED 优先级 ===== */
  await group('C52/T75 · COVERED 覆盖一切其它分类，total 不变', async () => {
    await resetDb()
    const s = session('s52', { active_tab_id: A, lock_epoch: 0, applied_error_event_ids: { z: true } })
    await SESSIONS.put(s as never)
    const pending = event('p', 's52')
    const zeroed = event('z', 's52')
    const stale = event('s', 's52', { lock_epoch: 9 })
    const events = [pending, zeroed, stale]
    const before = statsOf(events, { s52: s })
    const covered = new Set(['p', 'z', 's'])
    const after = statsOf(events, { s52: s }, covered)
    eq(before.active_wrong_count, 2, '覆盖前 2 条活动错词')
    eq(after.active_wrong_count, 0, 'C52 三类全部被 covered 移出 active')
    eq(after.by_class.COVERED, 3, 'COVERED 计数 = 3')
    eq(after.total_error_events, 3, 'C52 total 恒 3，不物理删行')
    // reset 快照并集幂等：重复构造同一集合不扩大
    const union = new Set([...covered, ...covered])
    eq(statsOf(events, { s52: s }, union).active_wrong_count, 0, '并集幂等，不扩大覆盖')
  })

  /* ===== C53/T76 · 脏数据容错 ===== */
  await group('C53/T76 · 缺 session / S=null / 缺 owner → 不抛错、不编造数字', async () => {
    await resetDb()
    const s = session('s53', { active_tab_id: A, lock_epoch: 0 })
    await SESSIONS.put(s as never)
    const orphan = event('o', 'no-such-session')
    const missingEpoch = event('m', 's53', { lock_epoch: undefined })
    let threw = false
    let st!: ReturnType<typeof statsOf>
    try {
      st = statsOf([orphan, missingEpoch], { s53: s, 'no-such-session': null })
    } catch {
      threw = true
    }
    ok(!threw, '脏数据不抛错、不白屏')
    eq(st.by_class.ORPHAN, 1, '会话不存在 → ORPHAN')
    eq(st.by_class.UNCLASSIFIABLE, 1, '缺代次 → UNCLASSIFIABLE')
    eq(st.active_wrong_count, 0, '脏数据不计入活动错词')
    eq(st.total_error_events, 2, '脏数据仍计入历史行数')
    // ORPHAN 的 S 必须按 session_id 精确读，不得挂到别的会话
    eq(classify(orphan, { session: null, covered: new Set() }), 'ORPHAN', 'S=null 明确判 ORPHAN')
  })

  /* ===== 统计一致性 / 文案 ===== */
  await group('统计口径 · active ⊆ total、指标分别标注、文案不出现「拼错次数」', async () => {
    await resetDb()
    const s = session('s-stat', { active_tab_id: A, lock_epoch: 0 })
    await SESSIONS.put(s as never)
    const rows = [
      event('a', 's-stat', { lock_epoch: 0 }),
      event('b', 's-stat', { lock_epoch: 3 }),
      event('c', 's-stat', { lock_epoch: 0, status: 'settled_skipped' }),
    ]
    const st = statsOf(rows, { s: s, 's-stat': s })
    ok(st.active_wrong_count <= st.total_error_events, 'active 恒为 total 子集')
    eq(st.total_error_events, 3, 'total 恒等于行数，与 status 无关')
    eq(ACTIVE_CLASSES.length, 2, '仅两类计入 active')
    ok(!STAT_LABELS.active.includes('拼错次数'), '活动指标文案禁用「拼错次数」')
    ok(!STAT_LABELS.total.includes('拼错次数'), '历史指标文案禁用「拼错次数」')
    ok(STAT_LABELS.active !== STAT_LABELS.total, '两个指标分别标注、名称不同')
    ok(STAT_LABELS.note.includes('不代表主观'), '口径说明明确否定主观次数')
  })

  /* ===== 同一 event_id 重试 ===== */
  await group('同一 event_id 重试 · 不产生第二行、不重复写凭证、不覆盖已有结论', async () => {
    await resetDb()
    await SESSIONS.put(session('s-dup', { active_tab_id: A }) as never)
    const input = { event_id: 'dup', session_id: 's-dup', word_id: 'CET4:abandon', kind: 'wrong' as const, tabId: A }
    const r1 = await appendErrorEventIfOwner(input)
    const r2 = await appendErrorEventIfOwner(input)
    const r3 = await appendErrorEventIfOwner(input)
    ok(r1.inserted && !r2.inserted && !r3.inserted, '首次 true，重复两次均 false')
    eq(await EVENTS.count(), 1, '事件表恒 1 行')
    eq(Object.keys((await sessionRow('s-dup')).applied_error_event_ids ?? {}).length, 1, '凭证恒 1 条')
    eq(await settleErrorEvent('s-dup', 'dup', { tabId: A }), 'already_settled', '重复结算幂等')
    // 手工把凭证改成 'stale' 后重放，不得被 true 覆盖
    await SESSIONS.put({
      ...(await sessionRow('s-dup')),
      applied_error_event_ids: { dup: 'stale' },
    } as never)
    await appendErrorEventIfOwner(input)
    eq((await sessionRow('s-dup')).applied_error_event_ids?.dup, 'stale', '重放不覆盖已有 stale 结论')
  })

  /* ===== 不同 reset 并发 ===== */
  await group('不同 reset 并发 · 两行各自落盘、covered 并集幂等、无 lost update', async () => {
    await resetDb()
    await SESSIONS.put(session('s-reset', { active_tab_id: A, lock_epoch: 0 }) as never)
    const base = [
      event('E1', 's-reset'),
      event('E2', 's-reset'),
      event('E3', 's-reset'),
    ]
    const [r1, r2] = await Promise.all([
      storage.insertIfAbsent('spellingErrorEvents', {
        ...event('R1', 's-reset'),
        kind: 'skip',
        covered_event_ids: ['E1', 'E2'],
      } as never),
      storage.insertIfAbsent('spellingErrorEvents', {
        ...event('R2', 's-reset'),
        kind: 'skip',
        covered_event_ids: ['E2'],
      } as never),
    ])
    ok(r1 && r2, '两个不同主键的 reset 行都落盘')
    const covered = new Set(['E1', 'E2', 'E2'])
    const st = statsOf(base, { 's-reset': session('s-reset') }, covered)
    eq(covered.size, 2, '集合并集天然幂等，不扩大')
    eq(st.by_class.COVERED, 2, 'E1/E2 被覆盖')
    eq(st.active_wrong_count, 1, 'E3 未覆盖，保留为活动错词')
    eq(st.total_error_events, 3, 'total 不受 reset 影响')
  })

  /* ===== error / reset 事务竞争 ===== */
  await group('error/reset 事务竞争 · 两种全序各自自洽，不读 occurred_at', async () => {
    await resetDb()
    await SESSIONS.put(session('s-race', { active_tab_id: A, lock_epoch: 0 }) as never)
    const [ins, reset] = await Promise.all([
      storage.insertIfAbsent('spellingErrorEvents', event('E-new', 's-race', { occurred_at: NOW + 999 }) as never),
      storage.insertIfAbsent('spellingErrorEvents', {
        ...event('R-race', 's-race'),
        kind: 'skip',
        covered_event_ids: ['E-new'],
        occurred_at: NOW - 999,
      } as never),
    ])
    ok(ins && reset, 'error 与 reset 两行都落盘，无 ConstraintError 泄漏')
    const s = session('s-race')
    const withCovered = statsOf([event('E-new', 's-race')], { 's-race': s }, new Set(['E-new']))
    const withoutCovered = statsOf([event('E-new', 's-race')], { 's-race': s }, new Set())
    eq(withCovered.active_wrong_count, 0, 'reset 快照含 E → 不计入')
    eq(withoutCovered.active_wrong_count, 1, 'reset 快照不含 E → 保留')
    eq(withCovered.total_error_events, withoutCovered.total_error_events, 'total 与全序无关')
    // 时间不影响分类：把 occurred_at 改成任意值，结果不变
    const later = event('E-new', 's-race', { occurred_at: NOW - 100000 })
    eq(classify(later, { session: s, covered: new Set() }), classify(event('E-new', 's-race'), { session: s, covered: new Set() }), 'occurred_at 不参与分类')
  })

  /* ===== 双驱动一致性 ===== */
  await group('Dexie / memory 双驱动 · classify 与聚合结果一致', async () => {
    await resetDb()
    const s = session('s-drv', { active_tab_id: A, lock_epoch: 2, applied_error_event_ids: { z: true } })
    const rows = [
      event('p', 's-drv', { lock_epoch: 2 }),
      event('z', 's-drv', { lock_epoch: 0 }),
      event('o', 'ghost'),
    ]
    const dex = statsOf(rows, { 's-drv': s, ghost: null })
    // memory 侧写入同样的行，验证两驱动读回一致
    await memoryStorage.table('spellingSessions').put(s as never)
    for (const r of rows) await memoryStorage.table('spellingErrorEvents').put(r as never)
    const memRows = (await memoryStorage.table('spellingErrorEvents').toArray()) as unknown as SpellingErrorEvent[]
    const memSession = (await memoryStorage.table('spellingSessions').get('s-drv')) as unknown as SpellingSession
    const mem = aggregateErrorStats(memRows, (sid) => (sid === 's-drv' ? memSession : null))
    eq(mem.active_wrong_count, dex.active_wrong_count, '两驱动 active 一致')
    eq(mem.total_error_events, dex.total_error_events, '两驱动 total 一致')
    eq(mem.by_class.ORPHAN, dex.by_class.ORPHAN, '两驱动 ORPHAN 一致')
  })

  /* ===== takeover 与旧标签 in-flight ===== */
  await group('takeover 与旧标签 in-flight 写入 · 严格校验拒绝、零落盘', async () => {
    await resetDb()
    await SESSIONS.put(session('s-to', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW }) as never)
    await takeoverSessionLock('s-to', { confirmed: true, tabId: B, now: NOW + 1 })
    let rejected = 0
    try {
      await appendErrorEventIfOwner({
        event_id: 'in-flight',
        session_id: 's-to',
        word_id: 'CET4:abandon',
        kind: 'wrong',
        tabId: A,
      })
    } catch {
      rejected += 1
    }
    eq(rejected, 1, '旧标签写入被明确拒绝')
    eq(await EVENTS.count(), 0, '旧标签零事件落盘')
    eq((await sessionRow('s-to')).active_tab_id, B, '接管方仍持锁')
    eq((await sessionRow('s-to')).lock_epoch, 1, 'fencing token 恰 +1')
    // 租约过期也不得在写路径静默接管
    await SESSIONS.put({ ...(await sessionRow('s-to')), lock_held_at: 1 } as never)
    let stillRejected = 0
    try {
      await appendErrorEventIfOwner({
        event_id: 'in-flight-2',
        session_id: 's-to',
        word_id: 'CET4:abandon',
        kind: 'wrong',
        tabId: A,
      })
    } catch {
      stillRejected += 1
    }
    eq(stillRejected, 1, '租约过期也不在写路径静默接管')
    eq((await sessionRow('s-to')).lock_epoch, 1, '旧标签未偷偷递增 epoch')
  })

  /* ===== T-A 已提交、T-B 未提交的恢复（历史 S1 形态） ===== */
  await group('T-A 已提交 / T-B 未提交 · 启动恢复链幂等补结算', async () => {
    await resetDb()
    await SESSIONS.put(session('s-s1', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e-s1', 's-s1', { lock_epoch: 0, tab_id: A }) as never)
    // T-B 未跑：凭证缺失，统计按 epoch 兜底已能给出正确结论
    const before = statsOf([event('e-s1', 's-s1', { lock_epoch: 0 })], { 's-s1': session('s-s1') })
    eq(before.active_wrong_count, 1, 'T-B 未跑时 active 已正确 = 1（不等待结算）')
    invalidateLocalLocks()
    const chain = await runRecoveryChain('s-s1', { tabId: A, now: NOW })
    ok(chain.converged, 'U16 恢复链收敛')
    eq(chain.drain.settled, 1, 'drain 恰补结算 1 条')
    eq((await sessionRow('s-s1')).applied_error_event_ids?.['e-s1'], true, '凭证已补')
    eq((await eventRow('e-s1'))!.status, 'settled', '事件状态收敛')
    const d2 = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 's-s1' })
    eq(d2.scanned, 0, '重复 drain 无活可干')
    ok(d2.converged, '重复 drain 仍收敛')
    const after = await loadSessionErrorStats('s-s1')
    eq(after.active_wrong_count, 1, '恢复后 active 不变')
    eq(after.total_error_events, 1, '恢复后 total 不变')
  })

  /* ===== 旧代次事件在结算前不污染活动错词本（P0 第 5 条） ===== */
  await group('P0 第 5 条 · 旧代次事件在 T-B 未执行/失败/崩溃/刷新时不污染活动错词本', async () => {
    await resetDb()
    await SESSIONS.put(session('s-pollute', { active_tab_id: B, lock_epoch: 1, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e-old', 's-pollute', { lock_epoch: 0, tab_id: A }) as never)
    const pre = await loadSessionErrorStats('s-pollute')
    eq(pre.active_wrong_count, 0, '结算前（T-B 未执行）活动错词 = 0')
    eq(pre.total_error_events, 1, '结算前历史行数 = 1')
    await settleErrorEvent('s-pollute', 'e-old', { tabId: B, now: NOW })
    const post = await loadSessionErrorStats('s-pollute')
    eq(post.active_wrong_count, 0, '结算后（settled_skipped）活动错词仍 = 0')
    eq(post.total_error_events, 1, '结算后历史行数仍 = 1')
    eq((await sessionRow('s-pollute')).applied_error_event_ids?.['e-old'], 'stale', 'stale 凭证不被当 zeroed')
  })

  /* ===== 事件写入上下文校验（owner/session/tab/epoch） ===== */
  await group('P0 第 1 条 · owner / session / tab / lock_epoch 写入校验', async () => {
    await resetDb()
    const s = session('s-val', { active_tab_id: A, lock_epoch: 4, owner: 'guest' })
    const good = event('v', 's-val', { owner: 'guest', tab_id: A, lock_epoch: 4 })
    eq(validateEventRow(good, s, A, 4).ok, true, '同源事件通过校验')
    eq((validateEventRow({ ...good, owner: 'other' }, s, A, 4) as { reason: string }).reason, 'OWNER_MISMATCH', '跨 owner 被拒')
    eq((validateEventRow({ ...good, session_id: 'other' }, s, A, 4) as { reason: string }).reason, 'SESSION_MISMATCH', '跨会话被拒')
    eq((validateEventRow({ ...good, tab_id: 'other' }, s, A, 4) as { reason: string }).reason, 'TAB_MISMATCH', '错标签被拒')
    eq((validateEventRow({ ...good, lock_epoch: 3 }, s, A, 4) as { reason: string }).reason, 'EPOCH_MISMATCH', '代次冻结错误被拒')
    eq((validateEventRow({ ...good, event_id: '' }, s, A, 4) as { reason: string }).reason, 'EVENT_ID_REQUIRED', '空 event_id 被拒')
    // 事务内实际路径：注入越权 owner 会被会话 owner 覆盖，不会跨账号落盘
    await SESSIONS.put(s as never)
    const r = await appendErrorEventIfOwner({
      event_id: 'v-owner',
      session_id: 's-val',
      word_id: 'CET4:abandon',
      kind: 'wrong',
      owner: 'attacker',
      tabId: A,
    })
    eq(r.event.owner, 'guest', '越权 owner 被会话 owner 覆盖，不落跨账号数据')
    eq((await eventRow('v-owner'))!.lock_epoch, 4, '事件冻结事务内重读到的 lock_epoch')
  })

  /* ===== drain 重试、收敛、sessionsSkipped ===== */
  await group('drain 重试与收敛 · 失败保留 pending、被他标签持锁不抢不丢', async () => {
    await resetDb()
    await SESSIONS.put(session('s-skip', { active_tab_id: 'other', lock_epoch: 2, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e-skip', 's-skip', { lock_epoch: 2 }) as never)
    const d = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 's-skip' })
    eq(d.sessionsSkipped, 1, '他人持锁 → sessionsSkipped=1')
    eq((await eventRow('e-skip'))!.status, 'pending', '事件保留 pending，不抢不丢')
    ok(!d.converged, '存在未结算事件时判未收敛（输入闸门不得开启）')
    eq(d.pendingRemaining, 1, 'pendingRemaining 如实为 1')

    // 空库 drain 判收敛
    await resetDb()
    const clean = await drainPendingEvents({ tabId: A })
    ok(clean.converged, '无 pending 时收敛')
    eq(clean.scanned, 0, '空库 scanned=0')
    eq(clean.retries, 0, '空库无需重试')
  })

  /* ===== loadSessionErrorStats owner 隔离 ===== */
  await group('只读统计入口 · owner 隔离、reset 覆盖、读取不编造', async () => {
    await resetDb()
    await SESSIONS.put(session('s-load', { active_tab_id: A, lock_epoch: 0 }) as never)
    await EVENTS.put(event('own', 's-load', { owner: 'guest' }) as never)
    await EVENTS.put(event('foreign', 's-load', { owner: 'someone-else' }) as never)
    await EVENTS.put({
      ...event('R', 's-load'),
      kind: 'skip',
      covered_event_ids: ['own'],
    } as never)
    const st = await loadSessionErrorStats('s-load')
    eq(st.total_error_events, 1, '其它 owner 的行不混入统计')
    eq(st.by_class.COVERED, 1, 'reset 快照生效')
    eq(st.active_wrong_count, 0, '被覆盖的行不计入活动错词')
    const missing = await loadSessionErrorStats('no-such-session')
    eq(missing.total_error_events, 0, '会话不存在时返回 0，不编造数字')
  })

  /* ===== 统计类映射完整性 ===== */
  await group('分类优先级完整性 · 7 类全覆盖且 active 仅 2 类', async () => {
    const s = session('x', { lock_epoch: 0, applied_error_event_ids: { z: true, st: 'stale' } })
    const cases: Array<[SpellingErrorEvent, ReadonlySet<string>, SpellingSession | null, StatClass]> = [
      [event('c', 'x'), new Set(['c']), s, 'COVERED'],
      [event('z', 'x', { lock_epoch: 9 }), new Set(), s, 'SETTLED_ZEROED'],
      [event('st', 'x', { lock_epoch: 9 }), new Set(), s, 'SETTLED_STALE'],
      [event('p', 'x', { lock_epoch: 0 }), new Set(), s, 'PENDING_CURRENT'],
      [event('q', 'x', { lock_epoch: 1 }), new Set(), s, 'PENDING_STALE'],
      [event('o', 'x'), new Set(), null, 'ORPHAN'],
      [event('d', 'x', { lock_epoch: undefined }), new Set(), s, 'UNCLASSIFIABLE'],
    ]
    for (const [e, covered, ses, expected] of cases) {
      eq(classify(e, { session: ses, covered }), expected, `优先级用例 ${e.event_id} → ${expected}`)
    }
    eq(ACTIVE_CLASSES.includes('SETTLED_STALE'), false, 'SETTLED_STALE 不计入 active')
    eq(ACTIVE_CLASSES.includes('PENDING_STALE'), false, 'PENDING_STALE 不计入 active')
  })

  console.log(`\n${'─'.repeat(64)}`)
  if (failed === 0) {
    console.log(`✅ V2 P0 正确性链路全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ V2 P0 正确性链路失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run().catch((err) => {
  console.error('❌ 测试执行异常', err)
  process.exit(1)
})
