const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const ts = require('../node_modules/typescript')

const pending = []
const calls = []
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nextPage = options => {
  calls.push({ ...options })
  const task = { options: { ...options }, ...deferred() }
  pending.push(task)
  return task.promise
}
const result = (prefix, count, hasMore = false) => ({ items: Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, momentDate: '2026-01-01' })), total: 40, hasMore })
const tick = () => new Promise(resolve => setImmediate(resolve))
const mode = value => ({ currentTarget: { dataset: { mode: value } } })
const filter = key => ({ currentTarget: { dataset: { key } } })
const transpile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

async function main() {
  let definition
  let map, collections
  const statsPending = []
  let session = null
  let sync
  let syncCalls = 0
  let prefetch = null
  const redirects = []
  const toasts = []
  let stoppedPulls = 0
  const wx = {
    showToast: ({ title }) => toasts.push(title),
    reLaunch: ({ url }) => redirects.push(url),
    stopPullDownRefresh: () => { stoppedPulls++ },
  }
  const bootModules = {
    '../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    './session': {
      getSession: () => session,
      syncSession: async () => {
        syncCalls++
        session = await sync.promise
        return session
      },
    },
  }
  const boot = {}
  vm.runInNewContext(transpile('miniprogram/services/page-boot.ts'), { require: id => bootModules[id], exports: boot, wx })
  const ready = { status: 'ready', coupleId: 'space', role: 'B', couple: { startDate: '2020-01-01' } }
  const modules = {
    '../../services/page-boot': boot,
    '../../services/store': {
      listMomentsPage: nextPage,
      getIdentity: () => {
        assert.equal(session?.status, 'ready', 'identity requires an active session')
        return { role: session.role }
      },
      getCouple: () => session?.couple,
      getMomentsBriefStats: async () => ({ total: 40 }), getOnThisDayMoments: async () => [],
      listMapPlaces: () => (map = deferred()).promise,
      listMomentCollections: () => (collections = deferred()).promise,
      getMomentsStats: (year, month) => {
        const task = deferred()
        statsPending.push({ year, month, ...task })
        return task.promise
      },
    },
    '../../utils/tags': { MOMENT_TAG_FILTERS: [], tagLabel: x => x },
    '../../utils/moments-timeline': { buildTimelineRows: items => items.map(item => ({ key: item.id })), scenesFromMoments: items => items },
    '../../services/moments-feed-cache': {
      feedCacheKey: x => JSON.stringify(x),
      invalidateMomentsFeedPrefetch() {},
      takePrefetchedFeed: async () => {
        const feed = prefetch
        prefetch = null
        return feed
      },
    },
    '../../services/moments-list-state': { consumeMomentsListStale: () => false, peekMomentsListStale: () => false, takeMomentsContext: () => null, consumeMomentsScrollTop: () => 0 },
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
  }
  const source = transpile('miniprogram/pages/moments/moments.ts')
  const newPage = () => {
    vm.runInNewContext(source, { require: id => modules[id], exports: {}, Page: page => { definition = page }, wx, console, Promise, Date, Math, Number, Error, Set, setTimeout })
    definition.setData = function (values) { Object.assign(this.data, values) }
    return definition
  }
  const markup = fs.readFileSync('miniprogram/pages/moments/moments.wxml', 'utf8')
  const timelineState = data => {
    const branches = [
      ['rows', /class="reel-stream" wx:if="{{([^}]+)}}"/],
      ['loading', /wx:elif="{{([^}]+)}}" class="reel-skeleton"/],
      ['retry', /wx:elif="{{([^}]+)}}" class="err-banner card-soft"[^>]+bindtap="onRetry"/],
      ['empty', /wx:elif="{{([^}]+)}}" class="empty-stage"/],
    ]
    for (const [state, pattern] of branches) {
      const match = markup.match(pattern)
      assert.ok(match, `missing timeline branch: ${state}`)
      if (vm.runInNewContext(match[1], { ...data })) return state
    }
  }

  const page = newPage()
  assert.equal(timelineState(page.data), 'loading')
  sync = deferred()
  const firstShow = page.onShow()
  await tick()
  assert.equal(syncCalls, 1)
  assert.equal(timelineState(page.data), 'loading')
  sync.reject(new Error('首次连接失败'))
  await firstShow
  assert.equal(timelineState(page.data), 'retry')
  assert.match(page.data.loadError, /连不上/)
  assert.equal(calls.length, 0)
  assert.deepEqual(redirects, [])
  assert.deepEqual(toasts, [])

  sync = deferred()
  const retryBoot = page.onRetry()
  const duplicateRetry = page.onRetry()
  await tick()
  assert.equal(syncCalls, 2)
  assert.equal(timelineState(page.data), 'loading')
  sync.resolve(ready)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(timelineState(page.data), 'loading')
  pending.shift().resolve({ items: [], total: 0, hasMore: false })
  await Promise.all([retryBoot, duplicateRetry])
  assert.equal(page.data.myRole, 'B')
  assert.equal(page.data.loadError, '')
  assert.equal(timelineState(page.data), 'empty')

  const inactive = newPage()
  session = null
  sync = deferred()
  const inactiveShow = inactive.onShow()
  sync.resolve({ status: 'needsInviteCode', coupleId: null })
  await inactiveShow
  assert.deepEqual(redirects, ['/pages/setup/setup'])
  assert.equal(inactive.data.bootState, 'redirecting')
  assert.equal(inactive.data.loadError, '')
  assert.equal(timelineState(inactive.data), 'loading')
  assert.equal(calls.length, 1)

  const cached = newPage()
  session = ready
  prefetch = result('cached', 2)
  sync = deferred()
  const cachedShow = cached.onShow()
  sync.reject(new Error('会话更新失败'))
  await cachedShow
  assert.equal(cached.data.rows[0].key, 'cached0')
  assert.equal(timelineState(cached.data), 'rows')
  assert.equal(calls.length, 1)
  cached.lastRefreshedAt = 0
  sync = deferred()
  const cachedRefresh = cached.onShow()
  sync.reject(new Error('会话仍离线'))
  await tick()
  pending.shift().reject(new Error('列表连接失败'))
  await cachedRefresh
  assert.equal(cached.data.rows[0].key, 'cached0')
  assert.equal(cached.data.loadError, '列表连接失败')
  assert.equal(timelineState(cached.data), 'rows')
  const retryFeed = cached.onRetry()
  await tick()
  pending.shift().resolve(result('updated', 1))
  await retryFeed
  assert.equal(cached.data.rows[0].key, 'updated0')
  assert.equal(cached.data.loadError, '')
  assert.equal(redirects.length, 1)
  assert.equal(await boot.ensureCloudReady(), true)
  session = null
  assert.equal(await boot.ensureCloudReady(), false)
  assert.match(toasts.at(-1), /连不上/)
  assert.equal(redirects.length, 1)
  session = ready

  page.onSearchInput({ detail: { value: 'A' } }); page.onSearchConfirm(); await tick()
  assert.equal(calls.at(-1).keyword, 'A'); assert.equal(calls.at(-1).skip, 0)
  pending.shift().resolve(result('A', 20, true)); await tick()
  page.onSearchInput({ detail: { value: 'B' } })
  const more = page.loadMore(); assert.equal(calls.at(-1).keyword, 'A'); assert.equal(calls.at(-1).skip, 20)
  pending.shift().resolve(result('A-next', 2)); await more
  page.onSearchConfirm(); await tick()
  assert.equal(calls.at(-1).keyword, 'B'); assert.equal(calls.at(-1).skip, 0)
  assert.equal(page.data.skip, 0); assert.equal(page.data.rows.length, 0)
  pending.shift().resolve(result('B', 1)); await tick()
  assert.equal(page.data.rows[0].key, 'B0')

  page.onPickFilter(filter('travel')); await tick()
  assert.equal(page.data.rows.length, 0); assert.equal(calls.at(-1).tag, 'travel')
  pending.shift().reject(new Error('筛选失败')); await tick()
  assert.equal(page.data.loadError, '筛选失败'); assert.equal(page.data.rows.length, 0)
  page.onRetry(); await tick(); assert.equal(calls.at(-1).tag, 'travel')
  pending.shift().resolve(result('travel', 1)); await tick()
  const refresh = page.refresh(); await tick(); pending.shift().reject(new Error('刷新失败')); await refresh
  assert.equal(page.data.rows[0].key, 'travel0'); assert.equal(page.data.loadError, '刷新失败')
  assert.match(markup, /loadError && rows\.length/); assert.match(markup, /当前显示上次加载的内容/)
  assert.match(markup, /wx:elif="{{loadError}}"/)

  page.onSearchInput({ detail: { value: 'old' } }); page.onSearchConfirm(); await tick()
  const old = pending.shift()
  page.onSearchInput({ detail: { value: 'new' } }); page.onSearchConfirm(); await tick()
  pending.shift().resolve(result('new', 1)); await tick()
  old.resolve(result('old', 1)); await tick()
  assert.equal(page.data.rows[0].key, 'new0'); assert.equal(page.data.submittedKeyword, 'new')

  page.onSwitchView(mode('map'))
  page.onSwitchView(mode('collections'))
  map.reject(new Error('过期地图错误')); await tick()
  assert.equal(page.data.secondaryError, ''); assert.equal(page.data.secondaryLoading, true)
  collections.resolve({ tags: [], places: [] }); await tick()
  assert.equal(page.data.secondaryLoading, false); assert.equal(page.data.secondaryError, '')
  page.onSwitchView(mode('recap')); await tick()
  const recapPage = pending.shift()
  const recapStats = statsPending.shift()
  page.onSwitchView(mode('map'))
  recapPage.reject(new Error('过期回顾错误'))
  recapStats.resolve({ total: 0, countA: 0, countB: 0, placeCount: 0 })
  await tick()
  assert.equal(page.data.secondaryError, ''); assert.equal(page.data.secondaryLoading, true)
  map.resolve({ places: [], cities: [] }); await tick()
  assert.equal(page.data.secondaryLoading, false)
  const takeMonth = (year, month) => {
    const stats = statsPending.shift()
    assert.ok(stats, `missing stats request for ${year}-${month}`)
    assert.equal(stats.year, year)
    assert.equal(stats.month, month)
    const list = pending.shift()
    assert.ok(list, `missing preview request for ${year}-${month}`)
    assert.deepEqual(list.options, { limit: 6, year, month })
    return { stats, list }
  }
  const statsFor = (total, countA = total) => ({
    total, countA, countB: total - countA, placeCount: total ? 1 : 0, topTag: total ? 'travel' : '',
  })
  const previewFor = (id, total) => ({ ...result(id, Math.min(6, total)), total, hasMore: total > 6 })
  const resolveMonth = ({ stats, list }, id, total, countA) => {
    stats.resolve(statsFor(total, countA))
    list.resolve(previewFor(id, total))
  }
  const assertRecap = (page, total, first) => {
    assert.equal(page.data.recapStats?.total ?? null, total)
    assert.equal(page.data.recapMemories[0]?.id, first)
    if (!first) assert.equal(page.data.recapMemories.length, 0)
  }
  const pickMonth = (page, month) => page.onRecapMonthTap({ currentTarget: { dataset: { month } } })
  const isRecapEmpty = data => {
    const match = markup.match(/wx:elif="{{([^}]+)}}" class="recap-empty card-soft">\s*<text class="recap-empty__icon"/)
    assert.ok(match, 'missing recap empty branch')
    return vm.runInNewContext(match[1], { ...data })
  }
  assert.match(markup, /{{recapLoading && recapStats}}">正在更新，当前显示该月缓存/)
  const recap = newPage()
  recap.setData({ bootState: 'ready', recapYear: 2026, recapMonth: 6, recapYears: [2026, 2025] })
  recap.onSwitchView(mode('recap'))
  const june = takeMonth(2026, 6)
  resolveMonth(june, '', 0)
  await tick()
  assertRecap(recap, 0)
  assert.ok(isRecapEmpty(recap.data))

  pickMonth(recap, 6)
  assertRecap(recap, 0)
  assert.equal(recap.data.recapLoading, true)
  assert.ok(!isRecapEmpty(recap.data))
  const mayWarm = takeMonth(2026, 5)
  const julyWarm = takeMonth(2026, 7)
  const added = takeMonth(2026, 6)
  resolveMonth(mayWarm, 'may', 2)
  added.list.resolve(previewFor('added', 8))
  await tick()
  assertRecap(recap, 0)
  added.stats.resolve(statsFor(8, 2))
  await tick()
  assertRecap(recap, 8, 'added0')
  assert.equal(recap.data.recapMemories.length, 6)
  assert.equal(recap.data.recapStats.countB, 6)
  assert.equal(recap.data.recapStats.percentA, 25)
  assert.equal(recap.data.recapStats.topTag, 'travel')

  pickMonth(recap, 6)
  const deleted = takeMonth(2026, 6)
  deleted.stats.resolve(statsFor(0))
  await tick()
  assertRecap(recap, 8, 'added0')
  deleted.list.resolve(previewFor('', 0))
  await tick()
  assertRecap(recap, 0)
  assert.ok(isRecapEmpty(recap.data))

  pickMonth(recap, 6)
  const emptyRefresh = takeMonth(2026, 6)
  emptyRefresh.stats.resolve(statsFor(1))
  emptyRefresh.list.reject(new Error('空月份刷新失败'))
  await tick()
  assertRecap(recap, 0)
  assert.ok(!isRecapEmpty(recap.data))
  assert.match(recap.data.secondaryError, /当前显示.*缓存/)

  pickMonth(recap, 5)
  assertRecap(recap, 2, 'may0')
  assert.equal(recap.data.recapLoading, true)
  const mayRefresh = takeMonth(2026, 5)
  mayRefresh.stats.reject(new Error('统计连接失败'))
  mayRefresh.list.resolve(previewFor('partial', 3))
  await tick()
  assertRecap(recap, 2, 'may0')
  assert.match(recap.data.secondaryError, /更新失败.*当前显示.*缓存/)
  assert.equal(recap.data.recapLoading, false)

  pickMonth(recap, 6)
  const oldJune = takeMonth(2026, 6)
  pickMonth(recap, 7)
  assertRecap(recap, null)
  const july = takeMonth(2026, 7)
  oldJune.list.reject(new Error('旧月份连接失败'))
  oldJune.stats.resolve(statsFor(0))
  await tick()
  assert.equal(recap.data.secondaryError, '')
  assert.equal(recap.data.recapLoading, true)
  resolveMonth(july, 'july', 1)
  await tick()
  const augustWarm = takeMonth(2026, 8)
  augustWarm.list.reject(new Error('预热连接失败'))
  augustWarm.stats.resolve(statsFor(2))
  resolveMonth(julyWarm, 'old-warm', 2)
  await tick()
  assertRecap(recap, 1, 'july0')
  assert.equal(recap.data.secondaryError, '')
  pickMonth(recap, 7)
  assertRecap(recap, 1, 'july0')
  const julyRefresh = takeMonth(2026, 7)
  julyRefresh.stats.resolve(statsFor(0))
  julyRefresh.list.resolve(previewFor('mismatch', 1))
  await tick()
  assertRecap(recap, 1, 'july0')
  assert.match(recap.data.secondaryError, /当前显示.*缓存/)

  pickMonth(recap, 8)
  assertRecap(recap, null)
  const cold = takeMonth(2026, 8)
  cold.stats.resolve(statsFor(2))
  cold.list.reject(new Error('列表连接失败'))
  await tick()
  assertRecap(recap, null)
  assert.match(recap.data.secondaryError, /加载失败/)
  assert.doesNotMatch(recap.data.secondaryError, /缓存/)
  assert.equal(recap.data.recapLoading, false)
  assert.ok(!isRecapEmpty(recap.data))
  recap.onRetrySecondary()
  const retried = takeMonth(2026, 8)
  resolveMonth(retried, 'retried', 1)
  await tick()
  assertRecap(recap, 1, 'retried0')
  assert.equal(recap.data.secondaryError, '')
  resolveMonth(takeMonth(2026, 9), '', 0)
  await tick()

  const january = newPage()
  january.setData({ bootState: 'ready', recapYear: 2026, recapMonth: 1, recapYears: [2026, 2025] })
  january.onSwitchView(mode('recap'))
  resolveMonth(takeMonth(2026, 1), 'january', 1)
  await tick()
  const decemberWarm = takeMonth(2025, 12)
  const februaryWarm = takeMonth(2026, 2)
  january.invalidateSecondaryViews()
  assertRecap(january, null)
  resolveMonth(decemberWarm, 'invalidated', 1)
  resolveMonth(februaryWarm, '', 0)
  await tick()
  pickMonth(january, 2)
  assertRecap(january, null)
  const february = takeMonth(2026, 2)
  february.stats.resolve(statsFor(0))
  february.list.reject(new Error('重新加载失败'))
  await tick()
  assertRecap(january, null)
  assert.doesNotMatch(january.data.secondaryError, /缓存/)
  assert.equal(pending.length, 0)
  assert.equal(statsPending.length, 0)

  const filteredSearch = newPage()
  filteredSearch.setData({ bootState: 'ready' })
  filteredSearch.onSearchInput({ detail: { value: ' 周末 ' } })
  filteredSearch.onSearchConfirm()
  await tick()
  pending.shift().resolve(result('weekend', 20, true))
  await tick()
  filteredSearch.onSearchInput({ detail: { value: '未提交的草稿' } })
  const oldPagination = filteredSearch.onReachBottom()
  const oldPage = pending.shift()
  assert.equal(oldPage.options.skip, 20)
  filteredSearch.onPickFilter(filter('travel'))
  await tick()
  const filteredFirst = pending.shift()
  assert.equal(filteredFirst.options.keyword, '周末', 'changing tags must keep the submitted search')
  assert.equal(filteredFirst.options.tag, 'travel')
  assert.equal(filteredFirst.options.skip, 0)
  assert.equal(filteredSearch.data.searchKeyword, '未提交的草稿')
  assert.equal(filteredSearch.data.searchActive, true)
  filteredFirst.resolve(result('filtered', 20, true))
  await tick()
  oldPage.resolve(result('old-pagination', 2))
  await oldPagination
  assert.equal(filteredSearch.data.skip, 20)
  assert.equal(filteredSearch.data.rows.at(-1).key, 'filtered19')
  const filteredPagination = filteredSearch.onReachBottom()
  const filteredNext = pending.shift()
  assert.equal(filteredNext.options.keyword, '周末')
  assert.equal(filteredNext.options.tag, 'travel')
  assert.equal(filteredNext.options.skip, 20)
  filteredNext.resolve(result('filtered-next', 2))
  await filteredPagination
  assert.equal(filteredSearch.data.skip, 22)
  assert.equal(filteredSearch.data.rows.at(-1).key, 'filtered-next1')
  filteredSearch.onClearSearch()
  await tick()
  const tagOnly = pending.shift()
  assert.equal(tagOnly.options.keyword, undefined)
  assert.equal(tagOnly.options.tag, 'travel')
  assert.equal(tagOnly.options.skip, 0)
  tagOnly.resolve(result('tag-only', 1))
  await tick()

  const switching = newPage()
  switching.setData({ bootState: 'ready' })
  switching.onSearchInput({ detail: { value: '没有匹配' } })
  switching.onSearchConfirm()
  await tick()
  const searchRequest = pending.shift()
  switching.onSwitchView(mode('collections'))
  collections.resolve({ tags: [], places: [] })
  switching.onSwitchView(mode('timeline'))
  await tick()
  assert.equal(pending.length, 0, 'returning to the timeline must keep the in-flight search')
  searchRequest.resolve({ items: [], total: 0, hasMore: false })
  await tick()
  assert.equal(timelineState(switching.data), 'empty')
  switching.onSwitchView(mode('collections'))
  collections.resolve({ tags: [], places: [] })
  await tick()
  switching.onSwitchView(mode('timeline'))
  await tick()
  assert.equal(pending.length, 0, 'returning to the timeline must keep a loaded empty result')
  assert.equal(timelineState(switching.data), 'empty')
  assert.equal(switching.data.submittedKeyword, '没有匹配')

  const pulling = newPage()
  pulling.setData({ bootState: 'ready' })
  pulling.onSearchInput({ detail: { value: '周末' } })
  pulling.onSearchConfirm()
  await tick()
  pending.shift().resolve(result('before-pull', 1))
  await tick()
  const pull = pulling.onPullDownRefresh()
  await tick()
  const refreshingSearch = pending.shift()
  assert.equal(refreshingSearch.options.keyword, '周末')
  assert.equal(stoppedPulls, 0)
  pulling.onSwitchView(mode('collections'))
  const switchedCollections = collections
  refreshingSearch.resolve(result('after-pull', 1))
  await tick()
  assert.equal(collections, switchedCollections, 'refresh must not restart the collections request started by the tab switch')
  await pull
  assert.equal(stoppedPulls, 1)
  switchedCollections.resolve({ tags: [{ key: 'travel', label: '旅行', count: 2 }], places: [] })
  await tick()
  assert.equal(pulling.data.secondaryLoading, false)
  assert.equal(pulling.data.collectionTagTotal, 2)
  pulling.onSwitchView(mode('timeline'))
  assert.equal(pulling.data.rows[0].key, 'after-pull0')

  pulling.onSwitchView(mode('collections'))
  const collectionPull = pulling.onPullDownRefresh()
  await tick()
  pending.shift().resolve(result('collection-pull', 1))
  await tick()
  assert.notEqual(collections, switchedCollections)
  assert.equal(pulling.data.secondaryLoading, true)
  assert.equal(stoppedPulls, 1)
  collections.resolve({ tags: [], places: [] })
  await collectionPull
  assert.equal(stoppedPulls, 2)
  assert.equal(pulling.data.collectionTagTotal, 0)
  assert.equal(pending.length, 0)
  console.log('search regression checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
