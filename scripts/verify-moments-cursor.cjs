const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { loadCloud, post } = require('./verify-map-boundaries.cjs')

const root = path.join(__dirname, '../miniprogram')
const sources = new Map()
const tick = () => new Promise(resolve => setImmediate(resolve))
const ids = page => Array.from(page.data.rows.filter(row => row.type === 'moment'), row => row.scene.id)
const pageIds = page => page.items.map(row => row.id)
const timestamp = Date.UTC(2024, 9, 12, 8)
const makePost = (id, fields) => post(id, 30, 121, {
  content: '周末 [A]', tag: 'travel', authorRole: 'B', createdAt: timestamp, ...fields,
})
const fixture = (length = 21) => Array.from({ length }, (_, i) => makePost(String(i + 1).padStart(2, '0')))

function setup(rows, { legacy = false, beforeSearch, beforeList } = {}) {
  const cloud = loadCloud(rows)
  const calls = []
  const listCalls = []
  const toasts = []
  const session = { status: 'ready', openid: 'owner', coupleId: 'space', role: 'A', couple: { memberA: {}, startDate: '2020-01-01' } }
  let page
  let pulls = 0
  const mocks = {
    'services/session': { coupleId: () => 'space', getSession: () => session, requireSession: () => session },
    'services/upload-cleanup': {},
    'services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    'services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
  }
  const wx = {
    showToast: ({ title }) => toasts.push(title),
    stopPullDownRefresh: () => { pulls++ },
    cloud: {
      async callFunction({ name, data: { action, payload } }) {
        assert.equal(name, 'ours')
        if (action === 'searchMoments' || action === 'listMoments') {
          const requests = action === 'searchMoments' ? calls : listCalls
          const beforeRequest = action === 'searchMoments' ? beforeSearch : beforeList
          const request = structuredClone(payload)
          requests.push(request)
          const failure = await beforeRequest?.(request, requests.length)
          if (failure) return { result: { ok: false, error: failure } }
        }
        const options = structuredClone(payload)
        if (legacy) delete options.cursor
        return { result: structuredClone(await cloud.invoke(action, options)) }
      },
    },
  }
  const context = vm.createContext({ wx, Page: definition => { page = definition }, setTimeout, clearTimeout, console })
  const modules = new Map()
  function load(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (modules.has(name)) return modules.get(name)
    if (!sources.has(name)) {
      const text = fs.readFileSync(path.join(root, `${name}.ts`), 'utf8')
      const { outputText } = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      })
      sources.set(name, new vm.Script(`(function(require, exports) {${outputText}\n})`, { filename: name }))
    }
    const exports = {}
    modules.set(name, exports)
    sources.get(name).runInContext(context)(id => load(path.posix.join(path.posix.dirname(name), id)), exports)
    return exports
  }
  load('pages/moments/moments')
  page.setData = function (patch) { Object.assign(this.data, patch) }
  page.setData({ bootState: 'ready' })
  const listState = load('services/moments-list-state')
  const { feedCacheKey, prefetchMomentsFeed } = load('services/moments-feed-cache')
  const { listMomentsPage } = load('services/store')
  return {
    cloud, page, calls, listCalls, toasts, pulls: () => pulls, listState, listMomentsPage,
    prefetch(options) {
      listState.markMomentsListStale()
      prefetchMomentsFeed(feedCacheKey(), () => listMomentsPage({ limit: 20, skip: 0, ...options }))
    },
  }
}

async function submit(page, keyword = ' 周末 [a] ') {
  page.onSearchInput({ detail: { value: keyword } })
  page.onSearchConfirm()
  await tick()
}

for (const prefetched of [false, true]) {
  for (const remove of [false, true]) {
    test(`默认时间线${prefetched ? '复用发布预取' : '冷启动'}后${remove ? '删除' : '插入'}顶部，续页保留原第 21 条`, async () => {
      const rows = fixture(prefetched ? 20 : 21)
      const { page, cloud, listCalls, prefetch } = setup(rows)
      if (prefetched) {
        await page.onShow()
        rows.push(makePost('21'))
        prefetch({ cursor: null })
        await tick()
      }
      await page.onShow()
      const first = ids(page)
      const firstPageRequests = prefetched ? 2 : 1
      assert.equal(listCalls.length, firstPageRequests, '返回应直接使用预取的首屏')
      assert.ok(listCalls.every(({ cursor, skip }) => cursor === null && skip === 0))
      assert.deepEqual(first, rows.slice(1).reverse().map(row => row._id))
      if (remove) rows.pop()
      else rows.push(makePost('22'))

      await page.onReachBottom()
      assert.deepEqual(ids(page), [...first, '01'])
      assert.equal(listCalls.length, firstPageRequests + 1)
      assert.deepEqual(listCalls.at(-1).cursor, { id: '02', momentDate: '2024-10-12', createdAt: timestamp })
      assert.equal(page.data.hasMore, false)
      const reads = cloud.queries.filter(({ name, type }) => name === 'moments' && type === 'get')
      assert.ok(reads.some(({ limit, ids }) => limit === 21 && ids.join(',') === '01'))
      await page.onReachBottom()
      assert.equal(listCalls.length, firstPageRequests + 1)
    })
  }
}

test('默认时间线下拉和发布返回保留已读深度，并更新续页游标', async () => {
  const rows = fixture(41)
  const { page, listCalls, prefetch } = setup(rows)
  await page.onShow()
  await page.onReachBottom()
  await page.onPullDownRefresh()
  assert.deepEqual(listCalls.map(call => call.cursor?.id ?? call.cursor), [null, '22', null, '22'])
  assert.equal(ids(page).length, 40)

  rows.push(makePost('42'))
  prefetch({ cursor: null })
  await page.onShow()
  assert.deepEqual(listCalls.slice(4).map(call => call.cursor?.id ?? call.cursor), [null, '23'])
  assert.equal(ids(page).length, 40)
  assert.equal(ids(page)[0], '42')
  assert.equal(ids(page).at(-1), '03')
  await page.onReachBottom()
  assert.equal(listCalls.at(-1).cursor.id, '03')
  assert.deepEqual(ids(page).slice(-3), ['03', '02', '01'])
})

for (const [label, legacy, prefetched] of [
  ['旧预取', false, true],
  ['旧云函数冷启动', true, false],
  ['旧云函数返回的预取', true, true],
]) {
  test(`默认时间线兼容${label}，去重后仍按服务器消费条数推进`, async () => {
    const rows = fixture(40)
    const { page, listCalls, prefetch } = setup(rows, { legacy })
    if (prefetched) prefetch(legacy ? { cursor: null } : undefined)
    await page.onShow()
    assert.equal(listCalls.length, 1)
    assert.equal(Object.hasOwn(listCalls[0], 'cursor'), legacy)
    if (legacy) assert.equal(listCalls[0].cursor, null)
    rows.push(makePost('41'))
    await page.onReachBottom()
    assert.equal(ids(page).length, 39)
    await page.onReachBottom()
    assert.deepEqual(listCalls.slice(1).map(call => call.skip), [20, 40])
    assert.ok(listCalls.slice(1).every(call => !Object.hasOwn(call, 'cursor')))
    assert.equal(ids(page).length, 40)
    assert.equal(ids(page).at(-1), '01')
    assert.equal(page.data.hasMore, false)
  })
}

test('切换精确坐标后，延迟的默认时间线预取不能写回，坐标续页仍用偏移', async () => {
  const rows = [...fixture(), makePost('22', { location: { latitude: 30.0001, longitude: 121 } })]
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const { page, listCalls, listState, prefetch } = setup(rows, {
    beforeList(request, index) { if (index === 1) return waiting },
  })
  prefetch({ cursor: null })
  const pending = page.onShow()
  await tick()
  listState.openMomentsContext({ locationKey: '30,121', label: 'Park' })
  await page.onShow()
  assert.equal(ids(page)[0], '21')
  release()
  await pending
  await page.onReachBottom()
  assert.equal(ids(page)[0], '21')
  assert.equal(ids(page).at(-1), '01')
  assert.equal(ids(page).length, 21)
  assert.deepEqual(listCalls.slice(1).map(call => call.skip), [0, 20])
  assert.ok(listCalls.slice(1).every(call => call.locationKey === '30,121' && !Object.hasOwn(call, 'cursor')))
  page.onClearContext()
  await tick()
  assert.equal(listCalls.at(-1).cursor, null)
  assert.equal(ids(page)[0], '22')
})

test('媒体筛选仍按精确匹配后的偏移分页', async () => {
  const rows = fixture(42)
  rows.filter((_, index) => index % 2 === 0).forEach(row => { row.images = ['https://example.test/photo.jpg'] })
  const { listMomentsPage, listCalls } = setup(rows)
  const first = await listMomentsPage({ mediaFilter: 'image', limit: 20 })
  const second = await listMomentsPage({ mediaFilter: 'image', limit: 20, skip: first.items.length })
  assert.equal(first.total, 21)
  assert.equal(first.hasMore, true)
  assert.deepEqual(pageIds(second), ['01'])
  assert.equal(second.hasMore, false)
  assert.ok([first, second, ...listCalls].every(call => !Object.hasOwn(call, 'nextCursor') && !Object.hasOwn(call, 'cursor')))
})

for (const mutation of ['删除顶部', '插入顶部']) {
  test(`${mutation}后旧偏移重现遗漏或重复，页面游标准确拿到第 21 条`, async () => {
    const rows = fixture()
    const { cloud, page, calls } = setup(rows)
    const legacy = await cloud.call('searchMoments', { keyword: '周末 [a]', limit: 20 })
    assert.equal(Object.hasOwn(legacy, 'nextCursor'), false)
    await submit(page)
    const first = ids(page)
    assert.deepEqual(first, pageIds(legacy))
    assert.equal(calls[0].cursor, null)
    if (mutation === '删除顶部') rows.pop()
    else rows.push(makePost('22'))

    const offset = await cloud.call('searchMoments', { keyword: '周末 [a]', limit: 20, skip: 20 })
    assert.deepEqual(pageIds(offset), mutation === '删除顶部' ? [] : ['02', '01'])
    await page.onReachBottom()
    assert.deepEqual(ids(page), [...first, '01'])
    assert.deepEqual(calls[1].cursor, { id: '02', momentDate: '2024-10-12', createdAt: timestamp })
    assert.equal(page.data.hasMore, false)
    await page.onReachBottom()
    assert.equal(calls.length, 2)
  })
}

test('同毫秒按 ID、同日按发布时间、跨日按回忆日期续页，边界记录可被删除', async () => {
  const rows = [
    ...fixture(21),
    makePost('same-day-earlier', { createdAt: timestamp - 1 }),
    makePost('older-day', { momentDate: '2024-10-11', createdAt: timestamp + 1000 }),
    makePost('outside-month', { momentDate: '2024-09-01' }),
  ]
  const { cloud, page } = setup(rows)
  page.setData({ dateYear: 2024, dateMonth: 10, locationName: 'Park' })
  await submit(page)
  rows.splice(rows.findIndex(row => row._id === '02'), 1)
  await page.onReachBottom()
  assert.deepEqual(ids(page).slice(-5), ['03', '02', '01', 'same-day-earlier', 'older-day'])
  assert.equal(ids(page).length, 23)
  assert.equal(page.data.hasMore, false)
  assert.ok(cloud.queries.filter(query => query.name === 'moments' && query.type === 'get').every(query => query.skip === 0))
})

test('尾页失败后原游标可重试，下拉重新从头加载并保留深度', async () => {
  const rows = fixture()
  const { page, calls, toasts, pulls } = setup(rows, {
    beforeSearch(request, index) {
      if (index === 2) return '尾页暂不可用'
      if (index === 5) rows.pop()
    },
  })
  await submit(page)
  const first = ids(page)
  await page.onReachBottom()
  assert.deepEqual(toasts, ['尾页暂不可用'])
  assert.deepEqual(ids(page), first)
  assert.equal(page.data.loadingMore, false)
  assert.equal(page.data.hasMore, true)
  await page.onReachBottom()
  assert.deepEqual(calls[2].cursor, calls[1].cursor)
  assert.deepEqual(ids(page), [...first, '01'])

  await page.onPullDownRefresh()
  assert.equal(pulls(), 1)
  assert.equal(calls[3].cursor, null)
  assert.deepEqual(calls[4].cursor, calls[2].cursor)
  assert.deepEqual(ids(page), [...first, '01'])
  assert.equal(page.data.hasMore, false)
})

test('换标签、换词和首屏重试都重置游标，过滤后的续页不会接受旧请求', async () => {
  const rows = [...fixture(22), makePost('另一组', { content: '午后', tag: 'daily' })]
  rows.find(row => row._id === '22').tag = 'daily'
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const { page, calls } = setup(rows, {
    beforeSearch(request, index) {
      if (index === 2) return waiting
      if (index === 5) return '首屏暂不可用'
    },
  })
  await submit(page)
  page.onSearchInput({ detail: { value: '午后' } })
  const old = page.onReachBottom()
  page.onPickFilter({ currentTarget: { dataset: { key: 'travel' } } })
  await tick()
  release()
  await old
  assert.equal(calls[1].keyword, '周末 [a]')
  assert.equal(calls[2].cursor, null)
  assert.equal(calls[2].tag, 'travel')
  assert.equal(ids(page)[0], '21')
  await page.onReachBottom()
  assert.equal(calls[3].tag, 'travel')
  assert.equal(calls[3].cursor.id, '02')
  assert.equal(ids(page).at(-1), '01')
  assert.equal(ids(page).length, 21)

  page.onSearchConfirm()
  await tick()
  assert.equal(page.data.loadError, '首屏暂不可用')
  assert.deepEqual(ids(page), [])
  await page.onRetry()
  assert.equal(page.data.loadError, '')
  assert.deepEqual(ids(page), [])
  assert.deepEqual(calls.slice(4).map(({ keyword, tag, skip, cursor }) => ({ keyword, tag, skip, cursor })), [
    { keyword: '午后', tag: 'travel', skip: 0, cursor: null },
    { keyword: '午后', tag: 'travel', skip: 0, cursor: null },
  ])
})

test('新页面与旧云函数走兼容偏移，去重后仍按服务器消费条数推进', async () => {
  const rows = fixture(40)
  const { page, calls } = setup(rows, { legacy: true })
  await submit(page)
  rows.push(makePost('41'))
  await page.onReachBottom()
  assert.equal(Object.hasOwn(calls[1], 'cursor'), false)
  assert.equal(calls[1].skip, 20)
  assert.equal(ids(page).length, 39)
  await page.onReachBottom()
  assert.equal(calls[2].skip, 40)
  assert.equal(ids(page).length, 40)
  assert.equal(new Set(ids(page)).size, 40)
  assert.equal(ids(page).at(-1), '01')
})


test('已读记录改日期越过游标时去重，未读记录移到前面时下拉重排', async () => {
  const rows = fixture(22)
  const { page } = setup(rows)
  await submit(page)
  const first = ids(page)
  rows.find(row => row._id === '22').momentDate = '2024-10-11'
  rows.find(row => row._id === '02').momentDate = '2024-10-13'
  await page.onReachBottom()
  assert.deepEqual(ids(page), [...first, '01'])
  assert.equal(page.data.hasMore, false)

  await page.onPullDownRefresh()
  assert.deepEqual(ids(page), ['02', ...first.slice(1), '01', '22'])
  assert.equal(page.data.hasMore, false)
})
