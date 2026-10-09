import { useNavigate } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'

/**
 * 账号区块（Phase D）：展示登录态与 userId，提供登录入口 / 退出登录。
 * 会话来自 authService（存 Dexie `session` 表，令牌不进 localStorage）。
 * subtitle 由调用方传入（如诊断等级），在游客态下作为副标题。
 */
export function AccountSection({ subtitle }: { subtitle?: string }) {
  const { session, isLoggedIn, logout } = useAuth()
  const navigate = useNavigate()

  if (!isLoggedIn) {
    return (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 text-lg font-bold text-primary">
            游
          </div>
          <div>
            <div className="font-semibold">游客</div>
            <div className="text-xs text-muted-foreground">
              {subtitle ?? '本地数据 · 未同步'}
            </div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => navigate('/start')}>
          登录同步
        </Button>
      </div>
    )
  }

  const initial = (session!.email[0] ?? '?').toUpperCase()

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
          {initial}
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold">{session!.email}</div>
          <div className="text-xs text-muted-foreground">
            已登录 · ID {session!.user_id.slice(0, 8)}
          </div>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={() => void logout()}>
        <LogOut className="h-4 w-4" /> 退出
      </Button>
    </div>
  )
}
