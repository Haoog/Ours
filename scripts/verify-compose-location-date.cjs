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

const compose = compile('miniprogram/pages/compose/compose.ts')
const date = compile('miniprogram/services/date.ts')
const momentTime = compile('miniprogram/utils/moment-time.ts')
const location = { name: '公园', address: '路口', latitude: 0, longitude: 120 }
const replacement = { name: '车站', address: '站前路', latitude: 30, longitude: 0 }
const legacy = { content: '旧正文', momentDate: '2024-02-29', tag: 'daily', authorRole: 'A', location,
  images: ['cloud://fixture/photo.gif'], videos: ['cloud://fixture/video.mp4'] }

async function open({ edit = true, now = '2026-11-20T12:00:00Z', tz = 'Asia/Shanghai', startDate = '2026-01-01', draft = null } = {}) {
  process.env.TZ = tz
  let time = Date.parse(now)
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])) }
    static now() { return time }
  }
  const dateExports = {}, momentTimeExports = {}
  date.runInNewContext({ exports: dateExports, Date: Clock })
  momentTime.runInNewContext({ exports: momentTimeExports, Date: Clock, require: () => dateExports })
  let page, departed = false
  const picks = [], modals = [], toasts = [], settings = [], edits = [], posts = []
  const session = { status: 'ready', role: 'A', coupleId: 'test-space', openid: 'test-author' }
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReady: async () => true },
    '../../services/session': { getSession: () => session },
    '../../services/store': {
      getIdentity: () => session, getCouple: () => ({ startDate }), getMoment: async () => legacy,
      updateMoment: async (id, patch) => edits.push([id, structuredClone(patch)]),
      addMoment: async input => posts.push(structuredClone(input)),
    },
    '../../services/compose-draft': {
      newPublishId: () => 'request-id', readComposeDraft: () => draft, waitForComposeDraftSave: async () => {},
      saveComposeDraft: async () => {}, clearComposeDraft() {},
    },
    '../../services/date': dateExports,
    '../../utils/moment-time': momentTimeExports,
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/moments-list-state': { markMomentsListStale() {} },
    '../../services/moments-feed-cache': { feedCacheKey() {}, prefetchMomentsFeed() {} },
    '../../utils/tags': { MOMENT_TAG_POST: [] },
  }
  compose.runInNewContext({
    Page: definition => { page = { ...definition, data: structuredClone(definition.data) } },
    require: name => modules[name] || {}, exports: {}, Date: Clock,
    setTimeout: () => 1, clearTimeout() {},
    wx: {
      getSystemInfoSync: () => ({ platform: 'ios' }), setNavigationBarTitle() {},
      getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {} }),
      chooseLocation: options => picks.push(options), showModal: options => modals.push(options),
      openSetting: options => settings.push(options), showToast: options => toasts.push(options.title),
    },
  })
  page.setData = values => {
    assert.equal(departed, false, 'a native callback must not update an unloaded compose page')
    Object.assign(page.data, values)
  }
  await page.onLoad(edit ? { id: 'record' } : {})
  page.onShow()
  return { page, picks, modals, toasts, settings, edits, posts,
    unload() { page.onUnload(); departed = true }, advance: value => { time = Date.parse(value) } }
}

const pickDate = (page, value) => page.onPickMomentDate({ detail: { value } })
const denied = { errMsg: 'chooseLocation:fail auth deny' }
const westward = { tz: 'America/Los_Angeles', now: '2026-11-20T16:05:00Z' }

const cases = {
  async 'clear or retry wins over old location callbacks'() {
    const { page, picks, edits, modals } = await open()
    page.onPickLocation()
    page.onHide()
    page.onShow()
    page.onClearLocation()
    picks[0].success(replacement)
    assert.equal(page.data.locationFull, null, 'late success must not undo Clear')
    assert.equal(page.data.location, '')
    await page.onSubmit()
    assert.deepEqual(edits, [['record', { location: null }]])

    const retry = await open()
    retry.page.onPickLocation()
    retry.page.onPickLocation()
    retry.picks[1].success(replacement)
    retry.picks[0].fail(denied)
    assert.equal(retry.page.data.locationFull.longitude, 0)
    assert.equal(retry.page.data.location, replacement.name)
    assert.equal(retry.modals.length, 0, 'superseded failure must not open a permission dialog')
    assert.equal(modals.length, 0)
  },
  async 'location callbacks do not outlive the page'() {
    const { page, picks, modals, unload } = await open()
    page.onPickLocation()
    unload()
    picks[0].fail(denied)
    assert.equal(modals.length, 0, 'late failure must not show over the next page')

    const late = await open()
    late.page.onPickLocation()
    late.unload()
    late.picks[0].success(replacement)
  },
  async 'permission flow does not act after clear or unload'() {
    const { page, picks, modals, settings, toasts, unload } = await open()
    page.onPickLocation()
    picks[0].fail(denied)
    page.onClearLocation()
    modals[0].success({ confirm: true })
    assert.equal(settings.length, 0, 'obsolete permission confirmation must not open settings')
    page.onPickLocation()
    picks[1].fail(denied)
    modals[1].success({ confirm: true })
    assert.equal(settings.length, 1)
    unload()
    settings[0].fail()
    assert.deepEqual(toasts, [], 'settings failure must not toast over the next page')
  },
  async 'return from picker preserves form and accepts the active result in either order'() {
    const { page, picks, modals, toasts } = await open()
    page.onPickLocation()
    page.onHide()
    picks[0].fail({ errMsg: 'chooseLocation:fail cancel' })
    page.onShow()
    assert.deepEqual([modals.length, toasts.length, page.data.locationFull], [0, 0, location])
    page.onPickLocation()
    page.onHide()
    page.onShow()
    picks[1].fail({ errMsg: 'chooseLocation:fail network error' })
    assert.deepEqual(toasts, ['地点选择失败，请重试'])
    assert.deepEqual(page.data.locationFull, location)
    assert.equal(page.data.momentDate, legacy.momentDate)
    for (const beforeShow of [true, false]) {
      page.onPickLocation()
      page.onHide()
      const result = beforeShow ? replacement : location
      if (beforeShow) picks.at(-1).success(result)
      page.onShow()
      if (!beforeShow) picks.at(-1).success(result)
      assert.deepEqual(structuredClone(page.data.locationFull), result)
    }
  },
  async 'UTC+8 date limit prevents a future default on an eastward device'() {
    const { page, posts } = await open({ edit: false, tz: 'Asia/Tokyo', now: '2026-11-20T15:30:00Z' })
    page.onContentInput({ detail: { value: '新的回忆' } })
    await page.onSubmit()
    assert.equal(posts[0].momentDate, '2026-11-20', 'at 00:30 in Tokyo, Nov 21 in the payload is still future in Shanghai')
    assert.equal(page.data.maxMomentDate, '2026-11-20')
  },
  async 'date limit refreshes across midnight without rewriting a selected date'() {
    const { page, edits, advance } = await open({ now: '2026-11-20T15:59:00Z' })
    assert.equal(page.data.minMomentDate, '2026-01-01')
    assert.equal(page.data.momentDate, legacy.momentDate)
    pickDate(page, '2026-11-20')
    assert.equal(page.data.momentDateLabel, '今天')
    page.onHide()
    advance('2026-11-20T16:01:00Z')
    page.onShow()
    assert.equal(page.data.maxMomentDate, '2026-11-21', 'returning after midnight must unlock the new day')
    assert.equal(page.data.momentDate, '2026-11-20')
    assert.equal(page.data.momentDateLabel, '2026年11月20日')
    pickDate(page, '2026-11-21')
    await page.onSubmit()
    assert.deepEqual(edits, [['record', { momentDate: '2026-11-21' }]])
  },
  async 'westward default publishes local today when it is within range'() {
    const { page, posts } = await open({ ...westward, edit: false })
    assert.equal(page.data.momentDate, '2026-11-20')
    assert.equal(page.data.maxMomentDate, '2026-11-21')
    page.onContentInput({ detail: { value: '当地今天的回忆' } })
    await page.onSubmit()
    assert.deepEqual(posts.map(post => post.momentDate), ['2026-11-20'])
  },
  async 'westward default publishes the start date when local today is too early'() {
    const { page, posts } = await open({ ...westward, edit: false, startDate: '2026-11-21' })
    page.onContentInput({ detail: { value: '第一天的回忆' } })
    await page.onSubmit()
    assert.deepEqual(posts.map(post => post.momentDate), ['2026-11-21'], 'default publish must not precede the start date')
    assert.deepEqual([page.data.minMomentDate, page.data.momentDate, page.data.maxMomentDate],
      ['2026-11-21', '2026-11-21', '2026-11-21'])
  },
  async 'a restored draft keeps its date outside the current picker bounds'() {
    const draft = { requestId: 'draft', content: '以前的草稿', momentDate: '2026-11-20',
      images: [], livePhotos: [], video: '', videoCover: '', voice: null }
    const { page } = await open({ ...westward, edit: false, startDate: '2026-11-21', draft })
    assert.equal(page.data.momentDate, draft.momentDate)
  },
  async 'editing old fields does not rewrite media or date'() {
    const old = await open({ ...westward, startDate: '2026-11-21' })
    assert.equal(old.page.data.momentDate, legacy.momentDate)
    old.page.onPickTag({ currentTarget: { dataset: { key: 'travel' } } })
    await old.page.onSubmit()
    assert.deepEqual(old.edits, [['record', { tag: 'travel' }]])
    assert.deepEqual(old.page.data.images, legacy.images)
    assert.equal(old.page.data.video, legacy.videos[0])
  },
}

async function main() {
  for (const [name, check] of Object.entries(cases)) {
    try { await check(); console.log(`PASS: ${name}`) }
    catch (error) { console.error(`FAIL: ${name}\n${error.stack}`); process.exitCode = 1 }
  }
}

main()
