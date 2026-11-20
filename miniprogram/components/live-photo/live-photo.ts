import { resolveCloudUrl } from '../../services/store'
import { invalidateCachedUrl, peekCachedUrl } from '../../utils/cloud-url-cache'

// The ID ties each URL request and native video event to its playback attempt.
const playbackStates = new WeakMap<object, { id: number; hidden: boolean }>()

function showPlaybackError() {
  wx.showToast({ title: '实况播放失败', icon: 'none' })
}

Component({
  properties: {
    cover: {
      type: String,
      value: '',
      observer(cover: string, previous: string) {
        if (cover !== previous) this.retryCover()
      },
    },
    video: {
      type: String,
      value: '',
      observer(video: string, previous: string) {
        if (video !== previous) this.stop()
      },
    },
    duration: { type: Number, value: 0 },
  },

  data: {
    playing: false,
    playSrc: '',
    playbackId: 0,
    playbackFailed: false,
    coverAttempt: 0,
    coverFailed: false,
  },

  lifetimes: {
    created() { playbackStates.set(this, { id: 0, hidden: false }) },
    detached() { playbackStates.delete(this) },
  },

  pageLifetimes: {
    show() {
      const playback = playbackStates.get(this)
      if (playback) playback.hidden = false
    },
    hide() {
      const playback = playbackStates.get(this)
      if (!playback) return
      playback.hidden = true
      this.stop()
    },
  },

  methods: {
    async onTap() {
      const playback = playbackStates.get(this)
      if (!playback || playback.hidden) return
      if (this.data.playing) {
        this.stop()
        return
      }
      const video = this.properties.video
      if (!video) return
      const playbackId = ++playback.id
      const isCurrent = () => playbackStates.get(this) === playback &&
        playback.id === playbackId && this.properties.video === video
      try {
        const playSrc = video.startsWith('cloud://') ? await resolveCloudUrl(video) : video
        if (!playSrc) throw new Error('媒体加载失败')
        if (isCurrent()) this.setData({ playing: true, playSrc, playbackId, playbackFailed: false })
      } catch {
        if (!isCurrent()) return
        this.setData({ playbackFailed: true })
        showPlaybackError()
      }
    },

    onVideoError(event: WechatMiniprogram.BaseEvent) {
      const playback = playbackStates.get(this)
      if (!playback || !this.data.playing || Number(event.currentTarget.dataset.playbackId) !== playback.id) return
      const { video } = this.properties
      if (video.startsWith('cloud://') && peekCachedUrl(video) === this.data.playSrc) invalidateCachedUrl(video)
      this.stop()
      this.setData({ playbackFailed: true })
      showPlaybackError()
    },

    onCoverError(event: WechatMiniprogram.BaseEvent) {
      if (!playbackStates.has(this) || !this.properties.cover ||
        Number(event.currentTarget.dataset.coverAttempt) !== this.data.coverAttempt) return
      this.setData({ coverFailed: true })
    },

    retryCover() {
      this.setData({ coverFailed: false, coverAttempt: this.data.coverAttempt + 1 })
    },

    stop() {
      const playback = playbackStates.get(this)
      if (!playback) return
      playback.id++
      if (this.data.playing || this.data.playbackFailed) {
        this.setData({ playing: false, playSrc: '', playbackFailed: false })
      }
    },
  },
})
