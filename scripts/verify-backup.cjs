const assert = require('assert/strict')
const fs = require('fs')
const vm = require('vm')
const ts = require('typescript')

const storage = new Map(), files = new Set()
let page, user = 'a', modal, downloads = 0, unlinks = 0, failDownload = false, failDelete = false, failStorage = false, failRead = false, missingSession = false, holdDownload = null, holdRename = null, holdDelete = null
const info = { snapshotFileID: 'cloud://snapshot', parts: 2, files: 2, moments: 1, createdAt: Date.now() }
const wx = {
  env: { USER_DATA_PATH: '/data' },
  getStorageSync: key => { if (failRead) throw new Error('storage failed'); return storage.get(key) }, setStorageSync: (key, value) => { if (failStorage) throw new Error('storage failed'); storage.set(key, structuredClone(value)) }, removeStorageSync: key => storage.delete(key),
  getFileSystemManager: () => ({
    readdirSync: () => [...files], unlinkSync: p => files.delete(p.split('/').pop()),
    unlink: ({ filePath, success, fail }) => { unlinks++; if (failDelete) return fail(); const run = () => { files.delete(filePath.split('/').pop()); success() }; if (holdDelete) holdDelete.run = run; else run() },
    rename: ({ oldPath, newPath, success }) => { const run = () => { files.delete(oldPath.split('/').pop()); files.add(newPath.split('/').pop()); success() }; if (holdRename) holdRename.run = run; else run() },
  }),
  downloadFile: ({ filePath, success, fail }) => { downloads++; files.add(filePath.split('/').pop()); if (failDownload) return fail(new Error('download failed')); if (holdDownload) holdDownload.run = () => success({ statusCode: 200 }); else success({ statusCode: 200 }) },
  cloud: { downloadFile: async () => { throw new Error('cloud download failed') } },
  showModal: options => { modal = options }, showToast() {}, shareFileMessage() {},
}
const source = ts.transpileModule(fs.readFileSync('miniprogram/subpages/backup/backup.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const context = vm.createContext({ wx, Date, Math, Number, Error, encodeURIComponent, exports: {}, Page: value => { page = value }, require: id => {
  if (id.includes('session')) return { coupleId: () => 'space', requireSession: () => { if (missingSession) throw new Error('尚未完成空间初始化'); return { coupleId: 'space', openid: user } } }
  if (id.includes('cloud-api')) return { callOurs: async (action, payload) => action === 'startBackup' ? info : { fileID: 'cloud://zip', url: 'https://example.invalid', name: `Ours-2026-01-01-${payload.part + 1}.zip`, missing: 0 } }
  if (id.includes('page-boot')) return { ensureCloudReady: async () => {} }
  return { getThemeStyle: () => '', syncTheme() {} }
} })
vm.runInContext(source, context)
const createPage = () => { const instance = { ...page, data: structuredClone(page.data) }; instance.setData = value => Object.assign(instance.data, value); return instance }
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
  p.refreshLocalPackages(); p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(files.size, 1); modal.success({ confirm: false }); assert.equal(files.size, 1)
  const unlinksBeforeReadFailure = unlinks, savedBeforeReadFailure = structuredClone(storage.get(p.data.progressOwner))
  failRead = true; modal.success({ confirm: true }); failRead = false
  assert.match(p.data.cleanupError, /无法读取备份进度/); assert.equal(unlinks, unlinksBeforeReadFailure)
  assert.equal(files.size, 1); assert.deepEqual(storage.get(p.data.progressOwner), savedBeforeReadFailure)
  failDelete = true; modal.success({ confirm: true }); assert.equal(files.size, 1); assert.match(p.data.cleanupError, /删除失败/)
  failDelete = false; modal.success({ confirm: true }); assert.equal(files.size, 0)
  failDownload = true; await p.onContinue(); assert.equal(p.data.nextPart, 1); assert.equal(files.size, 0); assert.ok(p.data.error)
  failDownload = false; await p.onContinue(); assert.equal(p.data.nextPart, 2); assert.equal(downloads, 3)
  p = createPage(); p.restoreProgress(); assert.equal(p.data.nextPart, 2)
  p.onAbandon(); modal.success({ confirm: true }); assert.equal(files.size, 1); assert.equal(p.data.info, null)
  const expired = { ...info, createdAt: Date.now() - 86400001 }
  p.saveProgress(expired, 0, []); p.restoreProgress(); assert.match(p.data.error, /过期/)
  await p.onContinue(); assert.match(p.data.error, /过期/); assert.equal(downloads, 3)
  // Confirmation must never act on a newly selected owner.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart()
  const keyA = p.progressKey(); p.onAbandon(); user = 'b'; const keyB = p.progressKey()
  storage.set(keyB, { marker: 'B' }); modal.success({ confirm: true })
  assert.deepEqual(storage.get(keyB), { marker: 'B' }); assert.ok(storage.has(keyA))
  user = 'a'; p.refreshLocalPackages(); p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); user = 'b'; modal.success({ confirm: true }); assert.equal(files.size, 1)
  // Failed reads or missing sessions must not open a confirmation or change data.
  user = 'a'; p.refreshLocalPackages()
  const savedBefore = structuredClone(storage.get(keyA)), filesBefore = [...files], infoBefore = p.data.info
  for (const failure of ['read', 'session']) {
    failRead = failure === 'read'; missingSession = failure === 'session'
    modal = null; p.onAbandon(); assert.equal(modal, null); assert.match(p.data.error, failure === 'read' ? /无法读取备份进度/ : /会话已失效/)
    modal = null; p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); assert.equal(modal, null); assert.match(p.data.cleanupError, failure === 'read' ? /无法读取备份进度/ : /会话已失效/)
    assert.deepEqual(storage.get(keyA), savedBefore); assert.deepEqual([...files], filesBefore); assert.equal(p.data.info, infoBefore)
    failRead = false; missingSession = false
  }
  // An unexplained missing volume cannot be silently marked complete.
  user = 'a'; files.clear(); p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/)
  const before = downloads; await p.onContinue(); assert.equal(downloads, before); assert.match(p.data.error, /缺失/)
  // Missing a completed volume, including an ambiguous legacy record, is blocked.
  storage.set(keyA, { info, nextPart: 2, packages: [] }); p = createPage(); p.restoreProgress()
  assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/)
  // A pre-existing destination is never overwritten.
  storage.clear(); files.clear(); files.add(`${info.createdAt}-Ours-2026-01-01-1.zip`)
  p = createPage(); await p.onStart(); assert.match(p.data.error, /已存在/); assert.equal(files.size, 1)
  // Confirmed deletion is recorded and survives a restart.
  storage.clear(); files.clear(); p = createPage(); await p.onStart(); p.refreshLocalPackages()
  p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); modal.success({ confirm: true })
  p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.deletedParts[0], 0)
  await p.onContinue(); assert.equal(p.data.nextPart, 2)
  // Switching during the download cleans only this download's temporary file.
  storage.clear(); files.clear(); p = createPage(); holdDownload = {}; const downloading = p.onStart()
  while (!holdDownload.run) await new Promise(resolve => setImmediate(resolve))
  files.add('user-file.tmp'); user = 'b'; holdDownload.run(); await downloading; holdDownload = null
  assert.deepEqual([...files], ['user-file.tmp']); assert.equal(storage.get(keyA).nextPart, 0)
  // Rename completes after a switch: the pending journal recovers the finished file.
  user = 'a'; storage.clear(); files.clear(); p = createPage(); holdRename = {}; const renaming = p.onStart()
  while (!holdRename.run) await new Promise(resolve => setImmediate(resolve))
  user = 'b'; holdRename.run(); await renaming; holdRename = null
  user = 'a'; p = createPage(); p.restoreProgress(); assert.equal(p.data.nextPart, 1); assert.equal(p.data.packages.length, 1)
  // Delete may finish after switching: record A's deletion without touching B's state.
  p.refreshLocalPackages(); holdDelete = {}; p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); modal.success({ confirm: true })
  user = 'b'; holdDelete.run(); holdDelete = null; assert.deepEqual(storage.get(keyA).deletedParts, [0])
  user = 'a'; p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, false)
  // A failed persistence after a successful unlink stays visible after refreshing.
  storage.clear(); files.clear(); p = createPage(); await p.onStart(); p.refreshLocalPackages()
  p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); holdDelete = {}; modal.success({ confirm: true }); failStorage = true; holdDelete.run(); failStorage = false; holdDelete = null
  assert.match(p.data.cleanupError, /保存失败/); p.refreshLocalPackages(); assert.match(p.data.cleanupError, /保存失败/)
  p = createPage(); p.restoreProgress(); assert.equal(p.data.progressBlocked, true)
  // Two completed volumes: a failed write after switching sessions must invalidate
  // the still-visible A page immediately, and remain blocked after restoring A.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart(); await p.onContinue(); p.refreshLocalPackages()
  const completedA = structuredClone(storage.get(keyA))
  storage.set(keyB, { marker: 'B' }); const untouchedB = structuredClone(storage.get(keyB))
  holdDelete = {}; p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); modal.success({ confirm: true })
  user = 'b'; failStorage = true; holdDelete.run(); failStorage = false; holdDelete = null
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
  holdDelete = {}; p.onDeleteLocal({ currentTarget: { dataset: { index: 1 } } }); modal.success({ confirm: true })
  user = 'b'; p.restoreProgress(); const pageB = structuredClone(p.data)
  failStorage = true; holdDelete.run(); failStorage = false; holdDelete = null
  assert.deepEqual(structuredClone(p.data), pageB); assert.deepEqual(storage.get(keyB), savedB); assert.deepEqual(storage.get(keyA), completedA2)
  user = 'a'; p.restoreProgress(); assert.equal(p.data.progressBlocked, true); assert.match(p.data.error, /缺失/); assert.equal(p.data.packages.length, 1)
  assert.deepEqual(storage.get(keyB), savedB); assert.deepEqual(storage.get(keyA), completedA2)
  // Successful confirmed deletion of a completed volume remains complete.
  storage.clear(); files.clear(); user = 'a'; p = createPage(); await p.onStart(); await p.onContinue(); p.refreshLocalPackages()
  p.onDeleteLocal({ currentTarget: { dataset: { index: 0 } } }); modal.success({ confirm: true })
  assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.error, '')
  assert.equal(storage.get(keyA).deletedParts.length, 1); assert.equal(storage.get(keyA).packages.length, 1)
  p.restoreProgress(); assert.equal(p.data.nextPart, 2); assert.equal(p.data.progressBlocked, false); assert.equal(p.data.error, '')
  console.log('PASS: backup ownership, missing and confirmed volumes, interrupted downloads, rename recovery and persistence failure')
})().catch(error => { console.error(error); process.exitCode = 1 })
