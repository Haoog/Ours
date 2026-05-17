// services/session.ts — 登录态与双人空间会话

import { callOurs } from './cloud-api'
import { Couple } from './types'

export type SessionStatus = 'ready' | 'needsSetup'

export interface Session {
  status: SessionStatus
  openid: string
  role: 'A' | 'B'
  couple: Couple | null
  coupleId: string | null
}

let cached: Session | null = null

export function getSession(): Session | null {
  return cached
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
  inviteCoupleId?: string
  nickname?: string
  avatarUrl?: string
}): Promise<Session> {
  const data = await callOurs<{
    status: SessionStatus
    openid: string
    role?: 'A' | 'B'
    couple?: Couple
  }>('bootstrap', {
    inviteCoupleId: opts?.inviteCoupleId ?? '',
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
      status: 'needsSetup',
      openid: data.openid,
      role: 'A',
      couple: null,
      coupleId: null,
    }
  }
  return cached
}

export async function createCoupleAndCache(input: {
  startDate: string
  nickname: string
  avatarUrl?: string
}): Promise<Session> {
  const couple = await callOurs<Couple>('createCouple', input)
  cached = {
    status: 'ready',
    openid: cached?.openid ?? '',
    role: 'A',
    couple,
    coupleId: couple.id,
  }
  return cached
}

export function clearSessionCache(): void {
  cached = null
}
