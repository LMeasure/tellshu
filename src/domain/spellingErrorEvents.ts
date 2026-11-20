/**
 * 错词事件写入 / 幂等结算 / 启动 drain（Dexie v14 · U16 恢复链）
 * ------------------------------------------------------------------
 * 【本轮改造：跨表原子化，消除 U11 / U1】
 * 实施 B 的 T-A / T-B / T-C 是三个独立请求，锁校验与事件写入之间可插入
 * 另一标签的 takeover（U11 跨表 TOCTOU），从而落盘一条旧代次事件、
 * 让错词本多一条 stale 记录（U1 / C09/T29）。
 *
 * 现在所有生产写路径走 storage.atomicBatch 的**同一个底层 rw 事务**：
 *   read 会话 → 严格校验 active_tab_id / lock_epoch
 *            → 写事件行（addIfAbsent 幂等）
 *            → 在同一份会话文档写 applied_error_event_ids 凭证
 *            → 写回会话 + 事件状态
 * IndexedDB 保证 scope 重叠的 rw 事务串行，接管事务无法插入其间；
 * 若接管先提交，本事务读到新锁即整笔回滚，**零事件落盘**。
 *
 * 【与 V1 状态机的关系 —— 不编造功能】
 * 设计稿的「cc 归零 / SRS」属于尚未实现的打字链路 V2 状态机；当前源码是 V1，
 * 判错效果已由 applyAttempt 落库。结算的「业务效果」是幂等消费 + 写凭证，
 * 通过 applyEvent 注入点预留 V2 语义；不重复计数、不伪造 V2 状态。
 *
 * 【不丢 / 不重】
 *   · 同一事务提交 → 事件行与凭证同生共死，不再有 S1「事件已落、凭证未落」；
 *   · 事务回滚 → 两者都不落，用户看到明确拒绝，不静默丢失、不假报成功；
 *   · 历史遗留 pending / 旧代次 stale 事件仍由 drain + settle 兼容收敛；
 *   · T-C status 为非权威展示态，markErrorEventStatus 保留作幂等补偿。
 */

import { storage } from '../services/storage'
import type {
  SpellingErrorEvent,
  SpellingErrorEventKind,
  SpellingErrorEventStatus,
} from './types'
import type { SpellingErrorCredential, SpellingSession } from './spelling'
import { aggregateErrorStats, type ErrorStats } from './spellingErrorStats'
import {
  aggregateWrongWordBook,
  collectCovered,
  type WrongBookEvent,
  type WrongWordBook,
} from './spellingWrongBook'
import {
  TAB_ID,
  acquireSessionLock,
  assertLockInTransaction,
  invalidateLocalLocks,
  resetAfterReconnect,
  toLockError,
} from './spellingLock'

const EVENTS = storage.table('spellingErrorEvents')
const DEFAULT_OWNER = 'guest'

export interface AppendErrorEventInput {
  /** 幂等键：V1 写路径用 `evt:${request_id}`，同一请求重放不会产生第二行 */
  event_id: string
  session_id: string
  word_id: string
  kind: SpellingErrorEventKind
  owner?: string
  occurred_at?: number
  /** 依赖注入：扮演哪个标签（双标签并发测试用），默认当前标签 TAB_ID */
  tabId?: string
}

export interface AppendErrorEventResult {
  /** false = 主键已存在（重放），行未增加 */
  inserted: boolean
  event: SpellingErrorEvent
}

/** 纯函数：构造事件行（事务内外共用，保证字段口径一致） */
export function buildErrorEvent(
  input: {
    event_id: string
    session_id: string
    word_id: string
    kind: SpellingErrorEventKind
    owner?: string
    occurred_at?: number
  },
  tabId: string,
  epoch: number,
  status: SpellingErrorEventStatus = 'pending',
): SpellingErrorEvent {
  return {
    event_id: input.event_id,
    owner: input.owner ?? DEFAULT_OWNER,
    word_id: input.word_id,
    session_id: input.session_id,
    kind: input.kind,
    occurred_at: input.occurred_at ?? Date.now(),
    status,
    tab_id: tabId,
    lock_epoch: epoch,
  }
}

/**
 * P0：事件写入上下文校验（owner / session / tab / lock_epoch）。
 * 纯函数，供 appendErrorEventIfOwner 与 atomicSubmit 在**事务内**共享调用。
 *
 * 校验的是「即将落盘的事件行」与「事务内重读到的会话文档」是否同源：
 *   · session_id 必须等于会话主键，防止把事件挂到别的会话；
 *   · owner 必须等于会话 owner，防止跨账号写入（读到 ≠ 展示/写入）；
 *   · tab_id 必须等于本次持锁标签，防止旧标签借重放落盘；
 *   · lock_epoch 必须等于事务内校验通过的代次，防止冻结值错误导致 classify 误判；
 *   · event_id 非空，保证主键幂等有依据。
 * 任一项不符即整笔回滚，不落一行、不假报成功。
 */
export type EventRowRejection =
  | 'EVENT_ID_REQUIRED'
  | 'SESSION_MISMATCH'
  | 'OWNER_MISMATCH'
  | 'TAB_MISMATCH'
  | 'EPOCH_MISMATCH'

export type EventRowCheck = { ok: true } | { ok: false; reason: EventRowRejection }

export function validateEventRow(
  event: Pick<SpellingErrorEvent, 'event_id' | 'session_id' | 'owner' | 'tab_id' | 'lock_epoch'>,
  session: SpellingSession,
  tabId: string,
  epoch: number,
): EventRowCheck {
  if (!event.event_id) return { ok: false, reason: 'EVENT_ID_REQUIRED' }
  if (event.session_id !== session.id) return { ok: false, reason: 'SESSION_MISMATCH' }
  if (event.owner !== (session.owner ?? DEFAULT_OWNER)) {
    return { ok: false, reason: 'OWNER_MISMATCH' }
  }
  if (event.tab_id !== tabId) return { ok: false, reason: 'TAB_MISMATCH' }
  if (event.lock_epoch !== epoch) return { ok: false, reason: 'EPOCH_MISMATCH' }
  return { ok: true }
}

type AppendBatchResult =
  | { kind: 'ok'; inserted: boolean; event: SpellingErrorEvent }
  | { kind: 'rejected'; reason: string }

/**
 * 独立 API：在**同一个跨表事务**内完成「锁校验 + 事件写入 + 凭证写回」。
 * 生产提交路径（spellingSession.atomicSubmit）自带业务状态机，走它自己的
 * 批事务；本函数用于兼容、补偿与测试，语义与生产路径一致。
 */
export async function appendErrorEventIfOwner(
  input: AppendErrorEventInput,
): Promise<AppendErrorEventResult> {
  const tabId = input.tabId ?? TAB_ID
  const now = input.occurred_at ?? Date.now()

  const batch = await storage.atomicBatch(
    ['spellingSessions', 'spellingErrorEvents'] as const,
    async (t): Promise<{ commit: boolean; result: AppendBatchResult }> => {
      const current = await t.spellingSessions.get(input.session_id)
      const check = assertLockInTransaction(current, tabId)
      if (!check.ok) {
        return { commit: false, result: { kind: 'rejected', reason: check.reason } }
      }
      // P0：owner 一律以事务内重读到的会话为准，不接受调用方注入的越权 owner
      const event = buildErrorEvent(
        { ...input, owner: current!.owner ?? DEFAULT_OWNER },
        tabId,
        check.epoch,
        'settled',
      )
      const rowCheck = validateEventRow(event, current!, tabId, check.epoch)
      if (!rowCheck.ok) {
        return { commit: false, result: { kind: 'rejected', reason: rowCheck.reason } }
      }
      const inserted = await t.spellingErrorEvents.addIfAbsent(event)
      // 同事务写凭证：仅在凭证**缺失**时补写（S1 兼容）。
      // 凭证已存在（含 'stale' / 'zeroed'）一律不动，重复提交绝不覆盖已有结算结论。
      if (current!.applied_error_event_ids?.[event.event_id] === undefined) {
        await t.spellingSessions.put({
          ...current!,
          applied_error_event_ids: {
            ...(current!.applied_error_event_ids ?? {}),
            [event.event_id]: true,
          },
          lock_held_at: now,
        })
      }
      return { commit: true, result: { kind: 'ok', inserted, event } }
    },
  )

  if (!batch.committed || batch.result.kind === 'rejected') {
    throw toLockError(batch.result.kind === 'rejected' ? batch.result.reason : 'LOCK_UNAVAILABLE')
  }
  return { inserted: batch.result.inserted, event: batch.result.event }
}

/**
 * T-C 独立入口：非权威展示态的幂等补偿。
 * 生产路径已把 status 与凭证放进同一事务，这里只用于兼容旧数据。
 */
export async function markErrorEventStatus(
  eventId: string,
  status: SpellingErrorEventStatus,
  reason?: string,
): Promise<void> {
  try {
    const event = await EVENTS.get(eventId)
    if (!event) return
    const next: SpellingErrorEvent = {
      ...event,
      status,
      settled_at: Date.now(),
      ...(reason ? { settle_reason: reason } : {}),
    }
    await EVENTS.put(next)
  } catch (err) {
    // 状态非权威，失败只告警，绝不回抛成「结算失败」
    console.warn('[spelling] 事件状态标记失败（非权威展示态）', err)
  }
}

export type SettleOutcome = 'missing' | 'already_settled' | 'settled' | 'settled_skipped'

export interface SettleOptions {
  now?: number
  /** 依赖注入：扮演哪个标签（双标签并发测试用） */
  tabId?: string
  /**
   * V2 业务效果注入点（如连对归零 / SRS）。默认不改 V1 会话状态：
   * V1 的判错效果已由 applyAttempt 落库，重复施加会造成计数漂移。
   */
  applyEvent?: (session: SpellingSession, event: SpellingErrorEvent) => SpellingSession
}

type SettleBatchResult =
  | { kind: 'outcome'; outcome: SettleOutcome }
  | { kind: 'rejected'; reason: string }

/**
 * 结算：**同一个跨表事务**内读事件行 + 读会话 + 凭证二次检查 +
 * 写凭证 + 写事件状态。并发两次 settle 由 rw 事务串行化，恰一次生效。
 */
export async function settleErrorEvent(
  sessionId: string,
  eventId: string,
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  const now = opts.now ?? Date.now()
  const tabId = opts.tabId ?? TAB_ID

  const batch = await storage.atomicBatch(
    ['spellingSessions', 'spellingErrorEvents'] as const,
    async (t): Promise<{ commit: boolean; result: SettleBatchResult }> => {
      const event = await t.spellingErrorEvents.get(eventId)
      if (!event) {
        return { commit: true, result: { kind: 'outcome', outcome: 'missing' } }
      }
      const current = await t.spellingSessions.get(sessionId)
      if (!current) {
        return { commit: false, result: { kind: 'rejected', reason: 'SESSION_NOT_FOUND' } }
      }

      // P0-1：凭证二次检查拥有最高优先级，重复 drain 直接不写回。
      // 「存在即已结算」——不能只认 === true：'zeroed' / 'stale' 也是终局凭证，
      // 漏判会对同一事件重复归零 / 重复触发 V2 业务效果。
      const existingCredential = current.applied_error_event_ids?.[eventId]
      if (existingCredential !== undefined) {
        if (event.status === 'pending') {
          await t.spellingErrorEvents.put({
            ...event,
            status: existingCredential === 'stale' ? 'settled_skipped' : 'settled',
            settled_at: now,
          })
        }
        return { commit: true, result: { kind: 'outcome', outcome: 'already_settled' } }
      }

      // P0：事件归属校验——防止把 A 会话 / A 账号的事件结算到 B 会话文档上。
      // 注意：此处**不**校验 tab_id / lock_epoch，旧代次事件本就与当前持锁者不同，
      // 它们是 stale 判定依据而不是拒绝理由。
      if (event.session_id !== sessionId || event.session_id !== current.id) {
        return { commit: false, result: { kind: 'rejected', reason: 'SESSION_MISMATCH' } }
      }
      if (event.owner !== (current.owner ?? DEFAULT_OWNER)) {
        return { commit: false, result: { kind: 'rejected', reason: 'OWNER_MISMATCH' } }
      }

      const check = assertLockInTransaction(current, tabId)
      if (!check.ok) {
        return { commit: false, result: { kind: 'rejected', reason: check.reason } }
      }

      // 历史遗留的旧代次事件：写凭证终结重放，但不归零、不触发 SRS。
      // 凭证必须带结论：'stale' 使 classify 判 SETTLED_STALE（不计入活动错词本），
      // true（= 'zeroed'）使本代次判 SETTLED_ZEROED（计入）。旧实现统一写 true，
      // 旧代次事件因此被误计入活动错词本，即 P0 第 5 条要修的污染路径。
      const stale = (event.lock_epoch ?? 0) !== check.epoch
      const credential: SpellingErrorCredential = stale ? 'stale' : true
      const credentials: Record<string, SpellingErrorCredential> = {
        ...(current.applied_error_event_ids ?? {}),
        [eventId]: credential,
      }
      const applied = stale || !opts.applyEvent ? current : opts.applyEvent(current, event)
      await t.spellingSessions.put({
        ...applied,
        applied_error_event_ids: credentials,
        lock_held_at: now,
      })
      await t.spellingErrorEvents.put({
        ...event,
        status: stale ? 'settled_skipped' : 'settled',
        settled_at: now,
        ...(stale ? { settle_reason: 'stale_epoch' } : {}),
      })
      return {
        commit: true,
        result: {
          kind: 'outcome',
          outcome: stale ? 'settled_skipped' : 'settled',
        },
      }
    },
  )

  if (!batch.committed) {
    if (batch.result.kind === 'rejected') throw toLockError(batch.result.reason)
    throw new Error('[spelling] 结算事务未提交')
  }
  return batch.result.kind === 'outcome' ? batch.result.outcome : 'already_settled'
}

export interface DrainResult {
  /** 扫描到的 pending 事件数 */
  scanned: number
  settled: number
  settledSkipped: number
  alreadySettled: number
  /** 被其它活跃标签持锁而跳过的会话数（事件保留 pending，不抢不丢） */
  sessionsSkipped: number
  failures: Array<{ event_id: string; reason: string }>
  /** 本轮 drain 后仍为 pending 的事件数（收敛判据之一） */
  pendingRemaining: number
  /** 重试轮数（0 = 未发生重试） */
  retries: number
  /** 是否收敛：无失败、且本作用域内不再有 pending 事件 */
  converged: boolean
}

export interface DrainOptions {
  now?: number
  background?: boolean
  tabId?: string
  /** 仅 drain 指定会话（U16 恢复链用）；省略则扫描全表 */
  sessionId?: string
  /** 失败事件的最大额外重试轮数，默认 2 */
  maxRetries?: number
}

/**
 * 启动 / 重连后的恢复入口（U16 五步链第 4 步）。
 * 只结算「本标签能取到锁」的会话：被别的活跃标签持锁时保留 pending，
 * 由持锁标签自己 drain；持锁标签崩溃后租约过期，下次启动可接管并结算。
 *
 * P0：失败事件有限重试 + 收敛判定。重复 drain 天然幂等（event_id 主键 +
 * 凭证二次检查），因此重试不会产生第二行、不会重复归零。
 * converged=false 时调用方**不得**启用输入（U16 第 5 步闸门）。
 */
export async function drainPendingEvents(opts: DrainOptions = {}): Promise<DrainResult> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2)
  const result: DrainResult = {
    scanned: 0,
    settled: 0,
    settledSkipped: 0,
    alreadySettled: 0,
    sessionsSkipped: 0,
    failures: [],
    pendingRemaining: 0,
    retries: 0,
    converged: false,
  }

  const scoped = (rows: SpellingErrorEvent[]): SpellingErrorEvent[] =>
    opts.sessionId ? rows.filter((e) => e.session_id === opts.sessionId) : rows

  let pending: SpellingErrorEvent[]
  try {
    pending = scoped(await EVENTS.whereIndex('status', 'pending'))
  } catch (err) {
    // 启动期不阻断渲染；如实告警，绝不假装「没有待结算事件」
    console.warn('[spelling] 启动 drain 扫描失败，待结算事件将在下次启动重试', err)
    result.converged = false
    return result
  }
  result.scanned = pending.length
  if (pending.length === 0) {
    result.converged = true
    return result
  }

  let batch = pending
  for (let round = 0; round <= maxRetries; round += 1) {
    const grouped = new Map<string, SpellingErrorEvent[]>()
    for (const event of batch) {
      const list = grouped.get(event.session_id)
      if (list) list.push(event)
      else grouped.set(event.session_id, [event])
    }

    const failures: DrainResult['failures'] = []
    for (const [sessionId, events] of grouped) {
      try {
        await acquireSessionLock(sessionId, {
          now: opts.now,
          background: opts.background,
          tabId: opts.tabId,
        })
      } catch {
        // 其它活跃标签持锁：保留 pending，不抢不丢；不做无效重试
        result.sessionsSkipped += 1
        continue
      }
      for (const event of events) {
        try {
          const outcome = await settleErrorEvent(sessionId, event.event_id, {
            now: opts.now,
            tabId: opts.tabId,
          })
          if (outcome === 'settled') result.settled += 1
          else if (outcome === 'settled_skipped') result.settledSkipped += 1
          else if (outcome === 'already_settled') result.alreadySettled += 1
        } catch (err) {
          failures.push({
            event_id: event.event_id,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    result.failures = failures
    if (failures.length === 0 || round === maxRetries) break
    // 只重试仍为 pending 的失败事件，不重新扫出新的 pending 计入 scanned
    result.retries += 1
    batch = batch.filter((e) => failures.some((f) => f.event_id === e.event_id))
  }

  // 收敛复核：重新读一次持久化状态，不依赖内存计数、不依赖 status 之外的推断
  try {
    result.pendingRemaining = scoped(await EVENTS.whereIndex('status', 'pending')).length
  } catch {
    // 读不到就判未收敛，绝不假报成功
    result.pendingRemaining = Math.max(1, result.failures.length)
  }
  result.converged = result.failures.length === 0 && result.pendingRemaining === 0
  return result
}

/* ------------------------------------------------------------------
 * P1 · U16 升级中断恢复链（domain 编排，五步缺一不可）
 * ------------------------------------------------------------------ */

export interface RecoveryChainResult {
  epoch: number
  takenOver: boolean
  drain: DrainResult
  /** 只有 true 才允许调用方启用输入 */
  converged: boolean
}

/**
 * U16 恢复链，严格按序执行：
 *   1. versionchange / blocked 后丢弃旧内存锁状态（invalidateLocalLocks）；
 *      底层 db.close() 由 storage 层负责，本函数**不假设**被关闭连接上的
 *      in-flight 事务仍能继续（铁律 1）。
 *   2. 重新打开数据库 + 重新读取会话文档与 lock_epoch（resetAfterReconnect 内）。
 *   3. 重新 acquireLock —— 重新 open **不等于**已取得写锁（铁律 2）。
 *   4. drainPendingEvents（带失败重试）。
 *   5. 返回 converged；启用输入是**调用方**的最后一步，本函数不代劳。
 *
 * 【边界，不虚报】
 * · T-A 尚未持久化的事件（用户已按错、事件行还没落盘）不在现有 U16 保证范围内：
 *   升级中断绝对不丢事件**不成立**，本函数不宣称这一点。
 * · 事件行已落盘但凭证未落盘（历史 S1 形态）由第 4 步幂等重放收敛。
 * · fake-indexeddb 无法完整模拟 db.close() 的 in-flight 逐拍时序，真机矩阵仍为 N/A。
 */
export async function runRecoveryChain(
  sessionId: string,
  opts: DrainOptions & { background?: boolean } = {},
): Promise<RecoveryChainResult> {
  // 1. 丢弃旧内存锁状态（幂等；storage 层的 versionchange 监听已 close 连接）
  invalidateLocalLocks()
  // 2 + 3. 重新 open → 重读会话与 lock_epoch → 重新取锁
  const lock = await resetAfterReconnect(sessionId, opts)
  // 4. drain
  const drain = await drainPendingEvents({ ...opts, sessionId })
  // 5. 收敛结果交调用方决定开闸
  return {
    epoch: lock.epoch,
    takenOver: lock.takenOver,
    drain,
    converged: drain.converged,
  }
}

/* ------------------------------------------------------------------
 * P2 · 只读统计入口（页面只调这里，不直接碰 storage）
 * ------------------------------------------------------------------ */

/** reset 行携带的快照字段：行内可选字段，不改 Dexie schema */
interface ResetEventLike {
  kind: string
  covered_event_ids?: string[]
}

/**
 * 读取某一会话的错词事件统计。
 * · 按 session_id 精确过滤，会话按主键精确读取（禁止 getResumableSession 兜底）；
 * · owner 隔离：只统计与会话 owner 一致的行，不把当前账号结果表述成「全部历史」；
 * · covered 由本会话内 reset 行的 frozen 快照并集构造，集合并集天然幂等。
 */
export async function loadSessionErrorStats(sessionId: string): Promise<ErrorStats> {
  let rows: SpellingErrorEvent[] = []
  try {
    rows = await EVENTS.whereIndex('session_id', sessionId)
  } catch (err) {
    console.warn('[spelling] 错词事件读取失败，统计返回空集（不编造数字）', err)
  }
  const session = await storage.table('spellingSessions').get(sessionId).catch(() => undefined)
  const owner = session?.owner ?? DEFAULT_OWNER

  const covered = new Set<string>()
  const errorRows: SpellingErrorEvent[] = []
  for (const row of rows) {
    const ext = row as unknown as ResetEventLike
    // 内容寻址：kind='reset' 或携带 covered_event_ids 快照都视为 reset 行。
    // 当前 SpellingErrorEventKind 枚举尚无 'reset'（V2 状态机未实现），
    // 只认 kind 会把历史/测试构造的 reset 快照误统计成普通错误行。
    const isReset = ext.kind === 'reset' || Array.isArray(ext.covered_event_ids)
    if (isReset) {
      for (const id of ext.covered_event_ids ?? []) covered.add(id)
      continue
    }
    if (row.owner !== owner) continue
    errorRows.push(row)
  }

  return aggregateErrorStats(errorRows, (sid) => (sid === sessionId ? session ?? null : null), covered)
}

/**
 * 错词本只读入口（产品规则 3/9）：按 (owner, word_id) 合并 append-only 事件行。
 * · 优先按 session_id 精确读取，事件行与会话文档按主键对齐，不串账号；
 * · 会话文档不存在 → classify 判 ORPHAN，保守提示且不编造数字；
 * · 读取失败返回空错词本（owner 仍如实回填），不抛错、不白屏。
 */
export async function loadWrongWordBook(
  sessionId: string,
  opts: { owner?: string } = {},
): Promise<WrongWordBook> {
  let rows: SpellingErrorEvent[] = []
  try {
    rows = await EVENTS.whereIndex('session_id', sessionId)
  } catch (err) {
    console.warn('[spelling] 错词本读取失败，返回空集（不编造数字）', err)
  }
  const session = await storage.table('spellingSessions').get(sessionId).catch(() => undefined)
  const owner = opts.owner ?? session?.owner ?? DEFAULT_OWNER
  const events: WrongBookEvent[] = rows.map((r) => r as unknown as WrongBookEvent)
  const covered = collectCovered(events)
  return aggregateWrongWordBook(
    events,
    (sid) => (sid === sessionId ? session ?? null : null),
    owner,
    covered,
  )
}
