const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const componentPath = path.join(__dirname, '../miniprogram/components/live-photo/live-photo')
const source = ts.transpileModule(fs.readFileSync(`${componentPath}.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const template = fs.readFileSync(`${componentPath}.wxml`, 'utf8')
const tapHandler = template.match(/<view\s[^>]*\bbindtap="([^"]+)"/)?.[1]
const videoTag = template.match(/<video\s[^>]+>/)?.[0]

const cloudVideo = 'cloud://test/live.mp4'
const nextVideo = 'cloud://test/next.mp4'
const firstUrl = 'https://media.test/first.mp4'
const nextUrl = 'https://media.test/next.mp4'
const localVideo = 'wxfile://local/live.mp4'
const playbackError = '实况播放失败'

function setup({ cached = false } = {}) {
  let definition
  const requests = []
  const toasts = []
  const urls = new Map()
  const invalidated = []
  vm.runInNewContext(source, {
    Component(options) { definition = options },
    exports: {},
    require(id) {
      if (id === '../../utils/cloud-url-cache') return {
        peekCachedUrl: fileID => urls.get(fileID) || '',
        invalidateCachedUrl(fileID) {
          invalidated.push(fileID)
          urls.delete(fileID)
        },
      }
      assert.equal(id, '../../services/store')
      return {
        async resolveCloudUrl(fileID) {
          if (cached && urls.has(fileID)) return urls.get(fileID)
          const url = await new Promise((resolve, reject) => requests.push({ fileID, resolve, reject }))
          if (cached && url) urls.set(fileID, url)
          return url
        },
      }
    },
    wx: { showToast: ({ title }) => toasts.push(title) },
  })

  function mount(props = {}) {
    const data = { ...definition.data }
    for (const [key, prop] of Object.entries(definition.properties)) data[key] = prop.value
    const writes = []
    const component = {
      ...definition.methods,
      data,
      properties: data,
      setData(patch) {
        writes.push({ ...patch })
        Object.assign(data, patch)
      },
    }
    function setProperty(key, value) {
      const previous = data[key]
      data[key] = value
      if (previous !== value) definition.properties[key].observer?.call(component, value, previous, [key])
    }
    definition.lifetimes?.created?.call(component)
    for (const [key, value] of Object.entries(props)) setProperty(key, value)
    definition.lifetimes?.attached?.call(component)
    return {
      data, writes, setProperty,
      tap: () => component[tapHandler](),
      stop: () => component.stop(),
      hide: () => definition.pageLifetimes.hide.call(component),
      show: () => definition.pageLifetimes.show?.call(component),
      detach: () => definition.lifetimes?.detached?.call(component),
      videoErrorEvent() {
        assert.match(videoTag, /wx:for="{{\[playbackId\]}}"/)
        assert.match(videoTag, /wx:key="\*this"/)
        assert.match(videoTag, /data-playback-id="{{item}}"/)
        return { currentTarget: { dataset: { playbackId: data.playbackId } } }
      },
      emitVideoError(event) {
        const handler = videoTag?.match(/\bbinderror="(\w+)"/)?.[1]
        assert.ok(handler, '原生视频需绑定错误事件')
        component[handler](event)
      },
      coverError(attempt = data.coverAttempt) {
        const image = template.match(/<image\s[^>]+>/)?.[0]
        assert.match(image, /data-cover-attempt="{{item}}"/)
        const handler = image.match(/\bbinderror="(\w+)"/)?.[1]
        assert.ok(handler, '封面需绑定原生错误事件')
        component[handler]({ currentTarget: { dataset: { coverAttempt: attempt } } })
      },
      retryCover() {
        const handler = template.match(/\bcatchtap="(\w+)"/)?.[1]
        assert.ok(handler, '封面重试不能冒泡触发视频播放')
        component[handler]()
      },
    }
  }
  function takeRequest(fileID) {
    const request = requests.shift()
    assert.equal(request?.fileID, fileID)
    return request
  }
  return { mount, requests, toasts, takeRequest, invalidated, urls }
}

function assertPlayback(photo, src = '', message = '组件播放状态或链接不符合预期') {
  assert.deepEqual([photo.data.playing, photo.data.playSrc], [Boolean(src), src], message)
}

test('页面隐藏后，挂起的云链接成功回包不能重新播放', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const playing = photo.tap()
  const pending = app.takeRequest(cloudVideo)
  assertPlayback(photo)
  photo.hide()
  assertPlayback(photo)
  const writes = photo.writes.length

  pending.resolve(firstUrl)
  await playing
  assertPlayback(photo, '', 'hide 后的旧回包不得设置 playing 或 playSrc')
  assert.equal(photo.writes.length, writes)
  assert.deepEqual(app.toasts, [])
})

test('连续三次点击的云链接逆序完成，只采纳最后一次点击', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const first = photo.tap()
  const oldest = app.takeRequest(cloudVideo)
  const second = photo.tap()
  const middle = app.takeRequest(cloudVideo)
  const third = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await third
  assertPlayback(photo, nextUrl)
  const writes = photo.writes.length

  middle.resolve(firstUrl)
  await second
  oldest.reject(new Error('stale request'))
  await first
  assertPlayback(photo, nextUrl)
  assert.equal(photo.writes.length, writes)
  assert.deepEqual(app.toasts, [])
})

test('较早点击先回包也不会抢播，最后一次取链接失败后可以重试', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const first = photo.tap()
  const oldest = app.takeRequest(cloudVideo)
  const latest = photo.tap()
  const newest = app.takeRequest(cloudVideo)
  oldest.resolve(firstUrl)
  await first
  assertPlayback(photo)
  newest.reject(new Error('temporary failure'))
  await latest
  assertPlayback(photo)
  assert.deepEqual(app.toasts, [playbackError])

  const retry = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await retry
  assertPlayback(photo, nextUrl)
  await photo.tap()
  assertPlayback(photo)
  assert.equal(app.requests.length, 0)
})

test('视频变化停止旧媒体，即使值改回旧视频也使旧请求失效', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const initial = photo.tap()
  const stale = app.takeRequest(cloudVideo)
  photo.setProperty('video', nextVideo)
  photo.setProperty('video', cloudVideo)
  stale.resolve(firstUrl)
  await initial
  assertPlayback(photo)

  const replacing = photo.tap()
  const previous = app.takeRequest(cloudVideo)
  photo.setProperty('video', nextVideo)
  const current = photo.tap()
  app.takeRequest(nextVideo).resolve(nextUrl)
  await current
  previous.resolve(firstUrl)
  await replacing
  assertPlayback(photo, nextUrl)

  photo.setProperty('video', localVideo)
  assertPlayback(photo)
  await photo.tap()
  assertPlayback(photo, localVideo)
  photo.setProperty('video', '')
  await photo.tap()
  assertPlayback(photo)
  assert.equal(app.requests.length, 0)
  assert.deepEqual(app.toasts, [])
})

test('封面、时长和相同视频重复赋值不打断取链接或播放', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const playing = photo.tap()
  photo.setProperty('cover', '/cover.jpg')
  photo.setProperty('duration', 4)
  photo.setProperty('video', cloudVideo)
  app.takeRequest(cloudVideo).resolve(firstUrl)
  await playing
  assertPlayback(photo, firstUrl)
  photo.setProperty('cover', '/new-cover.jpg')
  photo.setProperty('video', cloudVideo)
  assertPlayback(photo, firstUrl)
})

test('隐藏抑制旧请求的失败和隐藏期间的点击，显示后正常重放', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const playing = photo.tap()
  const stale = app.takeRequest(cloudVideo)
  photo.hide()
  const hiddenTap = photo.tap()
  assert.equal(app.requests.length, 0)
  await hiddenTap
  photo.show()
  const replay = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await replay
  stale.reject(new Error('hidden request'))
  await playing
  assertPlayback(photo, nextUrl)
  assert.deepEqual(app.toasts, [])

  photo.hide()
  assertPlayback(photo)
  photo.show()
  assertPlayback(photo)
})

test('显式停止和播放中的点击停止都会使旧请求失效', async () => {
  const app = setup()
  const photo = app.mount({ video: cloudVideo })
  const initial = photo.tap()
  const stopped = app.takeRequest(cloudVideo)
  photo.stop()

  const first = photo.tap()
  const stale = app.takeRequest(cloudVideo)
  stopped.resolve(firstUrl)
  await initial
  assertPlayback(photo)

  const latest = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await latest
  assertPlayback(photo, nextUrl)
  await photo.tap()
  assertPlayback(photo)
  stale.resolve(firstUrl)
  await first
  assertPlayback(photo)

  const replay = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await replay
  photo.stop()
  assertPlayback(photo)
  assert.deepEqual(app.toasts, [])
})

test('移除组件使所有挂起请求失效，同一页面的其他实况仍可播放', async () => {
  const app = setup()
  const removed = app.mount({ video: cloudVideo })
  const live = app.mount({ video: cloudVideo })
  const success = removed.tap()
  const lateSuccess = app.takeRequest(cloudVideo)
  const failure = removed.tap()
  const lateFailure = app.takeRequest(cloudVideo)
  const other = live.tap()
  const current = app.takeRequest(cloudVideo)
  removed.detach()
  const writes = removed.writes.length
  lateSuccess.resolve(firstUrl)
  lateFailure.reject(new Error('detached request'))
  current.resolve(nextUrl)
  await Promise.all([success, failure, other])
  assertPlayback(removed)
  assertPlayback(live, nextUrl)
  assert.equal(removed.writes.length, writes)
  assert.deepEqual(app.toasts, [])

  const afterDetach = removed.tap()
  assert.equal(app.requests.length, 0)
  await afterDetach
  assert.equal(removed.writes.length, writes)
})

test('本地和直链实况使用原生视频，点击在播放和停止间切换', async () => {
  assert.match(videoTag, /wx:if="{{playing}}"/)
  assert.match(videoTag, /src="{{playSrc}}"/)
  assert.match(videoTag, /\bautoplay\b/)
  assert.match(videoTag, /\bloop\b/)
  const app = setup()
  const photo = app.mount()
  await photo.tap()
  assertPlayback(photo)
  for (const src of [localVideo, firstUrl]) {
    photo.setProperty('video', src)
    await photo.tap()
    assertPlayback(photo, src)
    await photo.tap()
    assertPlayback(photo)
    await photo.tap()
    assertPlayback(photo, src)
  }
  assert.equal(app.requests.length, 0)
  assert.deepEqual(app.toasts, [])
})

test('原生视频错误只结束对应的播放，旧事件不能中断同链接重放', async () => {
  const app = setup()
  const photo = app.mount({ video: localVideo })
  await photo.tap()
  const oldError = photo.videoErrorEvent()
  await photo.tap()
  await photo.tap()
  const currentError = photo.videoErrorEvent()
  assert.notEqual(oldError.currentTarget.dataset.playbackId, currentError.currentTarget.dataset.playbackId)
  photo.emitVideoError(oldError)
  assertPlayback(photo, localVideo)
  assert.deepEqual(app.toasts, [])

  photo.emitVideoError(currentError)
  assertPlayback(photo)
  assert.deepEqual(app.toasts, [playbackError])
  photo.emitVideoError(currentError)
  assert.deepEqual(app.toasts, [playbackError])

  await photo.tap()
  assertPlayback(photo, localVideo)
  const removedError = photo.videoErrorEvent()
  photo.detach()
  const writes = photo.writes.length
  photo.emitVideoError(removedError)
  assert.equal(photo.writes.length, writes)
  assert.deepEqual(app.toasts, [playbackError])
})

test('云视频原生报错后重签，旧报错不能逐出新链接', async () => {
  const app = setup({ cached: true })
  const photo = app.mount({ video: cloudVideo })
  const firstPlay = photo.tap()
  app.takeRequest(cloudVideo).resolve(firstUrl)
  await firstPlay
  const failed = photo.videoErrorEvent()
  photo.emitVideoError(failed)
  assertPlayback(photo)
  assert.equal(photo.data.playbackFailed, true)
  assert.match(template, /轻触重试播放/)
  assert.deepEqual(app.invalidated, [cloudVideo])

  const retry = photo.tap()
  app.takeRequest(cloudVideo).resolve(nextUrl)
  await retry
  photo.emitVideoError(failed)
  assertPlayback(photo, nextUrl)
  assert.equal(photo.data.playbackFailed, false)
  assert.deepEqual(app.invalidated, [cloudVideo])
  app.urls.set(cloudVideo, firstUrl)
  photo.emitVideoError(photo.videoErrorEvent())
  assert.equal(app.urls.get(cloudVideo), firstUrl, '原生错误不能清除已被其他请求替换的链接')
})

test('实况封面可单独重试，旧图片报错不能覆盖新封面', async () => {
  const app = setup()
  const photo = app.mount({ cover: '/old.jpg', video: localVideo })
  const original = photo.data.coverAttempt
  photo.coverError()
  assert.equal(photo.data.coverFailed, true)
  assert.match(template, /重试封面/)
  photo.retryCover()
  assert.equal(photo.data.coverFailed, false)
  assert.notEqual(photo.data.coverAttempt, original)
  photo.coverError(original)
  assert.equal(photo.data.coverFailed, false)
  assertPlayback(photo)
  photo.coverError()
  await photo.tap()
  assertPlayback(photo, localVideo)
  const previous = photo.data.coverAttempt
  photo.setProperty('cover', '/new.jpg')
  photo.coverError(previous)
  assert.equal(photo.data.coverFailed, false)
  assertPlayback(photo, localVideo)
})
