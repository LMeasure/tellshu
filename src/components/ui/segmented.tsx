import { cn } from '@/lib/utils'

export interface SegmentedItem<T extends string> {
  key: T
  label: string
  icon?: React.ReactNode
}

/**
 * 分段切换控件（阅读/记忆、隐藏单词/文字 等）。
 * 移动端友好：等宽分段、清晰选中态（多巴胺绿）。
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  className,
  size = 'md',
}: {
  items: SegmentedItem<T>[]
  value: T
  onChange: (v: T) => void
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div
      className={cn(
        'inline-flex w-full rounded-xl bg-secondary p-1',
        className,
      )}
      role="tablist"
    >
      {items.map((it) => {
        const active = it.key === value
        return (
          <button
            key={it.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors touch-target',
              size === 'sm' ? 'py-1.5 text-xs' : 'py-2 text-sm',
              active
                ? 'bg-primary text-primary-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        )
      })}
    </div>
  )
}
