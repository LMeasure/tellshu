/**
 * 单词默写 V2 · 错词本（只读聚合，独立于 SRS 错题系统）
 * ------------------------------------------------------------------
 * 【实体边界】产品规则 9：错词本独立于既有 SRS 错题系统。
 *   · 本模块**只读** v14 spellingErrorEvents 表（append-only 事件行）；
 *   · 不读 / 不写 VocabEntry.in_wrong_pool，不调 recordQuiz()；
 *   · V1 的 SRS 交接只在「整词达标 COMPLETED」时发生，与错误字母事件无关。
 *
 * 【合并规则】产品规则 3：同一单词已有错词记录时合并，错误次数增加对应
 *   错误字母数，更新最近错误时间。
 *   · 每个错误字母 = 1 条事件行 → 按 (owner, word_id) 分组，行数即错误次数；
 *   · 同词多次错误 → 多行 append-only 追加，聚合时自然合并（无需 upsert 记录表）；
 *   · last_error_at 取该词所有事件行 occurred_at 的最大值，**仅用于展示**，
 *     不参与 classify（1.2.3 §1.6：分类不依赖 occurred_at / status）。
 *
 * 【两个指标仍然分开】
 *   active_wrong_count  当前活动错词事件数（classification 派生）
 *   total_error_events  历史错误事件行数（恒等于行数，含 stale / covered / orphan）
 *   两者都是事件行数口径，不是主观「拼错次数」。
 *
 * 【零 schema 变更】不新增表、不改 stores()、不改 version、不做迁移。
 */

import type { SpellingErrorEvent } from './types'
import type { SpellingSession } from './spelling'
import { aggregateErrorStats, classify, type ErrorStats } from './spellingErrorStats'

/** 参与错词本聚合的最小事件形状 */
export interface WrongBookEvent
  extends Pick<SpellingErrorEvent, 'event_id' | 'session_id' | 'word_id' | 'owner' | 'lock_epoch'> {
  occurred_at?: number
  word_snapshot?: string
  /** reset 行携带的覆盖快照（内容寻址） */
  covered_event_ids?: string[]
}

export interface WrongWordRecord {
  word_id: string
  /** 词条文本快照（来自事件行；缺失为 null，绝不编造） */
  word: string | null
  /** 当前活动错词事件数（= 该词活动错误字母数） */
  active_wrong_count: number
  /** 历史错误事件行数（含旧代次 / 已移除 / 无法归类） */
  total_error_events: number
  /** 最近错误时间（epoch ms），仅展示用；无事件时为 null */
  last_error_at: number | null
  /** 分类明细，供结果页展示「已排除 / 无法归类」 */
  by_class: ErrorStats['by_class']
  /** 无法归类 / 孤儿 / 旧代次的行数（供 ORPHAN 异常提示） */
  anomaly_count: number
  orphan_count: number
  unclassifiable_count: number
}

export interface WrongWordBook {
  owner: string
  records: WrongWordRecord[]
  /** 全部记录的两个指标合计（分别标注，不混用） */
  active_wrong_count: number
  total_error_events: number
  /** 跨词合计的异常行数 */
  anomaly_count: number
  orphan_count: number
  unclassifiable_count: number
}

/** reset 行：内容寻址识别（与 loadSessionErrorStats 同一判据） */
function isResetRow(row: WrongBookEvent): boolean {
  return Array.isArray(row.covered_event_ids) || (row as { kind?: string }).kind === 'reset'
}

/**
 * 纯聚合：把事件行按 (owner, word_id) 合并成错词本记录。
 * @param rows     已按 owner / session 过滤好的事件行（调用方保证不串账号）
 * @param sessionOf 按 event.session_id 精确读会话；缺失返回 null（→ ORPHAN）
 * @param owner    当前账号，写进结果用于 UI 标注范围
 * @param covered  被 reset 覆盖的 event_id 集合（默认从 rows 中 reset 快照并集构造）
 */
export function aggregateWrongWordBook(
  rows: readonly WrongBookEvent[],
  sessionOf: (sessionId: string) => SpellingSession | null | undefined,
  owner: string,
  covered: ReadonlySet<string> = collectCovered(rows),
): WrongWordBook {
  const byWord = new Map<string, WrongBookEvent[]>()
  const resetRows: WrongBookEvent[] = []
  for (const row of rows) {
    if (isResetRow(row)) {
      resetRows.push(row)
      continue
    }
    if (row.owner !== owner) continue
    const list = byWord.get(row.word_id)
    if (list) list.push(row)
    else byWord.set(row.word_id, [row])
  }

  const records: WrongWordRecord[] = []
  for (const [word_id, events] of byWord) {
    const stats = aggregateErrorStats(events, sessionOf, covered)
    let last_error_at: number | null = null
    let word: string | null = null
    for (const e of events) {
      if (typeof e.occurred_at === 'number' && (last_error_at === null || e.occurred_at > last_error_at)) {
        last_error_at = e.occurred_at
      }
      if (word === null && typeof e.word_snapshot === 'string' && e.word_snapshot.length > 0) {
        word = e.word_snapshot
      }
    }
    records.push({
      word_id,
      word,
      active_wrong_count: stats.active_wrong_count,
      total_error_events: stats.total_error_events,
      last_error_at,
      by_class: stats.by_class,
      anomaly_count: stats.anomaly_count,
      orphan_count: stats.by_class.ORPHAN,
      unclassifiable_count: stats.by_class.UNCLASSIFIABLE,
    })
  }

  // 稳定排序：错误次数降序 → word_id 升序（不依赖 occurred_at、客户端时钟或插入顺序）
  records.sort(
    (a, b) =>
      b.active_wrong_count - a.active_wrong_count ||
      b.total_error_events - a.total_error_events ||
      a.word_id.localeCompare(b.word_id),
  )

  const sum = (pick: (r: WrongWordRecord) => number): number =>
    records.reduce((n, r) => n + pick(r), 0)

  return {
    owner,
    records,
    active_wrong_count: sum((r) => r.active_wrong_count),
    total_error_events: sum((r) => r.total_error_events),
    anomaly_count: sum((r) => r.anomaly_count),
    orphan_count: sum((r) => r.orphan_count),
    unclassifiable_count: sum((r) => r.unclassifiable_count),
  }
}

/** reset 快照并集：集合天然幂等，重复 reset 不扩大覆盖范围 */
export function collectCovered(rows: readonly WrongBookEvent[]): Set<string> {
  const covered = new Set<string>()
  for (const row of rows) {
    if (!isResetRow(row)) continue
    for (const id of row.covered_event_ids ?? []) covered.add(id)
  }
  return covered
}

/** 单条事件的分类（供结果页 / 测试断言，输入只有持久化状态） */
export function classifyWrongBookEvent(
  event: WrongBookEvent,
  session: SpellingSession | null | undefined,
  covered: ReadonlySet<string>,
): ReturnType<typeof classify> {
  return classify(event, { session, covered })
}

/** 重置行数量（供统计展示，不编造） */
export function countResetRows(rows: readonly WrongBookEvent[]): number {
  return rows.filter(isResetRow).length
}
