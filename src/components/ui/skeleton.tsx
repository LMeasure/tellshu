import { cn } from '@/lib/utils'

/** 加载骨架（见 04/05 三态规范） */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}
