/**
 * 跨标签单写者锁（C09/T29 · L2 会话级实现）
 * ------------------------------------------------------------------
 * 问题：两个标签页同时打开同一默写会话时，V1 的「读 → 改 → 整份 put」
 * 是 last-writer-wins，后写者会静默覆盖先写者，也会把对方的锁状态冲掉。
 *
 * 解法（与设计稿 α 自洽，同一套机制，不另立第二套锁）：
 *   · 锁状态写在**会话文档的行内可选字段**（active_tab_id / lock_epoch /
 *     lock_held_at），不改 Dexie schema、不新增 version；
 *   · 所有锁变更走 storage.updateAtomic —— 单表 rw 事务串行化，才是真正的
 *     compare-and-swap，而不是「应用层先读再写」的伪锁；
 *   · lock_epoch 为 fencing token：takeover 时原子 +1，旧代次落盘的事件
 *     由结算判 stale，只写凭证不归零，杜绝永久 pending。
 *
 * 【U11 / U1 已消除（本轮改造）】
 *   · 生产写路径不再用「独立只读校验 + 独立事件写入」，改走
 *     storage.atomicBatch 的**跨表 rw 事务**：会话锁校验、事件行写入、
 *     会话凭证写回在同一事务内，另一标签的 takeover 无法插入其间。
 *   · assertLockInTransaction 为事务内的**严格**校验：写路径不自动接管，
 *     失锁即整笔回滚；租约过期只允许显式 acquireSessionLock 兜底接管。
 *   · 因此不再产生「旧代次事件已落盘」的 stale 行（U1/C09/T29）；
 *     历史遗留的 stale 行仍由 settle 判 settled_skipped 兼容收敛。
 *
 * 【其余边界，不虚报】
 *   · 软租约只用于「允许强制接管」的安全兜底，不作为正确性判据；
 *     时钟回拨时一律不判过期。
 *   · 升级 blocked / versionchange 后本标签进入只读，必须重走
 *     resetAfterReconnect 五步链，重新 open ≠ 已持锁（U16 铁律 2）。
 *   · 旧 API assertSessionLock / appendErrorEventIfOwner 仍保留供兼容与测试，
 *     但生产写路径已不再依赖「事务外校验」。
 */

import { storage } from '../services/storage'
import {
  AtomicAbortError,
  type AtomicUpdate,
  type StorageLifecycleEvent,
} from '../services/storage/types'
import { uuid } from '../lib/uuid'
import type { SpellingSession } from './spelling'

/**
 * 标签生命周期内稳定的 id。
 * 优先复用 sessionStorage：同一标签刷新后 id 不变，启动 drain 才能重新取到自己的锁；
 * 新开标签会得到独立 id。隐私模式 / Node 测试环境退化为模块级 uuid（仅影响刷新后需重取锁）。
 */
const TAB_ID_KEY = 'shushu.spelling.tab_id'
function resolveTabId(): string {
  try {
    const store = globalThis.sessionStorage
    if (store) {
      const existing = store.getItem(TAB_ID_KEY)
      if (existing) return existing
      const id = uuid()
      store.setItem(TAB_ID_KEY, id)
      return id
    }
  } catch {
    // 不可用时不阻断启动
  }
  return uuid()
}
export const TAB_ID: string = resolveTabId()

/** 前台租约：持锁标签租约过期后，其它标签才允许强制接管 */
export const LOCK_LEASE_MS = 30_000
/** 后台标签受 setInterval 节流（可达 1/min），租约放宽避免误接管 */
export const LOCK_BACKGROUND_LEASE_MS = 120_000
/** 建议心跳周期（由页面 effect 驱动，本模块不放平台定时器） */
export const LOCK_HEARTBEAT_MS = 10_000

/**
 * 锁命令的可注入上下文。tabId 允许显式指定「扮演哪个标签」，
 * 使双标签并发能在同一进程内自动化验证（生产路径一律用默认 TAB_ID）。
 */
export interface LockOptions {
  background?: boolean
  now?: number
  tabId?: string
}

export type SpellingLockErrorCode =
  | 'TAB_LOCK_LOST'
  | 'LOCK_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'TAKEOVER_NOT_CONFIRMED'
  | 'OWNER_MISMATCH'
  | 'SESSION_MISMATCH'
  | 'EVENT_ROW_INVALID'

export class SpellingLockError extends Error {
  constructor(
    message: string,
    readonly code: SpellingLockErrorCode,
  ) {
    super(message)
    this.name = 'SpellingLockError'
  }
}

/** 本地内存态：db.close() / versionchange 后一律失效（U16 §7） */
const heldEpochs = new Map<string, number>()
let invalidated = false

storage.subscribeLifecycle((event) => {
  if (event.type === 'blocked' || event.type === 'versionchange') {
    heldEpochs.clear()
    invalidated = true
  }
})

/**
 * 供页面订阅底层连接生命周期（U16 触发源）。
 * 页面不直接 import storage，统一经领域层转发，保持平台 API 红线。
 */
export function subscribeLockLifecycle(
  listener: (event: StorageLifecycleEvent) => void,
): () => void {
  return storage.subscribeLifecycle(listener)
}

/** 升级阻塞 / 连接被抢占后是否处于只读降级态 */
export function isLockInvalidated(): boolean {
  return invalidated
}

/** 显式丢弃内存态（versionchange / 测试模拟中断） */
export function invalidateLocalLocks(): void {
  heldEpochs.clear()
  invalidated = true
}

/** 恢复链完成后的显式解降级；只由 resetAfterReconnect / takeover 调用 */
export function clearLockInvalidation(): void {
  invalidated = false
}

/** 是否租约过期；时钟回拨（now <= heldAt）一律不判过期 */
function isExpired(session: SpellingSession, now: number, leaseMs: number): boolean {
  const heldAt = session.lock_held_at ?? 0
  if (heldAt === 0) return true // 从未续期的老会话，视作可被接管
  if (now <= heldAt) return false
  return now - heldAt > leaseMs
}

function epochOf(session: SpellingSession | undefined): number {
  return session?.lock_epoch ?? 0
}

/* ------------------------------------------------------------------
 * 纯 reducer（可单测，不碰 storage）
 * ------------------------------------------------------------------ */

/** 取锁：空闲→取；自己→续期；他人未过期→拒绝；他人过期→强制接管（epoch+1） */
export function decideAcquire(
  current: SpellingSession | undefined,
  tabId: string,
  now: number,
  leaseMs: number = LOCK_LEASE_MS,
): { update: AtomicUpdate<SpellingSession>; epoch: number; takenOver: boolean } {
  if (!current) {
    return {
      update: { kind: 'abort', reason: 'SESSION_NOT_FOUND' },
      epoch: 0,
      takenOver: false,
    }
  }
  const epoch = epochOf(current)
  if (!current.active_tab_id || current.active_tab_id === tabId) {
    return {
      update: {
        kind: 'commit',
        value: { ...current, active_tab_id: tabId, lock_epoch: epoch, lock_held_at: now },
      },
      epoch,
      takenOver: false,
    }
  }
  if (!isExpired(current, now, leaseMs)) {
    return {
      update: { kind: 'abort', reason: 'TAB_LOCK_LOST' },
      epoch,
      takenOver: false,
    }
  }
  const nextEpoch = epoch + 1
  return {
    update: {
      kind: 'commit',
      value: {
        ...current,
        active_tab_id: tabId,
        lock_epoch: nextEpoch,
        lock_held_at: now,
      },
    },
    epoch: nextEpoch,
    takenOver: true,
  }
}

/** 显式接管：唯一不校验 active_tab_id 的路径，必须由 UI 明确确认 */
export function decideTakeover(
  current: SpellingSession | undefined,
  tabId: string,
  now: number,
): { update: AtomicUpdate<SpellingSession>; epoch: number } {
  if (!current) {
    return { update: { kind: 'abort', reason: 'SESSION_NOT_FOUND' }, epoch: 0 }
  }
  const epoch = epochOf(current) + 1
  return {
    update: {
      kind: 'commit',
      value: { ...current, active_tab_id: tabId, lock_epoch: epoch, lock_held_at: now },
    },
    epoch,
  }
}

/** 释放：旧标签不得清掉新锁，不匹配则 skip（不写回） */
export function decideRelease(
  current: SpellingSession | undefined,
  tabId: string,
): AtomicUpdate<SpellingSession> {
  if (!current) return { kind: 'abort', reason: 'SESSION_NOT_FOUND' }
  if (current.active_tab_id !== tabId) return { kind: 'skip' }
  return {
    kind: 'commit',
    value: { ...current, active_tab_id: undefined, lock_held_at: undefined },
  }
}

/** 心跳续期：锁已易主则拒绝，调用方应进入冲突面板 */
export function decideRenew(
  current: SpellingSession | undefined,
  tabId: string,
  now: number,
): AtomicUpdate<SpellingSession> {
  if (!current) return { kind: 'abort', reason: 'SESSION_NOT_FOUND' }
  if (current.active_tab_id !== tabId) return { kind: 'abort', reason: 'TAB_LOCK_LOST' }
  return { kind: 'commit', value: { ...current, lock_held_at: now } }
}

export type LockCheck = { ok: true; epoch: number } | { ok: false; reason: string }

/**
 * 事务内锁校验（严格版）：供 atomicBatch / updateAtomic 的 reducer 使用。
 * 与 decideAcquire 的区别：这里**不因租约过期而静默接管**。
 * 写路径若能在租约过期后自动 epoch+1 继续写，等于给旧标签开后门，
 * fencing token 就失去意义；接管必须走显式 acquireSessionLock / takeover。
 */
export function assertLockInTransaction(
  current: SpellingSession | undefined,
  tabId: string,
): LockCheck {
  if (!current) return { ok: false, reason: 'SESSION_NOT_FOUND' }
  if (invalidated) return { ok: false, reason: 'LOCK_UNAVAILABLE' }
  if (!current.active_tab_id || current.active_tab_id === tabId) {
    return { ok: true, epoch: epochOf(current) }
  }
  return { ok: false, reason: 'TAB_LOCK_LOST' }
}

/**
 * 写路径守卫：供会话 CAS reducer 复用。
 * current 是事务内读到的真值，next 是纯业务函数基于 current 算出的新文档；
 * 锁状态一律以 current 判定后覆盖回 next，杜绝旧标签把新锁字段冲掉。
 */
export function mergeLockState(
  current: SpellingSession | undefined,
  next: SpellingSession,
  tabId: string,
  now: number,
): AtomicUpdate<SpellingSession> {
  const check = assertLockInTransaction(current, tabId)
  if (!check.ok) return { kind: 'abort', reason: check.reason }
  return {
    kind: 'commit',
    value: {
      ...next,
      active_tab_id: tabId,
      lock_epoch: check.epoch,
      lock_held_at: now,
    },
  }
}

/* ------------------------------------------------------------------
 * 命令（走单表 CAS）
 * ------------------------------------------------------------------ */

export function toLockError(reason: string): SpellingLockError {
  switch (reason) {
    case 'SESSION_NOT_FOUND':
      return new SpellingLockError('默写会话不存在或已被删除', 'SESSION_NOT_FOUND')
    case 'LOCK_UNAVAILABLE':
      return new SpellingLockError(
        '数据正在升级或连接被其它标签抢占，当前为只读状态，请稍后重试',
        'LOCK_UNAVAILABLE',
      )
    case 'OWNER_MISMATCH':
      return new SpellingLockError('错词事件归属与会话不一致，已拒绝写入', 'OWNER_MISMATCH')
    case 'SESSION_MISMATCH':
      return new SpellingLockError('错词事件会话归属不一致，已拒绝结算', 'SESSION_MISMATCH')
    case 'EVENT_ROW_INVALID':
      return new SpellingLockError('错词事件字段校验失败，已拒绝写入', 'EVENT_ROW_INVALID')
    case 'EVENT_ID_REQUIRED':
    case 'TAB_MISMATCH':
    case 'EPOCH_MISMATCH':
      return new SpellingLockError('错词事件字段校验失败，已拒绝写入', 'EVENT_ROW_INVALID')
    default:
      return new SpellingLockError(
        '另一标签页正在使用本会话，本次写入已拒绝；如需在此继续请显式接管',
        'TAB_LOCK_LOST',
      )
  }
}

/** 把 AtomicAbortError 转成领域错误；其它异常（写库失败）原样抛出，不假报成功 */
export async function runLockAtomic<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AtomicAbortError) throw toLockError(err.reason)
    throw err
  }
}

export async function acquireSessionLock(
  sessionId: string,
  opts: LockOptions = {},
): Promise<{ epoch: number; takenOver: boolean }> {
  if (invalidated) throw toLockError('LOCK_UNAVAILABLE')
  const tabId = opts.tabId ?? TAB_ID
  const now = opts.now ?? Date.now()
  const leaseMs = opts.background ? LOCK_BACKGROUND_LEASE_MS : LOCK_LEASE_MS
  let outcome = { epoch: 0, takenOver: false }
  await runLockAtomic(() =>
    storage.updateAtomic('spellingSessions', sessionId, (current) => {
      const decided = decideAcquire(current, tabId, now, leaseMs)
      if (decided.update.kind === 'commit') {
        outcome = { epoch: decided.epoch, takenOver: decided.takenOver }
      }
      return decided.update
    }),
  )
  heldEpochs.set(sessionId, outcome.epoch)
  return outcome
}

export async function takeoverSessionLock(
  sessionId: string,
  opts: { confirmed: boolean; now?: number; tabId?: string },
): Promise<{ epoch: number }> {
  if (!opts.confirmed) {
    throw new SpellingLockError('接管需要用户显式确认', 'TAKEOVER_NOT_CONFIRMED')
  }
  const tabId = opts.tabId ?? TAB_ID
  const now = opts.now ?? Date.now()
  let epoch = 0
  await runLockAtomic(() =>
    storage.updateAtomic('spellingSessions', sessionId, (current) => {
      const decided = decideTakeover(current, tabId, now)
      if (decided.update.kind === 'commit') epoch = decided.epoch
      return decided.update
    }),
  )
  heldEpochs.set(sessionId, epoch)
  clearLockInvalidation()
  return { epoch }
}

export async function releaseSessionLock(sessionId: string, opts: LockOptions = {}): Promise<boolean> {
  const tabId = opts.tabId ?? TAB_ID
  const res = await runLockAtomic(() =>
    storage.updateAtomic('spellingSessions', sessionId, (current) =>
      decideRelease(current, tabId),
    ),
  )
  heldEpochs.delete(sessionId)
  return res.committed
}

/** 心跳：失败即本地降级为只读，由调用方进入冲突面板 */
export async function renewSessionLock(sessionId: string, opts: LockOptions = {}): Promise<void> {
  const tabId = opts.tabId ?? TAB_ID
  try {
    await runLockAtomic(() =>
      storage.updateAtomic('spellingSessions', sessionId, (current) =>
        decideRenew(current, tabId, opts.now ?? Date.now()),
      ),
    )
  } catch (err) {
    invalidateLocalLocks()
    throw err
  }
}

/**
 * T-A 写入前的锁校验（**独立只读请求**，与后续事件写入不构成跨表事务）。
 * 返回重读到的 lock_epoch —— 禁止沿用内存旧值（U16 铁律 2）。
 */
export async function assertSessionLock(sessionId: string, opts: LockOptions = {}): Promise<number> {
  if (invalidated) throw toLockError('LOCK_UNAVAILABLE')
  const tabId = opts.tabId ?? TAB_ID
  const session = await storage.table('spellingSessions').get(sessionId)
  if (!session) throw toLockError('SESSION_NOT_FOUND')
  if (session.active_tab_id !== tabId) throw toLockError('TAB_LOCK_LOST')
  // 软租约**只用于 decideAcquire 的强制接管兜底**，不在这里拦持锁者：
  // 否则标签休眠/时钟差异会把合法持有者误判为失锁。正确性由 epoch fencing 保证。
  const epoch = epochOf(session)
  heldEpochs.set(sessionId, epoch)
  return epoch
}

/**
 * U16 恢复链（五步中的 1–3）：重新 open → 重读会话 → 重新取锁。
 * 第 4 步 drain 与第 5 步解锁输入由调用方串行执行，缺一不可。
 */
export async function resetAfterReconnect(
  sessionId: string,
  opts: LockOptions = {},
): Promise<{ epoch: number; takenOver: boolean }> {
  await storage.open()
  const session = await storage.table('spellingSessions').get(sessionId)
  if (!session) throw toLockError('SESSION_NOT_FOUND')
  heldEpochs.clear()
  clearLockInvalidation()
  return acquireSessionLock(sessionId, opts)
}

/** 仅用于诊断/断言：本标签记录的代次（不参与正确性判定） */
export function heldEpoch(sessionId: string): number | undefined {
  return heldEpochs.get(sessionId)
}
