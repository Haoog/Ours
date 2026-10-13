import { callOurs } from '../../services/cloud-api'
import { coupleId } from '../../services/session'
import { ensureCloudReady } from '../../services/page-boot'
import { getThemeStyle, syncTheme } from '../../services/theme'

interface BackupInfo {
  snapshotFileID: string
  parts: number
  files: number
  moments: number
  createdAt: number
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    working: false,
    error: '',
    hint: '',
    info: null as BackupInfo | null,
    packages: [] as { part: number; name: string; path: string; missing: number }[],
  },
  async onLoad() {
    syncTheme(this)
    await ensureCloudReady()
  },
  async onStart() {
    if (this.data.working) return
    this.setData({ working: true, error: '', hint: '整理回忆…' })
    try {
      const info = await callOurs<BackupInfo>('startBackup', { coupleId: coupleId() })
      this.setData({ info, packages: [], hint: '' })
      await this.downloadNext()
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '备份失败，请重试' })
    } finally {
      this.setData({ working: false, hint: '' })
    }
  },
  async downloadNext() {
    const info = this.data.info
    if (!info) return
    const part = this.data.packages.length
    if (part >= info.parts) return
    this.setData({ hint: `生成备份 ${part + 1}/${info.parts}` })
    const result = await callOurs<{ url: string; name: string; missing: number }>('exportBackupPart', {
      coupleId: coupleId(), snapshotFileID: info.snapshotFileID, part,
    })
    const destination = `${wx.env.USER_DATA_PATH}/${info.createdAt}-${result.name}`
    await new Promise<void>((resolve, reject) => wx.downloadFile({
      url: result.url, filePath: destination,
      success: response => response.statusCode === 200 ? resolve() : reject(new Error('下载失败，请重试')),
      fail: reject,
    }))
    this.setData({ packages: [...this.data.packages, { part, name: result.name, path: destination, missing: result.missing }] })
  },
  async onContinue() {
    if (this.data.working) return
    this.setData({ working: true, error: '' })
    try { await this.downloadNext() } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '下载失败，请重试' })
    } finally { this.setData({ working: false, hint: '' }) }
  },
  onSave(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.packages[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.shareFileMessage({ filePath: item.path, fileName: item.name })
  },
})
