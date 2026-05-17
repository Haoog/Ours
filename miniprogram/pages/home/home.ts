// pages/home/home.ts —— 片头仪表盘

import {
  getCouple,
  getIdentity,
  daysBetween,
  listMomentsRecent,
  getCheckinState,
  addCheckin,
  getNextAnniversary,
} from '../../services/store'
import { ensureCloudReady, handleInviteQuery } from '../../services/page-boot'
import { pickMomentCover } from '../../utils/media-url'
import { getAppInstance } from '../../app'
import { formatSlate } from '../../services/format'
import { Moment, Mood } from '../../services/types'

interface RecentVO {
  id: string
  cover: string
  mediaTag: string
  caption: string
  md: string
  dow: string
  role: 'A' | 'B'
  authorLabel: string
}

interface MoodOption { key: Mood; name: string }

const MOODS: MoodOption[] = [
  { key: 'happy', name: '挺好' },
  { key: 'soft', name: '平静' },
  { key: 'low', name: '低落' },
  { key: 'rant', name: '想说' },
]

Page({
  data: {
    ready: false,
    bound: false,
    days: 0,
    youChecked: false,
    themChecked: false,
    bothToday: false,
    streak: 0,
    youLabel: '你',
    themLabel: 'TA',
    recent: [] as RecentVO[],
    hasRecent: false,
    checkinOpen: false,
    moodList: MOODS,
    moodSelected: 'happy' as Mood,
    noteDraft: '',
    nextAnn: null as { title: string; label: string } | null,
  },

  async onLoad(options: Record<string, string | undefined>) {
    await getAppInstance().waitBoot()
    await handleInviteQuery(options)
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async refresh() {
    const couple = getCouple()
    if (!couple) {
      this.setData({ ready: true, bound: false })
      return
    }

    try {
      const [checkinState, moments, nextAnn] = await Promise.all([
        getCheckinState(),
        listMomentsRecent(3),
        getNextAnniversary(),
      ])

      const myRole = getIdentity().role
      const partnerRole = myRole === 'A' ? 'B' : 'A'
      const checkins = checkinState.checkins
      const youChecked = checkins.some(c => c.role === myRole)
      const themChecked = checkins.some(c => c.role === partnerRole)
      const days = daysBetween(couple.startDate)

      const recent: RecentVO[] = await Promise.all(
        moments.slice(0, 3).map(async (m: Moment) => {
          const slate = formatSlate(m.createdAt)
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
        youChecked,
        themChecked,
        bothToday: checkinState.bothChecked,
        streak: checkinState.streakDays,
        youLabel: couple.memberA.nickname || '你',
        themLabel: couple.memberB?.nickname || '她',
        recent,
        hasRecent: recent.length > 0,
        nextAnn: nextAnn ? { title: nextAnn.title, label: nextAnn.label } : null,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ ready: true })
    }
  },

  onTapYou() {
    if (this.data.youChecked) {
      wx.showToast({ title: '你今天已签到', icon: 'none' })
      return
    }
    this.setData({ checkinOpen: true, noteDraft: '', moodSelected: 'happy' })
  },

  onTapThem() {
    if (!this.data.bound) {
      wx.navigateTo({ url: '/pages/bind/bind' })
      return
    }
    if (this.data.themChecked) {
      wx.showToast({ title: '她今天已签到', icon: 'none' })
      return
    }
    wx.showToast({ title: '等她打开小程序签到', icon: 'none' })
  },

  closeCheckin() {
    this.setData({ checkinOpen: false })
  },

  onPickMood(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as Mood
    this.setData({ moodSelected: key })
  },

  onNoteInput(e: WechatMiniprogram.Input) {
    this.setData({ noteDraft: e.detail.value })
  },

  async onSubmitCheckin() {
    try {
      await addCheckin({ mood: this.data.moodSelected, note: this.data.noteDraft })
      this.setData({ checkinOpen: false })
      wx.showToast({ title: '签到完成', icon: 'success' })
      await this.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '签到失败'
      wx.showToast({ title: msg, icon: 'none' })
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

  onTapStreak() {
    wx.navigateTo({ url: '/pages/checkin-history/checkin-history' })
  },

  onTapAnniversary() {
    wx.navigateTo({ url: '/pages/anniversaries/anniversaries' })
  },

})
