// pages/profile/profile.ts —— 我们

import {
  getCouple,
  getIdentity,
  getRelationshipMembers,
  updateStartDate,
  updateProfile,
  daysBetween,
} from '../../services/store'
import { toDisplayUrl } from '../../utils/media-url'
import { changeAvatarForSlot } from '../../utils/avatar'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { getThemeId, getThemeStyle, setTheme, syncTheme, THEME_OPTIONS, ThemeId } from '../../services/theme'
import { syncSession } from '../../services/session'

function themeLabel(id: ThemeId): string {
  if (id === 'peach') return '暖杏'
  if (id === 'mint') return '薄荷'
  if (id === 'sky') return '天蓝'
  return '淡紫'
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    youName: '你',
    themName: 'TA',
    youAvatarSrc: '',
    themAvatarSrc: '',
    startDate: '',
    days: 0,
    role: 'A' as 'A' | 'B',
    bound: false,
    partnerWechatId: '',
    themeId: getThemeId() as ThemeId,
    themeLabel: themeLabel(getThemeId() as ThemeId),
    themes: THEME_OPTIONS,
  },

  async onShow() {
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async refresh() {
    await syncSession(true).catch(() => undefined)
    const couple = getCouple()
    if (!couple) return
    const id = getIdentity()
    const { me, partner } = getRelationshipMembers()
    const [youAvatarSrc, themAvatarSrc] = await Promise.all([
      toDisplayUrl(me.avatarUrl),
      toDisplayUrl(partner?.avatarUrl ?? ''),
    ])
    this.setData({
      youName: me.nickname,
      themName: partner?.nickname ?? '尚未加入',
      youAvatarSrc,
      themAvatarSrc,
      startDate: couple.startDate,
      days: daysBetween(couple.startDate),
      role: id.role,
      bound: !!couple.memberB,
      partnerWechatId: couple.partnerWechatId ?? '',
    })
  },

  onTapAvatar(e: WechatMiniprogram.TouchEvent) {
    const slot = e.currentTarget.dataset.slot as 'A' | 'B'
    void changeAvatarForSlot(slot, this.data.role).then(ok => {
      if (ok) void this.refresh()
    })
  },

  onSelectTheme(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.theme as ThemeId
    if (id !== 'lavender' && id !== 'peach' && id !== 'mint' && id !== 'sky') return
    this.setData({ themeId: id, themeLabel: themeLabel(id), themeStyle: setTheme(id) })
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
    wx.navigateTo({ url: '/subpages/anniversaries/anniversaries' })
  },

  onTapMap() {
    wx.navigateTo({ url: '/subpages/map/map' })
  },

  onTapBackup() {
    wx.navigateTo({ url: '/subpages/backup/backup' })
  },

})
