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
  setMomentLike,
} from '../../services/store'
import { MOMENT_TAG_FILTERS, tagLabel } from '../../utils/tags'
import { Moment, MomentTag } from '../../services/types'
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
import { getThemeStyle, getThemeId, syncTheme } from '../../services/theme'
import { takeMomentsContext } from '../../services/moments-list-state'

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

Page({
  data: {
    themeStyle: getThemeStyle(),
    themeId: getThemeId(),
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
    locationName: '',
    locationKey: '',
    dateYear: 0,
    dateMonth: 0,
    contextLabel: '',
    expandedTexts: {} as Record<string, boolean>,
    recapYears: [] as number[],
    myRole: 'A' as 'A' | 'B',
    recapMemories: [] as SceneVO[],
    recapLoading: false,
    secondaryError: '',
    secondaryLoading: false,
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
    places: [] as MapPlace[],
    cities: [] as MapCityStat[],
    mapPlaceCount: 0,
    mapMemoryCount: 0,
    mapCityCount: 0,
    selectedMapPlaceId: '',
    selectedMapPlace: null as MapPlace | null,
  },

  mapLoaded: false,
  feedRevision: 0,
  recapRevision: 0,
  rawMoments: [] as Moment[],
  lastRefreshedAt: 0,
  likePending: new Set<string>(),
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
    syncTheme(this)
    this.setData({ themeId: getThemeId() })
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const stale = consumeMomentsListStale()
    const context = takeMomentsContext()
    if (context) this.setData({
      viewMode: 'timeline', locationKey: context.locationKey, locationName: '',
      contextLabel: context.label, dateYear: 0, dateMonth: 0, filterTag: '', searchActive: false, searchKeyword: '',
    })
    if (stale) this.invalidateSecondaryViews()
    const startYear = Number(getCouple()?.startDate.slice(0, 4)) || new Date().getFullYear()
    const currentYear = new Date().getFullYear()
    this.setData({ myRole: getIdentity().role, recapYears: Array.from({ length: Math.max(1, currentYear - startYear + 1) }, (_, index) => currentYear - index) })
    if (context || stale || this.data.rows.length === 0 || Date.now() - this.lastRefreshedAt > 15000) {
      await this.refresh(this.data.rows.length > 0)
      this.invalidateSecondaryViews()
      if (this.data.viewMode === 'map') await this.loadMap()
      if (this.data.viewMode === 'collections') await this.loadCollections()
      if (this.data.viewMode === 'recap') await this.loadRecap()
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
    this.invalidateSecondaryViews()
    await this.refresh()
    if (this.data.viewMode === 'map') await this.loadMap()
    if (this.data.viewMode === 'collections') await this.loadCollections()
    if (this.data.viewMode === 'recap') await this.loadRecap()
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
    this.setData({ viewMode: mode, secondaryError: '' })
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
    this.setData({ filterTag: key as MomentTag, viewMode: 'timeline', searchActive: false, searchKeyword: '', contextLabel: '', locationKey: '', locationName: '', dateYear: 0, dateMonth: 0 })
    this.refresh()
  },

  onTapCollectionPlace(e: WechatMiniprogram.BaseEvent) {
    const name = e.currentTarget.dataset.name as string
    this.setData({ viewMode: 'timeline', locationName: name, locationKey: '', contextLabel: name, filterTag: '', searchKeyword: '', searchActive: false, dateYear: 0, dateMonth: 0 })
    this.refresh()
  },

  onClearContext() {
    this.setData({ locationName: '', locationKey: '', contextLabel: '', dateYear: 0, dateMonth: 0 })
    void this.refresh()
  },

  onExpandText(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id)
    this.setData({ [`expandedTexts.${id}`]: !this.data.expandedTexts[id] })
  },

  onPickRecapYear(e: WechatMiniprogram.PickerChange) {
    this.setData({ recapYear: this.data.recapYears[Number(e.detail.value)] })
    void this.loadRecap()
  },

  onOpenRecap() {
    this.setData({
      viewMode: 'timeline', filterTag: '', locationName: '', locationKey: '',
      dateYear: this.data.recapYear, dateMonth: this.data.recapMonth,
      contextLabel: `${this.data.recapYear} 年 ${this.data.recapMonth} 月`,
      searchActive: false, searchKeyword: '',
    })
    void this.refresh()
  },

  coupleStartDate(): string {
    return getCouple()?.startDate ?? new Date().toISOString().slice(0, 10)
  },

  async refresh(preserve = false) {
    const revision = ++this.feedRevision
    const options = {
      tag: this.data.filterTag || undefined,
      keyword: this.data.searchActive ? this.data.searchKeyword : undefined,
      locationName: this.data.locationName || undefined, locationKey: this.data.locationKey || undefined,
      year: this.data.dateYear || undefined, month: this.data.dateMonth || undefined,
    }
    const targetCount = preserve ? Math.max(PAGE_SIZE, this.data.skip) : PAGE_SIZE
    this.setData({ loading: true })
    try {
      const myRole = getIdentity().role
      const key = feedCacheKey({
        tag: this.data.filterTag || '',
        keyword: this.data.searchActive ? this.data.searchKeyword : '',
      })
      const prefetched = options.locationName || options.locationKey || options.year ? null : await takePrefetchedFeed<MomentsPage>(key)
      const page = prefetched ?? await listMomentsPage({ ...options, limit: PAGE_SIZE, skip: 0 })
      if (revision !== this.feedRevision) return
      while (page.hasMore && page.items.length < targetCount) {
        const more = await listMomentsPage({ ...options, limit: PAGE_SIZE, skip: page.items.length })
        if (revision !== this.feedRevision) return
        page.items.push(...more.items)
        page.hasMore = more.hasMore
        if (!more.items.length) break
      }
      this.rawMoments = page.items
      const rows = buildTimelineRows(page.items, page.total, 0, myRole, this.coupleStartDate())
      this.setData({
        rows,
        empty: rows.length === 0,
        hasMore: page.hasMore,
        skip: page.items.length,
        total: page.total,
        loadError: '',
      })
      this.lastRefreshedAt = Date.now()
      this.setData({ briefStats: { ...this.data.briefStats, total: page.total } })
      void getMomentsBriefStats().then(brief => {
        if (revision === this.feedRevision) this.setData({ briefStats: brief })
      }).catch(() => undefined)
      if (!this.data.searchActive && !this.data.contextLabel) {
        void getOnThisDayMoments().then(list => {
          if (revision === this.feedRevision) this.setData({ onThisDay: scenesFromMoments(list, list.length, 0, myRole) })
        }).catch(() => undefined)
      } else this.setData({ onThisDay: [] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      if (revision === this.feedRevision) this.setData({ loadError: msg })
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      if (revision === this.feedRevision) this.setData({ loading: false })
    }
  },

  onRetry() {
    this.refresh()
  },

  onRetrySecondary() {
    if (this.data.viewMode === 'map') void this.loadMap()
    if (this.data.viewMode === 'collections') void this.loadCollections()
    if (this.data.viewMode === 'recap') void this.loadRecap()
  },

  async loadMore() {
    const revision = this.feedRevision
    this.setData({ loadingMore: true })
    try {
      const myRole = getIdentity().role
      const page = await listMomentsPage({
        limit: PAGE_SIZE,
        skip: this.data.skip,
        tag: this.data.filterTag || undefined,
        keyword: this.data.searchActive ? this.data.searchKeyword : undefined,
        locationName: this.data.locationName || undefined, locationKey: this.data.locationKey || undefined,
        year: this.data.dateYear || undefined, month: this.data.dateMonth || undefined,
      })
      if (revision !== this.feedRevision) return
      this.rawMoments.push(...page.items)
      const previousDate = this.rawMoments[this.rawMoments.length - page.items.length - 1]?.momentDate || ''
      const [previousYear, previousMonth] = previousDate.split('-')
      const moreRows = buildTimelineRows(
        page.items,
        this.data.total,
        this.data.skip,
        myRole,
        this.coupleStartDate(),
        previousDate ? `${previousYear}-${Number(previousMonth)}` : '',
      )
      this.setData({
        rows: [...this.data.rows, ...moreRows],
        hasMore: page.hasMore,
        skip: this.data.skip + page.items.length,
      })
    } catch (err) {
      if (revision !== this.feedRevision) return
      const msg = err instanceof Error ? err.message : '加载更多失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      if (revision === this.feedRevision) this.setData({ loadingMore: false })
    }
  },

  async loadMap() {
    this.setData({ secondaryLoading: true, secondaryError: '' })
    try {
      const { places, cities } = await listMapPlaces()
      this.mapLoaded = true
      if (!places.length) {
        this.setData({
          mapEmpty: true,
          places: [],
          cities: [],
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
      this.setData({
        mapEmpty: false,
        places,
        cities,
        mapPlaceCount: places.length,
        mapMemoryCount,
        mapCityCount: cities.length,
        selectedMapPlaceId: selectedMapPlace.id,
        selectedMapPlace,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '地图加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ secondaryError: msg })
    } finally {
      this.setData({ secondaryLoading: false })
    }
  },

  onTapMapPlace(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '')
    this.selectMapPlace(id)
  },

  selectMapPlace(id: string) {
    const p = this.data.places.find(place => place.id === id)
    if (!p) return
    this.setData({
      selectedMapPlaceId: id,
      selectedMapPlace: p,
    })
  },

  onSelectMapPlace(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    this.selectMapPlace(e.detail.id)
  },

  onTapMapStory() {
    const momentId = this.data.selectedMapPlace?.latestMomentId
    if (!momentId) return
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${momentId}` })
  },

  onOpenMapPlace() {
    const place = this.data.selectedMapPlace
    if (!place) return
    this.setData({ viewMode: 'timeline', locationKey: place.id, locationName: '', contextLabel: place.name, dateYear: 0, dateMonth: 0, filterTag: '', searchActive: false, searchKeyword: '' })
    void this.refresh()
  },

  async loadCollections() {
    this.setData({ secondaryLoading: true, secondaryError: '' })
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
      this.setData({ secondaryError: msg })
    } finally {
      this.setData({ secondaryLoading: false })
    }
  },

  async loadRecap() {
    const revision = ++this.recapRevision
    this.setData({ recapLoading: true, secondaryError: '', recapStats: null, recapMemories: [] })
    const key = `${this.data.recapYear}-${this.data.recapMonth}`
    const cached = this.recapCache[key]
    try {
      const [stats, page] = await Promise.all([
        cached ? Promise.resolve(cached) : getMomentsStats(this.data.recapYear, this.data.recapMonth),
        listMomentsPage({ limit: 6, year: this.data.recapYear, month: this.data.recapMonth }),
      ])
      if (revision !== this.recapRevision) return
      const total = Math.max(0, stats.total)
      const percentA = total > 0 ? Math.min(100, Math.round((stats.countA / total) * 100)) : 0
      const vo = {
        total,
        countA: stats.countA,
        countB: stats.countB,
        placeCount: stats.placeCount,
        topTag: cached ? cached.topTag : stats.topTag ? tagLabel(stats.topTag as MomentTag) : '—',
        percentA,
        percentB: total > 0 ? Math.max(0, 100 - percentA) : 0,
      }
      this.recapCache[key] = vo
      this.setData({ recapStats: vo, recapMemories: scenesFromMoments(page.items, page.total, 0, getIdentity().role) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '回顾加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      if (revision === this.recapRevision) this.setData({ secondaryError: msg })
    } finally {
      if (revision === this.recapRevision) this.setData({ recapLoading: false })
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
    if (this.likePending.has(id)) return
    this.likePending.add(id)
    const prevLiked = row.scene.likedByMe
    const prevCount = row.scene.likeCount
    const nextLiked = !prevLiked
    this.setData({
      [`rows[${index}].scene.likedByMe`]: nextLiked,
      [`rows[${index}].scene.likeCount`]: Math.max(0, prevCount + (nextLiked ? 1 : -1)),
    })
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await setMomentLike(id, nextLiked)
      if (this.data.rows[index]?.key !== id) return
      const liked = getIdentity().role === 'A' ? likes.likedByA : likes.likedByB
      this.setData({
        [`rows[${index}].scene.likedByMe`]: liked,
        [`rows[${index}].scene.likeCount`]: likes.count,
      })
    } catch (err) {
      if (this.data.rows[index]?.key !== id) return
      this.setData({
        [`rows[${index}].scene.likedByMe`]: prevLiked,
        [`rows[${index}].scene.likeCount`]: prevCount,
      })
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.likePending.delete(id)
    }
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },
})
