import { getAppInstance } from '../app'
import { getSession } from './session'

/** 等待云启动完成；未创建空间时跳转 setup */
export async function ensureCloudReady(): Promise<boolean> {
  await getAppInstance().waitBoot()
  const session = getSession()
  if (session?.status === 'needsSetup') {
    wx.reLaunch({ url: '/pages/setup/setup' })
    return false
  }
  if (!session?.coupleId) {
    wx.reLaunch({ url: '/pages/setup/setup' })
    return false
  }
  return true
}

/** 分享卡片带 inviteFrom 时（含热启动进 Tab 页） */
export async function handleInviteQuery(query?: Record<string, string | undefined>): Promise<void> {
  const invite = query?.inviteFrom || query?.inviteCoupleId
  if (!invite) return
  const session = getSession()
  if (session?.status === 'ready' && session.coupleId) return
  await getAppInstance().runBoot(invite)
}

export function isDevBuild(): boolean {
  const v = getAppInstance().globalData.envVersion
  return v === 'develop' || v === 'trial'
}
