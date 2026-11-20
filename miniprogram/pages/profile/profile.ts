// pages/profile/profile.ts —— 我们

import {
  getCouple,
  getIdentity,
  getRelationshipMembers,
  updateStartDate,
  updateProfile,
  uploadAvatar,
  daysBetween,
} from '../../services/store'
import { toDisplayUrl } from '../../utils/media-url'
import { pickLocalAvatar } from '../../utils/avatar'
import { getAppInstance } from '../../app'
import { getThemeId, getThemeStyle, setTheme, syncTheme, THEME_OPTIONS, ThemeId } from '../../services/theme'
import { getSession, syncSession } from '../../services/session'

const emptyProfile = {
  youName: '你',
  themName: 'TA',
  youAvatarSrc: '',
  themAvatarSrc: '',
  startDate: '',
  days: 0,
  role: 'A' as 'A' | 'B',
  bound: false,
  partnerWechatId: '',
}

function getProfileScope(): string {
  const session = getSession()
  if (session?.status !== 'ready' || !session.openid || !session.coupleId) return ''
  return JSON.stringify([session.openid, session.coupleId, session.role])
}

function themeLabel(id: ThemeId): string {
  if (id === 'peach') return '暖杏'
  if (id === 'mint') return '薄荷'
  if (id === 'sky') return '天蓝'
  return '淡紫'
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    ...emptyProfile,
    themeId: getThemeId() as ThemeId,
    themeLabel: themeLabel(getThemeId() as ThemeId),
    themes: THEME_OPTIONS,
    profileError: '',
    avatarSaving: false,
    avatarRetry: false,
  },

  refreshVersion: 0,
  editVersion: 0,
  visible: false,
  displayedScope: '',
  profileOffline: false,
  writeQueue: null as Promise<void> | null,
  avatarDraft: null as { path: string; fileID: string; isCurrent: () => boolean } | null,

  onShow() {
    this.visible = true
    syncTheme(this)
    if (this.data.avatarSaving || this.data.avatarRetry) {
      this.setData({ avatarSaving: false, avatarRetry: false })
    }
    return this.refresh(true)
  },

  onHide() {
    this.visible = false
    this.refreshVersion++
    this.editVersion++
    this.avatarDraft = null
  },

  onUnload() {
    this.onHide()
  },

  clearOtherAccountProfile(scope: string) {
    if (this.displayedScope && this.displayedScope !== scope) {
      this.displayedScope = ''
      this.setData(emptyProfile)
    }
  },

  onRetryProfile() {
    return this.refresh(true)
  },

  async refresh(checkCloudReady = false) {
    if (!this.visible) return
    const version = ++this.refreshVersion
    this.clearOtherAccountProfile(getProfileScope())
    if (checkCloudReady) {
      await getAppInstance().waitBoot()
      if (version !== this.refreshVersion) return
      const online = await syncSession(true).then(() => true, () => false)
      if (version !== this.refreshVersion) return
      this.profileOffline = !online
    }

    const scope = getProfileScope()
    this.clearOtherAccountProfile(scope)
    const couple = getCouple()
    if (!scope || !couple) {
      if (checkCloudReady && !this.profileOffline) wx.reLaunch({ url: '/pages/setup/setup' })
      else this.setData({ profileError: '暂时连不上，点击重试' })
      return
    }
    const id = getIdentity()
    const { me, partner } = getRelationshipMembers()
    const profile = {
      youName: me.nickname,
      themName: partner?.nickname ?? '尚未加入',
      startDate: couple.startDate,
      days: daysBetween(couple.startDate),
      role: id.role,
      bound: !!couple.memberB,
      partnerWechatId: couple.partnerWechatId ?? '',
    }
    const [youAvatarSrc, themAvatarSrc] = await Promise.all([
      toDisplayUrl(me.avatarUrl).catch(() => ''),
      toDisplayUrl(partner?.avatarUrl ?? '').catch(() => ''),
    ])
    if (version !== this.refreshVersion) return
    const currentScope = getProfileScope()
    this.clearOtherAccountProfile(currentScope)
    if (scope !== currentScope) return
    this.displayedScope = scope
    const avatarFailed = (me.avatarUrl && !youAvatarSrc) || (partner?.avatarUrl && !themAvatarSrc)
    const profileError = this.profileOffline ? '资料更新失败，点击重试'
      : avatarFailed ? '头像加载失败，点击重试' : ''
    this.setData({ ...profile, youAvatarSrc, themAvatarSrc, profileError })
  },

  captureEdit() {
    const scope = getProfileScope()
    const version = this.editVersion
    return () => this.visible && version === this.editVersion && !!scope && scope === getProfileScope()
  },

  queueWrite(write: () => Promise<void>) {
    // 头像写入会携带当前昵称，等前面的昵称写入应答后再读取它。
    const pending = (this.writeQueue ?? Promise.resolve()).then(write)
    this.writeQueue = pending.catch(() => undefined)
    return pending
  },

  async onTapAvatar(e: WechatMiniprogram.TouchEvent) {
    const isCurrent = this.captureEdit()
    if (!isCurrent() || this.data.avatarSaving) return
    if (e.currentTarget.dataset.slot !== getIdentity().role) {
      wx.showToast({ title: '只能更换自己的头像', icon: 'none' })
      return
    }
    let path: string
    try {
      path = await pickLocalAvatar()
    } catch (err) {
      if (isCurrent() && !(err instanceof Error && err.message === 'cancel')) {
        wx.showToast({ title: '未能选择头像，请重试', icon: 'none' })
      }
      return
    }
    if (!isCurrent() || this.data.avatarSaving) return
    this.avatarDraft = { path, fileID: '', isCurrent }
    return this.onRetryAvatar()
  },

  async onRetryAvatar() {
    const draft = this.avatarDraft
    if (!draft || this.data.avatarSaving) return
    if (!draft.isCurrent()) {
      this.avatarDraft = null
      this.setData({ avatarRetry: false })
      return
    }
    this.setData({ avatarSaving: true, avatarRetry: false })
    try {
      await this.queueWrite(async () => {
        if (!draft.isCurrent()) return
        if (!draft.fileID) draft.fileID = await uploadAvatar(draft.path)
        if (!draft.isCurrent()) return
        await updateProfile({ nickname: getIdentity().nickname, avatarUrl: draft.fileID })
      })
      if (!draft.isCurrent()) return
      this.avatarDraft = null
      this.setData({ avatarSaving: false })
      wx.showToast({ title: '头像已更新', icon: 'success' })
      await this.refresh()
    } catch {
      if (draft.isCurrent()) this.setData({ avatarRetry: true })
    } finally {
      if (this.avatarDraft === draft) {
        const current = draft.isCurrent()
        if (!current) this.avatarDraft = null
        this.setData({ avatarSaving: false, avatarRetry: current && this.data.avatarRetry })
      }
    }
  },

  onSelectTheme(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.theme as ThemeId
    if (id !== 'lavender' && id !== 'peach' && id !== 'mint' && id !== 'sky') return
    this.setData({ themeId: id, themeLabel: themeLabel(id), themeStyle: setTheme(id) })
  },

  async saveProfileEdit(isCurrent: () => boolean, write: () => Promise<unknown>) {
    try {
      await this.queueWrite(async () => {
        if (isCurrent()) await write()
      })
      if (!isCurrent()) return
      wx.showToast({ title: '已更新', icon: 'success' })
      await this.refresh()
    } catch (err) {
      if (!isCurrent()) return
      const msg = err instanceof Error ? err.message : '更新失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onEditNickname() {
    const isCurrent = this.captureEdit()
    if (!isCurrent()) return
    const { nickname } = getIdentity()
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '你的昵称',
      content: nickname,
      success: res => {
        if (!isCurrent() || !res.confirm || !res.content) return
        const nickname = res.content.trim()
        if (nickname) return this.saveProfileEdit(isCurrent, () => updateProfile({ nickname }))
      },
    })
  },

  onPickStartDate(e: WechatMiniprogram.PickerChange) {
    const isCurrent = this.captureEdit()
    const next = String(e.detail.value)
    if (!isCurrent() || !next || next === this.data.startDate) return
    wx.showModal({
      title: '修改开始日期？',
      content: '会重新计算「在一起的第 N 天」。',
      confirmText: '改',
      cancelText: '不改',
      success: res => {
        if (isCurrent() && res.confirm) return this.saveProfileEdit(isCurrent, () => updateStartDate(next))
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
