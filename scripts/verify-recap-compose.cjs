const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function compile(path) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  return new vm.Script(outputText, { filename: path })
}

const moments = compile('miniprogram/pages/moments/moments.ts')
const compose = compile('miniprogram/pages/compose/compose.ts')
const date = compile('miniprogram/services/date.ts')
const momentTime = compile('miniprogram/utils/moment-time.ts')
const momentsWxml = fs.readFileSync('miniprogram/pages/moments/moments.wxml', 'utf8')
const composeWxml = fs.readFileSync('miniprogram/pages/compose/compose.wxml', 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const route = '/pages/compose/compose'
const savedMoment = { content: '已发布的回忆', momentDate: '2025-06-10', tag: 'daily', authorRole: 'A' }

function scenario({ now = '2026-11-20T12:00:00Z', tz = 'Asia/Shanghai', startDate = '2024-01-15', drafts = {} } = {}) {
  process.env.TZ = tz
  const time = Date.parse(now)
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])) }
    static now() { return time }
  }
  const dateExports = {}, momentTimeExports = {}
  date.runInNewContext({ exports: dateExports, Date: Clock })
  momentTime.runInNewContext({ exports: momentTimeExports, Date: Clock, require: () => dateExports })

  const destinations = [], toasts = [], posts = [], edits = [], saves = [], draftReads = []
  const session = { status: 'ready', role: 'A', coupleId: 'space', openid: 'author' }
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReady: async () => true, ensureCloudReadyState: async () => 'ready' },
    '../../services/session': { getSession: () => session },
    '../../services/store': {
      getIdentity: () => session, getCouple: () => ({ startDate }), getMoment: async () => savedMoment,
      listMomentsPage: async () => ({ items: [], total: 0, hasMore: false }),
      getMomentsStats: async () => ({ total: 0, countA: 0, countB: 0, placeCount: 0 }),
      getMomentsBriefStats: async () => ({ total: 0, countA: 0, countB: 0 }),
      getOnThisDayMoments: async () => [],
      addMoment: async input => posts.push(structuredClone(input)),
      updateMoment: async (id, patch) => edits.push([id, structuredClone(patch)]),
    },
    '../../services/compose-draft': {
      newPublishId: () => 'new-request', waitForComposeDraftSave: async () => {},
      readComposeDraft: id => { draftReads.push(id); return drafts[id] },
      saveComposeDraft: async snapshot => saves.push(structuredClone(snapshot)),
      clearComposeDraft() {},
    },
    '../../services/date': dateExports,
    '../../utils/moment-time': momentTimeExports,
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => 'default', syncTheme() {} },
    '../../services/moments-list-state': {
      peekMomentsListStale: () => false, consumeMomentsListStale: () => false,
      takeMomentsContext: () => null, consumeMomentsScrollTop: () => 0, markMomentsListStale() {},
    },
    '../../services/moments-feed-cache': { feedCacheKey() {}, takePrefetchedFeed: async () => null, prefetchMomentsFeed() {} },
    '../../utils/moments-timeline': { buildTimelineRows: () => [], scenesFromMoments: () => [] },
    '../../utils/tags': { MOMENT_TAG_FILTERS: [], MOMENT_TAG_POST: [] },
  }
  const wx = {
    navigateTo: ({ url }) => destinations.push(url), showToast: ({ title }) => toasts.push(title), setNavigationBarTitle() {},
    getSystemInfoSync: () => ({ platform: 'ios' }),
    getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {} }),
  }
  function page(script) {
    let definition
    script.runInNewContext({
      Page: value => { definition = value }, require: name => modules[name] || {}, exports: {}, Date: Clock,
      wx, setTimeout: () => 1, clearTimeout() {},
    })
    return { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
  }
  async function openCompose(destination) {
    const url = new URL(destination, 'https://example.invalid')
    assert.equal(url.pathname, route)
    const form = page(compose)
    const opening = form.onLoad(Object.fromEntries(url.searchParams))
    form.onShow()
    await opening
    return form
  }
  async function tapRecap(year, month) {
    const list = page(moments)
    await list.onShow()
    const [, switchView] = momentsWxml.match(/data-mode="recap" bindtap="(\w+)"/)
    const [, pickYear] = momentsWxml.match(/range="{{recapYears}}" bindchange="(\w+)"/)
    const [, pickMonth] = momentsWxml.match(/data-month="{{item}}"\s+bindtap="(\w+)"/)
    const [, tap] = momentsWxml.match(/class="recap-empty__action"[^>]*bindtap="(\w+)"/)
    list[switchView]({ currentTarget: { dataset: { mode: 'recap' } } })
    const yearIndex = list.data.recapYears.indexOf(year)
    assert.ok(yearIndex >= 0)
    list[pickYear]({ detail: { value: String(yearIndex) } })
    list[pickMonth]({ currentTarget: { dataset: { month } } })
    await tick()
    assert.equal(list.data.recapStats?.total, 0)
    assert.equal(list.data.recapLoading, false)
    assert.equal(list.data.secondaryError, '')
    const beforeTap = destinations.length
    list[tap]()
    assert.ok(destinations.length <= beforeTap + 1, 'one tap must not navigate twice')
    return destinations[beforeTap]
  }
  return { openCompose, tapRecap, openMoments: () => page(moments), destinations, toasts, posts, edits, saves, draftReads }
}

function pickDate(form, value) {
  const [picker, change] = composeWxml.match(/<picker mode="date"[^>]*bindchange="(\w+)"[^>]*>/)
  assert.match(picker, /value="{{momentDate}}" start="{{minMomentDate}}" end="{{maxMomentDate}}"/)
  assert.match(composeWxml, /{{momentDateLabel}}/)
  form[change]({ detail: { value } })
}

const cases = {
  async 'historical empty recap submits into the selected year and month by default'() {
    const test = scenario()
    const destination = await test.tapRecap(2024, 2)
    assert.equal(destination, `${route}?recapMonth=2024-02`)
    const form = await test.openCompose(destination)
    assert.equal(form.data.momentDate, '2024-02-01')
    assert.equal(form.data.momentDateLabel, '2024年2月1日')
    form.onContentInput({ detail: { value: '补记' } })
    await form.onSubmit()
    assert.equal(test.posts[0].momentDate, '2024-02-01')
  },
  async 'the start date clips the month and the real date picker can change it'() {
    const test = scenario({ startDate: '2024-02-29' })
    const form = await test.openCompose(await test.tapRecap(2024, 2))
    assert.equal(form.data.momentDate, '2024-02-29')
    assert.equal(form.data.minMomentDate, '2024-02-29')
    pickDate(form, '2024-03-02')
    assert.equal(form.data.momentDateLabel, '2024年3月2日')
    form.onContentInput({ detail: { value: '改过日期的补记' } })
    await form.onSubmit()
    assert.equal(test.posts[0].momentDate, '2024-03-02')
  },
  async 'tapping a month before the start date or after UTC+8 today shows a message without navigating'() {
    const test = scenario({ startDate: '2024-02-29', now: '2026-10-31T15:59:59Z', tz: 'Asia/Tokyo' })
    assert.equal(await test.tapRecap(2024, 1), undefined)
    assert.equal(await test.tapRecap(2026, 11), undefined)
    assert.deepEqual(test.destinations, [])
    assert.deepEqual(test.toasts, Array(2).fill('该月没有可补记的日期，请选择其他月份'))
  },
  async 'the selected month opens at UTC+8 midnight even when the device is still in the previous month'() {
    const test = scenario({ now: '2026-10-31T16:00:00Z', tz: 'America/Los_Angeles' })
    const current = await test.openCompose(await test.tapRecap(2026, 11))
    assert.equal(current.data.maxMomentDate, '2026-11-01')
    assert.equal(current.data.momentDate, '2026-11-01')
    assert.equal(current.data.momentDateLabel, '2026年11月1日')
  },
  async 'ordinary compose and a recap in the current month keep today as the default'() {
    const test = scenario()
    const [, tap] = momentsWxml.match(/class="sticker-send"[^>]*bindtap="(\w+)"/)
    test.openMoments()[tap]()
    assert.deepEqual(test.destinations, [route])
    assert.equal((await test.openCompose(route)).data.momentDate, '2026-11-20')
    assert.equal((await test.openCompose(await test.tapRecap(2026, 11))).data.momentDate, '2026-11-20')
  },
  async 'direct compose links with invalid or out-of-range months fall back to the ordinary default'() {
    const test = scenario({ startDate: '2024-02-29', now: '2026-10-31T15:59:59Z', tz: 'Asia/Tokyo' })
    for (const month of ['', '0999-02', '2024-2', '2024-00', '2024-13', '2024-02-01', '2024-02\n', '2024-01', '2026-11']) {
      const form = await test.openCompose(`${route}?recapMonth=${encodeURIComponent(month)}`)
      assert.equal(form.data.maxMomentDate, '2026-10-31')
      assert.equal(form.data.momentDate, '2026-10-31', `unexpected date from ${JSON.stringify(month)}`)
    }
  },
  async 'the publish draft and an uncertain publish retry keep their date and request ID'() {
    for (const pendingResult of [false, true]) {
      const draft = { requestId: 'saved-request', content: '未完成的发布', tagSelected: 'travel', momentDate: '2025-09-08',
        location: '', locationFull: null, images: [], livePhotos: [], video: '', videoCover: '', voice: null, pendingResult }
      const test = scenario({ drafts: { '': draft } })
      const form = await test.openCompose(await test.tapRecap(2024, 2))
      assert.equal(form.data.momentDateLabel, '2025年9月8日')
      assert.equal(form.data.content, draft.content)
      assert.equal(form.data.pendingResult, pendingResult)
      assert.equal(test.saves.length, 0)
      if (pendingResult) pickDate(form, '2024-02-01')
      await form.onSubmit()
      assert.deepEqual(test.posts.map(({ requestId, momentDate }) => [requestId, momentDate]), [[draft.requestId, draft.momentDate]])
    }
  },
  async 'editing ignores the recap month and restores the edit draft for that record'() {
    const { content, momentDate } = savedMoment
    const base = { content, momentDate, tagSelected: 'daily', locationFull: null }
    const draft = { ...base, editBase: base, requestId: 'edit-request', tagSelected: 'travel' }
    const test = scenario({ drafts: { record: draft } })
    const destination = await test.tapRecap(2024, 2)
    const separator = destination.includes('?') ? '&' : '?'
    const form = await test.openCompose(`${destination}${separator}id=record`)
    assert.equal(form.data.editing, true)
    assert.equal(form.data.momentDate, momentDate)
    assert.equal(form.data.momentDateLabel, '2025年6月10日')
    assert.deepEqual(test.draftReads, ['record'])
    await form.onSubmit()
    assert.deepEqual(test.edits, [['record', { tag: 'travel' }]])
    assert.deepEqual(test.posts, [])
  },
}

async function main() {
  for (const [name, check] of Object.entries(cases)) {
    try { await check(); console.log(`PASS: ${name}`) }
    catch (error) { console.error(`FAIL: ${name}\n${error.stack}`); process.exitCode = 1 }
  }
}

main()
