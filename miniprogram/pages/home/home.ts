// pages/home/home.ts —— 片头仪表盘

import {
  getCouple,
  getIdentity,
  daysBetween,
  listMomentsRecent,
  getNextAnniversary,
} from '../../services/store'
import { ensureCloudReady, handleInviteQuery } from '../../services/page-boot'
import { pickMomentCover } from '../../utils/media-url'
import { momentDisplayAt } from '../../utils/moment-time'
import { getAppInstance } from '../../app'
import { formatSlate } from '../../services/format'
import { Moment } from '../../services/types'

interface RecentVO {
  id: string
  cover: string
  mediaTag: string
  caption: string
  hasVideo: boolean
  md: string
  dow: string
  role: 'A' | 'B'
  authorLabel: string
}

Page({
  data: {
    ready: false,
    bound: false,
    days: 0,
    recent: [] as RecentVO[],
    hasRecent: false,
    recentLoaded: false,
    nextAnn: null as { title: string; label: string } | null,
  },

  async onLoad(options: Record<string, string | undefined>) {
    await getAppInstance().waitBoot()
    await handleInviteQuery(options)
  },

  async onShow() {
    this.renderOptimistic()
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async onPullDownRefresh() {
    await this.refresh()
    wx.stopPullDownRefresh()
  },

  /** 冷启动用本地持久化的会话即时出图，避免白屏；随后 refresh 拉最新覆盖 */
  renderOptimistic() {
    if (this.data.ready) return
    const couple = getCouple()
    if (!couple) return
    this.setData({
      ready: true,
      bound: !!couple.memberB,
      days: daysBetween(couple.startDate),
    })
  },

  async refresh() {
    const couple = getCouple()
    if (!couple) {
      this.setData({ ready: true, bound: false, recentLoaded: true })
      return
    }

    try {
      const [moments, nextAnn] = await Promise.all([listMomentsRecent(8), getNextAnniversary()])

      const identity = getIdentity()
      const myRole = identity.role
      const days = daysBetween(couple.startDate)

      const recent: RecentVO[] = await Promise.all(
        moments.map(async (m: Moment) => {
          const slate = formatSlate(momentDisplayAt(m))
          const cover = await pickMomentCover(m)
          const tags: string[] = []
          if (m.images.length) tags.push(`${m.images.length}图`)
          if (m.livePhotos?.length) tags.push(`${m.livePhotos.length}实况`)
          if (m.videos?.length) tags.push('视频')
          if (m.voices?.length) tags.push('语音')
          const mediaTag = !cover && tags.length ? tags.join('·') : tags.length > 1 ? tags.join('·') : ''
          const cap = (m.content || '').slice(0, 40) || (tags.length ? tags.join(' · ') : '')
          return {
            id: m.id,
            cover,
            mediaTag,
            caption: cap,
            hasVideo: (m.videos?.length ?? 0) > 0,
            md: slate.md,
            dow: slate.dow,
            role: m.authorRole,
            authorLabel: m.authorRole === myRole ? '我' : '她',
          }
        }),
      )

      this.setData({
        ready: true,
        bound: !!couple.memberB,
        days,
        recent,
        hasRecent: recent.length > 0,
        recentLoaded: true,
        nextAnn: nextAnn ? { title: nextAnn.title, label: nextAnn.label } : null,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ ready: true, recentLoaded: true })
    }
  },

  onTapMoments() {
    wx.switchTab({ url: '/pages/moments/moments' })
  },

  onTapMoment(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${id}` })
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },

  onTapBind() {
    wx.navigateTo({ url: '/pages/bind/bind' })
  },

  onTapAnniversary() {
    wx.navigateTo({ url: '/subpages/anniversaries/anniversaries' })
  },

})
