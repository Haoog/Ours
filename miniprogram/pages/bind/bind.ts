// pages/bind/bind.ts —— 邀请 TA

import { getCouple, getRelationshipMembers, createPartnerInvite } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'

Page({
  data: {
    youName: '你',
    themName: 'TA',
    startDate: '',
    partnerHint: '',
    coupleId: '',
    inviteReady: false,
  },

  async onLoad() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
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
    if (!c.memberB) {
      try {
        await this.prepareInvite()
      } catch (err) {
        const msg = err instanceof Error ? err.message : '邀请链接生成失败'
        wx.showToast({ title: msg, icon: 'none' })
      }
    }
  },

  async prepareInvite() {
    const invite = await createPartnerInvite()
    this.setData({ inviteReady: true })
    this.inviteToken = invite.token
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
