// pages/map/map.ts — 动态地点聚合

import { listMapPlaces } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { MapPlace, MapCityStat } from '../../services/types'

Page({
  data: {
    markers: [] as WechatMiniprogram.MapMarker[],
    places: [] as MapPlace[],
    cities: [] as MapCityStat[],
    empty: true,
    centerLat: 31.23,
    centerLng: 121.47,
    scale: 10,
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.refresh()
  },

  async refresh() {
    try {
      const { places, cities } = await listMapPlaces()
      if (!places.length) {
        this.setData({ empty: true, places: [], cities: [], markers: [] })
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
      const centerLat = places[0].latitude
      const centerLng = places[0].longitude
      this.setData({
        empty: false,
        places,
        cities,
        markers,
        centerLat,
        centerLng,
        scale: places.length === 1 ? 14 : 8,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onMarkerTap(e: WechatMiniprogram.MapMarkerTap) {
    const idx = (e.detail.markerId as number) - 1
    const p = this.data.places[idx]
    if (!p) return
    wx.showModal({
      title: p.name,
      content: `${p.address || ''}\n关联 ${p.momentCount} 条动态`,
      showCancel: false,
    })
  },
})
