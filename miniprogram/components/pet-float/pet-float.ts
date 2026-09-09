import { getPet, petInteract } from '../../services/store'
import { PetView } from '../../services/types'
import { getAppInstance, isSessionReady } from '../../app'

const HIDE_ROUTES = new Set(['pages/setup/setup', 'pages/pet/pet'])
const POSITION_KEY = 'OURS_PET_FLOAT_POSITION_V1'
const ORB_SIZE_RPX = 104
const EDGE_RPX = 12
const PAGE_BOTTOM_RPX = 32
const TAB_BOTTOM_RPX = 120
const PANEL_WIDTH_RPX = 370
const PANEL_TOP_THRESHOLD_RPX = 280
const DRAG_THRESHOLD_PX = 6
const TAP_GUARD_MS = 250

interface Viewport {
  width: number
  height: number
  rpx: number
  orbSize: number
  edge: number
  safeBottom: number
}

interface Position {
  left: number
  top: number
}

interface DragState extends Position {
  startX: number
  startY: number
  originLeft: number
  originTop: number
  moved: boolean
}

const dragStates = new WeakMap<object, DragState>()
const tapGuards = new WeakMap<object, number>()

function currentRoute(): string {
  const pages = getCurrentPages()
  return pages[pages.length - 1]?.route ?? ''
}

function isTabPage(route: string): boolean {
  return route.startsWith('pages/home/') ||
    route.startsWith('pages/moments/') ||
    route.startsWith('pages/profile/')
}

function getViewport(): Viewport {
  const info = wx.getSystemInfoSync()
  const rpx = info.windowWidth / 750
  const safeBottom = Math.max(0, info.windowHeight - (info.safeArea?.bottom ?? info.windowHeight))
  return {
    width: info.windowWidth,
    height: info.windowHeight,
    rpx,
    orbSize: ORB_SIZE_RPX * rpx,
    edge: EDGE_RPX * rpx,
    safeBottom,
  }
}

function clampPosition(position: Position, viewport: Viewport): Position {
  const maxLeft = Math.max(viewport.edge, viewport.width - viewport.orbSize - viewport.edge)
  const maxTop = Math.max(viewport.edge, viewport.height - viewport.orbSize - viewport.edge)
  return {
    left: Math.min(Math.max(position.left, viewport.edge), maxLeft),
    top: Math.min(Math.max(position.top, viewport.edge), maxTop),
  }
}

function readStoredPosition(): Position | null {
  try {
    const stored = wx.getStorageSync(POSITION_KEY) as Partial<Position> | null
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      return { left: Number(stored.left), top: Number(stored.top) }
    }
  } catch {
    /* ignore */
  }
  return null
}

function initialPosition(route: string, viewport: Viewport): Position {
  const bottomRpx = isTabPage(route) ? TAB_BOTTOM_RPX : PAGE_BOTTOM_RPX
  return {
    left: 24 * viewport.rpx,
    top: viewport.height - bottomRpx * viewport.rpx - viewport.safeBottom - viewport.orbSize,
  }
}

function panelPosition(position: Position, viewport: Viewport) {
  const clamped = clampPosition(position, viewport)
  return {
    ...clamped,
    panelBelow: clamped.top < PANEL_TOP_THRESHOLD_RPX * viewport.rpx,
    panelRight: clamped.left + PANEL_WIDTH_RPX * viewport.rpx > viewport.width - viewport.edge,
  }
}

function touchPoint(e: WechatMiniprogram.TouchEvent): { x: number; y: number } | null {
  const touch = e.touches[0] ?? e.changedTouches[0]
  if (!touch) return null
  return { x: touch.clientX, y: touch.clientY }
}

Component({
  data: {
    show: false,
    expanded: false,
    pet: null as PetView | null,
    kittyMood: 'normal' as string,
    acting: false,
    left: 0,
    top: 0,
    panelBelow: false,
    panelRight: false,
    dragging: false,
  },

  lifetimes: {
    attached() {
      this.syncVisibility()
    },
    detached() {
      dragStates.delete(this)
      tapGuards.delete(this)
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
      if (HIDE_ROUTES.has(route) || !isSessionReady()) {
        this.setData({ show: false, expanded: false, dragging: false })
        return
      }
      const viewport = getViewport()
      const position = panelPosition(readStoredPosition() ?? initialPosition(route, viewport), viewport)
      this.setData({ show: true, ...position })
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
      const guardUntil = tapGuards.get(this) ?? 0
      if (guardUntil > Date.now()) return
      tapGuards.delete(this)
      this.setData({ expanded: !this.data.expanded })
    },

    onCollapse() {
      this.setData({ expanded: false })
    },

    onGoPet() {
      this.setData({ expanded: false })
      wx.navigateTo({ url: '/pages/pet/pet' })
    },

    onDragStart(e: WechatMiniprogram.TouchEvent) {
      const point = touchPoint(e)
      if (!point) return
      dragStates.set(this, {
        startX: point.x,
        startY: point.y,
        originLeft: this.data.left,
        originTop: this.data.top,
        left: this.data.left,
        top: this.data.top,
        moved: false,
      })
    },

    onDragMove(e: WechatMiniprogram.TouchEvent) {
      const state = dragStates.get(this)
      const point = touchPoint(e)
      if (!state || !point) return

      const dx = point.x - state.startX
      const dy = point.y - state.startY
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      state.moved = true

      const viewport = getViewport()
      const position = panelPosition({
        left: state.originLeft + dx,
        top: state.originTop + dy,
      }, viewport)
      state.left = position.left
      state.top = position.top
      this.setData({ ...position, expanded: false, dragging: true })
    },

    onDragEnd() {
      const state = dragStates.get(this)
      if (!state) return
      if (state.moved) {
        try {
          wx.setStorageSync(POSITION_KEY, { left: state.left, top: state.top })
        } catch {
          /* ignore */
        }
        tapGuards.set(this, Date.now() + TAP_GUARD_MS)
      }
      dragStates.delete(this)
      this.setData({ dragging: false })
    },

    stopTap() {},

    async onQuickAction(e: WechatMiniprogram.BaseEvent) {
      const action = e.currentTarget.dataset.action as 'feed' | 'pet'
      if (!this.data.pet?.adopted || this.data.acting) return
      this.setData({ acting: true })
      try {
        const pet = await petInteract(action)
        wx.vibrateShort({ type: 'light' })
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
