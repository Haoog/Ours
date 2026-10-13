// subpages/map/map.ts — 我们的足迹

import { listMapPlaces } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { MapPlace, MapCityStat } from '../../services/types'
import { getThemeStyle, getThemeId, syncTheme } from '../../services/theme'
import { openMomentsContext } from '../../services/moments-list-state'

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
  return {
    ...place,
    latestDateLabel: formatPlaceDate(place.latestMomentDate),
    latestContent: content.length > 56 ? `${content.slice(0, 56)}…` : content,
    latestCover: place.latestMomentCover || '',
    latestHasVideo: !!place.latestMomentHasVideo,
  }
}

Page({
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
  },

  async onShow() {
    syncTheme(this)
    this.setData({ themeId: getThemeId() })
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async onPullDownRefresh() {
    await this.refresh()
    wx.stopPullDownRefresh()
  },

  async refresh() {
    this.setData({ loading: true, loadError: '' })
    try {
      const { places: rawPlaces, cities } = await listMapPlaces()
      const places = rawPlaces.map(toPlaceVO)
      if (!places.length) {
        this.setData({
          empty: true,
          places: [],
          cities: [],
          placeCount: 0,
          memoryCount: 0,
          cityCount: 0,
          selectedPlaceId: '',
          selectedPlace: null,
        })
        return
      }

      const selectedPlace = places[0]
      const memoryCount = places.reduce((sum, place) => sum + place.momentCount, 0)
      this.setData({
        empty: false,
        places,
        cities,
        placeCount: places.length,
        memoryCount,
        cityCount: cities.length,
        selectedPlaceId: selectedPlace.id,
        selectedPlace,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ loadError: msg })
    } finally {
      this.setData({ loading: false })
    }
  },

  selectPlace(placeId: string) {
    const selectedPlace = this.data.places.find(place => place.id === placeId)
    if (!selectedPlace) return
    this.setData({
      selectedPlaceId: placeId,
      selectedPlace,
    })
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
