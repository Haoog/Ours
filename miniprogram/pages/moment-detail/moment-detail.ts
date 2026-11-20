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
import { ensureCloudReadyState } from '../../services/page-boot'
import { formatSlate } from '../../services/format'
import { momentDisplayAt, isBackdatedMoment } from '../../utils/moment-time'
import { MomentLivePhoto, MomentComment } from '../../services/types'
import { tagLabel } from '../../utils/tags'
import { invalidateCachedUrl, peekCachedUrl, resolveCloudUrls } from '../../utils/cloud-url-cache'
import { markMomentsListStale } from '../../services/moments-list-state'
import { getThemeStyle, syncTheme } from '../../services/theme'

const PRIVATE_SHARE_CARD = {
  title: '打开 Ours 查看回忆',
  // Without an explicit cover, WeChat can use a screenshot of the detail page.
  imageUrl: '/assets/share-cover.png',
}

const MEDIA_ERROR = '部分媒体暂时没能加载，点此重试'

interface MediaView {
  src: string
  key: number
}

interface MediaSource extends MediaView {
  fileID: string
  failed: boolean
}

interface MediaState {
  revision: number
  images: MediaSource[]
  video: MediaSource
  videoCover: MediaSource
  livePhotos: { cover: MediaSource; video: string; duration: number }[]
  retrying: boolean
}

interface DetailVO {
  id: string
  md: string
  dow: string
  time: string
  content: string
  livePhotos: MomentLivePhoto[]
  images: MediaView[]
  videos: MediaView[]
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

interface CommentState {
  momentId: string
  changes: Map<string, CommentVO | null> | null
  pendingDeletes: Set<string>
  pendingSend?: { content: string; requestId: string; uncertain: boolean }
  deletedDuringSubmit?: Set<string>
}

interface LikeState {
  momentId: string
  writeRevision: number
  hasConfirmed: boolean
  confirmed: { liked: boolean; likeCount: number }
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    found: false,
    loading: true,
    loadedImgs: {} as Record<string, boolean>,
    item: null as DetailVO | null,
    comments: [] as CommentVO[],
    commentsStatus: 'loading' as 'loading' | 'ready' | 'empty' | 'error',
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
    likeUnavailable: false,
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
  mediaKey: 0,
  mediaState: null as MediaState | null,
  bootState: 'pending' as 'pending' | 'starting' | 'ready' | 'redirecting' | 'unloaded',
  commentState: null as CommentState | null,
  likeState: null as LikeState | null,
  failedInteractions: { likes: false, neighbors: false },
  openerChannel: null as WechatMiniprogram.EventChannel | null,
  timelineLikeListener: null as ((id: string, liked: boolean, likeCount: number) => void) | null,

  async onLoad(opt: Record<string, string | undefined>): Promise<void> {
    this.momentId = opt.id ?? ''
    this.filterTag = (opt.tag ?? '') as MomentTag | ''
    this.bootState = 'pending'
    this.openerChannel = this.getOpenerEventChannel?.() ?? null
    this.timelineLikeListener = (id, liked, likeCount) => {
      const state = this.likeState
      if (!state || state.momentId !== id) return
      state.writeRevision++
      state.hasConfirmed = true
      state.confirmed = { liked, likeCount }
      this.setData({ likeUnavailable: false, ...(!this.data.liking ? state.confirmed : {}) })
    }
    this.openerChannel?.on('timelineLikeChanged', this.timelineLikeListener)
    syncTheme(this)
    if (!this.momentId) {
      this.setData({ found: false, loading: false, loadError: '' })
      return
    }
    return this.loadPage()
  },

  async onShow(): Promise<void> {
    if (this.bootState === 'unloaded') return
    syncTheme(this)
    if (this.bootState === 'ready' && this.data.loading) return
    return this.loadPage()
  },

  async loadPage(): Promise<void> {
    if (!this.momentId) return
    if (this.bootState === 'ready') return this.loadAll(this.momentId)
    if (this.bootState !== 'pending') return

    const revision = this.loadRevision
    this.bootState = 'starting'
    this.setData({ loading: true, loadError: '' })
    const state = await ensureCloudReadyState().catch(() => 'offline')
    if (revision !== this.loadRevision) return
    if (state === 'redirecting') {
      this.bootState = 'redirecting'
      return
    }
    if (state === 'offline') {
      this.bootState = 'pending'
      this.setData({ found: false, loading: false, loadError: '暂时连不上，请稍后重试' })
      return
    }
    this.myRole = getIdentity().role
    const opening = this.loadAll(this.momentId)
    const openingRevision = this.loadRevision
    await opening
    if (openingRevision === this.loadRevision) this.bootState = 'ready'
  },

  async loadAll(id: string) {
    this.stopVoice()
    const revision = ++this.loadRevision
    const resetComments = this.commentState?.momentId !== id
    if (!this.commentState || resetComments) {
      this.commentState = { momentId: id, changes: null, pendingDeletes: new Set() }
    }
    if (this.likeState?.momentId !== id) {
      this.likeState = { momentId: id, writeRevision: 0, hasConfirmed: false, confirmed: { liked: false, likeCount: 0 } }
      this.setData({ ...this.likeState.confirmed, liking: false })
    }
    const likeState = this.likeState
    this.failedInteractions = { likes: false, neighbors: false }
    const commentState = this.commentState
    // 快照返回时合并本次加载期间完成的评论操作。
    const changes = new Map<string, CommentVO | null>()
    commentState.changes = changes
    this.setData({
      loading: true, loadError: '', interactionError: '',
      likeUnavailable: !resetComments && this.data.likeUnavailable, commentsStatus: 'loading',
      ...(resetComments ? { comments: [], commentDraft: '', commentSubmitting: false } : {}),
    })
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

      const source = (fileID: string): MediaSource => ({ fileID, src: '', key: 0, failed: !!fileID })
      const media: MediaState = {
        revision,
        images: isSystem ? [] : m.images.map(source),
        video: source(isSystem ? '' : m.videos?.[0] ?? ''),
        videoCover: source(isSystem ? '' : m.videoCover ?? ''),
        livePhotos: isSystem ? [] : (m.livePhotos ?? []).map(photo => ({ ...photo, cover: source(photo.cover) })),
        retrying: false,
      }
      await this.resolveMedia(media)
      if (revision !== this.loadRevision) return
      this.mediaState = media

      const item: DetailVO = {
        id: m.id,
        md: slate.md,
        dow: slate.dow,
        time,
        content: m.content,
        ...this.mediaView(media),
        voiceFileID: m.voices?.[0]?.fileID ?? '',
        voiceDuration: m.voices?.[0]?.duration ?? 0,
        voicePlaying: false,
        voiceLoading: false,
        role: m.authorRole,
        author: m.authorRole === this.myRole ? '我' : 'TA',
        location: m.location?.name ?? '',
        tagLabel: tagLabel(m.tag),
        isSystem,
      }
      this.setData({
        found: true, loading: false, item, canInteract: !isSystem,
        canEdit: !isSystem && m.authorRole === this.myRole,
        ...(isSystem ? { comments: [] } : {}),
        prevId: '', nextId: '', navIndex: 0, navTotal: 0,
        loadedImgs: {}, mediaError: this.mediaErrorText(media),
      })

      if (!isSystem) {
        await Promise.all([
          this.loadComments(commentState, revision, changes),
          this.loadInteractions(likeState, revision, { likes: true, neighbors: true }),
        ])
      }
    } catch (err) {
      if (revision !== this.loadRevision) return
      this.setData({ found: false, loading: false, loadError: err instanceof Error ? err.message : '加载失败，请重试' })
    } finally {
      if (commentState.changes === changes) commentState.changes = null
    }
  },

  async loadInteractions(state: LikeState, revision: number, requested: { likes: boolean; neighbors: boolean }) {
    const isCurrent = () => revision === this.loadRevision && state === this.likeState
    const failed = this.failedInteractions
    const showFailures = () => {
      if (!isCurrent()) return
      this.setData({
        interactionError: failed.likes || failed.neighbors ? '部分信息未加载，点此重试' : '',
        likeUnavailable: (failed.likes || this.data.likeUnavailable) && !state.hasConfirmed,
      })
    }
    const writeRevision = state.writeRevision
    await Promise.all([
      requested.likes && getMomentLikes(state.momentId).then(likes => {
        if (!isCurrent() || writeRevision !== state.writeRevision) return
        state.hasConfirmed = true
        state.confirmed = { liked: this.myRole === 'A' ? likes.likedByA : likes.likedByB, likeCount: likes.count }
        this.setData({ likeUnavailable: false, ...(!this.data.liking ? state.confirmed : {}) })
      }).catch(() => {
        if (!isCurrent() || writeRevision !== state.writeRevision) return
        failed.likes = true
        showFailures()
      }),
      requested.neighbors && getMomentNeighbors(state.momentId, this.filterTag || undefined).then(neighbors => {
        if (!isCurrent()) return
        this.setData({ prevId: neighbors.prevId ?? '', nextId: neighbors.nextId ?? '', navIndex: neighbors.index, navTotal: neighbors.total })
      }).catch(() => {
        failed.neighbors = true
        showFailures()
      }),
    ])
    showFailures()
  },

  async onRetryInteractions() {
    const failed = this.failedInteractions
    const state = this.likeState
    if (!state || (!failed.likes && !failed.neighbors) || this.data.loading) return
    const requested = { ...failed }
    failed.likes = false
    failed.neighbors = false
    this.setData({ interactionError: '' })
    await this.loadInteractions(state, this.loadRevision, requested)
  },

  async loadComments(state: CommentState, revision: number, changes: Map<string, CommentVO | null>) {
    const isCurrent = () => revision === this.loadRevision && state === this.commentState && changes === state.changes
    try {
      const result = await listComments(state.momentId)
      if (!isCurrent()) return
      const snapshot = new Map(result.map(comment => [comment.id, this.toCommentVO(comment)]))
      for (const [id, comment] of changes) {
        if (comment) snapshot.set(id, comment)
        else snapshot.delete(id)
      }
      for (const id of state.pendingDeletes) snapshot.delete(id)
      this.setData({
        comments: [...snapshot.values()],
        commentsStatus: snapshot.size === 0 && state.pendingDeletes.size === 0 ? 'empty' : 'ready',
      })
    } catch {
      if (isCurrent()) this.setData({ commentsStatus: 'error' })
    } finally {
      if (changes === state.changes) state.changes = null
    }
  },

  async onRetryComments() {
    const state = this.commentState
    if (!state || this.data.loading || this.data.commentsStatus !== 'error' ||
      !this.data.found || !this.data.canInteract || this.data.item?.id !== state.momentId) return
    const changes = new Map<string, CommentVO | null>()
    state.changes = changes
    this.setData({ commentsStatus: 'loading' })
    await this.loadComments(state, this.loadRevision, changes)
  },

  async resolveMedia(media: MediaState) {
    const pending = [media.video, media.videoCover, ...media.images, ...media.livePhotos.map(photo => photo.cover)]
      .filter(source => source.failed)
    if (!pending.length) return
    const fileIDs = [...new Set(pending.map(source => source.fileID))]
    const urls = await resolveCloudUrls(fileIDs).catch((): Record<string, string> => ({}))
    if (media.revision !== this.loadRevision) return
    for (const source of pending) {
      const src = urls[source.fileID]
      if (!src) continue
      source.src = src
      source.key = ++this.mediaKey
      source.failed = false
    }
  },

  mediaView(media: MediaState) {
    const view = ({ src, key }: MediaSource): MediaView => ({ src, key })
    const images = media.images.filter(image => image.src).map(view)
    return {
      images,
      imgCount: images.length,
      videos: media.video.src ? [view(media.video)] : [],
      videoCover: media.videoCover.src,
      livePhotos: media.livePhotos.map(photo => ({ ...photo, cover: photo.cover.src })),
    }
  },

  mediaErrorText(media: MediaState) {
    return media.video.failed || media.images.some(image => !image.src || image.failed) ||
      media.livePhotos.some(photo => !photo.cover.src) ? MEDIA_ERROR : ''
  },

  currentMedia() {
    const media = this.mediaState
    return media?.revision === this.loadRevision && this.data.found && this.data.item?.id === this.momentId ? media : null
  },

  onImgLoad(e: WechatMiniprogram.BaseEvent) {
    const { key, src } = e.currentTarget.dataset
    const image = this.currentMedia()?.images.find(image => image.key === key && image.src === src)
    if (!image || image.failed || this.data.loadedImgs[key]) return
    this.setData({ loadedImgs: { ...this.data.loadedImgs, [key]: true } })
  },

  onMediaError(e: WechatMiniprogram.ImageError | WechatMiniprogram.VideoError) {
    const media = this.currentMedia()
    if (!media) return
    const { key, src } = e.currentTarget.dataset
    const source = [media.video, ...media.images].find(source => source.key === key && source.src === src)
    if (!source?.src || source.failed) return
    source.failed = true
    if (source.fileID.startsWith('cloud://') && peekCachedUrl(source.fileID) === src) {
      invalidateCachedUrl(source.fileID)
    }
    const loadedImgs = { ...this.data.loadedImgs }
    delete loadedImgs[key]
    this.setData({ mediaError: MEDIA_ERROR, loadedImgs })
  },

  async onRetryMedia() {
    const media = this.currentMedia()
    if (!media || media.retrying || !this.data.mediaError) return
    media.retrying = true
    try {
      await this.resolveMedia(media)
      if (media !== this.currentMedia()) return
      const { images, imgCount, videos, videoCover, livePhotos } = this.mediaView(media)
      this.setData({
        'item.images': images, 'item.imgCount': imgCount, 'item.videos': videos,
        'item.videoCover': videoCover, 'item.livePhotos': livePhotos,
        mediaError: this.mediaErrorText(media),
      })
    } finally {
      media.retrying = false
    }
  },

  onUnload() {
    this.loadRevision++
    this.mediaState = null
    this.commentState = null
    this.likeState = null
    this.bootState = 'unloaded'
    if (this.timelineLikeListener) this.openerChannel?.off('timelineLikeChanged', this.timelineLikeListener)
    this.openerChannel?.emit('momentDetailClosed')
    this.openerChannel = null
    this.timelineLikeListener = null
    this.stopVoice()
  },

  onHide() {
    this.stopVoice()
  },

  async onRetry(): Promise<void> {
    return this.loadPage()
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
    wx.previewImage({ current: src, urls: item.images.map(image => image.src) })
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
    const state = this.likeState
    if (!state || this.data.item?.id !== state.momentId || !this.data.found || !this.data.canInteract || this.data.loading || this.data.liking || this.data.likeUnavailable) return
    // 乐观更新：先即时反馈，失败时恢复最近确认的状态。
    const initiator = this.openerChannel
    const role = this.myRole
    const nextLiked = !state.confirmed.liked
    const likeCount = Math.max(0, state.confirmed.likeCount + (nextLiked ? 1 : -1))
    this.setData({ liking: true, liked: nextLiked, likeCount })
    wx.vibrateShort({ type: 'light' })
    try {
      const likes = await setMomentLike(state.momentId, nextLiked)
      markMomentsListStale()
      const liked = role === 'A' ? likes.likedByA : likes.likedByB
      initiator?.emit('momentLikeChanged', state.momentId, liked, likes.count)
      if (state !== this.likeState) return
      state.writeRevision++
      state.hasConfirmed = true
      if (this.data.likeUnavailable) this.setData({ likeUnavailable: false })
      state.confirmed = { liked, likeCount: likes.count }
      this.setData(state.confirmed)
    } catch (err) {
      if (state !== this.likeState) return
      this.setData(state.confirmed)
      const msg = err instanceof Error ? err.message : '操作失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      if (state === this.likeState) this.setData({ liking: false })
    }
  },

  toCommentVO(c: MomentComment): CommentVO {
    return {
      id: c.id,
      content: c.content,
      author: c.authorRole === this.myRole ? '我' : 'TA',
      canDelete: c.authorRole === this.myRole,
    }
  },

  onCommentInput(e: WechatMiniprogram.Input) {
    const state = this.commentState
    if (!state || this.data.item?.id !== state.momentId) return
    const commentDraft = e.detail.value
    if (state.pendingSend && state.pendingSend.content !== commentDraft.trim()) state.pendingSend = undefined
    this.setData({ commentDraft })
  },

  async onSubmitComment() {
    const state = this.commentState
    if (!state || this.data.item?.id !== state.momentId || !this.data.canInteract || this.data.commentSubmitting) return
    const content = this.data.commentDraft.trim()
    if (!content) return
    const submission = state.pendingSend?.content === content ? state.pendingSend : {
      content, requestId: `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`, uncertain: false,
    }
    state.pendingSend = submission
    const deletedDuringSubmit = new Set<string>()
    state.deletedDuringSubmit = deletedDuringSubmit
    this.setData({ commentSubmitting: true })
    try {
      const c = await addComment(state.momentId, content, submission.requestId)
      markMomentsListStale()
      if (state !== this.commentState) return
      if (state.pendingSend === submission) {
        state.pendingSend = undefined
        if (this.data.commentDraft.trim() === content) this.setData({ commentDraft: '' })
      }
      wx.vibrateShort({ type: 'light' })
      if (state.pendingDeletes.has(c.id) || deletedDuringSubmit.has(c.id)) return
      const vo = this.toCommentVO(c)
      state.changes?.set(c.id, vo)
      const comments = this.data.comments
      if (!comments.some(comment => comment.id === c.id)) {
        this.setData({
          comments: [...comments, vo],
          ...(this.data.commentsStatus === 'empty' ? { commentsStatus: 'ready' as const } : {}),
        })
      }
    } catch (err) {
      if (state !== this.commentState) return
      if (!(err as { commentRejected?: boolean })?.commentRejected) submission.uncertain = true
      // 先前结果不明时，本次拒绝无法排除之前已经写入。
      if (!submission.uncertain && state.pendingSend === submission) state.pendingSend = undefined
      const msg = err instanceof Error ? err.message : '发送失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      state.deletedDuringSubmit = undefined
      if (state === this.commentState) this.setData({ commentSubmitting: false })
    }
  },

  onDeleteComment(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const state = this.commentState
    if (!state || this.data.item?.id !== state.momentId || !this.data.canInteract) return
    wx.showModal({
      title: '删除评论？',
      success: async res => {
        if (!res.confirm || state !== this.commentState || state.pendingDeletes.has(id)) return
        const index = this.data.comments.findIndex(c => c.id === id)
        const removed = this.data.comments[index]
        if (!removed) return
        state.pendingDeletes.add(id)
        this.setData({ comments: this.data.comments.filter(c => c.id !== id) })
        try {
          await deleteComment(id)
          state.changes?.set(id, null)
          state.deletedDuringSubmit?.add(id)
          markMomentsListStale()
        } catch (err) {
          if (state !== this.commentState) return
          state.changes?.set(id, removed)
          const comments = [...this.data.comments]
          if (!comments.some(comment => comment.id === id)) comments.splice(Math.min(index, comments.length), 0, removed)
          this.setData({ comments })
          const msg = err instanceof Error ? err.message : '删除失败'
          wx.showToast({ title: msg, icon: 'none' })
        } finally {
          state.pendingDeletes.delete(id)
          if (state === this.commentState && this.data.commentsStatus === 'ready' &&
            this.data.comments.length === 0 && state.pendingDeletes.size === 0) {
            this.setData({ commentsStatus: 'empty' })
          }
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
