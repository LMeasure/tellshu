import type { ReactNode } from 'react'
import { TopSearchBar } from './TopSearchBar'
import { BottomTabBar } from './BottomTabBar'
import { SyncIndicator } from '@/components/sync/SyncIndicator'
import { SyncNotice } from '@/components/sync/SyncNotice'

/**
 * 全局应用外壳：顶部搜索 + 主内容滚动区 + 底部 Tab。
 * 以 375px 为设计基准居中（见 08 技术选型 §2 适配规范）。
 * 同步状态（SyncIndicator / SyncNotice）常驻于此，所有主路由可见。
 */
export function AppShell({ children, showTopSearch = true }: { children: ReactNode; showTopSearch?: boolean }) {
  return (
    <div className="app-frame flex min-h-screen flex-col">
      {showTopSearch && <TopSearchBar />}
      <main className="flex-1 overflow-y-auto">{children}</main>
      <BottomTabBar />
      <SyncIndicator />
      <SyncNotice />
    </div>
  )
}
