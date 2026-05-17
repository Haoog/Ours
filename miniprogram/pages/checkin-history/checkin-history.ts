// pages/checkin-history/checkin-history.ts — 月度签到日历

import { listCheckins, getIdentity } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { Checkin, Mood } from '../../services/types'

const MOOD_LABEL: Record<Mood, string> = {
  happy: '挺好',
  soft: '平静',
  low: '低落',
  rant: '想说',
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

interface DayCell {
  empty?: boolean
  day?: number
  dateKey?: string
  status: 'none' | 'me' | 'partner' | 'both'
}

interface DayDetail {
  dateKey: string
  label: string
  lines: string[]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function monthTitle(year: number, month: number): string {
  return `${year} 年 ${month} 月`
}

Page({
  data: {
    year: 0,
    month: 0,
    title: '',
    weekdays: WEEKDAYS,
    cells: [] as DayCell[],
    bothCount: 0,
    meCount: 0,
    detailOpen: false,
    detail: null as DayDetail | null,
  },

  checkins: [] as Checkin[],
  myRole: 'A' as 'A' | 'B',

  async onLoad() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const id = getIdentity()
    this.myRole = id.role
    const now = new Date()
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 })
    await this.loadMonth()
  },

  async loadMonth() {
    const { year, month } = this.data
    wx.showNavigationBarLoading()
    try {
      this.checkins = await listCheckins(year, month)
      const built = this.buildCalendar(year, month, this.checkins)
      this.setData({
        title: monthTitle(year, month),
        cells: built.cells,
        bothCount: built.bothCount,
        meCount: built.meCount,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      wx.hideNavigationBarLoading()
    }
  },

  buildCalendar(year: number, month: number, checkins: Checkin[]) {
    const byDate = new Map<string, { A?: Checkin; B?: Checkin }>()
    for (const c of checkins) {
      if (!byDate.has(c.date)) byDate.set(c.date, {})
      const slot = byDate.get(c.date)!
      if (c.role === 'A') slot.A = c
      else slot.B = c
    }

    const partnerRole = this.myRole === 'A' ? 'B' : 'A'
    const first = new Date(year, month - 1, 1)
    const lastDay = new Date(year, month, 0).getDate()
    const cells: DayCell[] = []

    for (let i = 0; i < first.getDay(); i++) {
      cells.push({ empty: true, status: 'none' })
    }

    let bothCount = 0
    let meCount = 0

    for (let d = 1; d <= lastDay; d++) {
      const dateKey = `${year}-${pad2(month)}-${pad2(d)}`
      const slot = byDate.get(dateKey)
      const me = slot?.[this.myRole]
      const partner = slot?.[partnerRole]
      let status: DayCell['status'] = 'none'
      if (me && partner) {
        status = 'both'
        bothCount += 1
      } else if (me) {
        status = 'me'
        meCount += 1
      } else if (partner) {
        status = 'partner'
      }
      cells.push({ day: d, dateKey, status })
    }

    return { cells, bothCount, meCount }
  },

  onPrevMonth() {
    let { year, month } = this.data
    month -= 1
    if (month < 1) {
      month = 12
      year -= 1
    }
    this.setData({ year, month })
    this.loadMonth()
  },

  onNextMonth() {
    let { year, month } = this.data
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    this.setData({ year, month })
    this.loadMonth()
  },

  onTapDay(e: WechatMiniprogram.BaseEvent) {
    const dateKey = e.currentTarget.dataset.date as string
    if (!dateKey) return

    const dayCheckins = this.checkins.filter(c => c.date === dateKey)
    if (dayCheckins.length === 0) {
      wx.showToast({ title: '这天还没有签到', icon: 'none' })
      return
    }

    const lines = dayCheckins.map(c => {
      const who = c.role === this.myRole ? '我' : '她'
      const mood = c.mood ? MOOD_LABEL[c.mood] : '未选心情'
      const note = c.note ? `：${c.note}` : ''
      return `${who} · ${mood}${note}`
    })

    const [, m, d] = dateKey.split('-')
    this.setData({
      detailOpen: true,
      detail: {
        dateKey,
        label: `${Number(m)} 月 ${Number(d)} 日`,
        lines,
      },
    })
  },

  closeDetail() {
    this.setData({ detailOpen: false, detail: null })
  },
})
