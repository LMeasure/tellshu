/**
 * 存储服务契约（platform-agnostic）
 * ------------------------------------------------------------------
 * 唯一目的：把「存哪」和「存什么」解耦。
 *
 *   domain/learning.ts  →  只写业务规则（SRS 状态机、统计口径）
 *   services/storage/*  →  只做平台适配（IndexedDB / 内存 / 将来原生壳的 SQLite）
 *
 * 页面与领域代码**禁止** import dexie、禁止直接用 indexedDB。
 * 将来包 Capacitor / 小程序时，只需新增一个实现并在 index.ts 里换掉 driver，
 * 上层一行都不用改。
 *
 * 接口刻意做成「表 + CRUD」这一层，而不是更抽象的仓储：
 * 现有业务逻辑（如 getDailyStats 需要同时遍历 reviewLog/vocab/readingTime）
 * 需要跨表读，包成仓储反而会把业务规则挤进 service 层。
 */

import type { PrimaryKey, StorageSchema, TableName } from '@/domain/types'

/** 单表读写能力。方法集合按现有业务实际用到的操作裁剪，不做全能 ORM。 */
export interface TableService<T> {
  get(key: string | number): Promise<T | undefined>
  put(value: T): Promise<void>
  /** 自增主键表用（reviewLog / diagnose）；返回新主键 */
  add(value: T): Promise<number>
  delete(key: string | number): Promise<void>
  toArray(): Promise<T[]>
  bulkGet(keys: (string | number)[]): Promise<(T | undefined)[]>
  bulkPut(values: T[]): Promise<void>
  count(): Promise<number>
  /**
   * 按**已建索引**的字段做等值查询。
   * 传未建索引的字段应抛错而不是静默全表扫——避免把慢查询藏进业务代码里。
   */
  whereIndex(field: string, value: string | number): Promise<T[]>
  /**
   * 按**已建索引**的字段做前缀匹配（搜索建议 / 自动补全用）。
   * 语义与 whereIndex 一致：字段未建索引直接抛错，不做全表扫描。
   * 大小写敏感，调用方需自行把字段存成小写副本（如 word_lower / base_lower）。
   */
  whereStartsWith(field: string, value: string): Promise<T[]>
  clear(): Promise<void>
}

/* ------------------------------------------------------------------
 * 单表原子读改写（跨标签单写者锁的基础设施）
 * ------------------------------------------------------------------
 * 为什么必须有：TableService 的 put() 是「最后一次写入获胜」，两个标签页
 * 各自 read → 改 → put 会互相覆盖，任何写在应用层的「锁」都会被覆盖掉。
 * updateAtomic 把「读 + 判定 + 写」放进**同一个单表读写事务**，IndexedDB
 * 保证同一 object store 上的 rw 事务串行化，才谈得上 compare-and-swap。
 *
 * 明确边界（不虚报）：这只是**单表**原子，不构成跨表事务；
 * 事件表与会话表之间的窗口仍然存在，靠 event_id 主键 + 凭证幂等收敛。
 * ------------------------------------------------------------------ */

/** reducer 的三种裁决：写入 / 不写回 / 中止并给出原因 */
export type AtomicUpdate<T> =
  | { kind: 'commit'; value: T }
  | { kind: 'skip'; value?: T }
  | { kind: 'abort'; reason: string }

export interface AtomicResult<T> {
  /** true = 本次确实写回了一行 */
  committed: boolean
  /** 写回后的值（skip 时为当前值） */
  value: T | undefined
}

/** reducer 主动中止时抛出；事务回滚，不写回任何内容 */
export class AtomicAbortError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'AtomicAbortError'
  }
}

/* ------------------------------------------------------------------
 * 跨表原子批事务（消除 U11 跨表 TOCTOU / U1 C09/T29 残留窗口）
 * ------------------------------------------------------------------
 * updateAtomic 只在**单表**内串行化，锁校验（会话表）与事件写入（事件表）
 * 分属两个请求，中间仍可插入另一标签的 takeover。atomicBatch 把多个表
 * 纳入**同一个底层 rw 事务**：IndexedDB 保证 scope 重叠的 rw 事务串行执行，
 * 因此「读会话 → 校验 lock_epoch → 写事件 → 写凭证」之间无法被插入写事务。
 *
 * 【硬约束，违反即静默丢事务】
 * scope 内只能 `await` ctx 提供的表句柄（它们返回底层事务内的 Promise）。
 * 绝不能在 scope 内 await 外部 Promise / setTimeout / fetch —— Dexie 会在
 * 非事务 Promise 上结束事务，后续写入落到事务外，原子性失效。
 * scope 必须是同步可判定的纯编排，业务纯函数不得带异步副作用。
 * ------------------------------------------------------------------ */

/** 事务内的最小表句柄（不含索引查询：本轮原子链路只用主键读写） */
export interface BatchTable<T, K extends string | number> {
  get(key: K): Promise<T | undefined>
  put(value: T): Promise<void>
  /** 主键冲突返回 false 且不写；事务内同 key 串行，故检查可靠 */
  addIfAbsent(value: T): Promise<boolean>
}

export type BatchTables<K extends TableName> = {
  [P in K]: BatchTable<StorageSchema[P], PrimaryKey<P>>
}

export interface BatchDecision<R> {
  /** false = 主动放弃，整个事务回滚（不做任何写入） */
  commit: boolean
  result: R
}

export interface BatchResult<R> {
  committed: boolean
  result: R
}

/** scope 主动放弃提交时抛出，由驱动捕获并转成 committed:false */
export class AtomicRollbackError<R> extends Error {
  constructor(readonly result: R) {
    super('ATOMIC_ROLLBACK')
    this.name = 'AtomicRollbackError'
  }
}

/** 底层连接生命周期事件：升级阻塞 / 被其它连接抢占 / 重新就绪 */
export type StorageLifecycleEvent =
  | { type: 'ready' }
  | { type: 'blocked' }
  | { type: 'versionchange' }

export interface StorageService {
  /** 当前实现标识，用于排查与单测断言 */
  readonly driver: 'dexie' | 'memory'
  table<K extends TableName>(name: K): TableService<StorageSchema[K]>
  /** 打开/升级底层库（幂等）。页面启动时调用一次即可。 */
  open(): Promise<void>
  /** 清空全部本地学习数据（设置页「清除数据」用）。 */
  clearAll(): Promise<void>

  /**
   * 单表原子读改写。reducer 必须是**纯同步函数**（事务内不能 await 外部 Promise）。
   * 返回 abort 时抛 AtomicAbortError；返回 skip 时不写回。
   */
  updateAtomic<K extends TableName>(
    name: K,
    key: PrimaryKey<K>,
    reducer: (current: StorageSchema[K] | undefined) => AtomicUpdate<StorageSchema[K]>,
  ): Promise<AtomicResult<StorageSchema[K]>>

  /** 主键冲突即返回 false，不覆盖已有行（事件表 insertIfAbsent 幂等原语） */
  insertIfAbsent<K extends TableName>(name: K, value: StorageSchema[K]): Promise<boolean>

  /**
   * 跨表原子批事务：tables 内所有读写落在同一个底层 rw 事务。
   * commit:false 或抛错 → 全部回滚，返回 committed:false 或原样抛错。
   * scope 内禁止 await 非 ctx 的 Promise（见上方硬约束）。
   */
  atomicBatch<K extends TableName, R>(
    tables: readonly K[],
    scope: (ctx: BatchTables<K>) => Promise<BatchDecision<R>>,
  ): Promise<BatchResult<R>>

  /** 订阅 blocked / versionchange / ready；返回取消订阅函数 */
  subscribeLifecycle(listener: (event: StorageLifecycleEvent) => void): () => void
}

/** 便捷别名：`storage.table('vocab')` 的返回类型 */
export type VocabTable = TableService<StorageSchema['vocab']>
export type PrimaryKeyOf<K extends TableName> = PrimaryKey<K>
