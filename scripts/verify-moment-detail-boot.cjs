const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const files = ['app.ts', 'services/session.ts', 'services/page-boot.ts', 'pages/moment-detail/moment-detail.ts']
const sources = new Map(files.map(file => [file, ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText]))
const flush = () => new Promise(resolve => setImmediate(resolve))
const ready = { status: 'ready', openid: 'partner', role: 'B', couple: { id: 'test-space' } }
const route = { id: 'test-moment', tag: 'travel' }
const neighbors = { prevId: null, nextId: 'next-moment', index: 1, total: 2 }

function mount({ cached = null, getNeighbors = async () => neighbors } = {}) {
  const requests = []
  const redirects = []
  const detailReads = []
  const neighborReads = []
  const patches = []
  const storage = new Map(cached ? [['OURS_SESSION_V1', cached]] : [])
  let bootWaits = 0
  let app, page
  const wx = {
    cloud: { init() {} },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    reLaunch: ({ url }) => redirects.push(url),
    showModal() {},
    showToast() {},
  }
  function load(file, modules, globals = {}) {
    const exports = {}
    vm.runInNewContext(sources.get(file), {
      exports, wx, ...globals,
      require(id) {
        assert.ok(Object.hasOwn(modules, id), `Unexpected dependency ${id} in ${file}`)
        return modules[id]
      },
    }, { filename: file })
    return exports
  }
  const session = load('services/session.ts', {
    './cloud-api': {
      callOurs(action) {
        assert.equal(action, 'bootstrap')
        return new Promise((resolve, reject) => requests.push({ resolve, reject }))
      },
    },
  })
  const appModule = load('app.ts', {
    './config/env': { CLOUD_ENV_ID: 'local-stub' },
    './services/session': session,
    './services/theme': { applyThemeChrome() {} },
    './services/upload-cleanup': { async retryUploadCleanup() {} },
  }, {
    App(definition) { app = definition },
    getApp: () => app,
    getCurrentPages: () => [{ route: 'pages/moment-detail/moment-detail' }],
  })
  const waitBoot = app.waitBoot.bind(app)
  app.waitBoot = () => {
    bootWaits++
    return waitBoot()
  }
  const pageBoot = load('services/page-boot.ts', { '../app': appModule, './session': session })
  load('pages/moment-detail/moment-detail.ts', {
    '../../app': appModule,
    '../../services/page-boot': pageBoot,
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/store': {
      getIdentity: () => ({ role: session.requireSession().role }),
      async getMoment(id) {
        detailReads.push(id)
        return { id, content: '正文', authorRole: 'B', images: [], createdAt: 1767225600000 }
      },
      listComments: async () => [],
      getMomentLikes: async () => ({ count: 1, likedByB: true }),
      getMomentNeighbors(id, tag) {
        neighborReads.push([id, tag])
        return getNeighbors()
      },
    },
    '../../services/format': { formatSlate: () => ({ md: '', dow: '' }) },
    '../../utils/moment-time': { momentDisplayAt: moment => moment.createdAt, isBackdatedMoment: () => false },
    '../../utils/tags': { tagLabel: () => '' },
    '../../services/moments-list-state': {},
    '../../utils/cloud-url-cache': {},
  }, { Page(definition) { page = definition } })
  page.setData = patch => { patches.push(patch); Object.assign(page.data, patch) }
  function takeBootstrap() {
    assert.equal(requests.length, 1, 'expected exactly one pending session request')
    return requests.shift()
  }
  function launch() {
    app.onLaunch({})
    return takeBootstrap()
  }
  return { page, session, requests, redirects, detailReads, neighborReads, patches, launch, takeBootstrap, bootWaits: () => bootWaits }
}

for (const retry of ['onShow', 'onRetry']) {
  test(`首次断网且没有缓存后，${retry} 用原路由恢复详情`, async () => {
    const f = mount()
    const boot = f.launch()
    const opening = f.page.onLoad(route)
    const firstShow = f.page.onShow()
    assert.equal(f.session.getSession(), null)
    boot.reject(new Error('app boot offline'))
    await flush()
    f.takeBootstrap().reject(new Error('first page session check offline'))
    await Promise.all([opening, firstShow])

    assert.equal(f.page.data.loading, false, 'offline startup must leave the skeleton')
    assert.match(f.page.data.loadError, /连不上/)
    assert.equal(f.page.momentId, route.id)
    assert.deepEqual(f.detailReads, [])
    assert.deepEqual(f.redirects, [])
    assert.equal(f.bootWaits(), 1)

    const recovery = f.page[retry]()
    await flush()
    f.takeBootstrap().resolve(ready)
    await recovery
    assert.equal(f.page.data.loading, false)
    assert.equal(f.page.data.loadError, '')
    assert.equal(f.page.data.item.id, route.id)
    assert.equal(f.page.data.item.author, '我')
    assert.equal(f.page.data.liked, true)
    assert.deepEqual(f.detailReads, [route.id])
    assert.deepEqual(f.neighborReads, [[route.id, route.tag]])
    assert.equal(f.bootWaits(), 2)
    assert.deepEqual(f.redirects, [])
  })
}

test('首次 onLoad 与 onShow 共享检查，互动请求未结束时也只加载一次', async () => {
  let finishNeighbors
  const pendingNeighbors = new Promise(resolve => { finishNeighbors = resolve })
  const f = mount({ getNeighbors: () => pendingNeighbors })
  const boot = f.launch()
  const opening = f.page.onLoad(route)
  const firstShow = f.page.onShow()
  assert.deepEqual(f.detailReads, [])
  boot.resolve(ready)
  await flush()
  assert.equal(f.page.data.found, true)
  assert.equal(f.page.data.loading, false)
  const showingDuringLoad = f.page.onShow()
  const retryDuringLoad = f.page.onRetry()
  await flush()
  assert.equal(f.bootWaits(), 1)
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.detailReads, [route.id])
  assert.deepEqual(f.neighborReads, [[route.id, route.tag]])
  finishNeighbors(neighbors)
  await Promise.all([opening, firstShow, showingDuringLoad, retryDuringLoad])

  f.page.onHide()
  await f.page.onShow()
  assert.deepEqual(f.detailReads, [route.id, route.id])
  assert.equal(f.bootWaits(), 1)
})

test('会话明确被撤销后跳转激活页，后续 onShow 和重试均不重新检查', async () => {
  const f = mount()
  f.launch().reject(new Error('app boot offline'))
  const opening = f.page.onLoad(route)
  await flush()
  f.takeBootstrap().resolve({ status: 'revoked', openid: ready.openid })
  await opening
  assert.deepEqual(f.redirects, ['/pages/setup/setup'])
  assert.equal(f.page.data.loadError, '')
  await f.page.onShow()
  await f.page.onRetry()
  assert.equal(f.bootWaits(), 1)
  assert.deepEqual(f.detailReads, [])
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.redirects, ['/pages/setup/setup'])
})

test('断网时有效的 ready 缓存仍允许打开详情', async () => {
  const f = mount({ cached: { ...ready, coupleId: ready.couple.id } })
  f.launch().reject(new Error('app boot offline'))
  const opening = f.page.onLoad(route)
  await flush()
  f.takeBootstrap().reject(new Error('session check offline'))
  await opening
  assert.equal(f.page.data.item.id, route.id)
  assert.equal(f.page.data.loadError, '')
  assert.equal(f.bootWaits(), 1)
  assert.deepEqual(f.redirects, [])
})

test('检查期间卸载后，迟到的 ready 会话不读取详情或更新页面', async () => {
  const f = mount()
  f.launch().reject(new Error('app boot offline'))
  const opening = f.page.onLoad(route)
  await flush()
  const pending = f.takeBootstrap()
  f.page.onUnload()
  const patchCount = f.patches.length
  pending.resolve(ready)
  await opening
  await f.page.onShow()
  await f.page.onRetry()
  assert.equal(f.patches.length, patchCount)
  assert.deepEqual(f.detailReads, [])
  assert.deepEqual(f.requests, [])
  assert.equal(f.bootWaits(), 1)
})

test('缺少路由 id 时结束加载，显示和重试都不发起请求', async () => {
  const f = mount()
  await f.page.onLoad({ tag: route.tag })
  await f.page.onShow()
  await f.page.onRetry()
  assert.equal(f.page.data.loading, false)
  assert.equal(f.page.data.found, false)
  assert.deepEqual(f.detailReads, [])
  assert.deepEqual(f.requests, [])
  assert.equal(f.bootWaits(), 0)
})
