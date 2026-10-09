import { useEffect } from 'react'
import { cn } from '@/lib/utils'

/**
 * 居中弹窗（Dialog）——与底部 Sheet 区分：用于「一轮学完」这类需要停下来的提示。
 * 点遮罩不关闭：完成提示必须让用户明确选择下一步（继续 / 去复习），
 * 误触遮罩会让人不知道自己到底做没做。
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean
  onClose?: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  useEffect(() => {
    if (!open || !onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative w-full max-w-sm animate-in rounded-2xl bg-card p-5 shadow-soft',
          className,
        )}
      >
        {title && <div className="mb-3 text-center text-lg font-bold">{title}</div>}
        <div className="text-center text-sm text-muted-foreground">{children}</div>
        {footer && <div className="mt-4 space-y-2">{footer}</div>}
      </div>
    </div>
  )
}
