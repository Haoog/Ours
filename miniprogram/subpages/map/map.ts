// subpages/map/map.ts — 我们的足迹

import { listMapPlaces } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { MapPlace, MapCityStat } from '../../services/types'

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

function markersFor(places: PlaceVO[], selectedId = ''): any[] {
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
    places: [] as PlaceVO[],
    cities: [] as MapCityStat[],
    markers: [] as any[],
    includePoints: [] as { latitude: number; longitude: number }[],
    empty: true,
    centerLat: 31.23,
    centerLng: 121.47,
    scale: 10,
    placeCount: 0,
    memoryCount: 0,
    cityCount: 0,
    selectedPlaceId: '',
    selectedPlace: null as PlaceVO | null,
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

  async refresh() {
    try {
      const { places: rawPlaces, cities } = await listMapPlaces()
      const places = rawPlaces.map(toPlaceVO)
      if (!places.length) {
        this.setData({
          empty: true,
          places: [],
          cities: [],
          markers: [],
          includePoints: [],
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
      const includePoints = places.map(place => ({
        latitude: place.latitude,
        longitude: place.longitude,
      }))

      this.setData({
        empty: false,
        places,
        cities,
        markers: markersFor(places, selectedPlace.id),
        includePoints,
        centerLat: selectedPlace.latitude,
        centerLng: selectedPlace.longitude,
        scale: places.length === 1 ? 14 : 8,
        placeCount: places.length,
        memoryCount,
        cityCount: cities.length,
        selectedPlaceId: selectedPlace.id,
        selectedPlace,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  selectPlace(placeId: string) {
    const selectedPlace = this.data.places.find(place => place.id === placeId)
    if (!selectedPlace) return
    this.setData({
      selectedPlaceId: placeId,
      selectedPlace,
      markers: markersFor(this.data.places, placeId),
      centerLat: selectedPlace.latitude,
      centerLng: selectedPlace.longitude,
    })
  },

  onTapPlace(e: WechatMiniprogram.BaseEvent) {
    this.selectPlace(String(e.currentTarget.dataset.id || ''))
  },

  onMarkerTap(e: any) {
    const markerId = Number(e.detail?.markerId)
    const place = this.data.places[markerId - 1]
    if (place) this.selectPlace(place.id)
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
