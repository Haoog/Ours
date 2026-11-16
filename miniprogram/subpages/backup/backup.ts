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
    nextPart: 0,
    packages: [] as { part: number; name: string; path: string; missing: number }[],
    localPackages: [] as { name: string; path: string }[],
    cleanupError: '',
  },
  async onLoad() {
    syncTheme(this)
    this.refreshLocalPackages()
    await ensureCloudReady()
  },
  async onStart() {
    if (this.data.working) return
    this.setData({ working: true, error: '', hint: '整理回忆…' })
    try {
      const info = await callOurs<BackupInfo>('startBackup', { coupleId: coupleId() })
      this.setData({ info, packages: [], nextPart: 0, hint: '' })
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
    const part = this.data.nextPart
    if (part >= info.parts) return
    this.setData({ hint: `生成备份 ${part + 1}/${info.parts}` })
    const result = await callOurs<{ fileID: string; url: string; name: string; missing: number }>('exportBackupPart', {
      coupleId: coupleId(), snapshotFileID: info.snapshotFileID, part,
    })
    if (!/^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(result.name) || !Number.isSafeInteger(info.createdAt)) throw new Error('备份文件名无效')
    const destination = `${wx.env.USER_DATA_PATH}/${info.createdAt}-${result.name}`
    const fs = wx.getFileSystemManager()
    const temporary = `${wx.env.USER_DATA_PATH}/.ours-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    const removeTemporary = () => { try { fs.unlinkSync(temporary) } catch { /* absent or already removed */ } }
    const ensureDestinationAvailable = () => {
      if (fs.readdirSync(wx.env.USER_DATA_PATH).includes(`${info.createdAt}-${result.name}`)) {
        throw new Error('备份包已存在，请先导出或删除原文件')
      }
    }
    try {
      ensureDestinationAvailable()
      try {
        if (!result.url) throw new Error('下载链接不可用')
        await new Promise<void>((resolve, reject) => wx.downloadFile({
          url: result.url, filePath: temporary,
          success: response => response.statusCode === 200 ? resolve() : reject(new Error('下载失败，请重试')),
          fail: reject,
        }))
      } catch {
        removeTemporary()
        // Cloud storage may be accessible even when the temporary URL domain is unavailable.
        const downloaded = await wx.cloud.downloadFile({ fileID: result.fileID })
        if (!downloaded.tempFilePath) throw new Error('下载失败，请重试')
        await new Promise<void>((resolve, reject) => fs.copyFile({
          srcPath: downloaded.tempFilePath, destPath: temporary, success: () => resolve(), fail: reject,
        }))
      }
      ensureDestinationAvailable()
      await new Promise<void>((resolve, reject) => fs.rename({
        oldPath: temporary, newPath: destination, success: () => resolve(), fail: reject,
      }))
    } finally {
      removeTemporary()
    }
    this.setData({ nextPart: part + 1, packages: [...this.data.packages, { part, name: result.name, path: destination, missing: result.missing }] })
    this.refreshLocalPackages()
  },
  async onContinue() {
    if (this.data.working) return
    this.setData({ working: true, error: '' })
    try { await this.downloadNext() } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '下载失败，请重试' })
    } finally { this.setData({ working: false, hint: '' }) }
  },
  refreshLocalPackages() {
    try {
      const names = wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH)
      const localPackages = names.filter(name => /^\d+-Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(name))
        .sort().reverse().map(name => ({ name, path: `${wx.env.USER_DATA_PATH}/${name}` }))
      this.setData({ localPackages, cleanupError: '' })
    } catch {
      this.setData({ cleanupError: '无法读取本地备份，请稍后重试' })
    }
  },
  onSaveLocal(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.localPackages[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.shareFileMessage({ filePath: item.path, fileName: item.name, fail: error => {
      if (!error.errMsg?.includes('cancel')) wx.showToast({ title: '导出失败，请重试', icon: 'none' })
    } })
  },
  onDeleteLocal(e: WechatMiniprogram.BaseEvent) {
    if (this.data.working) return
    const item = this.data.localPackages[Number(e.currentTarget.dataset.index)]
    if (!item) return
    if (this.data.info && this.data.nextPart < this.data.info.parts && this.data.packages.some(pkg => pkg.path === item.path)) {
      wx.showToast({ title: '请先下载完本次所有备份包', icon: 'none' })
      return
    }
    wx.showModal({ title: '删除小程序内的备份包？', content: '请先确认已导出并妥善保存，或不再需要此包。删除后无法从小程序找回，已导出的文件不受影响。', confirmText: '删除', success: res => {
      if (!res.confirm || this.data.working) return
      wx.getFileSystemManager().unlink({ filePath: item.path, success: () => {
        this.setData({ packages: this.data.packages.filter(pkg => pkg.path !== item.path) })
        this.refreshLocalPackages()
      }, fail: () => this.setData({ cleanupError: '删除失败，请重试' }) })
    } })
  },
  onSave(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.packages[Number(e.currentTarget.dataset.index)]
    if (!item) return
    wx.shareFileMessage({
      filePath: item.path,
      fileName: item.name,
      fail: error => {
        if (!error.errMsg?.includes('cancel')) wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      },
    })
  },
})
