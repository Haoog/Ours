const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '../miniprogram')
const scripts = new Map()
const ready = { status: 'ready', coupleId: 'space', openid: 'member', role: 'A' }
const draft = { requestId: 'restored-request', content: '原草稿', tagSelected: 'daily', momentDate: '2026-02-01',
  location: '', locationFull: null, images: [], video: '', videoCover: '', livePhotos: [], voice: null }
const defer = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function scenario({ offline = false, saved, edit = false } = {}) {
  let session = offline ? null : ready
  let definition
  const storage = new Map()
  const files = new Set()
  const toasts = [], navigations = [], picks = [], modals = [], timers = [], writes = [], submissions = []
  const controls = { syncs: 0, stale: 0, mediaLimit: 12, recorderCalls: 0, momentContent: '原回忆' }
  const recorder = {
    onStart(callback) { controls.recordStarted = callback },
    onStop(callback) { controls.recordStopped = callback },
    onError() {}, start() {}, stop() {},
  }
  const api = {
    getSession: () => session,
    requireSession() { assert.ok(session); return session },
    coupleId: () => api.requireSession().coupleId,
    async syncSession() { controls.syncs++; if (!session) throw new Error('offline') },
  }
  const submit = (...args) => {
    submissions.push(args[0])
    return controls.submit?.(...args)
  }
  const wx = {
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    env: { USER_DATA_PATH: '/data' },
    getFileSystemManager: () => ({
      accessSync(file) { if (!files.has(file)) throw new Error('missing file') },
      mkdirSync() {},
      copyFile(options) {
        if (controls.copy) return controls.copy(options)
        if (!files.has(options.srcPath)) return options.fail(new Error('missing file'))
        files.add(options.destPath)
        options.success()
      },
      readdirSync: () => [], rmdirSync() {}, unlinkSync: file => files.delete(file),
    }),
    getRecorderManager() { controls.recorderCalls++; return recorder },
    authorize: ({ success }) => success(),
    getSystemInfoSync: () => ({ platform: 'ios' }),
    showToast: ({ title }) => toasts.push(title),
    showModal: modal => modals.push(modal),
    chooseMedia: pick => picks.push(pick),
    setNavigationBarTitle() {},
    switchTab: ({ url }) => navigations.push(url),
    navigateBack: async () => navigations.push('back'),
  }
  const mocks = {
    'app.ts': { getAppInstance: () => ({ waitBoot: async () => {}, globalData: {} }) },
    'services/session.ts': api,
    'services/theme.ts': { getThemeStyle: () => '', syncTheme() {} },
    'services/store.ts': {
      getIdentity: () => api.requireSession(),
      getCouple: () => ({ startDate: '2020-01-01', quota: { maxMediaPerMoment: controls.mediaLimit } }),
      async getMoment() {
        return { authorRole: 'A', content: controls.momentContent, momentDate: '2026-02-01', images: controls.momentImages }
      },
      addMoment: submit, updateMoment: submit,
    },
    'services/moments-list-state.ts': { markMomentsListStale() { controls.stale++ } },
    'services/moments-feed-cache.ts': { feedCacheKey() {}, prefetchMomentsFeed() {} },
  }
  const context = vm.createContext({ wx, Error, console, Page: page => { definition = page },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].callback = null },
    setInterval: () => 1, clearInterval() {},
  })
  const modules = new Map()
  function load(file) {
    if (mocks[file]) return mocks[file]
    if (modules.has(file)) return modules.get(file)
    if (!scripts.has(file)) {
      const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      })
      scripts.set(file, new vm.Script(`(function(exports, require) {\n${outputText}\n})`, { filename: file }))
    }
    const exports = {}
    modules.set(file, exports)
    scripts.get(file).runInContext(context)(exports, id => load(path.join(path.dirname(file), `${id}.ts`)))
    return exports
  }
  if (saved) storage.set('OURS_DRAFT_V2_space_A_new', structuredClone(saved))
  load('pages/compose/compose.ts')
  const createPage = () => ({ ...definition, data: structuredClone(definition.data), setData(values) {
    writes.push({ unloaded: this.unloaded })
    Object.assign(this.data, values)
  } })
  const page = createPage()
  return { page, createPage, storage, files, toasts, navigations, picks, modals, timers, writes, submissions, controls,
    get online() { return !!session }, set online(value) { session = value ? ready : null },
    readDraft: load('services/compose-draft.ts').readComposeDraft,
    async open(options = edit ? { id: 'edit-id' } : {}) {
      const opening = page.onLoad(options)
      page.onShow()
      await opening
    },
  }
}

const input = (page, value) => page.onContentInput({ detail: { value } })
const pickImage = { tempFiles: [{ fileType: 'image', tempFilePath: '/picked.jpg' }] }

test('cold start without a session retries on foreground and restores request ID, draft and recorder once', async () => {
  const h = scenario({ offline: true, saved: draft })
  await h.open({ recapMonth: '2026-01' })
  h.online = true
  await h.page.onShow()
  await h.page.onShow()
  assert.equal(h.page.requestId, draft.requestId)
  assert.equal(h.page.data.content, draft.content)
  assert.equal(h.controls.recorderCalls, 1)
  assert.equal(h.controls.syncs, 2)
})

test('offline retry is reachable in the new-page markup and preserves the recap month', async () => {
  const h = scenario({ offline: true })
  await h.open({ recapMonth: '2026-01' })
  const markup = fs.readFileSync(path.join(root, 'pages/compose/compose.wxml'), 'utf8')
  const [, retry] = markup.match(/wx:elif="{{editError}}"[^>]*bindtap="(\w+)"/)
  h.online = true
  await h.page[retry]()
  assert.equal(h.page.data.momentDate, '2026-01-01')
  assert.ok(h.page.requestId)
})

for (const edit of [false, true]) {
  test(`${edit ? 'edit' : 'publish'} does not start after unloading during the initial draft save`, async () => {
    const h = scenario({ edit })
    if (edit) h.controls.momentImages = ['/picked.jpg']
    await h.open()
    if (!edit) h.page.setData({ images: ['/picked.jpg'] })
    input(h.page, '等待保存的内容')
    const copies = []
    h.controls.copy = options => copies.push(options)
    const submission = h.page.onSubmit()
    assert.equal(copies.length, 1)
    h.page.onUnload()
    for (const copy of copies) { h.files.add(copy.destPath); copy.success() }
    await submission
    await h.page.draftSaveQueue
    assert.equal(h.submissions.length, 0)
    assert.ok(h.writes.every(write => !write.unloaded))
    assert.equal(h.readDraft(edit ? 'edit-id' : '').content, '等待保存的内容')
  })
}

test('completed publish after unload clears its draft without touching the departed page or navigating', async () => {
  const h = scenario()
  await h.open()
  input(h.page, '已提交的内容')
  const result = defer()
  let progress
  h.controls.submit = (_input, callback) => { progress = callback; return result.promise }
  const submission = h.page.onSubmit()
  await flush()
  assert.equal(h.submissions.length, 1)
  h.page.onUnload()
  progress(50, '上传中')
  result.resolve()
  await submission
  for (const timer of h.timers.filter(timer => timer.delay === 500)) timer.callback?.()
  assert.ok(h.writes.every(write => !write.unloaded))
  assert.deepEqual(h.navigations, [])
  assert.deepEqual(h.toasts, [])
  assert.equal(h.readDraft(), null)
  assert.equal(h.controls.stale, 1)
})

test('reopening while a sent publish is unresolved waits and restores its confirmation state', async () => {
  const h = scenario()
  await h.open()
  input(h.page, '已发送的草稿')
  const result = defer()
  h.controls.submit = (_input, _progress, state) => {
    state('sending', 'receipt')
    return result.promise.catch(error => { state('uncertain'); throw error })
  }
  const submission = h.page.onSubmit()
  await flush()
  h.page.onUnload()
  const reopened = h.createPage()
  const opening = reopened.onLoad({})
  reopened.onShow()
  await flush()
  assert.equal(reopened.data.draftLoading, true)
  result.reject(new Error('保存结果待确认'))
  await Promise.all([submission, opening])
  assert.equal(reopened.data.draftLoading, false)
  assert.equal(reopened.data.pendingResult, true)
  assert.equal(reopened.requestId, h.page.requestId)
  assert.deepEqual([...h.readDraft().pendingMediaReceipts], ['receipt'])
  assert.ok(h.writes.every(write => !write.unloaded))
  assert.deepEqual(h.toasts, ['已恢复上次草稿'])
})

test('reopening an edit while its save is in flight loads the updated server fields', async () => {
  const h = scenario({ edit: true })
  await h.open()
  input(h.page, '已修改的回忆')
  const result = defer()
  h.controls.submit = (_id, changes) => result.promise.then(() => { h.controls.momentContent = changes.content })
  const submission = h.page.onSubmit()
  await flush()
  h.page.onUnload()
  const reopened = h.createPage()
  const opening = reopened.onLoad({ id: 'edit-id' })
  reopened.onShow()
  await flush()
  result.resolve()
  await Promise.all([submission, opening])
  assert.equal(reopened.data.content, '已修改的回忆')
  assert.equal(reopened.editBase.content, '已修改的回忆')
  assert.equal(h.readDraft('edit-id'), null)
})

test('recording blocks media selection and late results from taking its last slot', async () => {
  const h = scenario()
  h.controls.mediaLimit = 1
  h.files.add('/picked.jpg')
  await h.open()
  h.page.onPickAlbum()
  h.page.onToggleRecord()
  h.controls.recordStarted()
  h.page.onPickAlbum()
  h.picks[0].success(pickImage)
  h.page.onToggleRecord()
  h.controls.recordStopped({ tempFilePath: '/voice.mp3', duration: 2000 })
  assert.equal(h.picks.length, 1)
  assert.equal(h.page.data.images.length, 0)
  assert.equal(h.page.data.voice.duration, 2)
  assert.equal(h.page.data.mediaRemaining, 0)
})

test('unloading during the success toast cancels the scheduled navigation', async () => {
  const h = scenario()
  await h.open()
  input(h.page, '成功后退出')
  await h.page.onSubmit()
  h.page.onUnload()
  for (const timer of h.timers.filter(timer => timer.delay === 500)) timer.callback?.()
  assert.deepEqual(h.navigations, [])
})

test('native media callbacks ignore superseded and unloaded selections but accept a result while hidden', async () => {
  const h = scenario()
  h.files.add('/picked.jpg')
  await h.open()
  h.page.onPickAlbum()
  h.page.onPickVideo()
  h.picks[0].success(pickImage)
  assert.equal(h.page.data.images.length, 0)
  h.page.onPickAlbum()
  h.page.onHide()
  h.picks[2].success(pickImage)
  assert.equal(h.page.data.images.length, 1)
  h.page.onShow()
  h.page.onPickLivePhoto()
  h.page.onUnload()
  h.modals[0].success({ confirm: true })
  h.picks[1].fail({ errMsg: 'chooseMedia:fail unavailable' })
  assert.equal(h.picks.length, 3)
  assert.deepEqual(h.toasts, [])
  assert.ok(h.writes.every(write => !write.unloaded))
})

test('restoring missing video removes its orphaned cover, preserves surviving media and discloses the loss', async () => {
  const saved = { ...draft, images: ['/kept.jpg', '/gone.jpg'], video: '/gone.mp4', videoCover: '/poster.jpg',
    livePhotos: [{ id: 'broken', cover: '/poster.jpg', video: '' }], voice: { path: '', duration: 2 } }
  const h = scenario({ saved })
  h.controls.mediaLimit = 2
  h.files.add('/kept.jpg')
  h.files.add('/poster.jpg')
  await h.open()
  assert.equal(h.page.data.video, '')
  assert.equal(h.page.data.videoCover, '')
  assert.equal(h.page.data.livePhotos.length, 0)
  assert.equal(h.page.data.voice, null)
  assert.deepEqual([...h.page.data.images], ['/kept.jpg'])
  assert.equal(h.page.data.mediaRemaining, 1)
  assert.deepEqual(h.toasts, ['部分草稿媒体已失效'])
})

test('missing optional poster does not discard the draft video', async () => {
  const h = scenario({ saved: { ...draft, video: '/kept.mp4', videoCover: '/gone.jpg' } })
  h.files.add('/kept.mp4')
  await h.open()
  assert.equal(h.page.data.video, '/kept.mp4')
  assert.equal(h.page.data.videoCover, '')
  assert.equal(h.page.data.canPost, true)
})
