// pages/anniversaries/anniversaries.ts

import { listAnniversaries, addAnniversary, deleteAnniversary } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { Anniversary } from '../../services/types'

interface AnnVO {
  id: string
  title: string
  date: string
  daysLeft: number
  label: string
}

Page({
  data: {
    list: [] as AnnVO[],
    empty: true,
    showAdd: false,
    titleDraft: '',
    dateDraft: '',
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const d = new Date()
    const dateDraft = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    this.setData({ dateDraft })
    await this.refresh()
  },

  async refresh() {
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
    const title = this.data.titleDraft.trim()
    if (!title) {
      wx.showToast({ title: '写个名称', icon: 'none' })
      return
    }
    try {
      await addAnniversary({ title, date: this.data.dateDraft, yearly: true, remind: true })
      this.setData({ showAdd: false, titleDraft: '' })
      wx.showToast({ title: '已添加', icon: 'success' })
      await this.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '添加失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onRemind() {
    wx.requestSubscribeMessage({
      tmplIds: [],
      fail: () => {},
      complete: () => {
        wx.showToast({
          title: '提醒需在公众平台配置模板 ID',
          icon: 'none',
          duration: 2800,
        })
      },
    })
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
