// pages/bind/bind.ts —— 邀请 TA

import { getCouple, getRelationshipMembers, createPartnerInvite } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { getThemeStyle, syncTheme } from '../../services/theme'

Page({
  data: {
    themeStyle: getThemeStyle(),
    youName: '你',
    themName: 'TA',
    startDate: '',
    partnerHint: '',
    coupleId: '',
    inviteReady: false,
    inviteLoading: false,
    inviteError: '',
  },

  async onLoad() {
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) {
      this.setData({ inviteError: '连接失败，请重试' })
      return
    }
    const c = getCouple()
    if (!c) return
    const { me, partner } = getRelationshipMembers()
    this.setData({
      youName: me.nickname,
      themName: partner?.nickname ?? '她',
      startDate: c.startDate,
      partnerHint: c.partnerWechatId ?? '',
      coupleId: c.id,
    })
    if (!c.memberB) await this.prepareInvite()
  },

  async prepareInvite() {
    if (this.data.inviteLoading || this.data.inviteReady) return
    this.setData({ inviteLoading: true, inviteError: '' })
    try {
      if (!(await ensureCloudReady())) throw new Error('连接失败，请重试')
      const c = getCouple()
      if (!c || c.memberB) throw new Error('空间不可邀请，请返回后重试')
      const { me, partner } = getRelationshipMembers()
      this.setData({ youName: me.nickname, themName: partner?.nickname ?? '她', startDate: c.startDate, partnerHint: c.partnerWechatId ?? '', coupleId: c.id })
      const invite = await createPartnerInvite()
      this.inviteToken = invite.token
      this.setData({ inviteReady: true })
    } catch (err) {
      this.setData({ inviteError: err instanceof Error ? err.message : '邀请链接生成失败，请重试' })
    } finally {
      this.setData({ inviteLoading: false })
    }
  },

  inviteToken: '',

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const c = getCouple()
    if (!this.inviteToken) {
      wx.showToast({ title: '邀请链接还在生成，请稍后再试', icon: 'none' })
    }
    return {
      title: `${getRelationshipMembers().me.nickname ?? '我'} 邀请你一起写「Ours」`,
      path: this.inviteToken
        ? `/pages/home/home?inviteToken=${this.inviteToken}`
        : '/pages/setup/setup',
    }
  },
})
