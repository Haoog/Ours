const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const ts = require('../node_modules/typescript')

function pageFactory(file, modules, wx) {
  let definition
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const fallback = new Proxy({}, { get: () => () => undefined })
  vm.runInNewContext(source, { require: id => modules[id] || fallback, exports: {}, Page: value => { definition = value }, wx, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, Number, Error })
  return () => ({
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(values, cb) { Object.assign(this.data, values); if (cb) cb() },
  })
}

function page(file, modules, wx) {
  return pageFactory(file, modules, wx)()
}
const theme = { getThemeStyle: () => '', syncTheme() {} }

function sessionHarness() {
  const requests = []
  const storage = new Map()
  const redirects = []
  const tabSwitches = []
  const timers = []
  const key = 'OURS_SESSION_V1'
  let now = 100000
  const wx = {
    cloud: { init() {} },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    reLaunch: ({ url }) => redirects.push(url),
    switchTab: ({ url }) => tabSwitches.push(url),
    showToast() {},
    showLoading() {},
    hideLoading() {},
  }
  const load = (file, modules, globals = {}) => {
    const exports = {}
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
    vm.runInNewContext(source, { require: id => modules[id], exports, wx, Error, Date: { now: () => now }, ...globals })
    return exports
  }
  const cloud = {
    callOurs(action, input) {
      return new Promise((resolve, reject) => requests.push({ action, input, resolve, reject }))
    },
  }
  const loadSession = () => load('miniprogram/services/session.ts', { './cloud-api': cloud })
  const session = loadSession()
  let app
  load('miniprogram/app.ts', {
    './config/env': {}, './services/session': session,
    './services/theme': { applyThemeChrome() {} },
    './services/upload-cleanup': { retryUploadCleanup() {} },
  }, { App: definition => { app = definition }, getCurrentPages: () => [{ route: 'pages/home/home' }] })
  const getAppInstance = () => app
  const { ensureCloudReady } = load('miniprogram/services/page-boot.ts', {
    '../app': { getAppInstance }, './session': session,
  })
  const store = load('miniprogram/services/store.ts', {
    './cloud-api': cloud, './session': session, './date': {},
  })
  let setup
  load('miniprogram/pages/setup/setup.ts', {
    '../../services/store': store, '../../services/session': session,
    '../../app': { getAppInstance }, '../../services/theme': theme,
  }, { Page: definition => { setup = definition }, Date, setTimeout: callback => timers.push(callback) })
  setup.setData = values => Object.assign(setup.data, values)
  const take = action => {
    const request = requests.shift()
    assert.strictEqual(request?.action, action)
    return request
  }
  return { session, app, setup, ensureCloudReady, storage, key, redirects, tabSwitches, timers, take, requests, loadSession, advance: ms => { now += ms } }
}

async function verifyInviteArrivingDuringBoot() {
  const { app, session, requests, take, redirects } = sessionHarness()
  app.onLaunch({})
  const initial = take('bootstrap')
  const old = app.onShow({ query: { inviteToken: 'earlier-invite' } })
  const latest = app.onShow({ query: { inviteToken: 'latest-invite' } })
  assert.equal(requests.length, 0)
  initial.resolve({ status: 'needsInviteCode', openid: 'user' })
  await new Promise(resolve => setImmediate(resolve))
  const joining = take('bootstrap')
  assert.equal(joining.input.inviteToken, 'latest-invite')
  assert.deepEqual(redirects, [])
  let pageCanBoot = false
  const pageWait = app.waitBoot().then(() => { pageCanBoot = true })
  await Promise.resolve()
  assert.equal(pageCanBoot, false)
  const duplicate = app.onShow({ query: { inviteToken: 'latest-invite' } })
  assert.equal(requests.length, 0)
  joining.resolve({ status: 'ready', openid: 'user', role: 'B', couple: { id: 'space' } })
  await Promise.all([old, latest, duplicate, pageWait])
  assert.equal(session.getSession().role, 'B')
  assert.deepEqual(redirects, ['/pages/home/home'])

  const cold = sessionHarness()
  const options = { query: { inviteToken: 'cold-invite' } }
  cold.app.onLaunch(options)
  cold.app.onShow(options)
  const direct = cold.take('bootstrap')
  assert.equal(direct.input.inviteToken, 'cold-invite')
  assert.equal(cold.requests.length, 0)
  direct.resolve({ status: 'ready', openid: 'user', role: 'B', couple: { id: 'space' } })
  await cold.app.waitBoot()
  assert.equal(cold.session.getSession().role, 'B')
  assert.deepEqual(cold.redirects, [])
}

async function verifySessionActivation() {
  const invite = { code: 'activation-code', nickname: 'A', startDate: '2026-01-01' }
  const couple = { id: 'space', memberA: { openid: 'user' } }
  const needsInvite = { status: 'needsInviteCode', openid: 'user' }
  const { session, app, setup, ensureCloudReady, storage, key, redirects, tabSwitches, timers, take, requests, loadSession, advance } = sessionHarness()
  assert.strictEqual(session.getSession(), null)
  app.onLaunch({})
  const boot = take('bootstrap')
  assert.strictEqual(boot.input.inviteToken, '')
  const setupLoad = setup.onLoad()
  const staleSync = session.syncSession()
  const staleQuery = take('bootstrap')
  assert.strictEqual(session.syncSession(true), staleSync)

  assert.strictEqual(session.createCoupleAndCache, session.redeemAccessCodeAndCache)
  setup.setData({ accessCode: invite.code, nickname: invite.nickname, startDate: invite.startDate })
  const activation = setup.onSubmit()
  const redemption = take('redeemAccessCode')
  assert.strictEqual(redemption.input.code, invite.code)
  redemption.resolve(couple)
  await activation
  const ready = session.requireSession()
  assert.strictEqual(ready.status, 'ready')
  assert.strictEqual(session.coupleId(), couple.id)
  const coldSession = loadSession()
  assert.strictEqual(coldSession.getSession().coupleId, couple.id)
  const coldRefresh = coldSession.syncSession()
  take('bootstrap').resolve({ status: 'ready', openid: 'user', couple })
  assert.strictEqual((await coldRefresh).coupleId, couple.id)

  boot.resolve(needsInvite)
  await setupLoad
  assert.strictEqual(app.globalData.booted, true)
  assert.deepStrictEqual(redirects, [])
  assert.strictEqual(timers.length, 1)
  timers.shift()()
  assert.deepStrictEqual(tabSwitches, ['/pages/home/home'])
  const guard = ensureCloudReady()
  await Promise.resolve()
  assert.strictEqual(requests.length, 0)
  assert.strictEqual(await guard, true)

  const forced = session.syncSession(true)
  const currentQuery = take('bootstrap')
  staleQuery.resolve(needsInvite)
  assert.strictEqual(await staleSync, ready)
  assert.strictEqual(session.getSession(), ready)
  assert.strictEqual(storage.get(key).status, 'ready')
  assert.strictEqual(session.syncSession(), forced)
  currentQuery.resolve({ status: 'revoked', openid: 'user' })
  const revoked = await forced
  assert.strictEqual(revoked.status, 'revoked')
  assert.strictEqual(await session.syncSession(), revoked)
  assert.strictEqual(storage.has(key), false)
  assert.strictEqual(loadSession().getSession(), null)
  const revokedGuard = ensureCloudReady()
  await Promise.resolve()
  assert.strictEqual(requests.length, 0)
  assert.strictEqual(await revokedGuard, false)
  assert.deepStrictEqual(redirects, ['/pages/setup/setup'])

  advance(15000)
  const retryable = session.syncSession()
  take('bootstrap').reject(new Error('offline'))
  await assert.rejects(retryable, /offline/)
  assert.strictEqual(session.getSession(), revoked)
  const retry = session.syncSession()
  take('bootstrap').resolve({ status: 'ready', openid: 'partner', role: 'B', couple })
  assert.strictEqual((await retry).role, 'B')

  const direct = session.bootstrapSession({ inviteToken: 'another-token', nickname: 'B', avatarUrl: 'avatar' })
  const directQuery = take('bootstrap')
  assert.strictEqual(directQuery.input.inviteToken, 'another-token')
  assert.strictEqual(directQuery.input.nickname, 'B')
  assert.strictEqual(directQuery.input.avatarUrl, 'avatar')
  const failedActivation = session.redeemAccessCodeAndCache(invite)
  take('redeemAccessCode').reject(new Error('invalid code'))
  await assert.rejects(failedActivation, /invalid code/)
  directQuery.resolve(needsInvite)
  assert.strictEqual((await direct).status, 'needsInviteCode')
  assert.strictEqual(storage.has(key), false)
}

async function verifyMomentDetailComments() {
  const requests = []
  const modals = []
  const toasts = []
  const hold = (action, ...args) => new Promise((resolve, reject) => {
    requests.push({ action, args, resolve, reject })
  })
  const take = (action, ...args) => {
    const request = requests.shift()
    assert.strictEqual(request?.action, action)
    assert.deepStrictEqual(request.args, args)
    return request
  }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const mountDetail = pageFactory('miniprogram/pages/moment-detail/moment-detail.ts', {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/theme': theme,
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/store': {
      getIdentity: () => ({ role: 'A' }),
      getMoment: async id => ({ id, images: [], authorRole: 'A', createdAt: Date.now() }),
      listComments: id => hold('list', id),
      getMomentLikes: async () => ({ count: 0, likedByA: false }),
      getMomentNeighbors: id => hold('neighbors', id),
      addComment: (id, content) => hold('add', id, content),
      deleteComment: id => hold('delete', id),
    },
    '../../services/format': { formatSlate: () => ({ md: '', dow: '' }) },
    '../../utils/media-url': { resolveMomentImages: async () => [], resolveMomentLivePhotos: async () => [] },
  }, {
    showModal: options => modals.push(options.success),
    showToast: ({ title }) => toasts.push(title),
    vibrateShort() {},
  })
  const comment = id => ({ id, content: id, authorRole: 'A' })
  const detail = mountDetail()
  const assertComments = (...ids) => assert.deepStrictEqual(Array.from(detail.data.comments, c => c.id), ids)
  const submit = text => {
    detail.onCommentInput({ detail: { value: text } })
    return detail.onSubmitComment()
  }
  const openDelete = id => {
    detail.onDeleteComment({ currentTarget: { dataset: { id } } })
    return modals.shift()
  }
  const load = async (id, comments) => {
    await flush()
    take('list', id).resolve(comments.map(comment))
    return take('neighbors', id)
  }
  const neighbors = { prevId: 'a', nextId: 'b', index: 1, total: 2 }

  const opening = detail.onLoad({ id: 'a' })
  await flush()
  const initialComments = take('list', 'a')
  const initialNeighbors = take('neighbors', 'a')
  assert.strictEqual(detail.data.loading, false)
  const pendingStatus = detail.data.commentsStatus
  assertComments()
  const posting = submit('new')
  take('add', 'a', 'new').resolve(comment('new'))
  await posting
  assertComments('new')
  initialComments.resolve([comment('existing')])
  await flush()
  assertComments('existing', 'new')
  assert.strictEqual(pendingStatus, 'loading')
  assert.strictEqual(detail.data.commentsStatus, 'ready')
  assert.strictEqual(detail.data.nextId, '')
  initialNeighbors.resolve(neighbors)
  await opening
  assert.strictEqual(detail.data.nextId, 'b')

  const refresh = detail.onShow()
  await flush()
  const refreshComments = take('list', 'a')
  const refreshNeighbors = take('neighbors', 'a')
  assert.strictEqual(detail.data.commentsStatus, 'loading')
  assertComments('existing', 'new')
  const deleting = openDelete('existing')({ confirm: true })
  const deletion = take('delete', 'existing')
  assertComments('new')
  refreshComments.resolve([comment('existing'), comment('new')])
  await flush()
  assertComments('new')
  refreshNeighbors.resolve(neighbors)
  await refresh
  deletion.reject(new Error('delete failed'))
  await deleting
  assertComments('existing', 'new')
  assert.deepStrictEqual(toasts, ['delete failed'])

  const removing = openDelete('existing')({ confirm: true })
  const remove = take('delete', 'existing')
  const reentry = detail.onShow()
  await flush()
  const reentryComments = take('list', 'a')
  const reentryNeighbors = take('neighbors', 'a')
  remove.resolve()
  await removing
  reentryComments.resolve([comment('existing'), comment('new')])
  reentryNeighbors.resolve(neighbors)
  await reentry
  assertComments('new')

  const sendingAcrossRefresh = submit('already-listed')
  const listedAdd = take('add', 'a', 'already-listed')
  const superseded = detail.onShow()
  await flush()
  const staleComments = take('list', 'a')
  const staleNeighbors = take('neighbors', 'a')
  const latest = detail.onShow()
  const latestNeighbors = await load('a', ['new', 'already-listed'])
  latestNeighbors.resolve(neighbors)
  await latest
  listedAdd.resolve(comment('already-listed'))
  await sendingAcrossRefresh
  staleComments.resolve([comment('existing'), comment('new')])
  staleNeighbors.resolve(neighbors)
  await superseded
  assertComments('new', 'already-listed')

  const delayedPosting = submit('deleted-before-response')
  const delayedAdd = take('add', 'a', 'deleted-before-response')
  const visibleBeforeResponse = detail.onShow()
  const visibleNeighbors = await load('a', ['new', 'already-listed', 'deleted-before-response'])
  visibleNeighbors.resolve(neighbors)
  await visibleBeforeResponse
  const earlyDelete = openDelete('deleted-before-response')({ confirm: true })
  take('delete', 'deleted-before-response').resolve()
  await earlyDelete
  delayedAdd.resolve(comment('deleted-before-response'))
  await delayedPosting
  assertComments('new', 'already-listed')

  const staleConfirm = openDelete('new')
  const staleDeleting = openDelete('already-listed')({ confirm: true })
  const staleDelete = take('delete', 'already-listed')
  const stalePosting = submit('late')
  const staleAdd = take('add', 'a', 'late')
  detail.onTapNext()
  const nextNeighbors = await load('b', [])
  nextNeighbors.resolve(neighbors)
  await flush()
  assert.strictEqual(detail.data.commentDraft, '')
  assert.strictEqual(detail.data.commentSubmitting, false)

  detail.onTapPrev()
  const previousNeighbors = await load('a', ['new'])
  previousNeighbors.resolve(neighbors)
  await flush()
  await staleConfirm({ confirm: true })
  staleDelete.reject(new Error('old detail delete failed'))
  await staleDeleting
  const freshPosting = submit('fresh')
  const freshAdd = take('add', 'a', 'fresh')
  staleAdd.resolve(comment('late'))
  await stalePosting
  assertComments('new')
  assert.strictEqual(detail.data.commentSubmitting, true)
  assert.strictEqual(detail.data.commentDraft, 'fresh')
  detail.onUnload()
  freshAdd.reject(new Error('late send failure'))
  await freshPosting
  assert.deepStrictEqual(toasts, ['delete failed'])
  assert.strictEqual(requests.length, 0)

  const fresh = mountDetail()
  const firstRead = fresh.onLoad({ id: 'a' })
  await flush()
  const failedComments = take('list', 'a')
  const deferredNeighbors = take('neighbors', 'a')
  assert.strictEqual(fresh.data.commentsStatus, 'loading')
  failedComments.reject(new Error('comments offline'))
  await flush()
  assert.strictEqual(fresh.data.commentsStatus, 'error')
  assert.strictEqual(fresh.data.interactionError, '')
  assert.strictEqual(fresh.data.comments.length, 0)
  const retry = fresh.onRetryComments()
  void fresh.onRetryComments()
  assert.strictEqual(fresh.data.commentsStatus, 'loading')
  take('list', 'a').resolve([])
  await retry
  assert.strictEqual(fresh.data.commentsStatus, 'empty')
  assert.strictEqual(fresh.data.comments.length, 0)
  assert.strictEqual(requests.length, 0)
  deferredNeighbors.resolve(neighbors)
  await firstRead

  const populated = fresh.onShow()
  const populatedNeighbors = await load('a', ['retained'])
  populatedNeighbors.resolve(neighbors)
  await populated
  const failedRefresh = fresh.onShow()
  await flush()
  const failedRefreshComments = take('list', 'a')
  const failedRefreshNeighbors = take('neighbors', 'a')
  assert.strictEqual(fresh.data.comments[0]?.id, 'retained')
  failedRefreshComments.reject(new Error('refresh offline'))
  await flush()
  assert.strictEqual(fresh.data.commentsStatus, 'error')
  assert.strictEqual(fresh.data.comments[0]?.id, 'retained')
  failedRefreshNeighbors.resolve(neighbors)
  await failedRefresh

  const refreshAfterFailure = fresh.onRetryComments()
  take('list', 'a').resolve([comment('retained')])
  await refreshAfterFailure
  fresh.onDeleteComment({ currentTarget: { dataset: { id: 'retained' } } })
  const deleteLast = modals.shift()({ confirm: true })
  assert.strictEqual(fresh.data.comments.length, 0)
  assert.strictEqual(fresh.data.commentsStatus, 'ready')
  take('delete', 'retained').resolve()
  await deleteLast
  assert.strictEqual(fresh.data.commentsStatus, 'empty')
}

async function verifyMapSelection() {
  const requests = []
  const contexts = []
  const tabs = []
  const stories = []
  const toasts = []
  const locationQueries = []
  let pullStops = 0
  let pendingContext = null
  const listState = {
    openMomentsContext(context) {
      pendingContext = { ...context }
      contexts.push(pendingContext)
    },
    takeMomentsContext() {
      const context = pendingContext
      pendingContext = null
      return context
    },
    consumeMomentsListStale: () => false,
    peekMomentsListStale: () => false,
    consumeMomentsScrollTop: () => 0,
  }
  const mapTheme = { ...theme, getThemeId: () => '' }
  const newMap = pageFactory('miniprogram/subpages/map/map.ts', {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/theme': mapTheme,
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/session': { getSession: () => ({ coupleId: 'space' }) },
    '../../services/store': {
      listMapPlaces: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    },
    '../../services/moments-list-state': listState,
  }, {
    switchTab: ({ url }) => tabs.push(url),
    navigateTo: ({ url }) => stories.push(url),
    showToast: ({ title }) => toasts.push(title),
    stopPullDownRefresh: () => { pullStops++ },
  })
  const moments = page('miniprogram/pages/moments/moments.ts', {
    '../../services/theme': mapTheme,
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/moments-list-state': listState,
    '../../services/store': {
      listMomentsPage: async ({ locationKey }) => {
        locationQueries.push(locationKey)
        return { items: [], total: 0, hasMore: false }
      },
      getIdentity: () => ({ role: 'A' }),
      getCouple: () => ({ startDate: '2026-01-01' }),
      getMomentsBriefStats: async () => ({ total: 0 }),
    },
    '../../utils/moments-timeline': { buildTimelineRows: () => [] },
  }, { showToast: ({ title }) => toasts.push(title) })
  const take = async () => {
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(requests.length, 1)
    return requests.shift()
  }
  const result = (...places) => ({ places, cities: places.length ? [{ name: '杭州', count: places.length }] : [] })
  const a = { id: 'a', name: '第一站', momentCount: 1 }
  const b = { id: 'b', name: '第二站', momentCount: 2, latestMomentId: 'b-old' }
  const c = { id: 'c', name: '第三站', momentCount: 1 }
  const updatedB = { ...b, name: '第二站新名称', latestMomentId: 'b-new', latestMomentContent: '刚更新的故事' }
  const tap = (map, id) => map.onTapPlace({ currentTarget: { dataset: { id } } })
  const selectMarker = (map, id) => map.onSelectMapPlace({ detail: { id } })
  const assertSelected = (map, place) => {
    assert.strictEqual(map.data.selectedPlaceId, place.id)
    assert.strictEqual(map.data.selectedPlace, map.data.places.find(item => item.id === place.id))
    assert.strictEqual(map.data.selectedPlace.name, place.name)
  }
  const show = async (map, ...places) => {
    const showing = map.onShow()
    const request = await take()
    request.resolve(result(...places))
    await showing
  }

  let map = newMap()
  map.onLoad()
  await show(map, a, b, c)
  assertSelected(map, a)
  tap(map, b.id)
  map.onTapStory()
  assert.deepStrictEqual(stories, ['/pages/moment-detail/moment-detail?id=b-old'])
  await show(map, c, a, updatedB)
  assertSelected(map, updatedB)
  assert.strictEqual(map.data.selectedPlace.latestContent, updatedB.latestMomentContent)
  map.onTapStory()
  assert.strictEqual(stories.at(-1), '/pages/moment-detail/moment-detail?id=b-new')
  const leaving = map.onShow()
  const unloadedRequest = await take()
  const beforeUnload = map.onShow()
  const beforeUnloadRequest = await take()
  map.onOpenPlace()
  assert.deepStrictEqual(contexts, [{ locationKey: b.id, label: updatedB.name }])
  assert.deepStrictEqual(tabs, ['/pages/moments/moments'])
  beforeUnloadRequest.resolve(result(a, updatedB, c))
  await beforeUnload
  const oldMap = map
  oldMap.onUnload()
  await moments.onShow()
  assert.deepStrictEqual(locationQueries, [b.id])
  assert.strictEqual(moments.data.contextLabel, updatedB.name)

  map = newMap()
  map.onLoad()
  await show(map, a, updatedB, c)
  assertSelected(map, updatedB)
  unloadedRequest.reject(new Error('unloaded request'))
  await leaving
  assert.strictEqual(oldMap.data.loadError, '')
  assert.deepStrictEqual(toasts, [])
  map.onOpenPlace()
  assert.deepStrictEqual(contexts.at(-1), { locationKey: b.id, label: updatedB.name })

  const older = map.onShow()
  const olderRequest = await take()
  const pulling = map.onPullDownRefresh()
  const pullRequest = await take()
  tap(map, a.id)
  selectMarker(map, c.id)
  tap(map, 'unknown')
  assertSelected(map, c)
  olderRequest.resolve(result(a, b))
  await older
  assertSelected(map, c)
  assert.strictEqual(map.data.loading, true)
  pullRequest.resolve(result(updatedB, a, c))
  await pulling
  assertSelected(map, c)
  assert.strictEqual(map.data.loading, false)
  assert.strictEqual(pullStops, 1)
  map.onOpenPlace()
  assert.deepStrictEqual(contexts.at(-1), { locationKey: c.id, label: c.name })

  const late = map.onShow()
  const lateRequest = await take()
  await show(map, updatedB, a)
  assertSelected(map, updatedB)
  lateRequest.reject(new Error('superseded request'))
  await late
  assert.strictEqual(map.data.loadError, '')
  assert.strictEqual(map.data.loading, false)
  assert.deepStrictEqual(toasts, [])
  map.onOpenPlace()
  assert.deepStrictEqual(contexts.at(-1), { locationKey: b.id, label: updatedB.name })

  await show(map)
  assert.strictEqual(map.data.empty, true)
  assert.strictEqual(map.data.selectedPlaceId, '')
  assert.strictEqual(map.data.selectedPlace, null)
  const contextCount = contexts.length
  map.onOpenPlace()
  assert.strictEqual(contexts.length, contextCount)
  await show(map, a, updatedB)
  assertSelected(map, a)
}

async function main() {
  await verifySessionActivation()
  await verifyInviteArrivingDuringBoot()
  await verifyMomentDetailComments()
  await verifyMapSelection()

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
  const backup = page('miniprogram/subpages/backup/backup.ts', { '../../services/theme': theme, '../../services/session': { requireSession: () => deleteSession, coupleId: () => deleteSession.coupleId, captureCoupleWriteSession: () => ({ getCurrent: () => deleteSession }) } }, wxBackup)
  backup.restoreProgress()
  backup.refreshLocalPackages()
  assert.equal(backup.data.localPackages.length, 1)
  const packageEvent = { currentTarget: { dataset: { path: deletePackage.path } } }
  const cancelledDelete = backup.onDeleteLocal(packageEvent)
  confirm({ confirm: false })
  await cancelledDelete
  assert.equal(deleted.length, 0)
  const confirmedDelete = backup.onDeleteLocal(packageEvent)
  confirm({ confirm: true })
  await confirmedDelete
  assert.deepEqual(deleted, ['/private/123-Ours-2026-01-01-1.zip'])
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
