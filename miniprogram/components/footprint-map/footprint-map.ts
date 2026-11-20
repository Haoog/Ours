import { MapPlace } from '../../services/types'
import { getMapTheme } from '../../services/theme'

const markerStates = new WeakMap<object, { nextId: number; ids: Map<string, number> }>()

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
      const state = markerStates.get(this) ?? { nextId: 1, ids: new Map<string, number>() }
      const ids = new Map<string, number>()
      for (const place of places) ids.set(place.id, state.ids.get(place.id) ?? state.nextId++)
      state.ids = ids
      markerStates.set(this, state)
      if (!selected) {
        this.setData({ markers: [], points: [] })
        return
      }
      const colors = getMapTheme()
      this.setData({
        latitude: selected.latitude, longitude: selected.longitude, scale: places.length === 1 ? 14 : 8,
        points: places.map(place => ({ latitude: place.latitude, longitude: place.longitude })),
        markers: places.map(place => ({
          id: ids.get(place.id), latitude: place.latitude, longitude: place.longitude,
          title: place.name, iconPath: '/assets/footprint-pin.png', width: 24, height: 32,
          callout: {
            content: `${place.name} · ${place.momentCount} 条回忆`,
            color: place.id === selected.id ? '#FFFFFF' : colors.text,
            bgColor: place.id === selected.id ? colors.accent : '#FFFFFF',
            fontSize: 12, padding: 8, borderRadius: 8,
            display: place.id === selected.id ? 'ALWAYS' : 'BYCLICK',
          },
        })),
      })
    },
  },
  methods: {
    onMarkerTap(e: WechatMiniprogram.CustomEvent<{ markerId: number }>) {
      const markerId = Number(e.detail?.markerId)
      const ids = markerStates.get(this)?.ids
      if (!ids) return
      for (const [id, currentMarkerId] of ids) {
        if (currentMarkerId !== markerId) continue
        this.triggerEvent('select', { id })
        return
      }
    },
  },
})
