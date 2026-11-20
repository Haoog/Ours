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
  let page, picker, modal, failSave = false, addCalls = 0
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
    '../../services/store': { getCouple: () => ({ quota: { maxMediaPerMoment: 12, maxMediaItems: 100 }, usage: { mediaItems: 0 } }), addMoment: async () => { addCalls++ } },
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
    saved.length = 0; toasts.length = 0; picker = null; modal = null; failSave = false; addCalls = 0
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
  page.onPickAlbum()
  assert.deepEqual(Array.from(picker.mediaType), ['image'], 'An existing video leaves only photos available in the album')
  page.onRemoveVideo()
  page.onPickAlbum()
  assert.deepEqual(Array.from(picker.mediaType), ['image', 'video'])
  await page.draftSaveQueue
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
  let current = { coupleId: 'A', role: 'A', openid: 'alice' }, copy
  const storage = new Map([['OURS_DRAFT_V2_B_B_new', { content: 'B原有草稿' }]])
  const draftService = {}
  const fileSystem = {
    mkdirSync() {}, accessSync() {}, rmdirSync() {},
    copyFile(options) { copy = options },
    getFileInfo(options) { options.success({ size: 10 }) },
  }
  Object.assign(wx, {
    env: { USER_DATA_PATH: '/data' },
    getFileSystemManager: () => fileSystem,
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
  })
  compile('miniprogram/services/compose-draft.ts', {
    exports: draftService,
    require: id => id === './session' ? { requireSession: () => current, coupleId: () => current.coupleId } : { todayKey: () => '2026-01-01' },
    wx,
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
  current = session
  const cloudApi = {}, store = {}, pool = {}
  const calls = [], uploads = []
  let createResult
  let published = null
  wx.cloud = {
    callFunction: async ({ data: { action, payload } }) => {
      calls.push({ action, payload })
      if (action === 'addMoment') return createResult(payload)
      return { result: { ok: true, data: action === 'getPublishedMoment' ? published : null } }
    },
    uploadFile(options) {
      const upload = { options, progress: null }
      uploads.push(upload)
      return {
        abort: () => options.fail(new Error('aborted')),
        onProgressUpdate: callback => { upload.progress = callback },
      }
    },
  }
  const nextTurn = () => new Promise(resolve => setImmediate(resolve))
  compile('miniprogram/services/cloud-api.ts', {
    exports: cloudApi, wx, setTimeout: (callback, ms) => setTimeout(callback, ms === 400 ? 0 : ms), clearTimeout, Error,
  })
  compile('miniprogram/utils/async-pool.ts', { exports: pool })
  const storeModules = {
    './cloud-api': cloudApi,
    '../utils/async-pool': pool,
    './session': { coupleId: () => session.coupleId, requireSession: () => session, getSession: () => session },
  }
  compile('miniprogram/services/store.ts', {
    exports: store, require: id => storeModules[id] || fallback, wx, Error, setTimeout: setImmediate,
  })
  Object.assign(modules['../../services/store'], store)
  Object.assign(modules['../../services/compose-draft'], draftService)
  const storedDraft = () => draftService.readComposeDraft()
  const created = () => calls.filter(call => call.action === 'addMoment')
  const createSuccess = payload => ({ result: { ok: true, data: { id: 'saved', ...payload } } })
  const editContent = value => {
    page.onContentInput({ detail: { value } })
    clearTimeout(page.draftTimer)
  }

  fresh()
  page.data.content = '原草稿'
  page.data.images = ['/photo.jpg']
  copy = null
  const cancelled = page.onSubmit()
  await nextTurn()
  assert.equal(copy.srcPath, '/photo.jpg')
  page.onCancelUpload()
  copy.success()
  await nextTurn()
  assert.equal(uploads.length, 0, '取消后完成草稿复制不能触发上传')
  await cancelled
  assert.equal(calls.length, 0, '取消的提交不能发出发布请求')
  assert.equal(page.data.posting, false)
  assert.equal(storedDraft().content, '原草稿')
  assert.match(storedDraft().images[0], /^\/data\/ours-draft-test\//)
  editContent('手动重试')
  createResult = createSuccess
  const retried = page.onSubmit()
  await nextTurn()
  assert.equal(uploads.length, 1)
  uploads[0].options.success({ fileID: 'cloud://test/photo' })
  await retried
  assert.equal(created().length, 1)
  assert.equal(created()[0].payload.requestId, 'test')
  assert.equal(created()[0].payload.content, '手动重试')
  assert.equal(storedDraft(), null)

  fresh()
  page.requestId = 'voice'
  page.data.voice = { path: '/voice.mp3', duration: 4 }
  uploads.length = 0
  calls.length = 0
  const failedVoice = page.onSubmit()
  await nextTurn()
  assert.equal(copy.srcPath, '/voice.mp3')
  copy.success()
  for (let attempt = 0; attempt < 3; attempt++) {
    await nextTurn()
    const upload = uploads[attempt]
    upload.progress({ progress: 100 })
    assert.ok(page.data.uploadProgress >= 98, '必须复现语音上传的虚高进度')
    assert.equal(page.data.canCancelUpload, true)
    upload.options.fail(new Error('语音上传失败'))
    if (attempt < 2) await nextTurn()
  }
  await failedVoice
  assert.equal(created().length, 0)
  assert.equal(page.data.pendingResult, false)
  assert.equal(storedDraft().pendingResult, false)
  editContent('语音失败后仍可编辑')
  assert.equal(page.data.content, '语音失败后仍可编辑')
  assert.ok(toasts.includes('语音上传失败'))

  page.onRemoveVoice()
  clearTimeout(page.draftTimer)
  createResult = () => ({ result: { ok: false, error: '发布被拒绝' } })
  await page.onSubmit()
  assert.equal(created().length, 1)
  assert.equal(page.data.pendingResult, false)
  assert.ok(toasts.includes('发布被拒绝'))

  createResult = payload => {
    published = createSuccess(payload).result.data
    throw new Error('创建响应丢失')
  }
  const unconfirmed = page.onSubmit()
  await nextTurn()
  assert.equal(page.data.canCancelUpload, false)
  page.onCancelUpload()
  assert.ok(!toasts.includes('正在取消…'))
  await unconfirmed
  assert.equal(created().length, 3, '创建请求按原有策略重试一次')
  assert.ok(created().every(call => call.payload.requestId === 'voice'))
  assert.equal(page.data.pendingResult, true)
  assert.equal(storedDraft().pendingResult, true)
  editContent('锁定期间不能编辑')
  assert.equal(page.data.content, '语音失败后仍可编辑')
  fresh()
  await page.restoreDraft()
  assert.equal(page.data.pendingResult, true)
  assert.equal(page.requestId, 'voice')
  await page.onSubmit()
  assert.equal(created().length, 3, '确认已有记录时不得再次创建')
  assert.equal(storedDraft(), null)
  console.log('视频、实况与发布草稿行为回归通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
