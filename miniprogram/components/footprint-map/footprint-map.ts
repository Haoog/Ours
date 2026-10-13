import { MapPlace } from '../../services/types'
import { getMapTheme } from '../../services/theme'

Component({
  properties: {
    places: { type: Array, value: [] },
    selectedId: { type: String, value: '' },
    themeId: { type: String, value: 'lavender' },
  },
  data: {
    markers: [] as Record<string, unknown>[],
    points: [] as { latitude: number; longitude: number }[],
    latitude: 31.23,
    longitude: 121.47,
    scale: 10,
  },
  observers: {
    'places, selectedId, themeId'(places: MapPlace[], selectedId: string) {
      const selected = places.find(place => place.id === selectedId) || places[0]
      if (!selected) return
      const colors = getMapTheme()
      this.setData({
        latitude: selected.latitude, longitude: selected.longitude, scale: places.length === 1 ? 14 : 8,
        points: places.map(place => ({ latitude: place.latitude, longitude: place.longitude })),
        markers: places.map((place, index) => ({
          id: index + 1, latitude: place.latitude, longitude: place.longitude,
          title: place.name, iconPath: '/assets/footprint-pin.png', width: 24, height: 32,
          callout: {
            content: `${place.name} · ${place.momentCount} 条回忆`,
            color: place.id === selectedId ? '#FFFFFF' : colors.text,
            bgColor: place.id === selectedId ? colors.accent : '#FFFFFF',
            fontSize: 12, padding: 8, borderRadius: 8,
            display: place.id === selectedId ? 'ALWAYS' : 'BYCLICK',
          },
        })),
      })
    },
  },
  methods: {
    onMarkerTap(e: WechatMiniprogram.CustomEvent<{ markerId: number }>) {
      const places = this.properties.places as MapPlace[]
      const place = places[Number(e.detail.markerId) - 1]
      if (place) this.triggerEvent('select', { id: place.id })
    },
  },
})
