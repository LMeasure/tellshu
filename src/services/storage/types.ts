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

export interface StorageService {
  /** 当前实现标识，用于排查与单测断言 */
  readonly driver: 'dexie' | 'memory'
  table<K extends TableName>(name: K): TableService<StorageSchema[K]>
  /** 打开/升级底层库（幂等）。页面启动时调用一次即可。 */
  open(): Promise<void>
  /** 清空全部本地学习数据（设置页「清除数据」用）。 */
  clearAll(): Promise<void>
}

/** 便捷别名：`storage.table('vocab')` 的返回类型 */
export type VocabTable = TableService<StorageSchema['vocab']>
export type PrimaryKeyOf<K extends TableName> = PrimaryKey<K>
