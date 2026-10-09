import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Leaf, Loader2, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/useAppStore'
import { authService } from '@/services/auth'

/**
 * 启动 / 登录（前置门）。
 * - 登录：调用本地桩 authService.login（生成 userId + 写 Dexie `session` 表），随后进入「我的」查看账号态。
 * - 游客：仅本地数据，跳过登录直接进入（Phase 2 起登录后可跨设备同步）。
 * 本地桩阶段不校验密码强度；密码字段仅占位，真实校验在 Supabase 接入后由云端完成。
 */
export function StartLogin() {
  const navigate = useNavigate()
  const setGuest = useAppStore((s) => s.setGuest)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const normalized = email.trim().toLowerCase()
    if (!normalized) {
      setErr('请输入邮箱')
      return
    }
    if (!password) {
      setErr('请输入密码')
      return
    }
    setLoading(true)
    try {
      await authService.login({ email: normalized, password })
      setGuest(false)
      navigate('/profile')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-between bg-gradient-to-b from-primary/15 to-background px-6 py-12">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-soft">
          <Leaf className="h-10 w-10" />
        </div>
        <h1 className="text-3xl font-bold text-foreground">述树</h1>
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
          中文母语者的零基础英语。点读、慢速、中文辅助，7 天敢开口，30 天能对话。
        </p>
      </div>

      <div className="w-full max-w-xs space-y-3">
        {/* 登录表单 */}
        <form onSubmit={handleLogin} className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            autoComplete="email"
            aria-label="邮箱"
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-base outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete="current-password"
            aria-label="密码"
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-base outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {err && <p className="px-1 text-xs text-destructive">{err}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
            登录 / 注册
          </Button>
        </form>

        <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* 游客直接进入 */}
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={() => {
            setGuest(true)
            navigate('/diagnosis')
          }}
        >
          以游客身份开始 <ArrowRight className="h-5 w-5" />
        </Button>
        <p className="mt-1 text-center text-xs text-muted-foreground">
          游客模式仅本地数据，登录后可跨设备同步（Phase 2）
        </p>
      </div>
    </div>
  )
}
