// subpages/map/map.ts — 我们的足迹

import { getMapPlaceStory, listMapPlaces, resolveCloudUrl } from '../../services/store'
import { ensureCloudReadyState } from '../../services/page-boot'
import { MapPlace, MapCityStat } from '../../services/types'
import { getThemeStyle, getThemeId, syncTheme } from '../../services/theme'
import { openMomentsContext } from '../../services/moments-list-state'
import { getSession } from '../../services/session'
import { invalidateCachedUrl, peekCachedUrl } from '../../utils/cloud-url-cache'

interface PlaceSelection {
  coupleId: string
  placeId: string
}

// 切到回忆 Tab 会卸载地图，重新进入时按当前空间恢复这一站。
let returnSelection: PlaceSelection | null = null

interface PlaceVO extends MapPlace {
  latestDateLabel: string
  latestContent: string
  latestCover: string
  latestHasVideo: boolean
}

function formatPlaceDate(value?: string): string {
  if (!value) return ''
  const parts = value.split('-')
  if (parts.length !== 3) return value
  return `${parts[0]}.${Number(parts[1])}.${Number(parts[2])}`
}

function toPlaceVO(place: MapPlace): PlaceVO {
  const content = (place.latestMomentContent || '').trim()
  const cover = place.latestMomentCover || place.latestMomentCoverFileID || ''
  return {
    ...place,
    latestDateLabel: formatPlaceDate(place.latestMomentDate),
    latestContent: content.length > 56 ? `${content.slice(0, 56)}…` : content,
    latestCover: cover.startsWith('cloud://') ? '' : cover,
    latestHasVideo: !!place.latestMomentHasVideo,
  }
}

Page({
  refreshRevision: 0,
  storyRevision: 0,
  unloaded: false,
  restoredSelection: null as PlaceSelection | null,
  data: {
    themeStyle: getThemeStyle(),
    themeId: getThemeId(),
    loading: true,
    loadError: '',
    places: [] as PlaceVO[],
    cities: [] as MapCityStat[],
    empty: true,
    placeCount: 0,
    memoryCount: 0,
    cityCount: 0,
    selectedPlaceId: '',
    selectedPlace: null as PlaceVO | null,
    coverAttempt: 0,
    coverFailed: false,
  },

  onLoad() {
    this.restoredSelection = returnSelection
    returnSelection = null
  },

  async onShow() {
    syncTheme(this)
    this.setData({ themeId: getThemeId() })
    await this.refresh()
  },

  onUnload() {
    this.unloaded = true
    this.refreshRevision++
  },

  async onPullDownRefresh() {
    await this.refresh()
    if (!this.unloaded) wx.stopPullDownRefresh()
  },

  async refresh() {
    if (this.unloaded) return
    const revision = ++this.refreshRevision
    let coupleId = getSession()?.coupleId
    this.setData({ loading: true, loadError: '' })
    try {
      const state = await ensureCloudReadyState()
      if (revision !== this.refreshRevision || state === 'redirecting') return
      coupleId = getSession()?.coupleId
      if (state === 'offline') {
        this.setData({ loadError: '暂时连不上' })
        return
      }
      const { places: rawPlaces, cities } = await listMapPlaces({ deferCoverUrls: true })
      if (revision !== this.refreshRevision || coupleId !== getSession()?.coupleId) return

      const places = rawPlaces.map(toPlaceVO)
      const empty = places.length === 0
      const restored = this.restoredSelection
      const returnPlaceId = restored && restored.coupleId === coupleId ? restored.placeId : ''
      const selectedPlaceId = this.data.selectedPlaceId || returnPlaceId
      const selectedPlace = places.find(place => place.id === selectedPlaceId) ?? places[0] ?? null
      this.restoredSelection = null
      this.setData({
        empty,
        places,
        cities: empty ? [] : cities,
        placeCount: places.length,
        memoryCount: places.reduce((sum, place) => sum + place.momentCount, 0),
        cityCount: empty ? 0 : cities.length,
        selectedPlaceId: selectedPlace?.id ?? '',
        selectedPlace,
        coverAttempt: this.data.coverAttempt + 1,
        coverFailed: false,
      })
      void this.loadSelectedStory(selectedPlace)
    } catch (err) {
      if (revision !== this.refreshRevision || coupleId !== getSession()?.coupleId) return
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ loadError: msg })
    } finally {
      if (revision === this.refreshRevision) this.setData({ loading: false })
    }
  },

  selectPlace(placeId: string) {
    const selectedPlace = this.data.places.find(place => place.id === placeId)
    if (!selectedPlace) return
    this.setData({
      selectedPlaceId: placeId,
      selectedPlace,
      coverAttempt: this.data.coverAttempt + 1,
      coverFailed: false,
    })
    void this.loadSelectedStory(selectedPlace)
  },

  onCoverError(event: WechatMiniprogram.BaseEvent) {
    if (this.unloaded || !this.data.selectedPlace?.latestCover ||
      Number(event.currentTarget.dataset.coverAttempt) !== this.data.coverAttempt) return
    this.setData({ coverFailed: true })
  },

  onRetryCover() {
    const place = this.data.selectedPlace
    if (this.unloaded || !place || !this.data.coverFailed) return
    this.setData({
      selectedPlace: { ...place, latestCover: '' },
      coverAttempt: this.data.coverAttempt + 1,
      coverFailed: false,
    })
    void this.loadSelectedStory(place, true)
  },

  async loadSelectedStory(place: PlaceVO | null, retryCover = false) {
    const revision = ++this.storyRevision
    if (!place || this.unloaded) return
    const coupleId = getSession()?.coupleId
    let selected = place
    const isCurrent = () => {
      const current = this.data.selectedPlace
      return !this.unloaded && revision === this.storyRevision && coupleId === getSession()?.coupleId &&
        current?.id === selected.id && current.latestMomentId === selected.latestMomentId
    }

    try {
      if (!selected.latestMomentId ||
        ((!selected.latestMomentCover || retryCover) && selected.latestMomentCoverFileID == null &&
          !selected.latestMomentCover?.startsWith('cloud://'))) {
        const story = await getMapPlaceStory(selected).catch(() => selected)
        if (!isCurrent()) return
        if (story !== selected) {
          const previous = selected
          selected = toPlaceVO(story)
          const coverChanged = previous.latestCover !== selected.latestCover || previous.latestMomentId !== selected.latestMomentId
          this.setData({
            selectedPlace: retryCover ? { ...selected, latestCover: '' } : selected,
            ...(coverChanged ? { coverAttempt: this.data.coverAttempt + 1, coverFailed: false } : {}),
          })
        }
      }
      const source = retryCover
        ? selected.latestMomentCoverFileID || selected.latestMomentCover
        : selected.latestMomentCover || selected.latestMomentCoverFileID
      if (!source?.startsWith('cloud://')) {
        if (retryCover && isCurrent()) this.setData({ selectedPlace: selected })
        return
      }
      if (!retryCover && selected.latestCover) return
      if (retryCover && selected.latestCover && peekCachedUrl(source) === selected.latestCover) invalidateCachedUrl(source)
      const url = await resolveCloudUrl(source)
      if (url && isCurrent()) this.setData({
        selectedPlace: { ...selected, latestCover: url },
        coverAttempt: this.data.coverAttempt + 1,
        coverFailed: false,
      })
    } catch {
      if (isCurrent()) this.setData({ coverFailed: true })
    }
  },

  onTapPlace(e: WechatMiniprogram.BaseEvent) {
    this.selectPlace(String(e.currentTarget.dataset.id || ''))
  },

  onSelectMapPlace(e: WechatMiniprogram.CustomEvent<{ id: string }>) {
    this.selectPlace(e.detail.id)
  },

  onOpenPlace() {
    const place = this.data.selectedPlace
    if (!place) return
    const coupleId = getSession()?.coupleId
    returnSelection = coupleId ? { coupleId, placeId: place.id } : null
    openMomentsContext({ locationKey: place.id, label: place.name })
    wx.switchTab({ url: '/pages/moments/moments' })
  },

  onTapStory() {
    const momentId = this.data.selectedPlace?.latestMomentId
    if (!momentId) return
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${momentId}` })
  },

  onTapCompose() {
    wx.navigateTo({ url: '/pages/compose/compose' })
  },
})
