import { syncEngine, SyncEngine } from './engine'
import type { SyncableEntity } from '@/domain/types'

export { syncEngine, SyncEngine }
export * from './types'

/** 便捷封装：domain/learning 等写完后直接调用，把变更送入 Outbox。 */
export function enqueueSync(
  entity: SyncableEntity,
  entityId: string,
  op: 'upsert' | 'delete',
  payload: Record<string, unknown>,
): Promise<void> {
  return syncEngine.enqueue(entity, entityId, op, payload)
}
