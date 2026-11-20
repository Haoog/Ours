// subpages/anniversaries/anniversaries.ts

import { listAnniversaries, addAnniversary, deleteAnniversary } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { Anniversary } from '../../services/types'
import { todayKey } from '../../services/date'
import { getThemeStyle, syncTheme } from '../../services/theme'

interface AnnVO {
  id: string
  title: string
  date: string
  daysLeft: number
  label: string
}

function anniversaryView(anniversary: Anniversary): AnnVO {
  const { id, title, date, daysLeft = 0 } = anniversary
  return { id, title, date, daysLeft, label: daysLeft === 0 ? '就是今天' : daysLeft < 0 ? `已过去 ${Math.abs(daysLeft)} 天` : `还有 ${daysLeft} 天` }
}

function compareAnniversaries(x: AnnVO, y: AnnVO) {
  return (x.daysLeft < 0 ? Number.MAX_SAFE_INTEGER : x.daysLeft) - (y.daysLeft < 0 ? Number.MAX_SAFE_INTEGER : y.daysLeft)
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    list: [] as AnnVO[],
    empty: true,
    showAdd: false,
    titleDraft: '',
    dateDraft: '',
    submitting: false,
    saveUnconfirmed: false,
    loading: true,
    loadError: '',
  },
  refreshVersion: 0,
  pendingAdd: null as { title: string; date: string; requestId: string } | null,
  unloaded: false,
  deleting: false,
  cancelDeleteConfirmation: undefined as (() => void) | undefined,

  onUnload() {
    this.unloaded = true
    this.refreshVersion++
    this.pendingAdd = null
    this.cancelDeleteConfirmation?.()
  },

  async onShow() {
    syncTheme(this)
    await this.refresh(true)
  },

  async onRetryRefresh() {
    if (this.data.loading) return
    await this.refresh(true)
  },

  async refresh(checkSession = false) {
    const version = ++this.refreshVersion
    this.setData({ loading: true })
    try {
      if (checkSession) {
        await getAppInstance().waitBoot()
        if (version !== this.refreshVersion) return
        const ready = await ensureCloudReady()
        if (version !== this.refreshVersion) return
        if (!ready) throw new Error('暂时连不上，请重试')
      }
      const list = await listAnniversaries()
      if (version !== this.refreshVersion) return
      const items = list.map(anniversaryView).sort(compareAnniversaries)
      this.setData({ list: items, empty: items.length === 0, loadError: '', loading: false })
    } catch (err) {
      if (version !== this.refreshVersion) return
      const msg = err instanceof Error ? err.message : ''
      this.setData({ loadError: msg || '加载失败', loading: false })
    }
  },

  onToggleAdd() {
    if (this.unloaded || this.data.submitting) return
    this.setData({ showAdd: !this.data.showAdd, dateDraft: this.data.dateDraft || todayKey() })
  },

  onTitleInput(e: WechatMiniprogram.Input) {
    if (this.unloaded || !this.data.showAdd || this.data.submitting) return
    this.setData({ titleDraft: e.detail.value })
  },

  onPickDate(e: WechatMiniprogram.PickerChange) {
    if (this.unloaded || !this.data.showAdd || this.data.submitting) return
    this.setData({ dateDraft: String(e.detail.value) })
  },

  async onSubmitAdd() {
    if (this.unloaded || !this.data.showAdd || this.data.submitting) return
    const title = this.data.titleDraft.trim()
    if (!title) {
      wx.showToast({ title: '写个名称', icon: 'none' })
      return
    }
    const date = this.data.dateDraft
    const previous = this.pendingAdd
    const requestId = previous?.title === title && previous.date === date
      ? previous.requestId
      : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
    this.pendingAdd = { title, date, requestId }
    this.setData({ submitting: true, saveUnconfirmed: false })
    try {
      const saved = await addAnniversary({ title, date, yearly: true, remind: false, requestId })
      if (this.unloaded) return
      this.pendingAdd = null
      const list = [...this.data.list.filter(item => item.id !== saved.id), anniversaryView(saved)].sort(compareAnniversaries)
      this.setData({ list, empty: false, showAdd: false, titleDraft: '', dateDraft: '' })
      wx.showToast({ title: '已添加', icon: 'success' })
    } catch (err) {
      if (this.unloaded) return
      this.setData({ saveUnconfirmed: true })
      const msg = err instanceof Error ? err.message : '添加失败'
      wx.showToast({ title: msg, icon: 'none' })
      return
    } finally {
      if (!this.unloaded) this.setData({ submitting: false })
    }
    await this.refresh()
  },

  async onDelete(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    if (this.unloaded || this.deleting || !this.data.list.some(item => item.id === id)) return
    this.deleting = true
    try {
      const confirmed = await new Promise<boolean>(resolve => {
        this.cancelDeleteConfirmation = () => resolve(false)
        wx.showModal({
          title: '删除这个纪念日？',
          success: result => resolve(result.confirm),
          fail: () => resolve(false),
        })
      })
      this.cancelDeleteConfirmation = undefined
      if (!confirmed || this.unloaded || !this.data.list.some(item => item.id === id)) return
      await deleteAnniversary(id)
      if (this.unloaded) return
      const list = this.data.list.filter(item => item.id !== id)
      this.setData({ list, empty: list.length === 0 })
    } catch (err) {
      if (this.unloaded) return
      const msg = err instanceof Error ? err.message : '删除失败'
      wx.showToast({ title: msg, icon: 'none' })
      return
    } finally {
      this.cancelDeleteConfirmation = undefined
      this.deleting = false
    }
    await this.refresh()
  },
})
