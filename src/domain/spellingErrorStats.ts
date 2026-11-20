/**
 * 单词默写 V2 · 错词事件分类与统计（纯函数层）
 * ------------------------------------------------------------------
 * 【为什么单独一层】
 * 生产写路径（spellingSession.atomicSubmit / spellingErrorEvents）负责「不丢不重」，
 * 本文件只负责「按持久化状态重算两个统计口径」，二者职责不互相掩盖：
 *   · 结算链路的凭证变化不改变 active 集合成员关系（1.2.3 §1.6 证明）；
 *   · 统计不依赖 status / occurred_at / 内存锁标志，刷新、崩溃、重复 drain 后重算一致。
 *
 * 【严格按 1.2.3 §1.3 的优先级，不得调换】
 *   ① COVERED（reset 覆盖）最高
 *   ② 凭证优先于代次：'stale' → SETTLED_STALE；'zeroed' / true → SETTLED_ZEROED
 *   ③ 只有凭证缺失时才比较 E.lock_epoch 与 S.lock_epoch
 *      → 相等 PENDING_CURRENT（计入 active），不等 PENDING_STALE（不计入）
 *   ④ ORPHAN（会话文档不存在）/ UNCLASSIFIABLE（代次字段缺失）保守：
 *      不计入 active、计入 total、不抛错、不编造数字
 *
 * 【两个指标必须分别标注，绝不混用】
 *   active_wrong_count  当前活动错词事件数（分类派生，会随接管 / reset 单调变化）
 *   total_error_events  历史错误事件行数（等于参与统计的事件行数，与分类无关）
 *   ⚠️ 二者都是「事件行数」口径，**不是**用户主观的「拼错次数」。
 *
 * 【边界，不虚报】
 *   · 当前生产写路径为 atomicBatch 单跨表事务，正常情况下不产生凭证缺失的 pending 事件；
 *     PENDING_* 分支用于历史遗留行、T-B 未执行 / 失败 / 崩溃 / 刷新时的兜底判据。
 *   · 本层是纯函数，不读 storage、不碰平台 API、不改 Dexie version / stores()。
 *   · 1.2.3.1 提出「E.epoch > S.epoch 应单列 EPOCH_AHEAD 并报警」；本文件严格遵守
 *     用户指定的 1.2.3 优先级（不等即 PENDING_STALE），但额外暴露 epochAheadCount
 *     供 UI 提示异常，**不静默吞掉**该争议，裁定见交付报告「证据冲突」栏。
 */

import type { SpellingErrorEvent } from './types'
import type { SpellingSession, SpellingErrorCredential } from './spelling'

/** 结算凭证取值：与 SpellingSession.applied_error_event_ids 同源，避免两处漂移 */
export type ErrorEventCredential = SpellingErrorCredential

export type StatClass =
  | 'COVERED'
  | 'SETTLED_ZEROED'
  | 'SETTLED_STALE'
  | 'PENDING_CURRENT'
  | 'PENDING_STALE'
  | 'ORPHAN'
  | 'UNCLASSIFIABLE'

/** 计入「当前活动错词事件数」的两个分类 */
export const ACTIVE_CLASSES: readonly StatClass[] = ['PENDING_CURRENT', 'SETTLED_ZEROED']

export const STAT_CLASSES: readonly StatClass[] = [
  'COVERED',
  'SETTLED_ZEROED',
  'SETTLED_STALE',
  'PENDING_CURRENT',
  'PENDING_STALE',
  'ORPHAN',
  'UNCLASSIFIABLE',
]

/**
 * UI 文案：两个指标分别标注，禁用「拼错次数」等主观表述。
 * V2 逐字母状态机已落地：每个真实错误字母 = 1 条错误事件；
 * 同一次拼写错多个字母按错误字母数累计。V1 整词提交路径仍保留兼容，
 * 但页面主输入已切到逐字母，旧会话恢复后也从第一个字母开始（typed_prefix 缺省）。
 */
export const STAT_LABELS = {
  active: '当前活动错词事件数',
  total: '历史错误事件行数',
  note: '每个真实错误字母计 1 条错误事件，同一次拼写错多个字母按错误字母数累计。以上是事件行数，不代表主观「拼错次数」。',
  activeHint: '当前会话仍计入活动错词本的错误事件行数',
  totalHint: '本会话历史错误事件行总数（含已结算、旧代次、已移除）',
  /** 当前账号范围说明（不得表述成「全部历史记录」） */
  ownerScope: '仅统计当前账号在本会话内的错词事件，不含其它账号或设备的数据',
  /** 空数据 / 异常提示 */
  empty: '本轮没有错词事件',
  orphan: '另有 {n} 条记录无法归类（会话文档缺失或代次字段不全），未计入活动错词',
  excluded: '已排除 {n} 条旧代次或被移除的记录',
} as const

export interface ClassifyContext {
  /** 必须按 E.session_id 精确读取；没有会话文档时传 null（禁止用 getResumableSession 兜底） */
  session: SpellingSession | null | undefined
  /** 被 reset 覆盖的 event_id 集合；当前源码尚无 reset 写入，由调用方传入（默认空集） */
  covered: ReadonlySet<string>
}

/**
 * 单条事件分类。输入只有持久化状态：covered 成员关系、凭证、两个 lock_epoch 整数、会话存在性。
 * status / occurred_at / tab_id / 客户端时钟 / 内存锁标志**一律不读**。
 */
export function classify(
  event: Pick<SpellingErrorEvent, 'event_id' | 'lock_epoch'>,
  ctx: ClassifyContext,
): StatClass {
  // ① reset 覆盖优先
  if (ctx.covered.has(event.event_id)) return 'COVERED'
  // ⑤ 会话文档不存在
  const session = ctx.session
  if (!session) return 'ORPHAN'
  // ② 凭证是最高权威，一旦写入不再随代次变化
  const credential = session.applied_error_event_ids?.[event.event_id]
  if (credential === 'stale') return 'SETTLED_STALE'
  if (credential === 'zeroed' || credential === true) return 'SETTLED_ZEROED'
  // ③ 仅凭证缺失时回退到代次比较
  if (typeof event.lock_epoch === 'number' && typeof session.lock_epoch === 'number') {
    return event.lock_epoch === session.lock_epoch ? 'PENDING_CURRENT' : 'PENDING_STALE'
  }
  // ④ 脏数据保守处理
  return 'UNCLASSIFIABLE'
}

export interface ErrorStats {
  /** 当前活动错词事件数 = classify ∈ {PENDING_CURRENT, SETTLED_ZEROED} 的行数 */
  active_wrong_count: number
  /** 历史错误事件行数 = 参与统计的事件行数，与分类、凭证、status、epoch 全部解耦 */
  total_error_events: number
  /** 各分类计数，便于测试与诊断 */
  by_class: Record<StatClass, number>
  /** E.lock_epoch > S.lock_epoch（会话落后于事件）的异常行数，供 UI 提示，不改变分类 */
  epoch_ahead_count: number
  /** 无法归类 / 孤儿 / 代次超前的异常行数，供 UI 提示「另有 N 条无法归类」 */
  anomaly_count: number
}

/**
 * 聚合两个指标。
 * @param events 已按 owner / session 过滤好的事件行（调用方保证不串账号）
 * @param sessionOf 按 event.session_id 精确取会话；缺失返回 null
 * @param covered 被 reset 覆盖的 event_id 集合
 */
export function aggregateErrorStats(
  events: readonly Pick<SpellingErrorEvent, 'event_id' | 'session_id' | 'lock_epoch'>[],
  sessionOf: (sessionId: string) => SpellingSession | null | undefined,
  covered: ReadonlySet<string> = new Set<string>(),
): ErrorStats {
  const by_class = Object.fromEntries(STAT_CLASSES.map((c) => [c, 0])) as Record<StatClass, number>
  let epoch_ahead_count = 0

  for (const event of events) {
    const session = sessionOf(event.session_id)
    const cls = classify(event, { session, covered })
    by_class[cls] += 1

    // 1.2.3.1 指出的边界：会话代次落后于已落盘事件属于数据不一致，
    // 严格按 1.2.3 仍归 PENDING_STALE，但单独计数，避免静默丢错词。
    if (
      session &&
      typeof event.lock_epoch === 'number' &&
      typeof session.lock_epoch === 'number' &&
      event.lock_epoch > session.lock_epoch
    ) {
      epoch_ahead_count += 1
    }
  }

  const active_wrong_count = ACTIVE_CLASSES.reduce((sum, c) => sum + by_class[c], 0)
  const anomaly_count =
    by_class.ORPHAN + by_class.UNCLASSIFIABLE + by_class.PENDING_STALE + epoch_ahead_count

  return {
    active_wrong_count,
    total_error_events: events.length,
    by_class,
    epoch_ahead_count,
    anomaly_count,
  }
}
