const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '../miniprogram')
const template = './pages/moments/moments.wxml'
const devToolsCompiler = '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcc'
const bundledCompiler = { darwin: 'mac/wcc', linux: 'linux/wcc', win32: 'windows/wcc.exe' }[process.platform]
let compiler = process.env.WXML_COMPILER
if (!compiler && process.platform === 'darwin' && existsSync(devToolsCompiler)) compiler = devToolsCompiler
if (!compiler && bundledCompiler) {
  compiler = require.resolve(`miniprogram-compiler/bin/${bundledCompiler}`)
  // npm can unpack the bundled binaries without their executable bit.
  if (process.platform !== 'win32') {
    const mode = statSync(compiler).mode & 0o777
    if ((mode & 0o100) === 0) chmodSync(compiler, mode | 0o100)
  }
}
assert.ok(compiler, 'Set WXML_COMPILER to the path of a WeChat WXML compiler')
const context = vm.createContext({ window: {}, console })
vm.runInContext(execFileSync(compiler, [template], { cwd: root, encoding: 'utf8' }), context)
const render = context.$gwx(template)
const css = readFileSync(path.join(root, 'pages/moments/moments.wxss'), 'utf8')

const localModules = new Set([
  'services/date', 'services/format', 'utils/moment-time', 'utils/moments-timeline', 'utils/tags',
])
function loadTs(file, globals = {}, stubs = {}) {
  const source = readFileSync(path.join(root, `${file}.ts`), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  const exports = {}
  vm.runInNewContext(outputText, {
    ...globals, exports,
    require(id) {
      if (Object.hasOwn(stubs, id)) return stubs[id]
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), id))
      assert.ok(localModules.has(dependency), `Unexpected import ${id} in ${file}`)
      return loadTs(dependency)
    },
  }, { filename: `${file}.ts` })
  return exports
}

const timeline = loadTs('utils/moments-timeline')
const preview = index => `https://preview.example.test/${index}.jpg`
const photos = count => Array.from({ length: count }, (_, index) => `cloud://test/photos/${index}.jpg`)
const previews = count => Array.from({ length: count }, (_, index) => preview(index))
const moment = (id, attributes = {}) => ({
  id, kind: 'post', authorOpenid: 'test-author', authorRole: 'A', location: null,
  createdAt: Date.UTC(2026, 10, 20, 12), momentDate: '2026-11-20', content: '一段测试回忆',
  // enrichMomentsList preserves the original IDs when signing returns no URLs.
  images: [], previewImages: [], coverUrl: '',
  ...attributes,
})

function nodes(node) {
  if (typeof node !== 'object' || !node) return []
  return [node, ...(node.children ?? []).flatMap(nodes)]
}
const byClass = (node, name) => nodes(node).filter(n => n.attr?.class?.split(/\s+/).includes(name))
const imageSources = node => nodes(node).filter(n => n.tag === 'wx-image').map(n => n.attr.src)
const text = node => (node.children ?? []).map(child => typeof child === 'string' ? child.trim() : text(child)).join('')

function renderPage(data) {
  return render({
    themeStyle: '', briefStats: { total: 0 }, viewMode: 'timeline', bootState: 'ready',
    rows: [], onThisDay: [], tagFilters: [], expandedTexts: {}, ...data,
  })
}

function renderMoment(item) {
  const rows = timeline.buildTimelineRows([item], 1, 0, 'A', '2026-01-01')
  const row = rows.find(row => row.type === 'moment')
  assert.ok(row)
  const cards = byClass(renderPage({ rows }), 'scene')
  assert.equal(cards.length, 1)
  return { scene: row.scene, card: cards[0] }
}

function loadPage(name, wx = {}, store = {}, overrides = {}) {
  let page
  loadTs(`pages/${name}/${name}`, { wx, Page: definition => { page = definition } }, {
    '../../app': {},
    '../../services/store': store,
    '../../services/page-boot': {},
    '../../services/moments-list-state': {},
    '../../services/moments-feed-cache': {},
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '' },
    '../../utils/cloud-url-cache': {},
    ...overrides,
  })
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      const field = parts.pop()
      const target = parts.reduce((object, part) => object[part], page.data)
      target[field] = value
    }
  }
  return page
}

function tap(page, node) {
  assert.equal(node.attr.bindtap, 'onTapScene')
  page[node.attr.bindtap]({ currentTarget: { dataset: { id: node.attr['data-id'] } } })
}

for (const count of [2, 5]) {
  test(`签链返回空数组与空封面：原有 ${count} 张照片`, t => {
    const id = `unsigned-${count}`
    const { card, scene } = renderMoment(moment(id, { images: photos(count) }))
    const twoColumnGrid = byClass(card, 'scene__bento--2').length > 0
    const gridColumns = twoColumnGrid ? css.match(/\.scene__bento--2\s*\{\s*grid-template-columns:\s*([^;]+)/)?.[1] : undefined
    const more = byClass(card, 'scene__frame-more').map(text).join(',')
    const placeholders = byClass(card, 'scene__photo-placeholder')
    t.diagnostic(`layout=${scene.layout} 拼贴列=${gridColumns || '无'} 胶片条=${byClass(card, 'scene__filmstrip').length} 缩略图=${imageSources(card).length} 溢出=${more || '无'} 照片占位=${placeholders.length}`)
    assert.equal(placeholders.length, 1)
    assert.match(text(placeholders[0]), /照片预览暂不可用.*查看详情/)
    assert.equal(byClass(card, 'scene__bento').length, 0)
    assert.equal(byClass(card, 'scene__filmstrip').length, 0)
    assert.equal(imageSources(card).length, 0)
    assert.equal(more, '')
    assert.equal(byClass(card, 'scene__caption').length, 1)

    const routes = []
    const page = loadPage('moments', { navigateTo: ({ url }) => routes.push(url) })
    page.data.filterTag = 'daily'
    tap(page, card)
    assert.deepEqual(routes, [`/pages/moment-detail/moment-detail?id=${id}&tag=daily`])
  })
}

test('实际预览数决定单图、拼贴列和胶片条，未签链原图不计入溢出', () => {
  for (const count of [1, 2, 3, 4, 5, 9]) {
    const signed = previews(count)
    const { scene, card } = renderMoment(moment(`partial-${count}`, { images: photos(15), previewImages: signed }))
    assert.equal(scene.layout, count === 1 ? 'cinema' : count < 5 ? 'collage' : 'reel')
    if (count >= 2 && count <= 4) assert.equal(byClass(card, `scene__bento--${count}`).length, 1)
    assert.deepEqual(imageSources(card), signed)
    assert.equal(byClass(card, 'scene__frame-more').length, 0)
    assert.equal(byClass(card, 'scene__photo-placeholder').length, 0)
  }

  const many = renderMoment(moment('many-signed', { images: photos(15), previewImages: ['', ...previews(11)] }))
  assert.deepEqual(imageSources(many.card), previews(9))
  assert.deepEqual(byClass(many.card, 'scene__frame-more').map(text), ['+2'])
  const coverOnly = renderMoment(moment('legacy-cover', { images: photos(5), coverUrl: preview(5) }))
  assert.equal(coverOnly.scene.layout, 'cinema')
  assert.deepEqual(imageSources(coverOnly.card), [preview(5)])
})

test('视频、实况、语音、纯文字及特别记录各自保持展示分支', () => {
  const base = { images: photos(5) }
  const video = { videos: ['cloud://test/video.mp4'] }
  const live = { livePhotos: [{ cover: 'cloud://test/live.jpg', video: 'cloud://test/live.mp4', duration: 2 }] }
  const fallback = attributes => renderMoment(moment('media', attributes)).card
  const videoCard = fallback({ ...base, ...live, ...video })
  assert.match(text(byClass(videoCard, 'scene__cinema-empty')[0]), /视频记录/)
  assert.equal(byClass(videoCard, 'scene__photo-placeholder').length, 0)
  const liveCard = fallback({ ...base, ...live })
  assert.match(text(byClass(liveCard, 'scene__cinema-empty')[0]), /实况照片/)
  assert.ok(byClass(liveCard, 'scene__badge').some(badge => text(badge) === '实况'))
  assert.equal(byClass(liveCard, 'scene__photo-placeholder').length, 0)
  const signedVideo = fallback({ ...video, coverUrl: preview(0) })
  assert.deepEqual(imageSources(signedVideo), [preview(0)])
  assert.equal(byClass(signedVideo, 'scene__cinema-play').length, 1)
  const signedLive = fallback({ ...live, previewImages: [preview(0)] })
  assert.deepEqual(imageSources(signedLive), [preview(0)])
  assert.ok(byClass(signedLive, 'scene__badge').some(badge => text(badge) === '实况'))
  const mixedVideo = fallback({ ...base, ...video, previewImages: previews(2) })
  assert.deepEqual(imageSources(mixedVideo), previews(2))
  assert.equal(byClass(mixedVideo, 'scene__bento-video-mark').length, 1)
  const voice = fallback({ voices: [{ fileID: 'cloud://test/voice', duration: 3 }] })
  assert.deepEqual(byClass(voice, 'scene__badge').map(text), ['语音 3″'])
  const verse = fallback({ content: '只有文字' })
  assert.deepEqual(byClass(verse, 'scene__verse-text').map(text), ['只有文字'])
  assert.equal(byClass(verse, 'scene__cinema').length, 0)
  assert.equal(byClass(verse, 'scene__caption').length, 0)
  assert.equal(byClass(fallback({ ...base, kind: 'system' }), 'scene__signal').length, 1)
})

test('月回顾使用真实页面数据与模板，保留封面、原占位及详情入口', async () => {
  const items = [
    moment('recap-signed', { images: photos(5), previewImages: [preview(0), preview(1)] }),
    moment('recap-unsigned', { images: photos(2), content: '回顾文字' }),
  ]
  const routes = []
  const page = loadPage('moments', { navigateTo: ({ url }) => routes.push(url) }, {
    getMomentsStats: async () => ({ total: 2, countA: 1, countB: 1, placeCount: 0 }),
    listMomentsPage: async () => ({ items, total: 2, hasMore: false }),
  })
  page.setData({ bootState: 'ready', viewMode: 'recap', recapYear: 2026, recapMonth: 11 })
  await page.loadRecap()
  const tree = renderPage(page.data)
  const panel = byClass(tree, 'recap-panel')[0]
  const grid = byClass(panel, 'recap-photo-grid')[0]
  assert.deepEqual(imageSources(grid), [preview(0)])
  assert.deepEqual(byClass(grid, 'recap-photo-placeholder').map(text), ['回顾文字'])
  assert.equal(byClass(grid, 'scene__photo-placeholder').length, 0)
  assert.deepEqual(byClass(panel, 'recap-cover__number').map(text), ['2'])
  assert.equal(byClass(tree, 'reel-stream').length, 0)
  grid.children.forEach(node => tap(page, node))
  assert.deepEqual(routes, items.map(item => `/pages/moment-detail/moment-detail?id=${item.id}`))
})

test('详情的好友分享和朋友圈分享仍用通用文案与静态封面', () => {
  const page = loadPage('moment-detail')
  const id = 'fixture~?&'
  page.momentId = id
  page.data.item = { id, content: '仅出现在详情的测试文字', images: [{ src: preview(0) }] }
  const expected = { title: '打开 Ours 查看回忆', imageUrl: '/assets/share-cover.png' }
  assert.deepEqual({ ...page.onShareAppMessage() }, {
    ...expected, path: `/pages/moment-detail/moment-detail?id=${encodeURIComponent(id)}`,
  })
  assert.deepEqual({ ...page.onShareTimeline() }, { ...expected, query: `id=${encodeURIComponent(id)}` })
})

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const emittedEvent = node => ({ currentTarget: { dataset: Object.fromEntries(
  Object.entries(node.attr).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5), value]),
) } })
const pageOf = (items, total = items.length, nextCursor) => ({ items, total, hasMore: Boolean(nextCursor), nextCursor })

function timelinePage(store, wx = {}) {
  return loadPage('moments', { showToast() {}, stopPullDownRefresh() {}, vibrateShort() {}, ...wx }, {
    getIdentity: () => ({ role: 'A', openid: 'test-author' }),
    getCouple: () => ({ id: 'fixture-space', startDate: '2026-01-01' }),
    getMomentsBriefStats: async () => ({ total: 0 }), getOnThisDayMoments: async () => [],
    ...store,
  }, {
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
    '../../services/moments-list-state': {
      peekMomentsListStale: () => false, consumeMomentsListStale: () => false,
      takeMomentsContext: () => null, consumeMomentsScrollTop: () => 0,
    },
    '../../services/moments-feed-cache': { feedCacheKey: () => '', takePrefetchedFeed: async () => null },
  })
}

test('原生 error 驱动单图、拼贴和胶片布局，过期回调不覆盖刷新后的缩略图', async () => {
  for (const count of [1, 3, 6]) {
    const id = `native-${count}`
    let urls = previews(count)
    const routes = []
    const page = timelinePage({ listMomentsPage: async () => pageOf([moment(id, { images: photos(count), previewImages: urls })]) }, {
      navigateTo: ({ url }) => routes.push(url),
    })
    await page.onShow()
    const card = () => byClass(renderPage(page.data), 'scene')[0]
    const firstImage = () => nodes(card()).find(node => node.tag === 'wx-image')
    const obsolete = firstImage()
    assert.equal(obsolete.attr.binderror, 'onPreviewError')
    let remaining = count
    while (remaining--) {
      const image = firstImage()
      page[image.attr.binderror](emittedEvent(image))
      assert.equal(imageSources(card()).length, remaining)
    }
    assert.equal(byClass(card(), 'scene__photo-placeholder').length, 1)
    tap(page, card())
    assert.deepEqual(routes, [`/pages/moment-detail/moment-detail?id=${id}`])
    urls = [preview(99)]
    await page.onPullDownRefresh()
    page[obsolete.attr.binderror](emittedEvent(obsolete))
    assert.deepEqual(imageSources(card()), urls)
  }
})

test('月回顾下拉只刷新所选月，失败仍能看上次卡片，点击错误横幅重新请求', async () => {
  const requests = []
  let monthResult = pageOf([moment('recap-cached', { images: photos(1), previewImages: previews(1) })])
  const page = timelinePage({
    getMomentsStats: async () => ({ total: 1, countA: 1, countB: 0, placeCount: 0 }),
    listMomentsPage: async options => {
      requests.push({ ...options })
      if (options.month !== 11) return pageOf([])
      if (!monthResult) throw new Error('回顾离线')
      return monthResult
    },
  })
  await page.onShow()
  page.setData({ recapYear: 2026, recapMonth: 11, recapYears: [] })
  const tree = () => renderPage(page.data)
  const recapTab = byClass(tree(), 'seg-sticker').find(node => node.attr['data-mode'] === 'recap')
  page[recapTab.attr.bindtap](emittedEvent(recapTab))
  await tick()
  const grid = () => byClass(tree(), 'recap-photo-grid')[0]
  const image = nodes(grid()).find(node => node.tag === 'wx-image')
  assert.equal(image.attr.binderror, 'onPreviewError')
  page[image.attr.binderror](emittedEvent(image))
  assert.equal(byClass(grid(), 'recap-photo-placeholder').length, 1)
  requests.length = 0
  monthResult = null
  await page.onPullDownRefresh()
  assert.deepEqual(requests.map(request => [request.year, request.month]), [[2026, 11]])
  assert.ok(grid())
  assert.match(page.data.secondaryError, /当前显示该月缓存/)
  const retry = byClass(tree(), 'err-banner').find(node => node.attr.bindtap === 'onRetrySecondary')
  monthResult = pageOf([moment('recap-recovered')])
  page[retry.attr.bindtap]()
  await tick()
  assert.deepEqual(requests.map(request => [request.year, request.month]), [[2026, 11], [2026, 11]])
  assert.equal(grid().children[0].attr['data-id'], 'recap-recovered')
  assert.equal(page.data.secondaryError, '')
})

test('尾页失败渲染重试入口，点击沿用原游标和偏移并移除提示', async () => {
  const cursor = { momentDate: '2026-11-20', createdAt: 1, id: 'a' }
  const requests = []
  const firstPage = Array.from({ length: 20 }, (_, index) => moment(`a${index}`))
  const page = timelinePage({ listMomentsPage: async options => {
    requests.push(options)
    if (requests.length === 1) return pageOf(firstPage, 21, cursor)
    if (requests.length === 2) throw new Error('尾页返回失败')
    return pageOf([moment('b')])
  } })
  await page.onShow()
  await page.onReachBottom()
  assert.equal(page.data.skip, 20)
  const retry = nodes(renderPage(page.data)).find(node => node.attr?.bindtap === 'onRetryMore')
  assert.ok(retry)
  await page[retry.attr.bindtap]()
  assert.deepEqual([requests[2].cursor, requests[2].skip], [cursor, 20])
  assert.equal(page.data.skip, 21)
  assert.equal(page.data.loadMoreError, '')
  assert.ok(byClass(renderPage(page.data), 'scene').some(node => node.attr['data-id'] === 'b'))
})

test('时间线点赞回包按 ID 回写，读取晚到、刷新重排及下一次写入失败都保留正确计数', async () => {
  const requests = []
  const writes = []
  const page = timelinePage({
    listMomentsPage: () => { const request = deferred(); requests.push(request); return request.promise },
    setMomentLike: (id, liked) => { const request = deferred(); writes.push({ request, id, liked }); return request.promise },
  })
  const a = moment('a')
  const b = moment('b')
  const show = page.onShow()
  await tick()
  requests.shift().resolve(pageOf([a, b]))
  await show
  const button = id => byClass(renderPage(page.data), 'scene__pulse-like').find(node => node.attr['data-id'] === id)
  const scene = id => page.data.rows.find(row => row.type === 'moment' && row.scene.id === id).scene
  const tapLike = id => {
    const control = button(id)
    return page[control.attr.catchtap](emittedEvent(control))
  }
  const firstWrite = tapLike('a')
  const rewriting = page.onPullDownRefresh()
  await tick()
  const first = writes.shift()
  assert.deepEqual([first.id, first.liked], ['a', true])
  first.request.resolve({ likedByA: true, likedByB: true, count: 2 })
  await firstWrite
  requests.shift().resolve(pageOf([b, a]))
  await rewriting
  assert.deepEqual([scene('a').likedByMe, scene('a').likeCount, scene('b').likeCount], [true, 2, 0])
  const secondWrite = tapLike('a')
  const latestRefresh = page.onPullDownRefresh()
  await tick()
  requests.shift().resolve(pageOf([{ ...a, likedByMe: true, likeCount: 1 }, b]))
  await latestRefresh
  assert.deepEqual([scene('a').likedByMe, scene('a').likeCount], [false, 0])
  const second = writes.shift()
  assert.deepEqual([second.id, second.liked], ['a', false])
  second.request.reject(new Error('取消失败'))
  await secondWrite
  assert.deepEqual([scene('a').likedByMe, scene('a').likeCount], [true, 1])
})


test('时间线打开详情后，两页接收迟到的点赞成功回包并忽略较早读取', async () => {
  const listeners = new Map()
  const channel = {
    on(name, fn) { listeners.set(name, fn) },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
    emit(name, ...args) { listeners.get(name)?.(...args) },
  }
  const read = deferred()
  const writeFromList = deferred()
  const writeFromDetail = deferred()
  const record = moment('shared')
  let opening
  const detail = loadPage('moment-detail', { vibrateShort() {} }, {
    getIdentity: () => ({ role: 'A' }), getMoment: async () => record,
    listComments: async () => [], getMomentLikes: () => read.promise,
    getMomentNeighbors: async () => ({ index: 1, total: 1 }),
    setMomentLike(id, liked) { assert.deepEqual([id, liked], ['shared', false]); return writeFromDetail.promise },
  }, {
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/moments-list-state': { markMomentsListStale() {} },
  })
  detail.getOpenerEventChannel = () => channel
  const feed = timelinePage({
    listMomentsPage: async () => pageOf([record]),
    setMomentLike(id, liked) { assert.deepEqual([id, liked], ['shared', true]); return writeFromList.promise },
  }, {
    navigateTo({ url, events, success }) {
      assert.equal(url, '/pages/moment-detail/moment-detail?id=shared')
      for (const [name, fn] of Object.entries(events)) channel.on(name, fn)
      success({ eventChannel: channel })
      opening = detail.onLoad({ id: 'shared' })
    },
  })
  await feed.onShow()
  const card = byClass(renderPage(feed.data), 'scene')[0]
  const like = byClass(card, 'scene__pulse-like')[0]
  const listWrite = feed[like.attr.catchtap](emittedEvent(like))
  tap(feed, card)
  await tick()
  writeFromList.resolve({ likedByA: true, likedByB: true, count: 2 })
  await listWrite
  read.resolve({ likedByA: false, likedByB: false, count: 0 })
  await opening
  assert.deepEqual([detail.data.liked, detail.data.likeCount], [true, 2])

  const detailWrite = detail.onToggleLike()
  detail.onUnload()
  await feed.onShow()
  writeFromDetail.resolve({ likedByA: false, likedByB: true, count: 1 })
  await detailWrite
  const scene = feed.data.rows.find(row => row.type === 'moment').scene
  assert.deepEqual([scene.likedByMe, scene.likeCount], [false, 1])
})
