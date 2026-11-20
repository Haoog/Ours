// pages/moments/moments.ts — 回忆 Tab（回忆 / 足迹 / 合辑 / 回顾）

import {
  listMomentsPage,
  MomentsPage,
  MomentsCursor,
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
import { ensureCloudReadyState } from '../../services/page-boot'
import {
  buildTimelineRows,
  scenesFromMoments,
  SceneVO,
  TimelineRow,
  withoutFailedPreview,
} from '../../utils/moments-timeline'
import { MapPlace, MapCityStat } from '../../services/types'
import {
  consumeMomentsListStale,
  peekMomentsListStale,
  consumeMomentsScrollTop,
  saveMomentsScrollTop,
} from '../../services/moments-list-state'
import { feedCacheKey, invalidateMomentsFeedPrefetch, takePrefetchedFeed } from '../../services/moments-feed-cache'
import { getThemeStyle, getThemeId, syncTheme } from '../../services/theme'
import { takeMomentsContext } from '../../services/moments-list-state'

const PAGE_SIZE = 20
const RECAP_PREVIEW_SIZE = 6

type ViewMode = 'timeline' | 'map' | 'collections' | 'recap'

type RecapStats = {
  total: number
  countA: number
  countB: number
  placeCount: number
  topTag: string
  percentA: number
  percentB: number
}

type RecapSnapshot = {
  recapStats: RecapStats
  recapMemories: SceneVO[]
}

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

function unseenMoments(items: Moment[], seen: Set<string>): Moment[] {
  return items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    themeId: getThemeId(),
    viewMode: 'timeline' as ViewMode,
    rows: [] as TimelineRow[],
    onThisDay: [] as SceneVO[],
    empty: true,
    feedLoaded: false,
    bootState: 'checking' as 'checking' | Awaited<ReturnType<typeof ensureCloudReadyState>>,
    loading: false,
    loadError: '',
    loadingMore: false,
    loadMoreError: '',
    hasMore: false,
    skip: 0,
    total: 0,
    filterTag: '' as MomentTag | '',
    tagFilters: MOMENT_TAG_FILTERS,
    searchKeyword: '',
    submittedKeyword: '',
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
    recapStats: null as RecapStats | null,
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
  secondaryRevision: 0,
  loadedQueryKey: '',
  nextCursor: undefined as MomentsCursor | null | undefined,
  rawMoments: [] as Moment[],
  lastRefreshedAt: 0,
  likePending: new Map<string, boolean>(),
  likeRevision: 0,
  likeOwner: '',
  detailChannel: null as WechatMiniprogram.EventChannel | null,
  confirmedLikes: new Map<string, { likedByMe: boolean; likeCount: number; revision: number }>(),
  collectionsLoaded: false,
  recapCache: {} as Partial<Record<string, RecapSnapshot>>,
  recapRequests: {} as Partial<Record<string, Promise<RecapSnapshot>>>,

  checkingSession: false,

  async onShow() {
    syncTheme(this)
    this.setData({ themeId: getThemeId() })
    await this.loadPage()
  },

  async loadPage() {
    if (this.checkingSession || this.data.bootState === 'redirecting') return
    this.checkingSession = true
    if (peekMomentsListStale()) this.feedRevision++
    if (this.data.bootState !== 'ready') this.setData({ bootState: 'checking' })
    const state = await ensureCloudReadyState().finally(() => { this.checkingSession = false })
    if (state === 'offline') {
      this.setData({ bootState: state, loading: false, loadingMore: false, loadError: '暂时连不上，请稍后重试' })
      return
    }
    this.setData({ bootState: state })
    if (state === 'redirecting') return
    const stale = consumeMomentsListStale()
    const context = takeMomentsContext()
    if (context) this.setData({
      viewMode: 'timeline', locationKey: context.locationKey, locationName: '',
      contextLabel: context.label, dateYear: 0, dateMonth: 0, filterTag: '', searchActive: false, searchKeyword: '', submittedKeyword: '',
    })
    if (stale) this.invalidateSecondaryViews()
    const couple = getCouple()
    const likeOwner = this.currentLikeOwner()
    if (likeOwner !== this.likeOwner) {
      this.likeOwner = likeOwner
      this.likePending = new Map()
      this.confirmedLikes.clear()
      this.detailChannel = null
    }
    const startYear = Number(couple?.startDate.slice(0, 4)) || new Date().getFullYear()
    const currentYear = new Date().getFullYear()
    this.setData({ myRole: getIdentity().role, recapYears: Array.from({ length: Math.max(1, currentYear - startYear + 1) }, (_, index) => currentYear - index) })
    if (context || stale || this.data.loadError || this.data.rows.length === 0 || Date.now() - this.lastRefreshedAt > 15000) {
      await this.refresh(this.data.rows.length > 0)
      this.invalidateSecondaryViews()
      if (this.data.viewMode === 'map') await this.loadMap()
      if (this.data.viewMode === 'collections') await this.loadCollections()
      if (this.data.viewMode === 'recap') await this.loadRecap()
    }
    this.restoreScrollTop()
  },

  invalidateSecondaryViews(preserveRecap = false) {
    this.secondaryRevision++
    this.mapLoaded = false
    this.collectionsLoaded = false
    const key = `${this.data.recapYear}-${this.data.recapMonth}`
    const cached = preserveRecap ? this.recapCache[key] : undefined
    this.recapCache = cached ? { [key]: cached } : {}
    this.recapRequests = {}
    if (this.data.viewMode === 'recap') {
      this.setData({ recapStats: cached?.recapStats ?? null, recapMemories: cached?.recapMemories ?? [], recapLoading: true, secondaryError: '' })
    }
  },

  onPageScroll(e: WechatMiniprogram.Page.IPageScrollOption) {
    saveMomentsScrollTop(e.scrollTop)
  },

  async onPullDownRefresh() {
    try {
      if (this.data.bootState !== 'ready') {
        await this.loadPage()
        return
      }
      if (this.data.viewMode === 'recap') {
        this.invalidateSecondaryViews(true)
        await this.loadRecap()
        return
      }
      this.invalidateSecondaryViews()
      const { viewMode, filterTag, submittedKeyword, locationName, locationKey, dateYear, dateMonth } = this.data
      const defaultTimeline = viewMode === 'timeline' && !filterTag && !locationName && !locationKey && !dateYear && !dateMonth
      const feedRefresh = this.refresh(defaultTimeline || Boolean(submittedKeyword))
      const revision = this.secondaryRevision
      await feedRefresh
      if (revision !== this.secondaryRevision) return
      if (this.data.viewMode === 'map') await this.loadMap()
      if (this.data.viewMode === 'collections') await this.loadCollections()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async onReachBottom() {
    if (this.data.viewMode !== 'timeline' || this.data.bootState !== 'ready') return
    await this.onRetryMore()
  },

  async onRetryMore() {
    if (this.data.viewMode !== 'timeline' || this.data.bootState !== 'ready') return
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    await this.loadMore()
  },

  onSwitchView(e: WechatMiniprogram.BaseEvent) {
    const mode = (e.currentTarget.dataset.mode ?? 'timeline') as ViewMode
    if (mode === this.data.viewMode) return
    this.secondaryRevision++
    this.setData({ viewMode: mode, secondaryError: '', secondaryLoading: false, recapLoading: false })
    if (mode === 'map') {
      if (!this.mapLoaded) this.loadMap()
    } else if (mode === 'collections') {
      if (!this.collectionsLoaded) this.loadCollections()
    } else if (mode === 'recap') {
      this.loadRecap()
    } else if (!this.data.loading && !this.data.feedLoaded) {
      this.refresh()
    }
  },

  onPickFilter(e: WechatMiniprogram.BaseEvent) {
    const filterTag = (e.currentTarget.dataset.key ?? '') as MomentTag | ''
    this.setData({ filterTag })
    this.refresh()
  },

  onSearchInput(e: WechatMiniprogram.Input) {
    this.setData({ searchKeyword: e.detail.value })
  },

  onSearchConfirm() {
    const kw = this.data.searchKeyword.trim()
    this.setData({ searchActive: Boolean(kw), submittedKeyword: kw })
    this.refresh()
  },

  onClearSearch() {
    this.setData({ searchKeyword: '', submittedKeyword: '', searchActive: false })
    this.refresh()
  },

  onRecapMonthTap(e: WechatMiniprogram.BaseEvent) {
    const month = Number(e.currentTarget.dataset.month)
    this.setData({ recapMonth: month })
    this.loadRecap()
  },

  onTapCollectionTag(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as string
    this.setData({ filterTag: key as MomentTag, viewMode: 'timeline', searchActive: false, searchKeyword: '', submittedKeyword: '', contextLabel: '', locationKey: '', locationName: '', dateYear: 0, dateMonth: 0 })
    this.refresh()
  },

  onTapCollectionPlace(e: WechatMiniprogram.BaseEvent) {
    const name = e.currentTarget.dataset.name as string
    this.setData({ viewMode: 'timeline', locationName: name, locationKey: '', contextLabel: name, filterTag: '', searchKeyword: '', submittedKeyword: '', searchActive: false, dateYear: 0, dateMonth: 0 })
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
      searchActive: false, searchKeyword: '', submittedKeyword: '',
    })
    void this.refresh()
  },

  coupleStartDate(): string {
    return getCouple()?.startDate ?? new Date().toISOString().slice(0, 10)
  },

  async refresh(preserve = false) {
    const revision = ++this.feedRevision
    const likeRevision = this.likeRevision
    const options = {
      tag: this.data.filterTag || undefined,
      keyword: this.data.submittedKeyword || undefined,
      locationName: this.data.locationName || undefined, locationKey: this.data.locationKey || undefined,
      year: this.data.dateYear || undefined, month: this.data.dateMonth || undefined,
    }
    const queryKey = JSON.stringify(options)
    const sameQuery = queryKey === this.loadedQueryKey
    const targetCount = preserve && sameQuery ? Math.max(PAGE_SIZE, this.rawMoments.length) : PAGE_SIZE
    if (this.data.viewMode === 'timeline') this.secondaryRevision++
    if (!sameQuery) {
      this.rawMoments = []
      this.nextCursor = undefined
      this.setData({ rows: [], onThisDay: [], empty: true, feedLoaded: false, skip: 0, total: 0, hasMore: false })
    }
    this.setData({ loading: true, loadingMore: false, loadError: '', loadMoreError: '' })
    try {
      const myRole = getIdentity().role
      const key = feedCacheKey({
        tag: this.data.filterTag || '',
        keyword: this.data.submittedKeyword,
      })
      const filteredByContext = options.locationName || options.locationKey || options.year
      if (filteredByContext) invalidateMomentsFeedPrefetch()
      const prefetched = filteredByContext ? null : await takePrefetchedFeed<MomentsPage>(key)
      if (revision !== this.feedRevision) return
      // Exact coordinate matching runs after the database query and uses offsets.
      let page = prefetched ?? await listMomentsPage({
        ...options, limit: PAGE_SIZE, skip: 0, cursor: options.locationKey ? undefined : null,
      })
      if (revision !== this.feedRevision) return
      const total = page.total
      const seen = new Set<string>()
      const items = unseenMoments(page.items, seen)
      let skip = page.items.length
      while (page.hasMore && page.items.length && items.length < targetCount) {
        page = await listMomentsPage({ ...options, limit: PAGE_SIZE, skip, cursor: page.nextCursor })
        if (revision !== this.feedRevision) return
        skip += page.items.length
        items.push(...unseenMoments(page.items, seen))
      }
      this.loadedQueryKey = queryKey
      this.nextCursor = page.nextCursor
      this.rawMoments = this.reconcileFeedLikes(items, likeRevision)
      const rows = buildTimelineRows(this.rawMoments.map(item => this.withPendingLike(item)), total, 0, myRole, this.coupleStartDate())
      this.setData({
        rows,
        empty: rows.length === 0,
        feedLoaded: true,
        hasMore: page.hasMore && page.items.length > 0,
        skip,
        total,
        loadError: '',
      })
      this.lastRefreshedAt = Date.now()
      this.setData({ briefStats: { ...this.data.briefStats, total } })
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
      if (revision === this.feedRevision) {
        this.setData({ loadError: msg })
        wx.showToast({ title: msg, icon: 'none' })
      }
    } finally {
      if (revision === this.feedRevision) this.setData({ loading: false })
    }
  },

  async onRetry() {
    if (this.data.bootState !== 'ready') return this.loadPage()
    if (!this.data.loading) await this.refresh(true)
  },

  onRetrySecondary() {
    if (this.data.bootState !== 'ready') return this.loadPage()
    if (this.data.viewMode === 'map') void this.loadMap()
    if (this.data.viewMode === 'collections') void this.loadCollections()
    if (this.data.viewMode === 'recap') void this.loadRecap()
  },

  async loadMore() {
    const revision = this.feedRevision
    const likeRevision = this.likeRevision
    this.setData({ loadingMore: true, loadMoreError: '' })
    try {
      const myRole = getIdentity().role
      const page = await listMomentsPage({
        limit: PAGE_SIZE,
        skip: this.data.skip,
        cursor: this.nextCursor,
        tag: this.data.filterTag || undefined,
        keyword: this.data.submittedKeyword || undefined,
        locationName: this.data.locationName || undefined, locationKey: this.data.locationKey || undefined,
        year: this.data.dateYear || undefined, month: this.data.dateMonth || undefined,
      })
      if (revision !== this.feedRevision) return
      const previousDate = this.rawMoments[this.rawMoments.length - 1]?.momentDate || ''
      const seen = new Set(this.rawMoments.map(item => item.id))
      const items = this.reconcileFeedLikes(unseenMoments(page.items, seen), likeRevision)
      const rowOffset = this.rawMoments.length
      this.rawMoments.push(...items)
      this.nextCursor = page.nextCursor
      const [previousYear, previousMonth] = previousDate.split('-')
      const moreRows = buildTimelineRows(
        items.map(item => this.withPendingLike(item)),
        this.data.total,
        rowOffset,
        myRole,
        this.coupleStartDate(),
        previousDate ? `${previousYear}-${Number(previousMonth)}` : '',
      )
      this.setData({
        rows: [...this.data.rows, ...moreRows],
        hasMore: page.hasMore && page.items.length > 0,
        skip: this.data.skip + page.items.length,
      })
    } catch (err) {
      if (revision !== this.feedRevision) return
      const msg = err instanceof Error ? err.message : '加载更多失败'
      this.setData({ loadMoreError: msg })
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      if (revision === this.feedRevision) this.setData({ loadingMore: false })
    }
  },

  async loadMap() {
    const revision = ++this.secondaryRevision
    this.setData({ secondaryLoading: true, secondaryError: '' })
    try {
      const { places, cities } = await listMapPlaces()
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'map') return
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
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'map') return
      const msg = err instanceof Error ? err.message : '地图加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ secondaryError: msg })
    } finally {
      if (revision === this.secondaryRevision) this.setData({ secondaryLoading: false })
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
    this.setData({ viewMode: 'timeline', locationKey: place.id, locationName: '', contextLabel: place.name, dateYear: 0, dateMonth: 0, filterTag: '', searchActive: false, searchKeyword: '', submittedKeyword: '' })
    void this.refresh()
  },

  async loadCollections() {
    const revision = ++this.secondaryRevision
    this.setData({ secondaryLoading: true, secondaryError: '' })
    try {
      const raw = await listMomentCollections()
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'collections') return
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
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'collections') return
      const msg = err instanceof Error ? err.message : '合辑加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ secondaryError: msg })
    } finally {
      if (revision === this.secondaryRevision) this.setData({ secondaryLoading: false })
    }
  },

  async requestRecap(year: number, month: number): Promise<RecapSnapshot> {
    const key = `${year}-${month}`
    const requests = this.recapRequests
    const role = this.data.myRole
    const request = Promise.all([
      getMomentsStats(year, month),
      listMomentsPage({ limit: RECAP_PREVIEW_SIZE, year, month }),
    ]).then(([stats, page]) => {
      const total = stats.total
      if (total !== page.total || page.items.length !== Math.min(total, RECAP_PREVIEW_SIZE)) {
        throw new Error('本月回忆有更新，请重试')
      }
      const percentA = total > 0 ? Math.min(100, Math.round((stats.countA / total) * 100)) : 0
      return {
        recapStats: {
          total,
          countA: stats.countA,
          countB: stats.countB,
          placeCount: stats.placeCount,
          topTag: stats.topTag ? tagLabel(stats.topTag as MomentTag) : '—',
          percentA,
          percentB: total > 0 ? Math.max(0, 100 - percentA) : 0,
        },
        recapMemories: scenesFromMoments(page.items, total, 0, role),
      }
    })
    requests[key] = request
    try {
      const snapshot = await request
      if (this.recapRequests === requests && requests[key] === request) this.recapCache[key] = snapshot
      return snapshot
    } finally {
      if (requests[key] === request) delete requests[key]
    }
  },

  warmRecapNeighbors(year: number, month: number) {
    for (const offset of [-1, 1]) {
      const date = new Date(year, month - 1 + offset, 1)
      const neighborYear = date.getFullYear()
      const neighborMonth = date.getMonth() + 1
      const key = `${neighborYear}-${neighborMonth}`
      if (!this.data.recapYears.includes(neighborYear) || this.recapCache[key] || this.recapRequests[key]) continue
      void this.requestRecap(neighborYear, neighborMonth).catch(() => {})
    }
  },

  async loadRecap() {
    const revision = ++this.secondaryRevision
    const { recapYear: year, recapMonth: month } = this.data
    const cached = this.recapCache[`${year}-${month}`]
    this.setData({
      recapLoading: true, secondaryError: '',
      recapStats: cached?.recapStats ?? null, recapMemories: cached?.recapMemories ?? [],
    })
    try {
      const snapshot = await this.requestRecap(year, month)
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'recap') return
      this.setData({ ...snapshot, recapLoading: false })
      this.warmRecapNeighbors(year, month)
    } catch (err) {
      if (revision !== this.secondaryRevision || this.data.viewMode !== 'recap') return
      const msg = err instanceof Error ? err.message : '请稍后重试'
      this.setData({
        recapLoading: false,
        secondaryError: cached ? `更新失败：${msg}。当前显示该月缓存` : `回顾加载失败：${msg}`,
      })
    }
  },

  restoreScrollTop() {
    const scrollTop = consumeMomentsScrollTop()
    if (scrollTop <= 0) return
    setTimeout(() => {
      wx.pageScrollTo({ scrollTop, duration: 0 })
    }, 0)
  },

  currentLikeOwner(): string {
    try {
      const { openid, role } = getIdentity()
      return JSON.stringify([openid, role, getCouple()?.id])
    } catch {
      return ''
    }
  },

  onTapScene(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const tag = this.data.filterTag || ''
    const q = tag ? `&tag=${tag}` : ''
    const owner = this.likeOwner
    let channel: WechatMiniprogram.EventChannel | undefined
    wx.navigateTo({
      url: `/pages/moment-detail/moment-detail?id=${id}${q}`,
      success: ({ eventChannel }) => {
        channel = eventChannel
        if (this.likeOwner === owner) this.detailChannel = channel
      },
      events: {
        momentLikeChanged: (momentId: string, likedByMe: boolean, likeCount: number) => {
          if (this.likeOwner === owner && this.currentLikeOwner() === owner) this.confirmSceneLike(momentId, likedByMe, likeCount)
        },
        momentDetailClosed: () => {
          if (this.detailChannel === channel) this.detailChannel = null
        },
      },
    })
  },

  onPreviewError(e: WechatMiniprogram.BaseEvent) {
    const { surface, id, src } = e.currentTarget.dataset
    if (typeof src !== 'string' || !src) return
    if (surface === 'recap' || surface === 'onThisDay') {
      const field = surface === 'recap' ? 'recapMemories' : 'onThisDay'
      const index = this.data[field].findIndex(scene => scene.id === id)
      const scene = this.data[field][index]
      // An error for an older cover must not remove the current cover.
      if (scene?.coverUrl !== src) return
      const updated = withoutFailedPreview(scene, src)
      this.setData({ [`${field}[${index}]`]: updated })
      return
    }
    const index = this.data.rows.findIndex(row => row.type === 'moment' && row.scene.id === id)
    const row = this.data.rows[index]
    if (row?.type !== 'moment') return
    const scene = withoutFailedPreview(row.scene, src)
    if (scene !== row.scene) this.setData({ [`rows[${index}].scene`]: scene })
  },

  reconcileFeedLikes(items: Moment[], readRevision: number): Moment[] {
    return items.map(item => {
      const confirmed = this.confirmedLikes.get(item.id)
      if (!confirmed) return item
      if (confirmed.revision <= readRevision) {
        this.confirmedLikes.delete(item.id)
        return item
      }
      return { ...item, likedByMe: confirmed.likedByMe, likeCount: confirmed.likeCount }
    })
  },

  withPendingLike(item: Moment): Moment {
    const desired = this.likePending.get(item.id)
    if (desired === undefined || desired === Boolean(item.likedByMe)) return item
    return { ...item, likedByMe: desired, likeCount: Math.max(0, (item.likeCount ?? 0) + (desired ? 1 : -1)) }
  },

  updateVisibleLike(id: string, likedByMe: boolean, likeCount: number) {
    const index = this.data.rows.findIndex(row => row.type === 'moment' && row.scene.id === id)
    if (index < 0) return
    this.setData({ [`rows[${index}].scene.likedByMe`]: likedByMe, [`rows[${index}].scene.likeCount`]: likeCount })
  },

  confirmSceneLike(id: string, likedByMe: boolean, likeCount: number) {
    this.confirmedLikes.set(id, { likedByMe, likeCount, revision: ++this.likeRevision })
    const index = this.rawMoments.findIndex(item => item.id === id)
    if (index >= 0) this.rawMoments[index] = { ...this.rawMoments[index], likedByMe, likeCount }
    if (!this.likePending.has(id)) this.updateVisibleLike(id, likedByMe, likeCount)
  },

  async onToggleSceneLike(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const row = this.data.rows.find(row => row.type === 'moment' && row.scene.id === id)
    if (row?.type !== 'moment' || this.likePending.has(id)) return
    const prevLiked = row.scene.likedByMe
    const prevCount = row.scene.likeCount
    const nextLiked = !prevLiked
    const { role } = getIdentity()
    const owner = this.currentLikeOwner()
    const pending = this.likePending
    pending.set(id, nextLiked)
    this.updateVisibleLike(id, nextLiked, Math.max(0, prevCount + (nextLiked ? 1 : -1)))
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await setMomentLike(id, nextLiked)
      pending.delete(id)
      if (owner !== this.currentLikeOwner() || pending !== this.likePending) return
      const liked = role === 'A' ? likes.likedByA : likes.likedByB
      this.confirmSceneLike(id, liked, likes.count)
      this.detailChannel?.emit('timelineLikeChanged', id, liked, likes.count)
    } catch (err) {
      pending.delete(id)
      if (owner !== this.currentLikeOwner() || pending !== this.likePending) return
      const latest = this.rawMoments.find(item => item.id === id)
      this.updateVisibleLike(id, latest ? Boolean(latest.likedByMe) : prevLiked, latest ? latest.likeCount ?? 0 : prevCount)
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },

  onTapRecapCompose() {
    const { recapYear, recapMonth } = this.data
    const monthKey = `${recapYear}-${String(recapMonth).padStart(2, '0')}`
    const startDate = getCouple()?.startDate ?? '1970-01-01'
    // 按发布页和云端使用的 UTC+8 日历日判断所选月是否有可记日期。
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const monthStart = `${monthKey}-01`
    const firstAllowedDate = startDate > monthStart ? startDate : monthStart
    if (!firstAllowedDate.startsWith(`${monthKey}-`) || firstAllowedDate > today) {
      wx.showToast({ title: '该月没有可补记的日期，请选择其他月份', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/compose/compose?recapMonth=${monthKey}` })
  },
})
