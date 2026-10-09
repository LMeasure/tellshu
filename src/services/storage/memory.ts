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

import type { StorageSchema, TableName } from '@/domain/types'
import type { StorageService, TableService } from './types'

const INDEXED_FIELDS: Record<TableName, readonly string[]> = {
  vocab: ['word_id', 'word', 'layer', 'next_review', 'added_at'],
  reviewLog: ['id', 'word_id', 'at'],
  readings: ['id', 'created_at', 'type', 'on_shelf'],
  readingTime: ['date'],
  diagnose: ['id', 'at'],
  recitations: ['id', 'created_at', 'doc_id'],
  dictEntries: ['key', 'word_lower', 'pos', 'updated_at'],
  dictToc: ['id', 'book', 'page_start'],
  dictGrammar: ['key', 'base_lower', 'type'],
  dictMeta: ['key'],
  annotations: ['id', 'doc_id', 'created_at'],
  collections: ['id', 'owner', 'updated_at'],
  settings: ['owner'],
  session: ['user_id'],
  sync_queue: ['id', 'entity', 'entity_id', 'created_at', 'attempts'],
  sync_meta: ['key'],
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
}

const tables = new Map<TableName, MemoryTableService<Record<string, unknown>>>()

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
}
