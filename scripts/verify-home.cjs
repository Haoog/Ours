const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '..')
const sourceDir = process.argv[2] || path.join(root, 'miniprogram/pages/home')
const markup = fs.readFileSync(path.join(sourceDir, 'home.wxml'), 'utf8')
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const homeSource = compile(path.join(sourceDir, 'home.ts'))
const sessionSource = compile(path.join(root, 'miniprogram/services/session.ts'))
const bootSource = compile(path.join(root, 'miniprogram/services/page-boot.ts'))
const mediaSource = compile(path.join(root, 'miniprogram/utils/media-url.ts'))

const couple = { id: 'fixture-space', startDate: '2026-01-10', memberA: {}, memberB: {} }
const ready = { status: 'ready', role: 'B', openid: 'fixture-user', couple }
const cached = { ...ready, coupleId: couple.id }
const moment = (id, fields = {}) => ({ id, content: id, images: [], authorRole: 'B', ...fields })
const anniversary = title => ({ title, label: '还有 3 天' })
const turn = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ initial = cached, bootstrap = async () => ready, waitBoot = async () => {},
  moments = async () => [], nextAnn = async () => null, resolveCover = async () => '' } = {}) {
  const calls = { bootstrap: 0, moments: 0, ann: 0, stop: 0 }
  const redirects = []
  const navigations = []
  const toasts = []
  const patches = []
  const wx = {
    getStorageSync: key => key === 'OURS_SESSION_V1' ? initial : null,
    setStorageSync() {}, removeStorageSync() {},
    getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 720 }),
    reLaunch: ({ url }) => redirects.push(url),
    showToast: ({ title }) => toasts.push(title),
    stopPullDownRefresh: () => { calls.stop++ },
    navigateTo: ({ url }) => navigations.push(url),
  }
  let page
  function load(source, modules) {
    const exports = {}
    vm.runInNewContext(source, {
      exports, wx, Error, Page: definition => { page = definition },
      require(id) {
        assert.ok(Object.hasOwn(modules, id), `意外的模块 ${id}`)
        return modules[id]
      },
    })
    return exports
  }
  const app = { getAppInstance: () => ({ waitBoot }) }
  const session = load(sessionSource, {
    './cloud-api': { callOurs(action) { assert.equal(action, 'bootstrap'); return bootstrap(++calls.bootstrap) } },
  })
  const boot = load(bootSource, { '../app': app, './session': session })
  const media = load(mediaSource, {
    '../services/store': {
      async resolveCloudUrl(id) {
        const url = await resolveCover(id)
        if (!url) throw new Error('媒体加载失败')
        return url
      },
    },
    './cloud-url-cache': {},
  })
  load(homeSource, {
    '../../app': app,
    '../../services/session': session,
    '../../services/page-boot': boot,
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/store': {
      getCouple: () => session.getSession()?.couple ?? null,
      getIdentity: () => session.requireSession(),
      daysBetween: () => 42,
      listMomentsRecent: limit => { assert.equal(limit, 5); return moments(++calls.moments) },
      getNextAnniversary: () => nextAnn(++calls.ann),
    },
    '../../services/format': { formatSlate: () => ({ md: '01.10', dow: '周六' }) },
    '../../utils/media-url': media,
    '../../utils/moment-time': { momentDisplayAt: () => 1 },
  })
  page.setData = values => {
    patches.push({ ...values })
    for (const [key, value] of Object.entries(values)) {
      const match = key.match(/^recent\[(\d+)\]\.cover$/)
      if (match) page.data.recent[Number(match[1])].cover = value
      else page.data[key] = value
    }
  }
  return { page, calls, redirects, navigations, toasts, patches, syncExternalSession: () => session.syncSession(true) }
}

const ids = page => Array.from(page.data.recent, row => row.id)

async function verifySharedRefresh() {
  const connection = deferred()
  const records = deferred()
  const card = deferred()
  const { page, calls } = fixture({
    bootstrap: async attempt => {
      if (attempt === 1) return connection.promise
      throw new Error('fixture offline')
    },
    moments: () => records.promise,
    nextAnn: () => card.promise,
  })
  await page.onLoad({})
  const show = page.onShow()
  await turn()
  assert.equal(page.data.days, 42, '有缓存时应该先显示在一起天数')
  connection.reject(new Error('fixture offline'))
  await turn()
  const pull = page.onPullDownRefresh()
  const secondPull = page.onPullDownRefresh()
  await turn()
  const stopBeforeRecords = calls.stop
  records.resolve([moment('fresh')])
  await turn()
  const stopBeforeAnn = calls.stop
  const recentBeforeAnn = ids(page)
  card.resolve(null)
  await Promise.all([show, pull, secondPull])
  const actual = [calls.bootstrap, calls.moments, calls.ann, stopBeforeRecords, stopBeforeAnn, calls.stop]
  console.log(`  会话/最近记录/纪念日请求=${actual.slice(0, 3).join('/')}，记录返回前/纪念日返回前/结束时停止下拉=${actual.slice(3).join('/')}`)
  assert.deepEqual(actual, [1, 1, 1, 0, 0, 1])
  assert.deepEqual(recentBeforeAnn, ['fresh'])
  assert.equal(page.data.recentLoading, false)
}

async function verifyConnectionStates() {
  let offline = true
  const { page, calls } = fixture({ initial: null, bootstrap: async () => {
    if (offline) throw new Error('fixture offline')
    return { ...ready, couple: { ...couple, memberB: null }, role: 'A' }
  } })
  await page.onLoad({})
  await page.onShow()
  const offlineState = [page.data.ready, page.data.recentError, calls.moments]
  offline = false
  await page.onRetryRecent()
  const retryState = [page.data.ready, page.data.bound, page.data.recentLoaded, page.data.recentError]

  const boot = deferred()
  const missing = fixture({ initial: null, waitBoot: () => boot.promise, bootstrap: async () => ({ status: 'needsInviteCode' }) })
  const load = missing.page.onLoad({})
  const pull = missing.page.onPullDownRefresh()
  await turn()
  const requestsBeforeBoot = missing.calls.bootstrap
  boot.resolve()
  await Promise.all([load, pull])
  const redirectState = [requestsBeforeBoot, missing.redirects[0] || '无', missing.page.data.ready, missing.calls.stop]
  console.log(`  冷启动断网=${JSON.stringify(offlineState)}，重试=${JSON.stringify(retryState)}，未激活下拉=${JSON.stringify(redirectState)}`)
  assert.deepEqual(offlineState, [false, '连接失败，请重试', 0])
  assert.deepEqual(retryState, [true, false, true, ''])
  assert.deepEqual(redirectState, [0, '/pages/setup/setup', false, 1])
  assert.match(markup, /wx:elif="{{recentError}}"[\s\S]*?bindtap="onRetryRecent"/)
}

async function verifyAnnIndependence() {
  const records = deferred()
  const { page, calls } = fixture({
    moments: () => records.promise,
    nextAnn: async () => anniversary('独立结果'),
  })
  const show = page.onShow()
  await turn()
  const early = [calls.ann, page.data.nextAnn?.title || '无']
  records.reject(new Error('fixture records offline'))
  await show
  const afterRecentError = [page.data.recentError, page.data.nextAnn?.title || '无']

  const failing = fixture({ nextAnn: async attempt => {
    if (attempt === 2) throw new Error('fixture ann offline')
    return attempt === 1 ? anniversary('上次标题') : null
  } })
  await failing.page.onShow()
  assert.equal(failing.page.data.nextAnn?.title, '上次标题')
  await failing.page.onPullDownRefresh()
  await turn()
  const failed = failing.page.data
  const failedAnn = [failed.nextAnn?.title || '无', Boolean(failed.annError), failed.recentError]
  await failing.page.onTapAnniversary()
  const recovered = [failed.nextAnn?.title || '无', Boolean(failed.annError), failing.calls.ann]
  console.log(`  记录待定=${JSON.stringify(early)}，记录失败=${JSON.stringify(afterRecentError)}，纪念日失败=${JSON.stringify(failedAnn)}，重试=${JSON.stringify(recovered)}`)
  assert.deepEqual(early, [1, '独立结果'])
  assert.deepEqual(afterRecentError, ['fixture records offline', '独立结果'])
  assert.deepEqual(failedAnn, ['上次标题', true, ''])
  assert.deepEqual(recovered, ['无', false, 3])
  assert.match(markup, /wx:if="{{nextAnn \|\| annError}}" bindtap="onTapAnniversary"/)
  assert.match(markup, /wx:if="{{annError}}"[^>]*>[^<]*显示上次结果[^<]*点击重试<\/text>\s*<text wx:else[^>]*>{{nextAnn.label}}/)

  const firstFailure = fixture({ nextAnn: async () => { throw new Error('fixture ann offline') } })
  await firstFailure.page.onShow()
  assert.equal(firstFailure.page.data.nextAnn, null)
  assert.equal(firstFailure.page.data.annError, true)
  assert.equal(firstFailure.page.data.recentLoaded, true)
}

async function verifyLateAnn() {
  const oldAnn = deferred()
  const { page } = fixture({ nextAnn: attempt => attempt === 1 ? oldAnn.promise : Promise.resolve(anniversary('新结果')) })
  const previous = page.onShow()
  await turn()
  page.onHide?.()
  const revisiting = page.onShow()
  await turn()
  const before = page.data.nextAnn?.title
  oldAnn.resolve(anniversary('迟到旧结果'))
  await Promise.all([previous, revisiting])
  console.log(`  返回首页后的纪念日=${before}，旧请求完成后=${page.data.nextAnn?.title}`)
  assert.equal(before, '新结果')
  assert.equal(page.data.nextAnn?.title, '新结果')
}

async function verifyCoverFailure() {
  const { page, toasts, navigations } = fixture({
    moments: async () => [
      moment('broken-video', { videoCover: 'cloud://missing', videos: ['fixture-video'], authorRole: 'A' }),
      moment('healthy', { images: ['cloud://ok'] }),
      moment('text-only'),
    ],
    resolveCover: async id => id === 'cloud://ok' ? '/fixture-cover.jpg' : '',
    nextAnn: async () => anniversary('正常纪念日'),
  })
  await page.onLoad({})
  await page.onShow()
  // 摘要刷新结束后，独立的封面回填也完成再检查媒体展示。
  await turn()
  console.log(`  最近记录=${JSON.stringify(ids(page))}，列表错误=${JSON.stringify(page.data.recentError)}，提示=${JSON.stringify(toasts)}`)
  assert.deepEqual(ids(page), ['broken-video', 'healthy', 'text-only'])
  assert.deepEqual(Array.from(page.data.recent, row => [row.cover, row.hasVideo, row.authorLabel]), [
    ['', true, 'TA'], ['/fixture-cover.jpg', false, '我'], ['', false, '我'],
  ])
  assert.equal(page.data.recentError, '')
  assert.equal(page.data.recentLoading, false)
  assert.equal(page.data.recentLoaded, true)
  assert.deepEqual(toasts, [])
  page.onTapMoment({ currentTarget: { dataset: { id: 'healthy' } } })
  page.onTapAnniversary()
  assert.deepEqual(navigations, ['/pages/moment-detail/moment-detail?id=healthy', '/subpages/anniversaries/anniversaries'])
}

async function verifyProgressiveCovers() {
  const records = deferred()
  const slow = deferred()
  const fast = deferred()
  const failed = deferred()
  const { page, calls, patches, toasts, syncExternalSession } = fixture({
    moments: () => records.promise,
    resolveCover: id => ({ 'cloud://slow': slow, 'cloud://fast': fast, 'cloud://failed': failed })[id].promise,
  })
  await page.onLoad({})
  const pull = page.onPullDownRefresh()
  await turn()
  records.resolve([
    moment('slow', { content: '长途旅行', images: ['cloud://slow'], videos: ['fixture-video'] }),
    moment('fast', { livePhotos: [{ cover: 'cloud://fast' }] }),
    moment('failed', { images: ['cloud://failed'] }),
    moment('text'),
  ])
  await turn()
  console.log(`  封面全部待定时的摘要=${JSON.stringify(ids(page))}，结束下拉=${calls.stop}`)
  assert.deepEqual(ids(page), ['slow', 'fast', 'failed', 'text'])
  assert.equal(page.data.recentLoaded, true)
  assert.equal(page.data.recentLoading, false)
  assert.equal(calls.stop, 1)
  await pull
  const recent = page.data.recent
  assert.deepEqual(Array.from(recent, row => [row.caption, row.mediaTag, row.hasVideo, row.cover]), [
    ['长途旅行', '1图·视频', true, ''], ['fast', '1实况', false, ''], ['failed', '1图', false, ''], ['text', '', false, ''],
  ])
  assert.equal(patches.filter(patch => Object.hasOwn(patch, 'recent')).length, 1)
  const patchStart = patches.length
  await syncExternalSession()
  fast.resolve('/fast.jpg')
  await turn()
  assert.deepEqual(patches.slice(patchStart), [{ 'recent[1].cover': '/fast.jpg' }])
  assert.equal(recent[0].cover, '')
  assert.equal(recent[1].cover, '/fast.jpg')
  failed.resolve('')
  await turn()
  assert.equal(patches.length, patchStart + 1)
  assert.equal(recent[2].cover, '')
  slow.resolve('/slow.jpg')
  await turn()
  assert.deepEqual(patches.slice(patchStart), [{ 'recent[1].cover': '/fast.jpg' }, { 'recent[0].cover': '/slow.jpg' }])
  assert.equal(page.data.recent, recent)
  assert.equal(page.data.recentError, '')
  assert.deepEqual(toasts, [])
  assert.match(markup, /wx:key="id"/)
  assert.match(markup, /class="recent-card__media-badge">{{item.mediaTag}}/)
}

async function verifyLateRecent() {
  for (const fails of [false, true]) {
    const older = deferred()
    const coverRequests = []
    const { page, patches, toasts } = fixture({
      moments: attempt => attempt === 1 ? older.promise : Promise.resolve([moment('new-summary')]),
      resolveCover: async id => { coverRequests.push(id); return '/unexpected.jpg' },
    })
    await page.onLoad({})
    const first = page.onShow()
    await turn()
    page.onHide()
    const second = page.onShow()
    await turn()
    assert.deepEqual(ids(page), ['new-summary'])
    const count = patches.length
    if (fails) older.reject(new Error('迟到列表错误'))
    else older.resolve([moment('old-summary', { images: ['cloud://old'] })])
    await Promise.all([first, second])
    assert.equal(patches.length, count)
    assert.deepEqual(ids(page), ['new-summary'])
    assert.deepEqual(coverRequests, [])
    assert.deepEqual(toasts, [])
  }
}

async function verifyReorderedList(returnToPage) {
  const oldCover = deferred()
  const removedCover = deferred()
  const newCover = deferred()
  const reordered = deferred()
  const { page, calls, patches } = fixture({
    moments: async attempt => attempt === 1 ? [
      moment('shared', { images: ['cloud://old'] }),
      moment('removed', { images: ['cloud://removed'] }),
    ] : reordered.promise,
    resolveCover: id => ({ 'cloud://old': oldCover, 'cloud://removed': removedCover, 'cloud://new': newCover })[id].promise,
  })
  await page.onLoad({})
  const show = page.onShow()
  await turn()
  assert.deepEqual(ids(page), ['shared', 'removed'])
  assert.equal(page.data.recentLoading, false)
  await show
  if (returnToPage) page.onHide()
  const refresh = returnToPage ? page.onShow() : page.onPullDownRefresh()
  await turn()
  assert.equal(calls.moments, 2)
  assert.deepEqual(ids(page), ['shared', 'removed'], '同一账号刷新期间保留上次摘要')
  assert.equal(page.data.ready, true)
  reordered.resolve([moment('inserted'), moment('shared', { images: ['cloud://new'] })])
  await turn()
  assert.deepEqual(ids(page), ['inserted', 'shared'])
  assert.equal(page.data.recentLoading, false)
  await refresh
  const patchStart = patches.length
  newCover.resolve('/new.jpg')
  await turn()
  oldCover.resolve('/obsolete.jpg')
  removedCover.resolve('/removed.jpg')
  await turn()
  assert.deepEqual(patches.slice(patchStart), [{ 'recent[1].cover': '/new.jpg' }])
  assert.deepEqual(Array.from(page.data.recent, row => row.cover), ['', '/new.jpg'])
}

async function verifyAccountChangeWhileLoadingRecent() {
  const oldRecords = deferred()
  const oldAnn = deferred()
  const other = { ...ready, openid: 'other-user', role: 'A' }
  let server = ready
  const { page, patches, toasts, syncExternalSession } = fixture({
    bootstrap: async () => server,
    moments: attempt => attempt === 1 ? oldRecords.promise : Promise.resolve([moment('other-record')]),
    nextAnn: attempt => attempt === 1 ? oldAnn.promise : Promise.resolve(null),
  })
  await page.onLoad({})
  const first = page.onShow()
  await turn()
  server = other
  await syncExternalSession()
  oldRecords.resolve([moment('wrong-account')])
  oldAnn.resolve(anniversary('旧账号纪念日'))
  await first
  assert.equal(page.data.recentLoaded, false)
  assert.equal(page.data.nextAnn, null)
  assert.equal(page.data.ready, false)
  assert.ok(patches.every(patch => !patch.recent?.some(row => row.id === 'wrong-account')))
  assert.deepEqual(toasts, [])
  await page.onShow()
  assert.deepEqual(ids(page), ['other-record'])
  assert.equal(page.data.recent[0].authorLabel, 'TA')
}

async function verifyCoverAccountBoundaries() {
  const atSwitch = deferred()
  const afterReturn = deferred()
  const otherCover = deferred()
  let server = ready
  const { page, patches, calls, redirects, syncExternalSession } = fixture({
    bootstrap: async () => server,
    moments: async attempt => {
      if (attempt === 1) return [
        moment('shared', { images: ['cloud://old-account'] }),
        moment('extra', { images: ['cloud://at-switch'] }),
      ]
      if (attempt === 2) return [moment('shared', { images: ['cloud://other'] })]
      return [moment('shared', { images: ['/current.jpg'] })]
    },
    nextAnn: async attempt => anniversary(`纪念日 ${attempt}`),
    resolveCover: id => ({ 'cloud://old-account': afterReturn, 'cloud://at-switch': atSwitch, 'cloud://other': otherCover })[id].promise,
  })
  await page.onLoad({})
  const initialShow = page.onShow()
  await turn()
  assert.deepEqual(ids(page), ['shared', 'extra'])
  assert.equal(page.data.recentLoading, false)
  await initialShow
  server = { ...ready, openid: 'other-user' }
  await syncExternalSession()
  const switchStart = patches.length
  atSwitch.resolve('/wrong-account.jpg')
  await turn()
  assert.ok(patches.slice(switchStart).every(patch => !Object.hasOwn(patch, 'recent[1].cover')))
  assert.deepEqual(ids(page), [])
  assert.equal(page.data.nextAnn, null)
  const otherShow = page.onShow()
  await turn()
  assert.deepEqual(ids(page), ['shared'])
  assert.equal(page.data.recentLoading, false)
  await otherShow

  page.onHide()
  server = { status: 'needsInviteCode', openid: '' }
  await syncExternalSession()
  const missing = page.onShow()
  assert.equal(page.data.ready, false)
  assert.deepEqual(ids(page), [])
  await missing
  assert.deepEqual(redirects, ['/pages/setup/setup'])
  assert.equal(calls.moments, 2)
  otherCover.resolve('/other-account.jpg')
  await turn()
  assert.deepEqual(ids(page), [])

  page.onHide()
  server = ready
  await syncExternalSession()
  await page.onShow()
  await turn()
  const patchStart = patches.length
  afterReturn.resolve('/obsolete-account.jpg')
  await turn()
  assert.equal(patches.length, patchStart)
  assert.equal(page.data.recent[0].cover, '/current.jpg')
}

async function verifySessionRoundTripWithoutPageEvent() {
  const oldCover = deferred()
  let server = ready
  const { page, patches, syncExternalSession } = fixture({
    bootstrap: async () => server,
    moments: async attempt => [moment('same-id', { images: [attempt === 1 ? 'cloud://old' : '/current.jpg'] })],
    resolveCover: () => oldCover.promise,
  })
  await page.onLoad({})
  const show = page.onShow()
  await turn()
  assert.deepEqual(ids(page), ['same-id'])
  assert.equal(page.data.recentLoading, false)
  await show
  server = { status: 'needsInviteCode', openid: '' }
  await syncExternalSession()
  server = ready
  await syncExternalSession()
  const patchStart = patches.length
  oldCover.resolve('/obsolete.jpg')
  await turn()
  assert.equal(page.data.recent[0].cover, '')
  assert.ok(patches.slice(patchStart).every(patch => !Object.hasOwn(patch, 'recent[0].cover')))
  await page.onPullDownRefresh()
  await turn()
  assert.equal(page.data.recent[0].cover, '/current.jpg')
}

async function main() {
  const checks = [
    ['刷新合并及下拉指示', verifySharedRefresh],
    ['冷启动断网、恢复及未激活跳转', verifyConnectionStates],
    ['纪念日独立加载、失败和重试', verifyAnnIndependence],
    ['返回首页后忽略迟到的旧纪念日', verifyLateAnn],
    ['单个封面失败仍展示最近记录', verifyCoverFailure],
    ['封面待定时先展示摘要，再逐条更新封面', verifyProgressiveCovers],
    ['旧列表成功或失败均不再回写', verifyLateRecent],
    ['同账号返回保留摘要，列表重排后忽略旧封面', () => verifyReorderedList(true)],
    ['同页下拉后忽略已换位或移除记录的旧封面', () => verifyReorderedList(false)],
    ['账号切换时丢弃旧列表和旧纪念日', verifyAccountChangeWhileLoadingRecent],
    ['账号切换、无账号和切回时隔离旧封面', verifyCoverAccountBoundaries],
    ['会话退出又恢复时，即使页面未重进也忽略旧封面', verifySessionRoundTripWithoutPageEvent],
  ]
  let failures = 0
  for (const [name, verify] of checks) {
    try {
      await verify()
      console.log(`PASS ${name}`)
    } catch (error) {
      failures++
      console.error(`FAIL ${name}\n${error.message}`)
    }
  }
  console.log(`首页离线验证 ${checks.length - failures}/${checks.length} 通过`)
  if (failures) process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
