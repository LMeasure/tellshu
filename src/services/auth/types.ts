/** 账号会话（令牌只存 Dexie `session` 表，不进 localStorage） */
export interface AuthSession {
  user_id: string
  email: string
  access_token: string
  refresh_token: string
  expires_at: number
  updated_at: number
}

export interface Credentials {
  email: string
  password: string
}

export interface AuthResult {
  session: AuthSession
}
