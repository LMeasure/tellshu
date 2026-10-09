import { useEffect, useState } from 'react'
import { syncEngine } from '@/services/sync'
import type { SyncStatus } from '@/services/sync/types'

/**
 * 订阅 SyncEngine 的同步状态（UI 的 SyncIndicator 用）。
 * 返回当前状态、上次成功同步时间，以及一个手动「立即同步」入口。
 */
export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus>(syncEngine.getStatus())
  const [lastSyncAt, setLastSyncAt] = useState<number>(syncEngine.getLastSyncAt())

  useEffect(() => {
    const off = syncEngine.onStatus((s) => {
      setStatus(s)
      setLastSyncAt(syncEngine.getLastSyncAt())
    })
    return off
  }, [])

  return {
    status,
    lastSyncAt,
    /** 一键同步：推 Outbox + 拉增量合并（幂等，可重复点） */
    syncNow: () => void syncEngine.sync(),
  }
}
