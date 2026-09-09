import cloudbase from '@cloudbase/js-sdk'

const envId = import.meta.env.VITE_CLOUD_ENV_ID || 'cloud1-d1gg9j97ua5f7f700'

export const cloudApp = cloudbase.init({ env: envId })
export const cloudAuth = cloudApp.auth()

type AdminEnvelope<T> = {
  ok: boolean
  data?: T
  error?: string
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message?: unknown }).message || '请求失败')
  }
  return '请求失败，请稍后再试'
}

export async function signIn(username: string, password: string): Promise<void> {
  const auth = cloudAuth as unknown as {
    signIn?: (input: Record<string, string>) => Promise<{ error?: unknown }>
    signInWithPassword?: (input: Record<string, string>) => Promise<{ error?: unknown }>
  }
  const method = auth.signInWithPassword || auth.signIn
  if (!method) throw new Error('当前 CloudBase 登录 SDK 未提供账号密码登录')
  const account = username.trim()
  const credentials: Record<string, string> = { password }
  if (account.includes('@')) credentials.email = account
  else if (/^\+?[0-9][0-9 -]{5,}$/.test(account)) credentials.phone = account
  else credentials.username = account
  const result = await method.call(auth, credentials)
  if (result?.error) throw new Error(errorMessage(result.error))
}

export async function signOut(): Promise<void> {
  const auth = cloudAuth as unknown as { signOut?: () => Promise<unknown> }
  await auth.signOut?.()
}

export async function hasLoginSession(): Promise<boolean> {
  const auth = cloudAuth as unknown as {
    getLoginState?: () => Promise<{ user?: unknown; isAnonymousAuth?: boolean } | null>
    getSession?: () => Promise<{
      user?: unknown
      session?: unknown
      data?: { user?: unknown; session?: unknown }
    } | null>
    currentUser?: unknown
  }
  if (auth.getLoginState) {
    const state = await auth.getLoginState()
    return !!state?.user && !state.isAnonymousAuth
  }
  if (auth.getSession) {
    const state = await auth.getSession()
    return !!(state?.session || state?.data?.session) && !!(state?.user || state?.data?.user)
  }
  return !!auth.currentUser
}

export async function callAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await cloudApp.callFunction({
    name: 'admin-api',
    data: { action, payload },
  })
  let envelope = response.result as AdminEnvelope<T> | string | undefined
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope) as AdminEnvelope<T>
    } catch {
      throw new Error('管理台接口返回格式错误')
    }
  }
  if (!envelope || !envelope.ok) throw new Error(envelope?.error || '管理台接口调用失败')
  return envelope.data as T
}

export function describeError(error: unknown): string {
  return errorMessage(error)
}
