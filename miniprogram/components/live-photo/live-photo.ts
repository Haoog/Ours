import { resolveCloudUrl } from '../../services/store'

Component({
  properties: {
    cover: { type: String, value: '' },
    video: { type: String, value: '' },
    duration: { type: Number, value: 0 },
  },

  data: {
    playing: false,
    playSrc: '',
  },

  methods: {
    async onTap() {
      if (this.data.playing) {
        this.setData({ playing: false, playSrc: '' })
        return
      }
      const video = this.properties.video as string
      if (!video) return
      try {
        const playSrc = video.startsWith('cloud://') ? await resolveCloudUrl(video) : video
        this.setData({ playing: true, playSrc })
      } catch {
        wx.showToast({ title: '实况播放失败', icon: 'none' })
      }
    },

    stop() {
      this.setData({ playing: false, playSrc: '' })
    },
  },
})
