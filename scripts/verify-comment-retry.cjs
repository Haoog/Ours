const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const loadTS = file => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const source = {
  server: read('cloudfunctions/ours/index.js'),
  page: loadTS('miniprogram/pages/moment-detail/moment-detail.ts'),
  store: loadTS('miniprogram/services/store.ts'),
  cloud: loadTS('miniprogram/services/cloud-api.ts'),
}
const once = 'addCommentOnce'
const payload = { coupleId: 'space', momentId: 'first', content: '你好', requestId: 'request_123' }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  let rows = {
    couples: {
      space: { memberA: { openid: 'author-a' }, memberB: { openid: 'author-b' } },
      other: { memberA: { openid: 'author-a' } },
    },
    moments: {
      first: { coupleId: 'space', kind: 'post' },
      second: { coupleId: 'space', kind: 'post' },
      system: { coupleId: 'space', kind: 'system' },
      outside: { coupleId: 'other', kind: 'post' },
    },
    moment_comments: {},
  }
  let openid
  let tail = Promise.resolve()
  let legacyWrites = 0
  let commentWrites = 0
  let now = Date.now()
  const calls = []
  const toasts = []
  const mock = {
    moderate: async () => ({ result: { suggest: 'pass' } }),
    loseCommitAck: false,
    transport: async (event, send) => send(event),
  }
  const collection = (tables, name, transactional = false) => {
    const table = tables[name]
    assert.ok(table, `Unexpected collection: ${name}`)
    return {
      doc: id => ({
        async get() {
          if (!Object.hasOwn(table, id)) throw new Error('DOCUMENT_NOT_EXIST')
          return { data: structuredClone(table[id]) }
        },
        async update({ data }) { Object.assign(table[id], structuredClone(data)) },
        async set({ data }) {
          assert.ok(transactional && name === 'moment_comments')
          table[id] = { ...structuredClone(data), _id: id }
        },
      }),
      async add({ data }) {
        assert.ok(!transactional && name === 'moment_comments')
        const id = `legacy-${++legacyWrites}`
        table[id] = { ...structuredClone(data), _id: id }
        return { _id: id }
      },
      where: filter => ({
        orderBy(field, direction) {
          assert.equal(field, '_id')
          assert.equal(direction, 'asc')
          return this
        },
        limit: limit => ({
          async get() {
            const matches = row => Object.entries(filter).every(([key, value]) => row[key] === value)
            const data = Object.values(table).filter(matches).sort((a, b) => a._id.localeCompare(b._id))
            return { data: structuredClone(data.slice(0, limit)) }
          },
        }),
      }),
    }
  }
  const db = {
    collection: name => collection(rows, name),
    command: { set: value => value },
    runTransaction(run) {
      const result = tail.then(async () => {
        const staged = structuredClone(rows)
        const value = await run({ collection: name => collection(staged, name, true) })
        const added = Object.keys(staged.moment_comments).length > Object.keys(rows.moment_comments).length
        rows = staged
        if (added) {
          commentWrites++
          if (mock.loseCommitAck) {
            mock.loseCommitAck = false
            throw new Error('commit acknowledgement lost')
          }
        }
        return value
      })
      tail = result.catch(() => {})
      return result
    },
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'offline-fixture', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: openid }),
    openapi: { security: { msgSecCheck: input => mock.moderate(input) } },
  }
  function run(code, modules, globals) {
    const exports = {}
    vm.runInNewContext(code, {
      exports, Error, console, setTimeout, clearTimeout,
      Date: class extends Date { static now() { return ++now } },
      require: id => {
        assert.ok(Object.hasOwn(modules, id), `Unexpected module: ${id}`)
        return modules[id]
      },
      ...globals,
    })
    return exports
  }
  const server = run(source.server, { 'wx-server-sdk': cloud, crypto: require('node:crypto'), https: {} })
  const main = async (event, author = 'author-a') => {
    openid = author
    return structuredClone(await server.main(event))
  }
  const wx = {
    cloud: { async callFunction({ name, data }) {
      assert.equal(name, 'ours')
      calls.push(structuredClone(data))
      return { result: await mock.transport(data, main) }
    } },
    vibrateShort() {}, showToast: toast => toasts.push(toast.title),
  }
  const api = run(source.cloud, {}, { wx, setTimeout: (fn, ms) => setTimeout(fn, ms === 400 ? 0 : ms) })
  const store = run(source.store, {
    './cloud-api': api, './session': { coupleId: () => 'space' }, './date': {},
    './upload-cleanup': {}, '../utils/cloud-url-cache': {}, '../utils/async-pool': {},
  })
  let page
  run(source.page, {
    '../../services/store': {
      ...store, getIdentity: () => ({ role: 'A' }),
      getMoment: async id => ({ ...rows.moments[id], id, content: '', authorRole: 'A', images: [] }),
      getMomentLikes: async () => ({ count: 0 }),
      getMomentNeighbors: async id => id === 'first' ? { nextId: 'second' } : { prevId: 'first' },
    },
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReadyState: async () => 'ready' },
    '../../services/format': { formatSlate: () => ({}) },
    '../../utils/moment-time': { momentDisplayAt: () => 0, isBackdatedMoment: () => false },
    '../../utils/tags': { tagLabel: () => '' },
    '../../utils/cloud-url-cache': {}, '../../services/moments-list-state': { markMomentsListStale() {} },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
  }, { wx, Page: definition => { page = definition } })
  page.setData = patch => Object.assign(page.data, patch)
  const input = value => page.onCommentInput({ detail: { value } })
  const send = () => page.onSubmitComment()
  return {
    mock, main, api, page, input, send, toasts, calls,
    posts: () => calls.filter(call => call.action === once || call.action === 'addComment'),
    comments: () => Object.values(rows.moment_comments),
    writes: () => commentWrites,
  }
}

test('automatic retry after a committed response is lost returns the original comment; a deliberate resend creates another', async () => {
  const f = fixture()
  await f.page.onLoad({ id: 'first' })
  let committed
  f.mock.transport = async (event, send) => {
    const response = await send(event)
    if (event.action === once && !committed) {
      committed = response.data
      throw new Error('response lost after commit')
    }
    if (event.action === once && f.posts().length === 2) assert.deepEqual(response.data, committed)
    return response
  }
  f.input(' 你好 ')
  await Promise.all([f.send(), f.send()])
  const [first, retry] = f.posts()
  assert.deepEqual(retry, first)
  assert.equal(first.action, once)
  assert.equal(f.writes(), 1)
  assert.equal(f.page.data.commentDraft, '')
  assert.equal(f.page.data.comments[0].id, committed.id)
  assert.deepEqual(f.toasts, [])

  f.input('你好')
  await f.send()
  assert.notEqual(f.posts()[2].payload.requestId, first.payload.requestId)
  assert.equal(f.writes(), 2)
  assert.deepEqual(f.comments().map(c => c.content), ['你好', '你好'])
  assert.equal(new Set(Array.from(f.page.data.comments, c => c.id)).size, 2)
})

test('manual retry after both responses are lost merges a comment already shown by refresh', async () => {
  const f = fixture()
  await f.page.onLoad({ id: 'first' })
  f.mock.transport = async (event, send) => {
    await send(event)
    throw new Error('response lost')
  }
  f.input('你好')
  await f.send()
  assert.equal(f.posts().length, 2)
  assert.equal(f.page.data.commentDraft, '你好')
  assert.equal(f.writes(), 1)
  f.mock.transport = (event, send) => send(event)
  await f.page.onShow()
  assert.equal(f.page.data.comments.length, 1)
  f.input(' 你好 ')
  await f.send()
  assert.equal(f.posts().length, 3)
  for (const call of f.posts()) assert.deepEqual(call, f.posts()[0])
  assert.equal(f.page.data.comments.length, 1)
  assert.equal(f.page.data.commentDraft, '')
  assert.equal(f.writes(), 1)
})

test('two concurrent dispatches that both miss the initial read converge inside the transaction', async () => {
  const f = fixture()
  const event = { action: once, payload }
  const bothModerating = deferred()
  let arrivals = 0
  f.mock.moderate = async () => {
    if (++arrivals === 2) bothModerating.resolve()
    await bothModerating.promise
    return { result: { suggest: 'pass' } }
  }
  const [first, retry] = await Promise.all([f.main(event), f.main(event)])
  const id = createHash('sha256').update(JSON.stringify(['space', 'first', 'author-a', payload.requestId])).digest('hex').slice(0, 32)
  assert.equal(arrivals, 2)
  assert.deepEqual(first, retry)
  assert.equal(first.ok, true)
  assert.equal(first.data.id, id)
  assert.deepEqual(Object.keys(first.data).sort(), ['authorOpenid', 'authorRole', 'content', 'coupleId', 'createdAt', 'id', 'momentId'])
  const { id: commentId, ...comment } = first.data
  assert.deepEqual(f.comments(), [{ ...comment, _id: commentId }])
  assert.equal(f.writes(), 1)

  f.mock.moderate = async () => { throw new Error('moderation unavailable') }
  assert.deepEqual(await f.main(event), first)
  const conflict = await f.main({ ...event, payload: { ...payload, content: '其他正文' } })
  assert.equal(conflict.commentRejected, true)
  assert.match(conflict.error, /不匹配/)
  assert.equal(f.writes(), 1)
})

test('an edited draft and a switched record survive delayed acknowledgements', async () => {
  const f = fixture()
  await f.page.onLoad({ id: 'first' })
  const hold = () => {
    const received = deferred()
    const release = deferred()
    f.mock.transport = async (event, send) => {
      const result = await send(event)
      if (event.action === once && event.payload.momentId === 'first') {
        received.resolve()
        await release.promise
      }
      return result
    }
    return { received: received.promise, release: release.resolve }
  }
  const edit = hold()
  f.input('你好')
  const sending = f.send()
  await edit.received
  f.input('修改后的正文')
  edit.release()
  await sending
  assert.equal(f.page.data.commentDraft, '修改后的正文')
  assert.equal(f.page.data.comments[0].content, '你好')

  const previous = hold()
  const previousSend = f.send()
  await previous.received
  await f.page.goNeighbor('next')
  f.input('修改后的正文')
  await f.send()
  previous.release()
  await previousSend
  assert.equal(f.page.data.comments.length, 1)
  assert.equal(f.page.data.comments[0].id, f.comments().find(c => c.momentId === 'second')._id)
  assert.equal(f.page.data.commentDraft, '')
  assert.equal(new Set(f.posts().map(call => call.payload.requestId)).size, 3)
})

test('definitive rejection ends a fresh intent; an uncertain attempt keeps its request number', async () => {
  const f = fixture()
  await f.page.onLoad({ id: 'first' })
  f.input('   ')
  await f.send()
  assert.equal(f.posts().length, 0)
  f.input('你好')
  f.mock.moderate = async () => ({ result: { suggest: 'risky' } })
  await f.send()
  assert.equal(f.posts().length, 1)
  assert.match(f.toasts.at(-1), /不合适/)
  assert.equal(f.page.data.commentDraft, '你好')

  f.mock.transport = async (event, send) => {
    if (f.posts().length === 2) throw new Error('request result unknown')
    return send(event)
  }
  await f.send()
  assert.notEqual(f.posts()[1].payload.requestId, f.posts()[0].payload.requestId)
  assert.deepEqual(f.posts()[2], f.posts()[1])
  assert.match(f.toasts.at(-1), /不合适/)
  f.mock.transport = (event, send) => send(event)
  await f.send()
  assert.deepEqual(f.posts()[3], f.posts()[1])
  assert.equal(f.writes(), 0)

  f.input('改写')
  f.input('你好')
  f.mock.moderate = async () => ({ result: { suggest: 'pass' } })
  f.mock.loseCommitAck = true
  await f.send()
  assert.notEqual(f.posts()[4].payload.requestId, f.posts()[1].payload.requestId)
  assert.match(f.toasts.at(-1), /commit acknowledgement lost/)
  assert.equal(f.writes(), 1)
  await f.send()
  assert.deepEqual(f.posts()[5], f.posts()[4])
  assert.equal(f.writes(), 1)
  assert.equal(f.page.data.commentDraft, '')
})

test('server validates target and key, scopes IDs, and keeps the legacy action compatible', async () => {
  const f = fixture()
  const submit = (patch, author) => f.main({ action: once, payload: { ...payload, ...patch } }, author)
  for (const [patch, message] of [
    [{ requestId: undefined }, /请求编号/], [{ requestId: 'bad!' }, /请求编号/],
    [{ content: '  ' }, /填写/], [{ momentId: 'system' }, /系统卡片/],
    [{ momentId: 'outside' }, /动态不存在/], [{ momentId: 'missing' }, /动态不存在/],
  ]) {
    const result = await submit(patch)
    assert.equal(result.ok, false)
    assert.equal(result.commentRejected, true)
    assert.match(result.error, message)
  }
  const denied = await submit({}, 'non-member')
  assert.equal(denied.ok, false)
  assert.match(denied.error, /无权访问/)
  assert.equal(f.comments().length, 0)

  const a = await submit({})
  const b = await submit({}, 'author-b')
  const otherMoment = await submit({ momentId: 'second' })
  const otherSpace = await submit({ coupleId: 'other', momentId: 'outside' })
  assert.equal(b.data.authorRole, 'B')
  assert.equal(new Set([a, b, otherMoment, otherSpace].map(result => result.data.id)).size, 4)
  const legacy = { action: 'addComment', payload: { coupleId: 'space', momentId: 'first', content: ' 你好 ' } }
  const [oldFirst, oldSecond] = [await f.main(legacy), await f.main(legacy)]
  assert.equal(oldFirst.ok, true)
  assert.equal(oldFirst.data.content, '你好')
  assert.notEqual(oldFirst.data.id, oldSecond.data.id)
  assert.deepEqual(Object.keys(oldFirst.data).sort(), Object.keys(a.data).sort())
})

test('an older cloud function never receives a fallback legacy write', async () => {
  const f = fixture()
  await f.page.onLoad({ id: 'first' })
  f.mock.transport = async (event, send) => {
    if (event.action === once) return { ok: false, error: `未知 action: ${once}` }
    return send(event)
  }
  f.input('你好')
  await f.send()
  assert.deepEqual(f.posts().map(call => call.action), [once])
  assert.equal(f.comments().length, 0)
  assert.match(f.toasts.at(-1), /未知 action/)

  f.mock.transport = async () => { throw new Error('request lost') }
  await assert.rejects(f.api.callOurs(once, {}), /request lost/)
  await assert.rejects(f.api.callOurs('addComment', payload), /request lost/)
  assert.deepEqual(f.posts().map(call => call.action), [once, once, 'addComment'])
})
