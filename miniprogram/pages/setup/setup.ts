// pages/setup/setup.ts — 创建双人空间（你）

import { redeemAccessCode } from '../../services/store'
import { getSession } from '../../services/session'
import { getAppInstance } from '../../app'
import { saveMyAvatar } from '../../utils/avatar'
import { getThemeStyle, syncTheme } from '../../services/theme'

function defaultStartDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    accessCode: '',
    nickname: '你',
    avatarUrl: '',
    startDate: defaultStartDate(),
    submitting: false,
    activated: false,
    statusMessage: '',
  },

  /** chooseAvatar 返回的临时路径，建空间后再上传 */
  avatarTempPath: '',
  unloaded: false,
  homeNavigationPending: false,
  homeTimer: 0,

  async onLoad() {
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (this.unloaded) return
    const session = getSession()
    // 本页兑换成功时，由提交流程完成头像处理和跳转。
    if (session?.status === 'ready' && !this.data.activated) {
      this.setData({ activated: true })
      this.enterHome()
    } else if (session?.status === 'expired' || session?.status === 'suspended' || session?.status === 'revoked') {
      this.setData({ statusMessage: '当前空间暂时无法使用，请联系管理员处理授权。' })
    }
  },

  onUnload() {
    this.unloaded = true
    clearTimeout(this.homeTimer)
    if (this.data.submitting) wx.hideLoading()
  },

  enterHome(delay = 0) {
    if (this.unloaded || this.homeNavigationPending) return
    this.homeNavigationPending = true
    const navigate = () => {
      wx.switchTab({
        url: '/pages/home/home',
        fail: () => {
          this.homeNavigationPending = false
          if (!this.unloaded) wx.showToast({ title: '未能进入首页，请重试', icon: 'none' })
        },
      })
    }
    if (delay) this.homeTimer = setTimeout(navigate, delay)
    else navigate()
  },

  onCodeInput(e: WechatMiniprogram.Input) {
    this.setData({ accessCode: e.detail.value })
  },

  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const avatarUrl = e.detail?.avatarUrl
    if (!avatarUrl) return
    this.avatarTempPath = avatarUrl
    this.setData({ avatarUrl })
  },

  onNicknameInput(e: WechatMiniprogram.Input) {
    this.setData({ nickname: e.detail.value })
  },

  onPickDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ startDate: String(e.detail.value) })
  },

  async onSubmit() {
    if (this.unloaded || this.data.submitting) return
    if (this.data.activated) {
      this.enterHome()
      return
    }
    const accessCode = this.data.accessCode.trim()
    const nickname = this.data.nickname.trim() || '你'
    if (!accessCode) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' })
      return
    }
    if (!this.data.startDate) {
      wx.showToast({ title: '请选择开始日期', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中' })
    try {
      await redeemAccessCode({ code: accessCode, startDate: this.data.startDate, nickname })
      if (this.unloaded) return
      this.setData({ activated: true })
      // 头像可选：建空间后再上传，失败不阻断主流程
      if (this.avatarTempPath) {
        try {
          await saveMyAvatar(this.avatarTempPath)
        } catch (e) {
          console.warn('保存头像失败', e)
        }
      }
      if (this.unloaded) return
      wx.showToast({ title: '已激活空间', icon: 'success' })
      this.enterHome(400)
    } catch (err) {
      if (!this.unloaded) {
        const msg = err instanceof Error ? err.message : '创建失败'
        wx.showToast({ title: msg, icon: 'none' })
      }
    } finally {
      if (!this.unloaded) {
        wx.hideLoading()
        this.setData({ submitting: false })
      }
    }
  },
})
