// pages/interact/interact.ts — 吐槽墙 + 小纸条

import {
  listRants,
  addRant,
  deleteRant,
  listNotes,
  sendNote,
  markNoteRead,
  getIdentity,
  getCouple,
} from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { formatSlate } from '../../services/format'
import { Rant, LoveNote } from '../../services/types'

interface RantVO {
  id: string
  content: string
  author: string
  md: string
  canDelete: boolean
}

interface NoteVO {
  id: string
  content: string
  sub: string
  isUnread: boolean
  isMine: boolean
}

Page({
  data: {
    pageReady: false,
    loadError: '',
    tab: 'rant' as 'rant' | 'note',
    rants: [] as RantVO[],
    notes: [] as NoteVO[],
    emptyRant: true,
    emptyNote: true,
    bound: false,
    composeOpen: false,
    composeDraft: '',
    noteUnread: 0,
  },

  myRole: 'A' as 'A' | 'B',

  async onShow() {
    this.setData({ pageReady: false, loadError: '' })
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) {
      this.setData({ pageReady: true })
      return
    }
    try {
      this.myRole = getIdentity().role
      this.setData({ bound: !!getCouple()?.memberB })
      await this.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      this.setData({ loadError: msg })
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ pageReady: true })
    }
  },

  onRetryLoad() {
    this.onShow()
  },

  async refresh() {
    if (this.data.tab === 'rant') await this.loadRants()
    else await this.loadNotes()
  },

  async loadRants() {
    try {
      const list = await listRants()
      const rows = Array.isArray(list) ? list : []
      const rants: RantVO[] = rows.map((r: Rant) => ({
        id: r.id,
        content: r.content,
        author: r.authorRole === this.myRole ? '我' : '她',
        md: formatSlate(r.createdAt).md,
        canDelete: true,
      }))
      this.setData({ rants, emptyRant: rants.length === 0 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async loadNotes() {
    try {
      const list = await listNotes()
      const rows = Array.isArray(list) ? list : []
      const notes: NoteVO[] = rows.map((n: LoveNote) => ({
        id: n.id,
        content: n.content,
        sub: n.isMine ? `我发给她的 · ${formatSlate(n.createdAt).md}` : `她发来的 · ${formatSlate(n.createdAt).md}`,
        isUnread: !!n.isUnread,
        isMine: !!n.isMine,
      }))
      const noteUnread = notes.filter(n => n.isUnread).length
      this.setData({ notes, emptyNote: notes.length === 0, noteUnread })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onSwitchTab(e: WechatMiniprogram.BaseEvent) {
    const tab = e.currentTarget.dataset.tab as 'rant' | 'note'
    if (tab === this.data.tab) return
    this.setData({ tab, composeOpen: false })
    this.refresh()
  },

  openCompose() {
    if (this.data.tab === 'note' && !this.data.bound) {
      wx.showToast({ title: '她加入后才能发小纸条', icon: 'none' })
      return
    }
    this.setData({
      composeOpen: true,
      composeDraft: '',
    })
  },

  closeCompose() {
    this.setData({ composeOpen: false })
  },

  onComposeInput(e: WechatMiniprogram.Input) {
    this.setData({ composeDraft: e.detail.value })
  },

  onSubmitCompose() {
    if (this.data.tab === 'rant') this.onSubmitRant()
    else this.onSubmitNote()
  },

  async onSubmitRant() {
    const content = this.data.composeDraft.trim()
    if (!content) {
      wx.showToast({ title: '写点啥再发', icon: 'none' })
      return
    }
    try {
      await addRant(content, [])
      this.setData({ composeOpen: false, composeDraft: '' })
      wx.showToast({ title: '已发布', icon: 'success' })
      await this.loadRants()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发布失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async onSubmitNote() {
    const content = this.data.composeDraft.trim()
    if (!content) {
      wx.showToast({ title: '写点啥再发', icon: 'none' })
      return
    }
    try {
      await sendNote(content)
      this.setData({ composeOpen: false, composeDraft: '' })
      wx.showToast({ title: '已发送', icon: 'success' })
      await this.loadNotes()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发送失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onDeleteRant(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.showModal({
      title: '删除这条吐槽？',
      success: async res => {
        if (!res.confirm) return
        try {
          await deleteRant(id)
          await this.loadRants()
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },

  async onTapNote(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const note = this.data.notes.find(n => n.id === id)
    if (note?.isUnread) {
      try {
        await markNoteRead(id)
        await this.loadNotes()
      } catch {
        /* ignore */
      }
    }
  },
})
