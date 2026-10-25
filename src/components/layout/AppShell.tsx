import type { ReactNode } from 'react'
import { BottomTabBar } from './BottomTabBar'
import { SearchDock } from './SearchDock'
import { SyncIndicator } from '@/components/sync/SyncIndicator'
import { SyncNotice } from '@/components/sync/SyncNotice'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

/**
 * 全局应用外壳：主内容滚动区 + 底部停靠组（搜索区 + Tab）。
 * 以 375px 为设计基准居中（见 08 技术选型 §2 适配规范）。
 * 同步状态（SyncIndicator / SyncNotice）常驻于此，所有主路由可见。
 *
 * 2026-10-21 全局搜索改版（方案 v2 用户确认）：
 *  - 原顶部搜索栏 TopSearchBar 撤掉，能力（搜索 / 语音输入 / 扫描识别）整体
 *    迁入底部 SearchDock；刘海安全区随之从顶栏转移到 main 顶部（safe-top）；
 *  - 底部停靠组：SearchDock（上）+ BottomTabBar（下）同一 sticky 容器，
 *    Tab 栏保持屏幕最底一级；键盘弹起整组按 --kb-inset 上移
 *    （useKeyboardInset：iOS 不缩布局视口，只能信 visualViewport）；
 *  - showGlobalSearch：默认全页面接入；/search 页自身就是搜索页，传 false
 *    避免同功能重复（/word/:word 与 /reader/:id 不在 AppShell 内，天然没有）。
 */
export function AppShell({
  children,
  showGlobalSearch = true,
}: {
  children: ReactNode
  showGlobalSearch?: boolean
}) {
  useKeyboardInset()
  return (
    <div className="app-frame flex min-h-screen flex-col">
      <main className="safe-top flex-1 overflow-y-auto">{children}</main>
      {/* 底部停靠组：safe-bottom 收敛在容器（无搜索区的页面 Tab 栏也不露安全区）；
          顺序经用户定稿：搜索框在上、Tab 栏在下 */}
      <div className="safe-bottom sticky bottom-[var(--kb-inset,0px)] z-30">
        {showGlobalSearch && <SearchDock />}
        <BottomTabBar />
      </div>
      <SyncIndicator />
      <SyncNotice />
    </div>
  )
}
