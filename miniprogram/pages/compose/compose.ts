import { resolveCloudUrl } from '../../utils/cloud-url-cache'
// pages/compose/compose.ts —— 发布动态（图文 / 视频 / 语音 / 实况）

import { addMoment, getMoment, updateMoment, getCouple, getIdentity, listMomentsPage, cancelMomentUpload } from '../../services/store'
import { clearComposeDraft, newPublishId, readComposeDraft, saveComposeDraft, waitForComposeDraftSave, ComposeDraft, EditDraftFields } from '../../services/compose-draft'
import { todayKey } from '../../services/date'
import { getSession } from '../../services/session'
import { formatMomentDateLabel } from '../../utils/moment-time'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { markMomentsListStale } from '../../services/moments-list-state'
import { feedCacheKey, prefetchMomentsFeed } from '../../services/moments-feed-cache'
import { MomentLocation, MomentTag } from '../../services/types'
import { MOMENT_TAG_POST } from '../../utils/tags'
import { canUseAsLivePhoto, isRegularVideoFile } from '../../utils/live-photo'
import { getThemeStyle, syncTheme } from '../../services/theme'

const pendingSubmissions = new Map<string, Promise<void>>()

const editFieldNames = ['content', 'tagSelected', 'momentDate', 'locationFull'] as const

type PublishDraft = ComposeDraft & {
  publishCorrection?: boolean
  pendingMediaReceipts?: string[]
  existingMomentId?: string
}

function latestAllowedMomentDate(): string {
  // 回忆日期的上限与云端校验一致，按 UTC+8 的日历日计算。
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
}

function sameEditField(a: EditDraftFields, b: EditDraftFields, field: typeof editFieldNames[number]): boolean {
  if (field !== 'locationFull') return a[field] === b[field]
  const left = a.locationFull
  const right = b.locationFull
  return left && right
    ? left.name === right.name && left.address === right.address && left.latitude === right.latitude && left.longitude === right.longitude
    : left === right
}

const PICK_BATCH = 20
// 微信 RecorderManager 单条录音最长支持 600 秒；语音无法像文字一样真正无限。
const MAX_VOICE_SEC = 600

type RecordingCallbacks = {
  started: () => void
  stopped: WechatMiniprogram.RecorderManagerOnStopCallback
  failed: (error: unknown) => void
}

// RecorderManager is shared across pages and its listeners cannot be removed.
let recorderManager: WechatMiniprogram.RecorderManager | undefined
let activeRecording: RecordingCallbacks | undefined

function getVoiceRecorder() {
  if (recorderManager) return recorderManager
  const recorder = wx.getRecorderManager()
  recorder.onStart(() => activeRecording?.started())
  recorder.onStop(result => {
    const recording = activeRecording
    activeRecording = undefined
    recording?.stopped(result)
  })
  recorder.onError(error => {
    const recording = activeRecording
    activeRecording = undefined
    recording?.failed(error)
  })
  recorderManager = recorder
  return recorder
}

interface VoiceDraft {
  path: string
  duration: number
}

interface LivePhotoDraft {
  id: string
  cover: string
  video: string
  duration: number
}

interface ImageDragState {
  index: number
  gridLeft: number
  gridTop: number
  cellSize: number
  gap: number
  active: boolean
}

function touchPoint(e: WechatMiniprogram.TouchEvent): { x: number; y: number } | null {
  const touch = e.touches[0] ?? e.changedTouches[0]
  if (!touch) return null
  return { x: touch.clientX, y: touch.clientY }
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    content: '',
    images: [] as string[],
    livePhotos: [] as LivePhotoDraft[],
    video: '' as string,
    videoCover: '' as string,
    voice: null as VoiceDraft | null,
    voicePlaying: false,
    voiceLoading: false,
    recording: false,
    recordPending: false,
    recordSec: 0,
    location: '' as string,
    locationFull: null as MomentLocation | null,
    role: 'A' as 'A' | 'B',
    canPost: false,
    posting: false,
    canCancelUpload: false,
    uploadProgress: 0,
    uploadHint: '',
    isIOS: false,
    tagList: MOMENT_TAG_POST,
    tagSelected: 'daily' as MomentTag,
    momentDate: todayKey(),
    momentDateLabel: '今天',
    minMomentDate: '1970-01-01',
    maxMomentDate: latestAllowedMomentDate(),
    draggingImageIndex: -1,
    editing: false,
    editLoading: false,
    draftLoading: false,
    editError: '',
    pendingResult: false,
    publishCorrection: false,
    existingMomentId: '',
    mediaRemaining: 0,
  },

  voiceAudio: null as WechatMiniprogram.InnerAudioContext | null,
  voiceAttempt: 0,
  locationAttempt: 0,
  mediaPickAttempt: 0,
  recordPermissionAttempt: 0,
  pendingMediaReceipts: [] as string[],
  recorder: null as WechatMiniprogram.RecorderManager | null,
  recordStartedAt: 0,
  ownsRecording: false,
  pageHidden: false,
  recordTimer: 0 as ReturnType<typeof setInterval> | number,
  draftTimer: 0 as ReturnType<typeof setTimeout> | number,
  skipDraftSaveOnUnload: false,
  submitCancelled: false,
  imageDragState: null as ImageDragState | null,
  requestId: '',
  editId: '',
  loadOptions: {} as Record<string, string | undefined>,
  draftSaveQueue: Promise.resolve() as Promise<void>,
  draftIdentity: null as { coupleId: string | null; role: string; openid: string } | null,
  editReady: false,
  editBase: null as EditDraftFields | null,
  unloaded: false,

  async onLoad(options: Record<string, string | undefined>) {
    this.loadOptions = options
    this.editId = options.id || ''
    if (!this.editId) this.setData({ draftLoading: true, editError: '', canPost: false })
    if (this.editId) this.setData({ editing: true, editLoading: true, editError: '', canPost: false })
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (this.unloaded) return
    if (!(await ensureCloudReady())) {
      if (!this.unloaded) {
        if (this.editId) this.setData({ editLoading: false, editError: '暂时连不上，点此重试' })
        else this.setData({ draftLoading: false, editError: '暂时连不上，点此重试' })
      }
      return
    }
    if (this.unloaded) return
    const id = getIdentity()
    const session = getSession()
    this.draftIdentity = session && { coupleId: session.coupleId, role: session.role, openid: session.openid }
    const couple = getCouple()
    const sys = wx.getSystemInfoSync()
    const localToday = todayKey()
    const minMomentDate = couple?.startDate ?? '1970-01-01'
    const maxMomentDate = latestAllowedMomentDate()
    let momentDate = localToday > maxMomentDate ? maxMomentDate : localToday
    if (!this.editId && minMomentDate <= maxMomentDate && momentDate < minMomentDate) {
      momentDate = minMomentDate
    }
    // 月回顾只提供新建默认日期，恢复草稿时仍以草稿日期为准。
    const recapMonth = options.recapMonth || ''
    if (!this.editId && /^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(recapMonth) && !momentDate.startsWith(`${recapMonth}-`)) {
      const monthStart = `${recapMonth}-01`
      const firstAllowedDate = minMomentDate > monthStart ? minMomentDate : monthStart
      if (firstAllowedDate.startsWith(`${recapMonth}-`) && firstAllowedDate <= maxMomentDate) {
        momentDate = firstAllowedDate
      }
    }
    this.setData({
      role: id.role,
      isIOS: (sys.platform || '').toLowerCase() === 'ios',
      momentDate,
      momentDateLabel: formatMomentDateLabel(momentDate),
      minMomentDate,
      maxMomentDate,
    })
    if (this.unloaded) return
    this.recorder = getVoiceRecorder()
    this.requestId = newPublishId()
    if (this.editId) {
      try {
        const pending = pendingSubmissions.get(this.draftScope())
        if (pending) await pending
        if (this.unloaded) return
        if (!this.isDraftIdentityCurrent()) throw new Error('空间或账号已切换，点此重试')
        const moment = await getMoment(this.editId)
        if (this.unloaded) return
        if (!this.isDraftIdentityCurrent()) throw new Error('空间或账号已切换，点此重试')
        if (!moment || moment.kind === 'system' || moment.authorRole !== id.role) throw new Error('只能编辑自己发布的回忆')
        this.setData({
          editing: true, content: moment.content, images: moment.images || [],
          livePhotos: (moment.livePhotos || []).map((item, index) => ({ ...item, id: `existing-${index}` })),
          video: moment.videos?.[0] || '', videoCover: moment.videoCover || '',
          voice: moment.voices?.[0] ? { path: moment.voices[0].fileID, duration: moment.voices[0].duration } : null,
          tagSelected: moment.tag || '', momentDate: moment.momentDate || todayKey(),
          momentDateLabel: formatMomentDateLabel(moment.momentDate || todayKey()),
          location: moment.location?.name || '', locationFull: moment.location || null,
          canPost: true,
        })
        const { content, tagSelected, momentDate, locationFull } = this.data
        this.editBase = { content, tagSelected, momentDate, locationFull }
        wx.setNavigationBarTitle({ title: '编辑回忆' })
      } catch (err) {
        if (!this.unloaded) this.setData({ editLoading: false, editError: err instanceof Error ? err.message : '加载失败' })
        return
      }
    }
    await this.restoreDraft()
    if (this.unloaded) return
    if (!this.isDraftIdentityCurrent()) {
      this.setData({ draftLoading: false, editLoading: false, editError: '空间或账号已切换，点此重试' })
      return
    }
    if (!this.editId) this.setData({ draftLoading: false })
    if (this.editId) {
      this.editReady = true
      this.setData({ editLoading: false })
    }
    this.updateMediaRemaining()
  },

  onRetryEdit() {
    if (!this.unloaded && !this.data.draftLoading && !this.data.editLoading && this.data.editError) {
      return this.onLoad(this.loadOptions)
    }
  },

  isDraftIdentityCurrent() {
    const identity = this.draftIdentity
    const current = getSession()
    return !!identity && current?.status === 'ready' && current.coupleId === identity.coupleId && current.role === identity.role && current.openid === identity.openid
  },

  draftScope() {
    const identity = this.draftIdentity
    return JSON.stringify([identity?.coupleId, identity?.role, identity?.openid, this.editId])
  },

  onShow() {
    this.pageHidden = false
    const maxMomentDate = latestAllowedMomentDate()
    const momentDateLabel = formatMomentDateLabel(this.data.momentDate)
    if (maxMomentDate !== this.data.maxMomentDate || momentDateLabel !== this.data.momentDateLabel) {
      this.setData({ maxMomentDate, momentDateLabel })
    }
    if (!this.editId && this.data.editError) return this.onRetryEdit()
  },

  onHide() {
    this.pageHidden = true
    this.recordPermissionAttempt++
    if (this.data.recordPending && !this.ownsRecording) this.setData({ recordPending: false })
    this.stopVoicePreview()
    if (this.data.recording) this.recorder?.stop()
    if (!this.skipDraftSaveOnUnload) this.saveDraft()
  },

  onUnload() {
    this.recordPermissionAttempt++
    this.stopVoicePreview()
    this.imageDragState = null
    this.stopRecordTimer()
    if (this.draftTimer) {
      clearTimeout(this.draftTimer as number)
      this.draftTimer = 0
    }
    if (!this.data.posting) this.saveDraft()
    this.unloaded = true
    if (this.ownsRecording && this.data.recording) this.recorder?.stop()
  },

  async restoreDraft() {
    try {
      if (!this.editId) {
        const pending = pendingSubmissions.get(this.draftScope())
        if (pending) await pending
      }
      if (this.unloaded || !this.isDraftIdentityCurrent()) return
      await waitForComposeDraftSave(this.editId)
      if (this.unloaded || !this.isDraftIdentityCurrent()) return
      const draft: (PublishDraft & { missingMedia: boolean }) | null = readComposeDraft(this.editId)
      if (!draft) return
      if (!this.editBase) {
        const { pendingMediaReceipts, missingMedia, ...fields } = draft
        this.requestId = draft.requestId
        this.pendingMediaReceipts = pendingMediaReceipts || []
        this.setData({
          ...fields,
          momentDateLabel: formatMomentDateLabel(draft.momentDate),
          canPost: this.computeCanPost(draft.content, draft.images, draft.livePhotos, draft.video, draft.voice),
        })
        wx.showToast({ title: missingMedia ? '部分草稿媒体已失效' : '已恢复上次草稿', icon: 'none' })
      } else {
        const base = this.editBase
        const fields = editFieldNames.filter(field => !sameEditField(draft, draft.editBase || base, field))
        if (!fields.length) return
        const conflicts = fields.filter(field => !sameEditField(draft, base, field) &&
          (!draft.editBase || !sameEditField(draft.editBase, base, field)))
        if (conflicts.length) {
          const restore = await new Promise<boolean | undefined>(resolve => wx.showModal({
            title: '恢复编辑草稿？',
            content: '草稿与当前回忆有差异。恢复后可以检查差异，再决定是否保存。',
            confirmText: '恢复草稿',
            cancelText: '舍弃草稿',
            success: result => resolve(result.confirm),
            fail: () => resolve(undefined),
          }))
          if (this.unloaded || !this.isDraftIdentityCurrent()) return
          if (!restore) {
            if (restore === false) clearComposeDraft(draft.requestId, this.editId)
            return
          }
        }
        this.requestId = draft.requestId
        const content = fields.includes('content') ? draft.content : base.content
        const tagSelected = fields.includes('tagSelected') ? draft.tagSelected : base.tagSelected
        const momentDate = fields.includes('momentDate') ? draft.momentDate : base.momentDate
        const locationFull = fields.includes('locationFull') ? draft.locationFull : base.locationFull
        this.setData({ content, tagSelected, momentDate, locationFull, location: locationFull?.name || '',
          momentDateLabel: formatMomentDateLabel(momentDate),
          canPost: this.computeCanPost(content, this.data.images, this.data.livePhotos, this.data.video, this.data.voice),
        })
      }
      if (this.editId) wx.showToast({ title: '已恢复上次草稿', icon: 'none' })
    } catch { /* 读取草稿失败时仍可用当前回忆继续编辑 */ }
  },

  scheduleDraftSave() {
    this.pendingMediaReceipts = []
    if (this.draftTimer) clearTimeout(this.draftTimer as number)
    this.draftTimer = setTimeout(() => this.saveDraft(), 600)
  },

  saveDraft(edited = false, outcome?: Pick<PublishDraft, 'pendingResult' | 'publishCorrection' | 'existingMomentId'>) {
    if (edited) this.pendingMediaReceipts = []
    if (!this.requestId || this.skipDraftSaveOnUnload || this.data.draftLoading || (this.editId && !this.editReady)) return
    const { content, tagSelected, momentDate, location, locationFull, images, video, videoCover, livePhotos, voice } = this.data
    const snapshot: PublishDraft = { requestId: this.requestId, content, tagSelected, momentDate, location, locationFull, images, video, videoCover, livePhotos, voice, pendingResult: this.data.pendingResult }
    if (!this.editId) {
      if (this.data.publishCorrection) snapshot.publishCorrection = true
      if (this.pendingMediaReceipts.length) snapshot.pendingMediaReceipts = this.pendingMediaReceipts
      if (this.data.existingMomentId) snapshot.existingMomentId = this.data.existingMomentId
      Object.assign(snapshot, outcome)
    }
    if (this.editBase) {
      snapshot.editBase = this.editBase
      if (editFieldNames.every(field => sameEditField(snapshot, this.editBase!, field))) {
        const pending = this.draftSaveQueue
        void pending.catch(() => {}).then(() => {
          if (pending === this.draftSaveQueue) this.clearDraft()
        })
        return
      }
    }
    if (!this.isDraftIdentityCurrent()) {
      const previous = this.draftSaveQueue
      const reject = () => { throw new Error('空间或账号已切换，草稿未保存') }
      this.draftSaveQueue = previous.then(reject, reject)
    } else {
      // 立即登记快照，让正在保存的草稿保留后续快照仍引用的媒体。
      this.draftSaveQueue = saveComposeDraft(snapshot, this.editId)
    }
    // 后台保存也需要处理拒绝，但保留队列的失败状态供发布流程检查。
    void this.draftSaveQueue.catch(() => {
      if (!this.unloaded && !this.pageHidden) wx.showToast({ title: '草稿未能保存，请检查空间或账号', icon: 'none' })
    })
  },

  clearDraft() {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer as number)
      this.draftTimer = 0
    }
    const current = getSession()
    const identity = this.draftIdentity
    if (!identity || !current || current.status !== 'ready' || current.coupleId !== identity.coupleId || current.role !== identity.role || current.openid !== identity.openid) return
    try {
      clearComposeDraft(this.requestId, this.editId)
    } catch (e) {}
  },

  finishRecording(result: WechatMiniprogram.OnStopListenerResult) {
    this.ownsRecording = false
    const elapsed = this.recordStartedAt ? Date.now() - this.recordStartedAt : 0
    this.recordStartedAt = 0
    this.stopRecordTimer()
    if (this.unloaded) return
    this.setData({ recording: false, recordPending: false, recordSec: 0 })
    if (!result.tempFilePath) {
      wx.showToast({ title: '未生成录音文件，请重试', icon: 'none' })
      return
    }
    const durationMs = result.duration > 0 ? result.duration : elapsed
    if (durationMs < 1000) {
      wx.showToast({ title: '录音太短，请录满 1 秒', icon: 'none' })
      return
    }
    const voice = { path: result.tempFilePath, duration: Math.round(durationMs / 1000) }
    this.setData({ voice, canPost: this.syncCanPost({ voice }) })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
  },

  failRecording(error: unknown) {
    this.ownsRecording = false
    this.recordStartedAt = 0
    this.stopRecordTimer()
    console.warn('Voice recording failed', error)
    if (this.unloaded) return
    this.setData({ recording: false, recordPending: false, recordSec: 0 })
    wx.showToast({ title: '录音启动失败，请检查麦克风', icon: 'none' })
  },

  stopRecordTimer() {
    if (this.recordTimer) {
      clearInterval(this.recordTimer as number)
      this.recordTimer = 0
    }
  },

  onContentInput(e: WechatMiniprogram.Input) {
    if (this.data.pendingResult || this.data.draftLoading || (this.editId && !this.editReady)) return
    const v = e.detail.value
    this.setData({
      content: v,
      canPost: this.computeCanPost(v, this.data.images, this.data.livePhotos, this.data.video, this.data.voice),
    })
    this.scheduleDraftSave()
  },

  computeCanPost(
    content: string,
    images: string[],
    livePhotos: LivePhotoDraft[],
    video: string,
    voice: VoiceDraft | null,
  ): boolean {
    return (
      content.trim().length > 0 ||
      images.length > 0 ||
      livePhotos.length > 0 ||
      !!video ||
      !!voice
    )
  },

  syncCanPost(patch: Partial<typeof this.data>) {
    const next = { ...this.data, ...patch }
    return this.computeCanPost(next.content, next.images, next.livePhotos, next.video, next.voice)
  },

  newLiveId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  },

  applyMediaFiles(files: WechatMiniprogram.MediaFile[]) {
    let images = [...this.data.images]
    let livePhotos = [...this.data.livePhotos]
    let video = this.data.video
    let videoCover = this.data.videoCover
    let skippedVideo = false
    let addedLive = 0

    let remaining = this.mediaSlots()
    for (const f of files) {
      const cost = isRegularVideoFile(f) ? (f.thumbTempFilePath ? 2 : 1) : 1
      if (cost > remaining) {
        wx.showToast({ title: '已达到本条可添加数量', icon: 'none' })
        continue
      }
      if (isRegularVideoFile(f)) {
        if (!video) {
          video = f.tempFilePath
          videoCover = f.thumbTempFilePath || ''
          remaining -= cost
        }
        else skippedVideo = true
        continue
      }
      images.push(f.tempFilePath)
      remaining -= cost
    }

    if (skippedVideo) {
      wx.showToast({ title: '视频每条只能 1 个', icon: 'none' })
    }
    this.setData({
      images,
      livePhotos,
      video,
      videoCover,
      canPost: this.syncCanPost({ images, livePhotos, video }),
    })
    this.updateMediaRemaining()
    this.saveDraft(true)
  },

  mediaSlots() {
    const couple = getCouple()
    const quota = couple?.quota
    const used = this.data.images.length + this.data.livePhotos.length * 2 +
      (this.data.video ? 1 : 0) + (this.data.videoCover ? 1 : 0) + (this.data.voice ? 1 : 0)
    return Math.max(0, Math.min(
      (quota?.maxMediaPerMoment ?? 12) - used,
      (quota?.maxMediaItems ?? 2000) - (couple?.usage?.mediaItems ?? 0) - used,
    ))
  },

  updateMediaRemaining() {
    this.setData({ mediaRemaining: this.mediaSlots() })
  },

  canPickMedia() {
    return !this.unloaded && !this.data.editing && !this.data.draftLoading && !this.data.posting &&
      !this.data.pendingResult && !this.data.existingMomentId && !this.skipDraftSaveOnUnload &&
      !this.data.recording && !this.data.recordPending && this.isDraftIdentityCurrent()
  },

  onPickAlbum() {
    if (!this.canPickMedia() || this.mediaSlots() < 1) return
    const attempt = ++this.mediaPickAttempt
    wx.chooseMedia({
      count: Math.min(PICK_BATCH, this.mediaSlots()),
      mediaType: this.data.video ? ['image'] : ['image', 'video'],
      // 普通图片由微信返回压缩图；普通视频在发布前显式压缩，实况保留独立入口。
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: res => {
        if (attempt === this.mediaPickAttempt && this.canPickMedia()) this.applyMediaFiles(res.tempFiles)
      },
      fail: err => {
        if (attempt !== this.mediaPickAttempt || !this.canPickMedia()) return
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '没能选到媒体', icon: 'none' })
        }
      },
    })
  },

  onLongPressImage(e: WechatMiniprogram.TouchEvent) {
    if (this.data.editing || this.data.pendingResult) return
    if (this.data.images.length < 2 || this.imageDragState?.active) return
    const index = Number(e.currentTarget.dataset.index)
    const point = touchPoint(e)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.images.length || !point) return

    wx.createSelectorQuery()
      .select('.grid')
      .boundingClientRect(rect => {
        if (!rect) return
        const width = wx.getSystemInfoSync().windowWidth
        const rpx = width / 750
        const gap = 12 * rpx
        const cellSize = (rect.width - gap * 2) / 3
        this.imageDragState = {
          index,
          gridLeft: rect.left,
          gridTop: rect.top,
          cellSize,
          gap,
          active: true,
        }
        this.setData({ draggingImageIndex: index })
        wx.vibrateShort({ type: 'light' })
      })
      .exec()
  },

  onImageTouchMove(e: WechatMiniprogram.TouchEvent) {
    const state = this.imageDragState
    const point = touchPoint(e)
    if (!state?.active || !point) return

    const stride = state.cellSize + state.gap
    const column = Math.max(0, Math.min(2, Math.floor((point.x - state.gridLeft) / stride)))
    const row = Math.max(0, Math.floor((point.y - state.gridTop) / stride))
    const nextIndex = Math.min(this.data.images.length - 1, row * 3 + column)
    if (nextIndex === state.index) return

    const images = [...this.data.images]
    const [moving] = images.splice(state.index, 1)
    images.splice(nextIndex, 0, moving)
    state.index = nextIndex
    this.setData({ images, draggingImageIndex: nextIndex })
    this.scheduleDraftSave()
  },

  onImageTouchEnd() {
    if (!this.imageDragState?.active) return
    this.imageDragState = null
    this.setData({ draggingImageIndex: -1 })
  },

  onPickLivePhoto() {
    if (!this.canPickMedia()) return
    if (this.mediaSlots() < 2) {
      wx.showToast({ title: '实况需要两个媒体名额', icon: 'none' })
      return
    }
    const attempt = ++this.mediaPickAttempt
    const isCurrent = () => attempt === this.mediaPickAttempt && this.canPickMedia()
    wx.showModal({
      title: '添加实况',
      content: '请选择实况对应的视频，所选视频及其缩略图将作为实况添加。微信可能只返回静态照片；如无法选择视频，请先在系统相册将实况存为视频。',
      confirmText: '选择视频',
      success: result => {
        if (!result.confirm || !isCurrent()) return
        wx.chooseMedia({
          count: 1,
          mediaType: ['image', 'video'],
          sizeType: ['original'],
          sourceType: ['album'],
          success: res => {
            if (!isCurrent()) return
            const f = res.tempFiles[0]
            if (!f) return
            if (!canUseAsLivePhoto(f)) {
              wx.showModal({
                title: '无法添加实况',
                content: '需要视频及其缩略图。请在系统相册将实况存为视频后重试；若仍无法获取缩略图，请使用视频入口添加。',
                showCancel: false,
              })
              return
            }
            if (this.mediaSlots() < 2) {
              wx.showToast({ title: '实况需要两个媒体名额', icon: 'none' })
              return
            }
            const livePhotos = [
              ...this.data.livePhotos,
              { id: this.newLiveId(), cover: f.thumbTempFilePath, video: f.tempFilePath, duration: Math.max(1, Math.round(f.duration || 1)) },
            ]
            this.setData({ livePhotos, canPost: this.syncCanPost({ livePhotos }) })
            this.updateMediaRemaining()
            this.saveDraft(true)
            wx.showToast({ title: '实况已添加', icon: 'success' })
          },
          fail: err => {
            if (isCurrent() && err.errMsg && err.errMsg.indexOf('cancel') === -1) wx.showToast({ title: '没能选到媒体', icon: 'none' })
          },
        })
      },
    })
  },

  onPickVideo() {
    if (!this.canPickMedia()) return
    if (this.data.video) {
      wx.showToast({ title: '已有一条视频，可先删除再换', icon: 'none' })
      return
    }
    if (this.mediaSlots() < 1) {
      wx.showToast({ title: '媒体名额已满', icon: 'none' })
      return
    }
    const attempt = ++this.mediaPickAttempt
    const isCurrent = () => attempt === this.mediaPickAttempt && this.canPickMedia()
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: res => {
        if (!isCurrent()) return
        const file = res.tempFiles[0]
        if (!file) return
        if (this.data.video) {
          wx.showToast({ title: '已有一条视频，可先删除再换', icon: 'none' })
          return
        }
        const needed = file.thumbTempFilePath ? 2 : 1
        if (this.mediaSlots() < needed) {
          wx.showToast({ title: needed === 2 ? '视频和封面需要两个媒体名额' : '媒体名额已满', icon: 'none' })
          return
        }
        this.setData({
          video: file.tempFilePath,
          videoCover: file.thumbTempFilePath || '',
          canPost: this.syncCanPost({ video: file.tempFilePath }),
        })
        this.updateMediaRemaining()
        this.saveDraft(true)
      },
      fail: err => {
        if (isCurrent() && err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '没能选到视频', icon: 'none' })
        }
      },
    })
  },

  onRemoveImage(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.images.length) return
    const images = this.data.images.filter((_, imageIndex) => imageIndex !== index)
    this.setData({ images, canPost: this.syncCanPost({ images }) })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
  },

  onRemoveLivePhoto(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const livePhotos = this.data.livePhotos.filter(lp => lp.id !== id)
    this.setData({ livePhotos, canPost: this.syncCanPost({ livePhotos }) })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
  },

  onRemoveVideo() {
    this.setData({ video: '', videoCover: '', canPost: this.syncCanPost({ video: '' }) })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
  },

  stopVoicePreview() {
    this.voiceAttempt++
    const audio = this.voiceAudio
    this.voiceAudio = null
    if (audio) { audio.stop(); audio.destroy() }
    if (!this.unloaded) this.setData({ voicePlaying: false, voiceLoading: false })
  },

  async onToggleVoicePreview() {
    const voice = this.data.voice
    if (!voice || this.pageHidden || this.data.recording || this.data.recordPending) return
    if (this.data.voiceLoading) { this.stopVoicePreview(); return }
    if (this.voiceAudio) {
      try {
        if (this.data.voicePlaying) this.voiceAudio.pause()
        else this.voiceAudio.play()
      } catch {
        this.stopVoicePreview()
        wx.showToast({ title: '语音播放失败，请重试', icon: 'none' })
      }
      return
    }
    const attempt = ++this.voiceAttempt
    this.setData({ voiceLoading: true })
    try {
      const url = await resolveCloudUrl(voice.path)
      if (attempt !== this.voiceAttempt || this.pageHidden || this.unloaded) return
      if (!url) throw new Error('语音文件不可用')
      const audio = wx.createInnerAudioContext()
      this.voiceAudio = audio
      const active = () => this.voiceAudio === audio && attempt === this.voiceAttempt
      audio.onPlay(() => { if (active()) this.setData({ voicePlaying: true, voiceLoading: false }) })
      audio.onPause(() => { if (active()) this.setData({ voicePlaying: false }) })
      audio.onEnded(() => { if (active()) this.stopVoicePreview() })
      audio.onError(() => {
        if (!active()) return
        this.stopVoicePreview()
        wx.showToast({ title: '语音播放失败，请重试', icon: 'none' })
      })
      audio.src = url
      audio.play()
    } catch {
      if (attempt !== this.voiceAttempt || this.unloaded) return
      this.stopVoicePreview()
      wx.showToast({ title: '语音播放失败，请重试', icon: 'none' })
    }
  },

  onRemoveVoice() {
    this.stopVoicePreview()
    this.setData({ voice: null, canPost: this.syncCanPost({ voice: null }) })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
  },

  onToggleRecord() {
    if (this.pageHidden || this.unloaded || this.data.editing || this.data.posting || this.data.pendingResult || this.data.recordPending) return
    if (!this.recorder) {
      wx.showToast({ title: '页面尚未准备好，请稍后重试', icon: 'none' })
      return
    }
    if (!this.data.voice && this.mediaSlots() < 1) {
      wx.showToast({ title: '媒体数量已达上限', icon: 'none' })
      return
    }

    if (this.data.recording) {
      this.setData({ recordPending: true })
      this.recorder.stop()
      return
    }

    this.startRecord()
  },

  startRecord() {
    const attempt = ++this.recordPermissionAttempt
    const isCurrent = () => attempt === this.recordPermissionAttempt && !this.unloaded && !this.pageHidden
    const cancel = () => {
      if (!isCurrent()) return
      this.recordPermissionAttempt++
      this.setData({ recordPending: false })
    }
    const start = () => {
      if (!isCurrent()) return
      this.recordPermissionAttempt++
      this.doStartRecord()
    }
    const authorize = () => wx.authorize({
      scope: 'scope.record',
      success: start,
      fail: error => {
        if (!isCurrent()) return
        console.warn('Microphone authorization failed', error)
        wx.showModal({
          title: '需要麦克风权限',
          content: '请在设置中允许录音，才能发语音',
          confirmText: '去设置',
          success: result => {
            if (!isCurrent()) return
            if (!result.confirm) return cancel()
            wx.openSetting({
              success: settings => settings.authSetting['scope.record'] ? start() : cancel(),
              fail: cancel,
            })
          },
          fail: cancel,
        })
      },
    })

    this.setData({ recordPending: true })
    if (!this.data.voice) return authorize()
    wx.showModal({
      title: '重新录音？',
      content: '会替换当前这条语音',
      success: result => {
        if (!isCurrent()) return
        if (!result.confirm) return cancel()
        this.stopVoicePreview()
        authorize()
      },
      fail: cancel,
    })
  },

  doStartRecord() {
    const recorder = this.recorder
    if (!recorder || this.unloaded) return
    if (this.pageHidden || activeRecording) {
      this.setData({ recordPending: false })
      if (!this.pageHidden) wx.showToast({ title: '上一段录音正在结束，请稍后重试', icon: 'none' })
      return
    }
    this.mediaPickAttempt++
    this.ownsRecording = true
    activeRecording = {
      started: () => {
        if (this.unloaded || this.pageHidden) {
          recorder.stop()
          return
        }
        this.recordStartedAt = Date.now()
        this.setData({ recording: true, recordPending: false, recordSec: 0 })
        this.recordTimer = setInterval(() => {
          this.setData({ recordSec: Math.floor((Date.now() - this.recordStartedAt) / 1000) })
        }, 1000)
      },
      stopped: result => this.finishRecording(result),
      failed: error => this.failRecording(error),
    }
    try {
      recorder.start({
        duration: MAX_VOICE_SEC * 1000,
        format: 'mp3',
        sampleRate: 44100,
        encodeBitRate: 96000,
        numberOfChannels: 1,
      })
    } catch (error) {
      activeRecording = undefined
      this.failRecording(error)
    }
  },

  onPickLocation() {
    if (this.data.pendingResult || (this.editId && !this.editReady)) return
    const attempt = ++this.locationAttempt
    // 按选择尝试判定，不依赖地图回调与 onShow 的先后。
    const isCurrent = () => !this.unloaded && attempt === this.locationAttempt
    wx.chooseLocation({
      success: res => {
        if (!isCurrent()) return
        const loc: MomentLocation = {
          name: res.name,
          address: res.address,
          latitude: res.latitude,
          longitude: res.longitude,
        }
        this.setData({ location: loc.name, locationFull: loc })
        this.scheduleDraftSave()
      },
      fail: err => {
        if (!isCurrent()) return
        const message = (err.errMsg || '').toLowerCase()
        if (message.includes('cancel')) return
        if (/auth deny|auth denied|permission|authorize|scope\.userlocation/.test(message)) {
          wx.showModal({ title: '需要位置权限', content: '请在小程序设置中允许使用位置信息，然后重新选择地点。也请检查手机系统的位置权限。', confirmText: '去设置', success: res => {
            if (res.confirm && isCurrent()) wx.openSetting({ fail: () => {
              if (isCurrent()) wx.showToast({ title: '无法打开设置，请手动前往设置', icon: 'none' })
            } })
          } })
        } else {
          wx.showToast({ title: '地点选择失败，请重试', icon: 'none' })
        }
      },
    })
  },

  onClearLocation() {
    if (this.data.pendingResult || (this.editId && !this.editReady)) return
    this.locationAttempt++
    this.setData({ location: '', locationFull: null })
    this.scheduleDraftSave()
  },

  onPickTag(e: WechatMiniprogram.BaseEvent) {
    if (this.data.pendingResult || (this.editId && !this.editReady)) return
    const key = e.currentTarget.dataset.key as MomentTag
    this.setData({ tagSelected: key })
    this.scheduleDraftSave()
  },

  onPickMomentDate(e: WechatMiniprogram.PickerChange) {
    if (this.data.pendingResult || (this.editId && !this.editReady)) return
    const momentDate = String(e.detail.value)
    this.setData({
      momentDate,
      momentDateLabel: formatMomentDateLabel(momentDate),
    })
    this.scheduleDraftSave()
  },

  onCancel() {
    wx.navigateBack().catch(() => {
      wx.switchTab({ url: '/pages/moments/moments' })
    })
  },

  onCancelUpload() {
    if (!this.data.canCancelUpload) return
    this.submitCancelled = true
    this.setData({ canCancelUpload: false })
    cancelMomentUpload()
    wx.showToast({ title: '正在取消…', icon: 'none' })
  },

  onViewPublishedMoment() {
    const id = this.data.existingMomentId
    if (!id || !this.isDraftIdentityCurrent()) return
    wx.navigateTo({ url: `/pages/moment-detail/moment-detail?id=${encodeURIComponent(id)}` })
  },

  onDiscardPublishCorrection() {
    if (!this.data.existingMomentId || !this.isDraftIdentityCurrent()) return
    wx.showModal({
      title: '舍弃修正草稿？',
      content: '舍弃后将无法恢复这份草稿。',
      confirmText: '舍弃草稿',
      success: async result => {
        if (!result.confirm || this.unloaded || !this.isDraftIdentityCurrent()) return
        this.skipDraftSaveOnUnload = true
        try { await this.draftSaveQueue } catch { /* 仍可清理上次保存的草稿 */ }
        this.clearDraft()
        if (!this.unloaded) this.onCancel()
      },
    })
  },

  async onSubmit() {
    if (this.unloaded || !this.requestId || this.data.draftLoading || this.data.editLoading ||
      this.data.editError || this.data.existingMomentId || this.skipDraftSaveOnUnload || !this.isDraftIdentityCurrent()) return
    if (this.data.recording || this.data.recordPending) {
      wx.showToast({ title: '请先结束录音', icon: 'none' })
      return
    }
    if (this.data.posting) return
    if (!this.data.canPost && !this.data.pendingResult) {
      wx.showToast({ title: '写点内容或加点媒体吧', icon: 'none' })
      return
    }
    const scope = this.draftScope()
    if (pendingSubmissions.has(scope)) return
    const submission = this.submitDraft()
    pendingSubmissions.set(scope, submission)
    try { await submission } finally { pendingSubmissions.delete(scope) }
  },

  async submitDraft() {
    this.submitCancelled = false
    this.mediaPickAttempt++
    this.locationAttempt++
    if (this.draftTimer) {
      clearTimeout(this.draftTimer as number)
      this.draftTimer = 0
    }
    const canUpdatePage = () => !this.unloaded && this.isDraftIdentityCurrent()
    let resultUncertain = false
    let canCorrect = false
    let sentReceipt = ''
    let differentMomentId = ''
    this.setData({ posting: true, canCancelUpload: !this.editId, uploadProgress: 0, uploadHint: '准备上传…' })
    try {
      this.saveDraft()
      try {
        await this.draftSaveQueue
      } catch (error) {
        if (!this.editId || !this.isDraftIdentityCurrent()) throw error
      }
      if (!canUpdatePage()) return
      if (this.submitCancelled) throw new Error('已取消上传')
      if (this.editId) {
        const base = this.editBase
        if (!this.editReady || !base || !this.isDraftIdentityCurrent()) throw new Error('回忆尚未加载完成')
        const fields = this.data
        const changes: Parameters<typeof updateMoment>[1] = {}
        if (!sameEditField(fields, base, 'content')) changes.content = fields.content
        if (!sameEditField(fields, base, 'momentDate')) changes.momentDate = fields.momentDate
        if (!sameEditField(fields, base, 'tagSelected')) changes.tag = fields.tagSelected
        if (!sameEditField(fields, base, 'locationFull')) changes.location = fields.locationFull
        if (Object.keys(changes).length) await updateMoment(this.editId, changes)
      } else {
        await addMoment(
          {
            requestId: this.requestId,
            content: this.data.content,
            images: this.data.images,
            livePhotos: this.data.livePhotos.map(lp => ({
              cover: lp.cover,
              video: lp.video,
              duration: lp.duration,
            })),
            videos: this.data.video ? [this.data.video] : [],
            videoCover: this.data.videoCover,
            voices: this.data.voice ? [this.data.voice] : [],
            location: this.data.locationFull,
            tag: this.data.tagSelected,
            momentDate: this.data.momentDate,
          },
          (percent, hint) => {
            if (canUpdatePage()) this.setData({ uploadProgress: percent, uploadHint: hint })
          },
          (...event) => {
            if (event[0] === 'sending') {
              sentReceipt = event[1]
              if (canUpdatePage()) this.setData({ canCancelUpload: false })
            } else if (event[0] === 'uncertain') resultUncertain = true
            else if (event[0] === 'correctable') canCorrect = true
            else differentMomentId = event[1]
          },
          this.pendingMediaReceipts,
        )
        if (this.data.publishCorrection && differentMomentId) {
          this.pendingMediaReceipts = []
          const outcome = { existingMomentId: differentMomentId, pendingResult: false }
          markMomentsListStale()
          if (!this.isDraftIdentityCurrent()) return
          if (canUpdatePage()) this.setData(outcome)
          this.saveDraft(false, outcome)
          try { await this.draftSaveQueue } catch { /* 保留页面上的修正内容 */ }
          return
        }
      }
      if (canUpdatePage()) this.setData({ canCancelUpload: false })
      markMomentsListStale()
      this.skipDraftSaveOnUnload = true
      try { await this.draftSaveQueue } catch { /* 发布已成功，后台草稿保存失败不影响结果 */ }
      this.clearDraft()
      if (this.unloaded) return
      // 利用跳转前的 toast 间隙预取首屏，回到回忆 Tab 时秒开（含刚发布的这条）
      prefetchMomentsFeed(feedCacheKey(), () => listMomentsPage({ limit: 20, skip: 0, cursor: null }))
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => {
        if (this.unloaded) return
        if (this.editId) wx.navigateBack()
        else wx.switchTab({ url: '/pages/moments/moments' })
      }, 500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      const outcome: Pick<PublishDraft, 'pendingResult' | 'publishCorrection'> = {}
      if (resultUncertain) {
        if (sentReceipt && !this.pendingMediaReceipts.includes(sentReceipt)) {
          this.pendingMediaReceipts = [...this.pendingMediaReceipts, sentReceipt]
        }
        outcome.pendingResult = true
      } else if (canCorrect && this.data.pendingResult) {
        // 查无记录只代表查询当时未见到提交，后续仍用原请求编号确认。
        outcome.pendingResult = false
        outcome.publishCorrection = true
      }
      if (canUpdatePage()) this.setData(outcome)
      if (!this.unloaded) wx.showToast({ title: msg, icon: 'none' })
      if (this.isDraftIdentityCurrent() && (this.data.pendingResult || outcome.pendingResult || outcome.publishCorrection)) {
        this.saveDraft(false, outcome)
        try { await this.draftSaveQueue } catch { /* 保存失败已提示，保留页面供重试 */ }
      }
    } finally {
      if (!this.unloaded) this.setData({ posting: false, canCancelUpload: false, uploadProgress: 0, uploadHint: '' })
    }
  },
})
