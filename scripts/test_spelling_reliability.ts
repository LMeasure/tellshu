/**
 * 跨标签单写者锁 / 错词事件 / U16 恢复链 · 自动化回归
 * ------------------------------------------------------------------
 * 真实库：fake-indexeddb + 真实 Dexie 驱动（不 mock 服务层、不 mock 业务逻辑）。
 * 双标签：通过 LockOptions.tabId 注入两个标签身份，共享同一份 IDB 库，
 *         由 updateAtomic 的单表 rw 事务验证真正的并发串行化。
 *
 * 覆盖：
 *   组 1 存储原语（insertIfAbsent 幂等 / CAS 并发 / abort / skip / memory 对照）
 *   组 2 L2 锁（C33-C38：拒绝、takeover、release、fencing、租约、时钟回拨、安全降级）
 *   组 3 事件链（T-A/T-B/T-C、S1/S2、drain 幂等、C09/T29 stale）
 *   组 4 U16（重开≠持锁、只读降级、五步恢复链、跳过取锁被拒）
 *   组 5 V1 真实写路径接入（生产提交真的落事件、幂等重放、正确提交不写）
 *   组 6 v14 行内字段不改 schema（索引仍可用）
 *
 * 运行：tsx scripts/test_spelling_reliability.ts
 */

import 'fake-indexeddb/auto'
import { storage } from '../src/services/storage'
import { memoryStorage } from '../src/services/storage/memory'
import { AtomicAbortError } from '../src/services/storage/types'
import {
  LOCK_LEASE_MS,
  SpellingLockError,
  TAB_ID,
  acquireSessionLock,
  assertLockInTransaction,
  assertSessionLock,
  clearLockInvalidation,
  invalidateLocalLocks,
  isLockInvalidated,
  releaseSessionLock,
  renewSessionLock,
  resetAfterReconnect,
  takeoverSessionLock,
} from '../src/domain/spellingLock'
import {
  appendErrorEventIfOwner,
  drainPendingEvents,
  settleErrorEvent,
} from '../src/domain/spellingErrorEvents'
import { classify, aggregateErrorStats } from '../src/domain/spellingErrorStats'

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

/**
 * 跨表竞态注入：在「写前校验已完成、真正落盘之前」让另一标签显式接管。
 * 同时包装 insertIfAbsent（实施 B 旧路径）与 atomicBatch（本轮新路径），
 * 无论实现走哪条路径都触发同一时序 —— 断言在实施前后保持不变。
 */
function injectTakeoverBeforeEventWrite(sessionId: string, otherTab: string): () => void {
  const target = storage as unknown as Record<string, any>
  const origInsert = target.insertIfAbsent as (...a: any[]) => Promise<boolean>
  const origBatch = target.atomicBatch as ((...a: any[]) => Promise<any>) | undefined
  let fired = false
  const fire = async (): Promise<void> => {
    if (fired) return
    fired = true
    await takeoverSessionLock(sessionId, { confirmed: true, tabId: otherTab })
  }
  target.insertIfAbsent = async (...args: any[]) => {
    if (args[0] === 'spellingErrorEvents') await fire()
    return origInsert.apply(storage, args)
  }
  if (origBatch) {
    target.atomicBatch = async (...args: any[]) => {
      await fire()
      return origBatch.apply(storage, args)
    }
  }
  return () => {
    target.insertIfAbsent = origInsert
    if (origBatch) target.atomicBatch = origBatch
  }
}

function hasAtomicBatch(): boolean {
  return typeof (storage as unknown as Record<string, unknown>).atomicBatch === 'function'
}

async function group(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${title}`)
  await fn()
}

async function expectLockError(
  fn: () => Promise<unknown>,
  code: string,
  msg: string,
): Promise<void> {
  try {
    await fn()
    ok(false, `${msg}（未抛错）`)
  } catch (err) {
    const actual = err instanceof SpellingLockError ? err.code : (err as Error)?.message
    ok(err instanceof SpellingLockError && err.code === code, `${msg}（实际 ${String(actual)}）`)
  }
}

const NOW = 1_700_000_000_000
const A = 'tab-A'
const B = 'tab-B'

const SESSIONS = storage.table('spellingSessions')
const EVENTS = storage.table('spellingErrorEvents')

function seedSession(id: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  }
}

function seedEvent(
  event_id: string,
  session_id: string,
  extra: Record<string, unknown> = {},
) {
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
    ...extra,
  }
}

function putSession(id: string, extra: Record<string, unknown> = {}) {
  return SESSIONS.put(seedSession(id, extra) as never)
}

async function resetDb(): Promise<void> {
  await storage.clearAll()
  clearLockInvalidation()
}

async function rowOf(id: string): Promise<Record<string, any>> {
  return (await SESSIONS.get(id)) as unknown as Record<string, any>
}

async function eventOf(id: string): Promise<Record<string, any>> {
  return (await EVENTS.get(id)) as unknown as Record<string, any>
}

async function run(): Promise<void> {
  console.log('▶ 存储可靠性 / 跨标签锁 / 错词事件 / U16 恢复链')
  await storage.open()

  /* ---------------- 组 1 · 存储原语 ---------------- */
  await group('1 · 存储原语（幂等插入 / 并发 CAS / abort / skip / 双驱动）', async () => {
    await resetDb()

    ok(
      await storage.insertIfAbsent('spellingErrorEvents', seedEvent('e1', 's1') as never),
      'insertIfAbsent 首次写入返回 true',
    )
    ok(
      !(await storage.insertIfAbsent('spellingErrorEvents', seedEvent('e1', 's1') as never)),
      'insertIfAbsent 主键冲突返回 false（不覆盖、不增行）',
    )
    eq(await EVENTS.count(), 1, '事件表仍只有 1 行')

    ok(
      await memoryStorage.insertIfAbsent('spellingErrorEvents', seedEvent('m1', 's1') as never),
      'memory 驱动 insertIfAbsent 首次 true',
    )
    ok(
      !(await memoryStorage.insertIfAbsent('spellingErrorEvents', seedEvent('m1', 's1') as never)),
      'memory 驱动 insertIfAbsent 重复 false（双驱动一致）',
    )

    await putSession('cas', { lock_epoch: 0 })
    const bump = () =>
      storage.updateAtomic('spellingSessions', 'cas', (current) => ({
        kind: 'commit',
        value: {
          ...(current as any),
          lock_epoch: ((current as any).lock_epoch ?? 0) + 1,
        },
      }))
    await Promise.all([bump(), bump()])
    eq((await rowOf('cas')).lock_epoch, 2, '两个并发 CAS 串行化，结果 = 2（不是 last-writer-wins）')

    await memoryStorage
      .table('spellingSessions')
      .put(seedSession('cas', { lock_epoch: 0 }) as never)
    const memBump = () =>
      memoryStorage.updateAtomic('spellingSessions', 'cas', (current) => ({
        kind: 'commit',
        value: {
          ...(current as any),
          lock_epoch: ((current as any).lock_epoch ?? 0) + 1,
        },
      }))
    await Promise.all([memBump(), memBump()])
    const memRow = (await memoryStorage
      .table('spellingSessions')
      .get('cas')) as unknown as Record<string, any>
    eq(memRow.lock_epoch, 2, 'memory 驱动并发 CAS 同样收敛到 2')

    const before = (await rowOf('cas')).lock_epoch
    let aborted = false
    try {
      await storage.updateAtomic('spellingSessions', 'cas', () => ({
        kind: 'abort',
        reason: 'TEST_ABORT',
      }))
    } catch (err) {
      aborted = err instanceof AtomicAbortError
    }
    ok(aborted, 'abort 抛 AtomicAbortError')
    eq((await rowOf('cas')).lock_epoch, before, 'abort 事务回滚，一行未写')

    const skipped = await storage.updateAtomic('spellingSessions', 'cas', () => ({ kind: 'skip' }))
    eq(skipped.committed, false, 'skip 返回 committed=false')
    eq((await rowOf('cas')).lock_epoch, before, 'skip 不写回')
  })

  /* ---------------- 组 2 · L2 跨标签锁 ---------------- */
  await group('2 · L2 跨标签单写者锁（C33-C38）', async () => {
    await resetDb()
    await putSession('sess')

    const a = await acquireSessionLock('sess', { tabId: A, now: NOW })
    eq(a.epoch, 0, 'A 取锁成功，初始 lock_epoch=0')
    eq((await rowOf('sess')).active_tab_id, A, '会话记录持锁标签 A')

    await expectLockError(
      () => acquireSessionLock('sess', { tabId: B, now: NOW + 1000 }),
      'TAB_LOCK_LOST',
      'B 在租约未过期时取锁被拒',
    )

    const t = await takeoverSessionLock('sess', { confirmed: true, tabId: B, now: NOW + 2000 })
    eq(t.epoch, 1, 'B 显式接管，fencing token epoch 恰 +1')
    eq((await rowOf('sess')).active_tab_id, B, '接管后持锁标签为 B')
    eq((await rowOf('sess')).lock_epoch, 1, 'epoch 原子递增并落库')

    await expectLockError(
      () => takeoverSessionLock('sess', { confirmed: false, tabId: A }),
      'TAKEOVER_NOT_CONFIRMED',
      '未获用户确认不得接管',
    )
    await expectLockError(
      () => assertSessionLock('sess', { tabId: A }),
      'TAB_LOCK_LOST',
      '旧持有者 A 的写前校验被拒',
    )

    eq(await releaseSessionLock('sess', { tabId: A }), false, 'A 的 release 不写回')
    eq((await rowOf('sess')).active_tab_id, B, '旧标签没能清掉新锁')
    eq((await rowOf('sess')).lock_epoch, 1, 'release 未扰动 epoch')

    const beforeCount = await EVENTS.count()
    await expectLockError(
      () =>
        appendErrorEventIfOwner({
          event_id: 'rejected',
          session_id: 'sess',
          word_id: 'CET4:abandon',
          kind: 'wrong',
          tabId: A,
        }),
      'TAB_LOCK_LOST',
      '旧持有者的事件写入被拒（九路径之一）',
    )
    eq(await EVENTS.count(), beforeCount, '拒绝写入后事件表零新增')

    await renewSessionLock('sess', { tabId: B, now: NOW + 3000 })
    eq((await rowOf('sess')).lock_held_at, NOW + 3000, 'B 心跳续期写入 lock_held_at')

    await putSession('sess-lease', { active_tab_id: A, lock_epoch: 5, lock_held_at: NOW })
    const forced = await acquireSessionLock('sess-lease', {
      tabId: B,
      now: NOW + LOCK_LEASE_MS + 1,
    })
    ok(forced.takenOver, '租约过期允许强制接管')
    eq(forced.epoch, 6, '强制接管同样 epoch+1')
    eq((await rowOf('sess-lease')).active_tab_id, B, '强制接管后锁归属 B')

    await putSession('sess-clock', { active_tab_id: A, lock_epoch: 2, lock_held_at: NOW + 100000 })
    await expectLockError(
      () => acquireSessionLock('sess-clock', { tabId: B, now: NOW }),
      'TAB_LOCK_LOST',
      '时钟回拨不判过期、不误接管',
    )

    clearLockInvalidation()
    await expectLockError(
      () => renewSessionLock('sess', { tabId: A }),
      'TAB_LOCK_LOST',
      '失锁标签心跳被拒',
    )
    ok(isLockInvalidated(), '心跳失锁后本地进入只读降级')
    await expectLockError(
      () => assertSessionLock('sess', { tabId: B }),
      'LOCK_UNAVAILABLE',
      '降级态下所有写入请求被拒（不静默失败）',
    )
    clearLockInvalidation()
  })

  /* ---------------- 组 3 · 事件链与 drain ---------------- */
  await group('3 · 错词事件链（T-A/T-B/T-C、S1/S2、stale、C57/C58）', async () => {
    await resetDb()
    await putSession('s3', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW })

    const r1 = await appendErrorEventIfOwner({
      event_id: 'e1',
      session_id: 's3',
      word_id: 'CET4:abandon',
      kind: 'wrong',
      tabId: A,
      occurred_at: NOW,
    })
    ok(r1.inserted, 'T-A 事件首次落盘')
    eq(r1.event.tab_id, A, '事件行冻结写入时的 tab_id')
    eq(r1.event.lock_epoch, 0, '事件行冻结写入时的 lock_epoch')
    const r2 = await appendErrorEventIfOwner({
      event_id: 'e1',
      session_id: 's3',
      word_id: 'CET4:abandon',
      kind: 'wrong',
      tabId: A,
    })
    ok(!r2.inserted, 'T-A 重放幂等，不增行')
    eq(await EVENTS.count(), 1, '事件表仍只有 1 行')

    // 新生产路径把事件与凭证放进同一事务：S1「T-A 已落、T-B 未落」窗口已不存在。
    // 断言比原先更强：直接 settled、凭证已写、drain 无活可干。
    ok(
      (await rowOf('s3')).applied_error_event_ids?.e1 === true,
      '同事务：凭证与事件一起落库（S1 窗口关闭）',
    )
    eq((await eventOf('e1')).status, 'settled', '同事务：事件状态直接为 settled')
    const d1 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(d1.scanned, 0, '生产路径不产生 pending，drain 无需重放（U11/U1 消除）')

    const d2 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(d2.scanned, 0, '重复 drain 无 pending，不重复重放')
    eq(
      await settleErrorEvent('s3', 'e1', { tabId: A, now: NOW }),
      'already_settled',
      '直接重复 settle 返回 already_settled',
    )
    eq(
      Object.keys((await rowOf('s3')).applied_error_event_ids ?? {}).length,
      1,
      '幂等结算不重复写凭证',
    )

    // S2：T-B 已提交、T-C 未提交（status 落后）
    await EVENTS.put({ ...(await eventOf('e1')), status: 'pending' } as never)
    const d3 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(d3.alreadySettled, 1, 'S2 查凭证跳过 T-B')
    eq(d3.settled, 0, 'S2 不重复归零/重复结算')
    eq((await eventOf('e1')).status, 'settled', 'S2 补 T-C 状态标记')
    eq(
      Object.keys((await rowOf('s3')).applied_error_event_ids ?? {}).length,
      1,
      'S2 凭证数不变',
    )

    // C09/T29：A 的 in-flight 事件在 B 接管后才落盘 → stale 收敛
    await EVENTS.put(seedEvent('e-stale', 's3', { tab_id: A, lock_epoch: 0 }) as never)
    await SESSIONS.put({
      ...(await rowOf('s3')),
      active_tab_id: B,
      lock_epoch: 1,
      lock_held_at: NOW,
    } as never)
    const d4 = await drainPendingEvents({ tabId: B, now: NOW })
    eq(d4.settledSkipped, 1, 'stale 事件判 settled_skipped')
    eq((await eventOf('e-stale')).status, 'settled_skipped', 'stale 事件状态已终结')
    eq((await eventOf('e-stale')).settle_reason, 'stale_epoch', 'stale 原因码为 stale_epoch')
    // P0 语义升级：stale 凭证从 true 改为 'stale'（原来统一写 true 会把旧代次
    // 事件误判为 SETTLED_ZEROED，污染活动错词本）。断言同步升级为「凭证带结论 +
    // classify 判 SETTLED_STALE + 不计入 active」，比原 === true 更严格。
    eq(
      (await rowOf('s3')).applied_error_event_ids?.['e-stale'],
      'stale',
      'stale 写带结论的凭证，杜绝永久 pending',
    )
    const staleRow = (await eventOf('e-stale')) as unknown as {
      event_id: string
      session_id: string
      lock_epoch?: number
    }
    const staleSession = (await SESSIONS.get('s3')) as never
    eq(
      classify(staleRow, { session: staleSession, covered: new Set<string>() }),
      'SETTLED_STALE',
      'P0：旧代次事件分类为 SETTLED_STALE',
    )
    const staleStats = aggregateErrorStats(
      [staleRow],
      (sid) => (sid === 's3' ? staleSession : null),
    )
    eq(staleStats.active_wrong_count, 0, 'P0：旧代次事件不计入活动错词事件数')
    eq(staleStats.total_error_events, 1, 'P0：旧代次事件仍计入历史错误事件行数')
    const d5 = await drainPendingEvents({ tabId: B, now: NOW })
    eq(d5.scanned, 0, 'stale 事件不再无限重放')
  })

  /* ---------------- 组 4 · U16 恢复链 ---------------- */
  await group('4 · U16 升级中断恢复（C60/C62/S5）', async () => {
    await resetDb()
    await putSession('s4', { active_tab_id: A, lock_epoch: 7, lock_held_at: NOW })
    await EVENTS.put(seedEvent('e4', 's4', { tab_id: A, lock_epoch: 7 }) as never)

    invalidateLocalLocks()
    ok(isLockInvalidated(), 'versionchange 后内存态全部失效')
    await expectLockError(
      () => assertSessionLock('s4', { tabId: A }),
      'LOCK_UNAVAILABLE',
      '重新 open ≠ 已持锁：未走恢复链前写入被拒',
    )

    const d0 = await drainPendingEvents({ tabId: A })
    eq(d0.sessionsSkipped, 1, 'S5 降级态下 drain 不抢锁、页面保持只读')
    eq((await eventOf('e4')).status, 'pending', '事件保留 pending，不丢不假报成功')

    const r = await resetAfterReconnect('s4', { tabId: A, now: NOW })
    eq(r.epoch, 7, '恢复链重新读取 lock_epoch，未沿用内存旧值')
    ok(!isLockInvalidated(), '恢复链完成后解除只读降级')
    const d1 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(d1.settled, 1, '恢复链 drain 补结算成功')

    // C62：跳过 acquireLock 直接结算，以未持锁标签身份 → 必须被判失败
    await EVENTS.put(seedEvent('e5', 's4', { tab_id: B, lock_epoch: 7 }) as never)
    await expectLockError(
      () => settleErrorEvent('s4', 'e5', { tabId: B }),
      'TAB_LOCK_LOST',
      '注入「跳过 acquireLock」应被测试判定为失败',
    )
    eq((await eventOf('e5')).status, 'pending', '被拒结算的事件保持 pending')
  })

  /* ---------------- 组 5 · V1 真实写路径 ---------------- */
  await group('5 · V1 生产写路径真实接入（不是只在测试里存在）', async () => {
    await resetDb()
    await putSession('s5', {
      active_tab_id: TAB_ID,
      lock_epoch: 0,
      lock_held_at: Date.now(),
    })
    const { submitAttempt } = await import('../src/domain/spellingSession')

    const wrong = await submitAttempt({
      word_id: 'CET4:abandon',
      input: 'wrng',
      request_id: 'req-w1',
    })
    eq(wrong.result.result, 'wrong', '错误提交判定为 wrong')
    eq(await EVENTS.count(), 1, '生产写路径落 1 条错词事件')

    const ev = await eventOf('evt:req-w1')
    eq(ev.status, 'settled', 'T-C 状态标记完成')
    eq(ev.tab_id, TAB_ID, '事件行带当前标签 id')
    eq(ev.lock_epoch, 0, '事件行冻结当前代次')
    ok(
      (await rowOf('s5')).applied_error_event_ids?.['evt:req-w1'] === true,
      'T-B 凭证与 V1 状态在同一次会话写入内落库',
    )

    await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'req-w1' })
    eq(await EVENTS.count(), 1, '同 request_id 重放不产生第二行')
    eq(
      Object.keys((await rowOf('s5')).applied_error_event_ids ?? {}).length,
      1,
      '重放不重复结算',
    )

    await submitAttempt({ word_id: 'CET4:abandon', input: 'abandon', request_id: 'req-c1' })
    eq(await EVENTS.count(), 1, '正确提交不写错词事件')

    const d = await drainPendingEvents()
    eq(d.scanned, 0, '正常路径无遗留 pending 事件')
  })

  /* ---------------- 组 6 · 行内字段 / schema ---------------- */
  await group('6 · v14 行内字段不改 schema', async () => {
    await resetDb()
    await EVENTS.put(
      seedEvent('e6', 's6', {
        tab_id: 'any-tab',
        lock_epoch: 9,
        settled_at: NOW,
        settle_reason: 'stale_epoch',
      }) as never,
    )
    const row = await eventOf('e6')
    eq(row.tab_id, 'any-tab', '新增行内字段可回读（无版本升级）')
    eq(row.lock_epoch, 9, 'lock_epoch 行内字段可回读')
    eq(row.settle_reason, 'stale_epoch', '原因码可回读')
    eq((await EVENTS.whereIndex('status', 'pending')).length, 1, 'status 索引仍可用')
    eq((await EVENTS.whereIndex('session_id', 's6')).length, 1, 'session_id 索引仍可用')
  })

  /* ---------------- 组 7 · U11/U1 跨表竞态 ---------------- */
  await group('7 · U11/U1 跨表竞态（C09/T29 窗口：接管插在写前校验与落盘之间）', async () => {
    await resetDb()
    const MY = TAB_ID
    const OTHER = 'tab-rival'
    await putSession('race', {
      active_tab_id: MY,
      lock_epoch: 0,
      lock_held_at: Date.now(),
    })

    const restore = injectTakeoverBeforeEventWrite('race', OTHER)
    const { submitAttempt } = await import('../src/domain/spellingSession')
    let rejected: unknown = null
    try {
      await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'race-1' })
    } catch (err) {
      rejected = err
    }
    restore()

    const rows = await EVENTS.toArray()
    const session = await rowOf('race')
    ok(
      rows.length === 0,
      'C09/T29：接管插在写前校验与落盘之间时，旧标签零事件落盘（U1 消除）',
    )
    eq(session.active_tab_id, OTHER, '接管方持锁')
    eq(session.lock_epoch, 1, 'fencing token 恰 +1')
    ok(
      session.applied_error_event_ids?.['evt:race-1'] !== true,
      '旧标签未写入结算凭证（事件与凭证必须同事务）',
    )
    ok(
      rejected instanceof SpellingLockError && rejected.code === 'TAB_LOCK_LOST',
      '旧标签提交被明确拒绝（不静默丢弃、不假报成功）',
    )
    ok(hasAtomicBatch(), '存储层提供跨表原子批事务 atomicBatch')
  })

  /* ---------------- 组 8 · 跨表事务原子性 / 并发 / 恢复 ---------------- */
  await group('8 · atomicBatch 原子性、并发、abort、严格锁校验、重启 drain', async () => {
    const TABLES = ['spellingSessions', 'spellingErrorEvents'] as const

    /* 8.1 commit / commit:false / 抛错回滚（dexie + memory 双驱动） */
    await resetDb()
    await putSession('batch', { lock_epoch: 0 })
    const committed = await storage.atomicBatch(TABLES, async (t) => {
      await t.spellingErrorEvents.addIfAbsent(seedEvent('b1', 'batch') as never)
      const s = await t.spellingSessions.get('batch')
      await t.spellingSessions.put({ ...s!, lock_epoch: 99 } as never)
      return { commit: true, result: 'ok' }
    })
    ok(committed.committed, 'commit=true 事务提交')
    eq(await EVENTS.count(), 1, '提交后事件表 1 行')
    eq((await rowOf('batch')).lock_epoch, 99, '提交后会话写入生效')

    const rolledBack = await storage.atomicBatch(TABLES, async (t) => {
      await t.spellingErrorEvents.addIfAbsent(seedEvent('b2', 'batch') as never)
      const s = await t.spellingSessions.get('batch')
      await t.spellingSessions.put({ ...s!, lock_epoch: 123 } as never)
      return { commit: false, result: 'rollback' }
    })
    eq(rolledBack.committed, false, 'commit=false 返回 committed=false')
    eq(await EVENTS.count(), 1, 'commit=false 事件表无新增（两表同事务回滚）')
    eq((await rowOf('batch')).lock_epoch, 99, 'commit=false 会话写入被回滚')

    let threw = false
    try {
      await storage.atomicBatch(TABLES, async (t) => {
        await t.spellingErrorEvents.addIfAbsent(seedEvent('b3', 'batch') as never)
        await t.spellingSessions.put({ ...(await t.spellingSessions.get('batch'))!, lock_epoch: 456 } as never)
        throw new Error('injected transaction abort')
      })
    } catch {
      threw = true
    }
    ok(threw, 'scope 抛错原样冒泡')
    eq(await EVENTS.count(), 1, '事务 abort 事件表无新增')
    eq((await rowOf('batch')).lock_epoch, 99, '事务 abort 会话写入被回滚')

    // memory 驱动对照：同样语义
    await memoryStorage.table('spellingSessions').put(seedSession('mb', { lock_epoch: 0 }) as never)
    const memOk = await memoryStorage.atomicBatch(TABLES, async (t) => {
      await t.spellingErrorEvents.addIfAbsent(seedEvent('mb1', 'mb') as never)
      await t.spellingSessions.put({ ...(await t.spellingSessions.get('mb'))!, lock_epoch: 7 } as never)
      return { commit: true, result: 'ok' }
    })
    const memRollback = await memoryStorage.atomicBatch(TABLES, async (t) => {
      await t.spellingErrorEvents.addIfAbsent(seedEvent('mb2', 'mb') as never)
      await t.spellingSessions.put({ ...(await t.spellingSessions.get('mb'))!, lock_epoch: 8 } as never)
      return { commit: false, result: 'no' }
    })
    ok(memOk.committed && !memRollback.committed, 'memory 驱动 commit/rollback 语义一致')
    const memEpoch = (await memoryStorage.table('spellingSessions').get('mb')) as unknown as Record<string, any>
    eq(memEpoch.lock_epoch, 7, 'memory 驱动回滚后会话值不变')

    /* 8.2 重复 event_id 幂等（同事务内 + 跨事务生产重放） */
    await resetDb()
    await putSession('dup', { active_tab_id: TAB_ID, lock_epoch: 0, lock_held_at: Date.now() })
    const dup = await storage.atomicBatch(TABLES, async (t) => {
      const first = await t.spellingErrorEvents.addIfAbsent(seedEvent('dup1', 'dup') as never)
      const second = await t.spellingErrorEvents.addIfAbsent(seedEvent('dup1', 'dup') as never)
      return { commit: true, result: { first, second } }
    })
    ok(dup.result.first && !dup.result.second, '同事务内重复主键：首次 true、再次 false')
    eq(await EVENTS.count(), 1, '重复主键不增行')

    const { submitAttempt } = await import('../src/domain/spellingSession')
    await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'dup-req' })
    await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'dup-req' })
    ok((await EVENTS.get('evt:dup-req')) !== undefined, '生产路径落了 evt:dup-req 事件')
    eq(await EVENTS.count(), 2, '手工行 + 生产行，重放不增第三行')
    const dupSession = await rowOf('dup')
    eq(Object.keys(dupSession.applied_error_event_ids ?? {}).length, 1, '重放不重复写凭证')

    /* 8.3 两个并发批事务串行化（不是 last-writer-wins） */
    await resetDb()
    await putSession('conc', { active_tab_id: TAB_ID, lock_epoch: 0, lock_held_at: Date.now() })
    const runConcurrent = (id: string) =>
      storage.atomicBatch(TABLES, async (t) => {
        const s = await t.spellingSessions.get('conc')
        const check = assertLockInTransaction(s, TAB_ID)
        if (!check.ok) return { commit: false, result: false }
        await t.spellingErrorEvents.addIfAbsent(seedEvent(id, 'conc') as never)
        await t.spellingSessions.put({
          ...s!,
          applied_error_event_ids: { ...(s!.applied_error_event_ids ?? {}), [id]: true },
        } as never)
        return { commit: true, result: true }
      })
    const [c1, c2] = await Promise.all([runConcurrent('c1'), runConcurrent('c2')])
    ok(c1.committed && c2.committed, '两个并发批事务都提交（rw 事务串行化）')
    eq(await EVENTS.count(), 2, '并发两行事件都落盘，无覆盖')
    eq(Object.keys((await rowOf('conc')).applied_error_event_ids ?? {}).length, 2, '并发两条凭证都保留')

    /* 8.4 严格锁校验：租约过期也不在写路径静默接管 */
    await resetDb()
    await putSession('strict', { active_tab_id: 'other-tab', lock_epoch: 3, lock_held_at: 1 })
    let strictErr: unknown = null
    try {
      await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'strict-1' })
    } catch (e) {
      strictErr = e
    }
    ok(
      strictErr instanceof SpellingLockError && strictErr.code === 'TAB_LOCK_LOST',
      '租约过期也不静默接管，旧标签写路径被拒',
    )
    eq((await rowOf('strict')).lock_epoch, 3, '旧标签未偷偷递增 epoch')
    eq(await EVENTS.count(), 0, '被拒提交零事件落盘')
    const forced = await acquireSessionLock('strict', { now: Date.now(), tabId: TAB_ID })
    ok(forced.takenOver && forced.epoch === 4, '显式 acquireSessionLock 仍可租约过期接管')

    /* 8.5 versionchange 降级：生产提交被拒且零落盘 */
    await resetDb()
    await putSession('vc', { active_tab_id: TAB_ID, lock_epoch: 0, lock_held_at: Date.now() })
    invalidateLocalLocks()
    let vcErr: unknown = null
    try {
      await submitAttempt({ word_id: 'CET4:abandon', input: 'wrng', request_id: 'vc-1' })
    } catch (e) {
      vcErr = e
    }
    ok(
      vcErr instanceof SpellingLockError && vcErr.code === 'LOCK_UNAVAILABLE',
      'versionchange 降级后提交被 LOCK_UNAVAILABLE 拒绝',
    )
    eq(await EVENTS.count(), 0, '降级态零事件落盘')
    clearLockInvalidation()

    /* 8.6 历史 pending 事件（旧数据/升级遗留）重启 drain 收敛 */
    await resetDb()
    await putSession('legacy', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW })
    await EVENTS.put(seedEvent('e-legacy', 'legacy', { tab_id: A, lock_epoch: 0 }) as never)
    invalidateLocalLocks()
    const reboot = await resetAfterReconnect('legacy', { tabId: A, now: NOW })
    eq(reboot.epoch, 0, '重启恢复链重读 epoch')
    const drain1 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(drain1.scanned, 1, '历史 pending 被扫到')
    eq(drain1.settled, 1, '补写凭证恰一次')
    ok((await rowOf('legacy')).applied_error_event_ids?.['e-legacy'] === true, '历史事件凭证已补')
    eq((await eventOf('e-legacy')).status, 'settled', '历史事件状态收敛')
    eq(await settleErrorEvent('legacy', 'e-legacy', { tabId: A }), 'already_settled', '重复结算幂等')
    const drain2 = await drainPendingEvents({ tabId: A, now: NOW })
    eq(drain2.scanned, 0, '收敛后不再重放')

    /* 8.7 takeover 后旧标签的独立事件 API 与结算都被拒 */
    await resetDb()
    await putSession('reject', { active_tab_id: A, lock_epoch: 0, lock_held_at: Date.now() })
    await EVENTS.put(seedEvent('e-old', 'reject', { tab_id: A, lock_epoch: 0 }) as never)
    await takeoverSessionLock('reject', { confirmed: true, tabId: B })
    await expectLockError(
      () =>
        appendErrorEventIfOwner({
          event_id: 'e-after-takeover',
          session_id: 'reject',
          word_id: 'CET4:abandon',
          kind: 'wrong',
          tabId: A,
        }),
      'TAB_LOCK_LOST',
      '旧标签独立事件 API 被拒',
    )
    eq(await EVENTS.count(), 1, '被拒后事件表无新增')
    await expectLockError(
      () => settleErrorEvent('reject', 'e-old', { tabId: A }),
      'TAB_LOCK_LOST',
      '旧标签结算被拒',
    )
    eq((await eventOf('e-old')).status, 'pending', '被拒结算的事件保留 pending（不丢）')
  })

  console.log(`\n${'─'.repeat(60)}`)
  if (failed === 0) {
    console.log(`✅ 可靠性回归全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ 可靠性回归失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run().catch((err) => {
  console.error('❌ 测试执行异常', err)
  process.exit(1)
})
