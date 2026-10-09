import type { SyncableEntity } from '@/domain/types'
import type { RemoteSyncClient } from './types'

/** 从记录里取稳定主键（用于本地桩去重） */
function entityKey(payload: Record<string, unknown>): string {
  const id =
    payload['id'] ?? payload['uid'] ?? payload['word_id'] ?? payload['owner'] ?? null
  if (id == null) return JSON.stringify(payload)
  return String(id)
}

/**
 * 本地桩实现：用一个内存 Map 模拟云端，使 enqueue→push→pull 能端到端跑通。
 * 注意：仅本地桩，进程重启即清空；Supabase 接入后由真实实现替换。
 */
export class LocalSyncStub implements RemoteSyncClient {
  private store = new Map<string, Record<string, unknown>>()

  async upsert(entity: SyncableEntity, payload: Record<string, unknown>): Promise<void> {
    this.store.set(`${entity}:${entityKey(payload)}`, { ...payload })
  }

  async fetchSince(entity: SyncableEntity, since: number): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    const prefix = `${entity}:`
    for (const [key, val] of this.store) {
      if (!key.startsWith(prefix)) continue
      const updated = (val['updated_at'] as number | undefined) ?? 0
      if (updated >= since) out.push(val)
    }
    return out
  }
}
