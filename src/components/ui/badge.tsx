import { cn } from '@/lib/utils'

/** 胶囊标签（见 视觉风格：标签胶囊） */
export function Badge({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}
