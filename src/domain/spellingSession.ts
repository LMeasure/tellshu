/**
 * 单词默写 · 持久化层（Dexie）
 * ------------------------------------------------------------------
 * 分层（与 domain/learning.ts 完全一致）：
 *   src/domain/spelling.ts        纯状态机（零 storage 依赖，可单测）
 *   src/domain/spellingSession.ts 本文件：读库 → 调纯函数 → 写库（含 SRS 交接）
 *
 * 【单文档写入】`TableService` 没有事务 API（见 services/storage/types.ts），
 * 所以「计数更新 + 状态变更 + 队列推进」全部压在**一次 `put()`** 上：
 * 纯函数返回一份全新的会话文档，这里整份换掉。写入失败 = 什么都没有发生。
 *
 * 【并发边界 —— 不许虚假承诺】
 * IndexedDB 的单文档 `put()` 只保证**这一篇**写入是原子的，
 * 它不保证「检查活跃会话 → 创建会话」这一整套的原子性：
 *   · 两个标签页可能各读到「无活跃会话」，各写一份不同 id 的会话 → 库里有 2 份活跃会话；
 *   · 同一 id 的并发 `put()` 是 last-writer-wins，后写者覆盖先写者。
 * 本层的对策是**写前检查 + 写后复核 + 读取时不假定唯一**：
 *     createSession 写完立刻重读校验（status / id / queue 长度），不一致就抛冲突；
 *     getActiveSession 返回**最新**的一份，getActiveSessions 返回全部供 UI 提示用户二选一。
 * 这不是互斥锁，也不宣称是 —— 只是把冲突变成「用户可见的选择」而不是静默数据丢失。
 *
 * 【SRS 交接边界 —— 同样不许虚假承诺】详见文件末尾 `fulfillSrsHandoff` 的长注释：
 * recordQuiz 不幂等，会话写入与 recordQuiz 之间无法原子提交，
 * 中断窗口内可能对该词多调度一次。影响面与缓解手段都写在那里。
 * 阶段 C 已用故障注入测试**复现**该窗口（scripts/test_spelling_srs_handoff.ts），
 * 并顺带修掉一个原实现的缺陷：会话自然结束后未交接的词永远等不到补交。
 */

import { storage } from '../services/storage'
import { uuid } from '../lib/uuid'
import {
  abandonSession,
  applyAttempt,
  createSessionDraft,
  markSrsReported,
  markUnavailable,
  pauseSession,
  pendingSrsWords,
  resumeSession,
  skipWord,
  type AttemptResult,
  type SelectionDrop,
  type SpellingSelectionMode,
  type SpellingSession,
} from './spelling'
import { recordQuiz } from './learning'
import type { VocabEntry } from './types'

const SESSIONS = storage.table('spellingSessions')
const VOCAB = storage.table('vocab')
/** 「易错词」模式要靠历史答题日志排序，创建时一并读出（只读，不改） */
const LOGS = storage.table('reviewLog')

/** 默认 owner：与 vocab / reviewLog 现状一致（本地无多用户，字段留给将来账号接入） */
const DEFAULT_OWNER = 'guest'

/** SRS 交接的结果分类（给 UI 与测试用，避免把「失败」说成「成功」） */
export type SrsHandoffOutcome =
  | 'none' /* 没有待交接词条 */
  | 'reported' /* 全部交接成功并已落标记 */
  | 'dropped' /* 全部无交接对象（词条已删），已落标记、不会重试 */
  | 'partial' /* 一部分成功、一部分没成功（含仍有写入失败待重试） */
  | 'failed' /* 一个都没交接成功，且存在写入失败（会重试） */

export interface CreateSessionResult {
  session: SpellingSession
  dropped: SelectionDrop[]
  /** 用户请求的词数（与实际建成的可能不同，供 UI 提示「数量不足」） */
  requested: number
  /** 过滤后实际可用词条总数 */
  available: number
}

export interface SubmitAttemptInput {
  word_id: string
  input: string
  request_id: string
  now?: number
}

export interface SubmitAttemptResult {
  session: SpellingSession
  result: AttemptResult
  srs: SrsHandoffOutcome
}

export class SpellingSessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NO_ACTIVE_SESSION'
      | 'SESSION_CONFLICT'
      | 'WORD_NOT_IN_QUEUE'
      | 'SESSION_NOT_ACTIVE'
      | 'WRITE_FAILED',
  ) {
    super(message)
    this.name = 'SpellingSessionError'
  }
}

/* ------------------------------------------------------------------
 * 读取
 * ------------------------------------------------------------------ */

/** 全部会话，按开始时间倒序（历史列表 / 冲突提示 / SRS 补交扫描用）。会话量级是个位到几十，全表取即可 */
export async function getAllSessions(): Promise<SpellingSession[]> {
  const rows = await SESSIONS.toArray().catch(() => [] as SpellingSession[])
  return rows.sort((a, b) => b.started_at - a.started_at)
}

/** 历史列表（限量） */
export async function listHistory(limit = 20): Promise<SpellingSession[]> {
  return (await getAllSessions()).slice(0, limit)
}

/**
 * 进行中的会话（IN_PROGRESS）。可能有多份（并发创建未被互斥挡住）——
 * 返回**最新**的一份，其余交由 getActiveSessions 暴露给 UI。
 */
export async function getActiveSession(): Promise<SpellingSession | null> {
  const rows = await SESSIONS.whereIndex('status', 'IN_PROGRESS').catch(
    () => [] as SpellingSession[],
  )
  if (rows.length === 0) return null
  return rows.sort((a, b) => b.started_at - a.started_at)[0]
}

/** 全部 IN_PROGRESS 会话（并发冲突时 UI 让用户二选一） */
export async function getActiveSessions(): Promise<SpellingSession[]> {
  const rows = await SESSIONS.whereIndex('status', 'IN_PROGRESS').catch(
    () => [] as SpellingSession[],
  )
  return rows.sort((a, b) => b.started_at - a.started_at)
}

/**
 * 可恢复的会话：IN_PROGRESS 或 PAUSED。
 * 「暂停超 7 天」的判定由 UI 调 spelling.isSessionStale 做，本层不吞掉历史。
 */
export async function getResumableSession(): Promise<SpellingSession | null> {
  const [active, paused] = await Promise.all([
    SESSIONS.whereIndex('status', 'IN_PROGRESS').catch(() => [] as SpellingSession[]),
    SESSIONS.whereIndex('status', 'PAUSED').catch(() => [] as SpellingSession[]),
  ])
  const all = [...active, ...paused].sort((a, b) => b.started_at - a.started_at)
  return all[0] ?? null
}

export async function getSessionById(id: string): Promise<SpellingSession | null> {
  const row = await SESSIONS.get(id).catch(() => undefined)
  return row ?? null
}

/* ------------------------------------------------------------------
 * 写入口的公共骨架
 * ------------------------------------------------------------------ */

/**
 * 读活跃/暂停会话 → 交给纯函数 → 整份写回。
 * 任何一步失败都抛 SpellingSessionError，**不返回成功**（方案 §8「不假报成功」）。
 *
 * 状态语义：PAUSED / ABANDONED 下提交报 SESSION_NOT_ACTIVE（UI 状态违规），
 * 完全没有会话才报 NO_ACTIVE_SESSION。
 */
async function mutate<T>(
  fn: (session: SpellingSession) => { session: SpellingSession; value: T },
): Promise<{ session: SpellingSession; value: T }> {
  const target = await getResumableSession()
  if (!target) throw new SpellingSessionError('没有可恢复的默写会话', 'NO_ACTIVE_SESSION')
  if (target.status !== 'IN_PROGRESS') {
    throw new SpellingSessionError(`会话当前是 ${target.status}，不能提交`, 'SESSION_NOT_ACTIVE')
  }
  const out = fn(target)
  try {
    await SESSIONS.put(out.session)
  } catch {
    // 写不进去 = 什么都没有发生（不返回成功）。语义上是「保存失败」而不是状态违规，
    // 所以用 WRITE_FAILED 而不是 SESSION_NOT_ACTIVE。
    throw new SpellingSessionError('会话保存失败，请重试', 'WRITE_FAILED')
  }
  return out
}

/* ------------------------------------------------------------------
 * 创建
 * ------------------------------------------------------------------ */

/**
 * 创建会话。三步：过滤选词 → 生成单文档 → 写入并复核。
 *
 * 冲突处理（如实说明能力边界）：
 *   写前检查活跃会话；写后重读校验 id / status / 队列长度。
 *   写后复核能挡住「同 id 被覆盖」，挡不住「两个标签页各写一份不同 id」——
 *   后一种情况由 getActiveSessions 暴露给 UI 让用户二选一（见文件头说明）。
 */
export async function createSession(input: {
  mode: SpellingSelectionMode
  count: number
  target_correct?: number
  owner?: string
  now?: number
  id?: string
}): Promise<CreateSessionResult> {
  const blocking = await getActiveSessions()
  if (blocking.length > 0) {
    throw new SpellingSessionError(
      `已有进行中的默写会话（${blocking[0].id}），请先恢复或放弃`,
      'SESSION_CONFLICT',
    )
  }

  const now = input.now ?? Date.now()
  const [vocab, reviewLogs] = await Promise.all([VOCAB.toArray(), LOGS.toArray()])
  // 过滤只发生在 createSessionDraft 内部一次：这里必须传**全量** entries，
  // 否则 dropped（被排除的词）会被提前过滤掉，用户看不到为什么少了几个词。
  const { session, dropped, requested, available } = createSessionDraft({
    entries: vocab,
    review_logs: reviewLogs,
    mode: input.mode,
    count: input.count,
    target_correct: input.target_correct,
    owner: input.owner ?? DEFAULT_OWNER,
    now,
    id: input.id ?? uuid(),
  })

  if (session.total_words === 0) {
    // 一座空会话没有意义：直接报错让 UI 走 EmptyState，别落一份空文档占着「活跃」位
    throw new SpellingSessionError('没有可练习的词条', 'SESSION_CONFLICT')
  }

  await SESSIONS.put(session)

  // 写后复核：确认落库的就是我们刚写的那一份（防止同 id 被并发覆盖）
  const reread = await SESSIONS.get(session.id)
  if (
    !reread ||
    reread.status !== 'IN_PROGRESS' ||
    reread.queue.length !== session.queue.length ||
    reread.started_at !== session.started_at
  ) {
    throw new SpellingSessionError('会话写入后被并发修改，已放弃本次创建', 'SESSION_CONFLICT')
  }

  return { session: reread, dropped, requested, available }
}

/* ------------------------------------------------------------------
 * 提交 / 跳过 / 生命周期
 * ------------------------------------------------------------------ */

export async function submitAttempt(input: SubmitAttemptInput): Promise<SubmitAttemptResult> {
  const out = await mutate<AttemptResult>((s) => {
    const r = applyAttempt(s, {
      word_id: input.word_id,
      input: input.input,
      request_id: input.request_id,
      now: input.now,
    })
    return { session: r.session, value: r.result }
  })
  const { session, work } = await fulfillSrsHandoff(out.session, input.now)
  return { session, result: out.value, srs: handoffOutcome(work) }
}

export async function skip(input: {
  word_id: string
  request_id: string
  now?: number
}): Promise<{ session: SpellingSession; result: AttemptResult }> {
  const out = await mutate<AttemptResult>((s) => {
    const r = skipWord(s, {
      word_id: input.word_id,
      request_id: input.request_id,
      now: input.now,
    })
    return { session: r.session, value: r.result }
  })
  return { session: out.session, result: out.value }
}

export async function pause(now = Date.now()): Promise<SpellingSession> {
  const out = await mutate<null>((s) => ({ session: pauseSession(s, now), value: null }))
  return out.session
}

export async function resume(now = Date.now()): Promise<SpellingSession> {
  // resume 要从 PAUSED 读，不能走 getActiveSession（那只返回 IN_PROGRESS）
  const target = await getResumableSession()
  if (!target) throw new SpellingSessionError('没有可恢复的默写会话', 'NO_ACTIVE_SESSION')
  const next = resumeSession(target, now)
  await SESSIONS.put(next)
  return next
}

export async function abandon(now = Date.now()): Promise<SpellingSession> {
  const target = await getResumableSession()
  if (!target) throw new SpellingSessionError('没有可恢复的默写会话', 'NO_ACTIVE_SESSION')
  const next = abandonSession(target, now)
  await SESSIONS.put(next)
  return next
}

/* ------------------------------------------------------------------
 * 恢复时的一致性修补
 * ------------------------------------------------------------------ */

/**
 * 恢复会话时核对词条是否还在生词本里。
 * `removeFromVocab` 是**硬删除、无墓碑**，所以「已删除」只能靠查不到判定。
 * 只有 PENDING / IN_PROGRESS 会被转 UNAVAILABLE（markUnavailable 内部保证），
 * 终态词条即使词条已删也保持原状态。
 */
export async function refreshAvailability(): Promise<{
  session: SpellingSession
  marked: string[]
}> {
  const target = await getResumableSession()
  if (!target) throw new SpellingSessionError('没有可恢复的默写会话', 'NO_ACTIVE_SESSION')

  const pending = target.queue.filter(
    (w) => w.status === 'PENDING' || w.status === 'IN_PROGRESS',
  )
  if (pending.length === 0) return { session: target, marked: [] }

  const rows = await VOCAB.bulkGet(pending.map((w) => w.word_id))
  const gone = pending.filter((_, i) => !rows[i]).map((w) => w.word_id)
  if (gone.length === 0) return { session: target, marked: [] }

  const next = markUnavailable(target, {
    word_ids: gone,
    reason: 'vocab-entry-deleted',
  })
  await SESSIONS.put(next)
  return { session: next, marked: gone }
}

/**
 * 恢复后补做 SRS 交接（阶段 C 的恢复入口）。
 *
 * ⚠️ 阶段 C 修掉的缺陷（原实现只查 IN_PROGRESS/PAUSED）：
 *   会话**自然结束**（SESSION_COMPLETED）后，`getResumableSession()` 返回 null，
 *   原实现直接抛 NO_ACTIVE_SESSION —— 于是「最后一个词完成时交接失败」的词
 *   **永远等不到补交**，SRS 积分静默丢失，且没有任何界面能发现。
 *   现改为扫描**全部会话**（含 SESSION_COMPLETED / ABANDONED）：
 *   D2 的义务在词条转 COMPLETED 的那一刻就产生了，不会因为会话结束或用户放弃而消失。
 *   代价是一次补交可能涉及多个历史会话 —— 量级是个位到几十，可接受。
 */
export async function repairSrsHandoff(now = Date.now()): Promise<SrsRepairResult> {
  const all = await getAllSessions()
  const owing = all.filter((s) => pendingSrsWords(s).length > 0)
  const sessions: SpellingSession[] = []
  const work: SrsHandoffWork = { reported: [], dropped: [], lost: [] }

  for (const s of owing) {
    const out = await fulfillSrsHandoff(s, now)
    sessions.push(out.session)
    work.reported.push(...out.work.reported)
    work.dropped.push(...out.work.dropped)
    work.lost.push(...out.work.lost)
  }

  return { sessions, outcome: handoffOutcome(work), ...work }
}

/** 补交结果：一次调用可能横跨多个历史会话，所以返回数组而不是单个 session */
export interface SrsRepairResult extends SrsHandoffWork {
  /** 本次实际参与补交的会话（已写回库的最新版本） */
  sessions: SpellingSession[]
  outcome: SrsHandoffOutcome
}

/* ------------------------------------------------------------------
 * SRS 交接（决策 D2）—— 能力边界写在下面，改动前先读
 * ------------------------------------------------------------------ */

/**
 * 把「已完成」的词条交接给既有 SRS：recordQuiz(word_id, true, 'spelling')。
 *
 * 分层读法（方案 §6.3 原文「由调用方（阶段三）执行」）：
 *   `spelling.ts` 的 applyAttempt 只负责在 result 里置 `srs_due = true`（纯函数，无 storage）；
 *   **执行交接的是本文件**（阶段三持久化层），页面拿到的已经是最终结果。
 *   这样每个调用点都不可能忘记交接 —— 交给页面做的话，漏一处就静默丢一次 SRS 计分。
 *
 * 规则（V3.2 §6.3 / D2）：
 *   · 只有 status === 'COMPLETED' 且 srs_reported === false 的词条产生义务；
 *   · SKIPPED / UNAVAILABLE / 过程中的单次对错**都不交接**；
 *   · 交接成功后立刻 markSrsReported 并整份写回。
 *
 * ⚠️ 边界（不许包装成「恰好一次」）：
 *   `recordQuiz()` **不幂等**（每次调用都 reviewLog.add 新行 + consecutive_correct+1
 *   + srs_step 步进 + next_review 推后），而它与会话文档的写入**无法原子提交**
 *   （TableService 无事务 API，Dexie 实例不外泄，两个库操作之间必然有缝隙）。
 *   因此存在一个中断窗口：
 *     「recordQuiz 成功 → 标记尚未落库」之间崩溃 / 关页 / 写库失败
 *     ⇒ 下次恢复会重新发现该词待交接，**多调度一次**。
 *
 *   实际影响面（可量化、可说明，阶段 C 已用测试复现）：
 *     该词 consecutive_correct +1、srs_step 前进一档、next_review 推后一档、
 *     reviewLog 多一行 quiz_form='spelling'；
 *     若该词原本 consecutive_correct = PASS_THRESHOLD-1 = 4，重复交接会
 *     **连跳两级**（new→apply→mastered）并写下 mastered_at —— 这是最严重的可见后果。
 *
 *   为什么仍然采用「布尔标记 + 恢复补交」而不是更重的方案：
 *     · 引入事务能力要改 StorageService 抽象并影响全部既有表，超出本轮范围；
 *     · 给 reviewLog 建唯一索引做幂等键属于**改历史表结构**，方案明确禁止；
 *     · 独立的交接流水表需要 Dexie version(11) 且要设计对账流程，属新增范围。
 *   三者都已列入「待用户裁决」，未擅自实施。当前实现把风险压到
 *   「一次崩溃窗口 × 一个词 × 一档 SRS」，并且**只可能多、不可能少**（不会漏调度）。
 */

/** 一次交接的明细分类（UI 提示与测试断言用，避免把「无对象」说成「失败」） */
export interface SrsHandoffWork {
  /** recordQuiz 成功并已落标记的词 */
  reported: string[]
  /** 词条已不在生词本（removeFromVocab 硬删除），无交接对象；已落标记、不会重试 */
  dropped: string[]
  /** 写入失败，**未**落标记，下次补交会重试 */
  lost: string[]
}

/** 由明细推导 outcome。优先级：彻底没成功且有写入失败 → failed；全部无对象 → dropped；全部成功 → reported；混合 → partial */
export function handoffOutcome(work: SrsHandoffWork): SrsHandoffOutcome {
  const { reported, dropped, lost } = work
  if (reported.length === 0 && dropped.length === 0 && lost.length === 0) return 'none'
  if (lost.length === 0 && dropped.length === 0) return 'reported'
  if (lost.length === 0 && reported.length === 0) return 'dropped'
  if (reported.length + dropped.length === 0) return 'failed'
  return 'partial'
}

async function fulfillSrsHandoff(
  session: SpellingSession,
  now = Date.now(),
): Promise<{ session: SpellingSession; work: SrsHandoffWork }> {
  const due = pendingSrsWords(session)
  const work: SrsHandoffWork = { reported: [], dropped: [], lost: [] }
  if (due.length === 0) return { session, work }

  let current = session

  for (const w of due) {
    try {
      const updated = await recordQuiz(w.word_id, true, 'spelling')
      if (updated) {
        current = markSrsReported(current, w.word_id, now)
        work.reported.push(w.word_id)
      } else {
        // 词条已不在生词本（removeFromVocab 是硬删除）—— 交接无对象。
        // 落标记，避免每次恢复都重试同一件做不到的事；但不计入「成功」。
        current = markSrsReported(current, w.word_id, now)
        work.dropped.push(w.word_id)
      }
    } catch {
      // recordQuiz 写库失败：**不标记**，下次恢复重试（宁可重试也不要假装成功）
      work.lost.push(w.word_id)
    }
  }

  if (work.reported.length + work.dropped.length > 0) {
    try {
      await SESSIONS.put(current)
    } catch {
      // 标记落库失败 ≠ 本次作答失败：mutate 已经把计数/状态/队列推进落库了，
      // 用户看到的答案结果是有效的。这里只把「交接未落标记」如实降级：
      // 全部重新记为待重试，并返回与库一致（未标记）的会话对象，
      // 下次补交重试。绝不返回成功。
      work.lost.push(...work.reported, ...work.dropped)
      work.reported.length = 0
      work.dropped.length = 0
      current = session
    }
  }

  return { session: current, work }
}

/* ------------------------------------------------------------------
 * 便捷导出（页面只 import 这一个文件）
 * ------------------------------------------------------------------ */

export {
  aggregateSession,
  applyAttempt,
  currentWord,
  markUnavailable,
  markSrsReported,
  pendingSrsWords,
  selectWords,
  sessionProgress,
  skipWord,
  STALE_PAUSE_MS,
  DEFAULT_TARGET_CORRECT,
  isSessionStale,
  pauseSession,
  resumeSession,
  abandonSession,
  type AttemptResult,
  type SelectionDrop,
  type SpellingSelectionMode,
  type SpellingSession,
  type SpellingWordState,
  type SessionStats,
  type SessionProgress,
  type AttemptOutcome,
  type SpellingWordStatus,
  type SpellingSessionStatus,
} from './spelling'
export type { VocabEntry }
