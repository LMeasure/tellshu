/**
 * 单词默写 V2 · 逐字母打字状态机（纯函数，零平台依赖）
 * ------------------------------------------------------------------
 * 【与 V1 的边界 —— 不混用】
 * V1（spelling.ts / applyAttempt）：整词输入 → 一次判分 → 一次完整答题提交，
 *   一次错误提交写 1 条错词事件，并计入 total_attempts / wrong_attempts。
 * V2（本文件）：逐字符输入 → 每个字符即时判定。
 *   · 正确字母：推进输入进度；拼完整个单词才算「一次完整答题提交」；
 *     连续正确次数达到 target_correct 才完成单词并切换。
 *   · 错误字母：**立即**产生 1 条错词事件规格（1 个字母 = 1 条事件），
 *     输入进度清零、连续正确次数归零、触发错误提示音。
 *     **不**增加 total_attempts / correct_attempts / wrong_attempts，
 *     **不**产生 SRS 交接义务（错误事件不得污染完整答题统计与 SRS）。
 *
 * 【产品规则对应】
 *  1/2 逐字母检测、每个错误字母一事件 → applyLetter 的 wrong 分支
 *  3   同词合并、错误次数 +N、更新最近错误时间 → 错词本按 (owner, word_id)
 *      聚合 append-only 事件行（见 spellingWrongBook.ts），不另建记录表
 *  4   错误提示音 → LetterResult.outcome==='wrong' 时由持久化层播放
 *  5   输入进度清零 → typed_prefix = ''
 *  6   连续正确次数归零 → consecutive_correct = 0
 *  7   单个错误字母不是完整答题提交 → 不调 applyAttempt，is_full_attempt=false
 *  8   不污染 SRS / total_attempts → 错误分支不动这两个字段、srs_due=false
 *  9   错词本独立于 SRS 错题系统 → 只读 v14 事件表，不碰 in_wrong_pool / recordQuiz
 * 10   事件 ID 幂等 → event_id 绑定 request_id + addIfAbsent 主键幂等
 *
 * 【持久化形态，零 schema 变更】
 * 逐字母进度挂在 SpellingWordState.typed_prefix（行内可选字段，内嵌在会话文档，
 * 随整份 put 原子落库）；幂等回放挂在 SpellingSession.processed_letters（行内可选）。
 * 不改 Dexie version / stores() / 迁移。
 */

import type { SpellingErrorEvent, SpellingErrorEventKind } from './types'
import {
  advance,
  cloneSession,
  isTerminal,
  type SpellingSession,
  type SpellingWordState,
  type SpellingWordStatus,
  type SpellingSessionStatus,
  type SessionProgress,
} from './spelling'
import { sessionProgress } from './spelling'

/** 允许输入的单字符：与 VALID_ANSWER_RE 的字符集一致（含连字符 / 撇号） */
const LETTER_RE = /^[A-Za-z'’-]$/

export type LetterOutcome =
  | 'correct' /* 字母正确，进度推进 */
  | 'wrong' /* 字母错误，产生 1 条错误事件规格 */
  | 'word_completed' /* 整词达标完成并切换 */
  | 'session_completed' /* 会话自然结束 */
  | 'ignored' /* 非法字符 / 终态词条 / 空白，不计数不改变状态 */

/** 一个错误字母的事件规格（由持久化层落成 v14 事件行，此处不碰 storage） */
export interface LetterErrorSpec {
  event_id: string
  word_id: string
  session_id: string
  word_snapshot: string
  letter_index: number
  typed_char: string
  expected_char: string
  occurred_at: number
}

export interface LetterResult {
  request_id: string
  word_id: string
  outcome: LetterOutcome
  /** 当前词已正确输入的字母前缀（错误后为空） */
  typed_prefix: string
  /** 下一个待输入字母位置 */
  letter_index: number
  word_length: number
  word_status: SpellingWordStatus
  session_status: SpellingSessionStatus
  /** 词级连续正确（拼完整个单词）次数；错误字母归零 */
  consecutive_correct: number
  target_correct: number
  /** 完整答题提交次数；错误字母不增加 */
  total_attempts: number
  correct_attempts: number
  wrong_attempts: number
  /** true 仅当本次拼完整个单词（一次完整答题提交） */
  is_full_attempt: boolean
  /** true 仅当整词达标完成且尚未交接 SRS；错误字母恒为 false */
  srs_due: boolean
  next_word_id: string | null
  progress: SessionProgress
  /** 仅 outcome==='wrong' 时存在 */
  error?: LetterErrorSpec
  at: number
}

export interface ApplyLetterOptions {
  word_id: string
  /** 单个字符 */
  char: string
  /** 幂等键：每次按键一个；同一 id 重放原样回放，不重复计数 */
  request_id: string
  now?: number
}

/** 事件行扩展字段（行内可选，不改 SpellingErrorEvent / Dexie schema） */
export interface LetterErrorEvent extends SpellingErrorEvent {
  letter_index?: number
  typed_char?: string
  expected_char?: string
  word_snapshot?: string
  error_source?: 'letter'
}

/** 构造错误字母事件 ID：与 request_id 一一对应，重放天然幂等 */
export function letterEventId(requestId: string): string {
  return `evt:letter:${requestId}`
}

/** v14 事件 kind 保持 'wrong'（不新增枚举值、不改 stores()） */
export const LETTER_ERROR_KIND: SpellingErrorEventKind = 'wrong'

/**
 * 逐字符判定。返回**全新的** session（绝不修改入参），由持久化层一次 put 落库。
 * 幂等：命中 processed_letters 时原样回放，不二次推进、不二次产生事件。
 */
export function applyLetter(
  session: SpellingSession,
  opts: ApplyLetterOptions,
): { session: SpellingSession; result: LetterResult } {
  const now = opts.now ?? Date.now()
  const cached = session.processed_letters?.[opts.request_id]
  if (cached) return { session, result: cached }

  if (session.status === 'PAUSED' || session.status === 'ABANDONED') {
    throw new Error(`SPELLING_SESSION_NOT_ACTIVE: ${session.status}`)
  }

  const word = session.queue.find((w) => w.position === session.current_position) ?? null
  const base = {
    request_id: opts.request_id,
    word_id: opts.word_id,
    at: now,
  }

  // 会话已结束 / 词条终态 / 词不匹配 / 非法字符 → ignored，不计数、不改状态
  const char = opts.char
  const valid =
    word !== null &&
    !isTerminal(word) &&
    word.word_id === opts.word_id &&
    typeof char === 'string' &&
    LETTER_RE.test(char) &&
    session.status === 'IN_PROGRESS'

  if (!valid) {
    const result: LetterResult = {
      ...base,
      outcome: 'ignored',
      typed_prefix: word?.typed_prefix ?? '',
      letter_index: (word?.typed_prefix ?? '').length,
      word_length: word?.word.length ?? 0,
      word_status: word?.status ?? 'UNAVAILABLE',
      session_status: session.status,
      consecutive_correct: word?.consecutive_correct ?? 0,
      target_correct: word?.target_correct ?? session.target_correct,
      total_attempts: word?.total_attempts ?? 0,
      correct_attempts: word?.correct_attempts ?? 0,
      wrong_attempts: word?.wrong_attempts ?? 0,
      is_full_attempt: false,
      srs_due: false,
      next_word_id: word?.word_id ?? null,
      progress: sessionProgress(session),
    }
    return { session, result }
  }

  const target = word as SpellingWordState
  const next = cloneSession(session)
  const w = next.queue.find((x) => x.word_id === opts.word_id) as SpellingWordState
  const prefix = w.typed_prefix ?? ''
  const index = prefix.length
  const expected = w.word[index] ?? ''
  const correct =
    expected !== '' && char.toLowerCase() === expected.toLowerCase()

  let result: LetterResult
  if (correct) {
    // 用答案里的规范字符推进，避免大小写差异污染前缀
    const nextPrefix = prefix + expected
    if (nextPrefix.length === w.word.length) {
      // 拼完整个单词 = 一次完整答题提交（仅此处动 total_attempts）
      w.total_attempts += 1
      w.correct_attempts += 1
      w.consecutive_correct += 1
      w.typed_prefix = ''
      w.last_attempt_at = now
      const reached = w.consecutive_correct >= w.target_correct
      if (reached) w.status = 'COMPLETED'
      else w.status = 'IN_PROGRESS'
      advance(next, now)
      const isLast = next.status === 'SESSION_COMPLETED'
      result = buildResult(next, w, {
        ...base,
        outcome: isLast ? 'session_completed' : reached ? 'word_completed' : 'correct',
        typed_prefix: '',
        letter_index: 0,
        is_full_attempt: true,
        srs_due: reached && !w.srs_reported,
        at: now,
      })
    } else {
      w.typed_prefix = nextPrefix
      w.status = 'IN_PROGRESS'
      result = buildResult(next, w, {
        ...base,
        outcome: 'correct',
        typed_prefix: nextPrefix,
        letter_index: nextPrefix.length,
        is_full_attempt: false,
        srs_due: false,
        at: now,
      })
    }
  } else {
    // 错词字母：进度清零 + 连对归零；**不**动 attempts / SRS
    w.typed_prefix = ''
    w.consecutive_correct = 0
    w.status = 'IN_PROGRESS'
    result = buildResult(next, w, {
      ...base,
      outcome: 'wrong',
      typed_prefix: '',
      letter_index: 0,
      is_full_attempt: false,
      srs_due: false,
      error: {
        event_id: letterEventId(opts.request_id),
        word_id: opts.word_id,
        session_id: session.id,
        word_snapshot: w.word,
        letter_index: index,
        typed_char: char,
        expected_char: expected,
        occurred_at: now,
      },
      at: now,
    })
  }

  next.updated_at = now
  next.processed_letters = {
    ...(next.processed_letters ?? {}),
    [opts.request_id]: result,
  }
  return { session: next, result }
}

function buildResult(
  session: SpellingSession,
  w: SpellingWordState,
  extra: Pick<LetterResult, 'request_id' | 'word_id' | 'outcome' | 'typed_prefix' | 'letter_index' | 'is_full_attempt' | 'srs_due' | 'at'> & {
    error?: LetterErrorSpec
  },
): LetterResult {
  const nextWord = session.queue
    .filter((x) => !isTerminal(x))
    .sort((a, b) => a.position - b.position)[0]
  return {
    ...extra,
    word_length: w.word.length,
    word_status: w.status,
    session_status: session.status,
    consecutive_correct: w.consecutive_correct,
    target_correct: w.target_correct,
    total_attempts: w.total_attempts,
    correct_attempts: w.correct_attempts,
    wrong_attempts: w.wrong_attempts,
    next_word_id: nextWord ? nextWord.word_id : null,
    progress: sessionProgress(session),
  }
}
