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
 *   ----- 以下为 v9 新增（Phase 2 M1：ASR 字幕 + 学习稿）-----
 *   transcripts  id, created_at, source
 *   studyNotes   id, transcript_id, status, created_at, updated_at, source
 *   ----- 以下为 v10 新增（单词默写：单文档会话，队列内嵌）-----
 *   spellingSessions  id, status, started_at, owner
 *   ----- 以下为 v11 新增（单词学习进度：单文档会话，队列内嵌）-----
 *   wordLearningSessions  id, book, level, updated_at, owner
 *   ----- 以下为 v12 新增（书籍资产：5 表补 owner 索引，无 schema 破坏性变更）-----
 *   readings    id, created_at, type, on_shelf, owner
 *   recitations id, created_at, doc_id, owner
 *   transcripts id, created_at, source, owner
 *   studyNotes  id, transcript_id, status, created_at, updated_at, source, owner
 *   annotations id, doc_id, created_at, owner
 *   ----- 以下为 v13（书籍资产：owner 默认 'guest' + blocked/versionchange；schema 同 v12）-----
 *   ----- 以下为 v14 新增（单词默写 V2：错词事件表）-----
 *   spellingErrorEvents  &event_id, owner, word_id, session_id, kind, occurred_at, status
 *     ⚠️ queue 是会话文档里的对象数组，IndexedDB 不索引对象数组的内嵌属性，
 *        所以**不给 position / word_status / word_id 建索引**（建了也不会生效，
 *        反而误导后来人以为可以按词条查）。按词条查一律读整份会话文档。
 */

import Dexie, { type Table } from 'dexie'
import type { PrimaryKey, StorageSchema, TableName } from '@/domain/types'
import {
  AtomicAbortError,
  AtomicRollbackError,
  type AtomicResult,
  type AtomicUpdate,
  type BatchDecision,
  type BatchResult,
  type BatchTables,
  type StorageLifecycleEvent,
  type StorageService,
  type TableService,
} from './types'

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
  readings: ['id', 'created_at', 'type', 'on_shelf', 'owner'],
  readingTime: ['date', 'owner'],
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
  // v10：单词默写会话（queue 内嵌，无内嵌字段索引）
  spellingSessions: ['id', 'status', 'started_at', 'owner'],
  // v11：单词学习进度（队列/已完成是内嵌数组，同样不建索引）
  wordLearningSessions: ['id', 'book', 'level', 'updated_at', 'owner'],
  // v14：单词默写 V2 错词事件（主键 event_id，纯新增表；kind/status 为实施草案）
  spellingErrorEvents: ['event_id', 'owner', 'word_id', 'session_id', 'kind', 'occurred_at', 'status'],
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
  transcripts!: Table<StorageSchema['transcripts'], string>
  studyNotes!: Table<StorageSchema['studyNotes'], string>
  spellingSessions!: Table<StorageSchema['spellingSessions'], string>
  wordLearningSessions!: Table<StorageSchema['wordLearningSessions'], string>
  spellingErrorEvents!: Table<StorageSchema['spellingErrorEvents'], string>

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
    // v9：ASR 字幕 + 学习稿持久化（Phase 2 M1，2026-10-18 拍板）
    //   · transcripts：id 与 ASR job_id 对齐，重复 done 幂等覆盖
    //   · studyNotes：transcript_id 建索引，按它 upsert 不追加（评审冻结）
    //   · 两张新表，纯新增无 upgrade；不进 sync_queue（同步链只服务词典数据）
    this.version(9).stores({
      transcripts: 'id, created_at, source',
      studyNotes: 'id, transcript_id, status, created_at, updated_at, source',
    })
    // v10：单词默写会话（2026-10-21 拍板，方案 V3.2 §5.1）
    //   · 单文档：queue 内嵌在会话行里 —— TableService 没有事务 API，
    //     只有一次 put() 换整份文档才能保证「计数 + 状态 + 队列推进」原子
    //   · 纯新增表，无 upgrade；存量库打开时自动建空表，老数据一行不动
    //   · 不建 queue 内嵌字段索引（IndexedDB 不支持，建了也不生效）
    this.version(10).stores({
      spellingSessions: 'id, status, started_at, owner',
    })
    // v11：单词学习进度（2026-10-31 拍板，修复「退出后从头再来」）
    //   · 单文档：`${book}::${level ?? 'all'}` 一份，整份 put 覆盖；
    //     队列顺序 + 位置 + 已完成集合同生共死，不会出现三者不同步
    //   · 纯新增表，无 upgrade；存量库打开时自动建空表，老数据一行不动
    //   · queue / completed 是内嵌数组，不建索引（IndexedDB 不支持）
    this.version(11).stores({
      wordLearningSessions: 'id, book, level, updated_at, owner',
    })
    // v12：统一书籍资产架构 —— 对 5 张存量表补 owner 索引（多端/多用户隔离）
    //   · readings / recitations / transcripts / studyNotes / annotations 此前无 owner；
    //     v12 仅在索引层加 owner，**不改主键、不删字段、不碰其他表**；
    //   · 升级回调为这 5 张表的存量行补 owner='guest'（与 v8 对 vocab/reviewLog/readingTime 的处理一致）；
    //     新写入行的 owner 由各自写路径按「默认 'guest'」约定携带，本版本只管索引与回填。
    this.version(12)
      .stores({
        readings: 'id, created_at, type, on_shelf, owner',
        recitations: 'id, created_at, doc_id, owner',
        transcripts: 'id, created_at, source, owner',
        studyNotes: 'id, transcript_id, status, created_at, updated_at, source, owner',
        annotations: 'id, doc_id, created_at, owner',
      })
      .upgrade(async (tx) => {
        for (const name of ['readings', 'recitations', 'transcripts', 'studyNotes', 'annotations']) {
          const t = tx.table(name) as any
          await t.toCollection().modify((row: any) => {
            row.owner = row.owner ?? 'guest'
          })
        }
      })
    // v13：统一书籍资产架构 —— owner 可空、默认 'guest'（约定层，非 schema 变更）
    //   · 本版本 schema 与 v12 完全一致（仅重申 5 表 owner 索引），不新增/不删表；
    //   · 真正落地的是 db.on('blocked') / db.on('versionchange') 事件处理（见构造函数后的注册），
    //     使升级被其他标签页阻塞时可提示、被其他连接升级时可主动让出，避免升级死锁。
    this.version(13).stores({
      readings: 'id, created_at, type, on_shelf, owner',
      recitations: 'id, created_at, doc_id, owner',
      transcripts: 'id, created_at, source, owner',
      studyNotes: 'id, transcript_id, status, created_at, updated_at, source, owner',
      annotations: 'id, doc_id, created_at, owner',
    })
    // v14：单词默写 V2 —— 纯新增 spellingErrorEvents 表，无 upgrade，存量零触碰
    //   · 主键 event_id（& 前缀 = 主键且唯一）；索引覆盖 owner/word_id/session_id/kind/occurred_at/status
    //   · 该表的写入逻辑（T-A 插入 / 幂等 event_id / drain 重放）属单词默写 V2 领域层，不在本版本；
    //     本版本只建表与索引，保持与 v12/v13 分版本、不合并（见《Dexie版本协调-G9-D9-结论.md》§二）。
    //   · kind / status 枚举为实施草案，最终取值待架构负责人确认（授权清单 Q2 待合并复核）。
    this.version(14).stores({
      spellingErrorEvents: '&event_id, owner, word_id, session_id, kind, occurred_at, status',
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

/* ------------------------------------------------------------------
 * v13 生命周期：升级被其它标签阻塞 / 被其它连接抢占 / 重新就绪
 * ------------------------------------------------------------------
 * 只做广播与让出连接，不含任何业务规则；订阅方（跨标签锁）据此丢弃
 * 内存态并进入「重新 open ≠ 已持锁」的 U16 恢复链。
 */
const lifecycleListeners = new Set<(event: StorageLifecycleEvent) => void>()

function emitLifecycle(event: StorageLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event)
    } catch {
      // 订阅方异常不得影响存储层本身
    }
  }
}

// v13 行为：升级被其他标签页占用时给出明确提示；被其他连接的新版本升级请求抢占时主动让出，
// 避免「打开的库版本过旧 → 对方升级被 blocked → 本端又持有连接」的死锁。
db.on('blocked', () => {
  emitLifecycle({ type: 'blocked' })
  console.warn('[storage] 数据库升级被其他标签页阻塞：请关闭其他标签页后重试')
})
db.on('versionchange', () => {
  emitLifecycle({ type: 'versionchange' })
  db.close()
})

/** 判断是否为 IndexedDB / Dexie 的主键冲突（insertIfAbsent 的幂等依据） */
function isConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  if (name === 'ConstraintError' || name === 'Dexie.ConstraintError') return true
  const inner = (err as { inner?: { name?: string } }).inner
  return inner?.name === 'ConstraintError'
}

export const dexieStorage: StorageService = {
  driver: 'dexie',

  table<K extends TableName>(name: K): TableService<StorageSchema[K]> {
    return new DexieTableService<StorageSchema[K]>(db[name], name) as TableService<
      StorageSchema[K]
    >
  },

  async open(): Promise<void> {
    if (!db.isOpen()) {
      await db.open()
      emitLifecycle({ type: 'ready' })
    }
  },

  /**
   * 一次 rw 事务清空全部表。
   * 任一表 clear 失败则整笔回滚，避免逐表 Promise.all 部分成功后留下残行。
   */
  async clearAll(): Promise<void> {
    const stores = TABLE_NAMES.map((n) => db[n])
    await db.transaction('rw', stores, async (tx) => {
      for (const name of TABLE_NAMES) {
        await tx.table(name).clear()
      }
    })
  },

  /**
   * 单表原子 CAS：把「读 → reducer 判定 → 写」放进同一个 Dexie rw 事务。
   * 事务内刻意仍走 DexieTableService 的 get/put，保持与既有业务写路径
   * 相同的注入面（scripts/test_spelling_srs_handoff.ts 的原型注入仍有效）。
   */
  async updateAtomic<K extends TableName>(
    name: K,
    key: PrimaryKey<K>,
    reducer: (current: StorageSchema[K] | undefined) => AtomicUpdate<StorageSchema[K]>,
  ): Promise<AtomicResult<StorageSchema[K]>> {
    if (!db.isOpen()) await db.open()
    const table = db[name] as Table<any, any>
    return db.transaction('rw', table, async () => {
      const svc = new DexieTableService<StorageSchema[K]>(table, name)
      const current = (await svc.get(key)) as StorageSchema[K] | undefined
      const decision = reducer(current)
      if (decision.kind === 'abort') throw new AtomicAbortError(decision.reason)
      if (decision.kind === 'skip') {
        return { committed: false, value: decision.value ?? current }
      }
      await svc.put(decision.value)
      return { committed: true, value: decision.value }
    }) as Promise<AtomicResult<StorageSchema[K]>>
  },

  /** 事件表 T-A：主键冲突即 false，不覆盖已有行 */
  async insertIfAbsent<K extends TableName>(name: K, value: StorageSchema[K]): Promise<boolean> {
    if (!db.isOpen()) await db.open()
    const table = db[name] as Table<any, any>
    const svc = new DexieTableService<StorageSchema[K]>(table, name)
    try {
      await svc.add(value)
      return true
    } catch (err) {
      if (isConstraintError(err)) return false
      throw err
    }
  },

  /**
   * 跨表原子批：所有表纳入同一个 Dexie rw 事务。
   * 与 updateAtomic 的关键区别：scope 重叠的 rw 事务在 IndexedDB 层串行，
   * 因此「会话锁校验 → 事件行写入 → 会话凭证写回」之间不可能插入另一标签
   * 的 takeover，U11/U1 窗口由此关闭。
   *
   * 事务内仍走 DexieTableService，保持与既有写路径相同的原型注入面。
   */
  async atomicBatch<K extends TableName, R>(
    names: readonly K[],
    scope: (ctx: BatchTables<K>) => Promise<BatchDecision<R>>,
  ): Promise<BatchResult<R>> {
    if (!db.isOpen()) await db.open()
    const dexieTables = names.map((n) => db[n] as Table<any, any>)
    try {
      return await db.transaction('rw', dexieTables, async () => {
        const ctx = {} as BatchTables<K>
        for (const name of names) {
          const t = db[name] as Table<any, any>
          const svc = new DexieTableService<StorageSchema[K]>(t, name)
          const primKey = (t.schema.primKey.keyPath ?? '') as string
          ;(ctx as Record<string, unknown>)[name] = {
            get: (key: string | number) => svc.get(key),
            put: (value: StorageSchema[K]) => svc.put(value),
            addIfAbsent: async (value: StorageSchema[K]) => {
              // 同事务内无其它写者，主键存在性检查是可靠的；
              // 仍保留 ConstraintError 兜底，避免依赖单一实现细节。
              const key = primKey
                ? (value as unknown as Record<string, unknown>)?.[primKey]
                : undefined
              if (key !== undefined && key !== null) {
                const existing = await svc.get(key as string | number)
                if (existing !== undefined) return false
              }
              try {
                await svc.add(value)
                return true
              } catch (err) {
                if (isConstraintError(err)) return false
                throw err
              }
            },
          }
        }
        const decision = await scope(ctx)
        // 抛错让 Dexie 回滚整个事务（含此前所有 put/add）
        if (!decision.commit) throw new AtomicRollbackError(decision.result)
        return { committed: true, result: decision.result }
      })
    } catch (err) {
      if (err instanceof AtomicRollbackError) {
        return { committed: false, result: err.result as R }
      }
      throw err
    }
  },

  subscribeLifecycle(listener: (event: StorageLifecycleEvent) => void): () => void {
    lifecycleListeners.add(listener)
    return () => {
      lifecycleListeners.delete(listener)
    }
  },
}
/* eslint-enable @typescript-eslint/no-explicit-any */
