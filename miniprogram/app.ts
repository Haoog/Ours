// app.ts — OursWXAPP 入口

import { CLOUD_ENV_ID } from './config/env'
import { bootstrapSession, getSession } from './services/session'
import { applyThemeChrome } from './services/theme'
import { retryUploadCleanup } from './services/upload-cleanup'

interface IAppOption {
  globalData: {
    envVersion: string
    booted: boolean
  }
  runBoot(inviteToken?: string): Promise<void>
  waitBoot(): Promise<void>
}

let bootPromise: Promise<void> | null = null
let sessionVerified = false
let bootInFlight = false
let activeBootInvite: string | undefined
let queuedInvite: { token: string } | null = null
let inviteBoot: Promise<void> | null = null

App<IAppOption>({
  globalData: {
    envVersion: '0.1.0',
    booted: false,
  },

  onLaunch(options) {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 及以上基础库，并开通云开发')
      return
    }
    wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })
    applyThemeChrome()
    wx.onNetworkStatusChange?.(status => {
      if (!status.isConnected) return
      if (sessionVerified) void retryUploadCleanup()
      else if (!bootInFlight) void this.runBoot()
    })

    const info = wx.getAccountInfoSync?.()
    if (info?.miniProgram?.envVersion) {
      this.globalData.envVersion = info.miniProgram.envVersion
    }

    const invite =
      (options?.query?.inviteToken as string) ||
      undefined
    void this.runBoot(invite)
  },

  onShow(options) {
    if (sessionVerified) void retryUploadCleanup()
    const token = options?.query?.inviteToken
    if (!token || getSession()?.status === 'ready' || token === activeBootInvite || token === queuedInvite?.token) return
    const pending = { token: String(token) }
    queuedInvite = pending
    const joining = (async () => {
      while (bootInFlight && queuedInvite === pending) await bootPromise
      if (queuedInvite !== pending) return
      queuedInvite = null
      if (getSession()?.status === 'ready') return
      await this.runBoot(pending.token)
      if (getSession()?.status === 'ready') wx.reLaunch({ url: '/pages/home/home' })
    })()
    inviteBoot = joining
    return joining.finally(() => {
      if (inviteBoot === joining) inviteBoot = null
    })
  },

  runBoot(inviteToken?: string) {
    if (bootInFlight) return bootPromise ?? Promise.resolve()
    bootInFlight = true
    activeBootInvite = inviteToken
    sessionVerified = false
    bootPromise = (async () => {
      try {
        const session = await bootstrapSession({ inviteToken })
        this.globalData.booted = true
        sessionVerified = true
        if (session.status === 'ready') void retryUploadCleanup()
        else if (!queuedInvite) {
          const pages = getCurrentPages()
          const route = pages[pages.length - 1]?.route ?? ''
          if (route !== 'pages/setup/setup') wx.reLaunch({ url: '/pages/setup/setup' })
        }
      } catch (err) {
        this.globalData.booted = true
        if (!queuedInvite) {
          const msg = err instanceof Error ? err.message : '云开发连接失败'
          wx.showModal({
            title: '暂时连不上',
            content: `${msg}\n\n请稍后重试；如果仍无法连接，请联系管理员。`,
            showCancel: false,
          })
        }
      } finally {
        activeBootInvite = undefined
        bootInFlight = false
      }
    })()
    return bootPromise
  },

  waitBoot() {
    return inviteBoot ?? bootPromise ?? Promise.resolve()
  },
})

export function getAppInstance(): IAppOption {
  return getApp<IAppOption>()
}
