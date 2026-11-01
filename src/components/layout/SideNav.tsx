import { useState, type ComponentType } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  IconHomeSolid,
  IconDiscover,
  IconReviewCards,
  IconUserSolid,
  IconImport,
  IconCollapseBars,
  IconExpandCrown,
} from '@/components/icons/shushu'
import {
  BookOpen,
  Route,
  Trophy,
  PenLine,
  Mic,
  BookMarked,
  Search,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 桌面侧边导航（多端兼容 阶段1-A2）。
 *
 * 设计边界（与阶段 0/1 红线一致）：
 *  - 本文件是「纯新增组件」，A2 阶段不接入 AppShell、不接桌面布局，
 *    移动端行为零变化；A5 才会把它挂进 AppShell 的桌面分支。
 *  - 导航数据独立定义，不重构 BottomTabBar（不为了复用 TABS 去动已有文件）。
 *  - 所有 to 均来自 src/App.tsx 真实存在的路由；不创造任何不存在的页面。
 *  - 图标复用现有资源：主 4 项用 shushu 自绘，其余用项目既有依赖 lucide-react
 *    （^0.439.0，已在多处使用，未引入新依赖）。
 *  - 侧栏自身可独立滚动（flex-1 min-h-0 overflow-y-auto），不影响主内容区。
 *
 * 折叠：默认展开 240px（w-60），折叠 64px（w-16）。内部 state 管理，A5 再提升。
 */

type NavIcon = ComponentType<{ className?: string }>

type NavItem = {
  to: string
  label: string
  icon: NavIcon
  /** NavLink end 语义：true=仅精确匹配；false=匹配自身及子路径 */
  end?: boolean
  /** 额外高亮前缀：当前路径以这些前缀开头时也视为激活（用于详情页高亮父分组） */
  activeOn?: string[]
}

/** 主导航：与 BottomTabBar.TABS 完全一致（首页/发现/复习/我的） */
const MAIN_NAV: NavItem[] = [
  { to: '/', label: '首页', icon: IconHomeSolid, end: true },
  { to: '/discover', label: '发现', icon: IconDiscover, end: false, activeOn: ['/course'] },
  { to: '/review', label: '复习', icon: IconReviewCards, end: false },
  { to: '/profile', label: '我的', icon: IconUserSolid, end: false },
]

/** 学习分组：均为 src/App.tsx 中真实存在的路由 */
const STUDY_NAV: NavItem[] = [
  { to: '/learn', label: '学习', icon: BookOpen, end: false },
  { to: '/path', label: '学习路径', icon: Route, end: false },
  { to: '/challenge', label: '挑战', icon: Trophy, end: false },
  { to: '/spelling', label: '拼写练习', icon: PenLine, end: false, activeOn: ['/spelling-result'] },
  { to: '/recitations', label: '跟读', icon: Mic, end: false },
  { to: '/collections', label: '收藏', icon: BookMarked, end: false, activeOn: ['/collection'] },
]

/** 工具分组：均为真实路由。词典扫描(/dict-ingest)为管理员口令入口，不放入常规模板 */
const TOOL_NAV: NavItem[] = [
  { to: '/search', label: '搜索', icon: Search, end: false },
  { to: '/import', label: '导入', icon: IconImport, end: false },
  { to: '/settings', label: '设置', icon: Settings, end: false },
]

function NavSection({
  title,
  items,
  collapsed,
}: {
  title: string
  items: NavItem[]
  collapsed: boolean
}) {
  const { pathname } = useLocation()
  return (
    <div className="px-2">
      {!collapsed && (
        <div className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          {title}
        </div>
      )}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end ?? false}
              title={item.label}
              aria-label={item.label}
              className={({ isActive }) => {
                const active =
                  isActive ||
                  item.activeOn?.some(
                    (p) => pathname === p || pathname.startsWith(p + '/'),
                  )
                return cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SideNav() {
  const [collapsed, setCollapsed] = useState(false)

  const toggleLabel = collapsed ? '展开侧边栏' : '折叠侧边栏'

  return (
    <aside
      aria-label="主导航"
      className={cn(
        'flex h-full flex-col border-r border-border bg-card',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* 顶部品牌 + 折叠按钮 */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-border px-3',
          collapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {!collapsed && <span className="text-base font-semibold">述树</span>}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {collapsed ? (
            <IconExpandCrown className="h-5 w-5" />
          ) : (
            <IconCollapseBars className="h-5 w-5" />
          )}
        </button>
      </div>

      {/* 导航滚动区：独立滚动，不挤压/影响主内容 */}
      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        <NavSection title="主导航" items={MAIN_NAV} collapsed={collapsed} />
        <NavSection title="学习" items={STUDY_NAV} collapsed={collapsed} />
        <NavSection title="工具" items={TOOL_NAV} collapsed={collapsed} />
      </nav>
    </aside>
  )
}
