import { NavLink } from 'react-router-dom'
import {
  IconDiscover,
  IconHomeSolid,
  IconReviewCards,
  IconUserSolid,
} from '@/components/icons/shushu'
import { cn } from '@/lib/utils'

/**
 * 底部 Tab：首页 / 发现 / 复习 / 我的（见 02-IA §1，04/05 全局常驻）。
 * 图标按需求换为述树自绘：首页=3号实心房、发现=1号网络节点、
 * 复习=2号翻卡叠、我的=4号实心人（见 components/icons/shushu.tsx 的用途登记）。
 */
const TABS = [
  { to: '/', label: '首页', icon: IconHomeSolid, end: true },
  { to: '/discover', label: '发现', icon: IconDiscover, end: false },
  { to: '/review', label: '复习', icon: IconReviewCards, end: false },
  { to: '/profile', label: '我的', icon: IconUserSolid, end: false },
]

export function BottomTabBar() {
  return (
    <nav className="safe-bottom sticky bottom-0 z-20 flex items-stretch border-t border-border bg-card/95 backdrop-blur">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground',
            )
          }
        >
          <t.icon className="h-5 w-5" />
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}
