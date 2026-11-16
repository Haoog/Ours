const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const ts = require('../node_modules/typescript')

function compile(path, context) {
  const source = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(source, context)
}
const live = {}
compile('miniprogram/utils/live-photo.ts', { exports: live })

async function main() {
  let page, picker, modal, failSave = false, addCalls = 0, uncertain = false
  const saved = [], toasts = []
  const session = { status: 'ready', coupleId: 'space', role: 'A', openid: 'user' }
  const wx = {
    chooseMedia: options => { picker = options },
    showModal: options => { modal = options },
    showToast: options => { toasts.push(options.title) },
    switchTab() {},
  }
  const modules = {
    '../../utils/live-photo': live,
    '../../services/store': { getCouple: () => ({ quota: { maxMediaPerMoment: 12, maxMediaItems: 100 }, usage: { mediaItems: 0 } }), addMoment: async (_draft, progress) => { addCalls++; if (uncertain) { progress(98, ''); throw new Error('网络中断') } } },
    '../../services/session': { getSession: () => session },
    '../../services/compose-draft': { saveComposeDraft: async draft => { if (failSave) throw new Error('磁盘已满'); saved.push(draft) }, clearComposeDraft() {} },
    '../../services/date': { todayKey: () => '2026-01-01' },
    '../../services/theme': { getThemeStyle: () => '' },
  }
  const fallback = new Proxy({}, { get: () => () => undefined })
  compile('miniprogram/pages/compose/compose.ts', {
    exports: {}, require: id => modules[id] || fallback, Page: value => { page = value }, wx,
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, Number, Error,
  })
  function fresh() {
    page.data = { ...page.data, content: '', images: [], livePhotos: [], video: '', videoCover: '', voice: null, editing: false, pendingResult: false }
    page.requestId = 'test'; page.editId = ''; page.skipDraftSaveOnUnload = false; page.draftIdentity = { ...session }
    page.draftSaveQueue = Promise.resolve()
    page.setData = values => Object.assign(page.data, values)
    saved.length = 0; toasts.length = 0; picker = null; modal = null; failSave = false; addCalls = 0; uncertain = false
    page.data.posting = false; page.data.canPost = true; page.data.uploadProgress = 0
  }
  const video = (duration, thumb = '/cover.jpg') => ({ fileType: 'video', tempFilePath: '/movie.mp4', thumbTempFilePath: thumb, duration })
  for (const duration of [0, 3, 4.5, 4.6, 120]) {
    fresh(); page.onPickVideo(); picker.success({ tempFiles: [video(duration)] })
    assert.equal(page.data.video, '/movie.mp4'); assert.equal(page.data.livePhotos.length, 0)
    assert.equal(page.data.mediaRemaining, 10); assert.equal(page.data.canPost, true)
    await page.draftSaveQueue; assert.equal(saved.at(-1).video, '/movie.mp4')
  }
  fresh(); page.onPickAlbum(); picker.success({ tempFiles: [{ fileType: 'image', tempFilePath: '/photo.jpg' }, video(3), video(90)] })
  assert.equal(page.data.images.length, 1); assert.equal(page.data.video, '/movie.mp4'); assert.equal(page.data.livePhotos.length, 0)
  assert.equal(page.data.mediaRemaining, 9); await page.draftSaveQueue; assert.equal(saved.at(-1).images[0], '/photo.jpg')
  fresh(); page.onPickLivePhoto(); assert.match(modal.content, /视频/); modal.success({ confirm: true }); picker.success({ tempFiles: [video(3)] })
  assert.equal(page.data.livePhotos.length, 1); assert.equal(page.data.video, ''); assert.equal(page.data.canPost, true)
  assert.equal(page.data.mediaRemaining, 10); await page.draftSaveQueue; assert.equal(saved.at(-1).livePhotos[0].video, '/movie.mp4')
  fresh(); page.onPickLivePhoto(); modal.success({ confirm: true }); picker.success({ tempFiles: [{ fileType: 'image', tempFilePath: '/photo.jpg' }] })
  assert.equal(page.data.livePhotos.length, 0); assert.match(modal.title, /无法/)
  fresh(); page.onPickLivePhoto(); modal.success({ confirm: true }); picker.success({ tempFiles: [video(3, '')] })
  assert.equal(page.data.livePhotos.length, 0); assert.match(modal.content, /缩略图/)
  fresh(); page.data.images = Array.from({ length: 11 }, (_, i) => String(i)); page.onPickLivePhoto(); assert.equal(picker, null)
  fresh(); page.applyMediaFiles([video(3, '')]); assert.equal(page.data.video, '/movie.mp4'); assert.equal(page.data.mediaRemaining, 11)
  await page.draftSaveQueue; assert.equal(saved.at(-1).video, '/movie.mp4')
  fresh(); page.data.images = Array.from({ length: 11 }, (_, i) => String(i)); page.onPickVideo(); assert.ok(picker)
  picker.success({ tempFiles: [video(3, '')] }); assert.equal(page.data.video, '/movie.mp4'); assert.equal(page.data.mediaRemaining, 0); await page.draftSaveQueue
  fresh(); page.data.images = Array.from({ length: 11 }, (_, i) => String(i)); page.onPickVideo()
  picker.success({ tempFiles: [video(3)] }); assert.equal(page.data.video, ''); assert.match(toasts.at(-1), /两个媒体名额/)
  fresh(); page.onPickVideo(); page.data.images = Array.from({ length: 11 }, (_, i) => String(i))
  picker.success({ tempFiles: [video(3)] }); assert.equal(page.data.video, ''); assert.match(toasts.at(-1), /两个媒体名额/)
  fresh(); page.onPickVideo(); page.data.video = '/other.mp4'; picker.success({ tempFiles: [video(3)] }); assert.equal(page.data.video, '/other.mp4'); assert.match(toasts.at(-1), /已有一条视频/)
  fresh(); page.data.images = Array.from({ length: 12 }, (_, i) => String(i)); page.onPickVideo(); assert.equal(picker, null); assert.match(toasts.at(-1), /名额已满/)
  fresh(); failSave = true; page.saveDraft(); await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(toasts.some(t => /草稿未能保存/.test(t)))
  await page.onSubmit(); assert.equal(addCalls, 0); assert.ok(toasts.some(t => /草稿未能保存/.test(t)))
  failSave = false; await page.onSubmit(); assert.equal(addCalls, 1); assert.equal(saved.at(-1).pendingResult, false)
  fresh(); uncertain = true; await page.onSubmit(); assert.equal(addCalls, 1); assert.equal(page.data.pendingResult, true); assert.equal(saved.at(-1).pendingResult, true)
  let current = { coupleId: 'A', role: 'A', openid: 'alice' }, copy
  const storage = new Map([['OURS_DRAFT_V2_B_B_new', { content: 'B原有草稿' }]])
  const draftService = {}
  compile('miniprogram/services/compose-draft.ts', {
    exports: draftService,
    require: id => id === './session' ? { requireSession: () => current, coupleId: () => current.coupleId } : { todayKey: () => '2026-01-01' },
    wx: { env: { USER_DATA_PATH: '/data' }, getFileSystemManager: () => ({ mkdirSync() {}, copyFile: options => { copy = options } }), setStorageSync: (key, value) => storage.set(key, value) },
    Promise, Date, Math, Map, Error,
  })
  for (const changed of [{ coupleId: 'B', role: 'B', openid: 'bob' }, { coupleId: 'A', role: 'A', openid: 'other' }, { coupleId: 'A', role: 'B', openid: 'alice' }]) {
    current = { coupleId: 'A', role: 'A', openid: 'alice' }
    const pending = draftService.saveComposeDraft({ requestId: Math.random().toString(), images: ['/photo.jpg'], video: '', videoCover: '', livePhotos: [], voice: null })
    current = changed; copy.success()
    await assert.rejects(pending, /切换/)
    assert.equal(storage.has('OURS_DRAFT_V2_A_A_new'), false)
    assert.equal(storage.get('OURS_DRAFT_V2_B_B_new').content, 'B原有草稿')
  }
  console.log('视频、实况与发布草稿行为回归通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
