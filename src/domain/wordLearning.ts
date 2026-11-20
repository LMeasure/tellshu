/**
 * 单词学习进度 · 持久化层（Dexie v11 表 wordLearningSessions）
 * ------------------------------------------------------------------
 * 背景（2026-10-31 修复）：此前 /learn 的全部进度（组号 / 组内下标）只活在
 * React useState 里，退出、刷新、重进一律从第 1 组第 1 张重来 —— 这就是
 * 「已学过的词又回到眼前」的根因。本文件把进度搬到本地库，规则如下：
 *
 * 【存什么】一份会话文档 = **完整有序队列（词 id）+ 位置 + 已完成集合**。
 *   · 队列持久化的是「顺序」，不是内容：释义 / 例句 / 词源按 id 从词包回查，
 *     避免把 5MB 内容复制进库，也避免库里内容与词包版本漂移；
 *   · position 是队列下标，与 completed 一起决定「学到哪了」，二者由
 *     applyMove 单点写入，不出现「索引与完成状态不同步」；
 *   · 一个「词本 × 难度档」一份文档（id = `${book}::${level ?? 'all'}`）。
 *
 * 【单文档写入】与 spellingSession.ts 同口径：TableService 没有事务 API，
 * 所有变更都压在一次 put() 上（整份文档换掉），写入失败 = 什么都没发生。
 *
 * 【不做什么】
 *   · 不碰 vocab / reviewLog / spellingSessions，不改任何历史数据；
 *   · 不因恢复失败而清空进度 —— 队列里 id 解析不出来就剔除该 id 并保留
 *     其余顺序，位置按锚点词 id 重新定位，绝不回退到 0；
 *   · 重学（restart）是**唯一**会清 completed 的路径，且只能由用户显式触发。
 */

import { storage } from '../services/storage'
import type { ContentWord } from '../data/types'

const SESSIONS = storage.table('wordLearningSessions')
const VOCAB = storage.table('vocab')

const DEFAULT_OWNER = 'guest'

export type WordLearningLevel = 1 | 2 | 3 | null

/** 一个「词本 × 难度档」的学习会话（单文档，整份 put 覆盖） */
export interface WordLearningSession {
  /** PK：`${book}::${level ?? 'all'}` */
  id: string
  book: string
  level: WordLearningLevel
  /** 完整学习队列：词 id 的**顺序**即学习顺序 */
  queue: string[]
  /** 队列下标（0-based），指向当前正在学的词 */
  position: number
  /** 已学完（推进过）的词 id；去重集合，语义上用数组存以便结构化克隆 */
  completed: string[]
  /** 建队列时的每组词数（设置改动后重新分组，但 position 不动） */
  batch_size: number
  created_at: number
  updated_at: number
  owner: string
  /** 手势提示是否已展示过（纯 UI，不参与进度判定） */
  gesture_hinted?: boolean
}

/* ------------------------------------------------------------------ */
/* 纯函数（可单测，不碰 storage）                                      */
/* ------------------------------------------------------------------ */

export function sessionIdOf(book: string, level: WordLearningLevel): string {
  return `${book}::${level ?? 'all'}`
}

/** 按传入顺序建队列（顺序即学习顺序，不做二次排序） */
export function buildQueue(words: readonly { id: string }[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    if (!w.id || seen.has(w.id)) continue
    seen.add(w.id)
    out.push(w.id)
  }
  return out
}

/** 位置夹紧：队列为空 → 0；越界 → 末位（绝不出现空白卡片） */
export function clampPosition(position: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(position)) return 0
  const p = Math.trunc(position)
  if (p < 0) return 0
  if (p > length - 1) return length - 1
  return p
}

/** 当前组（每组 batch_size 个）在队列里的区间；batch_size 非法时退化为 1 */
export function groupOf(session: WordLearningSession): {
  index: number
  start: number
  end: number
  total: number
} {
  const size = Math.max(1, Math.trunc(session.batch_size) || 1)
  const total = Math.max(1, Math.ceil(session.queue.length / size))
  const index = Math.min(Math.floor(session.position / size), total - 1)
  const start = index * size
  const end = Math.min(start + size, session.queue.length)
  return { index, start, end, total }
}

/** 是否组内最后一张（含「队列末尾」这一真实边界） */
export function isLastInGroup(session: WordLearningSession): boolean {
  const g = groupOf(session)
  return session.position >= g.end - 1 || session.position >= session.queue.length - 1
}

export function isLastGroup(session: WordLearningSession): boolean {
  const g = groupOf(session)
  return g.index >= g.total - 1
}

/** 当前词的 id（队列为空时返回 null） */
export function currentId(session: WordLearningSession): string | null {
  if (session.queue.length === 0) return null
  return session.queue[clampPosition(session.position, session.queue.length)] ?? null
}

/** 已学完：站在队列最后一个词上，且最后一个词已标记完成 */
export function isFinished(session: WordLearningSession): boolean {
  if (session.queue.length === 0) return true
  const last = session.queue[session.queue.length - 1]
  return session.position >= session.queue.length - 1 && session.completed.includes(last)
}

/** 已完成数（只数仍在队列里的，避免历史残留把计数算虚高） */
export function completedCount(session: WordLearningSession): number {
  const inQueue = new Set(session.queue)
  return session.completed.reduce((n, id) => (inQueue.has(id) ? n + 1 : n), 0)
}

/** 剩余数 = 队列长度 - 已完成数（永不为负） */
export function remainingCount(session: WordLearningSession): number {
  return Math.max(0, session.queue.length - completedCount(session))
}

/** 把当前词标记为已完成（幂等：重复调用不会重复计数） */
export function markCurrentCompleted(session: WordLearningSession): WordLearningSession {
  const id = currentId(session)
  if (!id || session.completed.includes(id)) return session
  return { ...session, completed: [...session.completed, id], updated_at: Date.now() }
}

/**
 * 前进一步（dir=1）/ 后退一步（dir=-1）。
 * 规则：
 *   · 前进 = 把**当前词**标记完成 + 位置 +1；到队列末尾不再前进（返回原对象）；
 *   · 后退 = 只回退位置，不动 completed（回去看已经学过的词，不该清掉它的完成态）；
 *   · 边界一律返回**同一个对象引用**，调用方可用 `next === prev` 判断是否真的发生了切换。
 */
export function applyMove(session: WordLearningSession, dir: 1 | -1): WordLearningSession {
  if (session.queue.length === 0) return session
  const pos = clampPosition(session.position, session.queue.length)
  if (dir === -1) {
    if (pos <= 0) return session
    return { ...session, position: pos - 1, updated_at: Date.now() }
  }
  if (pos >= session.queue.length - 1) return session
  const leaving = session.queue[pos]
  const completed = session.completed.includes(leaving)
    ? session.completed
    : [...session.completed, leaving]
  return { ...session, position: pos + 1, completed, updated_at: Date.now() }
}

/**
 * 重学（唯一会清 completed 的路径，只能由用户显式触发）。
 *   scope='group' —— 回到本组第一张，清掉本组词的完成态；
 *   scope='all'   —— 回到整本第一张，清空全部完成态。
 */
export function restart(
  session: WordLearningSession,
  scope: 'group' | 'all',
): WordLearningSession {
  if (scope === 'all') {
    return { ...session, position: 0, completed: [], updated_at: Date.now() }
  }
  const g = groupOf(session)
  const inGroup = new Set(session.queue.slice(g.start, g.end))
  return {
    ...session,
    position: g.start,
    completed: session.completed.filter((id) => !inGroup.has(id)),
    updated_at: Date.now(),
  }
}

/**
 * 用当前词包的词表校正一份会话（词包换版 / 词表增删时用）。
 * 原则：**保留原顺序与原位置**，只做三件事 ——
 *   1. 队列里已不存在的 id 剔除（anchored 到锚点词，位置不回退）；
 *   2. 词包新增的词追加到队尾（不动原有顺序）；
 *   3. completed 里已不存在的 id 剔除。
 * 返回 null 表示没有任何变化（调用方不必回写）。
 */
export function reconcileQueue(
  session: WordLearningSession,
  words: readonly { id: string }[],
  batchSize?: number,
): WordLearningSession | null {
  const known = new Set<string>()
  const fresh: string[] = []
  for (const w of words) {
    if (!w.id || known.has(w.id)) continue
    known.add(w.id)
    fresh.push(w.id)
  }
  const anchor = currentId(session)
  // 去重 + 去失效：库里若存进了重复 id（历史脏数据），会让分组与计数失真
  const kept: string[] = []
  const keptSet = new Set<string>()
  for (const id of session.queue) {
    if (!known.has(id) || keptSet.has(id)) continue
    keptSet.add(id)
    kept.push(id)
  }
  const appended = fresh.filter((id) => !keptSet.has(id))
  const queue = [...kept, ...appended]
  const completed = session.completed.filter((id) => known.has(id))
  const nextBatch = batchSize && batchSize > 0 ? batchSize : session.batch_size

  let position = session.position
  if (anchor && queue.includes(anchor)) {
    position = queue.indexOf(anchor)
  } else {
    position = clampPosition(position, queue.length)
  }

  const sameLength =
    queue.length === session.queue.length && completed.length === session.completed.length
  const sameOrder = sameLength && queue.every((id, i) => id === session.queue[i])
  const sameCompleted =
    completed.length === session.completed.length &&
    completed.every((id, i) => id === session.completed[i])
  if (sameOrder && sameCompleted && position === session.position && nextBatch === session.batch_size) {
    return null
  }
  return {
    ...session,
    queue,
    completed,
    position,
    batch_size: nextBatch,
    updated_at: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 读写（唯一对外入口）                                                */
/* ------------------------------------------------------------------ */

export interface LoadSessionInput {
  book: string
  level: WordLearningLevel
  /** 已按展示顺序排好的词表（顺序即学习顺序） */
  words: readonly { id: string }[]
  batchSize: number
}

export interface LoadSessionResult {
  session: WordLearningSession
  /** true = 本次新建（首次进入 / 库里没有） */
  created: boolean
  /** 新建时因「已在生词本」被直接跳过（标为已完成）的词数 */
  skippedLearned: number
  /** 恢复时因词包里已查不到而被剔除的 id 数 */
  dropped: number
}

/**
 * 读取已有会话；没有才新建。
 * 新建时把**已在生词本里的词**标为已完成，位置落在第一个没学过的词上 ——
 * 这样「已完成的单词不会在当前学习队列里无故重新出现」（用户 2026-10-31 拍板）。
 * 已学过的词仍留在队列里，右滑可以回看，只是不再挡在学习路径的最前面。
 */
export async function loadOrCreateSession(input: LoadSessionInput): Promise<LoadSessionResult> {
  const id = sessionIdOf(input.book, input.level)
  const queue = buildQueue(input.words)
  const existing = await SESSIONS.get(id)

  if (existing) {
    let dropped = 0
    const patched = reconcileQueue(existing, input.words, input.batchSize)
    let session = patched ?? existing
    if (patched) {
      const kept = new Set(patched.queue)
      dropped = existing.queue.reduce((n, id) => (kept.has(id) ? n : n + 1), 0)
      await SESSIONS.put(session)
    }
    // 兜底：库里文档异常（position 越界等）也要保证能渲染出一张卡
    const safePosition = clampPosition(session.position, session.queue.length)
    if (safePosition !== session.position) {
      session = { ...session, position: safePosition }
      await SESSIONS.put(session)
    }
    return { session, created: false, skippedLearned: 0, dropped }
  }

  const now = Date.now()
  let completed: string[] = []
  if (queue.length > 0) {
    // 已在生词本 = 已经学过的词（vocab.word_id 与 ContentWord.id 同口径，见 learning.makeWordId）
    const rows = await VOCAB.bulkGet(queue)
    completed = queue.filter((_, i) => rows[i] !== undefined)
  }
  const firstUnlearned = queue.findIndex((w) => !completed.includes(w))
  const position =
    firstUnlearned >= 0 ? firstUnlearned : clampPosition(queue.length - 1, queue.length)
  const session: WordLearningSession = {
    id,
    book: input.book,
    level: input.level,
    queue,
    position,
    completed,
    batch_size: Math.max(1, Math.trunc(input.batchSize) || 1),
    created_at: now,
    updated_at: now,
    owner: DEFAULT_OWNER,
  }
  await SESSIONS.put(session)
  return { session, created: true, skippedLearned: completed.length, dropped: 0 }
}

/** 保存（整份覆盖）。失败向上抛，由调用方决定要不要提示 —— 绝不静默吞掉。 */
export async function saveSession(session: WordLearningSession): Promise<void> {
  await SESSIONS.put({ ...session, updated_at: Date.now() })
}

export async function getSession(
  book: string,
  level: WordLearningLevel,
): Promise<WordLearningSession | undefined> {
  return SESSIONS.get(sessionIdOf(book, level))
}

/** 把队列 id 解析成词（回查词包）；解析不出的 id 直接丢掉，不占位、不空白。 */
export function resolveQueue(
  session: WordLearningSession,
  words: readonly ContentWord[],
): ContentWord[] {
  const byId = new Map<string, ContentWord>()
  for (const w of words) if (w.id && !byId.has(w.id)) byId.set(w.id, w)
  const out: ContentWord[] = []
  for (const id of session.queue) {
    const w = byId.get(id)
    if (w) out.push(w)
  }
  return out
}
