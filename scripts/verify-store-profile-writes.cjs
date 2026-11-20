const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, mocks, wx, expose = '') {
  const filename = path.join(__dirname, '..', file)
  const source = fs.readFileSync(filename, 'utf8')
  const code = file.endsWith('.ts') ? ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText : source
  const exports = {}
  vm.runInThisContext(`(function (exports, require, wx) {\n${code}\n${expose}\n})`, { filename })(
    exports, id => {
      assert(Object.hasOwn(mocks, id), `Unmocked dependency: ${id}`)
      return mocks[id]
    }, wx,
  )
  return exports
}

const original = {
  id: 'space', startDate: '2024-01-01', streakDays: 1,
  memberA: { openid: 'a', nickname: 'old', avatarUrl: 'old-avatar' },
  memberB: { openid: 'b', nickname: 'partner', avatarUrl: 'old-b-avatar' },
}
const newDate = '2024-02-01'

function client() {
  const pending = []
  const writes = []
  const api = { callOurs: (action, payload) => new Promise(resolve => pending.push({ action, payload, resolve })) }
  const wx = { getStorageSync() {}, setStorageSync: (_, value) => writes.push(structuredClone(value)), removeStorageSync() {} }
  const session = load('miniprogram/services/session.ts', { './cloud-api': api }, wx)
  const store = load('miniprogram/services/store.ts', {
    './cloud-api': api, './session': session, './upload-cleanup': {},
    '../utils/cloud-url-cache': {}, '../utils/async-pool': {}, './date': {},
  }, wx)
  async function bootstrap(couple = original, role = 'A') {
    const request = session.bootstrapSession()
    const next = pending.pop()
    assert.equal(next.action, 'bootstrap')
    next.resolve(couple
      ? { status: 'ready', openid: couple[`member${role}`].openid, role, couple: structuredClone(couple) }
      : { status: 'needsInviteCode', openid: 'other' })
    return request
  }
  return { store, session, bootstrap, pending, writes }
}

async function verifyNormalProfile() {
  const { store, bootstrap, pending, writes } = client()
  await bootstrap(original, 'B')
  const result = store.updateProfile({ nickname: 'new B', avatarUrl: '' })
  const request = pending.pop()
  assert.equal(request.action, 'updateProfile')
  assert.deepEqual(request.payload, { coupleId: 'space', nickname: 'new B', avatarUrl: '' })
  const memberB = { ...original.memberB, nickname: 'new B', avatarUrl: '' }
  request.resolve({ ...original, memberB })
  assert.deepEqual(await result, { ...original, memberB })
  assert.deepEqual(store.getCouple(), { ...original, memberB })
  assert.deepEqual(writes.at(-1).couple, store.getCouple())
}

async function verifyResponseOrder(order) {
  const { store, bootstrap, pending, writes } = client()
  const before = await bootstrap()
  const results = [store.updateStartDate(newDate), store.updateProfile({ nickname: 'new A' })]
  assert.deepEqual(pending.map(request => [request.action, request.payload]), [
    ['updateStartDate', { coupleId: 'space', startDate: newDate }],
    ['updateProfile', { coupleId: 'space', nickname: 'new A' }],
  ])
  const latest = { ...original, streakDays: 4, memberA: { ...original.memberA, avatarUrl: 'new-avatar' } }
  assert.notEqual(await bootstrap(latest), before, '同一身份刷新会替换会话对象')
  const snapshots = [{ ...original, startDate: newDate }, { ...original, memberA: { ...original.memberA, nickname: 'new A' } }]
  for (const i of order) {
    pending[i].resolve(snapshots[i])
    assert.deepEqual(await results[i], snapshots[i])
  }
  assert.deepEqual(store.getCouple(), { ...latest, startDate: newDate, memberA: { ...latest.memberA, nickname: 'new A' } })
  assert.deepEqual(writes.at(-1).couple, store.getCouple())
}

async function verifyRefreshStartedBeforeWrite() {
  const { store, session, bootstrap, pending, writes } = client()
  await bootstrap()
  const staleRefresh = session.syncSession(true)
  const staleRequest = pending.shift()
  const saved = store.updateStartDate(newDate)
  const current = { ...original, startDate: newDate }
  pending.shift().resolve(current)
  await saved

  const freshRefresh = session.syncSession(true)
  const freshRequest = pending.shift()
  assert.notEqual(freshRefresh, staleRefresh, 'A manual refresh after saving must read again')
  staleRequest.resolve({ status: 'ready', openid: 'a', role: 'A', couple: original })
  assert.equal((await staleRefresh).couple.startDate, newDate)
  assert.equal(store.getCouple().startDate, newDate)
  assert.equal(writes.at(-1).couple.startDate, newDate)

  freshRequest.resolve({ status: 'ready', openid: 'a', role: 'A', couple: current })
  assert.equal((await freshRefresh).couple.startDate, newDate)
}

async function verifySessionSwitch(next) {
  const { store, session, bootstrap, pending, writes } = client()
  await bootstrap()
  const results = [store.updateStartDate(newDate), store.updateProfile({ nickname: 'late' })]
  await next({ bootstrap, session, pending })
  const current = structuredClone(session.getSession())
  const writeCount = writes.length
  pending[1].resolve({ ...original, memberA: { ...original.memberA, nickname: 'late' } })
  pending[0].resolve({ ...original, startDate: newDate })
  await Promise.all(results)
  assert.deepEqual(session.getSession(), current, '旧请求不得修改当前会话')
  assert.equal(writes.length, writeCount, '旧请求不得持久化')
}

async function verifyCloudProfile() {
  const { id, ...fields } = structuredClone(original)
  const doc = { _id: id, ...fields }
  const db = { collection: name => {
    assert.equal(name, 'couples')
    return { doc: id => {
      assert.equal(id, doc._id)
      return {
        get: async () => ({ data: structuredClone(doc) }),
        async update({ data }) {
          for (const [key, value] of Object.entries(data)) {
            const [member, field] = key.split('.')
            if (field) doc[member][field] = value
            else doc[key] = value
          }
        },
      }
    } }
  } }
  const { updateProfile } = load('cloudfunctions/ours/index.js', {
    'wx-server-sdk': { init() {}, database: () => db }, crypto: {}, https: {},
  }, undefined, 'exports.updateProfile = updateProfile')
  // 两次读取都看到初始资料，头像先写，昵称随后写。
  await Promise.all([
    updateProfile('a', { coupleId: id, avatarUrl: 'new-avatar' }),
    updateProfile('a', { coupleId: id, nickname: 'new A' }),
  ])
  assert.deepEqual(doc.memberA, { openid: 'a', nickname: 'new A', avatarUrl: 'new-avatar' })
  const result = await updateProfile('b', { coupleId: id, nickname: 'new B', avatarUrl: '' })
  assert.equal(result.id, id)
  assert.deepEqual(result.memberA, doc.memberA)
  assert.deepEqual(result.memberB, { openid: 'b', nickname: 'new B', avatarUrl: '' })
}

async function main() {
  await verifyNormalProfile()
  await verifyResponseOrder([1, 0])
  await verifyResponseOrder([0, 1])
  await verifyRefreshStartedBeforeWrite()
  await verifySessionSwitch(({ bootstrap }) => bootstrap(original, 'B'))
  await verifySessionSwitch(async ({ bootstrap }) => {
    await bootstrap(original, 'B')
    await bootstrap()
  })
  await verifySessionSwitch(({ bootstrap }) => bootstrap(null))
  await verifySessionSwitch(({ session, pending }) => {
    const redeem = session.redeemAccessCodeAndCache({ code: 'local-test', startDate: original.startDate, nickname: 'old' })
    const request = pending.pop()
    assert.equal(request.action, 'redeemAccessCode')
    request.resolve(structuredClone(original))
    return redeem
  })
  await verifyCloudProfile()
  console.log('资料写入回归通过（字段合并、响应乱序、会话切换、云端独立字段）')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
