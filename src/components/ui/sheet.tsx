import { useEffect } from 'react'
import { cn } from '@/lib/utils'

/**
 * 底部弹层（Bottom Sheet）——移动端从底部滑入的轻量容器。
 * 用于阅读器「点/长按单词」时的快捷操作面板。
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  className?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'absolute inset-x-0 bottom-0 max-h-[82vh] overflow-auto rounded-t-2xl bg-card p-4 pb-6 shadow-soft animate-slide-up safe-bottom',
          className,
        )}
      >
        {title && <div className="mb-3 text-base font-semibold text-foreground">{title}</div>}
        {children}
      </div>
    </div>
  )
}
