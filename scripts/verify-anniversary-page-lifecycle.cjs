const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../miniprogram/subpages/anniversaries/anniversaries.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const rows = [
  { id: 'first', title: '相遇', date: '2026-11-20', daysLeft: 0 },
  { id: 'second', title: '纪念日', date: '2026-11-21', daysLeft: 1 },
]
const event = id => ({ currentTarget: { dataset: { id } } })
const input = (page, title) => page.onTitleInput({ detail: { value: title } })
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let definition
  let saved = [...rows]
  const deleted = [], modals = [], toasts = [], submissions = []
  let reads = 0
  const store = {
    async listAnniversaries() { reads++; return saved },
    async deleteAnniversary(id) { deleted.push(id); saved = saved.filter(row => row.id !== id) },
    async addAnniversary(input) {
      submissions.push(input)
      const record = { ...input, id: `new-${submissions.length}`, daysLeft: 0 }
      saved = [...saved, record]
      return record
    },
  }
  const modules = {
    '../../services/store': {
      listAnniversaries: (...args) => store.listAnniversaries(...args),
      deleteAnniversary: (...args) => store.deleteAnniversary(...args),
      addAnniversary: (...args) => store.addAnniversary(...args),
    },
    '../../services/page-boot': { ensureCloudReady: async () => true },
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/date': { todayKey: () => rows[0].date },
    '../../services/types': {},
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
  }
  vm.runInNewContext(source, {
    Error, exports: {}, require: id => { assert.ok(modules[id], id); return modules[id] },
    Page: value => { definition = value },
    wx: { showModal: options => modals.push(options), showToast: ({ title }) => toasts.push(title) },
  })
  const createPage = () => {
    const page = { ...definition, data: structuredClone(definition.data) }
    page.setData = patch => Object.assign(page.data, patch)
    return page
  }
  return { createPage, deleted, modals, toasts, submissions, store, reads: () => reads }
}

test('离开纪念日页会撤销尚未确认的删除，迟到的原生确认不执行', async () => {
  const f = fixture()
  const page = f.createPage()
  await page.onShow()
  const removing = page.onDelete(event('first'))
  assert.equal(f.modals.length, 1)
  page.onUnload?.()
  const settled = await Promise.race([removing.then(() => true), tick().then(() => false)])
  f.modals[0].success({ confirm: true })
  await removing
  assert.deepEqual(f.deleted, [])
  assert.equal(settled, true)
})

test('一个删除确认打开时，连点同条和另一条只弹出一次确认', async () => {
  const f = fixture()
  const page = f.createPage()
  await page.onShow()
  const first = page.onDelete(event('first'))
  const duplicate = page.onDelete(event('first'))
  const other = page.onDelete(event('second'))
  const modalCount = f.modals.length
  f.modals[0].success({ confirm: true })
  for (const modal of f.modals.slice(1)) modal.success({ confirm: false })
  await Promise.all([first, duplicate, other])
  assert.equal(modalCount, 1)
  assert.deepEqual(f.deleted, ['first'])
  const next = page.onDelete(event('second'))
  f.modals.at(-1).success({ confirm: false })
  await next
  assert.equal(f.modals.length, 2)
})

test('保存回执晚于退出时不干扰其他页面，重开后列表和新表单正常', async () => {
  const f = fixture()
  const page = f.createPage()
  await page.onShow()
  const save = f.store.addAnniversary
  let sendReceipt
  f.store.addAnniversary = async input => {
    const saved = await save(input)
    await new Promise(resolve => { sendReceipt = resolve })
    return saved
  }
  page.onToggleAdd()
  input(page, '新条目')
  const saving = page.onSubmitAdd()
  await tick()
  page.onUnload?.()
  const reads = f.reads(), snapshot = structuredClone(page.data)
  sendReceipt()
  await saving
  assert.deepEqual(f.toasts, [])
  assert.equal(f.reads(), reads)
  assert.deepEqual(structuredClone(page.data), snapshot)

  const reopened = f.createPage()
  await reopened.onShow()
  assert.ok(reopened.data.list.some(row => row.id === 'new-1'))
  reopened.onToggleAdd()
  assert.equal(reopened.data.titleDraft, '')
  assert.equal(reopened.data.saveUnconfirmed, false)
})

test('收起未提交的表单保留名称和日期，隐藏时收到的输入回调不覆盖草稿', async () => {
  const f = fixture()
  const page = f.createPage()
  await page.onShow()
  page.onToggleAdd()
  input(page, '还没保存')
  page.onPickDate({ detail: { value: rows[1].date } })
  page.onToggleAdd()
  input(page, '迟到的输入')
  page.onPickDate({ detail: { value: rows[0].date } })
  await page.onSubmitAdd()
  assert.equal(f.submissions.length, 0)
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, '还没保存')
  assert.equal(page.data.dateDraft, rows[1].date)
  await page.onSubmitAdd()
  assert.equal(f.submissions[0].date, rows[1].date)
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, '')
  assert.equal(page.data.dateDraft, rows[0].date)
})

test('弱网重试成功后清除待确认状态，下一次相同输入可以主动另存', async () => {
  const f = fixture()
  const page = f.createPage()
  await page.onShow()
  const save = f.store.addAnniversary
  let committed
  f.store.addAnniversary = async input => {
    if (!committed) {
      committed = await save(input)
      throw new Error('回执丢失')
    }
    if (input.requestId !== f.submissions[0].requestId) return save(input)
    f.submissions.push(input)
    return committed
  }
  page.onToggleAdd()
  input(page, ' 原名称 ')
  await page.onSubmitAdd()
  assert.equal(page.data.saveUnconfirmed, true)
  page.onToggleAdd()
  await page.onShow()
  assert.ok(page.data.list.some(item => item.id === committed.id))
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, ' 原名称 ')
  f.store.listAnniversaries = async () => { throw new Error('列表暂时不可用') }
  await page.onSubmitAdd()
  assert.deepEqual(f.submissions[1], f.submissions[0])
  assert.equal(page.data.saveUnconfirmed, false)
  assert.equal(page.data.showAdd, false)
  assert.equal(page.data.list.filter(item => item.id === committed.id).length, 1)
  assert.equal(page.data.loadError, '列表暂时不可用')
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, '')
  input(page, '原名称')
  await page.onSubmitAdd()
  assert.notEqual(f.submissions[2].requestId, f.submissions[0].requestId)
  assert.equal(page.data.list.filter(item => item.title === '原名称').length, 2)
})
