// pages/compose/compose.ts —— 发布动态（图文 / 视频 / 语音 / 实况）

import { addMoment, getCouple, getIdentity } from '../../services/store'
import { todayKey } from '../../services/date'
import { formatMomentDateLabel } from '../../utils/moment-time'
import { ensureCloudReady } from '../../services/page-boot'
import { getAppInstance } from '../../app'
import { MomentLocation, MomentTag } from '../../services/types'
import { MOMENT_TAG_POST } from '../../utils/tags'
import { isLikelyLivePhotoFile, isRegularVideoFile } from '../../utils/live-photo'

const PICK_BATCH = 20
const MAX_VOICE_SEC = 60

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

Page({
  data: {
    content: '',
    contentLen: 0,
    images: [] as string[],
    livePhotos: [] as LivePhotoDraft[],
    video: '' as string,
    voice: null as VoiceDraft | null,
    recording: false,
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
  },

  recorder: null as WechatMiniprogram.RecorderManager | null,
  recordTimer: 0 as ReturnType<typeof setInterval> | number,

  async onLoad() {
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
    this.initRecorder()
  },

  onUnload() {
    this.stopRecordTimer()
    if (this.data.recording && this.recorder) {
      this.recorder.stop()
    }
  },

  initRecorder() {
    const recorder = wx.getRecorderManager()
    this.recorder = recorder

    recorder.onStop(res => {
      this.stopRecordTimer()
      const duration = Math.max(1, Math.round((res.duration || 0) / 1000))
      if (duration < 1) {
        this.setData({ recording: false, recordSec: 0 })
        wx.showToast({ title: '录音太短', icon: 'none' })
        return
      }
      const voice = { path: res.tempFilePath, duration }
      this.setData({
        recording: false,
        recordSec: 0,
        voice,
        canPost: this.computeCanPost(this.data.content, this.data.images, this.data.livePhotos, this.data.video, voice),
      })
    })

    recorder.onError(() => {
      this.stopRecordTimer()
      this.setData({ recording: false, recordSec: 0 })
      wx.showToast({ title: '录音失败', icon: 'none' })
    })
  },

  stopRecordTimer() {
    if (this.recordTimer) {
      clearInterval(this.recordTimer as number)
      this.recordTimer = 0
    }
  },

  onContentInput(e: WechatMiniprogram.Input) {
    const v = e.detail.value
    this.setData({
      content: v,
      contentLen: v.length,
      canPost: this.computeCanPost(v, this.data.images, this.data.livePhotos, this.data.video, this.data.voice),
    })
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
    let skippedVideo = false
    let addedLive = 0

    for (const f of files) {
      if (isLikelyLivePhotoFile(f)) {
        livePhotos.push({
          id: this.newLiveId(),
          cover: f.thumbTempFilePath,
          video: f.tempFilePath,
          duration: Math.max(1, Math.round(f.duration || 1)),
        })
        addedLive += 1
        continue
      }
      if (isRegularVideoFile(f)) {
        if (!video) video = f.tempFilePath
        else skippedVideo = true
        continue
      }
      images.push(f.tempFilePath)
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
      canPost: this.syncCanPost({ images, livePhotos, video }),
    })
  },

  onPickAlbum() {
    wx.chooseMedia({
      count: PICK_BATCH,
      mediaType: this.data.video ? ['image', 'video'] : ['image', 'video'],
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
      success: res => this.applyMediaFiles(res.tempFiles),
      fail: err => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '没能选到媒体', icon: 'none' })
        }
      },
    })
  },

  onPickLivePhoto() {
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
    if (this.data.video) {
      wx.showToast({ title: '已有一条视频，可先删除再换', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
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
          canPost: this.syncCanPost({ video: file.tempFilePath }),
        })
      },
      fail: err => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '没能选到视频', icon: 'none' })
        }
      },
    })
  },

  onRemoveImage(e: WechatMiniprogram.BaseEvent) {
    const src = e.currentTarget.dataset.src as string
    const images = this.data.images.filter(i => i !== src)
    this.setData({ images, canPost: this.syncCanPost({ images }) })
  },

  onRemoveLivePhoto(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string
    const livePhotos = this.data.livePhotos.filter(lp => lp.id !== id)
    this.setData({ livePhotos, canPost: this.syncCanPost({ livePhotos }) })
  },

  onRemoveVideo() {
    this.setData({ video: '', canPost: this.syncCanPost({ video: '' }) })
  },

  onRemoveVoice() {
    this.setData({ voice: null, canPost: this.syncCanPost({ voice: null }) })
  },

  onToggleRecord() {
    if (!this.recorder) return

    if (this.data.voice && !this.data.recording) {
      wx.showModal({
        title: '重新录音？',
        content: '会替换当前这条语音',
        success: res => {
          if (res.confirm) this.setData({ voice: null }, () => this.startRecord())
        },
      })
      return
    }

    if (this.data.recording) {
      this.recorder.stop()
      return
    }

    this.startRecord()
  },

  startRecord() {
    if (!this.recorder) return
    wx.authorize({
      scope: 'scope.record',
      success: () => this.doStartRecord(),
      fail: () => {
        wx.showModal({
          title: '需要麦克风权限',
          content: '请在设置中允许录音，才能发语音',
          confirmText: '去设置',
          success: r => {
            if (r.confirm) wx.openSetting({})
          },
        })
      },
    })
  },

  doStartRecord() {
    if (!this.recorder) return
    this.setData({ recording: true, recordSec: 0 })
    this.recorder.start({
      duration: MAX_VOICE_SEC * 1000,
      format: 'mp3',
      sampleRate: 44100,
      numberOfChannels: 1,
    })
    this.recordTimer = setInterval(() => {
      const sec = this.data.recordSec + 1
      this.setData({ recordSec: sec })
      if (sec >= MAX_VOICE_SEC && this.recorder) {
        this.recorder.stop()
      }
    }, 1000)
  },

  onPickLocation() {
    wx.chooseLocation({
      success: res => {
        const loc: MomentLocation = {
          name: res.name,
          address: res.address,
          latitude: res.latitude,
          longitude: res.longitude,
        }
        this.setData({ location: loc.name, locationFull: loc })
      },
      fail: err => {
        if (err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '取景地选择已取消', icon: 'none' })
        }
      },
    })
  },

  onClearLocation() {
    this.setData({ location: '', locationFull: null })
  },

  onPickTag(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as MomentTag
    this.setData({ tagSelected: key })
  },

  onPickMomentDate(e: WechatMiniprogram.PickerChange) {
    const momentDate = String(e.detail.value)
    this.setData({
      momentDate,
      momentDateLabel: formatMomentDateLabel(momentDate),
    })
  },

  onCancel() {
    wx.navigateBack().catch(() => {
      wx.switchTab({ url: '/pages/moments/moments' })
    })
  },

  async onSubmit() {
    if (!this.data.canPost || this.data.posting) {
      if (!this.data.canPost) wx.showToast({ title: '写点内容或加点媒体吧', icon: 'none' })
      return
    }
    if (this.data.recording) {
      wx.showToast({ title: '请先结束录音', icon: 'none' })
      return
    }

    this.setData({ posting: true, uploadProgress: 0, uploadHint: '准备上传…' })
    try {
      await addMoment(
        {
          content: this.data.content,
          images: this.data.images,
          livePhotos: this.data.livePhotos.map(lp => ({
            cover: lp.cover,
            video: lp.video,
            duration: lp.duration,
          })),
          videos: this.data.video ? [this.data.video] : [],
          voices: this.data.voice ? [this.data.voice] : [],
        location: this.data.locationFull,
        tag: this.data.tagSelected,
        momentDate: this.data.momentDate,
      },
        (percent, hint) => {
          this.setData({ uploadProgress: percent, uploadHint: hint })
        },
      )
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => {
        wx.switchTab({ url: '/pages/moments/moments' })
      }, 500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '保存失败'
      wx.showToast({ title: msg, icon: 'none' })
    } finally {
      this.setData({ posting: false, uploadProgress: 0, uploadHint: '' })
    }
  },
})
