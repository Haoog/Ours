// pages/setup/setup.ts — 创建双人空间（你）

import { PARTNER_WECHAT_ID } from '../../config/env'
import { createCouple } from '../../services/store'
import { getSession } from '../../services/session'
import { getAppInstance } from '../../app'

function defaultStartDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

Page({
  data: {
    nickname: '你',
    startDate: defaultStartDate(),
    partnerHint: PARTNER_WECHAT_ID,
    submitting: false,
  },

  async onLoad() {
    await getAppInstance().waitBoot()
    const session = getSession()
    if (session?.status === 'ready') {
      wx.switchTab({ url: '/pages/home/home' })
    }
  },

  onNicknameInput(e: WechatMiniprogram.Input) {
    this.setData({ nickname: e.detail.value })
  },

  onPickDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ startDate: String(e.detail.value) })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const nickname = this.data.nickname.trim() || '你'
    if (!this.data.startDate) {
      wx.showToast({ title: '请选择开始日期', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中' })
    try {
      await createCouple({ startDate: this.data.startDate, nickname })
      wx.showToast({ title: '空间已创建', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 400)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ submitting: false })
    }
  },
})
