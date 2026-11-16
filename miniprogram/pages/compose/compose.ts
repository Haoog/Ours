import { resolveCloudUrl } from '../../utils/cloud-url-cache'
// pages/compose/compose.ts —— 发布动态（图文 / 视频 / 语音 / 实况）

import { addMoment, getMoment, updateMoment, getCouple, getIdentity, listMomentsPage, cancelMomentUpload } from '../../services/store'
import { clearComposeDraft, newPublishId, readComposeDraft, saveComposeDraft, ComposeDraft } from '../../services/compose-draft'
import { todayKey } from '../../services/date'
import { formatMomentDateLabel } from '../../utils/moment-time'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { markMomentsListStale } from '../../services/moments-list-state'
import { feedCacheKey, prefetchMomentsFeed } from '../../services/moments-feed-cache'
import { MomentLocation, MomentTag } from '../../services/types'
import { MOMENT_TAG_POST } from '../../utils/tags'
import { isLikelyLivePhotoFile, isRegularVideoFile } from '../../utils/live-photo'
import { getThemeStyle, syncTheme } from '../../services/theme'

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
    uploadProgress: 0,
    uploadHint: '',
    isIOS: false,
    tagList: MOMENT_TAG_POST,
    tagSelected: 'daily' as MomentTag,
    momentDate: todayKey(),
    momentDateLabel: '今天',
    minMomentDate: '1970-01-01',
    maxMomentDate: todayKey(),
    draggingImageIndex: -1,
    editing: false,
    pendingResult: false,
    mediaRemaining: 0,
  },

  voiceAudio: null as WechatMiniprogram.InnerAudioContext | null,
  voiceAttempt: 0,
  recorder: null as WechatMiniprogram.RecorderManager | null,
  recordStartedAt: 0,
  ownsRecording: false,
  pageHidden: false,
  recordTimer: 0 as ReturnType<typeof setInterval> | number,
  draftTimer: 0 as ReturnType<typeof setTimeout> | number,
  skipDraftSaveOnUnload: false,
  imageDragState: null as ImageDragState | null,
  requestId: '',
  editId: '',
  draftSaveQueue: Promise.resolve() as Promise<void>,
  editReady: false,
  unloaded: false,

  async onLoad(options: Record<string, string | undefined>) {
    syncTheme(this)
    await getAppInstance().waitBoot()
    if (!(await ensureCloudReady())) return
    const id = getIdentity()
    const couple = getCouple()
    const sys = wx.getSystemInfoSync()
    const momentDate = todayKey()
    this.setData({
      role: id.role,
      isIOS: (sys.platform || '').toLowerCase() === 'ios',
      momentDate,
      momentDateLabel: formatMomentDateLabel(momentDate),
      minMomentDate: couple?.startDate ?? '1970-01-01',
      maxMomentDate: momentDate,
    })
    if (this.unloaded) return
    this.recorder = getVoiceRecorder()
    this.requestId = newPublishId()
    this.editId = options.id || ''
    if (this.editId) {
      try {
        const moment = await getMoment(this.editId)
        if (!moment || moment.kind === 'system' || moment.authorRole !== id.role) throw new Error('只能编辑自己发布的回忆')
        this.setData({
          editing: true, content: moment.content, images: moment.images || [],
          livePhotos: (moment.livePhotos || []).map((item, index) => ({ ...item, id: `existing-${index}` })),
          video: moment.videos?.[0] || '', videoCover: moment.videoCover || '',
          voice: moment.voices?.[0] ? { path: moment.voices[0].fileID, duration: moment.voices[0].duration } : null,
          tagSelected: moment.tag || '', momentDate: moment.momentDate || todayKey(),
          momentDateLabel: formatMomentDateLabel(moment.momentDate || todayKey()),
          location: moment.location?.name || '', locationFull: moment.location,
          canPost: true,
        })
        this.editReady = true
        wx.setNavigationBarTitle({ title: '编辑回忆' })
      } catch (err) {
        wx.showToast({ title: err instanceof Error ? err.message : '加载失败', icon: 'none' })
        return
      }
    }
    this.restoreDraft()
    this.updateMediaRemaining()
  },

  onShow() {
    this.pageHidden = false
  },

  onHide() {
    this.pageHidden = true
    this.stopVoicePreview()
    if (this.data.recording) this.recorder?.stop()
    if (!this.skipDraftSaveOnUnload) this.saveDraft()
  },

  onUnload() {
    this.stopVoicePreview()
    this.imageDragState = null
    this.stopRecordTimer()
    if (this.draftTimer) {
      clearTimeout(this.draftTimer as number)
      this.draftTimer = 0
    }
    if (!this.skipDraftSaveOnUnload) this.saveDraft()
    this.unloaded = true
    if (this.ownsRecording && this.data.recording) this.recorder?.stop()
  },

  restoreDraft() {
    try {
      const d = readComposeDraft(this.editId)
      if (d) {
        this.requestId = d.requestId
        this.setData({
          ...d,
          momentDateLabel: formatMomentDateLabel(d.momentDate),
          canPost: this.computeCanPost(d.content, d.images, d.livePhotos, d.video, d.voice),
        })
        wx.showToast({ title: '已恢复上次草稿', icon: 'none' })
      }
    } catch (e) {}
  },

  scheduleDraftSave() {
    if (this.draftTimer) clearTimeout(this.draftTimer as number)
    this.draftTimer = setTimeout(() => this.saveDraft(), 600)
  },

  saveDraft() {
    if (!this.requestId || this.skipDraftSaveOnUnload || (this.editId && !this.editReady)) return
    const { content, tagSelected, momentDate, location, locationFull, images, video, videoCover, livePhotos, voice } = this.data
    const snapshot: ComposeDraft = { requestId: this.requestId, content, tagSelected, momentDate, location, locationFull, images, video, videoCover, livePhotos, voice, pendingResult: this.data.pendingResult }
    this.draftSaveQueue = this.draftSaveQueue.catch(() => undefined).then(() =>
      saveComposeDraft(snapshot, this.editId),
    ).catch(() => {
      wx.showToast({ title: '草稿未能保存，请检查本机空间', icon: 'none' })
    })
  },

  clearDraft() {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer as number)
      this.draftTimer = 0
    }
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
    if (this.data.pendingResult) return
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
      const cost = isLikelyLivePhotoFile(f) ? 2 : isRegularVideoFile(f) ? (f.thumbTempFilePath ? 2 : 1) : 1
      if (cost > remaining) {
        wx.showToast({ title: '已达到本条可添加数量', icon: 'none' })
        continue
      }
      if (isLikelyLivePhotoFile(f)) {
        livePhotos.push({
          id: this.newLiveId(),
          cover: f.thumbTempFilePath,
          video: f.tempFilePath,
          duration: Math.max(1, Math.round(f.duration || 1)),
        })
        addedLive += 1
        remaining -= cost
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
      wx.showToast({ title: '长视频每条只能 1 个', icon: 'none' })
    }
    if (addedLive > 0) {
      wx.showToast({ title: `已识别 ${addedLive} 条实况`, icon: 'none' })
    }

    this.setData({
      images,
      livePhotos,
      video,
      videoCover,
      canPost: this.syncCanPost({ images, livePhotos, video }),
    })
    this.updateMediaRemaining()
    this.scheduleDraftSave()
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

  onPickAlbum() {
    if (this.data.editing || this.mediaSlots() < 1) return
    wx.chooseMedia({
      count: Math.min(PICK_BATCH, this.mediaSlots()),
      mediaType: this.data.video ? ['image', 'video'] : ['image', 'video'],
      // 普通图片由微信返回压缩图；普通视频在发布前显式压缩，实况保留独立入口。
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: res => this.applyMediaFiles(res.tempFiles),
      fail: err => {
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
    if (this.data.editing || this.mediaSlots() < 2) {
      wx.showToast({ title: '实况需要两个媒体名额', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image', 'video'],
      sizeType: ['original'],
      sourceType: ['album'],
      maxDuration: 10,
      success: res => {
        const f = res.tempFiles[0]
        if (!f) return
        if (isLikelyLivePhotoFile(f)) {
          const livePhotos = [
            ...this.data.livePhotos,
            {
              id: this.newLiveId(),
              cover: f.thumbTempFilePath,
              video: f.tempFilePath,
              duration: Math.max(1, Math.round(f.duration || 1)),
            },
          ]
          this.setData({
            livePhotos,
            canPost: this.syncCanPost({ livePhotos }),
          })
          wx.showToast({ title: '实况已添加', icon: 'success' })
          this.updateMediaRemaining()
          this.scheduleDraftSave()
          return
        }
        if (this.data.isIOS) {
          wx.showModal({
            title: '没识别到实况',
            content:
              '请在相册左上角点「实况」图标后再选；若仍只有静图，可在系统相册对该照片选「储存为视频」，再用「视频」按钮添加。',
            showCancel: false,
          })
        } else {
          wx.showToast({ title: '请用 iPhone 相册中的实况照片', icon: 'none' })
        }
      },
    })
  },

  onPickVideo() {
    if (this.data.editing || this.mediaSlots() < 2) return
    if (this.data.video) {
      wx.showToast({ title: '已有一条视频，可先删除再换', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
      success: res => {
        const file = res.tempFiles[0]
        if (!file) return
        if (isLikelyLivePhotoFile(file)) {
          const livePhotos = [
            ...this.data.livePhotos,
            {
              id: this.newLiveId(),
              cover: file.thumbTempFilePath,
              video: file.tempFilePath,
              duration: Math.max(1, Math.round(file.duration || 1)),
            },
          ]
          this.setData({
            livePhotos,
            canPost: this.syncCanPost({ livePhotos }),
          })
          wx.showToast({ title: '已按实况添加', icon: 'none' })
          return
        }
        this.setData({
          video: file.tempFilePath,
          videoCover: file.thumbTempFilePath || '',
          canPost: this.syncCanPost({ video: file.tempFilePath }),
        })
        this.updateMediaRemaining()
        this.scheduleDraftSave()
      },
      fail: err => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
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
    if (this.data.editing || this.data.posting || this.data.pendingResult || this.data.recordPending) return
    if (!this.recorder) {
      wx.showToast({ title: '页面尚未准备好，请稍后重试', icon: 'none' })
      return
    }
    if (!this.data.voice && this.mediaSlots() < 1) {
      wx.showToast({ title: '媒体数量已达上限', icon: 'none' })
      return
    }

    if (this.data.voice && !this.data.recording) {
      wx.showModal({
        title: '重新录音？',
        content: '会替换当前这条语音',
        success: res => {
          if (res.confirm) { this.stopVoicePreview(); this.startRecord() }
        },
      })
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
    if (!this.recorder || this.data.recordPending || this.unloaded) return
    this.setData({ recordPending: true })
    wx.authorize({
      scope: 'scope.record',
      success: () => this.doStartRecord(),
      fail: error => {
        console.warn('Microphone authorization failed', error)
        if (this.unloaded) return
        wx.showModal({
          title: '需要麦克风权限',
          content: '请在设置中允许录音，才能发语音',
          confirmText: '去设置',
          success: r => {
            if (this.unloaded) return
            if (!r.confirm) {
              this.setData({ recordPending: false })
              return
            }
            wx.openSetting({
              success: settings => {
                if (this.unloaded) return
                if (settings.authSetting['scope.record']) this.doStartRecord()
                else this.setData({ recordPending: false })
              },
              fail: () => {
                if (!this.unloaded) this.setData({ recordPending: false })
              },
            })
          },
          fail: () => {
            if (!this.unloaded) this.setData({ recordPending: false })
          },
        })
      },
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
    if (this.data.pendingResult) return
    wx.chooseLocation({
      success: res => {
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
        const message = (err.errMsg || '').toLowerCase()
        if (message.includes('cancel')) return
        if (/auth deny|auth denied|permission|authorize|scope\.userlocation/.test(message)) {
          wx.showModal({ title: '需要位置权限', content: '请在小程序设置中允许使用位置信息，然后重新选择地点。也请检查手机系统的位置权限。', confirmText: '去设置', success: res => {
            if (res.confirm) wx.openSetting({ fail: () => wx.showToast({ title: '无法打开设置，请手动前往设置', icon: 'none' }) })
          } })
        } else {
          wx.showToast({ title: '地点选择失败，请重试', icon: 'none' })
        }
      },
    })
  },

  onClearLocation() {
    if (this.data.pendingResult) return
    this.setData({ location: '', locationFull: null })
    this.scheduleDraftSave()
  },

  onPickTag(e: WechatMiniprogram.BaseEvent) {
    if (this.data.pendingResult) return
    const key = e.currentTarget.dataset.key as MomentTag
    this.setData({ tagSelected: key })
    this.scheduleDraftSave()
  },

  onPickMomentDate(e: WechatMiniprogram.PickerChange) {
    if (this.data.pendingResult) return
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
    cancelMomentUpload()
    wx.showToast({ title: '正在取消…', icon: 'none' })
  },

  async onSubmit() {
    if (this.data.recording || this.data.recordPending) {
      wx.showToast({ title: '请先结束录音', icon: 'none' })
      return
    }
    if (!this.data.canPost || this.data.posting) {
      if (!this.data.canPost) wx.showToast({ title: '写点内容或加点媒体吧', icon: 'none' })
      return
    }
    this.setData({ posting: true, uploadProgress: 0, uploadHint: '准备上传…' })
    try {
      this.saveDraft()
      await this.draftSaveQueue
      if (this.editId) {
        if (!this.editReady) throw new Error('回忆尚未加载完成')
        await updateMoment(this.editId, {
          content: this.data.content, momentDate: this.data.momentDate,
          tag: this.data.tagSelected, location: this.data.locationFull,
        })
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
          this.setData({ uploadProgress: percent, uploadHint: hint })
        },
      )
      }
      markMomentsListStale()
      this.skipDraftSaveOnUnload = true
      await this.draftSaveQueue
      this.clearDraft()
      // 利用跳转前的 toast 间隙预取首屏，回到回忆 Tab 时秒开（含刚发布的这条）
      prefetchMomentsFeed(feedCacheKey(), () => listMomentsPage({ limit: 20, skip: 0 }))
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => {
        if (this.editId) wx.navigateBack()
        else wx.switchTab({ url: '/pages/moments/moments' })
      }, 500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      if (!this.editId && this.data.uploadProgress >= 98 && !(err as { business?: boolean })?.business) {
        this.setData({ pendingResult: true })
      }
      wx.showToast({ title: msg, icon: 'none' })
      this.saveDraft()
    } finally {
      this.setData({ posting: false, uploadProgress: 0, uploadHint: '' })
    }
  },
})
