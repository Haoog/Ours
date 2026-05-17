// pages/moments/moments.ts — 回忆 Tab（三阶段：时间轴 / 地图 / 合辑 / 回顾）

import {
  listMomentsPage,
  getIdentity,
  getCouple,
  getOnThisDayMoments,
  getMomentsStats,
  listMomentCollections,
  getMomentsBriefStats,
  listMapPlaces,
} from '../../services/store'
import { MOMENT_TAG_FILTERS, tagLabel } from '../../utils/tags'
import { MomentTag } from '../../services/types'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import {
  buildTimelineRows,
  scenesFromMoments,
  SceneVO,
  TimelineRow,
} from '../../utils/moments-timeline'
import { MapPlace, MapCityStat } from '../../services/types'

const PAGE_SIZE = 20

type ViewMode = 'timeline' | 'map' | 'collections' | 'recap'

Page({
  data: {
    viewMode: 'timeline' as ViewMode,
    rows: [] as TimelineRow[],
    onThisDay: [] as SceneVO[],
    empty: true,
    loading: false,
    loadingMore: false,
    hasMore: true,
    skip: 0,
    total: 0,
    filterTag: '' as MomentTag | '',
    tagFilters: MOMENT_TAG_FILTERS,
    searchKeyword: '',
    searchActive: false,
    briefStats: { total: 0, countA: 0, countB: 0 },
    recapYear: new Date().getFullYear(),
    recapMonth: new Date().getMonth() + 1,
    recapMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    recapStats: null as {
      total: number
      countA: number
      countB: number
      placeCount: number
      topTag: string
    } | null,
    collections: { tags: [] as { key: string; label: string; count: number }[], places: [] as { name: string; count: number }[] },
    mapEmpty: true,
    markers: [] as WechatMiniprogram.MapMarker[],
    places: [] as MapPlace[],
    cities: [] as MapCityStat[],
    centerLat: 31.23,
    centerLng: 121.47,
    mapScale: 10,
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async onPullDownRefresh() {
    await this.refresh()
    wx.stopPullDownRefresh()
  },

  async onReachBottom() {
    if (this.data.viewMode !== 'timeline') return
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    await this.loadMore()
  },

  onSwitchView(e: WechatMiniprogram.BaseEvent) {
    const mode = (e.currentTarget.dataset.mode ?? 'timeline') as ViewMode
    if (mode === this.data.viewMode) return
    this.setData({ viewMode: mode })
    if (mode === 'map') this.loadMap()
    else if (mode === 'collections') this.loadCollections()
    else if (mode === 'recap') this.loadRecap()
    else this.refresh()
  },

  onPickFilter(e: WechatMiniprogram.BaseEvent) {
    const filterTag = (e.currentTarget.dataset.key ?? '') as MomentTag | ''
    this.setData({ filterTag, searchActive: false, searchKeyword: '' })
    this.refresh()
  },

  onSearchInput(e: WechatMiniprogram.Input) {
    this.setData({ searchKeyword: e.detail.value })
  },

  onSearchConfirm() {
    const kw = this.data.searchKeyword.trim()
    this.setData({ searchActive: Boolean(kw) })
    this.refresh()
  },

  onClearSearch() {
    this.setData({ searchKeyword: '', searchActive: false })
    this.refresh()
  },

  onRecapMonthTap(e: WechatMiniprogram.BaseEvent) {
    const month = Number(e.currentTarget.dataset.month)
    this.setData({ recapMonth: month })
    this.loadRecap()
  },

  onTapCollectionTag(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as string
    this.setData({ filterTag: key as MomentTag, viewMode: 'timeline', searchActive: false })
    this.refresh()
  },

  onTapCollectionPlace(e: WechatMiniprogram.BaseEvent) {
    const name = e.currentTarget.dataset.name as string
    wx.showToast({ title: `地点「${name}」可在时间轴中查看`, icon: 'none' })
    this.setData({ viewMode: 'timeline' })
    this.refresh()
  },

  coupleStartDate(): string {
    return getCouple()?.startDate ?? new Date().toISOString().slice(0, 10)
  },

  async refresh() {
    this.setData({ loading: true })
    try {
      const myRole = getIdentity().role
      const [page, onThisDayRaw, brief] = await Promise.all([
        listMomentsPage({
          limit: PAGE_SIZE,
          skip: 0,
          tag: this.data.filterTag || undefined,
          keyword: this.data.searchActive ? this.data.searchKeyword : undefined,
        }),
        this.data.searchActive ? Promise.resolve([]) : getOnThisDayMoments(),
        getMomentsBriefStats().catch(() => ({ total: 0, countA: 0, countB: 0 })),
      ])
      const onThisDay = scenesFromMoments(onThisDayRaw, onThisDayRaw.length, 0, myRole)
      const rows = buildTimelineRows(page.items, page.total, 0, myRole, this.coupleStartDate())
      this.setData({
        rows,
        onThisDay,
        empty: rows.length === 0,
        hasMore: page.hasMore,
        skip: page.items.length,
        total: page.total,
        briefStats: brief,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadMore() {
    this.setData({ loadingMore: true })
    try {
      const myRole = getIdentity().role
      const page = await listMomentsPage({
        limit: PAGE_SIZE,
        skip: this.data.skip,
        tag: this.data.filterTag || undefined,
        keyword: this.data.searchActive ? this.data.searchKeyword : undefined,
      })
      const moreRows = buildTimelineRows(
        page.items,
        this.data.total,
        this.data.skip,
        myRole,
        this.coupleStartDate(),
      )
      this.setData({
        rows: [...this.data.rows, ...moreRows],
        hasMore: page.hasMore,
        skip: this.data.skip + page.items.length,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载更多失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  async loadMap() {
    try {
      const { places, cities } = await listMapPlaces()
      if (!places.length) {
        this.setData({ mapEmpty: true, places: [], cities: [], markers: [] })
        return
      }
      const markers: WechatMiniprogram.MapMarker[] = places.map((p, i) => ({
        id: i + 1,
        latitude: p.latitude,
        longitude: p.longitude,
        title: p.name,
        width: 28,
        height: 28,
      }))
      this.setData({
        mapEmpty: false,
        places,
        cities,
        markers,
        centerLat: places[0].latitude,
        centerLng: places[0].longitude,
        mapScale: places.length === 1 ? 14 : 8,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '地图加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onMapMarkerTap(e: WechatMiniprogram.MapMarkerTap) {
    const idx = (e.detail.markerId as number) - 1
    const p = this.data.places[idx]
    if (!p) return
    wx.showModal({
      title: p.name,
      content: `${p.address || ''}\n关联 ${p.momentCount} 条动态`,
      showCancel: false,
    })
  },

  async loadCollections() {
    try {
      const collections = await listMomentCollections()
      this.setData({ collections })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合辑加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async loadRecap() {
    try {
      const stats = await getMomentsStats(this.data.recapYear, this.data.recapMonth)
      this.setData({
        recapStats: {
          total: stats.total,
          countA: stats.countA,
          countB: stats.countB,
          placeCount: stats.placeCount,
          topTag: stats.topTag ? tagLabel(stats.topTag as MomentTag) : '—',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回顾加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onTapScene(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const tag = this.data.filterTag || ''
    const q = tag ? `&tag=${tag}` : ''
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${id}${q}` })
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },
})
