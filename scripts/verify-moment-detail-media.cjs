const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const pagePath = path.join(__dirname, '../miniprogram/pages/moment-detail/moment-detail')
const source = ts.transpileModule(fs.readFileSync(`${pagePath}.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const template = fs.readFileSync(`${pagePath}.wxml`, 'utf8')
const imageTag = template.match(/<image\s[^>]+>/)?.[0]
const videoTag = template.match(/<video\s[^>]+>/)?.[0]
assert.match(imageTag, /data-key="{{image.key}}"[\s\S]*bindload="onImgLoad"[\s\S]*binderror="onMediaError"/)
assert.match(videoTag, /data-key="{{video.key}}"[\s\S]*binderror="onMediaError"/)
assert.match(template, /wx:if="{{mediaError}}"[^>]+bindtap="onRetryMedia"/)

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const sharedImageURL = 'https://media.test/shared.jpg'
const healthy = 'cloud://healthy'
const broken = 'cloud://broken'
const missing = 'cloud://missing'
const video = 'cloud://video'
const voice = 'cloud://voice'
const neighbors = { prevId: null, nextId: 'b', index: 1, total: 2 }
const event = media => ({ currentTarget: { dataset: { key: media.key, src: media.src } } })

function mount() {
  let page
  const requests = []
  const comments = deferred()
  const adjacent = deferred()
  const added = deferred()
  const audios = []
  const invalidated = []
  const previews = []
  const momentReads = []
  const cache = new Map([
    [healthy, sharedImageURL], [broken, sharedImageURL], [video, 'https://media.test/old.mp4'],
  ])
  const store = {
    getIdentity: () => ({ role: 'A' }),
    async getMoment(id) {
      momentReads.push(id)
      return {
        id, content: `正文 ${id}`, images: id === 'a' ? [healthy, missing, broken] : [healthy],
        videos: [video], voices: [{ fileID: voice, duration: 3 }],
        authorRole: 'A', createdAt: Date.now(),
      }
    },
    listComments: id => id === 'a' ? comments.promise : Promise.resolve([]),
    getMomentLikes: async () => ({ count: 1, likedByA: true }),
    getMomentNeighbors: id => id === 'a' ? adjacent.promise : Promise.resolve({ ...neighbors, nextId: null }),
    addComment: () => added.promise,
    resolveCloudUrl: async () => 'https://media.test/voice.mp3',
  }
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/store': store,
    '../../services/format': { formatSlate: () => ({ md: '', dow: '' }) },
    '../../utils/moment-time': { isBackdatedMoment: () => false, momentDisplayAt: moment => moment.createdAt },
    '../../utils/tags': { tagLabel: () => '' },
    '../../services/moments-list-state': { markMomentsListStale() {} },
    '../../utils/cloud-url-cache': {
      peekCachedUrl: id => cache.get(id) ?? '',
      invalidateCachedUrl(id) { invalidated.push(id); cache.delete(id) },
      async resolveCloudUrls(ids) {
        const request = deferred()
        requests.push({ ids, ...request })
        const urls = await request.promise
        const resolved = {}
        for (const id of ids) {
          if (urls[id]) cache.set(id, urls[id])
          if (cache.has(id)) resolved[id] = cache.get(id)
        }
        return resolved
      },
    },
  }
  const wx = {
    vibrateShort() {},
    previewImage(options) { previews.push(options) },
    createInnerAudioContext() {
      const audio = {
        destroyed: false,
        onPlay(fn) { this.started = fn },
        onEnded(fn) { this.ended = fn },
        onError(fn) { this.failed = fn },
        play() {},
        destroy() { this.destroyed = true },
      }
      audios.push(audio)
      return audio
    },
  }
  vm.runInNewContext(source, {
    require(id) { assert.ok(modules[id], `Unexpected dependency ${id}`); return modules[id] },
    exports: {}, wx, Page(definition) { page = definition },
  })
  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const fields = key.split('.')
      const target = fields.slice(0, -1).reduce((obj, field) => obj[field], this.data)
      target[fields.at(-1)] = structuredClone(value)
    }
  }
  const takeURLs = (...ids) => {
    const request = requests.shift()
    assert.deepEqual(Array.from(request?.ids ?? []).sort(), ids.sort())
    return request
  }
  return { page, adjacent, comments, added, cache, audios, invalidated, momentReads, previews, takeURLs, requests }
}

async function verify() {
  const { page, adjacent, comments, added, cache, audios, invalidated, momentReads, previews, takeURLs, requests } = mount()
  const opening = page.onLoad({ id: 'a' })
  await flush()
  takeURLs(healthy, broken, missing, video).resolve({})
  await flush()

  const [healthyImage, oldImage] = page.data.item.images
  const [oldVideo] = page.data.item.videos
  assert.equal(oldImage.src, healthyImage.src, 'the original IDs must survive a missing image and duplicate URLs')
  assert.ok(page.data.mediaError)
  page.onImgLoad(event(healthyImage))
  page.onImgLoad(event(oldImage))
  page.onTapImage(event(healthyImage))
  assert.deepEqual(Array.from(previews[0].urls), [sharedImageURL, sharedImageURL])

  await page.onTapVoice()
  assert.equal(page.data.item.voiceLoading, true)
  page.onCommentInput({ detail: { value: 'new' } })
  const posting = page.onSubmitComment()
  added.resolve({ id: 'new', content: 'new', authorRole: 'A' })
  await posting
  comments.resolve([{ id: 'existing', content: 'existing', authorRole: 'A' }])
  adjacent.resolve(neighbors)
  await opening
  assert.equal(page.data.item.voiceLoading, true)
  assert.deepEqual(page.data.comments.map(comment => comment.id), ['existing', 'new'])
  assert.equal(page.data.nextId, 'b')
  audios[0].started()
  assert.equal(page.data.item.voicePlaying, true)

  page.onMediaError(event(oldImage))
  assert.deepEqual(invalidated, [broken])
  assert.equal(page.data.loadedImgs[oldImage.key], undefined)
  assert.equal(page.data.loadedImgs[healthyImage.key], true)
  page.onMediaError(event(oldVideo))
  assert.deepEqual(invalidated, [broken, video])
  page.onMediaError(event(oldVideo))
  assert.deepEqual(invalidated, [broken, video])

  const firstRetry = page.onRetryMedia()
  const firstURLs = takeURLs(broken, missing, video)
  await page.onRetryMedia()
  assert.equal(requests.length, 0)
  firstURLs.resolve({ [missing]: 'https://media.test/missing.jpg' })
  await firstRetry
  assert.ok(page.data.mediaError)
  assert.deepEqual(page.data.item.images[0], healthyImage)
  assert.deepEqual(page.data.item.images[2], oldImage)
  assert.deepEqual(page.data.item.videos[0], oldVideo)
  assert.equal(page.data.item.content, '正文 a')
  assert.equal(page.data.item.voicePlaying, true)
  assert.deepEqual(momentReads, ['a'])

  const secondRetry = page.onRetryMedia()
  takeURLs(broken, video).resolve({ [broken]: sharedImageURL, [video]: 'https://media.test/new.mp4' })
  await secondRetry
  assert.equal(page.data.mediaError, '')
  const newImage = page.data.item.images[2]
  const [newVideo] = page.data.item.videos
  assert.equal(newImage.src, oldImage.src)
  assert.notEqual(newImage.key, oldImage.key)
  assert.notEqual(newVideo.key, oldVideo.key)
  assert.equal(page.data.loadedImgs[healthyImage.key], true)
  page.onMediaError(event(oldImage))
  page.onMediaError(event(oldVideo))
  page.onImgLoad(event(oldImage))
  assert.equal(page.data.mediaError, '')
  assert.equal(page.data.loadedImgs[newImage.key], undefined)
  assert.deepEqual(invalidated, [broken, video])
  page.onImgLoad(event(newImage))
  assert.equal(page.data.loadedImgs[newImage.key], true)
  await page.onTapVoice()
  assert.equal(audios.length, 1)
  assert.equal(audios[0].destroyed, true)
  assert.equal(page.data.item.voicePlaying, false)

  cache.set(video, 'https://media.test/newer.mp4')
  page.onMediaError(event(newVideo))
  assert.deepEqual(invalidated, [broken, video], 'an error must preserve a newer cached URL')
  const staleRetry = page.onRetryMedia()
  const staleURLs = takeURLs(video)
  const moving = page.goNeighbor('next')
  await flush()
  page.onMediaError(event(healthyImage))
  takeURLs(healthy, video).resolve({})
  await moving
  staleURLs.resolve({})
  await staleRetry
  page.onMediaError(event(healthyImage))
  page.onMediaError(event(newVideo))
  page.onImgLoad(event(healthyImage))
  assert.equal(page.data.item.content, '正文 b')
  assert.equal(page.data.item.videos[0].src, 'https://media.test/newer.mp4')
  assert.equal(page.data.mediaError, '')
  assert.deepEqual(page.data.loadedImgs, {})
  assert.deepEqual(invalidated, [broken, video])

  const currentVideo = page.data.item.videos[0]
  page.onMediaError(event(currentVideo))
  assert.ok(page.data.mediaError, 'a component error alone must expose media retry')
  const rejecting = page.onRetryMedia()
  takeURLs(video).reject(new Error('network unavailable'))
  await rejecting
  assert.equal(page.data.item.content, '正文 b')
  assert.ok(page.data.mediaError)
  const unloading = page.onRetryMedia()
  const lateURLs = takeURLs(video)
  page.onUnload()
  lateURLs.resolve({ [video]: 'https://media.test/too-late.mp4' })
  await unloading
  assert.deepEqual(page.data.item.videos[0], currentVideo)
  assert.deepEqual(invalidated, [broken, video, video])
  page.onMediaError(event(page.data.item.images[0]))
  assert.deepEqual(invalidated, [broken, video, video])
  assert.equal(requests.length, 0)
}

async function verifyPlayingDuringInteractionLoad() {
  const { page, adjacent, comments, audios, takeURLs } = mount()
  const opening = page.onLoad({ id: 'a' })
  await flush()
  takeURLs(healthy, broken, missing, video).resolve({ [missing]: 'https://media.test/missing.jpg' })
  await flush()

  await page.onTapVoice()
  audios[0].started()
  const oldVideo = page.data.item.videos[0]
  page.onMediaError(event(oldVideo))
  const retrying = page.onRetryMedia()
  takeURLs(video).resolve({ [video]: 'https://media.test/recovered.mp4' })
  await retrying
  comments.resolve([])
  adjacent.resolve(neighbors)
  await opening

  assert.equal(page.data.item.voicePlaying, true)
  assert.equal(page.data.item.videos[0].src, 'https://media.test/recovered.mp4')
  await page.onTapVoice()
  assert.equal(audios.length, 1)
  assert.equal(audios[0].destroyed, true)
}

test('媒体失败、局部恢复、重复重试与过时事件', verify)
test('延迟互动回包保留正在播放的语音和已恢复的视频', verifyPlayingDuringInteractionLoad)
