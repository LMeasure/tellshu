import { cn } from '@/lib/utils'

/** 图标组件的最小契约：lucide 图标与述树自绘图标都满足 */
type IconComponent = React.ComponentType<{ className?: string }>

/** 空状态（见 04/05 三态规范）：内容缺失时的友好引导，非报错 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: IconComponent
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {Icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-primary">
          <Icon className="h-7 w-7" />
        </div>
      )}
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description && (
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  )
}
