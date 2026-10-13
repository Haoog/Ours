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
import { getThemeStyle, syncTheme } from '../../services/theme'
import { syncSession } from '../../services/session'

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

interface FabPosition {
  left: number
  top: number
}

interface FabDragState extends FabPosition {
  startX: number
  startY: number
  originLeft: number
  originTop: number
  moved: boolean
}

const FAB_POSITION_KEY = 'OURS_HOME_FAB_POSITION_V1'
const FAB_SIZE_RPX = 108
const FAB_EDGE_RPX = 36
const FAB_BOTTOM_RPX = 48
const FAB_DRAG_THRESHOLD_PX = 6
const fabDragStates = new WeakMap<object, FabDragState>()

function fabTouchPoint(e: WechatMiniprogram.TouchEvent): { x: number; y: number } | null {
  const touch = e.touches[0] ?? e.changedTouches[0]
  if (!touch) return null
  return { x: touch.clientX, y: touch.clientY }
}

function fabViewport() {
  const info = wx.getSystemInfoSync()
  const rpx = info.windowWidth / 750
  const safeBottom = Math.max(0, info.windowHeight - (info.safeArea?.bottom ?? info.windowHeight))
  return {
    width: info.windowWidth,
    height: info.windowHeight,
    size: FAB_SIZE_RPX * rpx,
    edge: FAB_EDGE_RPX * rpx,
    bottom: FAB_BOTTOM_RPX * rpx + safeBottom,
  }
}

function clampFabPosition(position: FabPosition): FabPosition {
  const viewport = fabViewport()
  const maxLeft = Math.max(viewport.edge, viewport.width - viewport.size - viewport.edge)
  const maxTop = Math.max(viewport.edge, viewport.height - viewport.size - viewport.bottom)
  return {
    left: Math.min(Math.max(position.left, viewport.edge), maxLeft),
    top: Math.min(Math.max(position.top, viewport.edge), maxTop),
  }
}

function readFabPosition(): FabPosition | null {
  try {
    const stored = wx.getStorageSync(FAB_POSITION_KEY) as Partial<FabPosition> | null
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      return clampFabPosition({ left: Number(stored.left), top: Number(stored.top) })
    }
  } catch {
    /* use the default position */
  }
  return null
}

function initialFabPosition(): FabPosition {
  const viewport = fabViewport()
  return clampFabPosition({
    left: viewport.width - viewport.size - viewport.edge,
    top: viewport.height - viewport.size - viewport.bottom,
  })
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    ready: false,
    bound: false,
    days: 0,
    startDate: '',
    recent: [] as RecentVO[],
    hasRecent: false,
    recentLoaded: false,
    nextAnn: null as { title: string; label: string } | null,
    fabLeft: 0,
    fabTop: 0,
    fabDragging: false,
  },

  async onLoad(options: Record<string, string | undefined>) {
    syncTheme(this)
    this.syncFabPosition()
    await getAppInstance().waitBoot()
    await handleInviteQuery(options)
  },

  async onShow() {
    syncTheme(this)
    this.syncFabPosition()
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
      startDate: couple.startDate,
    })
  },

  async refresh() {
    await syncSession().catch(() => undefined)
    const couple = getCouple()
    if (!couple) {
      this.setData({ ready: true, bound: false, recentLoaded: true })
      return
    }

    try {
      const moments = await listMomentsRecent(5)
      void getNextAnniversary().then(nextAnn => {
        this.setData({ nextAnn: nextAnn ? { title: nextAnn.title, label: nextAnn.label } : null })
      }).catch(() => undefined)

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
            authorLabel: m.authorRole === myRole ? '我' : 'TA',
          }
        }),
      )

      this.setData({
        ready: true,
        bound: !!couple.memberB,
        days,
        startDate: couple.startDate,
        recent,
        hasRecent: recent.length > 0,
        recentLoaded: true,
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

  syncFabPosition() {
    const position = readFabPosition() ?? initialFabPosition()
    this.setData({ fabLeft: position.left, fabTop: position.top })
  },

  onFabTouchStart(e: WechatMiniprogram.TouchEvent) {
    const point = fabTouchPoint(e)
    if (!point) return
    fabDragStates.set(this, {
      startX: point.x,
      startY: point.y,
      originLeft: this.data.fabLeft,
      originTop: this.data.fabTop,
      left: this.data.fabLeft,
      top: this.data.fabTop,
      moved: false,
    })
  },

  onFabTouchMove(e: WechatMiniprogram.TouchEvent) {
    const state = fabDragStates.get(this)
    const point = fabTouchPoint(e)
    if (!state || !point) return

    const dx = point.x - state.startX
    const dy = point.y - state.startY
    if (!state.moved && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD_PX) return
    state.moved = true
    const position = clampFabPosition({
      left: state.originLeft + dx,
      top: state.originTop + dy,
    })
    state.left = position.left
    state.top = position.top
    this.setData({ fabLeft: position.left, fabTop: position.top, fabDragging: true })
  },

  onFabTouchEnd() {
    const state = fabDragStates.get(this)
    if (!state) return
    fabDragStates.delete(this)
    if (state.moved) {
      try {
        wx.setStorageSync(FAB_POSITION_KEY, { left: state.left, top: state.top })
      } catch {
        /* ignore */
      }
      this.setData({ fabDragging: false })
      return
    }
    this.setData({ fabDragging: false })
    this.onTapCompose()
  },

  onFabTouchCancel() {
    fabDragStates.delete(this)
    this.setData({ fabDragging: false })
  },

  onTapBind() {
    wx.navigateTo({ url: '/pages/bind/bind' })
  },

  onTapAnniversary() {
    wx.navigateTo({ url: '/subpages/anniversaries/anniversaries' })
  },

})
