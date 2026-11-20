const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '../miniprogram')
const scripts = new Map()

function scenario() {
  const calls = [], uploads = [], releases = [], toasts = [], navigations = []
  const authorizations = [], modals = [], settings = []
  const session = {
    status: 'ready', role: 'A', coupleId: 'space', openid: 'author',
    couple: { memberA: { nickname: 'Author', avatarUrl: '' } },
  }
  const storage = new Map()
  const files = new Set(['/image.jpg', '/video.mp4'])
  const controls = { starts: 0, stops: 0, cloud: () => ({ ok: true, data: null }) }
  const recorder = {
    onStart(callback) { controls.started = callback },
    onStop(callback) { controls.stopped = callback },
    onError(callback) { controls.failed = callback },
    start() { controls.starts++ },
    stop() { controls.stops++ },
  }
  const wx = {
    authorize: options => authorizations.push(options),
    showModal: options => modals.push(options),
    openSetting: options => settings.push(options),
    getRecorderManager: () => recorder,
    getSystemInfoSync: () => ({ platform: 'ios' }),
    showToast: ({ title }) => toasts.push(title),
    navigateTo: ({ url }) => navigations.push(url),
    async navigateBack() { navigations.push('back') },
    switchTab: ({ url }) => navigations.push(url),
    env: { USER_DATA_PATH: '/data' },
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({
      getFileInfo: ({ success }) => success({ size: 10 }),
      mkdirSync() {},
      copyFile({ srcPath, destPath, success, fail }) {
        if (!files.has(srcPath)) return fail(new Error('missing file'))
        files.add(destPath)
        success()
      },
      accessSync(file) { assert.ok(files.has(file)) },
      readdirSync(dir) { return [...files].filter(file => file.startsWith(`${dir}/`)).map(file => path.basename(file)) },
      unlinkSync: file => files.delete(file),
      rmdirSync(dir) { for (const file of files) if (file.startsWith(`${dir}/`)) files.delete(file) },
    }),
    cloud: {
      async callFunction({ data: { action, payload } }) {
        calls.push([action, structuredClone(payload)])
        return { result: await controls.cloud(action, payload) }
      },
      uploadFile({ filePath, success, fail }) {
        const fileID = `cloud://uploaded-${uploads.length + 1}`
        uploads.push({ filePath, fileID })
        if (controls.uploadFailure) fail(new Error('upload network unavailable'))
        else success({ fileID })
      },
    },
    getVideoInfo({ success, fail }) {
      if (controls.badVideo) fail(new Error('unreadable video'))
      else success({ width: 1280, height: 720, bitrate: 1800, fps: 30 })
    },
    compressVideo: ({ success }) => success({ tempFilePath: '/compressed.mp4' }),
  }
  const mocks = {
    'app.ts': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    'services/page-boot.ts': { ensureCloudReady: async () => true },
    'services/session.ts': {
      coupleId: () => session.coupleId, requireSession: () => session, getSession: () => session,
    },
    'services/theme.ts': { getThemeStyle: () => '', syncTheme() {} },
    'services/upload-cleanup.ts': {
      holdUpload() {},
      releaseUploads(owner, ids, used) { releases.push({ ids: [...ids], used: [...used] }) },
      async retryUploadCleanup() {},
    },
    'services/moments-feed-cache.ts': { feedCacheKey() {}, prefetchMomentsFeed() {}, invalidateMomentsFeedPrefetch() {} },
    'utils/cloud-url-cache.ts': {},
  }
  let definition
  const context = vm.createContext({
    wx, console: { warn() {} }, Error,
    Page: page => { definition = page },
    setTimeout(callback, delay) {
      if (delay !== 20000) queueMicrotask(callback)
      return 1
    },
    clearTimeout() {}, setInterval: () => 1, clearInterval() {},
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
  load('pages/compose/compose.ts')
  return {
    calls, uploads, releases, controls, toasts, navigations, authorizations, modals, settings,
    readDraft: load('services/compose-draft.ts').readComposeDraft,
    async open() {
      const form = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
      const opening = form.onLoad({})
      form.onShow()
      await opening
      return form
    },
  }
}

const absent = { ok: true, data: null }
const rejected = { ok: false, error: '已达到媒体数量额度，请联系管理员' }
const transportFailure = () => { throw new Error('network unavailable') }
const actions = calls => calls.map(([action]) => action)
const content = (form, value) => form.onContentInput({ detail: { value } })
const saved = (payload, id = 'saved-id') => ({ ok: true, data: { ...payload, id, content: payload.content.trim() } })

async function uncertainPublish(harness, type = 'image') {
  const form = await harness.open()
  content(form, '原草稿')
  if (type === 'image') form.setData({ images: ['/image.jpg'] })
  else form.setData({ video: '/video.mp4' })
  let prior
  harness.controls.cloud = (action, payload) => {
    if (action !== 'addMoment') return absent
    prior ||= saved(payload)
    return transportFailure()
  }
  await form.onSubmit()
  assert.deepEqual(actions(harness.calls), [
    'getPublishedMoment', 'validateMoment', ...(type === 'video' ? ['validateMoment'] : []), 'addMoment', 'addMoment',
  ])
  assert.equal(form.data.pendingResult, true)
  assert.equal(harness.readDraft().pendingResult, true)
  assert.deepEqual(harness.releases[0], { ids: ['cloud://uploaded-1'], used: [] })
  return { form, prior, requestId: form.requestId }
}

async function rejectOnRetry(harness, form) {
  const start = harness.calls.length
  harness.controls.cloud = action => action === 'validateMoment' ? rejected : absent
  await form.onSubmit()
  assert.deepEqual(actions(harness.calls.slice(start)), ['getPublishedMoment', 'validateMoment'])
  assert.equal(form.data.pendingResult, false, 'definitive media rejection should unlock the form')
  assert.equal(harness.readDraft().pendingResult, false)
}

test('definitive rejection unlocks the persisted draft, then correction reconciles and creates with its original request ID', async () => {
  const harness = scenario()
  const { form, requestId } = await uncertainPublish(harness)
  await rejectOnRetry(harness, form)
  form.onUnload()
  const restored = await harness.open()
  assert.equal(restored.requestId, requestId)
  assert.equal(restored.data.pendingResult, false)
  restored.onRemoveImage({ currentTarget: { dataset: { index: 0 } } })
  content(restored, '已修正')
  harness.controls.cloud = (action, payload) => action === 'addMoment' ? saved(payload) : absent
  const start = harness.calls.length
  await restored.onSubmit()
  const retry = harness.calls.slice(start)
  assert.deepEqual(actions(retry), ['getPublishedMoment', 'validateMoment', 'addMoment'])
  assert.equal(retry[0][1].requestId, requestId)
  assert.equal(retry[2][1].requestId, requestId)
  assert.equal(retry[2][1].content, '已修正')
  assert.deepEqual(retry[2][1].images, [])
  assert.equal(harness.readDraft(), null)
  assert.equal(harness.toasts.at(-1), '已保存')
})

test('an old commit found at reconciliation or returned from create preserves corrections and links to the existing record', async () => {
  for (const foundAt of ['getPublishedMoment', 'addMoment']) {
    const harness = scenario()
    const { form, prior, requestId } = await uncertainPublish(harness)
    await rejectOnRetry(harness, form)
    content(form, '修改后的文字')
    const start = harness.calls.length
    harness.controls.cloud = action => action === foundAt ? prior : absent
    await form.onSubmit()
    assert.deepEqual(actions(harness.calls.slice(start)), foundAt === 'addMoment'
      ? ['getPublishedMoment', 'validateMoment', 'addMoment'] : ['getPublishedMoment'])
    if (foundAt === 'addMoment') assert.deepEqual(harness.releases.at(-1), { ids: ['cloud://uploaded-2'], used: ['cloud://uploaded-1'] })
    assert.equal(form.requestId, requestId)
    assert.equal(harness.readDraft().content, '修改后的文字')
    assert.equal(harness.toasts.includes('已保存'), false)
    assert.deepEqual(harness.navigations, [])
    form.onUnload()
    const restored = await harness.open()
    const markup = fs.readFileSync(path.join(root, 'pages/compose/compose.wxml'), 'utf8')
    const [, viewExisting] = markup.match(/bindtap="(\w+)"[^>]*>查看已发布回忆</)
    restored[viewExisting]()
    assert.deepEqual(harness.navigations, ['/pages/moment-detail/moment-detail?id=saved-id'])
    assert.equal(harness.readDraft().images.length, 1)
    const [, discard] = markup.match(/bindtap="(\w+)"[^>]*> 舍弃草稿</)
    restored[discard]()
    await harness.modals.at(-1).success({ confirm: false })
    assert.equal(harness.readDraft().content, '修改后的文字')
    restored[discard]()
    await harness.modals.at(-1).success({ confirm: true })
    assert.equal(harness.readDraft(), null)
    assert.equal(harness.navigations.at(-1), 'back')
  }
})

test('after unlocking and reopening, an original receipt completes only if the media draft was left intact', async () => {
  for (const removeImage of [false, true]) {
    const harness = scenario()
    const { form, prior } = await uncertainPublish(harness)
    await rejectOnRetry(harness, form)
    if (removeImage) form.onRemoveImage({ currentTarget: { dataset: { index: 0 } } })
    form.onUnload()
    const restored = await harness.open()
    harness.controls.cloud = () => prior
    await restored.onSubmit()
    if (removeImage) {
      assert.equal(harness.readDraft().existingMomentId, 'saved-id')
      assert.equal(harness.readDraft().images.length, 0)
      assert.equal(harness.toasts.includes('已保存'), false)
    } else {
      assert.equal(harness.readDraft(), null)
      assert.equal(harness.toasts.at(-1), '已保存')
    }
  }
})

test('matching corrected media receipts complete after reopening, including a create that returns a prior matching commit', async () => {
  for (const foundAt of ['getPublishedMoment', 'addMoment']) {
    const harness = scenario()
    const { form } = await uncertainPublish(harness)
    await rejectOnRetry(harness, form)
    content(form, '修正后仍附图片')
    let corrected
    harness.controls.cloud = (action, payload) => {
      if (action !== 'addMoment') return absent
      corrected ||= saved(payload)
      return transportFailure()
    }
    await form.onSubmit()
    await form.onSubmit()
    assert.equal(harness.readDraft().pendingResult, true)
    assert.equal(harness.readDraft().pendingMediaReceipts.length, 2)
    form.onUnload()
    const restored = await harness.open()
    harness.controls.cloud = action => action === foundAt ? corrected : absent
    await restored.onSubmit()
    assert.equal(harness.readDraft(), null)
    assert.equal(harness.toasts.at(-1), '已保存')
  }
})

test('a missing lookup followed by video compression failure or post-compression rejection unlocks the original draft', async () => {
  for (const badVideo of [false, true]) {
    const harness = scenario()
    const { form, requestId } = await uncertainPublish(harness, 'video')
    harness.controls.badVideo = badVideo
    harness.controls.cloud = (action, payload) => action === 'validateMoment' && payload.mediaBytes > 0 ? rejected : absent
    const start = harness.calls.length
    await form.onSubmit()
    assert.deepEqual(actions(harness.calls.slice(start)), ['getPublishedMoment', 'validateMoment', ...(badVideo ? [] : ['validateMoment'])])
    assert.equal(harness.readDraft().requestId, requestId)
    assert.equal(harness.readDraft().pendingResult, false)
    form.onRemoveVideo()
    assert.equal(form.data.video, '')
  }
})

test('lookup, validation, and upload transport failures retain uncertainty; a genuine original receipt still completes', async () => {
  const harness = scenario()
  const { form, prior } = await uncertainPublish(harness)
  const failures = [
    ['getPublishedMoment', transportFailure],
    ['getPublishedMoment', () => ({ ok: true })],
    ['validateMoment', transportFailure],
    ['validateMoment', () => ({ ok: false, error: '内容审核服务暂时不可用，请稍后再试' })],
    ['upload', transportFailure],
  ]
  for (const [failingAction, failure] of failures) {
    harness.controls.cloud = action => action === failingAction ? failure() : absent
    harness.controls.uploadFailure = failingAction === 'upload'
    const start = harness.calls.length
    await form.onSubmit()
    assert.equal(form.data.pendingResult, true)
    assert.equal(harness.readDraft().pendingResult, true)
    assert.equal(actions(harness.calls.slice(start)).includes('addMoment'), false)
  }
  const start = harness.calls.length
  harness.controls.cloud = () => prior
  await form.onSubmit()
  assert.deepEqual(actions(harness.calls.slice(start)), ['getPublishedMoment'])
  assert.equal(harness.readDraft(), null)
  assert.equal(harness.toasts.at(-1), '已保存')
})

test('stale authorize success cannot start recording after hide and show or consume a new tap', async () => {
  const harness = scenario()
  const form = await harness.open()
  form.onToggleRecord()
  form.onHide()
  form.onShow()
  form.onToggleRecord()
  harness.authorizations[0].success()
  assert.equal(harness.controls.starts, 0)
  assert.equal(harness.authorizations.length, 2)
  assert.equal(form.data.recordPending, true)
  harness.authorizations[1].success()
  assert.equal(harness.controls.starts, 1)
  harness.controls.started()
  form.onHide()
  assert.equal(harness.controls.stops, 1)
  harness.controls.stopped({ tempFilePath: '/voice.mp3', duration: 2000 })
  assert.equal(form.data.voice.duration, 2)
})

test('stale permission failures never open a modal and an old modal cannot open settings', async () => {
  const harness = scenario()
  const form = await harness.open()
  form.onToggleRecord()
  form.onHide()
  harness.authorizations[0].fail(new Error('denied'))
  assert.equal(harness.modals.length, 0)
  form.onShow()
  form.onToggleRecord()
  harness.authorizations[1].fail(new Error('denied'))
  form.onHide()
  form.onShow()
  form.onToggleRecord()
  harness.modals[0].success({ confirm: true })
  assert.equal(harness.settings.length, 0)
  assert.equal(form.data.recordPending, true)
})

test('native settings can grant immediately or require a new tap after hiding, and permission remains retryable', async () => {
  for (const hides of [false, true]) {
    const harness = scenario()
    const form = await harness.open()
    form.onToggleRecord()
    harness.authorizations[0].fail(new Error('denied'))
    harness.modals[0].success({ confirm: true })
    if (hides) {
      form.onHide()
      form.onShow()
      assert.equal(form.data.recordPending, false)
      form.onToggleRecord()
    }
    harness.settings[0].success({ authSetting: { 'scope.record': true } })
    assert.equal(harness.controls.starts, hides ? 0 : 1)
    if (hides) {
      assert.equal(form.data.recordPending, true)
      harness.authorizations[1].success()
      assert.equal(harness.controls.starts, 1)
    }
  }
})

test('hide preserves ownership after RecorderManager.start has been requested', async () => {
  const harness = scenario()
  const form = await harness.open()
  form.onToggleRecord()
  harness.authorizations[0].success()
  assert.equal(harness.controls.starts, 1)
  form.onHide()
  assert.equal(form.data.recordPending, true)
  harness.controls.started()
  assert.equal(harness.controls.stops, 1)
  harness.controls.stopped({ tempFilePath: '/voice.mp3', duration: 2000 })
  assert.equal(form.data.recordPending, false)
  assert.equal(form.data.voice.duration, 2)
  form.onShow()
  form.onToggleRecord()
  const replacement = harness.modals.at(-1)
  form.onHide()
  form.onShow()
  replacement.success({ confirm: true })
  assert.equal(harness.authorizations.length, 1)
  assert.equal(form.data.recordPending, false)
})

test('cancellation, settings denial or failure, and unload end only the corresponding permission flow', async () => {
  const harness = scenario()
  const form = await harness.open()
  for (const completion of ['cancel', 'modal-failure', 'denied', 'settings-failure']) {
    form.onToggleRecord()
    harness.authorizations.at(-1).fail(new Error('denied'))
    const modal = harness.modals.at(-1)
    if (completion === 'cancel') modal.success({ confirm: false })
    else if (completion === 'modal-failure') modal.fail()
    else {
      modal.success({ confirm: true })
      const setting = harness.settings.at(-1)
      if (completion === 'denied') setting.success({ authSetting: {} })
      else setting.fail()
    }
    assert.equal(form.data.recordPending, false)
    assert.equal(harness.controls.starts, 0)
  }
  form.onToggleRecord()
  const stale = harness.authorizations.at(-1)
  const modalCount = harness.modals.length
  form.onUnload()
  stale.fail(new Error('denied'))
  assert.equal(harness.modals.length, modalCount)
  const reopened = await harness.open()
  reopened.onToggleRecord()
  harness.authorizations.at(-1).success()
  assert.equal(harness.controls.starts, 1)
})
