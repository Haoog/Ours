// app.ts — OursWXAPP 入口

import { CLOUD_ENV_ID } from './config/env'
import { bootstrapSession, getSession } from './services/session'

interface IAppOption {
  globalData: {
    envVersion: string
    booted: boolean
    petTick: number
  }
  bumpPet(): void
  runBoot(inviteToken?: string): Promise<void>
  waitBoot(): Promise<void>
}

let bootPromise: Promise<void> | null = null

App<IAppOption>({
  globalData: {
    envVersion: '0.1.0',
    booted: false,
    petTick: 0,
  },

  bumpPet() {
    this.globalData.petTick += 1
  },

  onLaunch(options) {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 及以上基础库，并开通云开发')
      return
    }
    wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true })

    const info = wx.getAccountInfoSync?.()
    if (info?.miniProgram?.envVersion) {
      this.globalData.envVersion = info.miniProgram.envVersion
    }

    const invite =
      (options?.query?.inviteToken as string) ||
      undefined
    bootPromise = this.runBoot(invite)
  },

  async runBoot(inviteToken?: string) {
    try {
      const session = await bootstrapSession({ inviteToken })
      this.globalData.booted = true
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
        content: `${msg}\n\n请确认已部署云函数 ours，并创建 access_codes / space_invites / couples / moments 等集合。`,
        showCancel: false,
      })
    }
  },

  waitBoot() {
    return bootPromise ?? Promise.resolve()
  },
})

export function getAppInstance(): IAppOption {
  return getApp<IAppOption>()
}

export function isSessionReady(): boolean {
  return getSession()?.status === 'ready'
}
