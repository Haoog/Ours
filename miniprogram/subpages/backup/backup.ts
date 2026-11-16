import { callOurs } from '../../services/cloud-api'
import { coupleId, requireSession } from '../../services/session'
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
    progressOwner: '',
    deletedParts: [] as number[],
    progressBlocked: false,
  },
  async onLoad() {
    syncTheme(this)
    this.refreshLocalPackages()
    await ensureCloudReady()
    this.restoreProgress()
  },
  progressKey() {
    const session = requireSession()
    return `OURS_BACKUP_PROGRESS_V1:${encodeURIComponent(session.coupleId!)}:${encodeURIComponent(session.openid)}`
  },
  saveProgress(info: BackupInfo, nextPart: number, packages: { part: number; name: string; path: string; missing: number }[], pending?: { part: number; name: string; path: string; missing: number }) {
    const key = this.progressKey()
    if (this.data.progressOwner && this.data.progressOwner !== key) throw new Error('用户或空间已切换，请重新打开备份页面')
    wx.setStorageSync(key, { info, nextPart, packages, pending, deletedParts: this.data.deletedParts })
  },
  restoreProgress() {
    try {
      const key = this.progressKey()
      if (this.data.progressOwner !== key) this.setData({ info: null, nextPart: 0, packages: [], deletedParts: [], progressBlocked: false, error: '' })
      this.setData({ progressOwner: key })
      const saved = wx.getStorageSync(key)
      const info = saved?.info as BackupInfo
      if (!info || !Number.isSafeInteger(info.createdAt) || !Number.isSafeInteger(info.parts) || info.parts < 1 || !Number.isSafeInteger(saved.nextPart) || saved.nextPart < 0 || saved.nextPart > info.parts || typeof info.snapshotFileID !== 'string' || !Array.isArray(saved.packages)) return
      const names = wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH)
      const deletedParts: number[] = Array.isArray(saved.deletedParts) ? saved.deletedParts.filter((part: unknown) => Number.isSafeInteger(part) && (part as number) >= 0 && (part as number) < saved.nextPart) : []
      const packages = saved.packages.filter((item: { part: number; name: string; path: string }) => Number.isSafeInteger(item.part) && item.part >= 0 && item.part < saved.nextPart && /^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(item.name) && item.path === `${wx.env.USER_DATA_PATH}/${info.createdAt}-${item.name}` && names.includes(`${info.createdAt}-${item.name}`))
      const missingParts = Array.from({ length: saved.nextPart }, (_, part) => part).filter(part => !deletedParts.includes(part) && !packages.some((item: { part: number }) => item.part === part))
      let nextPart = saved.nextPart
      const pending = saved.pending
      if (pending && pending.part === nextPart && /^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(pending.name) && pending.path === `${wx.env.USER_DATA_PATH}/${info.createdAt}-${pending.name}` && names.includes(`${info.createdAt}-${pending.name}`)) {
        packages.push(pending)
        nextPart++
        wx.setStorageSync(key, { info, nextPart, packages, deletedParts })
      }
      this.setData({ info, nextPart, packages, deletedParts, progressBlocked: missingParts.length > 0, error: missingParts.length ? `第 ${missingParts.map(part => part + 1).join('、')} 卷意外缺失或旧进度无法确认删除状态，请放弃进度并重新生成；已有备份包不会被覆盖。` : Date.now() - info.createdAt >= 86400000 && nextPart < info.parts ? '备份快照已过期，请放弃并重新生成；已下载的包仍可导出。' : '' })
    } catch { this.setData({ error: '无法读取备份进度，请检查存储后重试' }) }
  },
  onAbandon() {
    if (this.data.working || !this.data.info) return
    try {
      if (this.data.progressOwner !== this.progressKey()) throw new Error()
    } catch { this.setData({ error: '会话已失效或用户、空间已切换，请重新打开备份页面' }); return }
    const owner = this.data.progressOwner
    const info = this.data.info
    const nextPart = this.data.nextPart
    const packages = this.data.packages
    const deletedParts = this.data.deletedParts
    let savedAtOpen: string | undefined
    try { savedAtOpen = JSON.stringify(wx.getStorageSync(owner)) }
    catch { this.setData({ error: '无法读取备份进度，请检查存储后重试' }); return }
    wx.showModal({ title: '放弃本次备份进度？', content: '尚未下载的卷将无法继续，已下载的本地备份包不会删除。可以重新生成新备份。', confirmText: '放弃进度', success: res => {
      if (!res.confirm || this.data.working) return
      try {
        if (this.progressKey() !== owner || this.data.progressOwner !== owner || this.data.info !== info || this.data.nextPart !== nextPart || this.data.packages !== packages || this.data.deletedParts !== deletedParts) throw new Error('用户、空间或备份进度已变化，请重新操作')
        const saved = wx.getStorageSync(owner)
        if (JSON.stringify(saved) !== savedAtOpen || saved?.info?.snapshotFileID !== info.snapshotFileID || saved?.info?.createdAt !== info.createdAt || saved?.nextPart !== nextPart) throw new Error('备份进度已变化，请重新打开页面')
        wx.removeStorageSync(owner)
        this.setData({ info: null, packages: [], deletedParts: [], progressBlocked: false, nextPart: 0, error: '' })
      } catch (error) { this.setData({ error: error instanceof Error ? error.message : '无法清除备份进度，请重试' }) }
    } })
  },
  async onStart() {
    if (this.data.working || this.data.info) return
    this.setData({ working: true, error: '', hint: '整理回忆…' })
    try {
      this.setData({ progressOwner: this.progressKey() })
      const info = await callOurs<BackupInfo>('startBackup', { coupleId: coupleId() })
      this.saveProgress(info, 0, [])
      this.setData({ info, packages: [], deletedParts: [], progressBlocked: false, nextPart: 0, hint: '' })
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
    if (this.data.progressOwner !== this.progressKey()) throw new Error('用户或空间已切换，请重新打开备份页面')
    if (this.data.progressBlocked) throw new Error('备份卷缺失，请放弃进度并重新生成')
    const owner = this.data.progressOwner
    const part = this.data.nextPart
    const packagesBefore = this.data.packages.slice()
    const checkOwner = () => {
      if (this.progressKey() !== owner || this.data.progressOwner !== owner || this.data.info !== info || this.data.nextPart !== part) throw new Error('用户、空间或备份进度已变化，请重新打开备份页面')
    }
    if (part >= info.parts) return
    if (Date.now() - info.createdAt >= 86400000) throw new Error('备份快照已过期，请放弃并重新生成')
    this.setData({ hint: `生成备份 ${part + 1}/${info.parts}` })
    const result = await callOurs<{ fileID: string; url: string; name: string; missing: number }>('exportBackupPart', {
      coupleId: coupleId(), snapshotFileID: info.snapshotFileID, part,
    })
    checkOwner()
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
      checkOwner()
      ensureDestinationAvailable()
      this.saveProgress(info, part, packagesBefore, { part, name: result.name, path: destination, missing: result.missing })
      try {
        if (!result.url) throw new Error('下载链接不可用')
        await new Promise<void>((resolve, reject) => wx.downloadFile({
          url: result.url, filePath: temporary,
          success: response => response.statusCode === 200 ? resolve() : reject(new Error('下载失败，请重试')),
          fail: reject,
        }))
      } catch {
        checkOwner()
        removeTemporary()
        // Cloud storage may be accessible even when the temporary URL domain is unavailable.
        const downloaded = await wx.cloud.downloadFile({ fileID: result.fileID })
        checkOwner()
        if (!downloaded.tempFilePath) throw new Error('下载失败，请重试')
        await new Promise<void>((resolve, reject) => fs.copyFile({
          srcPath: downloaded.tempFilePath, destPath: temporary, success: () => resolve(), fail: reject,
        }))
      }
      checkOwner()
      ensureDestinationAvailable()
      await new Promise<void>((resolve, reject) => fs.rename({
        oldPath: temporary, newPath: destination, success: () => resolve(), fail: reject,
      }))
    } finally {
      removeTemporary()
    }
    checkOwner()
    const packages = [...packagesBefore, { part, name: result.name, path: destination, missing: result.missing }]
    this.saveProgress(info, part + 1, packages)
    this.setData({ nextPart: part + 1, packages })
    this.refreshLocalPackages()
  },
  async onContinue() {
    if (this.data.working) return
    this.setData({ working: true, error: '' })
    try {
      if (this.data.progressOwner !== this.progressKey()) throw new Error('用户或空间已切换，请重新打开备份页面')
      this.restoreProgress()
      if (this.data.progressBlocked) return
      await this.downloadNext()
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '下载失败，请重试' })
    } finally { this.setData({ working: false, hint: '' }) }
  },
  refreshLocalPackages() {
    try {
      const names = wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH)
      const localPackages = names.filter(name => /^\d+-Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(name))
        .sort().reverse().map(name => ({ name, path: `${wx.env.USER_DATA_PATH}/${name}` }))
      this.setData(this.data.progressBlocked ? { localPackages } : { localPackages, cleanupError: '' })
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
    const owner = this.data.progressOwner
    const info = this.data.info
    const nextPart = this.data.nextPart
    const packages = this.data.packages
    const deletedParts = this.data.deletedParts
    const current = () => this.progressKey() === owner && this.data.progressOwner === owner && this.data.info === info && this.data.nextPart === nextPart && this.data.packages === packages && this.data.deletedParts === deletedParts
    try { if (!current()) throw new Error() }
    catch { this.setData({ cleanupError: '会话已失效或用户、空间已切换，请重新打开备份页面' }); return }
    let savedAtOpen: string | undefined
    try { savedAtOpen = JSON.stringify(wx.getStorageSync(owner)) }
    catch { this.setData({ cleanupError: '无法读取备份进度，请检查存储后重试' }); return }
    wx.showModal({ title: '删除小程序内的备份包？', content: '请确认已将此包导出并妥善保存，或明确不再需要此包。分享成功不代表对方已保存。删除后本地文件无法找回。', confirmText: '删除', success: res => {
      if (!res.confirm || this.data.working) return
      try { if (!current()) throw new Error('用户、空间或备份进度已变化，请重新操作') }
      catch { this.setData({ cleanupError: '用户、空间或备份进度已变化，请重新操作' }); return }
      const removed = packages.find(pkg => pkg.path === item.path)
      if (info && removed) {
        let saved
        try { saved = wx.getStorageSync(owner) }
        catch { this.setData({ cleanupError: '无法读取备份进度，请检查存储后重试' }); return }
        if (JSON.stringify(saved) !== savedAtOpen || saved?.info?.snapshotFileID !== info.snapshotFileID || saved?.info?.createdAt !== info.createdAt || saved?.nextPart !== nextPart || !saved?.packages?.some((pkg: { path: string }) => pkg.path === item.path)) { this.setData({ cleanupError: '备份进度已变化，请重新打开页面' }); return }
      }
      wx.getFileSystemManager().unlink({ filePath: item.path, success: () => {
        const remaining = packages.filter(pkg => pkg.path !== item.path)
        let saveFailed = false
        if (info && removed) {
          try {
            const saved = wx.getStorageSync(owner)
            if (JSON.stringify(saved) !== savedAtOpen || saved?.info?.snapshotFileID !== info.snapshotFileID || saved?.info?.createdAt !== info.createdAt || saved?.nextPart !== nextPart) throw new Error('progress changed')
            wx.setStorageSync(owner, { info, nextPart, packages: remaining, deletedParts: [...deletedParts, removed.part] })
          } catch { saveFailed = true }
        }
        if (saveFailed && this.data.progressOwner === owner && this.data.info === info) {
          this.setData({ progressBlocked: true, cleanupError: '文件已删除，但进度保存失败；请重新打开页面检查并重新生成备份', error: '删除状态未能保存，请放弃进度并重新生成备份' })
        }
        let stillCurrent = false
        try { stillCurrent = current() } catch { /* session ended */ }
        if (!stillCurrent) return
        this.setData({ packages: remaining, deletedParts: removed && !saveFailed ? [...deletedParts, removed.part] : deletedParts, progressBlocked: saveFailed })
        this.refreshLocalPackages()
        if (saveFailed) this.setData({ cleanupError: '文件已删除，但进度保存失败；请重新打开页面检查并重新生成备份', error: '删除状态未能保存，请放弃进度并重新生成备份' })
      }, fail: () => { try { if (current()) this.setData({ cleanupError: '删除失败，请重试' }) } catch { /* session ended */ } } })
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
