const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function compile(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  return new vm.Script(outputText, { filename: file })
}

const pool = {}
compile('miniprogram/utils/async-pool.ts').runInNewContext({ exports: pool })
const storeScript = compile('miniprogram/services/store.ts')
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function setup(create = payload => ({ id: 'saved', ...payload })) {
  const store = {}
  const uploads = [], progress = [], creates = [], released = [], timers = []
  const session = { status: 'ready', coupleId: 'space', openid: 'user' }
  const wx = {
    cloud: {
      uploadFile(options) {
        const fileID = `cloud://test/${options.cloudPath}`
        let onProgress, settled = false
        const upload = {
          filePath: options.filePath,
          cloudPath: options.cloudPath,
          fileID,
          aborts: 0,
          report: percent => onProgress({ progress: percent }),
          succeed() { settled = true; options.success({ fileID }) },
          fail(error = new Error('network failure')) { settled = true; options.fail(error) },
        }
        uploads.push(upload)
        return {
          onProgressUpdate: callback => { onProgress = callback },
          abort() {
            upload.aborts++
            if (!settled) upload.fail(new Error('aborted'))
          },
        }
      },
    },
    getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: 10 }) }),
    getVideoInfo: options => options.success({ width: 1920, height: 1080, bitrate: 3000, fps: 30 }),
    compressVideo: options => options.success({ tempFilePath: '/compressed.mp4' }),
  }
  const imports = {
    './cloud-api': {
      async callOurs(action, payload) {
        if (action === 'getPublishedMoment' || action === 'validateMoment') return null
        assert.equal(action, 'addMoment')
        creates.push(payload)
        return create(payload)
      },
    },
    './session': { coupleId: () => session.coupleId, getSession: () => session, requireSession: () => session },
    './upload-cleanup': {
      holdUpload() {},
      releaseUploads(owner, ids, published) { released.push({ ids: [...ids], published: [...published] }) },
      async retryUploadCleanup() {},
    },
    '../utils/async-pool': pool,
    '../utils/cloud-url-cache': {},
    './date': {},
  }
  storeScript.runInNewContext({
    exports: store, wx, Error,
    setTimeout: (run, delay) => timers.push({ run, delay }),
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`)
      return imports[id]
    },
  })
  const publish = input => store.addMoment({
    content: 'memory', images: [], location: null, requestId: 'upload-progress', ...input,
  }, (percent, hint) => progress.push({ percent, hint }))
  return { store, uploads, progress, creates, released, timers, publish }
}

function assertMonotonic(progress) {
  for (let i = 1; i < progress.length; i++) {
    const [before, after] = [progress[i - 1], progress[i]]
    assert.ok(after.percent >= before.percent,
      `${before.hint} ${before.percent}% → ${after.hint} ${after.percent}%`)
  }
}

test('interleaved uploads sum the high-water mark of each file', async () => {
  const { uploads, progress, publish } = setup()
  const pending = publish({ images: ['/a.jpg', '/b.jpg'] })
  await nextTurn()
  assert.deepEqual(uploads.map(upload => upload.filePath), ['/a.jpg', '/b.jpg'], 'both start before either completes')
  const [a, b] = uploads

  a.report(80)
  const afterA = progress.at(-1).percent
  b.report(10)
  const afterB = progress.at(-1).percent
  assert.deepEqual([afterA, afterB], [28, 32], `A 80%, then B 10%: ${afterA}% → ${afterB}%`)
  a.report(50)
  assert.equal(progress.at(-1).percent, 32, 'an out-of-order callback for A keeps its higher value')

  b.succeed()
  await nextTurn()
  assert.equal(progress.at(-1).percent, 55, 'B success counts as 100% even without a final progress callback')
  a.succeed()
  const moment = await pending
  assert.deepEqual(Array.from(moment.images), [a.fileID, b.fileID], 'out-of-order completion preserves image order')
  assertMonotonic(progress)
})

test('per-file retry keeps its highest progress and does not restart its peer', async () => {
  const { uploads, progress, timers, publish } = setup()
  const pending = publish({ images: ['/a.jpg', '/b.jpg'] })
  await nextTurn()
  const [a, b] = uploads
  a.report(40)
  b.report(20)
  assert.equal(progress.at(-1).percent, 21)

  a.fail()
  await nextTurn()
  assert.deepEqual(timers.map(timer => timer.delay), [600])
  b.report(30)
  assert.equal(progress.at(-1).percent, 25, 'the other file keeps uploading during backoff')
  timers.shift().run()
  await nextTurn()
  assert.deepEqual(uploads.map(upload => upload.filePath), ['/a.jpg', '/b.jpg', '/a.jpg'])
  const retry = uploads[2]
  assert.equal(retry.cloudPath, a.cloudPath)
  retry.report(5)
  assert.equal(progress.at(-1).percent, 25, 'the retry does not clear progress already reported for A')
  a.report(100)
  assert.equal(progress.at(-1).percent, 25, 'callbacks from the failed attempt no longer contribute')
  retry.report(60)
  assert.equal(progress.at(-1).percent, 32)
  retry.succeed()
  b.succeed()
  const moment = await pending
  assert.deepEqual(Array.from(moment.images), [retry.fileID, b.fileID])
  assert.equal(moment.mediaBytes, 20, 'each file is counted once after success')
  assertMonotonic(progress)
})

test('phase boundaries are monotonic and success without any progress callback fills the phase', async () => {
  let finishCreate
  const { uploads, progress, creates, publish } = setup(payload => new Promise(resolve => {
    finishCreate = () => resolve({ id: 'saved', ...payload })
  }))
  const pending = publish({
    images: ['/image.jpg'], videos: ['/movie.mp4'],
    livePhotos: [{ cover: '/live.jpg', video: '/live.mov', duration: 2 }],
    voices: [{ path: '/voice.mp3', duration: 3 }],
  })
  await nextTurn()
  assert.deepEqual(progress.map(event => event.percent), [2, 4, 10])
  uploads[0].report(1)
  assert.deepEqual(progress.at(-1), { percent: 10, hint: '上传图片 1/1' })
  uploads[0].succeed()
  await nextTurn()
  assert.equal(uploads[1].filePath, '/compressed.mp4')
  assert.deepEqual(progress.at(-1), { percent: 55, hint: '上传图片 1/1' })
  uploads[1].succeed()
  await nextTurn()
  assert.deepEqual(progress.slice(-2), [
    { percent: 77.5, hint: '上传视频 1/1' }, { percent: 80, hint: '上传实况…' },
  ])
  uploads[2].succeed()
  await nextTurn()
  assert.equal(progress.at(-1).hint, '实况封面 1/1 1/1')
  uploads[3].report(0)
  uploads[3].succeed()
  await nextTurn()
  assert.deepEqual(progress.at(-1), { percent: 93.5, hint: '实况视频 1/1 1/1' })
  uploads[4].report(0)
  assert.deepEqual(progress.at(-1), { percent: 95, hint: '上传语音 1/1' })
  uploads[4].report(100)
  assert.deepEqual(progress.at(-1), { percent: 98, hint: '上传语音 1/1' })
  assert.equal(creates.length, 0, '100% from wx is not yet a successful upload')
  uploads[4].succeed()
  await nextTurn()
  assert.equal(creates.length, 1)
  assert.deepEqual(progress.at(-1), { percent: 98, hint: '保存记录…' })
  finishCreate()
  await pending
  assert.deepEqual(progress.at(-1), { percent: 100, hint: '完成' })
  assertMonotonic(progress)
})

test('cancellation aborts active uploads, stops a waiting retry, and leaves completed files for cleanup', async () => {
  const { store, uploads, progress, creates, released, timers, publish } = setup()
  const pending = publish({ images: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg', '/queued.jpg'] })
  await nextTurn()
  assert.equal(uploads.length, 4, 'the pool keeps its concurrency limit')
  const [a, b, c, d] = uploads
  a.succeed()
  b.fail()
  await nextTurn()
  assert.equal(uploads[4].filePath, '/queued.jpg', 'a successful upload frees its slot')
  assert.deepEqual(timers.map(timer => timer.delay), [600])
  const progressBeforeCancel = progress.length
  store.cancelMomentUpload()
  const rejected = assert.rejects(pending, /已取消上传/)
  timers.shift().run()
  await rejected
  assert.deepEqual(uploads.slice(2).map(upload => upload.aborts), [1, 1, 1])
  assert.equal(uploads.length, 5, 'the cancelled retry never starts')
  assert.equal(creates.length, 0)
  assert.deepEqual(released, [{ ids: [a.fileID], published: [] }])
  c.report(99)
  d.report(99)
  assert.equal(progress.length, progressBeforeCancel, 'cancelled uploads never report further progress')

  const next = store.uploadMomentImages(['/later.jpg'])
  await nextTurn()
  uploads[5].succeed()
  assert.deepEqual(Array.from(await next), [uploads[5].fileID])
})
