import { Link, useNavigate } from 'react-router-dom'
import { Leaf, Settings } from 'lucide-react'
import { SearchDock } from './SearchDock'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * 桌面端顶部栏（多端兼容 阶段1-A4）。
 * 纯展示组件，本阶段不接入 AppShell；A5 才会与 SideNav 一起挂进桌面布局。
 *
 * 结构：
 *  - 左：品牌入口（复用应用既有品牌资产 Leaf 图标 + 文字「述树」，链接首页 /）
 *  - 中：桌面搜索（SearchDock variant="topbar"，搜索逻辑完全复用、不复制）
 *  - 右：操作区（仅放真实可用功能：设置 /settings）
 * 高度固定 56px（h-14），宽度占满桌面内容区；窄桌面下搜索 pill 居中且可收缩不溢出。
 *
 * 品牌资产说明：应用内品牌标识统一为 StartLogin 中的 Leaf 图标 + 文字「述树」
 * （public/ 仅有 favicon 与 PNG，无独立矢量 logo），此处直接复用该组合，
 * 不重新绘制、不使用临时文字 Logo。
 */
export function DesktopTopBar({ className }: { className?: string }) {
  const navigate = useNavigate()
  return (
    <header
      className={cn(
        'flex h-14 w-full shrink-0 items-center gap-4 border-b border-border bg-card px-4',
        className,
      )}
    >
      {/* 品牌入口：真实品牌资产，链接到首页（真实路由 /） */}
      <Link
        to="/"
        aria-label="述树首页"
        className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Leaf className="h-5 w-5" />
        </span>
        <span className="text-base font-semibold text-foreground">述树</span>
      </Link>

      {/* 桌面搜索：复用 SearchDock 的 topbar 模式（仅外观不同，逻辑共用） */}
      <div className="flex min-w-0 flex-1 justify-center">
        <SearchDock variant="topbar" />
      </div>

      {/* 右侧操作区：仅真实可用功能（设置）；无用户菜单 / 通知等，不制造无效按钮 */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="设置"
          title="设置"
          onClick={() => navigate('/settings')}
        >
          <Settings className="h-5 w-5" />
        </Button>
      </div>
    </header>
  )
}
