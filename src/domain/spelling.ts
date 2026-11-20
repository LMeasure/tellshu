/**
 * 单词默写 · 纯状态机与拼写判定（平台无关）
 * ------------------------------------------------------------------
 * 【为什么这个一行 import 都没有指向 storage】
 * 阶段一查清了两件事，它们直接决定了本文件的形态：
 *   1. 存储抽象层（`services/storage/types.ts` 的 TableService）**没有任何事务 API**，
 *      Dexie 实例也不外泄 ⇒ 多步写入无法用事务包住。
 *      ⇒ 对策：会话 + 队列做成**单文档**，由调用方一次 `put()` 原子写入；
 *         所以这里的函数全部接受一个 session、返回一个**全新的 session**，
 *         绝不修改入参 —— 「要么整份替换，要么什么都没发生」，这就是我们的原子性。
 *   2. `VocabEntry.consecutive_correct` 是跨会话持久、阈值 PASS_THRESHOLD=5、
 *      驱动 SRS 晋级（new→apply→mastered）的字段。
 *      ⇒ 默写的连续正确（目标 3）**绝不写回 VocabEntry**，只活在会话文档里。
 *         两者同名但语义不同：前者 = SRS 晋级进度，后者 = 本轮默写进度。
 *
 * 【命名】内部一律 spelling。项目里已有三种「默写」：
 *   阅读器就地默写（DictationProgress / InlineDictation / lib/dictation.ts）、
 *   QuizForm 'dictation'、ReadingTimeRow.dictation_seconds —— 再混用无法维护。
 *
 * 【SRS 交接（决策 D2）】仅当词条**转为 COMPLETED** 时产生一次交接义务
 *   （result.srs_due = true），由调用方执行一次 recordQuiz(word_id, true, 'spelling')，
 *   成功后调用 markSrsReported() 落标记，防止恢复会话后重复调度。
 *   过程中的单次对错、SKIPPED、UNAVAILABLE **都不产生**交接。
 *
 * 本文件纯函数、零平台依赖，可在 Node 下用 tsx 直接单测。
 */

import { uuid } from '../lib/uuid'
import { shuffle } from '../lib/reviewQuiz'
import type { ReviewLog, VocabEntry } from './types'

/* ------------------------------------------------------------------
 * 常量与类型
 * ------------------------------------------------------------------ */

/** 默认连续正确目标次数（targetCorrect）。方案 §2.1 定为一处配置，不在组件里硬编码。 */
export const DEFAULT_TARGET_CORRECT = 3

/** 暂停超过这个时长提示用户「恢复或放弃」（方案 §4.3，7 天）。MVP 不静默删除历史。 */
export const STALE_PAUSE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 有效答案的形状：`A-Za-z`，允许内部单个连字符或撇号（含弯撇号 ’）。
 * 词库实测（22,791 条）：含空格 0、连字符 70、撇号 0、含大写 56、
 * 脏数据 1 条 `discombobulated[` —— 最后这条由本正则挡在选词池外。
 */
export const VALID_ANSWER_RE = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/

export type SpellingSelectionMode = 'random' | 'recent' | 'wrong'

export type SpellingWordStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'UNAVAILABLE'

export type SpellingSessionStatus =
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'SESSION_COMPLETED'
  | 'ABANDONED'

/**
 * 一次"提交"的判定结果：
 *   correct  —— 拼写正确
 *   wrong    —— 拼写错误（已计入错误次数、连续正确归零）
 *   invalid  —— 空白提交；**不计入任何计数**，避免误触回车把单词打回 0
 *   skipped  —— 手动跳过；不属于答题提交，不进正确率分母
 *   terminal —— 词条已是终态（COMPLETED/SKIPPED/UNAVAILABLE），本次未计数
 */
export type AttemptOutcome = 'correct' | 'wrong' | 'invalid' | 'skipped' | 'terminal'

/** 选词阶段被排除的词条及原因（如实上报，不静默丢弃 —— 沿用 reviewQuiz.QuizDrop 的作风） */
export type SelectionDropReason = 'invalid-word' | 'no-meaning' | 'duplicate'

export interface SelectionDrop {
  word_id: string
  word: string
  reason: SelectionDropReason
}

/** 队列里的一个词条（会话文档的内嵌对象） */
export interface SpellingWordState {
  word_id: string
  /** 答案（英文）；快照存在这儿，生词本条目被删也能展示与统计 */
  word: string
  /** 中文释义；题库就靠它，离线必然可用（VocabEntry 入库时已持久化） */
  definition_zh?: string
  ipa?: string
  pos?: string
  position: number
  status: SpellingWordStatus
  consecutive_correct: number
  target_correct: number
  total_attempts: number
  correct_attempts: number
  wrong_attempts: number
  last_attempt_at?: number
  unavailable_reason?: string
  /** D2：是否已经把「完成」交接给过 SRS，防止恢复会话后重复 recordQuiz */
  srs_reported: boolean
  /**
   * V2 逐字母：本轮已正确输入的字母前缀（错误后清零）。
   * 行内可选字段，内嵌在会话文档里，随整份 put 原子落库；不改 Dexie schema、不迁移。
   * 老会话（V1）没有该字段 → 按 '' 处理，即从第一个字母开始。
   */
  typed_prefix?: string
}

/** 一次提交的完整响应，同时也是写进 processed_requests 的回放值 */
export interface AttemptResult {
  request_id: string
  word_id: string
  result: AttemptOutcome
  word_status: SpellingWordStatus
  consecutive_correct: number
  target_correct: number
  total_attempts: number
  correct_attempts: number
  wrong_attempts: number
  next_word_id: string | null
  session_status: SpellingSessionStatus
  progress: SessionProgress
  /** true = 本次产生了 SRS 交接义务，调用方需执行一次 recordQuiz(word_id, true, 'spelling') */
  srs_due: boolean
  at: number
}

export interface SessionProgress {
  completed: number
  skipped: number
  unavailable: number
  total: number
}

/** 会话文档（单文档持久化，Dexie version(10) 的 spellingSessions 表） */
export interface SpellingSession {
  id: string
  type: 'spelling'
  owner: string
  status: SpellingSessionStatus
  selection_mode: SpellingSelectionMode
  target_correct: number
  total_words: number
  current_position: number
  started_at: number
  updated_at: number
  ended_at?: number
  paused_at?: number
  queue: SpellingWordState[]
  /** request_id → 原处理结果（幂等回放，V1 整词提交） */
  processed_requests: Record<string, AttemptResult>
  /**
   * V2 逐字母：request_id → 原字母处理结果（幂等回放）。
   * 行内可选字段，零 schema 变更；老会话无此字段按 {} 处理。
   * 体积随按键增长，保留策略见 P2 剩余问题清单（本轮不擅自清理）。
   */
  processed_letters?: Record<string, import('./spellingTyping').LetterResult>

  /* ---- 跨标签单写者锁 / 错词事件凭证（行内可选字段，无 Dexie schema 变更） ----
   * 老会话（V1 时期创建）没有这些字段，取锁时按需初始化，不迁移、不回填。
   * 权威结算依据是 applied_error_event_ids；事件表的 status 只是展示态。 */
  /** 当前持锁标签 id；空 = 尚未取锁 */
  active_tab_id?: string
  /** fencing token：每次成功 takeover 原子 +1 */
  lock_epoch?: number
  /** 最近一次取锁/续期时间（软租约，用于过期接管） */
  lock_held_at?: number
  /**
   * 已结算错词事件凭证：event_id → 结算结论（drain 幂等的唯一权威）。
   * true 兼容 V1 / 实施 B 已落库的老数据（语义 = 'zeroed'）；
   * 'zeroed' = 本代次已结算、计入活动错词；'stale' = 旧代次已终结、不计入活动错词。
   * 行内可选字段，不改 Dexie stores() / version，历史文档无需回填。
   */
  applied_error_event_ids?: Record<string, SpellingErrorCredential>
}

/** 结算凭证取值（1.2.3 §1.3「凭证优先于代次」） */
export type SpellingErrorCredential = true | 'zeroed' | 'stale'

export interface SessionStats {
  total_words: number
  /** Σ queue.total_attempts —— 有效提交次数（空白提交不算） */
  total_attempts: number
  correct_attempts: number
  wrong_attempts: number
  completed: number
  skipped: number
  unavailable: number
  /** 仍未终态的词（PENDING + IN_PROGRESS） */
  remaining: number
  /** 正确率 0-100；total_attempts === 0 时为 null —— 前端渲染 "—" */
  accuracy: number | null
  /** 完成率 0-100；total_words === 0 时为 null —— 前端渲染 "—" */
  completion_rate: number | null
  duration_ms: number
}

export interface ApplyAttemptOptions {
  word_id: string
  input: string
  request_id: string
  now?: number
}

export interface SkipOptions {
  word_id: string
  request_id: string
  now?: number
}

export interface MarkUnavailableOptions {
  word_ids: readonly string[]
  reason: string
  now?: number
}

export interface SelectWordsInput {
  entries: readonly VocabEntry[]
  /** 逐次复习日志，用于「易错词」排序；不传则只按 in_wrong_pool 标记排序 */
  review_logs?: readonly ReviewLog[]
  mode: SpellingSelectionMode
  count: number
  now?: number
  rng?: () => number
}

export interface SelectWordsResult {
  entries: VocabEntry[]
  dropped: SelectionDrop[]
  /** 过滤后可用词条总数（用于「请求数量 > 可用数量时按实际数量创建」的提示） */
  available: number
}

export interface CreateSessionInput extends SelectWordsInput {
  id?: string
  owner?: string
  target_correct?: number
  id_factory?: () => string
}

export interface CreateSessionResult {
  session: SpellingSession
  dropped: SelectionDrop[]
  /** 用户请求的词数 */
  requested: number
  /** 过滤后可用词条总数 */
  available: number
}

/* ------------------------------------------------------------------
 * 拼写判定（方案 §2.3 / 决策 D6）
 * ------------------------------------------------------------------ */

/** 归一化：只做 trim + toLowerCase。**不做**任何等价替换（连字符严格比对）。 */
export function normalizeInput(x: string): string {
  return (x ?? '').trim().toLowerCase()
}

/** 答案是否有效；脏数据（如 `discombobulated[`）在此被拦下。 */
export function hasValidAnswer(word: string): boolean {
  return VALID_ANSWER_RE.test((word ?? '').trim())
}

/**
 * 拼写判定。确定性逻辑，不调用 AI、不纠错、不做近似匹配。
 * 大小写不敏感 + 去首尾空格；其余一字之差都算错。
 */
export function judgeSpelling(input: string, answer: string): boolean {
  return normalizeInput(input) === normalizeInput(answer)
}

/* ------------------------------------------------------------------
 * 选词（方案 §6.1、决策 D5/D6）
 * ------------------------------------------------------------------ */

/** 该词条能否进选词池：英文有效 + 有中文释义（没释义就没法"看中文写英文"） */
export function isSelectable(v: VocabEntry): boolean {
  if (!hasValidAnswer(v.word)) return false
  return (v.definition_zh ?? '').trim().length > 0
}

/** 「错过的次数」：优先用既有 reviewLog 统计，便于默写也有历史时排序更准 */
function wrongCountOf(wordId: string, logs: readonly ReviewLog[] | undefined): number {
  if (!logs) return 0
  let n = 0
  for (const l of logs) if (l.word_id === wordId && !l.correct) n += 1
  return n
}

/**
 * 选词（纯函数）。三种模式：随机 / 最近新增 / 易错词。
 * 数量不足可用词数时**按实际可用数量返回**，并把被排除的词条如实带出（dropped）。
 */
export function selectWords(input: SelectWordsInput): SelectWordsResult {
  const { entries, review_logs, mode, count, rng = Math.random } = input
  const dropped: SelectionDrop[] = []
  const seen = new Set<string>()
  const pool: VocabEntry[] = []

  for (const v of entries) {
    if (seen.has(v.word_id)) {
      dropped.push({ word_id: v.word_id, word: v.word, reason: 'duplicate' })
      continue
    }
    if (!hasValidAnswer(v.word)) {
      seen.add(v.word_id)
      dropped.push({ word_id: v.word_id, word: v.word, reason: 'invalid-word' })
      continue
    }
    if ((v.definition_zh ?? '').trim().length === 0) {
      seen.add(v.word_id)
      dropped.push({ word_id: v.word_id, word: v.word, reason: 'no-meaning' })
      continue
    }
    seen.add(v.word_id)
    pool.push(v)
  }

  let ordered: VocabEntry[]
  if (mode === 'random') {
    ordered = shuffle(pool, rng)
  } else if (mode === 'recent') {
    ordered = [...pool].sort((a, b) => b.added_at - a.added_at)
  } else {
    ordered = [...pool].sort((a, b) => {
      const wa = wrongCountOf(a.word_id, review_logs) + (a.in_wrong_pool ? 1 : 0)
      const wb = wrongCountOf(b.word_id, review_logs) + (b.in_wrong_pool ? 1 : 0)
      if (wb !== wa) return wb - wa
      return a.added_at - b.added_at
    })
  }

  const take = Math.max(0, Math.min(count, ordered.length))
  return { entries: ordered.slice(0, take), dropped, available: pool.length }
}

/* ------------------------------------------------------------------
 * 会话文档构造
 * ------------------------------------------------------------------ */

function makeWordState(v: VocabEntry, position: number, target: number): SpellingWordState {
  return {
    word_id: v.word_id,
    word: v.word.trim(),
    definition_zh: v.definition_zh,
    ipa: v.ipa,
    pos: v.pos,
    position,
    status: 'PENDING',
    consecutive_correct: 0,
    target_correct: target,
    total_attempts: 0,
    correct_attempts: 0,
    wrong_attempts: 0,
    srs_reported: false,
  }
}

/**
 * 生成一份待持久化的会话文档（**不落库**，落库在阶段三的 spellingSession.ts）。
 * 可用词不足时按实际数量建会话，由调用方据此提示用户。
 * 过滤只在这里发生一次 —— 调用方应直接把全量 entries 传进来，
 * 不要先自己过滤一遍（否则 dropped 会被过滤掉，用户看不到被排除的词）。
 */
export function createSessionDraft(input: CreateSessionInput): CreateSessionResult {
  const now = input.now ?? Date.now()
  const target = input.target_correct ?? DEFAULT_TARGET_CORRECT
  const sel = selectWords(input)
  const queue = sel.entries.map((v, i) => makeWordState(v, i, target))
  const first = queue[0]
  return {
    session: {
      id: input.id ?? (input.id_factory ?? uuid)(),
      type: 'spelling',
      owner: input.owner ?? 'guest',
      status: 'IN_PROGRESS',
      selection_mode: input.mode,
      target_correct: target,
      total_words: queue.length,
      current_position: first ? first.position : -1,
      started_at: now,
      updated_at: now,
      queue,
      processed_requests: {},
    },
    dropped: sel.dropped,
    requested: input.count,
    available: sel.available,
  }
}

/* ------------------------------------------------------------------
 * 会话级聚合（方案 §2.2：一律实时算，不存汇总字段）
 * ------------------------------------------------------------------ */

export function sessionProgress(session: SpellingSession): SessionProgress {
  return {
    completed: session.queue.filter((w) => w.status === 'COMPLETED').length,
    skipped: session.queue.filter((w) => w.status === 'SKIPPED').length,
    unavailable: session.queue.filter((w) => w.status === 'UNAVAILABLE').length,
    total: session.total_words,
  }
}

/**
 * 会话统计。口径：
 *   正确率 = Σcorrect / Σattempts（跳过不属于答题提交，不进分母）
 *   完成率 = completed / total_words
 * 两者在分母为 0 时返回 null —— 前端渲染 "—"，不许编一个 0% 出来。
 */
export function aggregateSession(session: SpellingSession, now = Date.now()): SessionStats {
  let total_attempts = 0
  let correct_attempts = 0
  let wrong_attempts = 0
  let completed = 0
  let skipped = 0
  let unavailable = 0

  for (const w of session.queue) {
    total_attempts += w.total_attempts
    correct_attempts += w.correct_attempts
    wrong_attempts += w.wrong_attempts
    if (w.status === 'COMPLETED') completed += 1
    else if (w.status === 'SKIPPED') skipped += 1
    else if (w.status === 'UNAVAILABLE') unavailable += 1
  }

  const p = sessionProgress(session)
  const end = session.ended_at ?? now
  return {
    total_words: session.total_words,
    total_attempts,
    correct_attempts,
    wrong_attempts,
    completed,
    skipped,
    unavailable,
    remaining: p.total - completed - skipped - unavailable,
    accuracy: total_attempts === 0 ? null : Math.round((correct_attempts / total_attempts) * 100),
    completion_rate: p.total === 0 ? null : Math.round((completed / p.total) * 100),
    duration_ms: Math.max(0, end - session.started_at),
  }
}

/* ------------------------------------------------------------------
 * 内部工具
 * ------------------------------------------------------------------ */

/** V1/V2 共用的终态判定（导出供 V2 逐字母状态机复用，规则单一来源） */
export function isTerminal(w: SpellingWordState): boolean {
  return w.status === 'COMPLETED' || w.status === 'SKIPPED' || w.status === 'UNAVAILABLE'
}

/** 结构化克隆会话文档：保持"不修改入参"的纯度，同时让调用方拿到可直接 put 的新对象 */
export function cloneSession(s: SpellingSession): SpellingSession {
  return {
    ...s,
    queue: s.queue.map((w) => ({ ...w })),
    processed_requests: { ...s.processed_requests },
    // V2 逐字母幂等回放表：整份 put 时必须保留，否则刷新后重放会重复计数
    ...(s.processed_letters ? { processed_letters: { ...s.processed_letters } } : {}),
  }
}

/**
 * 队列推进：找第一个未终态的词；一个都没有 → 会话自然结束。
 * 统一的收口可以保证「计数更新 / 状态变更 / 队列推进」永远同批发生。
 */
/** V1/V2 共用的队列推进（导出供 V2 复用，保证切换规则不漂移） */
export function advance(session: SpellingSession, now: number): void {
  const next = session.queue.filter((w) => !isTerminal(w)).sort((a, b) => a.position - b.position)[0]
  if (!next) {
    session.status = 'SESSION_COMPLETED'
    session.ended_at = now
    session.current_position = -1
    return
  }
  session.current_position = next.position
}

/**
 * 是否允许这次操作改写会话。
 * PAUSED / ABANDONED 是真·状态违规（UI 不该在这种状态下提交），抛错让调用方立刻发现；
 * SESSION_COMPLETED **不抛** —— 走到这里的词条必然已是终态，会被下面的 terminal 分支挡住；
 * 会话结束后用户又点了一次提交属于正常交互，返回 terminal 即可，不该崩。
 */
function requireWritable(session: SpellingSession): void {
  if (session.status === 'PAUSED' || session.status === 'ABANDONED') {
    throw new Error(`SPELLING_SESSION_NOT_ACTIVE: ${session.status}`)
  }
}

function indexOfWord(session: SpellingSession, wordId: string): number {
  const i = session.queue.findIndex((w) => w.word_id === wordId)
  if (i < 0) throw new Error(`SPELLING_WORD_NOT_IN_QUEUE: ${wordId}`)
  return i
}

/** 组装响应（只做取值，不改状态） */
function buildResult(
  session: SpellingSession,
  word: SpellingWordState,
  outcome: AttemptOutcome,
  now: number,
  requestId: string,
): AttemptResult {
  const next = session.queue
    .filter((w) => !isTerminal(w))
    .sort((a, b) => a.position - b.position)[0]
  return {
    request_id: requestId,
    word_id: word.word_id,
    result: outcome,
    word_status: word.status,
    consecutive_correct: word.consecutive_correct,
    target_correct: word.target_correct,
    total_attempts: word.total_attempts,
    correct_attempts: word.correct_attempts,
    wrong_attempts: word.wrong_attempts,
    next_word_id: next ? next.word_id : null,
    session_status: session.status,
    progress: sessionProgress(session),
    srs_due: outcome === 'correct' && word.status === 'COMPLETED' && !word.srs_reported,
    at: now,
  }
}

/* ------------------------------------------------------------------
 * 状态机：提交 / 跳过 / 失效
 * ------------------------------------------------------------------ */

/**
 * 提交一次拼写。
 *
 * 幂等：`request_id` 命中 `processed_requests` 时**原样回放原结果**，不计数、不推进。
 * 终态词条不再计数；空白提交不计入任何计数（invalid）。
 * 返回的新 session 由调用方一次 put —— 计数、状态、队列推进都在这一份文档里。
 */
export function applyAttempt(
  session: SpellingSession,
  opts: ApplyAttemptOptions,
): { session: SpellingSession; result: AttemptResult } {
  requireWritable(session)
  const cached = session.processed_requests[opts.request_id]
  if (cached) return { session, result: cached }

  const now = opts.now ?? Date.now()
  const i = indexOfWord(session, opts.word_id)
  const next = cloneSession(session)
  const word = next.queue[i]

  let result: AttemptResult
  if (isTerminal(word)) {
    result = buildResult(next, word, 'terminal', now, opts.request_id)
  } else {
    const trimmed = opts.input.trim()
    if (trimmed.length === 0) {
      result = buildResult(next, word, 'invalid', now, opts.request_id)
    } else if (judgeSpelling(trimmed, word.word)) {
      word.total_attempts += 1
      word.correct_attempts += 1
      word.consecutive_correct += 1
      word.last_attempt_at = now
      word.status = 'IN_PROGRESS'
      if (word.consecutive_correct >= word.target_correct) word.status = 'COMPLETED'
      advance(next, now)
      result = buildResult(next, word, 'correct', now, opts.request_id)
    } else {
      word.total_attempts += 1
      word.wrong_attempts += 1
      word.consecutive_correct = 0
      word.last_attempt_at = now
      word.status = 'IN_PROGRESS'
      result = buildResult(next, word, 'wrong', now, opts.request_id)
    }
  }

  next.updated_at = now
  next.processed_requests[opts.request_id] = result
  return { session: next, result }
}

/**
 * 手动跳过。不属于答题提交 ⇒ **不进正确率分母**，也不触发 SRS（决策 D2）。
 * 同样用 request_id 保证幂等：重复请求回放原结果，不二次推进。
 */
export function skipWord(
  session: SpellingSession,
  opts: SkipOptions,
): { session: SpellingSession; result: AttemptResult } {
  requireWritable(session)
  const cached = session.processed_requests[opts.request_id]
  if (cached) return { session, result: cached }

  const now = opts.now ?? Date.now()
  const i = indexOfWord(session, opts.word_id)
  const next = cloneSession(session)
  const word = next.queue[i]

  let result: AttemptResult
  if (isTerminal(word)) {
    result = buildResult(next, word, 'terminal', now, opts.request_id)
  } else {
    word.status = 'SKIPPED'
    word.last_attempt_at = now
    advance(next, now)
    result = buildResult(next, word, 'skipped', now, opts.request_id)
  }

  next.updated_at = now
  next.processed_requests[opts.request_id] = result
  return { session: next, result }
}

/**
 * 词条失效（生词本条目被删除 / 答案不可用）。
 * **只有 PENDING 与 IN_PROGRESS 允许转 UNAVAILABLE** —— 终态词条保持原状态，
 * 否则恢复会话时会把已完成的词重新分类，会话统计立刻失真。
 * 传的 word_ids 里不在队列中的会被忽略（恢复场景可能一次传整批删掉的词）。
 */
export function markUnavailable(
  session: SpellingSession,
  opts: MarkUnavailableOptions,
): SpellingSession {
  const now = opts.now ?? Date.now()
  const next = cloneSession(session)
  const targets = new Set(opts.word_ids)
  let touched = false
  for (const w of next.queue) {
    if (!targets.has(w.word_id)) continue
    if (isTerminal(w)) continue
    w.status = 'UNAVAILABLE'
    w.unavailable_reason = opts.reason
    touched = true
  }
  if (!touched) return session
  if (next.status === 'IN_PROGRESS') advance(next, now)
  next.updated_at = now
  return next
}

/**
 * 标记「已把完成结果交接给 SRS」（决策 D2）。
 * 调用方在执行 recordQuiz(word_id, true, 'spelling') **成功之后**调用，
 * 保证崩溃 / 刷新后不会重复调度同一个词。
 */
export function markSrsReported(
  session: SpellingSession,
  wordId: string,
  now = Date.now(),
): SpellingSession {
  const next = cloneSession(session)
  const word = next.queue.find((w) => w.word_id === wordId)
  if (!word) throw new Error(`SPELLING_WORD_NOT_IN_QUEUE: ${wordId}`)
  if (word.srs_reported) return session
  word.srs_reported = true
  next.updated_at = now
  return next
}

/** 待交接给 SRS、但还没落标记的词（恢复会话后补一次用） */
export function pendingSrsWords(session: SpellingSession): SpellingWordState[] {
  return session.queue.filter((w) => w.status === 'COMPLETED' && !w.srs_reported)
}

/* ------------------------------------------------------------------
 * 会话级生命周期
 * ------------------------------------------------------------------ */

export function pauseSession(session: SpellingSession, now = Date.now()): SpellingSession {
  if (session.status !== 'IN_PROGRESS') return session
  return { ...cloneSession(session), status: 'PAUSED', paused_at: now, updated_at: now }
}

export function resumeSession(session: SpellingSession, now = Date.now()): SpellingSession {
  if (session.status !== 'PAUSED') return session
  const next = cloneSession(session)
  const patch: SpellingSession = { ...next, status: 'IN_PROGRESS', updated_at: now }
  delete patch.paused_at
  return patch
}

export function abandonSession(session: SpellingSession, now = Date.now()): SpellingSession {
  if (session.status === 'ABANDONED' || session.status === 'SESSION_COMPLETED') return session
  return { ...cloneSession(session), status: 'ABANDONED', ended_at: now, updated_at: now }
}

/** 暂停是否超过 STALE_PAUSE_MS（7 天）—— 判定在本地做，用于提示「恢复或放弃」 */
export function isSessionStale(session: SpellingSession, now = Date.now()): boolean {
  if (session.status !== 'PAUSED') return false
  const since = session.paused_at ?? session.updated_at
  return now - since >= STALE_PAUSE_MS
}

/** 当前应该展示的词（没有则返回 null） */
export function currentWord(session: SpellingSession): SpellingWordState | null {
  if (session.status !== 'IN_PROGRESS') return null
  return session.queue.find((w) => w.position === session.current_position) ?? null
}
