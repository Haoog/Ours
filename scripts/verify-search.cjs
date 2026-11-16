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
  const task = deferred()
  pending.push(task)
  return task.promise
}
const result = (prefix, count, hasMore = false) => ({ items: Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, momentDate: '2026-01-01' })), total: 40, hasMore })
const tick = () => new Promise(resolve => setImmediate(resolve))
const mode = value => ({ currentTarget: { dataset: { mode: value } } })
const filter = key => ({ currentTarget: { dataset: { key } } })

async function main() {
  let definition
  let map, collections
  const modules = {
    '../../services/store': {
      listMomentsPage: nextPage,
      getIdentity: () => ({ role: 'A' }), getCouple: () => ({ startDate: '2020-01-01' }),
      getMomentsBriefStats: async () => ({ total: 40 }), getOnThisDayMoments: async () => [],
      listMapPlaces: () => (map = deferred()).promise,
      listMomentCollections: () => (collections = deferred()).promise,
      getMomentsStats: async () => ({ total: 0, countA: 0, countB: 0, placeCount: 0 }),
    },
    '../../utils/tags': { MOMENT_TAG_FILTERS: [], tagLabel: x => x },
    '../../utils/moments-timeline': { buildTimelineRows: items => items.map(item => ({ key: item.id })), scenesFromMoments: items => items },
    '../../services/moments-feed-cache': { feedCacheKey: x => JSON.stringify(x), takePrefetchedFeed: async () => null },
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
  }
  const fallback = new Proxy({}, { get: () => () => undefined })
  const source = ts.transpileModule(fs.readFileSync('miniprogram/pages/moments/moments.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  vm.runInNewContext(source, { require: id => modules[id] || fallback, exports: {}, Page: page => { definition = page }, wx: { showToast() {} }, console, Promise, Date, Math, Number, Error, Set, setTimeout })
  const page = definition
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = function (values) { Object.assign(this.data, values) }

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
  const markup = fs.readFileSync('miniprogram/pages/moments/moments.wxml', 'utf8')
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
  page.onSwitchView(mode('map'))
  recapPage.reject(new Error('过期回顾错误')); await tick()
  assert.equal(page.data.secondaryError, ''); assert.equal(page.data.secondaryLoading, true)
  map.resolve({ places: [], cities: [] }); await tick()
  assert.equal(page.data.secondaryLoading, false)
  console.log('search regression checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
