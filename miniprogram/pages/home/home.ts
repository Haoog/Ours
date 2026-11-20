// pages/home/home.ts —— 片头仪表盘

import {
  getCouple,
  getIdentity,
  daysBetween,
  listMomentsRecent,
  getNextAnniversary,
} from '../../services/store'
import { handleInviteQuery } from '../../services/page-boot'
import { pickMomentCover } from '../../utils/media-url'
import { momentDisplayAt } from '../../utils/moment-time'
import { getAppInstance } from '../../app'
import { formatSlate } from '../../services/format'
import { Moment } from '../../services/types'
import { getThemeStyle, syncTheme } from '../../services/theme'
import { captureCoupleWriteSession, getSession, syncSession } from '../../services/session'

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

interface HomeRequest {
  revision: number
  scope: string
  session: ReturnType<typeof captureCoupleWriteSession> | null
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

const emptyHomeContent = {
  ready: false,
  bound: false,
  days: 0,
  startDate: '',
  recent: [] as RecentVO[],
  hasRecent: false,
  recentLoaded: false,
  recentError: '',
  nextAnn: null as { title: string; label: string } | null,
  annError: false,
}

function getHomeScope(): string {
  const session = getSession?.()
  if (session?.status !== 'ready' || !session.openid || !session.coupleId) return ''
  return JSON.stringify([session.openid, session.coupleId, session.role])
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    ...emptyHomeContent,
    recentLoading: false,
    fabLeft: 0,
    fabTop: 0,
    fabDragging: false,
  },

  bootTask: null as Promise<void> | null,
  refreshTask: null as Promise<void> | null,
  refreshRevision: 0,
  pullRefreshTask: null as Promise<void> | null,
  accountScope: '',
  hasShown: false,
  readSession: null as HomeRequest['session'],

  onLoad(options: Record<string, string | undefined>) {
    syncTheme(this)
    this.syncFabPosition()
    this.bootTask = getAppInstance().waitBoot()
      .then(() => handleInviteQuery(options))
      .finally(() => { this.bootTask = null })
    return this.bootTask
  },

  onShow() {
    syncTheme(this)
    this.syncFabPosition()
    const forceSession = this.hasShown
    this.hasShown = true
    return this.refresh(forceSession)
  },

  onHide() {
    this.invalidateRefresh()
  },

  onUnload() {
    this.invalidateRefresh()
  },

  invalidateRefresh() {
    this.refreshRevision++
    this.refreshTask = null
    this.readSession = null
    this.finishPullRefresh()
  },

  onPullDownRefresh() {
    const pending = this.refresh(true)
    if (this.pullRefreshTask === pending) return pending
    this.pullRefreshTask = pending
    return pending.finally(() => {
      if (this.pullRefreshTask === pending) this.finishPullRefresh()
    })
  },

  finishPullRefresh() {
    if (!this.pullRefreshTask) return
    this.pullRefreshTask = null
    wx.stopPullDownRefresh()
  },

  /** 冷启动用本地持久化的会话即时出图，避免白屏；随后 refresh 拉最新覆盖 */
  renderOptimistic() {
    if (this.data.ready || !this.accountScope) return
    const couple = getCouple()
    if (!couple) return
    this.setData({
      ready: true,
      bound: !!couple.memberB,
      days: daysBetween(couple.startDate),
      startDate: couple.startDate,
    })
  },

  setHomeScope(scope: string) {
    if (scope === this.accountScope) return
    const resetContent = this.accountScope || this.data.recentError
    this.accountScope = scope
    if (resetContent) this.setData(emptyHomeContent)
  },

  acceptHomeResult({ revision, scope, session }: HomeRequest) {
    if (revision !== this.refreshRevision) return false
    const currentScope = getHomeScope()
    if (scope === currentScope && (!session || session.getCurrent())) return true
    this.invalidateRefresh()
    this.setHomeScope(currentScope)
    if (this.data.recentLoading) this.setData({ recentLoading: false })
    return false
  },

  refresh(forceSession = false) {
    const scope = getHomeScope()
    if (scope !== this.accountScope || (this.readSession && !this.readSession.getCurrent())) {
      this.invalidateRefresh()
      this.setHomeScope(scope)
    }
    if (!this.refreshTask) {
      this.renderOptimistic()
      this.readSession = null
      this.refreshTask = this.loadHome(++this.refreshRevision, forceSession)
    }
    return this.refreshTask
  },

  async loadHome(revision: number, forceSession: boolean) {
    this.setData({ recentLoading: true })
    try {
      await this.bootTask
      await getAppInstance()?.waitBoot()
      if (revision !== this.refreshRevision) return
      this.setHomeScope(getHomeScope())
      let sessionFailed = false
      const session = await syncSession(forceSession).catch(() => {
        sessionFailed = true
        return getSession()
      })
      if (revision !== this.refreshRevision) return
      const scope = getHomeScope()
      this.setHomeScope(scope)
      const inactive = session && !scope
      if (inactive && !sessionFailed) {
        this.setData({ ready: false, recentError: '' })
        wx.reLaunch({ url: '/pages/setup/setup' })
        return
      }
      const couple = getCouple()
      if (!couple || inactive) {
        this.setData({ ready: false, recentError: '连接失败，请重试' })
        return
      }

      this.setData({
        ready: true,
        bound: !!couple.memberB,
        days: daysBetween(couple.startDate),
        startDate: couple.startDate,
      })
      this.readSession = scope ? captureCoupleWriteSession() : null
      const request = { revision, scope, session: this.readSession }
      await Promise.all([this.loadRecent(request), this.loadNextAnniversary(request)])
    } catch {
      if (revision === this.refreshRevision) {
        this.setHomeScope(getHomeScope())
        this.setData({ recentError: '连接失败，请重试' })
      }
    } finally {
      if (revision === this.refreshRevision) {
        this.refreshTask = null
        this.setData({ recentLoading: false })
      }
    }
  },

  async loadNextAnniversary(request: HomeRequest) {
    try {
      const nextAnn = await getNextAnniversary()
      if (!this.acceptHomeResult(request)) return
      this.setData({ nextAnn: nextAnn ? { title: nextAnn.title, label: nextAnn.label } : null, annError: false })
    } catch {
      if (this.acceptHomeResult(request)) this.setData({ annError: true })
    }
  },

  async loadRecent(request: HomeRequest) {
    try {
      const moments = await listMomentsRecent(5)
      if (!this.acceptHomeResult(request)) return
      const myRole = getIdentity().role
      const recent: RecentVO[] = moments.map(m => {
        const slate = formatSlate(momentDisplayAt(m))
        const tags: string[] = []
        if (m.images.length) tags.push(`${m.images.length}图`)
        if (m.livePhotos?.length) tags.push(`${m.livePhotos.length}实况`)
        if (m.videos?.length) tags.push('视频')
        if (m.voices?.length) tags.push('语音')
        return {
          id: m.id,
          cover: '',
          mediaTag: tags.join('·'),
          caption: (m.content || '').slice(0, 40) || tags.join(' · '),
          hasVideo: (m.videos?.length ?? 0) > 0,
          md: slate.md,
          dow: slate.dow,
          role: m.authorRole,
          authorLabel: m.authorRole === myRole ? '我' : 'TA',
        }
      })
      this.setData({
        recent,
        hasRecent: recent.length > 0,
        recentLoaded: true,
        recentError: '',
      })
      for (const moment of moments) void this.loadRecentCover(moment, request)
    } catch (err) {
      if (!this.acceptHomeResult(request)) return
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ recentError: msg })
    }
  },

  async loadRecentCover(moment: Moment, request: HomeRequest) {
    const cover = await pickMomentCover(moment).catch(() => '')
    if (!this.acceptHomeResult(request) || !cover) return
    const index = this.data.recent.findIndex(item => item.id === moment.id)
    if (index >= 0) this.setData({ [`recent[${index}].cover`]: cover })
  },

  onRetryRecent() {
    return this.refresh(true)
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
    if (this.data.annError) return this.refresh()
    wx.navigateTo({ url: '/subpages/anniversaries/anniversaries' })
  },

})
