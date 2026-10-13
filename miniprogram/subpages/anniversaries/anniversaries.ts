// subpages/anniversaries/anniversaries.ts

import { listAnniversaries, addAnniversary, deleteAnniversary } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { Anniversary } from '../../services/types'
import { getThemeStyle, syncTheme } from '../../services/theme'

interface AnnVO {
  id: string
  title: string
  date: string
  daysLeft: number
  label: string
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
    loading: true,
    loadError: '',
  },

  async onShow() {
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const d = new Date()
    const dateDraft = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    this.setData({ dateDraft })
    await this.refresh()
  },

  async refresh() {
    this.setData({ loading: true, loadError: '' })
    try {
      const list = await listAnniversaries()
      const items: AnnVO[] = list.map((a: Anniversary) => ({
        id: a.id,
        title: a.title,
        date: a.date,
        daysLeft: a.daysLeft ?? 0,
        label: (a.daysLeft ?? 0) === 0 ? '就是今天' : `还有 ${a.daysLeft} 天`,
      }))
      items.sort((x, y) => x.daysLeft - y.daysLeft)
      this.setData({ list: items, empty: items.length === 0 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ loadError: msg })
    } finally {
      this.setData({ loading: false })
    }
  },

  onToggleAdd() {
    this.setData({ showAdd: !this.data.showAdd, titleDraft: '' })
  },

  onTitleInput(e: WechatMiniprogram.Input) {
    this.setData({ titleDraft: e.detail.value })
  },

  onPickDate(e: WechatMiniprogram.PickerChange) {
    this.setData({ dateDraft: String(e.detail.value) })
  },

  async onSubmitAdd() {
    if (this.data.submitting) return
    const title = this.data.titleDraft.trim()
    if (!title) {
      wx.showToast({ title: '写个名称', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await addAnniversary({ title, date: this.data.dateDraft, yearly: true, remind: false })
      this.setData({ showAdd: false, titleDraft: '' })
      wx.showToast({ title: '已添加', icon: 'success' })
      await this.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '添加失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onDelete(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.showModal({
      title: '删除这个纪念日？',
      success: async res => {
        if (!res.confirm) return
        try {
          await deleteAnniversary(id)
          await this.refresh()
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },
})
