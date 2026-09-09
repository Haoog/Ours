// pages/moment-detail/moment-detail.ts —— 回忆详情 + 评论/爱心

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
import { markMomentsListStale } from '../../services/moments-list-state'

interface DetailVO {
  id: string
  md: string
  dow: string
  time: string
  content: string
  livePhotos: MomentLivePhoto[]
  images: string[]
  video: string
  videoCover: string
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
    loading: true,
    loadedImgs: {} as Record<string, boolean>,
    item: null as DetailVO | null,
    comments: [] as CommentVO[],
    commentDraft: '',
    commentSubmitting: false,
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
      this.setData({ found: false, loading: false })
      return
    }
    this.myRole = getIdentity().role
    await this.loadAll(id)
  },

  async loadAll(id: string) {
    this.setData({ loading: true, loadedImgs: {} })
    try {
      const m = await getMoment(id)
      if (!m) {
        this.setData({ found: false, loading: false })
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
      const videoCover = !isSystem && m.videoCover ? await toDisplayUrl(m.videoCover) : ''

      const item: DetailVO = {
        id: m.id,
        md: slate.md,
        dow: slate.dow,
        time,
        content: m.content,
        livePhotos,
        images,
        video,
        videoCover,
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

      // 预解析语音链接：首次点播不再等待换链
      if (!isSystem && item.voiceFileID) {
        resolveCloudUrl(item.voiceFileID)
          .then(url => {
            this.voiceUrl = url
          })
          .catch(() => undefined)
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
        loading: false,
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
      this.setData({ found: false, loading: false })
    }
  },

  onImgLoad(e: WechatMiniprogram.BaseEvent) {
    const src = e.currentTarget.dataset.src as string
    if (!src || this.data.loadedImgs[src]) return
    this.setData({ loadedImgs: { ...this.data.loadedImgs, [src]: true } })
  },

  onUnload() {
    this.stopVoice()
  },

  shareCard() {
    const item = this.data.item
    const title = (item?.content || '').trim().slice(0, 30) || '我们的一条回忆'
    const imageUrl = item?.images?.[0] || item?.livePhotos?.[0]?.cover || ''
    return { title, imageUrl }
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const { title, imageUrl } = this.shareCard()
    return {
      title,
      path: `/pages/moment-detail/moment-detail?id=${this.momentId}`,
      imageUrl,
    }
  },

  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent {
    const { title, imageUrl } = this.shareCard()
    return {
      title,
      query: `id=${this.momentId}`,
      imageUrl,
    }
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
    // 乐观更新：先即时反馈，失败再回滚
    const prevLiked = this.data.liked
    const prevCount = this.data.likeCount
    const nextLiked = !prevLiked
    this.setData({ liked: nextLiked, likeCount: Math.max(0, prevCount + (nextLiked ? 1 : -1)) })
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await toggleMomentLike(this.momentId)
      const liked = this.myRole === 'A' ? likes.likedByA : likes.likedByB
      this.setData({ liked, likeCount: likes.count })
    } catch (err) {
      this.setData({ liked: prevLiked, likeCount: prevCount })
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  onCommentInput(e: WechatMiniprogram.Input) {
    this.setData({ commentDraft: e.detail.value })
  },

  async onSubmitComment() {
    if (this.data.commentSubmitting) return
    const content = this.data.commentDraft.trim()
    if (!content) return
    this.setData({ commentSubmitting: true })
    try {
      const c = await addComment(this.momentId, content)
      wx.vibrateShort({ type: 'light' })
      // 直接追加，避免整页重载（评论/爱心/相邻都重拉）
      const vo: CommentVO = {
        id: c.id,
        content: c.content,
        author: c.authorRole === this.myRole ? '我' : '她',
        canDelete: c.authorRole === this.myRole,
      }
      this.setData({ commentDraft: '', comments: [...this.data.comments, vo] })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '发送失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ commentSubmitting: false })
    }
  },

  onDeleteComment(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    wx.showModal({
      title: '删除评论？',
      success: async res => {
        if (!res.confirm) return
        const prev = this.data.comments
        this.setData({ comments: prev.filter(c => c.id !== id) })
        try {
          await deleteComment(id)
        } catch (err) {
          this.setData({ comments: prev })
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
          markMomentsListStale()
          wx.navigateBack().catch(() => wx.switchTab({ url: '/pages/moments/moments' }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },
})
