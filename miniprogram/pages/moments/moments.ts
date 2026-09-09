// pages/moments/moments.ts — 回忆 Tab（回忆 / 足迹 / 合辑 / 回顾）

import {
  listMomentsPage,
  MomentsPage,
  getIdentity,
  getCouple,
  getOnThisDayMoments,
  getMomentsStats,
  listMomentCollections,
  getMomentsBriefStats,
  listMapPlaces,
  toggleMomentLike,
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
import {
  consumeMomentsListStale,
  consumeMomentsScrollTop,
  saveMomentsScrollTop,
} from '../../services/moments-list-state'
import { feedCacheKey, takePrefetchedFeed } from '../../services/moments-feed-cache'

const PAGE_SIZE = 20

type ViewMode = 'timeline' | 'map' | 'collections' | 'recap'

type CollectionTagVO = {
  key: string
  label: string
  count: number
  percent: number
  icon: string
  tone: string
}

type CollectionPlaceVO = {
  name: string
  count: number
  percent: number
  rank: number
}

type CollectionsVO = {
  tags: CollectionTagVO[]
  places: CollectionPlaceVO[]
}

function collectionDecor(key: string): { icon: string; tone: string } {
  if (key === 'travel') return { icon: '↗', tone: 'travel' }
  if (key === 'rant') return { icon: '…', tone: 'rant' }
  if (key === 'daily') return { icon: '☼', tone: 'daily' }
  return { icon: '♡', tone: 'default' }
}

function mapMarkersFor(places: MapPlace[], selectedId = ''): any[] {
  return places.map((place, index) => {
    const selected = place.id === selectedId
    return {
      id: index + 1,
      latitude: place.latitude,
      longitude: place.longitude,
      title: place.name,
      width: selected ? 32 : 28,
      height: selected ? 32 : 28,
      label: {
        content: `♥ ${place.momentCount}`,
        color: selected ? '#FFFFFF' : '#6E62A8',
        fontSize: 11,
        borderWidth: 0,
        borderRadius: 12,
        bgColor: selected ? '#6E62A8' : '#FFFFFF',
        padding: 4,
        textAlign: 'center',
        anchorX: 0,
        anchorY: -28,
      },
      callout: {
        content: `${place.name} · ${place.momentCount} 条回忆`,
        color: '#4A4458',
        fontSize: 12,
        borderWidth: 1,
        borderRadius: 12,
        borderColor: '#E7E1F1',
        bgColor: '#FFFFFF',
        padding: 6,
        display: selected ? 'ALWAYS' : 'BYCLICK',
        textAlign: 'center',
      },
    }
  })
}

Page({
  data: {
    viewMode: 'timeline' as ViewMode,
    rows: [] as TimelineRow[],
    onThisDay: [] as SceneVO[],
    empty: true,
    loading: false,
    loadError: '',
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
      percentA: number
      percentB: number
    } | null,
    collectionTagTotal: 0,
    collectionPlaceTotal: 0,
    collections: { tags: [] as CollectionTagVO[], places: [] as CollectionPlaceVO[] } as CollectionsVO,
    mapEmpty: true,
    markers: [] as any[],
    places: [] as MapPlace[],
    cities: [] as MapCityStat[],
    centerLat: 31.23,
    centerLng: 121.47,
    mapScale: 10,
    mapPlaceCount: 0,
    mapMemoryCount: 0,
    mapCityCount: 0,
    selectedMapPlaceId: '',
    selectedMapPlace: null as MapPlace | null,
  },

  mapLoaded: false,
  collectionsLoaded: false,
  recapCache: {} as Record<
    string,
    {
      total: number
      countA: number
      countB: number
      placeCount: number
      topTag: string
      percentA: number
      percentB: number
    }
  >,

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const stale = consumeMomentsListStale()
    if (stale) this.invalidateSecondaryViews()
    if (stale || this.data.rows.length === 0) {
      await this.refresh()
      return
    }
    this.restoreScrollTop()
  },

  invalidateSecondaryViews() {
    this.mapLoaded = false
    this.collectionsLoaded = false
    this.recapCache = {}
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    saveMomentsScrollTop(e.scrollTop)
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
    if (mode === 'map') {
      if (!this.mapLoaded) this.loadMap()
    } else if (mode === 'collections') {
      if (!this.collectionsLoaded) this.loadCollections()
    } else if (mode === 'recap') {
      this.loadRecap()
    } else if (this.data.rows.length === 0) {
      this.refresh()
    }
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
      const key = feedCacheKey({
        tag: this.data.filterTag || '',
        keyword: this.data.searchActive ? this.data.searchKeyword : '',
      })
      const prefetched = await takePrefetchedFeed<MomentsPage>(key)
      const [page, onThisDayRaw, brief] = await Promise.all([
        prefetched ??
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
        loadError: '',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      this.setData({ loadError: msg })
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRetry() {
    this.refresh()
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
      this.mapLoaded = true
      if (!places.length) {
        this.setData({
          mapEmpty: true,
          places: [],
          cities: [],
          markers: [],
          mapPlaceCount: 0,
          mapMemoryCount: 0,
          mapCityCount: 0,
          selectedMapPlaceId: '',
          selectedMapPlace: null,
        })
        return
      }
      const selectedMapPlace = places[0]
      const mapMemoryCount = places.reduce((sum, place) => sum + place.momentCount, 0)
      const markers = mapMarkersFor(places, selectedMapPlace.id)
      this.setData({
        mapEmpty: false,
        places,
        cities,
        markers,
        centerLat: selectedMapPlace.latitude,
        centerLng: selectedMapPlace.longitude,
        mapScale: places.length === 1 ? 14 : 8,
        mapPlaceCount: places.length,
        mapMemoryCount,
        mapCityCount: cities.length,
        selectedMapPlaceId: selectedMapPlace.id,
        selectedMapPlace,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '地图加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onMapMarkerTap(e: any) {
    const idx = (e.detail.markerId as number) - 1
    const p = this.data.places[idx]
    if (!p) return
    this.setData({
      selectedMapPlaceId: p.id,
      selectedMapPlace: p,
      markers: mapMarkersFor(this.data.places, p.id),
      centerLat: p.latitude,
      centerLng: p.longitude,
    })
  },

  onTapMapPlace(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    const p = this.data.places.find(place => place.id === id)
    if (!p) return
    this.setData({
      selectedMapPlaceId: id,
      selectedMapPlace: p,
      markers: mapMarkersFor(this.data.places, id),
      centerLat: p.latitude,
      centerLng: p.longitude,
    })
  },

  onTapMapStory() {
    const momentId = this.data.selectedMapPlace?.latestMomentId
    if (!momentId) return
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${momentId}` })
  },

  async loadCollections() {
    try {
      const raw = await listMomentCollections()
      const tagMax = Math.max(1, ...raw.tags.map(item => item.count))
      const placeMax = Math.max(1, ...raw.places.map(item => item.count))
      const collections: CollectionsVO = {
        tags: raw.tags.map(item => ({
          ...item,
          ...collectionDecor(item.key),
          percent: Math.max(12, Math.round((item.count / tagMax) * 100)),
        })),
        places: raw.places.map((item, index) => ({
          ...item,
          rank: index + 1,
          percent: Math.max(12, Math.round((item.count / placeMax) * 100)),
        })),
      }
      this.collectionsLoaded = true
      this.setData({
        collections,
        collectionTagTotal: collections.tags.reduce((sum, item) => sum + item.count, 0),
        collectionPlaceTotal: collections.places.reduce((sum, item) => sum + item.count, 0),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '合辑加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async loadRecap() {
    const key = `${this.data.recapYear}-${this.data.recapMonth}`
    const cached = this.recapCache[key]
    if (cached) {
      this.setData({ recapStats: cached })
      return
    }
    try {
      const stats = await getMomentsStats(this.data.recapYear, this.data.recapMonth)
      const total = Math.max(0, stats.total)
      const percentA = total > 0 ? Math.min(100, Math.round((stats.countA / total) * 100)) : 0
      const vo = {
        total,
        countA: stats.countA,
        countB: stats.countB,
        placeCount: stats.placeCount,
        topTag: stats.topTag ? tagLabel(stats.topTag as MomentTag) : '—',
        percentA,
        percentB: total > 0 ? Math.max(0, 100 - percentA) : 0,
      }
      this.recapCache[key] = vo
      this.setData({ recapStats: vo })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回顾加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  restoreScrollTop() {
    const scrollTop = consumeMomentsScrollTop()
    if (scrollTop <= 0) return
    setTimeout(() => {
      wx.pageScrollTo({ scrollTop, duration: 0 })
    }, 0)
  },

  onTapScene(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const tag = this.data.filterTag || ''
    const q = tag ? `&tag=${tag}` : ''
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${id}${q}` })
  },

  async onToggleSceneLike(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const index = Number(e.currentTarget.dataset.index)
    const row = this.data.rows[index]
    if (!row || row.type !== 'moment' || row.scene.id !== id) return
    const prevLiked = row.scene.likedByMe
    const prevCount = row.scene.likeCount
    const nextLiked = !prevLiked
    this.setData({
      [`rows[${index}].scene.likedByMe`]: nextLiked,
      [`rows[${index}].scene.likeCount`]: Math.max(0, prevCount + (nextLiked ? 1 : -1)),
    })
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await toggleMomentLike(id)
      const liked = getIdentity().role === 'A' ? likes.likedByA : likes.likedByB
      this.setData({
        [`rows[${index}].scene.likedByMe`]: liked,
        [`rows[${index}].scene.likeCount`]: likes.count,
      })
    } catch (err) {
      this.setData({
        [`rows[${index}].scene.likedByMe`]: prevLiked,
        [`rows[${index}].scene.likeCount`]: prevCount,
      })
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },
})
