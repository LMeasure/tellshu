import { storage } from '../storage'
import type { TableService } from '../storage/types'
import { uuid } from '@/lib/uuid'
import { mergeEntity, type SyncableRecord } from '@/domain/sync'
import type { SyncableEntity } from '@/domain/types'
import type { RemoteSyncClient, SyncStatus, SyncResult } from './types'
import { LocalSyncStub } from './remote'

const MAX_ATTEMPTS = 5

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, unknown> & SyncableRecord

/**
 * 同步引擎（Outbox 模式）
 * ------------------------------------------------------------------
 * - enqueue：本地写完后把变更写入 sync_queue（不阻塞调用方），随后触发一次 push。
 * - push：将队列中的变更幂等 upsert 到远端（云端接入后此处换成 Supabase 实现）。
 * - pull：从远端增量拉取，按 LWW（updated_at 大者胜）合并到本地。
 * 当前 RemoteSyncClient 为本地桩，仅用于端到端打通链路；真实远端接入时替换 client 即可。
 */
export class SyncEngine {
  private client: RemoteSyncClient
  private status: SyncStatus = 'idle'
  private lastSyncAt = 0
  private listeners = new Set<(s: SyncStatus) => void>()
  private resultListeners = new Set<(r: SyncResult) => void>()

  constructor(client: RemoteSyncClient = new LocalSyncStub()) {
    this.client = client
  }

  /** 订阅同步状态变化（UI 的 SyncIndicator 用）。返回取消订阅函数。 */
  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 订阅同步结果摘要（UI 的 SyncNotice 用，含 pushed / pulled 计数）。返回取消订阅函数。 */
  onResult(fn: (r: SyncResult) => void): () => void {
    this.resultListeners.add(fn)
    return () => this.resultListeners.delete(fn)
  }

  private emitResult(r: SyncResult) {
    this.resultListeners.forEach((fn) => fn(r))
  }

  private setStatus(s: SyncStatus) {
    this.status = s
    this.listeners.forEach((fn) => fn(s))
  }

  getStatus(): SyncStatus {
    return this.status
  }

  getLastSyncAt(): number {
    return this.lastSyncAt
  }

  /** 把一次本地变更写入 Outbox 队列（异步、不阻塞调用方）。 */
  async enqueue(
    entity: SyncableEntity,
    entityId: string,
    op: 'upsert' | 'delete',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await storage.table('sync_queue').put({
        id: uuid(),
        entity,
        entity_id: entityId,
        op,
        payload,
        created_at: Date.now(),
        attempts: 0,
        last_error: null,
      })
      // 入队后即尝试推送（本地桩即时完成；云端接入后改为防抖 / 网络可用时触发）
      void this.push()
    } catch (err) {
      console.error('[sync] enqueue 失败', err)
    }
  }

  /** 将 Outbox 队列中的变更幂等推送到远端。 */
  async push(): Promise<void> {
    this.setStatus('syncing')
    let pushed = 0
    try {
      const queue = storage.table('sync_queue')
      const pending = (await queue.toArray())
        .filter((r: any) => r.attempts < MAX_ATTEMPTS)
        .sort((a: any, b: any) => a.created_at - b.created_at)
      for (const item of pending) {
        try {
          await this.client.upsert(item.entity, item.payload)
          await queue.delete(item.id)
          pushed++
        } catch (err) {
          await queue.put({
            ...item,
            attempts: item.attempts + 1,
            last_error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const remaining = await queue.count()
      if (remaining === 0) {
        this.lastSyncAt = Date.now()
        this.setStatus('synced')
        await this.saveMeta()
      } else {
        this.setStatus('error')
      }
    } catch (err) {
      console.error('[sync] push 失败', err)
      this.setStatus('error')
    } finally {
      this.emitResult({ pushed, pulled: 0, at: Date.now() })
    }
  }

  /** 从远端增量拉取并 LWW 合并到本地。 */
  async pull(since = this.lastSyncAt): Promise<void> {
    this.setStatus('syncing')
    let pulled = 0
    try {
      const entities: SyncableEntity[] = ['vocab', 'reviewLog', 'collections', 'settings']
      for (const entity of entities) {
        const remoteRows = await this.client.fetchSince(entity, since)
        const table = storage.table(entity) as unknown as TableService<Row>
        for (const remote of remoteRows) {
          const r = remote as Row
          const id = (r['id'] ?? r['uid'] ?? r['word_id'] ?? r['owner']) as string | undefined
          if (id == null) continue
          const local = (await table.get(id)) as Row | undefined
          const merged = mergeEntity(local, r)
          await table.put(merged as any)
          pulled++
        }
      }
      this.lastSyncAt = Date.now()
      this.setStatus('synced')
      await this.saveMeta()
    } catch (err) {
      console.error('[sync] pull 失败', err)
      this.setStatus('error')
    } finally {
      this.emitResult({ pushed: 0, pulled, at: Date.now() })
    }
  }

  /** 一键同步：先把 Outbox 推上去，再从远端拉回增量并 LWW 合并。 */
  async sync(since?: number): Promise<void> {
    await this.push()
    await this.pull(since ?? this.lastSyncAt)
  }

  private async saveMeta(): Promise<void> {
    const meta = storage.table('sync_meta')
    await meta.put({ key: 'last_sync_at', value: this.lastSyncAt })
    await meta.put({ key: 'sync_status', value: this.status })
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 默认单例（本地桩）。Supabase 接入后在此替换 client。 */
export const syncEngine = new SyncEngine()
