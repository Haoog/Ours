const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '..', 'miniprogram')
const compiled = new Map()
const tick = () => new Promise(resolve => setImmediate(resolve))
const baseSession = {
  status: 'ready', openid: 'author', role: 'A',
  couple: { id: 'space', startDate: '2026-01-01' },
}
const feed = (...ids) => ({ items: ids.map(id => ({ id })), total: ids.length, hasMore: false })
const event = dataset => ({ currentTarget: { dataset } })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function runtime() {
  let now = Date.UTC(2026, 10, 20)
  let nextTimer = 0
  let verification = baseSession
  let compose, returned
  const timers = new Map()
  const requests = []
  const publishes = []
  const routes = []
  const toasts = []
  const app = { getAppInstance: () => ({ waitBoot: async () => {} }) }
  const wx = {
    getStorageSync: () => ({ ...baseSession, coupleId: baseSession.couple.id }),
    setStorageSync() {}, removeStorageSync() {},
    getSystemInfoSync: () => ({ platform: 'ios' }),
    getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {} }),
    navigateTo: ({ url }) => routes.push(url),
    switchTab: ({ url }) => {
      routes.push(url)
      compose.onUnload()
      returned = moments.onShow()
    },
    showToast: ({ title }) => toasts.push(title),
    stopPullDownRefresh() {},
  }

  function load(file, modules = {}) {
    if (!compiled.has(file)) {
      const source = fs.readFileSync(path.join(root, `${file}.ts`), 'utf8')
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      })
      compiled.set(file, new vm.Script(outputText, { filename: `${file}.ts` }))
    }
    const exports = {}
    let page
    compiled.get(file).runInNewContext({
      exports, wx, Date: class extends Date { static now() { return now } },
      Page: definition => { page = definition },
      require: name => {
        assert.ok(Object.hasOwn(modules, name), `unexpected import ${name} in ${file}`)
        return modules[name]
      },
      setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer },
      clearTimeout: id => timers.delete(id),
    })
    if (!page) return exports
    page.setData = values => Object.assign(page.data, values)
    return page
  }

  const session = load('services/session', {
    './cloud-api': { callOurs: async action => { assert.equal(action, 'bootstrap'); return verification } },
  })
  const cache = load('services/moments-feed-cache', { './session': session })
  const listState = load('services/moments-list-state', { './moments-feed-cache': cache })
  const boot = load('services/page-boot', { '../app': app, './session': session })
  const tags = load('utils/tags')
  const shared = {
    '../../services/moments-feed-cache': cache,
    '../../services/moments-list-state': listState,
    '../../services/page-boot': boot,
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
    '../../utils/tags': tags,
    '../../services/store': {
      getIdentity: () => session.requireSession(),
      getCouple: () => session.requireSession().couple,
      addMoment: async ({ content }) => { publishes.push(content) },
      listMomentsPage: options => {
        const request = { ...deferred(), options: { ...options }, owner: session.requireSession() }
        requests.push(request)
        return request.promise
      },
      getMomentsBriefStats: async () => ({ total: 0 }),
      getOnThisDayMoments: async () => [],
    },
  }
  const moments = load('pages/moments/moments', {
    ...shared,
    '../../utils/moments-timeline': { buildTimelineRows: items => items.map(item => ({ key: item.id })) },
  })

  const nextRequest = () => {
    assert.ok(requests.length, '需要发起一次新的列表请求')
    return requests.shift()
  }
  return {
    moments, cache, requests, nextRequest, tags,
    rows: () => Array.from(moments.data.rows, row => row.key),
    advance: ms => { now += ms },
    setVerification: value => { verification = value },
    syncSession: () => session.syncSession(true),
    async seed() {
      const shown = moments.onShow()
      await tick()
      nextRequest().resolve(feed('初始回忆'))
      await shown
    },
    async publish(content, beforeSubmit = () => {}) {
      moments.onTapCompose()
      assert.equal(routes.at(-1), '/pages/compose/compose')
      compose = load('pages/compose/compose', {
        ...shared,
        '../../app': app, '../../services/session': session,
        '../../services/compose-draft': {
          newPublishId: () => 'publish', waitForComposeDraftSave: async () => {},
          readComposeDraft: () => null, saveComposeDraft: async () => {}, clearComposeDraft() {},
        },
        '../../services/date': { todayKey: () => '2026-11-20' },
        '../../utils/moment-time': { formatMomentDateLabel: value => value },
        '../../utils/cloud-url-cache': {}, '../../utils/live-photo': {},
      })
      await compose.onLoad({})
      compose.onContentInput({ detail: { value: content } })
      beforeSubmit()
      await compose.onSubmit()
      assert.equal(publishes.at(-1), content)
      assert.equal(toasts.at(-1), '已保存')
      assert.equal(routes.at(-1), '/pages/compose/compose')
      const prefetch = nextRequest()
      assert.deepEqual(prefetch.options, { limit: 20, skip: 0, cursor: null })
      return prefetch
    },
    returnFromCompose() {
      const timer = [...timers].find(([, task]) => task.delay === 500)
      assert.ok(timer, '预取未结束时也应安排 500ms 后返回')
      timers.delete(timer[0])
      now += timer[1].delay
      timer[1].callback()
      assert.equal(routes.at(-1), '/pages/moments/moments')
      return returned
    },
  }
}

test('默认列表复用仍在进行的发布预取，复用一次后正常请求', async () => {
  const run = runtime()
  await run.seed()
  const prefetch = await run.publish('新回忆')
  const returned = run.returnFromCompose()
  await tick()
  assert.equal(run.requests.length, 0)
  prefetch.resolve(feed('新回忆', '初始回忆'))
  await returned
  assert.deepEqual(run.rows(), ['新回忆', '初始回忆'])
  const refreshed = run.moments.onPullDownRefresh()
  await tick()
  run.nextRequest().resolve(feed('更新后的回忆'))
  await refreshed
  assert.deepEqual(run.rows(), ['更新后的回忆'])
})

test('带标签返回后切回全部，已错过的发布预取不能覆盖更新', async () => {
  const run = runtime()
  await run.seed()
  run.moments.onPickFilter(event({ key: 'daily' }))
  await tick()
  run.nextRequest().resolve(feed('日常回忆'))
  await tick()
  const prefetch = await run.publish('新回忆')
  prefetch.resolve(feed('新回忆', '初始回忆'))
  const returned = run.returnFromCompose()
  await tick()
  const filtered = run.nextRequest()
  assert.equal(filtered.options.tag, 'daily')
  filtered.resolve(feed('新回忆', '日常回忆'))
  await returned

  run.moments.onPickFilter(event({ key: '' }))
  await tick()
  const latest = run.nextRequest()
  assert.equal(latest.options.tag, undefined)
  latest.resolve(feed('另一方新发布的回忆', '新回忆', '初始回忆'))
  await tick()
  assert.equal(run.rows()[0], '另一方新发布的回忆')
})

test('地点返回绕过预取，较晚清除地点时重新请求全部', async () => {
  const run = runtime()
  await run.seed()
  run.moments.onTapCollectionPlace(event({ name: '公园|l:长椅' }))
  const atPlace = run.nextRequest()
  assert.equal(atPlace.options.locationName, '公园|l:长椅')
  atPlace.resolve(feed('公园回忆'))
  await tick()
  const prefetch = await run.publish('新回忆')
  prefetch.resolve(feed('新回忆', '初始回忆'))
  const returned = run.returnFromCompose()
  await tick()
  run.nextRequest().resolve(feed('公园回忆'))
  await returned

  run.advance(20_000)
  run.moments.onClearContext()
  await tick()
  const latest = run.nextRequest()
  assert.equal(latest.options.locationName, undefined)
  latest.resolve(feed('另一方新发布的回忆'))
  await tick()
  assert.deepEqual(run.rows(), ['另一方新发布的回忆'])
})

test('正常关键词包含分隔字符时，与可取预取的其他标签及关键字不碰撞', async () => {
  const run = runtime()
  await run.seed()
  const prefetch = await run.publish('新回忆')
  prefetch.resolve(feed('新回忆'))
  const show = run.returnFromCompose()
  await show
  const keyword = '旅行|k:晚餐|l:长椅'
  run.moments.onSearchInput({ detail: { value: ` ${keyword} ` } })
  run.moments.onSearchConfirm()
  await tick()
  const search = run.nextRequest()
  assert.equal(search.options.keyword, keyword)
  search.resolve(feed('关键字结果'))
  await tick()
  const keys = run.tags.MOMENT_TAG_FILTERS.flatMap(({ key: tag }) =>
    ['', '旅行', '旅行|k:晚餐', keyword, '|l:', '|k:'].map(value => run.cache.feedCacheKey({ tag, keyword: value })),
  )
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(run.cache.feedCacheKey({ keyword: ` ${keyword} ` }), run.cache.feedCacheKey({ keyword }))
})

for (const change of [{ openid: 'other' }, { couple: { ...baseSession.couple, id: 'other' } }, { role: 'B' }]) {
  test(`返回页校验变更 ${Object.keys(change)[0]} 时重新请求`, async () => {
    const run = runtime()
    await run.seed()
    const prefetch = await run.publish('旧会话的回忆', () => run.advance(16_000))
    prefetch.resolve(feed('旧会话的回忆'))
    run.setVerification({ ...baseSession, ...change })
    const returned = run.returnFromCompose()
    await tick()
    const latest = run.nextRequest()
    assert.equal(latest.owner.openid, change.openid || baseSession.openid)
    assert.equal(latest.owner.coupleId, change.couple?.id || baseSession.couple.id)
    assert.equal(latest.owner.role, change.role || baseSession.role)
    latest.resolve(feed('当前会话的回忆'))
    await returned
    assert.deepEqual(run.rows(), ['当前会话的回忆'])
  })
}

test('等待预取期间 bootstrap 换会话时，旧结果不作为列表首屏', async () => {
  const run = runtime()
  await run.seed()
  const prefetch = await run.publish('旧会话的回忆')
  const returned = run.returnFromCompose()
  await tick()
  assert.equal(run.requests.length, 0)
  run.setVerification({ ...baseSession, openid: 'other' })
  await run.syncSession()
  prefetch.resolve(feed('旧会话的回忆'))
  await tick()
  assert.deepEqual(run.rows(), ['初始回忆'])
  const latest = run.nextRequest()
  assert.equal(latest.owner.openid, 'other')
  latest.resolve(feed('当前会话的回忆'))
  await returned
  assert.deepEqual(run.rows(), ['当前会话的回忆'])
})

test('再次发布后，第一次返回已取走的慢预取在会话校验期间不能回写', async () => {
  const run = runtime()
  await run.seed()
  const first = await run.publish('第一次发布')
  const firstReturn = run.returnFromCompose()
  await tick()
  assert.equal(run.requests.length, 0)
  const second = await run.publish('第二次发布', () => run.advance(16_000))
  const verification = deferred()
  run.setVerification(verification.promise)
  const secondReturn = run.returnFromCompose()
  await tick()
  assert.equal(run.moments.checkingSession, true)

  first.resolve(feed('第一次发布', '初始回忆'))
  await tick()
  assert.deepEqual(run.rows(), ['初始回忆'])
  assert.equal(run.requests.length, 0, '已失效的预取无需再发列表兜底请求')
  verification.resolve(baseSession)
  await tick()
  second.resolve(feed('第二次发布', '第一次发布'))
  await secondReturn
  await firstReturn
  assert.deepEqual(run.rows(), ['第二次发布', '第一次发布'])
})

test('发布后返回开始校验时，普通列表旧请求立即失去写入权', async () => {
  for (const settleDuringVerification of [true, false]) {
    const run = runtime()
    await run.seed()
    const refresh = run.moments.onPullDownRefresh()
    await tick()
    const old = run.nextRequest()
    const prefetch = await run.publish('新回忆', () => run.advance(16_000))
    const verification = deferred()
    run.setVerification(verification.promise)
    const returned = run.returnFromCompose()
    await tick()
    assert.equal(run.moments.checkingSession, true)
    if (settleDuringVerification) {
      old.resolve(feed('发布前的普通请求结果'))
      await refresh
      assert.deepEqual(run.rows(), ['初始回忆'])
    }
    verification.resolve(baseSession)
    await tick()
    if (!settleDuringVerification) {
      old.resolve(feed('发布前的普通请求结果'))
      await refresh
      assert.deepEqual(run.rows(), ['初始回忆'])
    }
    prefetch.resolve(feed('新回忆'))
    await returned
    assert.deepEqual(run.rows(), ['新回忆'])
  }
})
