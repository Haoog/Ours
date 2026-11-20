const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '..')
const cloudSource = fs.readFileSync(path.join(root, 'cloudfunctions/ours/index.js'), 'utf8')
const placeA = { id: '-31.2813,121.1234', name: '第一站', latitude: -31.28125, longitude: 121.1234, momentCount: 1 }
const placeB = { id: '30.0000,120.0000', name: '第二站', latitude: 30, longitude: 120, momentCount: 1 }
const url = name => `https://media.test/${name}.jpg`
const file = name => `cloud://test.bucket/moments/space/images/${name}.jpg`
const places = (...items) => ({ places: items, cities: [] })
const story = (place, name) => ({ ...place, latestMomentId: name, latestMomentCoverFileID: file(name) })
const tap = id => ({ currentTarget: { dataset: { id } } })
const flush = () => new Promise(resolve => setImmediate(resolve))
const tempURLs = fileList => ({ fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: url(path.basename(fileID, '.jpg')) })) })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function post(place, id, momentDate, media = {}) {
  const { name, latitude, longitude } = place
  return { _id: id, coupleId: 'space', kind: 'post', momentDate, createdAt: 1728720000000,
    location: { name, latitude, longitude, address: '上海市' }, ...media }
}

function mockCloud(moments) {
  const records = { couples: [{ _id: 'space', memberA: { openid: 'owner' } }], moments }
  const signing = []
  const db = {
    command: { set: value => value },
    runTransaction: run => run(db),
    collection(name) {
      assert.ok(records[name], `Unexpected collection ${name}`)
      return {
        doc(id) {
          const row = records[name].find(row => row._id === id)
          return {
            get: async () => ({ data: structuredClone(row) }),
            update: async ({ data }) => Object.assign(row, structuredClone(data)),
          }
        },
        where: filters => ({
          orderBy: () => ({ limit: limit => ({ get: async () => ({
            data: records[name].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
              .sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit),
          }) }) }),
        }),
      }
    },
  }
  const sdk = {
    init() {},
    getWXContext: () => ({ OPENID: 'owner' }),
    database: () => db,
    async getTempFileURL({ fileList }) {
      signing.push(Array.from(fileList))
      return sign(fileList)
    },
  }
  let sign = tempURLs
  const warnings = []
  const exports = {}
  vm.runInNewContext(cloudSource, { exports, console: { ...console, warn: (...args) => warnings.push(args) },
    require: id => id === 'wx-server-sdk' ? sdk : require(id) })
  return {
    signing, warnings,
    setSigner(fn) { sign = fn },
    async call(action, payload = { coupleId: 'space' }) {
      const result = await exports.main({ action, payload })
      assert.equal(result.ok, true, result.error)
      return structuredClone(result.data)
    },
  }
}

const source = new Map()
function loadTS(fileName, modules, globals = {}) {
  if (!source.has(fileName)) {
    const input = fs.readFileSync(path.join(root, `miniprogram/${fileName}.ts`), 'utf8')
    source.set(fileName, ts.transpileModule(input, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    } }).outputText)
  }
  const exports = {}
  vm.runInNewContext(source.get(fileName), {
    ...globals, exports, require(id) {
      assert.ok(Object.hasOwn(modules, id), `Unexpected dependency ${id} from ${fileName}`)
      return modules[id]
    },
  }, { filename: fileName })
  return exports
}

function mount(respond, sign = tempURLs) {
  let spaceId = 'space'
  let readiness = 'ready'
  const session = {
    coupleId: () => spaceId,
    getSession: () => ({ coupleId: spaceId, status: 'ready', openid: 'owner' }),
  }
  const calls = [], signing = [], toasts = [], navigation = [], contexts = []
  const cloud = { callOurs(action, payload) {
    const input = structuredClone(payload)
    calls.push([action, input])
    return respond(action, input)
  } }
  const wx = {
    getStorageSync: () => null,
    cloud: { async getTempFileURL({ fileList }) {
      const ids = Array.from(fileList)
      signing.push(ids)
      return sign(ids)
    } },
    navigateTo: ({ url }) => navigation.push(url),
    switchTab: ({ url }) => navigation.push(url),
    showToast: ({ title }) => toasts.push(title),
  }
  const cloudURLCache = loadTS('utils/cloud-url-cache', { '../services/cloud-api': cloud, '../services/session': session }, {
    wx, setTimeout: () => 1,
  })
  const store = loadTS('services/store', {
    './cloud-api': cloud, './session': session, './date': {}, './upload-cleanup': {},
    '../utils/async-pool': {}, '../utils/cloud-url-cache': cloudURLCache,
  }, { wx })
  const shared = {
    '../../services/store': store, '../../services/session': session,
    '../../utils/cloud-url-cache': cloudURLCache,
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => '', syncTheme() {} },
    '../../services/moments-list-state': { openMomentsContext: context => contexts.push(structuredClone(context)) },
    '../../services/page-boot': { ensureCloudReady: async () => readiness === 'ready', ensureCloudReadyState: async () => readiness },
  }
  function page(fileName, deps) {
    let page
    loadTS(fileName, { ...shared, ...deps }, { wx, Page: definition => { page = definition } })
    page.setData = patch => Object.assign(page.data, structuredClone(patch))
    return page
  }
  return {
    calls, signing, toasts, navigation, contexts,
    changeSpace: id => { spaceId = id },
    setReadiness: state => { readiness = state },
    map: () => page('subpages/map/map', { '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) } }),
    moments: () => page('pages/moments/moments', {
      '../../utils/tags': { MOMENT_TAG_FILTERS: [] }, '../../utils/moments-timeline': {}, '../../services/moments-feed-cache': {},
    }),
  }
}

test('cloud exposes the original latest photo, Live Photo or video cover and only skips signing on opt-in', async () => {
  const none = { ...placeB, latitude: 31 }
  const direct = { ...placeB, latitude: 32 }
  const video = { ...placeB, latitude: 33 }
  const cloud = mockCloud([
    post(placeA, 'older', '2024-10-10', { images: [file('older')] }),
    post(placeA, 'photo', '2024-10-12', { images: [file('photo'), file('second-photo')], livePhotos: [{ cover: file('unused-live') }] }),
    post(placeB, 'live', '2024-10-11', { livePhotos: [{ cover: file('live') }], videoCover: file('unused-video') }),
    post(none, 'none', '2024-10-09'),
    post(direct, 'direct', '2024-10-08', { images: [url('direct')] }),
    post(video, 'video', '2024-10-07', { videoCover: file('video'), videos: [file('not-the-cover')] }),
  ])
  const row = p => [p.latestMomentId, p.latestMomentCoverFileID, p.latestMomentCover]
  const optedIn = await cloud.call('listMapPlaces', { coupleId: 'space', deferCoverUrls: true })
  assert.deepEqual(cloud.signing, [])
  assert.deepEqual(optedIn.places.map(row), [
    ['photo', file('photo'), ''], ['live', file('live'), ''], ['none', '', ''],
    ['direct', url('direct'), url('direct')], ['video', file('video'), ''],
  ])
  assert.equal(optedIn.places[0].id, placeA.id)
  assert.equal(optedIn.places[0].latitude, placeA.latitude)
  assert.equal(optedIn.places[0].momentCount, 2)
  assert.equal(optedIn.places.at(-1).latestMomentHasVideo, true)

  const legacy = await cloud.call('listMapPlaces')
  const latestFileIDs = [file('photo'), file('live'), file('video')]
  assert.deepEqual(cloud.signing, [latestFileIDs])
  assert.deepEqual(legacy.places.map(p => p.latestMomentCover), [url('photo'), url('live'), '', url('direct'), url('video')])
  cloud.setSigner(() => ({ fileList: [{ fileID: file('photo'), status: -1, tempFileURL: url('invalid') }] }))
  assert.deepEqual((await cloud.call('listMapPlaces')).places.map(row), optedIn.places.map(row))
  cloud.setSigner(() => { throw new Error('mock signing failure') })
  assert.deepEqual((await cloud.call('listMapPlaces')).places.map(row), optedIn.places.map(row))
  assert.deepEqual(cloud.signing, [latestFileIDs, latestFileIDs, latestFileIDs])
  assert.deepEqual(cloud.warnings, [['resolveFileUrls', 'mock signing failure']])
})

test('footprint connects the real cloud result, store, single-file resolver and selected story', async () => {
  const cloud = mockCloud([
    post(placeA, 'first', '2024-10-12', { images: [file('first'), file('unused')] }),
    post(placeB, 'second', '2024-10-11', { images: [file('second')] }),
  ])
  cloud.setSigner(() => { throw new Error('mock signing failure') })
  const app = mount(cloud.call)
  const map = app.map()
  map.onLoad()
  await map.onShow()
  await flush()
  assert.deepEqual(app.calls, [['listMapPlaces', { coupleId: 'space', deferCoverUrls: true }]])
  assert.deepEqual(app.signing, [[file('first')]])
  assert.deepEqual(cloud.signing, [])
  assert.equal(map.data.selectedPlace.latestCover, url('first'))
  map.onSelectMapPlace({ detail: { id: placeB.id } })
  await flush()
  assert.deepEqual(app.signing, [[file('first')], [file('second')]])
  assert.equal(map.data.selectedPlace.latestCover, url('second'))
  map.onTapStory()
  map.onTapPlace(tap(placeA.id))
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('first'))
  assert.equal(app.signing.length, 2, 'reselection reuses the existing media cache')
  map.onOpenPlace()
  assert.deepEqual(app.contexts, [{ locationKey: placeA.id, label: placeA.name }])
  assert.deepEqual(app.navigation, ['/pages/moment-detail/moment-detail?id=second', '/pages/moments/moments'])
})

test('late cover results respect both the selected place and its latest moment across refresh and unload', async () => {
  let data = places(story(placeA, 'a'), story(placeB, 'b-old'))
  const pending = new Map()
  const app = mount(async action => {
    assert.equal(action, 'listMapPlaces')
    return data
  }, ([id]) => {
    const request = deferred()
    pending.set(id, request)
    return request.promise
  })
  const map = app.map()
  const finish = async (name) => {
    pending.get(file(name)).resolve(tempURLs([file(name)]))
    await flush()
  }
  await map.refresh()
  map.onTapPlace(tap(placeB.id))
  await finish('a')
  assert.equal(map.data.selectedPlaceId, placeB.id)
  assert.equal(map.data.selectedPlace.latestCover, '')
  data = places(story(placeA, 'a'), story(placeB, 'b-new'))
  await map.refresh()
  await finish('b-new')
  await finish('b-old')
  assert.equal(map.data.selectedPlace.latestMomentId, 'b-new')
  assert.equal(map.data.selectedPlace.latestCover, url('b-new'))

  data = places({ ...story(placeB, 'b-new'), latestMomentCoverFileID: file('edited') })
  await map.refresh()
  data = places({ ...story(placeB, 'b-new'), latestMomentCoverFileID: file('edited-again') })
  await map.refresh()
  await finish('edited-again')
  await finish('edited')
  assert.equal(map.data.selectedPlace.latestCover, url('edited-again'))

  data = places(story(placeB, 'before-space-change'))
  await map.refresh()
  app.changeSpace('other')
  await finish('before-space-change')
  assert.equal(map.data.selectedPlace.latestCover, '')

  data = places(story(placeB, 'before-unload'))
  await map.refresh()
  map.onUnload()
  await finish('before-unload')
  assert.equal(map.data.selectedPlace.latestCover, '')
  assert.deepEqual(app.toasts, [])
})

test('old cloud URLs and raw cover fields work, and an old empty cover recovers via the selected detail', async () => {
  const alias = { ...placeA, latestMomentId: 'alias', latestMomentCover: '', latestMomentCoverUrl: url('alias') }
  const raw = { ...placeB, latestMomentId: 'raw', latestMomentCover: file('raw') }
  let data = places(alias, raw)
  const app = mount(async (action, payload) => {
    if (action === 'listMapPlaces') return data
    assert.equal(action, 'getMoment')
    assert.equal(payload.momentId, 'blank')
    return { id: 'blank', location: placeB, videos: [file('video')], videoCover: file('video-cover') }
  })
  const map = app.map()
  await map.refresh()
  assert.equal(map.data.selectedPlace.latestCover, url('alias'))
  assert.deepEqual(app.signing, [])
  map.onTapPlace(tap(placeB.id))
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('raw'))

  data = places({ ...placeB, latestMomentId: 'blank', latestMomentCover: '' })
  await map.refresh()
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('video-cover'))
  assert.equal(map.data.selectedPlace.latestHasVideo, true)
  assert.deepEqual(app.calls.filter(([action]) => action !== 'listMapPlaces'), [['getMoment', { coupleId: 'space', momentId: 'blank' }]])
  assert.deepEqual(app.signing, [[file('raw')], [file('video-cover')]])

  data = places({ ...placeB, latestMomentId: 'empty', latestMomentCover: '', latestMomentCoverFileID: '' })
  await map.refresh()
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, '')
  assert.equal(app.calls.filter(([action]) => action === 'getMoment').length, 1)
  assert.equal(app.signing.length, 2)
})

test('missing legacy stories use the exact selected location and ignore late detail or list results', async () => {
  const detail = deferred()
  const lookup = deferred()
  const latestB = { id: 'real-b', location: { latitude: '30', longitude: '120' }, images: [file('real-b')] }
  const wrong = { id: 'nearby', location: { ...placeB, latitude: 30.00005 }, images: [file('nearby')] }
  let data = places({ ...placeA, latestMomentId: 'detail-a' }, placeB)
  const app = mount(async (action, payload) => {
    if (action === 'listMapPlaces') return data
    if (action === 'getMoment') return detail.promise
    assert.equal(action, 'listMoments')
    if (payload.locationKey === placeB.id) return [wrong]
    if (payload.locationKey === placeA.id) return lookup.promise
    if (!payload.skip) return { items: [wrong], hasMore: true }
    return { items: [latestB], hasMore: false }
  })
  const map = app.map()
  await map.refresh()
  map.onTapPlace(tap(placeB.id))
  await flush()
  assert.equal(map.data.selectedPlace.latestMomentId, 'real-b')
  assert.equal(map.data.selectedPlace.latestCover, url('real-b'))
  detail.resolve({ id: 'detail-a', location: placeA, images: [file('late-detail')] })
  await flush()
  assert.equal(map.data.selectedPlace.latestMomentId, 'real-b')
  data = places(placeA, story(placeB, 'fresh-b'))
  await map.refresh()
  map.onTapPlace(tap(placeA.id))
  map.onTapPlace(tap(placeB.id))
  lookup.resolve([{ id: 'late-list', location: placeA, images: [file('late-list')] }])
  await flush()
  assert.equal(map.data.selectedPlace.latestMomentId, 'fresh-b')
  assert.deepEqual(app.signing, [[file('real-b')], [file('fresh-b')]])
  assert.deepEqual(app.calls.filter(([action]) => action === 'listMoments').map(([, payload]) => payload), [
    { coupleId: 'space', limit: 1, skip: 0, locationKey: placeB.id },
    { coupleId: 'space', limit: 50, skip: 0 }, { coupleId: 'space', limit: 50, skip: 1 },
    { coupleId: 'space', limit: 1, skip: 0, locationKey: placeA.id },
  ])
})

test('failed media signing leaves the story usable and reselection retries only its cover', async () => {
  let healthy = false
  const app = mount(async action => {
    if (action === 'listMapPlaces') return places(story(placeA, 'retry'), story(placeB, 'untouched'))
    assert.equal(action, 'resolveMediaUrls')
    throw new Error('mock fallback signing failure')
  }, ids => healthy ? tempURLs(ids) : { fileList: [] })
  const map = app.map()
  await map.refresh()
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, '')
  map.onTapStory()
  assert.deepEqual(app.navigation, ['/pages/moment-detail/moment-detail?id=retry'])
  assert.deepEqual(app.calls.at(-1), ['resolveMediaUrls', { coupleId: 'space', fileIDs: [file('retry')] }])
  assert.deepEqual(app.signing, [[file('retry')], [file('retry')]])
  assert.deepEqual(app.toasts, [])

  healthy = true
  map.onTapPlace(tap(placeA.id))
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('retry'))
  assert.deepEqual(app.signing.at(-1), [file('retry')])
})

test('a failed legacy story lookup preserves the cover already in the response', async () => {
  const app = mount(async action => {
    if (action === 'listMapPlaces') return places({ ...placeA, latestMomentCoverUrl: file('known') })
    assert.equal(action, 'listMoments')
    throw new Error('mock list failure')
  })
  const map = app.map()
  await map.refresh()
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('known'))
  assert.deepEqual(app.signing, [[file('known')]])
})

test('a detail moved away from the selected location cannot supply its cover', async () => {
  const app = mount(async action => action === 'listMapPlaces'
    ? places({ ...placeA, latestMomentId: 'moved', latestMomentCover: '' })
    : { id: 'moved', location: placeB, images: [file('moved')] })
  const map = app.map()
  await map.refresh()
  await flush()
  assert.equal(map.data.selectedPlaceId, placeA.id)
  assert.equal(map.data.selectedPlace.latestCover, '')
  assert.deepEqual(app.signing, [])
})

test('the memories map uses the default protocol and supports historic cover and list responses', async () => {
  const cloud = mockCloud([
    post(placeA, 'latest-a', '2024-10-12', { images: [file('latest-a')] }),
    post(placeB, 'latest-b', '2024-10-11', { images: [file('latest-b')] }),
  ])
  const legacy = { ...placeA, latestMomentId: 'legacy-a', latestMomentCoverUrl: url('legacy-a') }
  let data
  const app = mount(async (action, payload) => {
    if (action === 'listMapPlaces') return data || cloud.call(action, payload)
    assert.equal(action, 'listMoments')
    return [{ id: 'legacy-b', location: placeB, images: [file('legacy-b')], content: '历史回忆' }]
  })
  const moments = app.moments()
  moments.setData({ viewMode: 'map' })
  await moments.loadMap()
  assert.deepEqual(app.calls, [['listMapPlaces', { coupleId: 'space' }]])
  assert.deepEqual(cloud.signing, [[file('latest-a'), file('latest-b')]])
  assert.equal(moments.data.selectedMapPlace.latestMomentCover, url('latest-a'))
  moments.onTapMapPlace(tap(placeB.id))
  assert.equal(moments.data.selectedMapPlace.latestMomentCover, url('latest-b'))
  assert.deepEqual(app.signing, [])

  data = places(legacy, placeB)
  await moments.loadMap()
  assert.equal(moments.data.selectedMapPlace.latestMomentCover, url('legacy-a'))
  moments.onSelectMapPlace({ detail: { id: placeB.id } })
  assert.equal(moments.data.selectedMapPlace.latestMomentCover, url('legacy-b'))
  assert.equal(moments.data.selectedMapPlace.latestMomentContent, '历史回忆')
  moments.onTapMapStory()
  assert.deepEqual(app.navigation, ['/pages/moment-detail/moment-detail?id=legacy-b'])
})


test('cold-open offline offers retry, reconnect loads the map and inactive sessions do not query', async () => {
  const app = mount(async () => places(story(placeA, 'first')))
  const map = app.map()
  map.onLoad()
  app.setReadiness('offline')
  await map.onShow()
  assert.equal(map.data.loading, false)
  assert.match(map.data.loadError, /连不上/)
  assert.equal(app.calls.length, 0)
  app.setReadiness('ready')
  await map.refresh()
  assert.equal(map.data.loadError, '')
  assert.equal(map.data.selectedPlaceId, placeA.id)
  assert.equal(app.calls.length, 1)
  app.setReadiness('redirecting')
  await map.refresh()
  assert.equal(map.data.loading, false)
  assert.equal(map.data.loadError, '')
  assert.equal(app.calls.length, 1)
})

function coverHandlers(map) {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/subpages/map/map.wxml'), 'utf8')
  const image = markup.match(/<image\s[^>]+>/)?.[0]
  assert.match(image, /wx:key="\*this"/)
  assert.match(image, /data-cover-attempt="{{item}}"/)
  const error = image.match(/\bbinderror="(\w+)"/)?.[1]
  const retry = markup.match(/\bcatchtap="(\w+)"/g)?.find(binding => /Cover/.test(binding))?.match(/"(\w+)"/)?.[1]
  assert.ok(error && retry, '封面错误和重试需要各自的模板入口')
  return {
    error(attempt = map.data.coverAttempt) {
      map[error]({ currentTarget: { dataset: { coverAttempt: attempt } } })
    },
    retry() { map[retry]() },
  }
}

test('原生图片报错后可单独重签，旧事件不能隐藏重试或另一站的封面', async () => {
  const signed = [url('expired'), url('renewed'), url('second')]
  const app = mount(async action => {
    assert.equal(action, 'listMapPlaces')
    return places(story(placeA, 'first'), story(placeB, 'second'))
  }, ([fileID]) => ({ fileList: [{ fileID, status: 0, tempFileURL: signed.shift() }] }))
  const map = app.map()
  map.onLoad()
  await map.onShow()
  await flush()
  const cover = coverHandlers(map)
  assert.equal(map.data.selectedPlace.latestCover, url('expired'))
  const previousAttempt = map.data.coverAttempt
  cover.error()
  assert.equal(map.data.coverFailed, true)
  cover.retry()
  assert.deepEqual(app.navigation, [])
  assert.equal(map.data.selectedPlace.latestCover, '')
  await flush()
  cover.error(previousAttempt)
  assert.equal(map.data.coverFailed, false)
  assert.equal(map.data.selectedPlace.latestCover, url('renewed'))
  assert.deepEqual(app.signing, [[file('first')], [file('first')]])
  const renewedAttempt = map.data.coverAttempt
  map.onTapStory()
  assert.deepEqual(app.navigation, ['/pages/moment-detail/moment-detail?id=first'])
  map.onTapPlace(tap(placeB.id))
  await flush()
  cover.error(renewedAttempt)
  assert.equal(map.data.selectedPlace.latestCover, url('second'))
  assert.equal(map.data.coverFailed, false)
  assert.deepEqual(app.signing, [[file('first')], [file('first')], [file('second')]])
})

test('旧直链若没有原始文件，原位重试会为相同 URL 重新渲染图片', async () => {
  const app = mount(async action => {
    assert.equal(action, 'listMapPlaces')
    return places({ ...placeA, latestMomentId: 'first', latestMomentCover: url('direct'), latestMomentCoverFileID: '' })
  })
  const map = app.map()
  await map.onShow()
  const cover = coverHandlers(map)
  const original = map.data.coverAttempt
  cover.error()
  assert.equal(map.data.coverFailed, true)
  cover.retry()
  assert.notEqual(map.data.coverAttempt, original)
  assert.equal(map.data.coverFailed, false)
  assert.equal(map.data.selectedPlace.latestCover, url('direct'))
  cover.error(original)
  assert.equal(map.data.coverFailed, false)
  assert.deepEqual(app.signing, [])
})

test('地图标记和气泡在刷新重排后仍选择原地，已移除标记的旧事件被忽略', async () => {
  const app = mount(async () => places(placeA, placeB))
  const page = app.map()
  await page.onShow()
  let definition
  const markup = fs.readFileSync(path.join(root, 'miniprogram/components/footprint-map/footprint-map.wxml'), 'utf8')
  loadTS('components/footprint-map/footprint-map', { '../../services/theme': { getMapTheme: () => ({ accent: '#897' }) } }, {
    Component(options) { definition = options },
  })
  const selections = []
  const map = {
    ...definition.methods,
    data: structuredClone(definition.data),
    properties: {},
    setData: patch => Object.assign(map.data, structuredClone(patch)),
    triggerEvent(name, detail) {
      assert.equal(name, 'select')
      selections.push(detail.id)
      page.onSelectMapPlace({ detail })
    },
  }
  const render = (input, selectedId) => {
    map.properties.places = input
    definition.observers['places, selectedId, themeId'].call(map, input, selectedId)
  }
  const nativeTap = (name, markerId) => {
    const handler = markup.match(new RegExp(`\\bbind:?${name}="(\\w+)"`))?.[1]
    assert.ok(handler, `${name} 缺少模板绑定`)
    map[handler]({ detail: { markerId } })
  }
  render([placeA, placeB], 'missing')
  const [first, second] = map.data.markers
  assert.equal(first.callout.display, 'ALWAYS')
  render([placeB, placeA], placeB.id)
  nativeTap('markertap', first.id)
  assert.equal(page.data.selectedPlaceId, placeA.id)
  nativeTap('callouttap', String(second.id))
  assert.equal(page.data.selectedPlaceId, placeB.id)
  render([placeB], placeB.id)
  nativeTap('markertap', first.id)
  render([], '')
  nativeTap('callouttap', second.id)
  assert.deepEqual(map.data.markers, [])
  assert.deepEqual(map.data.points, [])
  assert.deepEqual(selections, [placeA.id, placeB.id])
})

test('旧版封面坏链只补取所选故事，切站后等待中的重签不能覆盖当前封面', async () => {
  const pending = deferred()
  const app = mount(async (action, payload) => {
    if (action === 'listMapPlaces') return places(
      { ...placeA, latestMomentId: 'old-first', latestMomentCoverUrl: url('expired-legacy') },
      story(placeB, 'second'),
    )
    assert.equal(action, 'getMoment')
    assert.equal(payload.momentId, 'old-first')
    return { id: 'old-first', location: placeA, images: [file('old-first')] }
  }, ids => ids[0] === file('old-first') ? pending.promise : tempURLs(ids))
  const map = app.map()
  await map.onShow()
  const cover = coverHandlers(map)
  assert.equal(map.data.selectedPlace.latestCover, url('expired-legacy'))
  assert.deepEqual(app.signing, [])
  cover.error()
  cover.retry()
  await flush()
  assert.deepEqual(app.signing, [[file('old-first')]])
  assert.equal(map.data.selectedPlace.latestCover, '')
  map.onTapPlace(tap(placeB.id))
  await flush()
  pending.resolve(tempURLs([file('old-first')]))
  await flush()
  assert.equal(map.data.selectedPlace.latestCover, url('second'))
  assert.equal(map.data.coverFailed, false)
})
