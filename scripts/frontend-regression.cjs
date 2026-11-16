const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const ts = require('../node_modules/typescript')

function page(file, modules, wx) {
  let definition
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const fallback = new Proxy({}, { get: () => () => undefined })
  vm.runInNewContext(source, { require: id => modules[id] || fallback, exports: {}, Page: value => { definition = value }, wx, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, Number, Error })
  definition.data = JSON.parse(JSON.stringify(definition.data))
  definition.setData = function (values, cb) { Object.assign(this.data, values); if (cb) cb() }
  return definition
}
const theme = { getThemeStyle: () => '', syncTheme() {} }
const event = index => ({ currentTarget: { dataset: { index } } })

async function main() {
  let names = ['123-Ours-2026-01-01-1.zip', 'draft.mp3', 'unrelated.zip']
  let confirm
  const deleted = []
  const deleteStorage = new Map()
  const deleteSession = { status: 'ready', coupleId: 'c', openid: 'user' }
  const deleteKey = 'OURS_BACKUP_PROGRESS_V1:c:user'
  const deleteInfo = { snapshotFileID: 'snapshot', parts: 1, createdAt: 123 }
  const deletePackage = { part: 0, name: 'Ours-2026-01-01-1.zip', path: '/private/123-Ours-2026-01-01-1.zip', missing: 0 }
  deleteStorage.set(deleteKey, { info: deleteInfo, nextPart: 1, packages: [deletePackage], deletedParts: [] })
  const wxBackup = { env: { USER_DATA_PATH: '/private' }, getStorageSync: key => deleteStorage.get(key), setStorageSync: (key, value) => deleteStorage.set(key, structuredClone(value)), removeStorageSync: key => deleteStorage.delete(key), getFileSystemManager: () => ({ readdirSync: () => names, unlink: ({ filePath, success }) => { deleted.push(filePath); names = names.filter(n => !filePath.endsWith(n)); success() } }), showModal: opts => { confirm = opts.success }, showToast() {} }
  const backup = page('miniprogram/subpages/backup/backup.ts', { '../../services/theme': theme, '../../services/session': { requireSession: () => deleteSession, coupleId: () => deleteSession.coupleId } }, wxBackup)
  backup.restoreProgress()
  backup.refreshLocalPackages()
  assert.equal(backup.data.localPackages.length, 1)
  backup.onDeleteLocal(event(0)); confirm({ confirm: false }); assert.equal(deleted.length, 0)
  backup.onDeleteLocal(event(0)); confirm({ confirm: true }); assert.deepEqual(deleted, ['/private/123-Ours-2026-01-01-1.zip'])
  assert.deepEqual(deleteStorage.get(deleteKey).deletedParts, [0]); assert.equal(deleteStorage.get(deleteKey).packages.length, 0)
  assert(names.includes('draft.mp3') && names.includes('unrelated.zip'))

  const files = new Map([['draft.mp3', 'draft'], ['99-Ours-2026-01-01-1.zip', 'existing']])
  const filename = path => path.slice('/private/'.length)
  let cloudMode = 'fail', cloudDownloads = 0
  const storage = new Map()
  const session = { coupleId: 'c', openid: 'user' }
  const createdAt = Date.now()
  const progressKey = 'OURS_BACKUP_PROGRESS_V1:c:user'
  const info = { snapshotFileID: 'snapshot', parts: 1, createdAt }
  storage.set(progressKey, { info, nextPart: 0, packages: [] })
  const disk = {
    readdirSync: () => [...files.keys()],
    unlinkSync: path => { if (!files.delete(filename(path))) throw new Error('missing') },
    copyFile: ({ destPath, success, fail }) => { files.set(filename(destPath), cloudMode === 'copy-fail' ? 'partial copy' : 'complete'); cloudMode === 'copy-fail' ? fail(new Error('copy failed')) : success() },
    rename: ({ oldPath, newPath, success }) => { files.set(filename(newPath), files.get(filename(oldPath))); files.delete(filename(oldPath)); success() },
  }
  const downloading = page('miniprogram/subpages/backup/backup.ts', {
    '../../services/theme': theme, '../../services/session': { coupleId: () => 'c', requireSession: () => session },
    '../../services/cloud-api': { callOurs: async () => ({ fileID: 'cloud://backup', url: 'https://backup', name: 'Ours-2026-01-01-1.zip', missing: 0 }) },
  }, {
    env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => disk,
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    downloadFile: ({ filePath, success }) => { files.set(filename(filePath), 'partial HTTP'); success({ statusCode: 500 }) },
    cloud: { downloadFile: async () => { cloudDownloads++; if (cloudMode === 'fail') throw new Error('cloud offline'); return { tempFilePath: '/cloud' } } },
  })
  downloading.restoreProgress()
  await downloading.onContinue(); downloading.refreshLocalPackages()
  assert.equal(downloading.data.error, 'cloud offline'); assert.equal(downloading.data.nextPart, 0); assert.equal(cloudDownloads, 1)
  assert.deepEqual([...files.keys()].sort(), ['99-Ours-2026-01-01-1.zip', 'draft.mp3'])
  assert.equal(downloading.data.localPackages.length, 1)
  cloudMode = 'copy-fail'; await downloading.onContinue()
  assert.equal(downloading.data.error, 'copy failed'); assert.deepEqual([...files.keys()].sort(), ['99-Ours-2026-01-01-1.zip', 'draft.mp3'])
  cloudMode = 'success'; await downloading.onContinue()
  assert.equal(downloading.data.error, ''); assert.equal(downloading.data.nextPart, 1)
  const savedName = `${createdAt}-Ours-2026-01-01-1.zip`
  assert.equal(files.get(savedName), 'complete'); assert.equal(files.get('draft.mp3'), 'draft')
  storage.set(progressKey, { info, nextPart: 0, packages: [] })
  await downloading.onContinue()
  assert.equal(files.get(savedName), 'complete'); assert.match(downloading.data.error, /已存在/)

  let rejectInvite, calls = 0
  const bind = page('miniprogram/pages/bind/bind.ts', { '../../services/theme': theme, '../../services/page-boot': { ensureCloudReady: async () => true }, '../../services/store': { getCouple: () => ({ id: 'c', startDate: '2020-01-01' }), getRelationshipMembers: () => ({ me: {}, partner: null }), createPartnerInvite: () => { calls++; return calls === 1 ? new Promise((_, reject) => { rejectInvite = reject }) : Promise.resolve({ token: 'retry-token' }) } } }, {})
  const first = bind.prepareInvite(); await bind.prepareInvite(); await Promise.resolve(); assert.equal(calls, 1)
  rejectInvite(new Error('offline')); await first; assert.equal(bind.data.inviteError, 'offline'); assert.equal(bind.data.inviteLoading, false)
  await bind.prepareInvite(); assert.equal(calls, 2); assert.equal(bind.data.inviteReady, true); assert.equal(bind.data.inviteError, ''); assert.equal(bind.inviteToken, 'retry-token')

  let fail = true
  const home = page('miniprogram/pages/home/home.ts', {
    '../../services/theme': theme,
    '../../services/session': { syncSession: async () => {} },
    '../../services/store': { getCouple: () => ({ startDate: '2020-01-01', memberB: true }), listMomentsRecent: async () => { if (fail) throw new Error('offline'); return [] }, getNextAnniversary: async () => null, getIdentity: () => ({ role: 'A' }), daysBetween: () => 1 },
    '../../services/date': { daysBetween: () => 1 },
  }, { showToast() {} })
  await home.refresh(); assert.equal(home.data.recentLoaded, false); assert.equal(home.data.recentError, 'offline')
  assert.equal(home.data.bound, true); assert.equal(home.data.days, 1); assert.equal(home.data.startDate, '2020-01-01')
  fail = false; await home.refresh(); assert.equal(home.data.recentLoaded, true); assert.equal(home.data.recentError, '')
  home.data.recent = [{ id: 'old' }]; home.data.hasRecent = true; fail = true; await home.refresh(); assert.equal(home.data.recent[0].id, 'old'); assert.equal(home.data.recentError, 'offline')

  let audio, plays = 0, destroyed = 0
  const compose = page('miniprogram/pages/compose/compose.ts', { '../../services/theme': theme, '../../utils/cloud-url-cache': { resolveCloudUrl: async path => path }, '../../services/date': { todayKey: () => '2026-01-01' } }, { createInnerAudioContext: () => (audio = { onPlay: fn => { audio.played = fn }, onPause: fn => { audio.paused = fn }, onEnded() {}, onError() {}, play() { plays++; this.played() }, pause() { this.paused() }, stop() {}, destroy() { destroyed++ } }), showToast() {} })
  compose.data.voice = { path: '/draft.mp3', duration: 3 }
  await compose.onToggleVoicePreview(); assert.equal(plays, 1); assert.equal(compose.data.voicePlaying, true)
  await compose.onToggleVoicePreview(); assert.equal(compose.data.voicePlaying, false)
  await compose.onToggleVoicePreview(); assert.equal(plays, 2)
  compose.onHide(); assert.equal(destroyed, 1); assert.equal(compose.data.voicePlaying, false)

  let resolveVoice, lateAudio = 0
  const hiddenCompose = page('miniprogram/pages/compose/compose.ts', { '../../services/theme': theme, '../../utils/cloud-url-cache': { resolveCloudUrl: () => new Promise(resolve => { resolveVoice = resolve }) }, '../../services/date': { todayKey: () => '2026-01-01' } }, { createInnerAudioContext: () => { lateAudio++; throw new Error('should not play') }, showToast() {} })
  hiddenCompose.data.voice = { path: 'cloud://voice', duration: 3 }
  const pendingVoice = hiddenCompose.onToggleVoicePreview()
  hiddenCompose.onHide(); resolveVoice('/voice.mp3'); await pendingVoice
  assert.equal(lateAudio, 0); assert.equal(hiddenCompose.data.voiceLoading, false); assert.equal(hiddenCompose.data.voicePlaying, false)

  let choose, modalCount = 0, toastCount = 0, settings = 0
  const location = page('miniprogram/pages/compose/compose.ts', { '../../services/theme': theme, '../../services/date': { todayKey: () => '2026-01-01' } }, {
    chooseLocation: options => { choose = options },
    showModal: options => { modalCount++; options.success({ confirm: true }) },
    openSetting: () => { settings++ }, showToast: () => { toastCount++ },
  })
  location.onPickLocation(); choose.fail({ errMsg: 'chooseLocation:fail cancel' }); assert.equal(modalCount + toastCount, 0)
  location.onPickLocation(); choose.fail({ errMsg: 'chooseLocation:fail auth deny' }); assert.equal(modalCount, 1); assert.equal(settings, 1)
  location.onPickLocation(); choose.fail({ errMsg: 'chooseLocation:fail network error' }); assert.equal(toastCount, 1)
  console.log('frontend regression checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
