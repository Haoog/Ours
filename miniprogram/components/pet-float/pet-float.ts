import { getPet, petInteract } from '../../services/store'
import { PetView } from '../../services/types'
import { getAppInstance, isSessionReady } from '../../app'

const HIDE_ROUTES = new Set(['pages/setup/setup', 'pages/pet/pet', 'pages/privacy/privacy'])

function currentRoute(): string {
  const pages = getCurrentPages()
  return pages[pages.length - 1]?.route ?? ''
}

Component({
  data: {
    show: false,
    expanded: false,
    pet: null as PetView | null,
    kittyMood: 'normal' as string,
    acting: false,
    tabPage: false,
  },

  lifetimes: {
    attached() {
      this.syncVisibility()
    },
  },

  pageLifetimes: {
    show() {
      this.syncVisibility()
    },
  },

  methods: {
    syncVisibility() {
      const route = currentRoute()
      const tabPage = route.startsWith('pages/home/') ||
        route.startsWith('pages/moments/') ||
        route.startsWith('pages/interact/') ||
        route.startsWith('pages/profile/')
      if (HIDE_ROUTES.has(route) || !isSessionReady()) {
        this.setData({ show: false, expanded: false, tabPage })
        return
      }
      this.setData({ show: true, tabPage })
      this.refresh()
    },

    async refresh() {
      try {
        const pet = await getPet()
        const map: Record<string, string> = {
          happy: 'awake',
          normal: 'normal',
          hungry: 'dim',
          sleepy: 'dim',
        }
        this.setData({
          pet,
          kittyMood: pet.adopted ? map[pet.mood || 'normal'] || 'normal' : 'awake',
        })
      } catch {
        this.setData({ pet: { adopted: false } })
      }
    },

    onToggleExpand() {
      this.setData({ expanded: !this.data.expanded })
    },

    onCollapse() {
      this.setData({ expanded: false })
    },

    onGoPet() {
      this.setData({ expanded: false })
      wx.navigateTo({ url: '/pages/pet/pet' })
    },

    stopTap() {},

    async onQuickAction(e: WechatMiniprogram.BaseEvent) {
      const action = e.currentTarget.dataset.action as 'feed' | 'pet'
      if (!this.data.pet?.adopted || this.data.acting) return
      this.setData({ acting: true })
      try {
        const pet = await petInteract(action)
        const map: Record<string, string> = {
          happy: 'awake',
          normal: 'normal',
          hungry: 'dim',
          sleepy: 'dim',
        }
        this.setData({
          pet,
          kittyMood: map[pet.mood || 'normal'] || 'normal',
        })
        wx.showToast({
          title: action === 'feed' ? '喂食成功' : '抚摸成功',
          icon: 'success',
        })
        const app = getAppInstance() as { bumpPet?: () => void }
        app.bumpPet?.()
      } catch (err) {
        const msg = err instanceof Error ? err.message : '操作失败'
        wx.showToast({ title: msg, icon: 'none' })
      } finally {
        this.setData({ acting: false })
      }
    },
  },
})
