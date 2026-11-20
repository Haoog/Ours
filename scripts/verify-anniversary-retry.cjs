const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const compile = file => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const sources = {
  server: read('cloudfunctions/ours/index.js'),
  page: compile('miniprogram/subpages/anniversaries/anniversaries.ts'),
  store: compile('miniprogram/services/store.ts'),
  api: compile('miniprogram/services/cloud-api.ts'),
}
const once = 'addAnniversaryOnce'
const legacy = 'addAnniversary'
const payload = { coupleId: 'space', title: '相遇', date: '2026-11-20', requestId: 'request_123' }

function fixture({ oldCloud = false } = {}) {
  let rows = {
    couples: {
      space: { memberA: { openid: 'member-a' }, memberB: { openid: 'member-b' } },
      suspended: { memberA: { openid: 'member-a' }, status: 'suspended' },
      expired: { memberA: { openid: 'member-a' }, expiresAt: 1 },
    },
    anniversaries: {},
  }
  let openid
  let legacyId = 0
  let writes = 0
  let transactions = Promise.resolve()
  let clock = Date.now()
  const calls = []
  const toasts = []
  const mock = {
    transport: (event, send) => send(event),
    moderate: async () => ({ result: { suggest: 'pass' } }),
  }

  function collection(tables, name, transactional = false) {
    const table = tables[name]
    assert.ok(table, `Unexpected collection: ${name}`)
    return {
      doc: id => ({
        async get() {
          if (!Object.hasOwn(table, id)) throw new Error('DOCUMENT_NOT_EXIST')
          return { data: structuredClone(table[id]) }
        },
        async update({ data }) {
          assert.ok(transactional && name === 'couples')
          Object.assign(table[id], structuredClone(data))
        },
        async set({ data }) {
          assert.ok(transactional && name === 'anniversaries')
          writes++
          table[id] = { ...structuredClone(data), _id: id }
        },
      }),
      async add({ data }) {
        assert.ok(!transactional && name === 'anniversaries')
        const _id = `legacy-${++legacyId}`
        table[_id] = { ...structuredClone(data), _id }
        writes++
        return { _id }
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
    command: { set: value => value },
    collection: name => collection(rows, name),
    runTransaction(run) {
      const result = transactions.then(async () => {
        const staged = structuredClone(rows)
        const value = await run({ collection: name => collection(staged, name, true) })
        rows = staged
        return value
      })
      transactions = result.catch(() => {})
      return result
    },
  }
  const cloud = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }),
    openapi: { security: { msgSecCheck: input => mock.moderate(input) } },
  }

  function evaluate(code, modules, globals) {
    const exports = {}
    vm.runInNewContext(code, {
      exports, Error, console, clearTimeout,
      setTimeout: (fn, ms) => setTimeout(fn, ms === 400 ? 0 : ms),
      Date: class extends Date { static now() { return ++clock } },
      require: id => {
        assert.ok(Object.hasOwn(modules, id), `Unexpected module: ${id}`)
        return modules[id]
      },
      ...globals,
    })
    return exports
  }

  // Simulate a deployed switch that predates the new action, using the real default handler.
  const onceRoute = /^      case 'addAnniversaryOnce':\r?\n        data = await addAnniversary\(openid, payload, true\)\r?\n        break\r?\n/m
  const serverCode = oldCloud ? sources.server.replace(onceRoute, '') : sources.server
  const server = evaluate(serverCode, { 'wx-server-sdk': cloud, crypto: require('node:crypto'), https: {} })
  const main = async (event, author = 'member-a') => {
    openid = author
    return structuredClone(await server.main(event))
  }
  const wx = {
    cloud: { async callFunction({ name, data }) {
      assert.equal(name, 'ours')
      calls.push(structuredClone(data))
      return { result: await mock.transport(data, main) }
    } },
    showToast: ({ title }) => toasts.push(title),
  }
  const api = evaluate(sources.api, {}, { wx })
  const store = evaluate(sources.store, {
    './cloud-api': api, './session': { coupleId: () => 'space' }, './date': {},
    './upload-cleanup': {}, '../utils/cloud-url-cache': {}, '../utils/async-pool': {},
  })
  let page
  evaluate(sources.page, {
    '../../services/store': store,
    '../../services/page-boot': { ensureCloudReady: async () => true },
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/date': { todayKey: () => payload.date },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
  }, { wx, Page: definition => { page = definition } })
  page.setData = patch => Object.assign(page.data, patch)
  const title = value => page.onTitleInput({ detail: { value } })
  const date = value => page.onPickDate({ detail: { value } })
  const fill = () => { page.onToggleAdd(); title(` ${payload.title} `); date(payload.date) }
  return {
    page, mock, main, api, toasts, fill, title, date,
    saves: () => calls.filter(call => call.action === once || call.action === legacy),
    records: () => Object.values(rows.anniversaries),
    writes: () => writes,
  }
}

test('写入成功后丢失回执，自动重试只保留一条，确认后可主动保存同名同日', async () => {
  const f = fixture()
  let receipt
  f.mock.transport = async (event, send) => {
    const response = await send(event)
    if (event.action !== once && event.action !== legacy) return response
    if (!receipt) {
      receipt = response
      throw new Error('写入成功后回执丢失')
    }
    if (f.saves().length === 2) assert.deepEqual(response, receipt)
    return response
  }
  f.fill()
  await Promise.all([f.page.onSubmitAdd(), f.page.onSubmitAdd()])
  const [first, retry] = f.saves()
  assert.equal(f.writes(), 1)
  assert.equal(f.page.data.showAdd, false, '保存应收到重试回执并关闭表单')
  assert.equal(first.action, once)
  assert.deepEqual(retry, first)
  assert.equal(f.page.data.list[0].id, receipt.data.id)
  assert.deepEqual(f.toasts, ['已添加'])

  f.fill()
  await f.page.onSubmitAdd()
  assert.notEqual(f.saves()[2].payload.requestId, first.payload.requestId)
  assert.equal(f.writes(), 2)
  assert.deepEqual(f.records().map(({ title, date }) => ({ title, date })), [
    { title: payload.title, date: payload.date }, { title: payload.title, date: payload.date },
  ])
  assert.equal(new Set(Array.from(f.page.data.list, item => item.id)).size, 2)
})

test('页面关闭后收到成功回执，不更新已关闭页面或留下待确认保存', async () => {
  const f = fixture()
  let releaseReceipt, notifyWrite
  const written = new Promise(resolve => { notifyWrite = resolve })
  const holdReceipt = new Promise(resolve => { releaseReceipt = resolve })
  f.mock.transport = async (event, send) => {
    const response = await send(event)
    if (event.action === once) {
      notifyWrite()
      await holdReceipt
    }
    return response
  }
  f.fill()
  const adding = f.page.onSubmitAdd()
  await written
  f.page.onUnload()
  f.page.setData = () => assert.fail('Unloaded page was updated')
  releaseReceipt()
  await adding
  assert.equal(f.writes(), 1)
  assert.equal(f.saves().length, 1)
  assert.equal(f.page.pendingAdd, null)
  assert.deepEqual(f.toasts, [])
})

test('自动重试也无回执时，收起、刷新及改回原值后仍可用原请求号确认', async () => {
  const f = fixture()
  f.mock.transport = async (event, send) => {
    const response = await send(event)
    if (event.action === once || event.action === legacy) throw new Error('回执丢失')
    return response
  }
  f.fill()
  await f.page.onSubmitAdd()
  const unconfirmed = f.page.data.saveUnconfirmed
  const attempts = f.saves().length
  assert.equal(f.writes(), 1)
  f.mock.transport = (event, send) => send(event)
  f.page.onToggleAdd()
  await f.page.onShow()
  assert.equal(f.page.data.list.length, 1)
  f.page.onToggleAdd()
  const reopened = { title: f.page.data.titleDraft.trim(), date: f.page.data.dateDraft }
  f.title('临时修改')
  f.date('2026-11-21')
  f.title(payload.title)
  f.date(payload.date)
  await f.page.onSubmitAdd()
  assert.equal(f.writes(), 1, '再次提交原内容不应重复写入')
  assert.equal(unconfirmed, true)
  assert.equal(attempts, 2)
  assert.deepEqual(reopened, { title: payload.title, date: payload.date })
  assert.equal(f.saves().length, 3)
  for (const call of f.saves()) assert.deepEqual(call, f.saves()[0])
  assert.equal(f.page.data.list.length, 1)
  assert.equal(f.page.data.saveUnconfirmed, false)
  assert.equal(f.toasts.at(-1), '已添加')
})

test('缺少有效回执时保留表单，提交不同日期使用新请求号', async () => {
  const f = fixture()
  f.mock.transport = async (event, send) => {
    const response = await send(event)
    if (event.action === once && f.saves().length === 1) return { ok: true }
    return response
  }
  f.fill()
  await f.page.onSubmitAdd()
  assert.equal(f.page.data.saveUnconfirmed, true)
  assert.equal(f.page.data.showAdd, true)
  assert.equal(f.writes(), 1)
  assert.match(f.toasts.at(-1), /结果未确认/)
  f.date('2026-11-21')
  await f.page.onSubmitAdd()
  assert.notEqual(f.saves()[1].payload.requestId, f.saves()[0].payload.requestId)
  assert.equal(f.writes(), 2)
  assert.deepEqual(f.records().map(row => row.date), [payload.date, '2026-11-21'])
})

test('并发请求只写一次，原回执可重放，请求号按成员隔离', { timeout: 3000 }, async () => {
  const f = fixture()
  let reached = 0
  let release
  const bothReachedModeration = new Promise(resolve => { release = resolve })
  f.mock.moderate = async () => {
    if (++reached === 2) release()
    await bothReachedModeration
    return { result: { suggest: 'pass' } }
  }
  const event = { action: once, payload }
  const [a, b] = await Promise.all([f.main(event), f.main(event)])
  assert.equal(a.ok, true)
  assert.deepEqual(b, a)
  assert.equal(f.writes(), 1)
  f.mock.moderate = async () => { throw new Error('重放不应再审核') }
  assert.deepEqual(await f.main(event), a)
  for (const change of [{ title: '其他名称' }, { date: '2026-11-21' }, { yearly: false }, { remind: false }]) {
    const conflict = await f.main({ action: once, payload: { ...payload, ...change } })
    assert.equal(conflict.ok, false)
    assert.match(conflict.error, /请求编号.*不匹配/)
  }
  assert.equal(f.writes(), 1)
  f.mock.moderate = async () => ({ result: { suggest: 'pass' } })
  const partner = await f.main(event, 'member-b')
  assert.equal(partner.ok, true)
  assert.notEqual(partner.data.id, a.data.id)
  assert.equal(f.writes(), 2)
})

test('旧 action 保留独立新增，两个 action 都检查空间权限，新 action 检查编号和内容', async () => {
  const f = fixture()
  const { requestId, ...input } = payload
  const supplied = await f.main({ action: legacy, payload })
  const oldClient = await f.main({ action: legacy, payload: input })
  assert.equal(supplied.ok, true)
  assert.equal(oldClient.ok, true)
  assert.notEqual(supplied.data.id, oldClient.data.id)
  assert.equal(oldClient.data.yearly, true)
  assert.equal(oldClient.data.remind, true)
  for (const action of [legacy, once]) {
    for (const [author, coupleId, message] of [
      ['', 'space', /openid/], ['outsider', 'space', /无权访问/],
      ['member-a', 'suspended', /暂停/], ['member-a', 'expired', /过期/],
    ]) {
      const denied = await f.main({ action, payload: { ...payload, coupleId } }, author)
      assert.equal(denied.ok, false)
      assert.match(denied.error, message)
    }
  }
  for (const [patch, message] of [
    [{ requestId: undefined }, /请求编号/], [{ requestId: 'bad!' }, /请求编号/],
    [{ title: ' ' }, /名称/], [{ date: '2026-02-30' }, /日期/],
  ]) {
    const invalid = await f.main({ action: once, payload: { ...payload, ...patch } })
    assert.equal(invalid.ok, false)
    assert.match(invalid.error, message)
  }
  f.mock.moderate = async () => ({ result: { suggest: 'risky' } })
  const moderated = await f.main({ action: once, payload })
  assert.equal(moderated.ok, false)
  assert.match(moderated.error, /含有不合适的信息/)
  assert.equal(f.writes(), 2)

  f.mock.moderate = async () => ({ result: { suggest: 'pass' } })
  f.mock.transport = async (event, send) => {
    await send(event)
    throw new Error('旧 action 回执丢失')
  }
  await assert.rejects(f.api.callOurs(legacy, input), /旧 action 回执丢失/)
  assert.equal(f.saves().length, 1)
  assert.equal(f.writes(), 3)
})

test('新前端遇旧云函数显示错误并保留草稿，重试始终只发新 action', async () => {
  const f = fixture({ oldCloud: true })
  f.fill()
  await f.page.onSubmitAdd()
  assert.equal(f.writes(), 0)
  assert.equal(f.page.data.showAdd, true)
  assert.equal(f.page.data.titleDraft.trim(), payload.title)
  assert.match(f.toasts.at(-1), /云端暂不支持/)
  await f.page.onSubmitAdd()
  assert.equal(f.writes(), 0)
  assert.equal(f.saves().length, 2)
  assert.equal(f.saves()[0].action, once)
  assert.deepEqual(f.saves()[1], f.saves()[0])
})
