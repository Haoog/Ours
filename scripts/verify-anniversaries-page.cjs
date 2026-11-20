const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const pagePath = path.join(__dirname, '../miniprogram/subpages/anniversaries/anniversaries')
const source = ts.transpileModule(fs.readFileSync(`${pagePath}.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const markup = fs.readFileSync(`${pagePath}.wxml`, 'utf8')
const retryHandler = markup.match(/<button\b[^>]*bindtap="(\w+)"[^>]*>[^<]*重试刷新[^<]*<\/button>/)?.[1]

async function verify(initialRows) {
  const saved = { id: 'new', title: '新纪念日', date: '2026-11-18', daysLeft: 0 }
  let serverRows = initialRows.slice()
  let offline = false
  let bootReady = true
  let reads = 0
  let writes = 0
  let holdRead = false
  let deletes = 0
  let modals = 0
  let confirmDelete
  let finishOldRead
  let page
  const toasts = []
  const modules = {
    '../../services/store': {
      async listAnniversaries() {
        reads++
        if (offline) throw new Error('网络断开')
        const snapshot = serverRows
        if (holdRead) {
          holdRead = false
          await new Promise(resolve => { finishOldRead = resolve })
        }
        return snapshot
      },
      async deleteAnniversary(id) {
        deletes++
        serverRows = serverRows.filter(row => row.id !== id)
        offline = true
      },
      async addAnniversary(input) {
        writes++
        assert.equal(input.title, saved.title)
        assert.equal(input.date, saved.date)
        serverRows = [...serverRows, saved]
        offline = true
        return saved
      },
    },
    '../../services/page-boot': { ensureCloudReady: async () => bootReady },
    '../../services/date': { todayKey: () => '2026-11-20' },
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
  }
  vm.runInNewContext(source, {
    Error,
    exports: {},
    wx: { showToast: ({ title }) => toasts.push(title), showModal(options) { modals++; confirmDelete = options.success } },
    Page: value => { page = value },
    require: id => modules[id],
  })
  page.setData = data => Object.assign(page.data, data)
  const ids = () => Array.from(page.data.list, item => item.id)

  bootReady = false
  await page.onShow()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.loadError, '暂时连不上，请重试')
  assert.equal(reads, 0)
  bootReady = true
  await page[retryHandler]()
  const originalIds = initialRows.map(item => item.id)
  assert.deepEqual(ids(), originalIds)
  holdRead = true
  const oldRefresh = page.refresh()
  assert.equal(typeof finishOldRead, 'function')
  page.onToggleAdd()
  page.onTitleInput({ detail: { value: saved.title } })
  page.onPickDate({ detail: { value: saved.date } })
  await page.onShow()
  assert.equal(page.data.dateDraft, saved.date, 'Returning to an unfinished form must retain its selected date')
  page.onToggleAdd()
  page.onTitleInput({ detail: { value: '迟到的输入事件' } })
  page.onPickDate({ detail: { value: '2026-11-21' } })
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, saved.title)
  assert.equal(page.data.dateDraft, saved.date)
  const adding = page.onSubmitAdd()
  const duplicateAdd = page.onSubmitAdd()
  page.onToggleAdd()
  page.onPickDate({ detail: { value: '2026-11-21' } })
  assert.equal(page.data.showAdd, true)
  assert.equal(page.data.dateDraft, saved.date)
  await Promise.all([adding, duplicateAdd])
  assert.equal(writes, 1)
  assert.equal(reads, 4)
  assert.deepEqual(toasts, ['已添加'])
  assert.equal(page.data.showAdd, false)
  assert.equal(page.data.titleDraft, '')
  assert.equal(page.data.submitting, false)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.loadError, '网络断开')
  assert.deepEqual(ids(), ['new', ...originalIds], 'The saved receipt remains visible if the refresh fails')
  assert.equal(page.pendingAdd, null)
  assert.equal(page.data.saveUnconfirmed, false)
  page.onToggleAdd()
  assert.equal(page.data.titleDraft, '')
  assert.equal(page.data.dateDraft, '2026-11-20')
  page.onToggleAdd()

  // The same page-level control works whether or not the old list has rows.
  assert.match(markup, /<view\s+wx:if="{{loadError}}"[^>]*>\s*<text[^>]*>[^<]*<\/text>\s*<text\s+wx:if="{{!empty}}"[^>]*>正在显示上次加载的纪念日<\/text>/)
  assert.ok(retryHandler, '刷新错误需要提供可点击的页内按钮')
  assert.match(markup, /wx:elif="{{!loadError}}" class="empty-stage"/)
  await page[retryHandler]()
  assert.equal(page.data.loadError, '网络断开')
  assert.deepEqual(ids(), ['new', ...originalIds])
  assert.equal(writes, 1)
  assert.equal(reads, 5)

  offline = false
  await Promise.all([page[retryHandler](), page[retryHandler]()])
  finishOldRead()
  await oldRefresh
  assert.equal(page.data.loadError, '')
  assert.equal(page.data.loading, false)
  assert.equal(page.data.empty, false)
  assert.deepEqual(ids(), ['new', ...originalIds])
  assert.equal(reads, 6)
  assert.equal(writes, 1)

  const event = { currentTarget: { dataset: { id: saved.id } } }
  const deleting = page.onDelete(event)
  await page.onDelete(event)
  if (initialRows.length) await page.onDelete({ currentTarget: { dataset: { id: initialRows[0].id } } })
  assert.equal(modals, 1)
  confirmDelete({ confirm: true })
  await deleting
  assert.equal(page.data.loadError, '网络断开')
  assert.deepEqual(ids(), originalIds, 'A confirmed deletion stays removed even if the refresh fails')
  assert.equal(page.data.empty, initialRows.length === 0)
  await page.onDelete(event)
  assert.equal(deletes, 1)

  if (initialRows.length) {
    const closing = page.onDelete({ currentTarget: { dataset: { id: initialRows[0].id } } })
    assert.equal(modals, 2)
    offline = false
    holdRead = true
    const closingRefresh = page.onShow()
    while (holdRead) await Promise.resolve()
    page.onUnload()
    page.setData = () => assert.fail('Unloaded page was updated')
    confirmDelete({ confirm: true })
    finishOldRead()
    await Promise.all([closing, closingRefresh])
    assert.equal(deletes, 1)
    assert.deepEqual(toasts, ['已添加'])
  }
}

async function main() {
  await verify([])
  await verify([{ id: 'old', title: '旧纪念日', date: '2026-11-19', daysLeft: 1 }])
  console.log('纪念日页面回归通过（空列表、已有列表）')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
