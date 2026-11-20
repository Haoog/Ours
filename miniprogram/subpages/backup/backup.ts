import { callOurs } from '../../services/cloud-api'
import { captureCoupleWriteSession, coupleId, requireSession } from '../../services/session'
import { ensureCloudReady } from '../../services/page-boot'
import { getThemeStyle, syncTheme } from '../../services/theme'

interface BackupInfo {
  snapshotFileID: string
  parts: number
  files: number
  moments: number
  createdAt: number
}

interface BackupPart {
  fileID: string
  url?: string
  name: string
  missing: number
}

interface BackupVolume {
  part: number
  name: string
  path: string
  missing: number
}

interface SavedBackupProgress {
  info: BackupInfo
  nextPart: number
  packages: BackupVolume[]
  pending?: BackupVolume
  deletedParts?: unknown
}

const PROGRESS_READ_ERROR = '无法读取备份进度，请检查存储后重试'
const PROGRESS_FORMAT_ERROR = '备份进度格式无效，可清除进度后重新生成。已下载的 ZIP 会保留。'
const PROGRESS_CLEAR_ERROR = '无法清除备份进度，请重试'
const LOCAL_STORAGE_FULL = '本地存储空间不足，请释放小程序或设备的存储空间，再点「下载下一包」重试。'

function backupErrorMessage(error: unknown, fallback: string): string {
  const errMsg = (error as { errMsg?: unknown } | null)?.errMsg
  if (typeof errMsg === 'string' && errMsg.trim()) return errMsg.trim()
  return (error instanceof Error && error.message) || fallback
}

function isLocalStorageFull(error: unknown): boolean {
  return /\b(?:ENOSPC|EDQUOT|no space left on device|disk quota exceeded|(?:not enough|insufficient) (?:disk|storage) space|file storage limit (?:is )?exceeded)\b|(?:磁盘|存储)空间不足|磁盘已满/i.test(backupErrorMessage(error, ''))
}

function backupPartKey(owner: string, info: BackupInfo, part: number): string {
  return JSON.stringify([owner, info.snapshotFileID, info.createdAt, part])
}

// Backup pages share the local files and persisted progress, even across reopen.
let activeOperation: { page: object; done: Promise<void> } | undefined
let activeShare: (() => void) | undefined

function beginOperation(page: object) {
  if (activeOperation) return
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  activeOperation = { page, done }
  return () => {
    activeOperation = undefined
    finish()
  }
}

function confirmedParts(parts: unknown, nextPart: number): number[] {
  return Array.isArray(parts) ? parts.filter(part => Number.isSafeInteger(part) && part >= 0 && part < nextPart) : []
}

class ProgressReadError extends Error {}

function isEmptyProgress(saved: unknown): boolean {
  return saved === undefined || saved === ''
}

function isSavedProgress(value: unknown): value is SavedBackupProgress {
  const saved = value as SavedBackupProgress | null | undefined
  const info = saved?.info
  return !!saved && !!info && Number.isSafeInteger(info.createdAt) && Number.isSafeInteger(info.parts) && info.parts >= 1 &&
    typeof info.snapshotFileID === 'string' && Number.isSafeInteger(saved.nextPart) && saved.nextPart >= 0 && saved.nextPart <= info.parts &&
    Array.isArray(saved.packages) && saved.packages.every(item => item && Number.isSafeInteger(item.part) && typeof item.name === 'string' && typeof item.path === 'string')
}

Page({
  loading: false,
  unloaded: false,
  waitingToReload: false,
  finishShare: undefined as (() => void) | undefined,
  cancelConfirmation: undefined as (() => void) | undefined,
  generatedPart: undefined as { key: string; result: BackupPart } | undefined,
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
    progressIssue: '' as '' | 'invalid' | 'read',
  },
  async onLoad() {
    this.loading = true
    try {
      syncTheme(this)
      await ensureCloudReady()
      while (activeOperation && !this.unloaded) await activeOperation.done
    } finally { this.loading = false }
    this.reloadProgress()
  },
  onShow() {
    this.reloadProgress()
  },
  reloadProgress() {
    if (this.unloaded || this.loading) return
    if (activeOperation) {
      if (activeOperation.page === this || this.waitingToReload) return
      this.waitingToReload = true
      void activeOperation.done.then(() => {
        this.waitingToReload = false
        this.reloadProgress()
      })
      return
    }
    this.refreshLocalPackages()
    this.restoreProgress()
  },
  onUnload() {
    this.unloaded = true
    this.generatedPart = undefined
    this.cancelConfirmation?.()
    this.finishShare?.()
  },
  async confirmAction(options: Pick<WechatMiniprogram.ShowModalOption, 'title' | 'content' | 'confirmText'>) {
    try {
      return await new Promise<boolean>((resolve, reject) => {
        this.cancelConfirmation = () => resolve(false)
        wx.showModal({ ...options, success: res => resolve(res.confirm), fail: reject })
      })
    } finally { this.cancelConfirmation = undefined }
  },
  progressKey() {
    const session = requireSession()
    return `OURS_BACKUP_PROGRESS_V1:${encodeURIComponent(session.coupleId!)}:${encodeURIComponent(session.openid)}`
  },
  requireProgressOwner(owner: string) {
    try { if (this.progressKey() === owner) return }
    catch { /* session ended */ }
    this.generatedPart = undefined
    throw new Error('会话已失效或用户、空间已切换，请重新打开备份页面')
  },
  readProgress(owner: string) {
    try { return wx.getStorageSync(owner) }
    catch { throw new ProgressReadError(PROGRESS_READ_ERROR) }
  },
  saveProgress(info: BackupInfo, nextPart: number, packages: BackupVolume[], pending?: BackupVolume) {
    const key = this.progressKey()
    if (this.data.progressOwner && this.data.progressOwner !== key) throw new Error('用户或空间已切换，请重新打开备份页面')
    wx.setStorageSync(key, { info, nextPart, packages, pending, deletedParts: this.data.deletedParts })
  },
  resetProgress(progressIssue: '' | 'invalid' = '') {
    this.generatedPart = undefined
    this.setData({ info: null, nextPart: 0, packages: [], deletedParts: [], progressBlocked: false, progressIssue, error: progressIssue ? PROGRESS_FORMAT_ERROR : '' })
  },
  restoreProgress() {
    try {
      const key = this.progressKey()
      if (this.data.progressOwner !== key) this.resetProgress()
      this.setData({ progressOwner: key })
      const saved: unknown = this.readProgress(key)
      if (isEmptyProgress(saved)) {
        this.resetProgress()
        return true
      }
      if (!isSavedProgress(saved)) {
        this.resetProgress('invalid')
        return false
      }
      const { info } = saved
      const names = wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH)
      const deletedParts = confirmedParts(saved.deletedParts, saved.nextPart)
      const packages = saved.packages.filter(item => Number.isSafeInteger(item.part) && item.part >= 0 && item.part < saved.nextPart && /^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(item.name) && item.path === `${wx.env.USER_DATA_PATH}/${info.createdAt}-${item.name}` && names.includes(`${info.createdAt}-${item.name}`))
      const missingParts = Array.from({ length: saved.nextPart }, (_, part) => part).filter(part => !deletedParts.includes(part) && !packages.some(item => item.part === part))
      let nextPart = saved.nextPart
      const pending = saved.pending
      if (pending?.part === nextPart && typeof pending.name === 'string' && /^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(pending.name) && pending.path === `${wx.env.USER_DATA_PATH}/${info.createdAt}-${pending.name}` && names.includes(`${info.createdAt}-${pending.name}`)) {
        packages.push(pending)
        nextPart++
        wx.setStorageSync(key, { info, nextPart, packages, deletedParts })
      }
      if (this.generatedPart?.key !== backupPartKey(key, info, nextPart)) this.generatedPart = undefined
      this.setData({ info, nextPart, packages, deletedParts, progressIssue: '', progressBlocked: missingParts.length > 0, error: missingParts.length ? `第 ${missingParts.map(part => part + 1).join('、')} 卷意外缺失或旧进度无法确认删除状态，请放弃进度并重新生成；已有备份包不会被覆盖。` : Date.now() - info.createdAt >= 86400000 && nextPart < info.parts ? '备份快照已过期，请放弃并重新生成；已下载的包仍可导出。' : '' })
      return true
    } catch {
      this.setData({ progressIssue: 'read', error: PROGRESS_READ_ERROR })
      return false
    }
  },
  async onAbandon() {
    const { progressOwner: owner, info, nextPart, progressIssue } = this.data
    const invalid = progressIssue === 'invalid'
    if (this.unloaded || this.loading || progressIssue === 'read' || (!info && !invalid)) return
    const finish = beginOperation(this)
    if (!finish) return
    const changed = '备份进度已变化，请重新打开页面'
    try {
      this.requireProgressOwner(owner)
      const session = captureCoupleWriteSession()
      const saved: unknown = this.readProgress(owner)
      const matches = invalid
        ? !isEmptyProgress(saved) && !isSavedProgress(saved)
        : info && isSavedProgress(saved) && saved.info.snapshotFileID === info.snapshotFileID && saved.info.createdAt === info.createdAt && saved.nextPart === nextPart
      if (!matches) throw new Error(changed)
      const savedAtOpen = JSON.stringify(saved)
      const confirmed = await this.confirmAction({
        title: invalid ? '清除损坏的备份进度？' : '放弃本次备份进度？',
        content: '尚未下载的卷将无法继续，已下载的本地备份包不会删除。可以重新生成新备份。',
        confirmText: invalid ? '清除进度' : '放弃进度',
      })
      if (!confirmed || this.unloaded) return
      this.requireProgressOwner(owner)
      if (!session.getCurrent()) throw new Error('用户或空间已切换，请重新打开备份页面')
      if (this.data.progressOwner !== owner || this.data.info !== info || this.data.nextPart !== nextPart || this.data.progressIssue !== progressIssue) throw new Error(changed)
      if (JSON.stringify(this.readProgress(owner)) !== savedAtOpen) throw new Error(changed)
      try { wx.removeStorageSync(owner) }
      catch { throw new Error(PROGRESS_CLEAR_ERROR) }
      this.resetProgress()
    } catch (error) {
      if (this.unloaded || this.data.progressOwner !== owner) return
      if (error instanceof ProgressReadError) this.setData({ progressIssue: 'read', error: PROGRESS_READ_ERROR })
      else this.setData({ error: error instanceof Error ? error.message : PROGRESS_CLEAR_ERROR })
    } finally { finish() }
  },
  async onStart() {
    if (this.unloaded || this.loading || this.data.info || this.data.progressIssue) return
    const finish = beginOperation(this)
    if (!finish) return
    this.setData({ working: true, error: '', hint: '整理回忆…' })
    try {
      const owner = this.progressKey()
      if (!this.restoreProgress() || this.data.info) return
      const info = await callOurs<BackupInfo>('startBackup', { coupleId: coupleId() })
      if (this.unloaded) return
      this.requireProgressOwner(owner)
      this.saveProgress(info, 0, [])
      this.setData({ info, packages: [], deletedParts: [], progressBlocked: false, nextPart: 0, hint: '' })
      await this.downloadNext()
    } catch (error) {
      if (!this.unloaded) this.setData({ error: backupErrorMessage(error, '备份失败，请重试') })
    } finally {
      if (!this.unloaded) this.setData({ working: false, hint: '' })
      finish()
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
      if (this.unloaded) throw new Error('备份页面已关闭')
      this.requireProgressOwner(owner)
      if (this.data.progressOwner !== owner || this.data.info !== info || this.data.nextPart !== part) throw new Error('用户、空间或备份进度已变化，请重新打开备份页面')
    }
    if (part >= info.parts) return
    if (Date.now() - info.createdAt >= 86400000) {
      this.generatedPart = undefined
      throw new Error('备份快照已过期，请放弃并重新生成')
    }
    const key = backupPartKey(owner, info, part)
    if (this.generatedPart?.key !== key) this.generatedPart = undefined
    let result = this.generatedPart?.result
    if (!result) {
      this.setData({ hint: `生成备份 ${part + 1}/${info.parts}` })
      result = await callOurs<BackupPart>('exportBackupPart', { coupleId: coupleId(), snapshotFileID: info.snapshotFileID, part })
      checkOwner()
      if (!/^Ours-\d{4}-\d{2}-\d{2}-\d+\.zip$/.test(result.name) || !Number.isSafeInteger(info.createdAt)) throw new Error('备份文件名无效')
      if (!this.unloaded) this.generatedPart = { key, result }
    }
    this.setData({ hint: `下载备份 ${part + 1}/${info.parts}` })
    const { fileID, url, name, missing } = result
    const destination = `${wx.env.USER_DATA_PATH}/${info.createdAt}-${name}`
    const volume = { part, name, path: destination, missing }
    const fs = wx.getFileSystemManager()
    const temporary = `${wx.env.USER_DATA_PATH}/.ours-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    const removeTemporary = () => { try { fs.unlinkSync(temporary) } catch { /* absent or already removed */ } }
    const ensureDestinationAvailable = () => {
      if (fs.readdirSync(wx.env.USER_DATA_PATH).includes(`${info.createdAt}-${name}`)) {
        throw new Error('备份包已存在，请先导出或删除原文件')
      }
    }
    const rejectWrite = (reject: (reason: unknown) => void) => (error: unknown) => {
      reject(isLocalStorageFull(error) ? new Error(LOCAL_STORAGE_FULL) : error)
    }
    try {
      checkOwner()
      ensureDestinationAvailable()
      this.saveProgress(info, part, packagesBefore, volume)
      try {
        if (!url) throw new Error('下载链接不可用')
        await new Promise<void>((resolve, reject) => wx.downloadFile({
          url, filePath: temporary,
          success: ({ statusCode }) => {
            if (statusCode === 200) return resolve()
            // The cloud file may still work after its temporary link becomes unusable.
            if ([401, 403, 404, 410].includes(statusCode)) this.generatedPart = undefined
            reject(new Error('下载失败，请重试'))
          },
          fail: reject,
        }))
      } catch (error) {
        checkOwner()
        if (isLocalStorageFull(error)) throw new Error(LOCAL_STORAGE_FULL)
        removeTemporary()
        const downloaded = await wx.cloud.downloadFile({ fileID }).catch(error => {
          if (isLocalStorageFull(error)) throw new Error(LOCAL_STORAGE_FULL)
          if (error?.errCode === -503003 || /\b(?:STORAGE_FILE_NONEXIST|storage file not exists?)\b/i.test(backupErrorMessage(error, ''))) this.generatedPart = undefined
          throw error
        })
        checkOwner()
        if (!downloaded.tempFilePath) throw new Error('下载失败，请重试')
        await new Promise<void>((resolve, reject) => fs.copyFile({
          srcPath: downloaded.tempFilePath, destPath: temporary, success: () => resolve(), fail: rejectWrite(reject),
        }))
      }
      checkOwner()
      ensureDestinationAvailable()
      await new Promise<void>((resolve, reject) => fs.rename({
        oldPath: temporary, newPath: destination, success: () => resolve(), fail: rejectWrite(reject),
      }))
    } finally {
      removeTemporary()
    }
    checkOwner()
    const packages = [...packagesBefore, volume]
    this.saveProgress(info, part + 1, packages)
    this.generatedPart = undefined
    this.setData({ nextPart: part + 1, packages })
    this.refreshLocalPackages()
  },
  async onContinue() {
    if (this.unloaded || this.loading || this.data.progressIssue) return
    const finish = beginOperation(this)
    if (!finish) return
    this.setData({ working: true, error: '' })
    try {
      this.requireProgressOwner(this.data.progressOwner)
      if (!this.restoreProgress() || this.data.progressBlocked) return
      await this.downloadNext()
    } catch (error) {
      if (!this.unloaded) this.setData({ error: backupErrorMessage(error, '下载失败，请重试') })
    } finally {
      if (!this.unloaded) this.setData({ working: false, hint: '' })
      finish()
    }
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
  shareBackupVolume(item: { name: string; path: string }, failureMessage: string) {
    if (this.unloaded || activeShare || activeOperation) return
    if (typeof wx.shareFileMessage !== 'function') {
      wx.showToast({ title: '无法导出，备份包已保留', icon: 'none' })
      return
    }
    const finish = () => {
      if (activeShare !== finish) return false
      activeShare = undefined
      this.finishShare = undefined
      return !this.unloaded
    }
    const fail = (error: unknown) => {
      if (finish() && !/\bcancel(?:led|ed)?\b/i.test(backupErrorMessage(error, ''))) {
        wx.showToast({ title: failureMessage, icon: 'none' })
      }
    }
    this.finishShare = finish
    activeShare = finish
    try {
      wx.shareFileMessage({ filePath: item.path, fileName: item.name, success: finish, fail })
    } catch (error) { fail(error) }
  },
  onSaveLocal(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.localPackages.find(pkg => pkg.path === e.currentTarget.dataset.path)
    if (item) this.shareBackupVolume(item, '导出失败，请重试')
  },
  async onDeleteLocal(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.localPackages.find(pkg => pkg.path === e.currentTarget.dataset.path)
    if (this.unloaded || this.loading || activeShare || !item) return
    const finish = beginOperation(this)
    if (!finish) return
    const { progressOwner: owner, info, nextPart, packages, deletedParts } = this.data
    const samePageProgress = () => !this.unloaded && this.data.progressOwner === owner && this.data.info === info && this.data.nextPart === nextPart
    const changed = '备份进度已变化，请重新打开页面'
    try {
      this.requireProgressOwner(owner)
      const session = captureCoupleWriteSession()
      const savedAtOpen = JSON.stringify(this.readProgress(owner))
      const confirmed = await this.confirmAction({
        title: '删除小程序内的备份包？',
        content: '请确认已将此包导出并妥善保存，或明确不再需要此包。分享成功不代表对方已保存。删除后本地文件无法找回。',
        confirmText: '删除',
      })
      if (!confirmed || this.unloaded) return
      this.requireProgressOwner(owner)
      if (!session.getCurrent()) throw new Error('用户或空间已切换，请重新打开备份页面')
      if (!samePageProgress()) throw new Error(changed)
      const saved = this.readProgress(owner)
      if (JSON.stringify(saved) !== savedAtOpen || saved?.pending?.path === item.path) throw new Error(changed)
      const removed = packages.find(pkg => pkg.path === item.path)
      const storedPackages = Array.isArray(saved?.packages) ? saved.packages : []
      const stored = storedPackages.find((pkg: { path: string }) => pkg.path === item.path)
      if (removed || stored) {
        if (!info || !removed || stored?.part !== removed.part || saved?.info?.snapshotFileID !== info.snapshotFileID || saved?.info?.createdAt !== info.createdAt || saved?.nextPart !== nextPart) throw new Error(changed)
      }
      await new Promise<void>((resolve, reject) => wx.getFileSystemManager().unlink({
        filePath: item.path, success: () => resolve(), fail: () => reject(new Error('删除失败，请重试')),
      }))
      let nextDeletedParts = deletedParts
      if (removed) {
        try {
          if (JSON.stringify(this.readProgress(owner)) !== savedAtOpen) throw new Error(changed)
          nextDeletedParts = Array.from(new Set([...confirmedParts(saved.deletedParts, nextPart), removed.part]))
          wx.setStorageSync(owner, { ...saved, packages: storedPackages.filter((pkg: { path: string }) => pkg.path !== item.path), deletedParts: nextDeletedParts })
        } catch {
          if (samePageProgress()) {
            this.setData({ packages: packages.filter(pkg => pkg.path !== item.path), progressBlocked: true })
            this.refreshLocalPackages()
            this.setData({
              cleanupError: '文件已删除，但进度保存失败；请重新打开页面检查并重新生成备份',
              error: '删除状态未能保存，请放弃进度并重新生成备份',
            })
          }
          return
        }
      }
      if (!samePageProgress()) return
      try { this.requireProgressOwner(owner) } catch { return }
      if (removed) this.setData({ packages: packages.filter(pkg => !nextDeletedParts.includes(pkg.part)), deletedParts: nextDeletedParts })
      this.refreshLocalPackages()
    } catch (error) {
      if (samePageProgress()) this.setData({ cleanupError: error instanceof Error ? error.message : '删除失败，请重试' })
    } finally { finish() }
  },
  onSave(e: WechatMiniprogram.BaseEvent) {
    const item = this.data.packages.find(pkg => pkg.path === e.currentTarget.dataset.path)
    if (item) this.shareBackupVolume(item, '保存失败，请重试')
  },
})
