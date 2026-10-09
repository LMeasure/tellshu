/**
 * 存储服务 · Web 实现（Dexie / IndexedDB）
 * ------------------------------------------------------------------
 * ⚠️ 全项目**唯一**允许 `import Dexie` 的文件。
 * 版本迁移规则：
 *   - 只允许 **新增** version(n).stores({...})，不改历史版本；
 *   - 每次新增表/索引都要补一个 version，存量库才能平滑升级；
 *   - 删表/改主键属于破坏性变更，需要单独设计迁移方案，不要直接改老版本。
 *
 * 索引现状（字段名必须与 whereIndex 调用方一致）：
 *   vocab        word_id, word, layer, next_review, added_at, owner
 *   reviewLog    ++id, word_id, at, uid, owner
 *   readings     id, created_at, type, on_shelf
 *   readingTime  date, owner
 *   diagnose     ++id, at
 *   recitations  id, created_at, doc_id
 *   dictEntries  key, word_lower, pos, updated_at
 *   dictToc      id, book, page_start
 *   dictGrammar  key, base_lower, type
 *   dictMeta     key
 *   annotations  id, doc_id, created_at
 *   ----- 以下为 v8 新增（账号 / 多端同步）-----
 *   collections  id, owner, updated_at
 *   settings     owner
 *   session      user_id
 *   sync_queue   id, entity, entity_id, created_at, attempts
 *   sync_meta    key
 */

import Dexie, { type Table } from 'dexie'
import type { StorageSchema, TableName } from '@/domain/types'
import type { StorageService, TableService } from './types'

/** 生成稳定 UUID（reviewLog 跨端同步标识用）。优先 crypto.randomUUID，降级到 Math.random。 */
function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 各表已建索引字段集合，用于 whereIndex 的前置校验 */
const INDEXED_FIELDS: Record<TableName, readonly string[]> = {
  vocab: ['word_id', 'word', 'layer', 'next_review', 'added_at', 'owner'],
  reviewLog: ['id', 'word_id', 'at', 'uid', 'owner'],
  readings: ['id', 'created_at', 'type', 'on_shelf'],
  readingTime: ['date', 'owner'],
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

const TABLE_NAMES = Object.keys(INDEXED_FIELDS) as TableName[]

class ShushuDB extends Dexie {
  vocab!: Table<StorageSchema['vocab'], string>
  reviewLog!: Table<StorageSchema['reviewLog'], number>
  readings!: Table<StorageSchema['readings'], string>
  readingTime!: Table<StorageSchema['readingTime'], string>
  diagnose!: Table<StorageSchema['diagnose'], number>
  recitations!: Table<StorageSchema['recitations'], string>
  dictEntries!: Table<StorageSchema['dictEntries'], string>
  dictToc!: Table<StorageSchema['dictToc'], string>
  dictGrammar!: Table<StorageSchema['dictGrammar'], string>
  dictMeta!: Table<StorageSchema['dictMeta'], string>
  annotations!: Table<StorageSchema['annotations'], string>
  collections!: Table<StorageSchema['collections'], string>
  settings!: Table<StorageSchema['settings'], string>
  session!: Table<StorageSchema['session'], string>
  sync_queue!: Table<StorageSchema['sync_queue'], string>
  sync_meta!: Table<StorageSchema['sync_meta'], string>

  constructor() {
    super('shushu-learn')
    this.version(1).stores({
      vocab: 'word_id, word, layer, next_review, added_at',
      reviewLog: '++id, word_id, at',
    })
    // v2：新增导入阅读相关表（全新或存量库均可平滑升级）
    this.version(2).stores({
      readings: 'id, created_at, type',
      readingTime: 'date',
    })
    // v3：readings 增加 on_shelf 索引（书架）；其余表沿用
    this.version(3).stores({
      readings: 'id, created_at, type, on_shelf',
    })
    // v4：诊断结果表（定级 + 建议起始词本），存量库平滑升级
    this.version(4).stores({
      diagnose: '++id, at',
    })
    // v5：背诵录音表（真实音频 Blob + 自动命名）
    this.version(5).stores({
      recitations: 'id, created_at, doc_id',
    })
    // v6：词典扫描库本地缓存（词条 / 目录 / 语法规则 / 同步游标）
    this.version(6).stores({
      dictEntries: 'key, word_lower, pos, updated_at',
      dictToc: 'id, book, page_start',
      dictGrammar: 'key, base_lower, type',
      dictMeta: 'key',
    })
    // v7：阅读批注（划线 + 想法），按素材聚合查询
    this.version(7).stores({
      annotations: 'id, doc_id, created_at',
    })
    // v8：账号 + 多端同步（非破坏性迁移）
    //   · 现有表 vocab / reviewLog / readingTime 增量加 owner（多端隔离）与同步字段；
    //     reviewLog 额外加 uid(UUID) 作为跨端同步标识，原 ++id 自增主键不动。
    //   · 新增 collections / settings / session / sync_queue / sync_meta 五张表。
    //   · 升级时给存量行补 owner='guest'、updated_at、deleted_at（软删墓碑），
    //     reviewLog 补 uid；dict* / readings / recitations / annotations 一律不碰。
    this.version(8)
      .stores({
        vocab: 'word_id, word, layer, next_review, added_at, owner',
        reviewLog: '++id, word_id, at, uid, owner',
        readingTime: 'date, owner',
        collections: 'id, owner, updated_at',
        settings: 'owner',
        session: 'user_id',
        sync_queue: 'id, entity, entity_id, created_at, attempts',
        sync_meta: 'key',
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        const vocab = tx.table('vocab') as any
        await vocab.toCollection().modify((row: any) => {
          row.owner = row.owner ?? 'guest'
          row.updated_at = row.updated_at ?? now
          row.deleted_at = row.deleted_at ?? null
        })
        const reviewLog = tx.table('reviewLog') as any
        await reviewLog.toCollection().modify((row: any) => {
          row.uid = row.uid ?? uuid()
          row.owner = row.owner ?? 'guest'
          row.updated_at = row.updated_at ?? now
          row.deleted_at = row.deleted_at ?? null
        })
        const readingTime = tx.table('readingTime') as any
        await readingTime.toCollection().modify((row: any) => {
          row.owner = row.owner ?? 'guest'
          row.updated_at = row.updated_at ?? now
        })
      })
  }
}

/**
 * Dexie 的 Table 类型参数与我们的泛型无法直接对齐（主键类型不一致），
 * 这里在实现内部做一次受控的 any 收敛，对外仍是强类型。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
class DexieTableService<T> implements TableService<T> {
  constructor(
    private readonly table: Table<any, any>,
    private readonly name: TableName,
  ) {}

  get(key: string | number): Promise<T | undefined> {
    return this.table.get(key as any) as Promise<T | undefined>
  }

  async put(value: T): Promise<void> {
    await this.table.put(value as any)
  }

  add(value: T): Promise<number> {
    return this.table.add(value as any) as Promise<number>
  }

  async delete(key: string | number): Promise<void> {
    await this.table.delete(key as any)
  }

  toArray(): Promise<T[]> {
    return this.table.toArray() as Promise<T[]>
  }

  bulkGet(keys: (string | number)[]): Promise<(T | undefined)[]> {
    return this.table.bulkGet(keys as any[]) as Promise<(T | undefined)[]>
  }

  async bulkPut(values: T[]): Promise<void> {
    if (values.length === 0) return
    await this.table.bulkPut(values as any[])
  }

  count(): Promise<number> {
    return this.table.count()
  }

  async whereIndex(field: string, value: string | number): Promise<T[]> {
    const indexed = INDEXED_FIELDS[this.name]
    if (!indexed.includes(field)) {
      // 宁可显式报错，也不要在业务路径里埋全表扫描
      throw new Error(
        `[storage] 表 ${this.name} 的字段 ${field} 未建索引，无法等值查询（已索引：${indexed.join(', ')}）`,
      )
    }
    return this.table.where(field).equals(value).toArray() as Promise<T[]>
  }

  async whereStartsWith(field: string, value: string): Promise<T[]> {
    const indexed = INDEXED_FIELDS[this.name]
    if (!indexed.includes(field)) {
      throw new Error(
        `[storage] 表 ${this.name} 的字段 ${field} 未建索引，无法前缀查询（已索引：${indexed.join(', ')}）`,
      )
    }
    return this.table.where(field).startsWith(value).toArray() as Promise<T[]>
  }

  async clear(): Promise<void> {
    await this.table.clear()
  }
}

const db = new ShushuDB()

export const dexieStorage: StorageService = {
  driver: 'dexie',

  table<K extends TableName>(name: K): TableService<StorageSchema[K]> {
    return new DexieTableService<StorageSchema[K]>(db[name], name) as TableService<
      StorageSchema[K]
    >
  },

  async open(): Promise<void> {
    if (!db.isOpen()) await db.open()
  },

  async clearAll(): Promise<void> {
    await Promise.all(TABLE_NAMES.map((n) => db[n].clear()))
  },
}
/* eslint-enable @typescript-eslint/no-explicit-any */
