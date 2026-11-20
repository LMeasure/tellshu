/**
 * 存储服务 · 内存实现
 * ------------------------------------------------------------------
 * 两个用途：
 *   1. **单测**：不依赖 fake-indexeddb 也能跑领域逻辑（SRS 状态机、统计口径）；
 *   2. **降级兜底**：无 IndexedDB 的环境（SSR / 隐私模式初始化失败）不至于白屏，
 *      数据不落盘但功能可走通，并在控制台给出明确告警。
 *
 * 行为对齐 Dexie 实现的关键点：
 *   - `add` 对自增主键表自增，对字符串主键表按主键写入并返回 0
 *   - `put` 覆盖写；`bulkGet` 保序返回，缺失位为 undefined
 *   - `whereIndex` 校验字段是否「已索引」，与 web 实现同样的报错语义
 *   - **存引用而非深拷贝**：与 IndexedDB 的结构化克隆不同，这里的对象是共享的。
 *     单测里若依赖「读出来是副本」的行为会失真，务必按不可变方式使用。
 */

import type { PrimaryKey, StorageSchema, TableName } from '@/domain/types'
import {
  AtomicAbortError,
  type AtomicResult,
  type AtomicUpdate,
  type BatchDecision,
  type BatchResult,
  type BatchTables,
  type StorageLifecycleEvent,
  type StorageService,
  type TableService,
} from './types'

const INDEXED_FIELDS: Record<TableName, readonly string[]> = {
  vocab: ['word_id', 'word', 'layer', 'next_review', 'added_at'],
  reviewLog: ['id', 'word_id', 'at'],
  readings: ['id', 'created_at', 'type', 'on_shelf', 'owner'],
  readingTime: ['date'],
  diagnose: ['id', 'at'],
  recitations: ['id', 'created_at', 'doc_id', 'owner'],
  dictEntries: ['key', 'word_lower', 'pos', 'updated_at'],
  dictToc: ['id', 'book', 'page_start'],
  dictGrammar: ['key', 'base_lower', 'type'],
  dictMeta: ['key'],
  annotations: ['id', 'doc_id', 'created_at', 'owner'],
  collections: ['id', 'owner', 'updated_at'],
  settings: ['owner'],
  session: ['user_id'],
  sync_queue: ['id', 'entity', 'entity_id', 'created_at', 'attempts'],
  sync_meta: ['key'],
  transcripts: ['id', 'created_at', 'source', 'owner'],
  studyNotes: ['id', 'transcript_id', 'status', 'created_at', 'updated_at', 'source', 'owner'],
  spellingSessions: ['id', 'status', 'started_at', 'owner'],
  wordLearningSessions: ['id', 'book', 'level', 'updated_at', 'owner'],
  // v14：单词默写 V2 错词事件（镜像 web.ts；kind/status 为实施草案）
  spellingErrorEvents: ['event_id', 'owner', 'word_id', 'session_id', 'kind', 'occurred_at', 'status'],
}

const AUTO_INCREMENT: Record<TableName, string | null> = {
  vocab: null,
  reviewLog: 'id',
  readings: null,
  readingTime: null,
  diagnose: 'id',
  recitations: null,
  dictEntries: null,
  dictToc: null,
  dictGrammar: null,
  dictMeta: null,
  annotations: null,
  collections: null,
  settings: null,
  session: null,
  sync_queue: null,
  sync_meta: null,
  transcripts: null,
  studyNotes: null,
  spellingSessions: null,
  wordLearningSessions: null,
  spellingErrorEvents: null,
}

const PRIMARY_KEY: Record<TableName, string> = {
  vocab: 'word_id',
  reviewLog: 'id',
  readings: 'id',
  readingTime: 'date',
  diagnose: 'id',
  recitations: 'id',
  dictEntries: 'key',
  dictToc: 'id',
  dictGrammar: 'key',
  dictMeta: 'key',
  annotations: 'id',
  collections: 'id',
  settings: 'owner',
  session: 'user_id',
  sync_queue: 'id',
  sync_meta: 'key',
  transcripts: 'id',
  studyNotes: 'id',
  spellingSessions: 'id',
  wordLearningSessions: 'id',
  spellingErrorEvents: 'event_id',
}

class MemoryTableService<T extends Record<string, unknown>> implements TableService<T> {
  private readonly rows = new Map<string | number, T>()
  private nextAuto = 1

  constructor(
    private readonly name: TableName,
    private readonly clone: boolean,
  ) {}

  /** 结构化克隆不可用时退化为引用；避免在 Node 单测里引入额外依赖 */
  private copy(row: T): T {
    return this.clone ? structuredClone(row) : row
  }

  get(key: string | number): Promise<T | undefined> {
    const row = this.rows.get(key)
    return Promise.resolve(row ? this.copy(row) : undefined)
  }

  put(value: T): Promise<void> {
    this.rows.set(value[PRIMARY_KEY[this.name]] as string | number, this.copy(value))
    return Promise.resolve()
  }

  add(value: T): Promise<number> {
    const autoField = AUTO_INCREMENT[this.name]
    if (!autoField) {
      this.rows.set(value[PRIMARY_KEY[this.name]] as string | number, this.copy(value))
      return Promise.resolve(0)
    }
    const id = this.nextAuto++
    this.rows.set(id, this.copy({ ...value, [autoField]: id }))
    return Promise.resolve(id)
  }

  delete(key: string | number): Promise<void> {
    this.rows.delete(key)
    return Promise.resolve()
  }

  toArray(): Promise<T[]> {
    return Promise.resolve([...this.rows.values()].map((r) => this.copy(r)))
  }

  bulkGet(keys: (string | number)[]): Promise<(T | undefined)[]> {
    return Promise.resolve(
      keys.map((k) => {
        const row = this.rows.get(k)
        return row ? this.copy(row) : undefined
      }),
    )
  }

  bulkPut(values: T[]): Promise<void> {
    for (const v of values) this.rows.set(v[PRIMARY_KEY[this.name]] as string | number, this.copy(v))
    return Promise.resolve()
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.size)
  }

  whereIndex(field: string, value: string | number): Promise<T[]> {
    const indexed = INDEXED_FIELDS[this.name]
    if (!indexed.includes(field)) {
      return Promise.reject(
        new Error(
          `[storage] 表 ${this.name} 的字段 ${field} 未建索引，无法等值查询（已索引：${indexed.join(', ')}）`,
        ),
      )
    }
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r[field] === value).map((r) => this.copy(r)),
    )
  }

  whereStartsWith(field: string, value: string): Promise<T[]> {
    const indexed = INDEXED_FIELDS[this.name]
    if (!indexed.includes(field)) {
      return Promise.reject(
        new Error(
          `[storage] 表 ${this.name} 的字段 ${field} 未建索引，无法前缀查询（已索引：${indexed.join(', ')}）`,
        ),
      )
    }
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => typeof r[field] === 'string' && (r[field] as string).startsWith(value))
        .map((r) => this.copy(r)),
    )
  }

  clear(): Promise<void> {
    this.rows.clear()
    return Promise.resolve()
  }

  /**
   * 同步 CAS：读 → reducer → 写全程不 await。
   * 若用 `await this.get()`，两个并发 updateAtomic 会在微任务边界交错成
   * last-writer-wins（实测两次 +1 只得到 1）；这里保持同步执行，
   * 与 Dexie rw 事务的串行化语义一致。reducer 抛错时未写回 = 事务回滚。
   */
  atomicSync<R>(
    key: string | number,
    reducer: (current: T | undefined) => { value?: T; result: R },
  ): R {
    const existing = this.rows.get(key)
    const current = existing === undefined ? undefined : this.copy(existing)
    const { value, result } = reducer(current)
    if (value !== undefined) this.rows.set(key, this.copy(value))
    return result
  }

  /** 跨表批事务的回滚快照（深拷贝，避免事务内写入污染快照） */
  snapshot(): Array<[string | number, T]> {
    return [...this.rows.entries()].map(([k, v]) => [k, this.copy(v)] as [string | number, T])
  }

  restore(snap: Array<[string | number, T]>): void {
    this.rows.clear()
    for (const [k, v] of snap) this.rows.set(k, this.copy(v))
  }
}

const tables = new Map<TableName, MemoryTableService<Record<string, unknown>>>()

/**
 * 内存驱动的批事务队列：atomicBatch 的 scope 是 async，await 会引入微任务边界，
 * 用队列保证同一时刻只有一个批事务在跑，模拟 IDB 的 rw 事务串行化。
 * 边界（如实标注）：updateAtomic / insertIfAbsent 是同步原语，不走此队列，
 * 因此 memory 驱动不宣称「atomicBatch 与 updateAtomic 互相串行」；
 * 双驱动对照只断言批事务自身语义一致。
 */
let batchQueue: Promise<unknown> = Promise.resolve()

/** structuredClone 在 Node 18+ / 所有现代浏览器都有；缺失则退化为引用共享。 */
const canClone = typeof structuredClone === 'function'

function tableOf(name: TableName): MemoryTableService<Record<string, unknown>> {
  let t = tables.get(name)
  if (!t) {
    t = new MemoryTableService<Record<string, unknown>>(name, canClone)
    tables.set(name, t)
  }
  return t
}

export const memoryStorage: StorageService = {
  driver: 'memory',

  table<K extends TableName>(name: K): TableService<StorageSchema[K]> {
    return tableOf(name) as unknown as TableService<StorageSchema[K]>
  },

  open(): Promise<void> {
    return Promise.resolve()
  },

  async clearAll(): Promise<void> {
    for (const t of tables.values()) await t.clear()
  },

  /**
   * 内存驱动的 CAS：走 atomicSync 同步读改写，与 Dexie rw 事务串行化语义一致
   * （双驱动对照测试会断言两个并发 +1 收敛到 2）。
   */
  updateAtomic<K extends TableName>(
    name: K,
    key: PrimaryKey<K>,
    reducer: (current: StorageSchema[K] | undefined) => AtomicUpdate<StorageSchema[K]>,
  ): Promise<AtomicResult<StorageSchema[K]>> {
    const t = tableOf(name)
    return Promise.resolve(
      t.atomicSync<AtomicResult<StorageSchema[K]>>(key as string | number, (raw) => {
        const current = raw as unknown as StorageSchema[K] | undefined
        const decision = reducer(current)
        if (decision.kind === 'abort') throw new AtomicAbortError(decision.reason)
        if (decision.kind === 'skip') {
          return { result: { committed: false, value: decision.value ?? current } }
        }
        return {
          value: decision.value as unknown as Record<string, unknown>,
          result: { committed: true, value: decision.value },
        }
      }),
    )
  },

  insertIfAbsent<K extends TableName>(name: K, value: StorageSchema[K]): Promise<boolean> {
    const t = tableOf(name)
    const key = (value as unknown as Record<string, unknown>)[PRIMARY_KEY[name]]
    if (key === undefined || key === null) {
      throw new Error(`[storage] 表 ${name} 缺少主键，无法 insertIfAbsent`)
    }
    return Promise.resolve(
      t.atomicSync<boolean>(key as string | number, (current) =>
        current !== undefined
          ? { result: false }
          : { value: value as unknown as Record<string, unknown>, result: true },
      ),
    )
  },

  /**
   * 内存驱动的跨表批事务：排队串行 + 全表快照回滚。
   * commit:false 或抛错时把所有参与表恢复到事务开始前，等价于 IDB 事务回滚。
   */
  atomicBatch<K extends TableName, R>(
    names: readonly K[],
    scope: (ctx: BatchTables<K>) => Promise<BatchDecision<R>>,
  ): Promise<BatchResult<R>> {
    const run = async (): Promise<BatchResult<R>> => {
      const snaps = names.map((n) => tableOf(n).snapshot())
      const rollback = () => names.forEach((n, i) => tableOf(n).restore(snaps[i]))
      const ctx = {} as BatchTables<K>
      for (const name of names) {
        const t = tableOf(name)
        ;(ctx as Record<string, unknown>)[name] = {
          get: (key: string | number) => t.get(key),
          put: (value: StorageSchema[K]) =>
            t.put(value as unknown as Record<string, unknown>),
          addIfAbsent: (value: StorageSchema[K]) => memoryStorage.insertIfAbsent(name, value),
        }
      }
      try {
        const decision = await scope(ctx)
        if (!decision.commit) {
          rollback()
          return { committed: false, result: decision.result }
        }
        return { committed: true, result: decision.result }
      } catch (err) {
        rollback()
        throw err
      }
    }
    const result = batchQueue.then(run, run)
    batchQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  },

  subscribeLifecycle(_listener: (event: StorageLifecycleEvent) => void): () => void {
    // 内存实现没有真实 IDB 连接，也就没有 blocked / versionchange；返回可调用的空订阅
    return () => {}
  },
}
