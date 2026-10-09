import { useCallback, useEffect, useState } from 'react'
import { authService } from '@/services/auth'
import type { AuthSession, Credentials } from '@/services/auth/types'

/**
 * 账号状态钩子：包裹本地桩 authService（会话存 Dexie，不进 localStorage）。
 * 每个用到账号态的组件各自在挂载时读取一次会话；login / logout 会即时更新本地状态。
 */
export function useAuth() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    authService
      .getCurrentSession()
      .then((s) => {
        if (alive) {
          setSession(s)
          setReady(true)
        }
      })
      .catch(() => alive && setReady(true))
    return () => {
      alive = false
    }
  }, [])

  const login = useCallback(async (creds: Credentials) => {
    const s = await authService.login(creds)
    setSession(s)
    return s
  }, [])

  const register = useCallback(async (creds: Credentials) => {
    const s = await authService.register(creds)
    setSession(s)
    return s
  }, [])

  const logout = useCallback(async () => {
    await authService.logout()
    setSession(null)
  }, [])

  return { session, isLoggedIn: session !== null, ready, login, register, logout }
}
