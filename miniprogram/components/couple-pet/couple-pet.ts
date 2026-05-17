import { PetView } from '../../services/types'

Component({
  properties: {
    pet: {
      type: Object,
      value: null as PetView | null,
    },
    compact: {
      type: Boolean,
      value: false,
    },
    large: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    kittyMood: 'normal' as string,
    bounce: false,
  },

  observers: {
    pet(p: PetView | null) {
      if (!p?.adopted) return
      const map: Record<string, string> = {
        happy: 'awake',
        normal: 'normal',
        hungry: 'dim',
        sleepy: 'dim',
      }
      this.setData({
        kittyMood: map[p.mood || 'normal'] || 'normal',
        bounce: p.mood === 'happy',
      })
    },
  },
})
