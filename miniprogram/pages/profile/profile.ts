// pages/profile/profile.ts —— 我们

import {
  getCouple,
  getIdentity,
  updateStartDate,
  updateProfile,
  daysBetween,
  clearAll,
  getPet,
} from '../../services/store'
import { toDisplayUrl } from '../../utils/media-url'
import { changeAvatarForSlot } from '../../utils/avatar'
import { ensureCloudReady } from '../../services/page-boot'
import { bootstrapSession } from '../../services/session'
import { getAppInstance } from '../../app'

Page({
  data: {
    youName: '你',
    themName: 'TA',
    youAvatarSrc: '',
    themAvatarSrc: '',
    startDate: '',
    days: 0,
    role: 'A' as 'A' | 'B',
    bound: false,
    partnerWechatId: '',
    confirmText: '',
    showClear: false,
    petLabel: '去领养',
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async refresh() {
    const couple = getCouple()
    if (!couple) return
    const id = getIdentity()
    let petLabel = '去领养'
    try {
      const pet = await getPet()
      if (pet.adopted) petLabel = `${pet.name} · Lv.${pet.level}`
    } catch {
      /* ignore */
    }
    const [youAvatarSrc, themAvatarSrc] = await Promise.all([
      toDisplayUrl(couple.memberA.avatarUrl),
      toDisplayUrl(couple.memberB?.avatarUrl ?? ''),
    ])
    this.setData({
      youName: couple.memberA.nickname,
      themName: couple.memberB?.nickname ?? '尚未加入',
      youAvatarSrc,
      themAvatarSrc,
      startDate: couple.startDate,
      days: daysBetween(couple.startDate),
      role: id.role,
      bound: !!couple.memberB,
      partnerWechatId: couple.partnerWechatId ?? '',
      petLabel,
    })
  },

  onTapAvatar(e: WechatMiniprogram.TouchEvent) {
    const slot = e.currentTarget.dataset.slot as 'A' | 'B'
    void changeAvatarForSlot(slot, this.data.role).then(ok => {
      if (ok) void this.refresh()
    })
  },

  onTapPet() {
    wx.navigateTo({ url: '/pages/pet/pet' })
  },

  onEditNickname() {
    const { nickname } = getIdentity()
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '你的昵称',
      content: nickname,
      success: async res => {
        if (!res.confirm || !res.content) return
        const nickname = res.content.trim()
        if (!nickname) return
        try {
          await updateProfile({ nickname })
          wx.showToast({ title: '已更新', icon: 'success' })
          this.refresh()
        } catch (err) {
          const msg = err instanceof Error ? err.message : '更新失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },

  onPickStartDate(e: WechatMiniprogram.PickerChange) {
    const next = String(e.detail.value)
    if (!next || next === this.data.startDate) return
    wx.showModal({
      title: '修改开始日期？',
      content: '会重新计算「在一起的第 N 天」。',
      confirmText: '改',
      cancelText: '不改',
      success: async res => {
        if (!res.confirm) return
        try {
          await updateStartDate(next)
          wx.showToast({ title: '已更新', icon: 'success' })
          this.refresh()
        } catch (err) {
          const msg = err instanceof Error ? err.message : '更新失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },

  onTapInvite() {
    wx.navigateTo({ url: '/pages/bind/bind' })
  },

  onTapAnniversaries() {
    wx.navigateTo({ url: '/pages/anniversaries/anniversaries' })
  },

  onTapMap() {
    wx.navigateTo({ url: '/pages/map/map' })
  },

  onTapCheckinHistory() {
    wx.navigateTo({ url: '/pages/checkin-history/checkin-history' })
  },

  onTapPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' })
  },

  onConfirmInput(e: WechatMiniprogram.Input) {
    this.setData({ confirmText: e.detail.value })
  },

  onToggleClear() {
    this.setData({ showClear: !this.data.showClear, confirmText: '' })
  },

  async onConfirmClear() {
    if (this.data.confirmText.trim() !== '确认') {
      wx.showToast({ title: '需输入「确认」二字', icon: 'none' })
      return
    }
    wx.showLoading({ title: '清空中' })
    try {
      await clearAll()
      await bootstrapSession()
      await getAppInstance().runBoot()
      this.setData({ showClear: false, confirmText: '' })
      wx.reLaunch({ url: '/pages/setup/setup' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '清空失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },
})
