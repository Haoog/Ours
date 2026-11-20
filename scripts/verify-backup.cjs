const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')
const ts = require('typescript')

const storage = new Map(), files = new Set()
const removeAttempts = [], shares = [], toasts = []
let page, user = 'a', modal, downloads = 0, unlinks = 0, failDelete = false, failStorage = false, failRead = false, missingSession = false, holdDownload = null, holdRename = null, holdDelete = null
let holdBoot, starts = 0, exportsRequested = 0, reads = 0, passed = false
let space = 'space', sessionRevision = 0, failRemove = false
const switchSession = (openid, coupleId) => {
  if (user !== openid || space !== coupleId) sessionRevision++
  user = openid
  space = coupleId
}
const requireSession = () => {
  if (missingSession) throw new Error('尚未完成空间初始化')
  return { coupleId: space, openid: user }
}
let downloadError, copyError, renameError, downloadStatus = 200, omitUrl = false
const unavailableCloud = new Error('cloud download failed')
let cloudError = unavailableCloud, cloudDownloads = 0, renameAttempts = 0
let lastUrl, lastFileID, lastExport
const cloudTemp = 'cloud-download.tmp'
process.on('beforeExit', () => { if (!passed && !process.exitCode) throw new Error('Backup regression stopped before finishing') })
const info = { snapshotFileID: 'cloud://snapshot', parts: 2, files: 2, moments: 1, createdAt: Date.now() }
const wx = {
  env: { USER_DATA_PATH: '/data' },
  getStorageSync: key => { reads++; if (failRead) throw new Error('storage failed'); return storage.get(key) },
  setStorageSync: (key, value) => { if (failStorage) throw new Error('storage failed'); storage.set(key, structuredClone(value)) },
  removeStorageSync: key => {
    removeAttempts.push(key)
    if (failRemove) throw { errMsg: 'removeStorageSync:fail' }
    storage.delete(key)
  },
  getFileSystemManager: () => ({
    readdirSync: () => [...files], unlinkSync: p => files.delete(p.split('/').pop()),
    unlink: ({ filePath, success, fail }) => {
      unlinks++
      if (failDelete) return fail()
      const remove = () => files.delete(filePath.split('/').pop())
      const run = () => { remove(); success() }
      if (holdDelete) Object.assign(holdDelete, { remove, success, fail, run })
      else run()
    },
    copyFile: ({ srcPath, destPath, success, fail }) => {
      assert.equal(srcPath, `/tmp/${cloudTemp}`)
      files.add(destPath.split('/').pop())
      if (copyError) return fail(copyError)
      success()
    },
    rename: ({ oldPath, newPath, success, fail }) => {
      renameAttempts++
      const target = newPath.split('/').pop()
      assert.ok(!files.has(target), `rename would overwrite ${target}`)
      if (renameError) return fail(renameError)
      const run = () => { files.delete(oldPath.split('/').pop()); files.add(target); success() }
      if (holdRename) holdRename.run = run
      else run()
    },
  }),
  downloadFile: ({ url, filePath, success, fail }) => {
    downloads++
    lastUrl = url
    files.add(filePath.split('/').pop())
    if (downloadError) return fail(downloadError)
    const run = () => success({ statusCode: downloadStatus })
    if (holdDownload) holdDownload.run = run
    else run()
  },
  cloud: { downloadFile: async ({ fileID }) => {
    cloudDownloads++
    lastFileID = fileID
    if (cloudError) throw cloudError
    files.add(cloudTemp)
    return { tempFilePath: `/tmp/${cloudTemp}` }
  } },
  showModal: options => { modal = options },
  showToast: options => { toasts.push(options.title) },
  shareFileMessage: options => { shares.push(options) },
}
const source = ts.transpileModule(fs.readFileSync('miniprogram/subpages/backup/backup.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const context = vm.createContext({ wx, Date, Math, Number, Error, encodeURIComponent, exports: {}, Page: value => { page = value }, require: id => {
  if (id.includes('session')) return {
    coupleId: () => requireSession().coupleId,
    requireSession,
    captureCoupleWriteSession() {
      const owner = requireSession(), revision = sessionRevision
      return { getCurrent: () => !missingSession && sessionRevision === revision && owner.openid === user && owner.coupleId === space ? requireSession() : null }
    },
  }
  if (id.includes('cloud-api')) return { callOurs: async (action, payload) => {
    if (action === 'startBackup') { starts++; return info }
    exportsRequested++
    lastExport = payload
    return {
      fileID: `cloud://zip-${exportsRequested}`, url: omitUrl ? undefined : `https://example.invalid/zip-${exportsRequested}`,
      name: `Ours-2026-01-01-${payload.part + 1}.zip`, missing: 0,
    }
  } }
  if (id.includes('page-boot')) return { ensureCloudReady: () => holdBoot ? new Promise(resolve => { holdBoot.run = resolve }) : Promise.resolve() }
  return { getThemeStyle: () => '', syncTheme() {} }
} })
vm.runInContext(source, context)
const createPage = () => { const instance = { ...page, data: structuredClone(page.data) }; instance.setData = value => Object.assign(instance.data, value); return instance }
const packageEvent = path => ({ currentTarget: { dataset: { path } } })
const deletePackage = (page, index = 0) => page.onDeleteLocal(packageEvent(page.data.localPackages[index]?.path))
const answer = async (action, confirm = true) => { modal.success({ confirm }); await action }
const tick = () => new Promise(resolve => setImmediate(resolve))
const template = fs.readFileSync('miniprogram/subpages/backup/backup.wxml', 'utf8')
const actionVisible = (page, action) => {
  const binding = template.match(new RegExp(`<view\\s+wx:if="\\{\\{([^"]+)\\}\\}"[^>]*bindtap="${action}"`))
  return Boolean(binding && vm.runInNewContext(binding[1], { ...page.data }))
}
;(async () => {
  let p = createPage()
  missingSession = true
  await p.onStart()
  assert.match(p.data.error, /尚未完成空间初始化/); assert.equal(p.data.working, false); assert.equal(p.data.hint, '')
  assert.equal(downloads, 0); assert.equal(storage.size, 0)
  missingSession = false
  await p.onStart()
  assert.equal(p.data.nextPart, 1)
  assert.equal(downloads, 1)
  p = createPage(); p.restoreProgress(); assert.equal(p.data.nextPart, 1)
  user = 'b'; const other = createPage(); other.restoreProgress(); assert.equal(other.data.info, null); user = 'a'
  p.refreshLocalPackages(); let deleting = deletePackage(p)
  assert.equal(files.size, 1); await answer(deleting, false); assert.equal(files.size, 1)
  const unlinksBeforeReadFailure = unlinks, savedBeforeReadFailure = structuredClone(storage.get(p.data.progressOwner))
  deleting = deletePackage(p); failRead = true; await answer(deleting); failRead = false
  assert.match(p.data.cleanupError, /无法读取备份进度/); assert.equal(unlinks, unlinksBeforeReadFailure)
  assert.equal(files.size, 1); assert.deepEqual(storage.get(p.data.progressOwner), savedBeforeReadFailure)
  failDelete = true; await answer(deletePackage(p)); assert.equal(files.size, 1); assert.match(p.data.cleanupError, /删除失败/)
  failDelete = false; await answer(deletePackage(p)); assert.equal(files.size, 0)
  downloadError = new Error('download failed'); await p.onContinue(); assert.equal(p.data.nextPart, 1); assert.equal(files.size, 0); assert.ok(p.data.error)
  downloadError = undefined; await p.onContinue(); assert.equal(p.data.nextPart, 2); assert.equal(downloads, 3)
  p = createPage(); p.restoreProgress(); assert.equal(p.data.nextPart, 2)
  await answer(p.onAbandon()); assert.equal(files.size, 1); assert.equal(p.data.info, null)
  const expired = { ...info, createdAt: Date.now() - 86400001 }
  p.saveProgress(expired, 0, []); p.restoreProgress(); assert.match(p.data.error, /过期/)
  await p.onContinue(); assert.match(p.data.error, /过期/); assert.equal(downloads, 3)
  // Confirmation must never act on a newly selected owner.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart()
  const keyA = p.progressKey(); const abandoning = p.onAbandon(); user = 'b'; const keyB = p.progressKey()
  storage.set(keyB, { marker: 'B' }); await answer(abandoning)
  assert.deepEqual(storage.get(keyB), { marker: 'B' }); assert.ok(storage.has(keyA))
  user = 'a'; p.refreshLocalPackages(); deleting = deletePackage(p); user = 'b'; await answer(deleting); assert.equal(files.size, 1)
  // Failed reads or missing sessions must not open a confirmation or change data.
  user = 'a'; p.refreshLocalPackages()
  const savedBefore = structuredClone(storage.get(keyA)), filesBefore = [...files]
  for (const failure of ['read', 'session']) {
    const infoBefore = p.data.info
    failRead = failure === 'read'; missingSession = failure === 'session'
    modal = null; await p.onAbandon(); assert.equal(modal, null); assert.match(p.data.error, failure === 'read' ? /无法读取备份进度/ : /会话已失效/)
    modal = null; await deletePackage(p); assert.equal(modal, null); assert.match(p.data.cleanupError, failure === 'read' ? /无法读取备份进度/ : /会话已失效/)
    assert.deepEqual(storage.get(keyA), savedBefore); assert.deepEqual([...files], filesBefore); assert.equal(p.data.info, infoBefore)
    failRead = false; missingSession = false
    if (p.data.progressIssue === 'read') p.reloadProgress()
  }
  // An unexplained missing volume cannot be silently marked complete.
  user = 'a'; files.clear(); p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/)
  const before = downloads; await p.onContinue(); assert.equal(downloads, before); assert.match(p.data.error, /缺失/)
  // Missing a completed volume, including an ambiguous legacy record, is blocked.
  storage.set(keyA, { info, nextPart: 2, packages: [] }); p = createPage(); p.restoreProgress()
  assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/)
  // A pre-existing destination is never overwritten.
  storage.clear(); files.clear(); files.add(`${info.createdAt}-Ours-2026-01-01-1.zip`)
  const beforeCollisionRenames = renameAttempts, beforeCollisionDownloads = downloads
  p = createPage(); await p.onStart(); assert.match(p.data.error, /已存在/); assert.equal(files.size, 1)
  assert.equal(renameAttempts, beforeCollisionRenames); assert.equal(downloads, beforeCollisionDownloads)
  // Confirmed deletion is recorded and survives a restart.
  storage.clear(); files.clear(); p = createPage(); await p.onStart(); p.refreshLocalPackages()
  await answer(deletePackage(p))
  p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.deletedParts[0], 0)
  await p.onContinue(); assert.equal(p.data.nextPart, 2)
  // Switching during the download cleans only this download's temporary file.
  storage.clear(); files.clear(); p = createPage(); holdDownload = {}; const downloading = p.onStart()
  await tick(); assert.equal(typeof holdDownload.run, 'function')
  files.add('user-file.tmp'); user = 'b'; holdDownload.run(); await downloading; holdDownload = null
  assert.deepEqual([...files], ['user-file.tmp']); assert.equal(storage.get(keyA).nextPart, 0)
  // Rename completes after a switch: the pending journal recovers the finished file.
  user = 'a'; storage.clear(); files.clear(); p = createPage(); holdRename = {}; const renaming = p.onStart()
  await tick(); assert.equal(typeof holdRename.run, 'function')
  user = 'b'; holdRename.run(); await renaming; holdRename = null
  user = 'a'; p = createPage(); p.restoreProgress(); assert.equal(p.data.nextPart, 1); assert.equal(p.data.packages.length, 1)
  // Delete may finish after switching: record A's deletion without touching B's state.
  p.refreshLocalPackages(); holdDelete = {}; deleting = deletePackage(p); modal.success({ confirm: true }); await tick()
  user = 'b'; holdDelete.run(); await deleting; holdDelete = null; assert.deepEqual(storage.get(keyA).deletedParts, [0])
  user = 'a'; p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, false)
  // A failed persistence after a successful unlink stays visible after refreshing.
  storage.clear(); files.clear(); p = createPage(); await p.onStart(); p.refreshLocalPackages()
  holdDelete = {}; deleting = deletePackage(p); modal.success({ confirm: true }); await tick()
  failStorage = true; holdDelete.run(); await deleting; failStorage = false; holdDelete = null
  assert.match(p.data.cleanupError, /保存失败/); p.refreshLocalPackages(); assert.match(p.data.cleanupError, /保存失败/)
  p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, true)
  // Two completed volumes: a failed write after switching sessions must invalidate
  // the still-visible A page immediately, and remain blocked after restoring A.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart(); await p.onContinue(); p.refreshLocalPackages()
  const completedA = structuredClone(storage.get(keyA))
  storage.set(keyB, { marker: 'B' }); const untouchedB = structuredClone(storage.get(keyB))
  holdDelete = {}; deleting = deletePackage(p); modal.success({ confirm: true }); await tick()
  user = 'b'; failStorage = true; holdDelete.run(); await deleting; failStorage = false; holdDelete = null
  assert.equal(p.data.progressOwner, keyA); assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, true)
  assert.match(p.data.error, /删除状态未能保存/); assert.match(p.data.cleanupError, /保存失败/)
  assert.deepEqual(storage.get(keyA), completedA); assert.deepEqual(storage.get(keyB), untouchedB)
  user = 'a'; p.restoreProgress(); assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/)
  assert.equal(p.data.packages.length, 1); assert.deepEqual(storage.get(keyA), completedA)
  // If B has actually loaded before the callback, neither its UI nor storage
  // may change; restoring A still detects the missing completed volume.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart(); await p.onContinue(); p.refreshLocalPackages()
  const completedA2 = structuredClone(storage.get(keyA))
  const bInfo = { ...info, snapshotFileID: 'cloud://b', createdAt: info.createdAt + 1 }
  const bName = 'Ours-2026-01-01-1.zip', bPath = `/data/${bInfo.createdAt}-${bName}`
  files.add(bPath.split('/').pop()); storage.set(keyB, { info: bInfo, nextPart: 1, packages: [{ part: 0, name: bName, path: bPath, missing: 0 }], deletedParts: [] })
  const savedB = structuredClone(storage.get(keyB))
  holdDelete = {}; deleting = deletePackage(p, 1); modal.success({ confirm: true }); await tick()
  user = 'b'; p.restoreProgress(); const pageB = structuredClone(p.data)
  failStorage = true; holdDelete.run(); await deleting; failStorage = false; holdDelete = null
  assert.deepEqual(structuredClone(p.data), pageB); assert.deepEqual(storage.get(keyB), savedB); assert.deepEqual(storage.get(keyA), completedA2)
  user = 'a'; p.restoreProgress(); assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/); assert.equal(p.data.packages.length, 1)
  assert.deepEqual(storage.get(keyB), savedB); assert.deepEqual(storage.get(keyA), completedA2)
  // Successful confirmed deletion of a completed volume remains complete.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart(); await p.onContinue(); p.refreshLocalPackages()
  await answer(deletePackage(p))
  assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.error, '')
  assert.equal(storage.get(keyA).deletedParts.length, 1); assert.equal(storage.get(keyA).packages.length, 1)
  p.restoreProgress(); assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.error, '')
  // A reopened page waits past the gap between physical deletion and its callback.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad(); await p.onStart()
  const firstVolume = p.data.packages[0]
  const savedFirst = structuredClone(storage.get(keyA))
  const firstExports = exportsRequested
  const firstUnlinks = unlinks
  holdDelete = {}
  deleting = deletePackage(p)
  const deleteConfirmation = modal
  await p.onContinue(); await p.onAbandon(); await deletePackage(p)
  assert.equal(modal, deleteConfirmation); assert.equal(exportsRequested, firstExports); assert.equal(unlinks, firstUnlinks)
  deleteConfirmation.success({ confirm: true }); await tick()
  holdDelete.remove()
  assert.equal(files.size, 0); assert.equal(unlinks, firstUnlinks + 1)
  const reopened = createPage()
  p.onUnload()
  const reopening = reopened.onLoad()
  await tick()
  await reopened.onStart(); await reopened.onContinue(); await p.onContinue()
  assert.equal(reopened.data.info, null); assert.equal(reopened.data.error, '')
  assert.deepEqual(storage.get(keyA), savedFirst); assert.equal(exportsRequested, firstExports)
  holdDelete.success(); await deleting; await reopening; holdDelete = null
  assert.equal(reopened.data.progressBlocked, false); assert.deepEqual([...reopened.data.deletedParts], [0])
  assert.equal(reopened.data.nextPart, 1); assert.equal(reopened.data.localPackages.length, 0)
  await reopened.onContinue()
  assert.equal(exportsRequested, firstExports + 1)
  assert.equal(storage.get(keyA).nextPart, 2); assert.deepEqual(storage.get(keyA).deletedParts, [0])
  assert.deepEqual(storage.get(keyA).packages.map(pkg => pkg.part), [1])
  p = createPage(); await p.onLoad()
  assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, false)
  assert.deepEqual([...p.data.packages.map(pkg => pkg.part)], [1])

  // Download first: neither management action opens a modal during the download.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad(); await p.onStart()
  holdDownload = {}
  const continuing = p.onContinue(); await tick()
  const pendingSecond = structuredClone(storage.get(keyA))
  assert.equal(pendingSecond.pending.part, 1)
  modal = null
  await deletePackage(p); await p.onAbandon(); await p.onContinue()
  assert.equal(modal, null); assert.equal(unlinks, firstUnlinks + 1)
  assert.deepEqual(storage.get(keyA), pendingSecond)
  holdDownload.run(); await continuing; holdDownload = null
  assert.equal(p.data.nextPart, 2); assert.equal(p.data.packages.length, 2)

  // An abandon confirmation excludes competing writes; failed and late callbacks release safely.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad(); await p.onStart()
  const pendingAbandon = p.onAbandon(), abandonConfirmation = modal
  const beforeAbandonExports = exportsRequested
  await deletePackage(p); await p.onContinue()
  assert.equal(modal, abandonConfirmation); assert.equal(exportsRequested, beforeAbandonExports)
  abandonConfirmation.fail({ errMsg: 'showModal:fail' }); await pendingAbandon
  abandonConfirmation.success({ confirm: true })
  assert.match(p.data.error, /无法清除备份进度/); assert.equal(storage.get(keyA).nextPart, 1)
  deleting = deletePackage(p)
  const lateDeleteConfirmation = modal
  p.onUnload(); await deleting
  lateDeleteConfirmation.success({ confirm: true })
  p = createPage(); await p.onLoad()
  assert.equal(p.data.nextPart, 1); assert.equal(files.size, 1)
  holdDelete = {}; deleting = deletePackage(p)
  modal.success({ confirm: true }); await tick()
  const beforeUnlinkFailure = structuredClone(storage.get(keyA))
  await p.onContinue(); assert.equal(exportsRequested, beforeAbandonExports)
  holdDelete.fail(); await deleting; holdDelete = null
  assert.match(p.data.cleanupError, /删除失败/); assert.equal(files.size, 1)
  assert.deepEqual(storage.get(keyA), beforeUnlinkFailure)

  // Initialization and failed storage reads cannot overwrite an existing snapshot.
  const originalStarts = starts, originalExports = exportsRequested
  const beforeBoot = structuredClone(storage.get(keyA))
  holdBoot = {}; p = createPage(); const booting = p.onLoad()
  await p.onStart(); await p.onContinue(); await p.onAbandon(); await deletePackage(p)
  assert.equal(starts, originalStarts); assert.equal(exportsRequested, originalExports)
  assert.deepEqual(storage.get(keyA), beforeBoot)
  holdBoot.run(); await booting; holdBoot = null
  assert.equal(p.data.nextPart, 1)
  failRead = true; await p.onContinue(); failRead = false
  assert.match(p.data.error, /无法读取备份进度/); assert.equal(exportsRequested, originalExports)
  assert.deepEqual(storage.get(keyA), beforeBoot)

  // A legacy record still works when its downloaded volume is present, and
  // deleting that volume preserves the pending journal from a failed download.
  const legacy = structuredClone(storage.get(keyA))
  delete legacy.deletedParts
  legacy.pending = pendingSecond.pending
  storage.set(keyA, legacy)
  p = createPage(); await p.onLoad()
  assert.equal(p.data.progressBlocked, false)
  await answer(deletePackage(p))
  assert.deepEqual(storage.get(keyA).pending, pendingSecond.pending)
  assert.deepEqual(storage.get(keyA).deletedParts, [0])
  p = createPage(); await p.onLoad()
  assert.equal(p.data.progressBlocked, false)
  await p.onContinue()
  assert.equal(p.data.nextPart, 2); assert.deepEqual(storage.get(keyA).deletedParts, [0])

  // Cleanup of an unrelated old file must not clear an existing missing-volume block.
  storage.set(keyA, legacy); files.clear()
  const oldName = `${info.createdAt - 1}-${firstVolume.name}`
  files.add(oldName)
  p = createPage(); await p.onLoad()
  assert.equal(p.data.progressBlocked, true)
  await answer(deletePackage(p))
  assert.equal(files.size, 0); assert.equal(p.data.progressBlocked, true)
  assert.match(p.data.error, /缺失/); assert.deepEqual(storage.get(keyA), legacy)

  // Native write failures keep the same part pending and clean only the current attempt's temporary file.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad()
  const history = new Set([oldName, 'user-file.tmp', '.ours-backup-other.tmp'])
  history.forEach(name => files.add(name))
  const beforeWriteExports = exportsRequested, beforeWriteCloud = cloudDownloads, beforeWriteRenames = renameAttempts
  const diskHint = /本地存储空间不足.*释放.*下载下一包.*重试/
  downloadError = { errMsg: 'downloadFile:fail no space left on device' }
  await p.onStart()
  const writeJournal = structuredClone(storage.get(keyA))
  const cachedUrl = lastUrl
  assert.equal(writeJournal.pending.part, 0)
  assert.equal(writeJournal.nextPart, 0)
  const assertFailedWrite = (message, expectedFiles, expectedRenames) => {
    assert.match(p.data.error, message)
    assert.equal(p.data.nextPart, 0)
    assert.equal(p.data.packages.length, 0)
    assert.equal(p.data.working, false)
    assert.deepEqual(storage.get(keyA), writeJournal)
    assert.deepEqual(files, expectedFiles)
    assert.equal(renameAttempts, expectedRenames)
    assert.equal(exportsRequested, beforeWriteExports + 1)
    assert.equal(lastUrl, cachedUrl)
  }
  assertFailedWrite(diskHint, history, beforeWriteRenames)
  assert.equal(cloudDownloads, beforeWriteCloud)

  // Exercise the file-system callback in the cloud-download fallback as well as direct writes.
  downloadError = { errMsg: 'downloadFile:fail url not in domain list' }
  cloudError = undefined
  copyError = { errMsg: 'copyFile:fail the maximum size of the file storage limit is exceeded' }
  await p.onContinue()
  assert.equal(lastFileID, `cloud://zip-${beforeWriteExports + 1}`)
  const filesWithCloudTemp = new Set([...history, cloudTemp])
  assertFailedWrite(diskHint, filesWithCloudTemp, beforeWriteRenames)
  for (const errMsg of ['copyFile:fail permission denied', 'copyFile:fail individual file size limit exceeded']) {
    copyError = { errMsg, message: 'generic fallback message' }
    await p.onContinue()
    assert.equal(p.data.error, errMsg)
    assertFailedWrite(/^copyFile:fail/, filesWithCloudTemp, beforeWriteRenames)
  }
  downloadError = copyError = undefined; cloudError = unavailableCloud
  renameError = { errMsg: 'rename:fail ENOSPC' }
  await p.onContinue()
  assertFailedWrite(diskHint, filesWithCloudTemp, beforeWriteRenames + 1)

  renameError = undefined
  p.refreshLocalPackages()
  const beforeCachedDeleteDownloads = downloads
  modal = null
  deleting = deletePackage(p)
  assert.equal(typeof modal?.success, 'function')
  await p.onContinue()
  assert.equal(downloads, beforeCachedDeleteDownloads)
  await answer(deleting, false)
  await p.onContinue()
  assert.equal(p.data.nextPart, 1); assert.equal(exportsRequested, beforeWriteExports + 1)
  assert.equal(lastUrl, cachedUrl); assert.equal(p.data.error, '')
  assert.deepEqual(storage.get(keyA).packages, [writeJournal.pending])
  assert.equal(storage.get(keyA).pending, undefined)
  assert.deepEqual(files, new Set([...filesWithCloudTemp, writeJournal.pending.path.split('/').pop()]))
  await p.onContinue()
  assert.equal(lastExport.part, 1); assert.equal(exportsRequested, beforeWriteExports + 2)
  assert.equal(p.data.nextPart, info.parts); assert.equal(storage.get(keyA).nextPart, info.parts)

  // An expired URL still gets the cloud-file fallback. If that attempt fails, the next tap regenerates the part.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad()
  renameError = { errMsg: 'rename:fail no space left on device' }
  await p.onStart(); renameError = undefined
  const expiredUrl = lastUrl, beforeExpiry = exportsRequested
  downloadStatus = 403; cloudError = { errMsg: 'cloud.downloadFile:fail network timeout' }
  await p.onContinue()
  assert.equal(lastUrl, expiredUrl); assert.equal(lastFileID, `cloud://zip-${beforeExpiry}`)
  assert.equal(exportsRequested, beforeExpiry); assert.equal(storage.get(keyA).nextPart, 0)
  assert.equal(p.data.error, cloudError.errMsg); assert.equal(files.size, 0)
  downloadStatus = 200; cloudError = unavailableCloud
  await p.onContinue()
  assert.equal(exportsRequested, beforeExpiry + 1); assert.notEqual(lastUrl, expiredUrl)
  assert.equal(storage.get(keyA).nextPart, 1)

  // When there is no public URL, cache the cloud file ID until storage confirms the file is gone.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad()
  omitUrl = true; cloudError = undefined; copyError = { errMsg: 'copyFile:fail ENOSPC' }
  await p.onStart(); copyError = undefined
  const beforeMissing = exportsRequested, noUrlFile = lastFileID
  assert.match(p.data.error, diskHint)
  cloudError = { errMsg: 'cloud.downloadFile:fail network timeout' }
  await p.onContinue()
  assert.equal(lastFileID, noUrlFile); assert.equal(exportsRequested, beforeMissing)
  cloudError = { errCode: -503003, errMsg: 'cloud.downloadFile:fail storage file not exists' }
  await p.onContinue()
  assert.equal(lastFileID, noUrlFile); assert.equal(exportsRequested, beforeMissing)
  assert.equal(storage.get(keyA).nextPart, 0)
  cloudError = undefined
  await p.onContinue()
  assert.notEqual(lastFileID, noUrlFile); assert.equal(exportsRequested, beforeMissing + 1)
  assert.equal(storage.get(keyA).nextPart, 1)
  omitUrl = false; cloudError = unavailableCloud

  // A retry cannot inherit a cached result from a different page, owner, or snapshot.
  for (const change of ['page', 'owner', 'snapshot', 'abandon']) {
    storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onLoad()
    renameError = { errMsg: 'rename:fail ENOSPC' }
    await p.onStart(); renameError = undefined
    const previousUrl = lastUrl, beforeChange = exportsRequested
    const previousProgress = structuredClone(storage.get(keyA))
    if (change === 'page') {
      p.onUnload(); p = createPage(); await p.onLoad()
    } else if (change === 'owner') {
      storage.set(keyB, structuredClone(previousProgress)); user = 'b'
      await p.onContinue()
      assert.match(p.data.error, /已切换/); assert.equal(exportsRequested, beforeChange)
      p.restoreProgress()
    } else if (change === 'snapshot') {
      storage.set(keyA, { ...previousProgress, info: { ...info, snapshotFileID: 'cloud://new-snapshot' } })
    } else {
      await answer(p.onAbandon())
    }
    if (change === 'abandon') await p.onStart()
    else await p.onContinue()
    assert.equal(exportsRequested, beforeChange + 1, change)
    assert.notEqual(lastUrl, previousUrl, change)
    assert.equal(p.data.nextPart, 1, change)
    if (change === 'owner') assert.deepEqual(storage.get(keyA), previousProgress)
    if (change === 'snapshot') assert.equal(lastExport.snapshotFileID, 'cloud://new-snapshot')
  }

  // First show with a malformed record used to offer Generate, which read the same record again and stopped.
  user = 'a'; storage.clear(); files.clear()
  const malformed = { info: { ...info, createdAt: info.createdAt - 1 }, nextPart: 1 }
  storage.set(keyA, structuredClone(malformed)); files.add(oldName)
  p = createPage(); await p.onLoad(); p.onShow?.()
  const generateVisible = actionVisible(p, 'onStart')
  const readsBeforeGenerate = reads, startsBeforeRecovery = starts
  if (generateVisible) await p.onStart()
  assert.equal(starts, startsBeforeRecovery)
  assert.deepEqual(storage.get(keyA), malformed)
  assert.deepEqual([...files], [oldName])
  assert.equal(p.data.localPackages[0].name, oldName)
  assert.ok(actionVisible(p, 'onAbandon'),
    `应显示清除入口。实际提示「${p.data.error}」，生成按钮可见=${generateVisible}，点击生成后新增读取=${reads - readsBeforeGenerate}`)
  assert.equal(generateVisible, false)
  assert.match(p.data.error, /格式/)
  assert.equal(p.data.progressIssue, 'invalid')
  assert.equal(actionVisible(p, 'reloadProgress'), false)
  for (const packages of [null, [null], [{}]]) {
    storage.set(keyA, { ...malformed, packages }); p.onShow()
    assert.equal(p.data.progressIssue, 'invalid'); assert.deepEqual([...files], [oldName])
  }
  storage.set(keyA, structuredClone(malformed)); p.onShow()

  // Recovery is scoped to the confirmed account and space, and shares the existing operation lock.
  switchSession('a', 'other-space'); const keyOtherSpace = p.progressKey()
  switchSession('a', 'space')
  storage.set(keyB, { marker: 'other account' })
  storage.set(keyOtherSpace, { marker: 'other space' })
  storage.set('unrelated', { marker: 'unrelated storage' })
  const recordsBeforeRecovery = structuredClone(storage)
  const removeBeforeRecovery = removeAttempts.length, unlinksBeforeRecovery = unlinks
  const assertUntouched = () => {
    assert.deepEqual(storage, recordsBeforeRecovery)
    assert.deepEqual([...files], [oldName])
    assert.equal(unlinks, unlinksBeforeRecovery)
  }
  let clearing = p.onAbandon()
  const clearConfirmation = modal, readsAtConfirmation = reads
  assert.equal(clearConfirmation.confirmText, '清除进度')
  assert.match(clearConfirmation.content, /本地备份包不会删除/)
  await p.onAbandon(); await p.onStart(); await p.onContinue(); await deletePackage(p)
  p.reloadProgress(); p.onShow()
  assert.equal(modal, clearConfirmation); assert.equal(reads, readsAtConfirmation)
  assert.equal(removeAttempts.length, removeBeforeRecovery); assertUntouched()
  await answer(clearing, false)
  assert.equal(actionVisible(p, 'onAbandon'), true); assertUntouched()

  clearing = p.onAbandon()
  modal.fail({ errMsg: 'showModal:fail' }); await clearing
  assert.match(p.data.error, /无法清除备份进度/); assertUntouched()
  for (const [openid, coupleId, switchBack] of [['b', 'space', false], ['a', 'other-space', false], ['b', 'space', true]]) {
    clearing = p.onAbandon()
    switchSession(openid, coupleId)
    if (switchBack) switchSession('a', 'space')
    await answer(clearing)
    assert.match(p.data.error, /已切换/)
    assert.equal(removeAttempts.length, removeBeforeRecovery); assertUntouched()
    switchSession('a', 'space')
  }

  clearing = p.onAbandon()
  const valid = {
    ...malformed, packages: [{ ...firstVolume, path: `/data/${oldName}` }],
  }
  storage.set(keyA, structuredClone(valid))
  await answer(clearing)
  assert.match(p.data.error, /进度已变化/)
  assert.deepEqual(storage.get(keyA), valid); assert.equal(removeAttempts.length, removeBeforeRecovery)
  p.onShow(); assert.equal(p.data.progressIssue, ''); assert.equal(p.data.nextPart, 1)
  storage.set(keyA, structuredClone(malformed)); p.onShow()
  assert.equal(p.data.progressIssue, 'invalid')

  // A failed read during confirmation requires a fresh read and fresh consent.
  clearing = p.onAbandon()
  failRead = true; await answer(clearing)
  assert.equal(p.data.progressIssue, 'read'); assert.match(p.data.error, /无法读取备份进度/)
  assert.equal(actionVisible(p, 'onAbandon'), false); assert.equal(actionVisible(p, 'reloadProgress'), true)
  p.reloadProgress()
  assert.equal(p.data.progressIssue, 'read'); assertUntouched()
  failRead = false; p.reloadProgress()
  assert.equal(p.data.progressIssue, 'invalid'); assert.equal(removeAttempts.length, removeBeforeRecovery)
  assertUntouched()

  failRemove = true; await answer(p.onAbandon()); failRemove = false
  assert.match(p.data.error, /无法清除备份进度/)
  assert.equal(p.data.progressIssue, 'invalid'); assertUntouched()
  assert.deepEqual(removeAttempts.slice(removeBeforeRecovery), [keyA])

  clearing = p.onAbandon()
  const lateClear = modal
  p.onUnload(); await clearing
  lateClear.success({ confirm: true }); assertUntouched()
  p = createPage(); await p.onLoad()
  await answer(p.onAbandon())
  recordsBeforeRecovery.delete(keyA)
  assert.deepEqual(removeAttempts.slice(removeBeforeRecovery), [keyA, keyA]); assertUntouched()
  assert.equal(p.data.error, ''); assert.equal(actionVisible(p, 'onStart'), true)
  assert.equal(actionVisible(p, 'onAbandon'), false)
  await p.onStart()
  assert.equal(starts, startsBeforeRecovery + 1)
  assert.equal(p.data.nextPart, 1); assert.equal(files.has(oldName), true)

  // A read failure on entry leaves readable progress recoverable and never offers a destructive action.
  storage.set(keyA, structuredClone(valid))
  failRead = true; p = createPage(); await p.onLoad(); p.onShow()
  assert.equal(p.data.progressIssue, 'read'); assert.match(p.data.error, /无法读取备份进度/)
  assert.equal(actionVisible(p, 'onStart'), false); assert.equal(actionVisible(p, 'onAbandon'), false)
  assert.equal(actionVisible(p, 'reloadProgress'), true)
  modal = null; const removalsBeforeRetry = removeAttempts.length
  await p.onStart(); await p.onAbandon(); await p.onContinue()
  assert.equal(modal, null); assert.equal(removeAttempts.length, removalsBeforeRetry)
  assert.deepEqual(storage.get(keyA), valid); assert.equal(files.has(oldName), true)
  failRead = false; p.reloadProgress()
  assert.equal(p.data.progressIssue, ''); assert.equal(p.data.error, '')
  assert.equal(p.data.nextPart, 1); assert.equal(actionVisible(p, 'onContinue'), true)
  assert.equal(actionVisible(p, 'reloadProgress'), false)
  assert.deepEqual(storage.get(keyA), valid)

  // Both visible export buttons share one outstanding native request.
  for (const handler of ['onSave', 'onSaveLocal', 'onDeleteLocal']) {
    assert.match(template, new RegExp(`data-path="\\{\\{item.path\\}\\}" bindtap="${handler}"`))
  }
  const oldEvent = packageEvent(`/data/${oldName}`)
  p.onSaveLocal(oldEvent); p.onSave(oldEvent)
  assert.deepEqual(shares.map(share => share.filePath), [`/data/${oldName}`])
  shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' }); assert.deepEqual(toasts, [])
  p.onSave(oldEvent)
  shares[1].fail({ errMsg: 'shareFileMessage:fail' }); assert.match(toasts.pop(), /保存失败/)
  p.onSave(oldEvent); shares[2].success()
  assert.deepEqual(toasts, [])
  p.onSave(oldEvent); p.onUnload()
  shares[3].fail({ errMsg: 'shareFileMessage:fail unavailable' }); assert.deepEqual(toasts, [])
  p = createPage(); await p.onLoad()
  const savedFiles = new Set(files)
  const share = wx.shareFileMessage
  delete wx.shareFileMessage
  p.onSaveLocal(oldEvent); p.onSave(oldEvent)
  assert.equal(toasts.length, 2); toasts.forEach(title => assert.match(title, /无法导出.*已保留/))
  assert.deepEqual(files, savedFiles); assert.deepEqual(storage.get(keyA), valid)
  wx.shareFileMessage = share

  // A page that was already loaded refreshes when the other page completes its write.
  storage.clear(); files.clear()
  const first = createPage(), second = createPage()
  await first.onLoad(); await second.onLoad()
  holdDownload = {}; const firstDownload = first.onStart(); await tick()
  second.onShow(); second.onShow()
  assert.equal(second.data.nextPart, 0)
  holdDownload.run(); await firstDownload; holdDownload = null
  assert.equal(second.data.nextPart, 1); assert.equal(second.data.localPackages.length, 1)
  const firstPath = second.data.localPackages[0].path
  const firstEvent = packageEvent(firstPath)
  await first.onContinue(); second.onShow()
  assert.notEqual(second.data.localPackages[0].path, firstPath)
  second.onSaveLocal(firstEvent); assert.equal(shares.at(-1).filePath, firstPath)
  shares.at(-1).success()
  const deletion = second.onDeleteLocal(firstEvent)
  switchSession('b', 'space'); switchSession('a', 'space')
  await answer(deletion)
  assert.match(second.data.cleanupError, /已切换/); assert.equal(files.size, 2)
  await answer(second.onDeleteLocal(firstEvent))
  assert.equal(files.has(firstPath.split('/').pop()), false); assert.equal(files.size, 1)
  const shareCount = shares.length, unlinkCount = unlinks
  second.onSaveLocal(firstEvent); await second.onDeleteLocal(firstEvent)
  assert.equal(shares.length, shareCount); assert.equal(unlinks, unlinkCount)

  // Once unloaded, a late download is discarded, while an in-flight rename is recoverable.
  for (const stage of ['download', 'rename']) {
    storage.clear(); files.clear(); p = createPage(); await p.onLoad()
    if (stage === 'download') holdDownload = {}; else holdRename = {}
    const starting = p.onStart(); await tick()
    const release = (holdDownload ?? holdRename).run
    p.onUnload(); p.setData = () => assert.fail('Unloaded page was updated')
    release(); await starting
    holdDownload = holdRename = null
    const reopened = createPage(); await reopened.onLoad()
    assert.equal(reopened.data.nextPart, stage === 'rename' ? 1 : 0)
    assert.equal(reopened.data.localPackages.length, reopened.data.nextPart)
    assert.ok([...files].every(name => name.endsWith('.zip')))
  }

  // Two open pages can see the same ZIP while native export is still pending.
  storage.clear(); files.clear()
  const sharingPage = createPage(), managingPage = createPage()
  await sharingPage.onLoad(); await sharingPage.onStart(); await managingPage.onLoad()
  const sharedPath = sharingPage.data.packages[0].path
  const sharedEvent = packageEvent(sharedPath)
  sharingPage.onSave(sharedEvent)
  const shareRequest = shares.at(-1)
  const beforeCrossPageShare = shares.length
  assert.equal(shareRequest.filePath, sharedPath)
  modal = null
  const deletingWhileShared = managingPage.onDeleteLocal(sharedEvent)
  const openedDuringShare = modal
  if (openedDuringShare) openedDuringShare.success({ confirm: true })
  await deletingWhileShared
  assert.ok(files.has(sharedPath.split('/').pop()), 'Another page deleted a ZIP pending native export')
  assert.equal(openedDuringShare, null)
  managingPage.onSaveLocal(sharedEvent)
  assert.equal(shares.length, beforeCrossPageShare)
  shareRequest.success()
  await answer(managingPage.onDeleteLocal(sharedEvent))
  assert.equal(files.has(sharedPath.split('/').pop()), false)
  assert.deepEqual(storage.get(keyA).deletedParts, [0])

  // The cloud-file download can hit the same disk limit before copyFile starts.
  storage.clear(); files.clear(); p = createPage(); await p.onLoad()
  omitUrl = true
  cloudError = { errMsg: 'cloud.downloadFile:fail no space left on device' }
  const beforeCloudDiskExports = exportsRequested
  await p.onStart()
  assert.match(p.data.error, diskHint)
  assert.equal(p.data.nextPart, 0)
  assert.equal(storage.get(keyA).pending.part, 0)
  assert.equal(files.size, 0)
  const retryFileID = lastFileID
  cloudError = undefined
  await p.onContinue()
  assert.equal(lastFileID, retryFileID)
  assert.equal(exportsRequested, beforeCloudDiskExports + 1)
  assert.equal(p.data.nextPart, 1)
  omitUrl = false; cloudError = unavailableCloud

  passed = true
  console.log('PASS: backup retry cache, write errors, deletion locks, malformed progress recovery, storage retry and export fallback')
})().catch(error => { console.error(error); process.exitCode = 1 })
