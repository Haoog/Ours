const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, '../miniprogram/pages/moment-detail/moment-detail.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText
const flush = () => new Promise(resolve => setImmediate(resolve))
const likes = (likedByB, count) => ({ likedByA: !likedByB && count > 0, likedByB, count })
const neighbors = (prevId = null, nextId = null) => ({ prevId, nextId, index: prevId ? 2 : 1, total: 2 })

function mount() {
  let page
  let staleMarks = 0
  const requests = []
  const toasts = []
  const patches = []
  const hold = (action, ...args) => new Promise((resolve, reject) => {
    requests.push({ action, args, resolve, reject })
  })
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/store': {
      getIdentity: () => ({ role: 'B' }),
      getMoment: async id => ({ id, images: [], authorRole: 'A', createdAt: Date.now() }),
      listComments: async () => [],
      getMomentLikes: id => hold('read likes', id),
      getMomentNeighbors: id => hold('read neighbors', id),
      setMomentLike: (id, liked) => hold('write like', id, liked),
    },
    '../../services/format': { formatSlate: () => ({ md: '', dow: '' }) },
    '../../utils/moment-time': { isBackdatedMoment: () => false, momentDisplayAt: moment => moment.createdAt },
    '../../utils/tags': { tagLabel: () => '' },
    '../../services/moments-list-state': { markMomentsListStale() { staleMarks++ } },
    '../../utils/cloud-url-cache': {},
  }
  vm.runInNewContext(source, {
    require(id) { assert.ok(modules[id], `Unexpected dependency ${id}`); return modules[id] },
    exports: {}, Error,
    wx: { vibrateShort() {}, showToast({ title }) { toasts.push(title) } },
    Page(definition) { page = definition },
  })
  page.setData = patch => { patches.push(patch); Object.assign(page.data, patch) }
  const take = (action, ...args) => {
    const request = requests.shift()
    assert.equal(request?.action, action)
    assert.deepEqual(request.args, args)
    return request
  }
  const read = async id => {
    await flush()
    return { likes: take('read likes', id), neighbors: take('read neighbors', id) }
  }
  const finishRead = async (opening, id, snapshot, adjacent) => {
    const pending = await read(id)
    pending.likes.resolve(snapshot)
    pending.neighbors.resolve(adjacent ?? neighbors())
    await opening
  }
  const expectLike = (liked, count, liking = false) => {
    assert.deepEqual([page.data.liked, page.data.likeCount, page.data.liking], [liked, count, liking])
  }
  return { page, read, take, finishRead, expectLike, requests, patches, toasts, staleMarks: () => staleMarks }
}

test('an older read cannot overwrite a successful like while neighbors are still loading', async () => {
  const { page, read, take, expectLike, staleMarks } = mount()
  const opening = page.onLoad({ id: 'a' })
  const pending = await read('a')
  pending.likes.resolve(likes(false, 0))
  await flush()

  const writing = page.onToggleLike()
  expectLike(true, 1, true)
  take('write like', 'a', true).resolve(likes(true, 2))
  await writing
  expectLike(true, 2)

  pending.neighbors.resolve(neighbors(null, 'b'))
  await opening
  expectLike(true, 2)
  assert.equal(page.data.nextId, 'b')
  assert.equal(staleMarks(), 1)
})

test('same-page return preserves the confirmed baseline and lets a fresh read update it', async () => {
  const { page, read, take, finishRead, expectLike } = mount()
  await finishRead(page.onLoad({ id: 'a' }), 'a', likes(true, 2))
  const returning = page.onShow()
  const pending = await read('a')
  expectLike(true, 2)
  const writing = page.onToggleLike()
  expectLike(false, 1, true)
  take('write like', 'a', false).resolve(likes(false, 1))
  await writing
  pending.likes.resolve(likes(true, 2))
  pending.neighbors.resolve(neighbors())
  await returning
  expectLike(false, 1)

  await finishRead(page.onShow(), 'a', likes(false, 0))
  expectLike(false, 0)
})

test('a same-record refresh keeps the write in flight and supplies rollback on failure', async () => {
  const { page, read, take, finishRead, expectLike, requests, toasts, staleMarks } = mount()
  await finishRead(page.onLoad({ id: 'a' }), 'a', likes(false, 0))
  const writing = page.onToggleLike()
  const write = take('write like', 'a', true)
  const returning = page.onShow()
  const pending = await read('a')
  await page.onToggleLike()
  assert.equal(requests.length, 0)
  pending.likes.resolve(likes(false, 1))
  pending.neighbors.resolve(neighbors())
  await returning
  expectLike(true, 1, true)

  write.reject(new Error('写入失败'))
  await writing
  expectLike(false, 1)
  assert.deepEqual(toasts, ['写入失败'])
  assert.equal(staleMarks(), 0)
})

test('switching records and returning to the same ID isolates old writes and busy flags', async () => {
  const { page, take, finishRead, expectLike, toasts, staleMarks } = mount()
  await finishRead(page.onLoad({ id: 'a' }), 'a', likes(false, 0), neighbors(null, 'b'))
  const oldA = page.onToggleLike()
  const oldAWrite = take('write like', 'a', true)
  await finishRead(page.goNeighbor('next'), 'b', likes(false, 1), neighbors('a'))
  expectLike(false, 1)
  const oldB = page.onToggleLike()
  const oldBWrite = take('write like', 'b', true)
  await finishRead(page.goNeighbor('prev'), 'a', likes(false, 0), neighbors(null, 'b'))
  const currentA = page.onToggleLike()
  const currentWrite = take('write like', 'a', true)

  oldBWrite.reject(new Error('旧页面的写入失败'))
  await oldB
  expectLike(true, 1, true)
  oldAWrite.resolve(likes(true, 2))
  await oldA
  expectLike(true, 1, true)
  assert.deepEqual(toasts, [])
  assert.equal(staleMarks(), 1)

  currentWrite.resolve(likes(true, 1))
  await currentA
  expectLike(true, 1)
  assert.equal(staleMarks(), 2)
})

for (const succeeds of [true, false]) {
  test(`unload discards a delayed read and a ${succeeds ? 'successful' : 'failed'} write's page callbacks`, async () => {
    const { page, read, take, finishRead, expectLike, patches, toasts, staleMarks } = mount()
    const opening = page.onLoad({ id: 'a' })
    const pending = await read('a')
    const writing = page.onToggleLike()
    const write = take('write like', 'a', true)
    page.onUnload()
    const patchCount = patches.length

    pending.likes.resolve(likes(false, 1))
    pending.neighbors.resolve(neighbors(null, 'b'))
    if (succeeds) write.resolve(likes(true, 2))
    else write.reject(new Error('页面已卸载'))
    await Promise.all([opening, writing])
    assert.equal(patches.length, patchCount)
    assert.deepEqual(toasts, [])
    assert.equal(staleMarks(), succeeds ? 1 : 0)

    await finishRead(page.onLoad({ id: 'a' }), 'a', likes(true, 1))
    expectLike(true, 1)
  })
}


test('首次点赞读取失败只重试失败项，已加载的相邻记录不丢失', async () => {
  const { page, read, take, requests, expectLike } = mount()
  const opening = page.onLoad({ id: 'a' })
  const pending = await read('a')
  pending.likes.reject(new Error('点赞读取失败'))
  await flush()
  assert.equal(page.data.likeUnavailable, true)
  assert.match(page.data.interactionError, /点此重试/)
  await page.onToggleLike()
  assert.equal(requests.length, 0)
  pending.neighbors.resolve(neighbors(null, 'b'))
  await opening
  assert.equal(page.data.nextId, 'b')
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/moment-detail/moment-detail.wxml'), 'utf8')
  const binding = template.match(/wx:if="{{interactionError}}"[^>]*bindtap="([^"]+)"/)[1]
  const itemBeforeRetry = page.data.item
  const retry = page[binding]()
  await page[binding]()
  assert.equal(requests.length, 1)
  assert.equal(page.data.likeUnavailable, true)
  take('read likes', 'a').resolve(likes(true, 2))
  await retry
  expectLike(true, 2)
  assert.equal(page.data.likeUnavailable, false)
  assert.equal(page.data.interactionError, '')
  assert.equal(page.data.nextId, 'b')
  assert.equal(page.data.item, itemBeforeRetry)
  const write = page.onToggleLike()
  take('write like', 'a', false).resolve(likes(false, 1))
  await write
  expectLike(false, 1)
})
