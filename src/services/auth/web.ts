import { storage } from '../storage'
import { uuid } from '@/lib/uuid'
import type { AuthSession, Credentials } from './types'

/**
 * 本地桩：登录即生成一个 userId 并写入 Dexie `session` 表。
 * 不校验密码（云端接入后由 Supabase 做邮箱+密码 + 重名/强度校验）；
 * 令牌只存 `session` 表，不进 localStorage（合规红线）。
 */
async function createSession(email: string): Promise<AuthSession> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) throw new Error('邮箱不能为空')
  const now = Date.now()
  const session: AuthSession = {
    user_id: uuid(),
    email: normalized,
    access_token: uuid(),
    refresh_token: uuid(),
    expires_at: now + 60 * 60_000,
    updated_at: now,
  }
  await storage.table('session').put(session)
  return session
}

export const authService = {
  login(creds: Credentials): Promise<AuthSession> {
    return createSession(creds.email)
  },

  register(creds: Credentials): Promise<AuthSession> {
    // 本地桩阶段：注册与登录等价（云端接入后做重名 / 密码强度校验）
    return createSession(creds.email)
  },

  async logout(): Promise<void> {
    const current = await authService.getCurrentSession()
    if (current) await storage.table('session').delete(current.user_id)
  },

  async getCurrentSession(): Promise<AuthSession | null> {
    const rows = await storage.table('session').toArray()
    return rows.length > 0 ? (rows[0] as AuthSession) : null
  },

  async isLoggedIn(): Promise<boolean> {
    return (await authService.getCurrentSession()) !== null
  },
}
