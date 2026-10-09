/**
 * 同步合并纯逻辑（平台无关、可单测）
 * ------------------------------------------------------------------
 * 冲突裁决 = LWW（Last Write Wins，按 updated_at 大者胜）。
 * 删除用「打 deleted_at 的更新」表示，因此天然参与 LWW：
 *   若删除时间晚于某次编辑，删除胜出；早于则编辑胜出。
 */

/** 可同步记录必须携带的时间字段 */
export interface SyncableRecord {
  updated_at?: number | null
  deleted_at?: number | null
}

/**
 * 合并一条本地记录与一条远端记录，返回应落库的记录。
 * - 远端是删除（deleted_at 有值）且（本地为空 或 本地 updated_at < 远端 deleted_at）→ 删除胜出（覆盖为带墓碑的记录）
 * - 本地为空 → 采用远端
 * - 远端 updated_at 更大 → 采用远端
 * - 否则保留本地
 */
export function mergeEntity<T extends SyncableRecord>(local: T | undefined, remote: T): T {
  const remoteDeleted = remote.deleted_at != null
  if (remoteDeleted) {
    const delAt = remote.deleted_at as number
    const localUpdated = local?.updated_at ?? 0
    // 删除晚于本地最后修改 → 删除胜出
    if (local == null || localUpdated < delAt) {
      return { ...remote, deleted_at: delAt }
    }
    // 本地有更晚的编辑 → 编辑胜出，保留本地（不应用远端删除）
    return local
  }
  if (local == null) return remote
  const localUpdated = local.updated_at ?? 0
  const remoteUpdated = remote.updated_at ?? 0
  return remoteUpdated > localUpdated ? remote : local
}

/** 取两条记录中 updated_at 较大者；都为空时优先远端。 */
export function pickLatest<T extends SyncableRecord>(a: T, b: T): T {
  const ta = a.updated_at ?? 0
  const tb = b.updated_at ?? 0
  return tb > ta ? b : a
}
