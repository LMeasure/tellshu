/**
 * 单词默写 V2 · P1 U16 升级中断恢复 · 自动化验证
 * ------------------------------------------------------------------
 * 协议五步：① versionchange 关闭连接 / 丢弃旧内存锁状态
 *          ② 重新 open + 重读会话与 lock_epoch
 *          ③ 重新 acquireLock（重新 open ≠ 已持锁）
 *          ④ drainPendingErrors（带失败重试）
 *          ⑤ 仅当收敛才允许恢复输入
 *
 * 覆盖：
 *   S1  versionchange 降级：写路径全拒、零落盘、输入闸门关闭
 *   S2  重新 open ≠ 已持锁：跳过 acquireLock 直接结算被拒
 *   S3  五步链成功：收敛、事件与凭证幂等补结算
 *   S4  恢复链失败（他人持锁）：converged=false，不得开启输入
 *   S5  T-B 首次失败 → drain 重试后收敛
 *   S6  重复恢复链 / 重复 drain 幂等，不重复归零
 *   S7  边界登记：T-A 尚未持久化的事件不在保证范围（不宣称绝对不丢）
 *
 * 运行：npx tsx scripts/test_spelling_u16_recovery.ts
 * ⚠️ 本脚本为**自动化层**；db.close() 的 in-flight 逐拍时序、跨内核矩阵、
 *    真实移动设备与软键盘仍需真机，本脚本不替代（N/A 如实登记）。
 */

import 'fake-indexeddb/auto'
import { storage } from '../src/services/storage'
import {
  TAB_ID,
  assertLockInTransaction,
  clearLockInvalidation,
  invalidateLocalLocks,
  isLockInvalidated,
} from '../src/domain/spellingLock'
import {
  drainPendingEvents,
  runRecoveryChain,
  settleErrorEvent,
} from '../src/domain/spellingErrorEvents'
import type { SpellingSession } from '../src/domain/spelling'
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
function eq<T>(a: T, b: T, msg: string): void {
  ok(a === b, `${msg}（期望 ${String(b)}，实际 ${String(a)}）`)
}
async function group(t: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${t}`)
  await fn()
}

const NOW = 1_700_000_000_000
const A = 'tab-A'
const B = 'tab-B'
const SESSIONS = storage.table('spellingSessions')
const EVENTS = storage.table('spellingErrorEvents')

function session(id: string, over: Record<string, unknown> = {}): SpellingSession {
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
function event(id: string, sid: string, over: Record<string, unknown> = {}): SpellingErrorEvent {
  return {
    event_id: id,
    owner: 'guest',
    word_id: 'CET4:abandon',
    session_id: sid,
    kind: 'wrong',
    occurred_at: NOW,
    status: 'pending',
    tab_id: A,
    lock_epoch: 0,
    ...over,
  } as SpellingErrorEvent
}
async function resetDb(): Promise<void> {
  await storage.clearAll()
  clearLockInvalidation()
}
async function row(id: string): Promise<SpellingSession> {
  return (await SESSIONS.get(id)) as unknown as SpellingSession
}
async function ev(id: string): Promise<SpellingErrorEvent> {
  return (await EVENTS.get(id)) as unknown as SpellingErrorEvent
}

/** 注入一次 atomicBatch 失败，模拟 T-B 首次写库失败；之后自动恢复 */
function injectOneBatchFailure(): () => void {
  const target = storage as unknown as Record<string, unknown>
  const orig = target.atomicBatch as (...a: unknown[]) => Promise<unknown>
  let fired = false
  target.atomicBatch = async (...args: unknown[]) => {
    if (!fired) {
      fired = true
      throw new Error('injected T-B write failure')
    }
    return orig.apply(storage, args)
  }
  return () => {
    target.atomicBatch = orig
  }
}

async function run(): Promise<void> {
  console.log('▶ P1 U16 升级中断恢复 · 五步链自动化验证')
  await storage.open()

  /* S1 · versionchange 降级 */
  await group('S1 · versionchange 后丢弃内存锁状态、写路径全拒、输入闸门关闭', async () => {
    await resetDb()
    await SESSIONS.put(session('u1', { active_tab_id: A, lock_epoch: 3 }) as never)
    await EVENTS.put(event('e1', 'u1', { lock_epoch: 3 }) as never)
    invalidateLocalLocks()
    ok(isLockInvalidated(), '旧内存锁状态已作废')
    const check = assertLockInTransaction(await row('u1'), A)
    ok(!check.ok && check.reason === 'LOCK_UNAVAILABLE', '事务内写前校验拒绝（不假设 close 后事务仍可继续）')
    let rejected = 0
    try {
      await settleErrorEvent('u1', 'e1', { tabId: A, now: NOW })
    } catch {
      rejected += 1
    }
    eq(rejected, 1, '降级态结算被明确拒绝')
    eq((await ev('e1')).status, 'pending', '事件保留 pending，不丢不假报成功')
    eq(await EVENTS.count(), 1, '零新增落盘')
  })

  /* S2 · 重新 open ≠ 已持锁 */
  await group('S2 · 重新 open 不等于重新取得写锁', async () => {
    await resetDb()
    await SESSIONS.put(session('u2', { active_tab_id: B, lock_epoch: 2, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e2', 'u2', { lock_epoch: 2, tab_id: B }) as never)
    invalidateLocalLocks()
    await storage.open() // 只恢复连接
    let rejected = 0
    try {
      // 跳过步骤 3（acquireLock），以未持锁标签身份直接结算
      await settleErrorEvent('u2', 'e2', { tabId: A, now: NOW })
    } catch {
      rejected += 1
    }
    eq(rejected, 1, '未重新取锁直接结算被拒')
    eq((await ev('e2')).status, 'pending', '事件仍为 pending，未被错误结算')
    // 走完整恢复链（本标签 A 接管 B 需显式 takeover，此处用 A 自己的会话再验）
    await SESSIONS.put(session('u2', { active_tab_id: A, lock_epoch: 2, lock_held_at: NOW }) as never)
    const chain = await runRecoveryChain('u2', { tabId: A, now: NOW })
    ok(chain.converged, '完整五步链后收敛')
    eq((await ev('e2')).status, 'settled', '收敛后事件结算完成')
  })

  /* S3 · 五步链成功 */
  await group('S3 · 五步链成功：重读 epoch / 重新取锁 / drain / 收敛', async () => {
    await resetDb()
    await SESSIONS.put(session('u3', { active_tab_id: A, lock_epoch: 7, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e3', 'u3', { lock_epoch: 7, tab_id: A }) as never)
    invalidateLocalLocks()
    const chain = await runRecoveryChain('u3', { tabId: A, now: NOW })
    eq(chain.epoch, 7, '重新读取到的 lock_epoch = 7，未沿用内存旧值')
    ok(!isLockInvalidated(), '恢复链完成后解除只读降级')
    eq(chain.drain.settled, 1, 'drain 恰补结算 1 条')
    ok(chain.converged, 'converged=true（输入闸门才允许开启）')
    eq(chain.drain.pendingRemaining, 0, 'pendingRemaining=0')
    eq((await row('u3')).applied_error_event_ids?.e3, true, '凭证已补')
    eq((await ev('e3')).status, 'settled', '状态收敛')
  })

  /* S4 · 恢复链失败，不得开输入 */
  await group('S4 · 他人持锁导致未收敛 → converged=false，输入保持禁用', async () => {
    await resetDb()
    await SESSIONS.put(session('u4', { active_tab_id: B, lock_epoch: 4, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e4', 'u4', { lock_epoch: 4, tab_id: B }) as never)
    // A 未获显式接管：取锁被拒 → 异常冒泡，页面应保持只读
    let rejected = 0
    try {
      await runRecoveryChain('u4', { tabId: A, now: NOW })
    } catch {
      rejected += 1
    }
    eq(rejected, 1, '取锁失败时恢复链明确抛错，不假报恢复成功')
    eq((await ev('e4')).status, 'pending', '事件保留 pending，不抢不丢')
    // 页面级闸门依据：降级态下 drain 不收敛
    invalidateLocalLocks()
    const d = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 'u4' })
    ok(!d.converged, 'drain 未收敛')
    eq(d.pendingRemaining, 1, '仍有 1 条未结算')
  })

  /* S5 · T-B 首次失败 → 重试收敛 */
  await group('S5 · T-B 首次写库失败 → drain 有限重试后收敛', async () => {
    await resetDb()
    await SESSIONS.put(session('u5', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e5', 'u5', { lock_epoch: 0, tab_id: A }) as never)
    const restore = injectOneBatchFailure()
    let d!: Awaited<ReturnType<typeof drainPendingEvents>>
    try {
      d = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 'u5', maxRetries: 2 })
    } finally {
      restore()
    }
    eq(d.retries, 1, '发生 1 轮重试')
    eq(d.failures.length, 0, '重试后无残留失败')
    eq(d.settled, 1, '恰结算 1 条，不重复结算')
    ok(d.converged, '重试后收敛')
    eq(await EVENTS.count(), 1, '事件表恒 1 行，不因重试增行')
    eq((await ev('e5')).status, 'settled', '状态收敛')
  })

  /* S6 · 重复恢复 / 重复 drain 幂等 */
  await group('S6 · 重复恢复链与重复 drain 幂等，不重复归零', async () => {
    await resetDb()
    await SESSIONS.put(session('u6', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW }) as never)
    await EVENTS.put(event('e6', 'u6', { lock_epoch: 0, tab_id: A }) as never)
    const c1 = await runRecoveryChain('u6', { tabId: A, now: NOW })
    const c2 = await runRecoveryChain('u6', { tabId: A, now: NOW })
    ok(c1.converged && c2.converged, '两次恢复链均收敛')
    eq(c2.drain.scanned, 0, '第二次无 pending 可扫')
    eq(Object.keys((await row('u6')).applied_error_event_ids ?? {}).length, 1, '凭证数恒 1，未重复归零')
    eq(await EVENTS.count(), 1, '事件行数恒 1')
    const d = await drainPendingEvents({ tabId: A, now: NOW, sessionId: 'u6' })
    eq(d.settled, 0, '重复 drain 不再结算')
    eq(d.retries, 0, '重复 drain 不触发重试')
  })

  /* S7 · 边界登记：T-A 未持久化 */
  await group('S7 · 边界：T-A 尚未持久化的事件不在 U16 保证范围（如实登记）', async () => {
    await resetDb()
    await SESSIONS.put(session('u7', { active_tab_id: A, lock_epoch: 0, lock_held_at: NOW }) as never)
    // 模拟「用户已按错，但事件行还没落盘」就升级中断：库里没有任何事件行
    invalidateLocalLocks()
    const chain = await runRecoveryChain('u7', { tabId: A, now: NOW })
    ok(chain.converged, '恢复链本身收敛（库内无待办）')
    eq(await EVENTS.count(), 0, '未持久化事件不会被恢复链凭空造出来')
    ok(true, '登记：不宣称「升级中断绝对不丢事件」；该场景需 V2 状态机前置持久化，属未实现范围')
  })

  console.log(`\n${'─'.repeat(64)}`)
  if (failed === 0) {
    console.log(`✅ U16 恢复链验证全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ U16 恢复链验证失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run().catch((err) => {
  console.error('❌ 测试执行异常', err)
  process.exit(1)
})
