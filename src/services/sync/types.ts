import type { SyncableEntity } from '@/domain/types'

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'synced'

/**
 * 远端同步客户端抽象。当前由本地桩实现（无云端）；
 * Supabase 接入后提供另一实现，SyncEngine 无需改动。
 */
export interface RemoteSyncClient {
  /** 幂等 upsert 一条记录（云端以 id / uid / word_id 去重） */
  upsert(entity: SyncableEntity, payload: Record<string, unknown>): Promise<void>
  /** 拉取自 since（epoch ms，含）以来的变更记录 */
  fetchSince(entity: SyncableEntity, since: number): Promise<Record<string, unknown>[]>
}

/**
 * 一次同步的结果摘要（UI 的 SyncNotice 用）。
 * - pushed：本次成功推送到远端的本地变更数。
 * - pulled：本次从远端拉回并 LWW 合并到本地的记录数（>0 即代表发生了跨设备合并）。
 */
export interface SyncResult {
  pushed: number
  pulled: number
  at: number
}
