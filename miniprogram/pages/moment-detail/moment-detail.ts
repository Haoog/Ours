// pages/moment-detail/moment-detail.ts —— 放映 + 评论/爱心

import {
  getMoment,
  getIdentity,
  deleteMoment,
  resolveCloudUrl,
  listComments,
  addComment,
  deleteComment,
  getMomentLikes,
  toggleMomentLike,
  getMomentNeighbors,
} from '../../services/store'
import { MomentTag } from '../../services/types'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { formatSlate } from '../../services/format'
import { momentDisplayAt, isBackdatedMoment } from '../../utils/moment-time'
import { MomentLivePhoto, MomentComment } from '../../services/types'
import { tagLabel } from '../../utils/tags'
import { resolveMomentImages, resolveMomentLivePhotos, toDisplayUrl } from '../../utils/media-url'

interface DetailVO {
  id: string
  md: string
  dow: string
  time: string
  content: string
  livePhotos: MomentLivePhoto[]
  images: string[]
  video: string
  voiceFileID: string
  voiceDuration: number
  voicePlaying: boolean
  imgCount: number
  role: 'A' | 'B'
  author: string
  location: string
  tagLabel: string
  isSystem: boolean
}

interface CommentVO {
  id: string
  content: string
  author: string
  canDelete: boolean
}

Page({
  data: {
    found: false,
    item: null as DetailVO | null,
    comments: [] as CommentVO[],
    commentDraft: '',
    likeCount: 0,
    liked: false,
    canInteract: true,
    prevId: '',
    nextId: '',
    navIndex: 0,
    navTotal: 0,
  },

  audioCtx: null as WechatMiniprogram.InnerAudioContext | null,
  voiceUrl: '',
  momentId: '',
  filterTag: '' as MomentTag | '',
  myRole: 'A' as 'A' | 'B',

  async onLoad(opt: Record<string, string>) {
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return

    const id = opt.id
    this.momentId = id
    this.filterTag = (opt.tag ?? '') as MomentTag | ''
    if (!id) {
      this.setData({ found: false })
      return
    }
    this.myRole = getIdentity().role
    await this.loadAll(id)
  },

  async loadAll(id: string) {
    try {
      const m = await getMoment(id)
      if (!m) {
        this.setData({ found: false })
        return
      }
      const isSystem = m.kind === 'system'
      const displayAt = momentDisplayAt(m)
      const slate = formatSlate(displayAt)
      const d = new Date(m.createdAt)
      const time = isBackdatedMoment(m)
        ? '补记'
        : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

      const images = isSystem ? [] : await resolveMomentImages(m.images)
      const livePhotos = isSystem ? [] : await resolveMomentLivePhotos(m.livePhotos ?? [])
      const video = !isSystem && m.videos?.[0] ? await toDisplayUrl(m.videos[0]) : ''

      const item: DetailVO = {
        id: m.id,
        md: slate.md,
        dow: slate.dow,
        time,
        content: m.content,
        livePhotos,
        images,
        video,
        voiceFileID: m.voices?.[0]?.fileID ?? '',
        voiceDuration: m.voices?.[0]?.duration ?? 0,
        voicePlaying: false,
        imgCount: images.length,
        role: m.authorRole,
        author: m.authorRole === this.myRole ? '我' : '她',
        location: m.location?.name ?? '',
        tagLabel: tagLabel(m.tag),
        isSystem,
      }

      let comments: CommentVO[] = []
      let likeCount = 0
      let liked = false
      let prevId = ''
      let nextId = ''
      let navIndex = 0
      let navTotal = 0
      if (!isSystem) {
        const [clist, likes, neighbors] = await Promise.all([
          listComments(id),
          getMomentLikes(id),
          getMomentNeighbors(id, this.filterTag || undefined),
        ])
        comments = clist.map((c: MomentComment) => ({
          id: c.id,
          content: c.content,
          author: c.authorRole === this.myRole ? '我' : '她',
          canDelete: c.authorRole === this.myRole,
        }))
        likeCount = likes.count
        liked = this.myRole === 'A' ? likes.likedByA : likes.likedByB
        prevId = neighbors.prevId ?? ''
        nextId = neighbors.nextId ?? ''
        navIndex = neighbors.index
        navTotal = neighbors.total
      }

      this.setData({
        found: true,
        item,
        comments,
        likeCount,
        liked,
        canInteract: !isSystem,
        prevId,
        nextId,
        navIndex,
        navTotal,
      })
    } catch {
      this.setData({ found: false })
    }
  },

  onUnload() {
    this.stopVoice()
  },

  async goNeighbor(direction: 'prev' | 'next') {
    const target = direction === 'prev' ? this.data.prevId : this.data.nextId
    if (!target) return
    this.stopVoice()
    this.voiceUrl = ''
    this.momentId = target
    await this.loadAll(target)
  },

  onTapPrev() {
    this.goNeighbor('prev')
  },

  onTapNext() {
    this.goNeighbor('next')
  },

  onTapImage(e: WechatMiniprogram.BaseEvent) {
    const src = e.currentTarget.dataset.src as string
    const item = this.data.item
    if (!item) return
    wx.previewImage({ current: src, urls: item.images })
  },

  async onTapVoice() {
    const item = this.data.item
    if (!item?.voiceFileID) return
    if (item.voicePlaying) {
      this.stopVoice()
      return
    }
    try {
      if (!this.voiceUrl) {
        this.voiceUrl = await resolveCloudUrl(item.voiceFileID)
      }
      if (!this.audioCtx) {
        this.audioCtx = wx.createInnerAudioContext()
        this.audioCtx.onEnded(() => this.setData({ 'item.voicePlaying': false }))
        this.audioCtx.onStop(() => this.setData({ 'item.voicePlaying': false }))
      }
      this.audioCtx.src = this.voiceUrl
      this.audioCtx.play()
      this.setData({ 'item.voicePlaying': true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '播放失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  stopVoice() {
    if (this.audioCtx) this.audioCtx.stop()
    if (this.data.item) this.setData({ 'item.voicePlaying': false })
  },

  async onToggleLike() {
    if (!this.data.canInteract) return
    try {
      const likes = await toggleMomentLike(this.momentId)
      const liked = this.myRole === 'A' ? likes.likedByA : likes.likedByB
      this.setData({ liked, likeCount: likes.count })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onCommentInput(e: WechatMiniprogram.Input) {
    this.setData({ commentDraft: e.detail.value })
  },

  async onSubmitComment() {
    const content = this.data.commentDraft.trim()
    if (!content) return
    try {
      await addComment(this.momentId, content)
      this.setData({ commentDraft: '' })
      await this.loadAll(this.momentId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发送失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onDeleteComment(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.showModal({
      title: '删除评论？',
      success: async res => {
        if (!res.confirm) return
        try {
          await deleteComment(id)
          await this.loadAll(this.momentId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },

  onTapDelete() {
    const item = this.data.item
    if (!item || item.isSystem) return
    wx.showModal({
      title: '删除这条回忆？',
      content: '删了就找不回来了哦。',
      confirmText: '删除',
      cancelText: '保留',
      success: async res => {
        if (!res.confirm) return
        try {
          this.stopVoice()
          await deleteMoment(item.id)
          wx.navigateBack().catch(() => wx.switchTab({ url: '/pages/moments/moments' }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },
})
