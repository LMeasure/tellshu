import type { ReactNode } from 'react'
import { BottomTabBar } from './BottomTabBar'
import { SearchDock } from './SearchDock'
import { SyncIndicator } from '@/components/sync/SyncIndicator'
import { SyncNotice } from '@/components/sync/SyncNotice'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { SideNav } from './SideNav'
import { DesktopTopBar } from './DesktopTopBar'

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
 *
 * 2026-11-01 多端兼容 阶段1-A5（依据：A5-0 审查报告 / 架构设计文档）：
 *  - 在 AppShell 内用 useIsDesktop() 做「桌面外壳 / 移动外壳」二选一分支，
 *    不重写移动端、不碰路由/页面/全局 CSS、不引入新依赖。
 *  - 桌面档（>=1024px）：SideNav(240/64 可折叠) + DesktopTopBar(56px) +
 *    内容区(max-w-[1200px] 居中、独立纵向滚动)；不渲染底部 SearchDock/BottomTabBar。
 *  - 移动档(<1024px，含 768/390)：保留下方改造前结构与交互，逐字不变。
 *  - 19 条套 AppShell 路由自动获得桌面壳；/start、/diagnosis、/reader、/word
 *    不套壳，完全不受影响。SideNav 折叠用其自身内部 state（固定宽 + 主区 flex-1），
 *    不产生宽度计算错误。
 */
export function AppShell({
  children,
  showGlobalSearch = true,
}: {
  children: ReactNode
  showGlobalSearch?: boolean
}) {
  useKeyboardInset()
  const isDesktop = useIsDesktop()

  // 桌面档：侧栏 + 顶栏 + 内容区；整体锁高，仅主内容区独立滚动（避免双滚动条）
  if (isDesktop) {
    return (
      <>
        <div className="flex h-screen overflow-hidden">
          <SideNav />
          <div className="flex min-w-0 flex-1 flex-col">
            <DesktopTopBar showSearch={showGlobalSearch} />
            <main className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[1200px]">{children}</div>
            </main>
          </div>
          <SyncIndicator />
          <SyncNotice />
        </div>
      </>
    )
  }

  // 移动档：改造前结构逐字保留（.app-frame / safe-top / 底部停靠组 / Tab / safe-bottom）
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
