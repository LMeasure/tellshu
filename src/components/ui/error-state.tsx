import { AlertTriangle } from 'lucide-react'
import { IconReset } from '@/components/icons/shushu'
import { Button } from './button'

/** 错误重试态（见 04/05 三态规范）。重试用 10 号回转箭头（需求 20）。 */
export function ErrorState({
  message = '出了点小问题',
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <p className="text-base font-semibold text-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <IconReset className="h-4 w-4" /> 重试
        </Button>
      )}
    </div>
  )
}
