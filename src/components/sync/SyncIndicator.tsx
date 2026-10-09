import { AlertTriangle, CheckCircle2, Cloud, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSyncStatus } from '@/hooks/useSyncStatus'
import type { SyncStatus } from '@/services/sync/types'

/** 把 epoch ms 转成「刚刚 / N 分钟前 / N 小时前」 */
function fmtAgo(at: number): string {
  if (!at) return ''
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

const META: Record<SyncStatus, { icon: typeof Cloud; label: string; cls: string }> = {
  idle: { icon: Cloud, label: '本地数据', cls: 'bg-muted/80 text-muted-foreground' },
  syncing: { icon: Loader2, label: '同步中…', cls: 'bg-primary/10 text-primary' },
  synced: { icon: CheckCircle2, label: '已同步', cls: 'bg-accent/15 text-accent' },
  error: { icon: AlertTriangle, label: '同步失败', cls: 'bg-destructive/10 text-destructive' },
}

/**
 * 全局同步状态胶囊：常驻右上角，点击可手动「立即同步」。
 * 挂载在 AppShell，所有主路由都可见（见 Phase D 接线）。
 */
export function SyncIndicator() {
  const { status, lastSyncAt, syncNow } = useSyncStatus()
  const meta = META[status]
  const Icon = meta.icon
  const spinning = status === 'syncing'
  const ago = status === 'synced' ? fmtAgo(lastSyncAt) : ''

  return (
    <div className="pointer-events-none fixed right-2 top-2 z-30">
      <button
        type="button"
        onClick={() => syncNow()}
        disabled={spinning}
        aria-label="同步状态，点击立即同步"
        className={cn(
          'pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur transition-colors',
          meta.cls,
          spinning && 'cursor-default',
        )}
      >
        {spinning ? (
          <Icon className="h-3.5 w-3.5 animate-spin" />
        ) : status === 'synced' ? (
          <Icon className="h-3.5 w-3.5" />
        ) : status === 'error' ? (
          <Icon className="h-3.5 w-3.5" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        <span>{ago ? `${meta.label} · ${ago}` : meta.label}</span>
        {status === 'error' && <RefreshCw className="h-3 w-3" />}
      </button>
    </div>
  )
}
