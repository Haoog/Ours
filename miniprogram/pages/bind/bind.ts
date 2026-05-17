// pages/bind/bind.ts —— 邀请 TA

import { getCouple } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { PARTNER_WECHAT_ID } from '../../config/env'
import { getAppInstance } from '../../app'

Page({
  data: {
    youName: '你',
    themName: 'TA',
    startDate: '',
    partnerHint: PARTNER_WECHAT_ID,
    coupleId: '',
  },

  async onLoad() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const c = getCouple()
    if (!c) return
    this.setData({
      youName: c.memberA.nickname,
      themName: c.memberB?.nickname ?? '她',
      startDate: c.startDate,
      coupleId: c.id,
    })
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const c = getCouple()
    return {
      title: `${c?.memberA.nickname ?? '我'} 邀请你一起写「Ours」`,
      path: `/pages/home/home?inviteFrom=${c?.id ?? ''}`,
    }
  },
})
