const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

const today = '2026-11-20'
const location = { name: '公园', address: '路口', latitude: 1, longitude: 2 }
const original = {
  content: '原正文', tagSelected: 'daily', momentDate: '2026-10-01', locationFull: null,
}
const fresh = { content: '另一端更新的正文', momentDate: '2026-10-02', location, tag: 'daily', authorRole: 'A' }
const source = ts.transpileModule(fs.readFileSync('miniprogram/pages/compose/compose.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function scenario(draft, { draftWait, failSave } = {}) {
  const identity = { status: 'ready', role: 'A', coupleId: 'space', openid: 'author' }
  const saves = []
  const writes = []
  const clears = []
  let definition, modal, completeFetch, failFetch, chosenMedia = 0
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/page-boot': { ensureCloudReady: async () => true },
    '../../services/session': { getSession: () => identity },
    '../../services/store': {
      getIdentity: () => identity,
      getCouple: () => ({ startDate: '2026-01-01' }),
      getMoment: () => new Promise((resolve, reject) => { completeFetch = resolve; failFetch = reject }),
      updateMoment: async (id, input) => { writes.push([id, structuredClone(input)]) },
    },
    '../../services/compose-draft': {
      newPublishId: () => 'new-id',
      readComposeDraft: () => typeof draft === 'function' ? draft() : draft,
      waitForComposeDraftSave: () => draftWait,
      saveComposeDraft: async data => {
        if (failSave) throw new Error('local storage full')
        saves.push(structuredClone(data))
      },
      clearComposeDraft: (id, editId) => { clears.push([id, editId]) },
    },
    '../../services/date': { todayKey: () => today },
    '../../utils/moment-time': { formatMomentDateLabel: date => date },
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/moments-list-state': { markMomentsListStale() {} },
    '../../services/moments-feed-cache': { feedCacheKey() {}, prefetchMomentsFeed() {} },
    '../../utils/tags': { MOMENT_TAG_POST: [] },
  }
  const wx = {
    getRecorderManager: () => ({ onStart() {}, onStop() {}, onError() {} }),
    getSystemInfoSync: () => ({ platform: 'ios' }),
    setNavigationBarTitle() {},
    showToast() {},
    showModal(options) { modal = options },
    chooseMedia() { chosenMedia++ },
  }
  vm.runInNewContext(source, {
    Page: value => { definition = value }, require: name => modules[name] || {}, exports: {}, wx, Error,
    setTimeout: () => 1, clearTimeout() {},
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
  return {
    page, saves, writes, clears, chosen: () => chosenMedia,
    resolveFetch: value => completeFetch(value), rejectFetch: error => failFetch(error),
    modal: () => modal,
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const load = test => test.page.onLoad({ id: 'record' })
const tag = (test, key) => test.page.onPickTag({ currentTarget: { dataset: { key } } })

async function verify() {
  const unchanged = scenario(null)
  const loading = load(unchanged)
  assert.equal(unchanged.page.data.editLoading, true)
  unchanged.page.onContentInput({ detail: { value: '等待时输入' } })
  unchanged.page.onPickAlbum()
  assert.equal(unchanged.page.data.content, '')
  assert.equal(unchanged.chosen(), 0)
  await tick()
  unchanged.resolveFetch(fresh)
  await loading
  unchanged.page.onUnload()
  await tick()
  assert.equal(unchanged.saves.length, 0)

  const patch = scenario({ ...original, editBase: original, requestId: 'draft', tagSelected: 'travel' })
  const patched = load(patch)
  await tick()
  patch.resolveFetch(fresh)
  await patched
  assert.equal(patch.modal(), undefined)
  assert.equal(patch.page.data.content, fresh.content)
  assert.equal(patch.page.data.momentDate, fresh.momentDate)
  assert.equal(patch.page.data.location, fresh.location.name)
  assert.equal(patch.page.data.tagSelected, 'travel')
  await patch.page.onSubmit()
  assert.deepEqual(patch.writes, [['record', { tag: 'travel' }]])

  for (const editBase of [original, undefined]) {
    const conflict = scenario({ ...original, editBase, requestId: 'draft', content: '本地改的正文' })
    const pending = load(conflict)
    await tick()
    conflict.resolveFetch(fresh)
    await tick()
    assert.equal(conflict.page.data.editLoading, true)
    conflict.modal().success({ confirm: false })
    await pending
    assert.equal(conflict.page.data.content, fresh.content)
    assert.deepEqual(conflict.clears, [['draft', 'record']])
    tag(conflict, 'travel')
    await conflict.page.onSubmit()
    assert.deepEqual(conflict.writes, [['record', { tag: 'travel' }]])
  }

  const failed = scenario(null)
  const rejected = load(failed)
  await tick()
  failed.rejectFetch(new Error('网络断开'))
  await rejected
  assert.equal(failed.page.data.editError, '网络断开')
  const retried = failed.page.onRetryEdit()
  await tick()
  failed.resolveFetch(fresh)
  await retried
  assert.equal(failed.page.data.editError, '')
  assert.equal(failed.page.data.content, fresh.content)
  let releaseDraft
  const draftWait = new Promise(resolve => { releaseDraft = resolve })
  let savedDraft = { ...original, requestId: 'draft', images: [], livePhotos: [], video: '', voice: null }
  const reopen = scenario(() => savedDraft, { draftWait })
  const opening = reopen.page.onLoad({})
  await tick()
  assert.equal(reopen.page.data.draftLoading, true)
  assert.equal(reopen.page.data.content, '')
  reopen.page.onHide()
  assert.equal(reopen.saves.length, 0)
  savedDraft = { ...savedDraft, content: '最新正文', images: ['/private/photo.jpg'] }
  releaseDraft()
  await opening
  assert.equal(reopen.page.data.draftLoading, false)
  assert.equal(reopen.page.data.content, '最新正文')
  assert.deepEqual(reopen.page.data.images, ['/private/photo.jpg'])

  const diskFull = scenario(null, { failSave: true })
  const edit = load(diskFull)
  await tick()
  diskFull.resolveFetch(fresh)
  await edit
  tag(diskFull, 'travel')
  await diskFull.page.onSubmit()
  assert.deepEqual(diskFull.writes, [['record', { tag: 'travel' }]])
  console.log('PASS: unchanged edit drafts, field merge, conflicts, loading retry, queued restoration, and edit with storage failure')
}

verify().catch(error => { console.error(error); process.exitCode = 1 })
