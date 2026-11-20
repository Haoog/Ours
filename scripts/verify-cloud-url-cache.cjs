const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const filename = path.join(__dirname, '../miniprogram/utils/cloud-url-cache.ts')
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

const storageKey = 'OURS_URL_CACHE'
const startTime = 1000000
const ttl = 90 * 60 * 1000
const avatar = 'cloud://mock/avatars/space-a/avatar.jpg'
const cover = 'cloud://mock/moments/space-a/cover.jpg'
const video = 'cloud://mock/moments/space-a/video.mp4'
const ready = { status: 'ready', openid: 'user-a', coupleId: 'space-a' }
const url = name => `https://media.test/${name}`
const found = (fileID, tempFileURL, maxAge) => ({ fileID, tempFileURL, maxAge, status: 0 })
const flush = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function mount({ sdk, fallback, storage = new Map() } = {}) {
  let session = ready
  let now = startTime
  const sdkCalls = []
  const fallbackCalls = []
  const timers = []
  const exports = {}
  const modules = {
    '../services/session': {
      getSession: () => session,
      coupleId() {
        if (session?.status !== 'ready' || !session.coupleId) throw new Error('no active space')
        return session.coupleId
      },
    },
    '../services/cloud-api': {
      async callOurs(action, { coupleId, fileIDs }) {
        const call = { action, coupleId, fileIDs: Array.from(fileIDs) }
        fallbackCalls.push(call)
        return fallback?.(call, fallbackCalls.length) ?? {}
      },
    },
  }
  vm.runInNewContext(source, {
    exports,
    require(id) {
      assert.ok(Object.hasOwn(modules, id), `Unexpected dependency ${id}`)
      return modules[id]
    },
    Date: { now: () => now },
    setTimeout(run, delay) { return timers.push({ run, at: now + delay }) },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorage: ({ key, data }) => storage.set(key, data),
      cloud: {
        async getTempFileURL({ fileList }) {
          const ids = Array.from(fileList)
          sdkCalls.push(ids)
          return sdk?.(ids, sdkCalls.length) ?? { fileList: [] }
        },
      },
    },
  }, { filename })
  return {
    ...exports, sdkCalls, fallbackCalls, storage,
    setSession(next) { session = next },
    advance(ms) {
      now += ms
      while (timers.length && timers[0].at <= now) timers.shift().run()
    },
  }
}

test('SDK 未解析头像时只走一次 SDK，兜底在途和头像重访都复用链接', async () => {
  const link = url('avatar')
  const reply = deferred()
  const cache = mount({ fallback: () => reply.promise })
  const original = cache.resolveCloudUrl(avatar)
  await flush()
  const revisit = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar]])
  assert.deepEqual(cache.fallbackCalls, [{ action: 'resolveMediaUrls', coupleId: 'space-a', fileIDs: [avatar] }])
  reply.resolve({ [avatar]: link })
  assert.deepEqual(await Promise.all([original, revisit]), [link, link])
  assert.equal(await cache.resolveCloudUrl(avatar), link)
  assert.equal(cache.peekCachedUrl(avatar), link)
  assert.deepEqual(cache.sdkCalls, [[avatar]])
})

test('重叠批次和单文件调用只申请各自缺失的文件', async () => {
  const first = deferred()
  const second = deferred()
  const cache = mount({ sdk: (_ids, count) => count === 1 ? first.promise : second.promise })
  const direct = url('already-resolved')
  const left = cache.resolveCloudUrls([avatar, cover, cover, ''])
  const right = cache.resolveCloudUrls([cover, video, direct])
  const single = cache.resolveCloudUrl(cover)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar, cover], [video]])
  second.resolve({ fileList: [found(video, url('video'))] })
  first.resolve({ fileList: [found(avatar, url('avatar')), found(cover, url('cover'))] })
  assert.deepEqual({ ...await left }, { [avatar]: url('avatar'), [cover]: url('cover') })
  assert.deepEqual({ ...await right }, { [cover]: url('cover'), [video]: url('video'), [direct]: direct })
  assert.equal(await single, url('cover'))
  assert.equal(cache.fallbackCalls.length, 0)
})

test('三段流程均保持 50 个一批，兜底和 SDK 重试只申请仍缺失的文件', async () => {
  const ids = Array.from({ length: 106 }, (_, index) => `cloud://mock/file-${index}`)
  const cache = mount({
    sdk(batch, count) {
      if (count === 1) return { fileList: [found(ids[0], url('sdk'))] }
      return { fileList: count > 3 ? batch.map(id => found(id, url('retry'))) : [] }
    },
    fallback: ({ fileIDs }) => fileIDs.includes(ids[1]) ? { [ids[1]]: url('fallback') } : {},
  })
  const result = await cache.resolveCloudUrls(ids)
  assert.deepEqual(cache.sdkCalls, [
    ids.slice(0, 50), ids.slice(50, 100), ids.slice(100),
    ids.slice(2, 52), ids.slice(52, 102), ids.slice(102),
  ])
  assert.deepEqual(cache.fallbackCalls.map(call => call.fileIDs), [ids.slice(1, 51), ids.slice(51, 101), ids.slice(101)])
  const expected = Object.fromEntries(ids.map(id => [id, url('retry')]))
  expected[ids[0]] = url('sdk')
  expected[ids[1]] = url('fallback')
  assert.deepEqual({ ...result }, expected)
})

test('兜底失败后只串行发起一次 SDK 重试，各阶段加入的调用共享结果', async () => {
  const first = deferred()
  const fallback = deferred()
  const retry = deferred()
  const cache = mount({
    sdk: (_ids, count) => count === 1 ? first.promise : retry.promise,
    fallback: () => fallback.promise,
  })
  const original = cache.resolveCloudUrls([avatar, cover])
  const duringFirst = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar, cover]])
  assert.deepEqual(cache.fallbackCalls, [])

  first.resolve({ fileList: [found(cover, url('cover'))] })
  await flush()
  const duringFallback = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar, cover]])
  assert.deepEqual(cache.fallbackCalls.map(call => call.fileIDs), [[avatar]])

  fallback.reject(new Error('fallback unavailable'))
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar, cover], [avatar]])
  const duringRetry = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar, cover], [avatar]])
  assert.equal(cache.fallbackCalls.length, 1)

  const recovered = url('recovered')
  retry.resolve({ fileList: [found(avatar, recovered)] })
  assert.deepEqual({ ...await original }, { [avatar]: recovered, [cover]: url('cover') })
  assert.deepEqual(await Promise.all([duringFirst, duringFallback, duringRetry]), [recovered, recovered, recovered])
  assert.equal(cache.peekCachedUrl(avatar), recovered)
})

test('两次 SDK 均失败时共享失败结果，下一次调用可重新申请', async () => {
  const cache = mount({
    sdk(_ids, count) {
      if (count <= 2) throw new Error('SDK unavailable')
      return { fileList: [found(avatar, url('recovered'))] }
    },
  })
  const first = cache.resolveCloudUrl(avatar)
  const joined = cache.resolveCloudUrl(avatar)
  assert.deepEqual(await Promise.all([first, joined]), ['', ''])
  assert.equal(cache.peekCachedUrl(avatar), '')
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar]])
  assert.equal(cache.fallbackCalls.length, 1)
  assert.equal(await cache.resolveCloudUrl(avatar), url('recovered'))
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar], [avatar]])
  assert.equal(cache.fallbackCalls.length, 1)
})

test('同一有效会话刷新可共享，空间、账号和非 ready 状态各自申请', async () => {
  const replies = Array.from({ length: 5 }, deferred)
  const cache = mount({ sdk: (_ids, count) => replies[count - 1].promise })
  const oldSpace = cache.resolveCloudUrl(avatar)
  cache.setSession({ ...ready })
  const refreshed = cache.resolveCloudUrl(avatar)
  cache.setSession({ ...ready, coupleId: 'space-b' })
  const newSpace = cache.resolveCloudUrl(avatar)
  cache.setSession({ ...ready, coupleId: 'space-b', openid: 'user-b' })
  const newUser = cache.resolveCloudUrl(avatar)
  cache.setSession({ ...ready, coupleId: 'space-b', openid: 'user-b', status: 'expired' })
  const expired = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar], [avatar], [avatar]])
  replies[3].resolve({ fileList: [] })
  await flush()
  assert.equal(cache.sdkCalls.length, 5)
  replies[4].resolve({ fileList: [] })
  assert.equal(await expired, '')
  replies[2].resolve({ fileList: [] })
  replies[1].resolve({ fileList: [found(avatar, url('old-space'))] })
  replies[0].resolve({ fileList: [] })
  assert.deepEqual(await Promise.all([oldSpace, refreshed, newSpace, newUser]), ['', '', '', ''])
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar], [avatar], [avatar], [avatar]])
  assert.deepEqual(cache.fallbackCalls, [])
  assert.equal(cache.peekCachedUrl(avatar), '')
})

test('切换会话无需等待新的媒体调用，旧 SDK 回包被丢弃且不发起兜底', async () => {
  const old = deferred()
  const cache = mount({ sdk: (_ids, count) => count === 1 ? old.promise : { fileList: [found(avatar, url('sdk-only'))] } })
  const previous = cache.resolveCloudUrls([avatar, cover])
  await flush()
  cache.setSession(null)
  old.resolve({ fileList: [found(avatar, url('previous'))] })
  assert.deepEqual({ ...await previous }, {})
  assert.equal(cache.peekCachedUrl(avatar), '')
  assert.equal(await cache.resolveCloudUrl(avatar), url('sdk-only'))
  assert.deepEqual(cache.sdkCalls, [[avatar, cover], [avatar]])
  assert.deepEqual(cache.fallbackCalls, [])
})

test('切换空间时，已发出的兜底回包无法覆盖当前空间的结果', async () => {
  const old = deferred()
  const cache = mount({ fallback: ({ coupleId }) => coupleId === 'space-a' ? old.promise : { [avatar]: url('current') } })
  const previous = cache.resolveCloudUrl(avatar)
  await flush()
  cache.setSession({ ...ready, coupleId: 'space-b' })
  assert.equal(await cache.resolveCloudUrl(avatar), url('current'))
  old.resolve({ [avatar]: url('previous') })
  assert.equal(await previous, '')
  assert.equal(cache.peekCachedUrl(avatar), url('current'))
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar]])
  assert.deepEqual(cache.fallbackCalls.map(call => call.coupleId), ['space-a', 'space-b'])
})

test('主动失效后旧 SDK 请求不能回填缓存或清除替代请求', async () => {
  const old = deferred()
  const replacement = deferred()
  const cache = mount({ sdk: (_ids, count) => count === 1 ? old.promise : replacement.promise })
  const stale = cache.resolveCloudUrl(avatar)
  await flush()
  cache.invalidateCachedUrl(avatar)
  const current = cache.resolveCloudUrl(avatar)
  old.resolve({ fileList: [found(avatar, url('stale'))] })
  assert.equal(await stale, '')
  await flush()
  assert.equal(cache.peekCachedUrl(avatar), '')
  const overlap = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar]])
  assert.deepEqual(cache.fallbackCalls, [])
  replacement.resolve({ fileList: [found(avatar, url('current'))] })
  assert.deepEqual(await Promise.all([current, overlap]), [url('current'), url('current')])
})

test('主动失效后，迟到的云函数回包也无法写回持久缓存', async () => {
  const old = deferred()
  const cache = mount({
    sdk: (_ids, count) => ({ fileList: count === 1 ? [] : [found(avatar, url('current'))] }),
    fallback: () => old.promise,
  })
  const stale = cache.resolveCloudUrl(avatar)
  await flush()
  assert.equal(cache.fallbackCalls.length, 1)
  cache.invalidateCachedUrl(avatar)
  assert.equal(await cache.resolveCloudUrl(avatar), url('current'))
  old.resolve({ [avatar]: url('stale') })
  assert.equal(await stale, '')
  await flush()
  cache.advance(5000)
  assert.equal(cache.peekCachedUrl(avatar), url('current'))
  assert.equal(JSON.parse(cache.storage.get(storageKey))[avatar].url, url('current'))
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar]])
})

test('主动失效后，迟到的 SDK 重试回包也无法覆盖新链接', async () => {
  const retry = deferred()
  const cache = mount({
    sdk(_ids, count) {
      if (count === 1) return { fileList: [] }
      if (count === 2) return retry.promise
      return { fileList: [found(avatar, url('current'))] }
    },
  })
  const stale = cache.resolveCloudUrl(avatar)
  await flush()
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar]])
  cache.invalidateCachedUrl(avatar)
  assert.equal(await cache.resolveCloudUrl(avatar), url('current'))
  retry.resolve({ fileList: [found(avatar, url('stale'))] })
  assert.equal(await stale, '')
  assert.equal(cache.peekCachedUrl(avatar), url('current'))
  assert.deepEqual(cache.sdkCalls, [[avatar], [avatar], [avatar]])
})

test('保留 SDK 提前过期、90 分钟上限、兜底 TTL 和冷启动读取', async () => {
  const cache = mount({
    sdk: ids => ({
      fileList: [found(avatar, url('short'), 40), found(cover, url('cap'), 7200)]
        .filter(item => ids.includes(item.fileID)),
    }),
    fallback: () => ({ [video]: url('fallback') }),
  })
  await cache.resolveCloudUrls([avatar, cover, video])
  cache.advance(5000)
  assert.deepEqual(JSON.parse(cache.storage.get(storageKey)), {
    [avatar]: { url: url('short'), expires: startTime + 10000 },
    [cover]: { url: url('cap'), expires: startTime + ttl },
    [video]: { url: url('fallback'), expires: startTime + ttl },
  })
  const cold = mount({ storage: cache.storage })
  assert.equal(await cold.resolveCloudUrl(avatar), url('short'))
  assert.deepEqual(cold.sdkCalls, [])
  cache.advance(4999)
  assert.equal(cache.peekCachedUrl(avatar), url('short'))
  cache.advance(1)
  assert.equal(cache.peekCachedUrl(avatar), '')
  assert.equal(await cache.resolveCloudUrl(avatar), url('short'))
  assert.deepEqual(cache.sdkCalls, [[avatar, cover, video], [avatar]])
  cache.advance(ttl - 10000)
  assert.equal(cache.peekCachedUrl(cover), '')
  assert.equal(cache.peekCachedUrl(video), '')
})
