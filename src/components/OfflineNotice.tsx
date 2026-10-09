import type { ReactNode } from 'react'
import { WifiOff } from 'lucide-react'

/**
 * 离线提示条
 * ------------------------------------------------------------------
 * 为什么需要：词库分片是**按需缓存**的（410MB 不可能预加载），
 * 所以断网时打开一个从没访问过的分页，表现为"空列表"。
 * 如果不说明，用户会以为 App 坏了或者数据丢了 —— 实际上只是没缓存过。
 *
 * 只在「离线 + 内容确实取不到」时展示，联网时不出现（避免噪音）。
 */
export function OfflineNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <WifiOff size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">当前离线。</span>
        {children ?? '这部分内容还没缓存过，联网打开一次后，之后断网也能看。'}
      </p>
    </div>
  )
}
