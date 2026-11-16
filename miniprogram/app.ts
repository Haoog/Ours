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
      else if (!bootInFlight) bootPromise = this.runBoot()
    })

    const info = wx.getAccountInfoSync?.()
    if (info?.miniProgram?.envVersion) {
      this.globalData.envVersion = info.miniProgram.envVersion
    }

    const invite =
      (options?.query?.inviteToken as string) ||
      undefined
    bootPromise = this.runBoot(invite)
  },

  onShow(options) {
    if (sessionVerified) void retryUploadCleanup()
    const invite = options?.query?.inviteToken
    if (!this.globalData.booted || !invite || getSession()?.status === 'ready') return
    bootPromise = this.runBoot(String(invite)).then(() => {
      if (getSession()?.status === 'ready') wx.reLaunch({ url: '/pages/home/home' })
    })
  },

  async runBoot(inviteToken?: string) {
    if (bootInFlight) return bootPromise ?? Promise.resolve()
    bootInFlight = true
    sessionVerified = false
    try {
      const session = await bootstrapSession({ inviteToken })
      this.globalData.booted = true
      sessionVerified = true
      if (session.status === 'ready') void retryUploadCleanup()
      if (session.status !== 'ready') {
        const pages = getCurrentPages()
        const route = pages[pages.length - 1]?.route ?? ''
        if (route !== 'pages/setup/setup') {
          wx.reLaunch({ url: '/pages/setup/setup' })
        }
      }
    } catch (err) {
      this.globalData.booted = true
      const msg = err instanceof Error ? err.message : '云开发连接失败'
      wx.showModal({
        title: '暂时连不上',
        content: `${msg}\n\n请稍后重试；如果仍无法连接，请联系管理员。`,
        showCancel: false,
      })
    } finally {
      bootInFlight = false
    }
  },

  waitBoot() {
    return bootPromise ?? Promise.resolve()
  },
})

export function getAppInstance(): IAppOption {
  return getApp<IAppOption>()
}
