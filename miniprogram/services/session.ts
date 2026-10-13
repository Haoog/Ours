// services/session.ts — 登录态与双人空间会话

import { callOurs } from './cloud-api'
import { Couple } from './types'

export type SessionStatus = 'ready' | 'needsInviteCode' | 'expired' | 'suspended' | 'revoked'

export interface Session {
  status: SessionStatus
  openid: string
  role: 'A' | 'B'
  couple: Couple | null
  coupleId: string | null
}

const SESSION_STORAGE_KEY = 'OURS_SESSION_V1'

/** 仅持久化 ready 态会话，用于冷启动乐观渲染（数据会在 bootstrap 后被刷新覆盖） */
function persist(session: Session | null): void {
  try {
    if (session && session.status === 'ready' && session.coupleId) {
      wx.setStorageSync(SESSION_STORAGE_KEY, session)
    } else {
      wx.removeStorageSync(SESSION_STORAGE_KEY)
    }
  } catch (e) {}
}

function loadPersisted(): Session | null {
  try {
    const s = wx.getStorageSync(SESSION_STORAGE_KEY)
    if (s && s.status === 'ready' && s.coupleId && s.couple) return s as Session
  } catch (e) {}
  return null
}

let cached: Session | null = loadPersisted()
let refreshedAt = 0
let refreshPromise: Promise<Session> | null = null

export function syncSession(force = false): Promise<Session> {
  if (refreshPromise) return refreshPromise
  if (!force && cached && Date.now() - refreshedAt < 15000) return Promise.resolve(cached)
  refreshPromise = bootstrapSession().finally(() => { refreshPromise = null })
  return refreshPromise
}

export function getSession(): Session | null {
  return cached
}

/** 供数据层在原地修改 couple 后回写本地缓存 */
export function persistSession(): void {
  persist(cached)
}

export function requireSession(): Session {
  if (!cached || cached.status !== 'ready' || !cached.coupleId) {
    throw new Error('尚未完成空间初始化')
  }
  return cached
}

export function coupleId(): string {
  return requireSession().coupleId!
}

export async function bootstrapSession(opts?: {
  inviteToken?: string
  nickname?: string
  avatarUrl?: string
}): Promise<Session> {
  const data = await callOurs<{
    status: SessionStatus
    openid: string
    role?: 'A' | 'B'
    couple?: Couple
  }>('bootstrap', {
    inviteToken: opts?.inviteToken ?? '',
    nickname: opts?.nickname ?? '',
    avatarUrl: opts?.avatarUrl ?? '',
  })

  if (data.status === 'ready' && data.couple) {
    cached = {
      status: 'ready',
      openid: data.openid,
      role: data.role ?? 'A',
      couple: data.couple,
      coupleId: data.couple.id,
    }
  } else {
    cached = {
      status: data.status,
      openid: data.openid,
      role: data.role ?? 'A',
      couple: data.couple ?? null,
      coupleId: data.couple?.id ?? null,
    }
  }
  persist(cached)
  refreshedAt = Date.now()
  return cached
}

export async function redeemAccessCodeAndCache(input: {
  code: string
  startDate: string
  nickname: string
  avatarUrl?: string
}): Promise<Session> {
  const couple = await callOurs<Couple>('redeemAccessCode', input)
  cached = {
    status: 'ready',
    openid: cached?.openid || couple.memberA.openid,
    role: 'A',
    couple,
    coupleId: couple.id,
  }
  persist(cached)
  return cached
}

/** 旧名称保留给其它开发期代码，正式入口统一走邀请码兑换。 */
export const createCoupleAndCache = redeemAccessCodeAndCache
