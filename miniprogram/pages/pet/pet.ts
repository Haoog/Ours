// pages/pet/pet.ts — 双人养小猫

import { getPet, adoptPet, petInteract } from '../../services/store'
import { PetView } from '../../services/types'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'

Page({
  data: {
    loading: true,
    pet: null as PetView | null,
    nameDraft: '小咪',
    acting: false,
  },

  async onShow() {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    await this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      const pet = await getPet()
      this.setData({ pet, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ loading: false })
    }
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ nameDraft: e.detail.value })
  },

  async onAdopt() {
    if (this.data.acting) return
    const name = this.data.nameDraft.trim() || '小咪'
    this.setData({ acting: true })
    try {
      const pet = await adoptPet(name)
      wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: '小猫到家啦', icon: 'success' })
      this.setData({ pet })
      getAppInstance().bumpPet()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '领养失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ acting: false })
    }
  },

  async onInteract(e: WechatMiniprogram.BaseEvent) {
    const action = e.currentTarget.dataset.action as 'feed' | 'pet'
    if (this.data.acting) return
    this.setData({ acting: true })
    try {
      const pet = await petInteract(action)
      wx.vibrateShort({ type: 'light' })
      wx.showToast({
        title: action === 'feed' ? '喂食成功' : '抚摸成功',
        icon: 'success',
      })
      this.setData({ pet })
      getAppInstance().bumpPet()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ acting: false })
    }
  },
})
