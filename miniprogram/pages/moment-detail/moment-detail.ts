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
  setMomentLike,
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
import { invalidateCachedUrl } from '../../utils/cloud-url-cache'
import { markMomentsListStale } from '../../services/moments-list-state'
import { getThemeStyle, syncTheme } from '../../services/theme'

const PRIVATE_SHARE_CARD = {
  title: '打开 Ours 查看回忆',
  // Without an explicit cover, WeChat can use a screenshot of the detail page.
  imageUrl: '/assets/share-cover.png',
}

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
  voiceLoading: boolean
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
    themeStyle: getThemeStyle(),
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
    loadError: '',
    interactionError: '',
    mediaError: '',
    canEdit: false,
    liking: false,
  },

  audioCtx: null as WechatMiniprogram.InnerAudioContext | null,
  voiceAttempt: 0,
  momentId: '',
  filterTag: '' as MomentTag | '',
  myRole: 'A' as 'A' | 'B',
  loadRevision: 0,
  initialized: false,

  async onLoad(opt: Record<string, string>) {
    syncTheme(this)
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
    this.initialized = true
  },

  async onShow() {
    syncTheme(this)
    if (this.initialized && !this.data.loading) await this.loadAll(this.momentId)
  },

  async loadAll(id: string) {
    this.stopVoice()
    const revision = ++this.loadRevision
    this.setData({ loading: true, loadedImgs: {}, loadError: '', interactionError: '' })
    try {
      const m = await getMoment(id)
      if (revision !== this.loadRevision) return
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

      const [images, livePhotos, video, videoCover] = await Promise.all([
        isSystem ? Promise.resolve([]) : resolveMomentImages(m.images),
        isSystem ? Promise.resolve([]) : resolveMomentLivePhotos(m.livePhotos ?? []),
        !isSystem && m.videos?.[0] ? toDisplayUrl(m.videos[0]).catch(() => '') : Promise.resolve(''),
        !isSystem && m.videoCover ? toDisplayUrl(m.videoCover).catch(() => '') : Promise.resolve(''),
      ])
      if (revision !== this.loadRevision) return

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
        voiceLoading: false,
        imgCount: images.length,
        role: m.authorRole,
        author: m.authorRole === this.myRole ? '我' : 'TA',
        location: m.location?.name ?? '',
        tagLabel: tagLabel(m.tag),
        isSystem,
      }
      this.setData({
        found: true, loading: false, item, canInteract: !isSystem,
        canEdit: !isSystem && m.authorRole === this.myRole,
        comments: [], likeCount: 0, liked: false, prevId: '', nextId: '',
        mediaError: images.length < m.images.length || (!video && !!m.videos?.length) || livePhotos.some(photo => !photo.cover)
          ? '部分媒体暂时没能加载，点此重试' : '',
      })

      let comments: CommentVO[] = []
      let likeCount = 0
      let liked = false
      let prevId = ''
      let nextId = ''
      let navIndex = 0
      let navTotal = 0
      if (!isSystem) {
        const [commentsResult, likesResult, neighborsResult] = await Promise.allSettled([
          listComments(id),
          getMomentLikes(id),
          getMomentNeighbors(id, this.filterTag || undefined),
        ])
        if (revision !== this.loadRevision) return
        const clist = commentsResult.status === 'fulfilled' ? commentsResult.value : []
        const likes = likesResult.status === 'fulfilled' ? likesResult.value : { likedByA: false, likedByB: false, count: 0 }
        const neighbors = neighborsResult.status === 'fulfilled' ? neighborsResult.value : { prevId: null, nextId: null, index: 0, total: 0 }
        this.setData({ interactionError: [commentsResult, likesResult, neighborsResult].some(result => result.status === 'rejected') ? '部分信息未加载，点此重试' : '' })
        comments = clist.map((c: MomentComment) => ({
          id: c.id,
          content: c.content,
          author: c.authorRole === this.myRole ? '我' : 'TA',
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
    } catch (err) {
      if (revision !== this.loadRevision) return
      this.setData({ found: false, loading: false, loadError: err instanceof Error ? err.message : '加载失败，请重试' })
    }
  },

  onImgLoad(e: WechatMiniprogram.BaseEvent) {
    const src = e.currentTarget.dataset.src as string
    if (!src || this.data.loadedImgs[src]) return
    this.setData({ loadedImgs: { ...this.data.loadedImgs, [src]: true } })
  },

  onUnload() {
    this.loadRevision++
    this.stopVoice()
  },

  onHide() {
    this.stopVoice()
  },

  onRetry() {
    void this.loadAll(this.momentId)
  },

  onTapEdit() {
    if (this.data.canEdit) wx.navigateTo({ url: `/pages/compose/compose?id=${this.momentId}` })
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      ...PRIVATE_SHARE_CARD,
      path: `/pages/moment-detail/moment-detail?id=${encodeURIComponent(this.momentId)}`,
    }
  },

  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent {
    return {
      ...PRIVATE_SHARE_CARD,
      query: `id=${encodeURIComponent(this.momentId)}`,
    }
  },

  async goNeighbor(direction: 'prev' | 'next') {
    const target = direction === 'prev' ? this.data.prevId : this.data.nextId
    if (!target || this.data.loading) return
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
    if (!item?.voiceFileID || this.data.loading) return
    if (item.voicePlaying || item.voiceLoading) {
      this.stopVoice()
      return
    }
    const fileID = item.voiceFileID
    const attempt = ++this.voiceAttempt
    this.setData({ 'item.voiceLoading': true })
    const current = () => attempt === this.voiceAttempt

    const showFailure = () => {
      if (!current()) return
      this.stopVoice()
      wx.showToast({ title: '语音播放失败，请重试', icon: 'none' })
    }

    const play = (src: string, onFailure: () => void) => {
      const audio = wx.createInnerAudioContext()
      this.audioCtx = audio
      const active = () => current() && this.audioCtx === audio
      const fail = () => {
        if (!active()) return
        this.audioCtx = null
        audio.destroy()
        onFailure()
      }
      audio.onPlay(() => {
        if (active()) this.setData({ 'item.voiceLoading': false, 'item.voicePlaying': true })
      })
      audio.onEnded(() => {
        if (active()) this.stopVoice()
      })
      audio.onError(fail)
      try {
        audio.src = src
        audio.play()
      } catch {
        fail()
      }
    }

    const playLocal = async () => {
      if (!current()) return
      if (!fileID.startsWith('cloud://')) return showFailure()
      this.setData({ 'item.voiceLoading': true, 'item.voicePlaying': false })
      try {
        const { tempFilePath } = await wx.cloud.downloadFile({ fileID })
        if (!current()) return
        if (!tempFilePath) return showFailure()
        play(tempFilePath, showFailure)
      } catch {
        showFailure()
      }
    }

    try {
      const url = await resolveCloudUrl(fileID)
      if (!current()) return
      if (url) play(url, () => { invalidateCachedUrl(fileID); void playLocal() })
      else await playLocal()
    } catch {
      await playLocal()
    }
  },

  stopVoice() {
    this.voiceAttempt++
    const audio = this.audioCtx
    this.audioCtx = null
    audio?.destroy()
    if (this.data.item?.voicePlaying || this.data.item?.voiceLoading) {
      this.setData({ 'item.voicePlaying': false, 'item.voiceLoading': false })
    }
  },

  async onToggleLike() {
    if (!this.data.canInteract || this.data.liking) return
    const id = this.momentId
    this.setData({ liking: true })
    // 乐观更新：先即时反馈，失败再回滚
    const prevLiked = this.data.liked
    const prevCount = this.data.likeCount
    const nextLiked = !prevLiked
    this.setData({ liked: nextLiked, likeCount: Math.max(0, prevCount + (nextLiked ? 1 : -1)) })
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await setMomentLike(id, nextLiked)
      markMomentsListStale()
      if (id !== this.momentId) return
      const liked = this.myRole === 'A' ? likes.likedByA : likes.likedByB
      this.setData({ liked, likeCount: likes.count })
    } catch (err) {
      if (id !== this.momentId) return
      this.setData({ liked: prevLiked, likeCount: prevCount })
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ liking: false })
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
    const momentId = this.momentId
    try {
      const c = await addComment(momentId, content)
      markMomentsListStale()
      if (momentId !== this.momentId) return
      wx.vibrateShort({ type: 'light' })
      // 直接追加，避免整页重载（评论/爱心/相邻都重拉）
      const vo: CommentVO = {
        id: c.id,
        content: c.content,
        author: c.authorRole === this.myRole ? '我' : 'TA',
        canDelete: c.authorRole === this.myRole,
      }
      this.setData({ commentDraft: '', comments: [...this.data.comments, vo] })
    } catch (err) {
      if (momentId !== this.momentId) return
      const msg = err instanceof Error ? err.message : '发送失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ commentSubmitting: false })
    }
  },

  onDeleteComment(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const momentId = this.momentId
    wx.showModal({
      title: '删除评论？',
      success: async res => {
        if (!res.confirm || momentId !== this.momentId) return
        const index = this.data.comments.findIndex(c => c.id === id)
        const removed = this.data.comments[index]
        if (!removed) return
        this.setData({ comments: this.data.comments.filter(c => c.id !== id) })
        try {
          await deleteComment(id)
          markMomentsListStale()
        } catch (err) {
          if (momentId !== this.momentId) return
          const comments = [...this.data.comments]
          if (!comments.some(comment => comment.id === id)) comments.splice(Math.min(index, comments.length), 0, removed)
          this.setData({ comments })
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
        if (!res.confirm || this.momentId !== item.id) return
        try {
          this.stopVoice()
          await deleteMoment(item.id)
          markMomentsListStale()
          if (this.momentId !== item.id) return
          wx.navigateBack().catch(() => wx.switchTab({ url: '/pages/moments/moments' }))
        } catch (err) {
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        }
      },
    })
  },
})
