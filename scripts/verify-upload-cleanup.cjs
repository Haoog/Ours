const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')

const source = fs.readFileSync(require('node:path').join(__dirname, '../miniprogram/services/upload-cleanup.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const storage = new Map()
let session = { status: 'ready', openid: 'a', coupleId: 'one' }
let failStorage = false
let handler = async () => ({ queued: 1 })
let calls = []
let now = 0
let nextTimer = 1
const timers = new Map()
const fakeDate = class extends Date { static now() { return now } }
const persistentFailureLogs = []
const testConsole = {
  ...console,
  warn: (...args) => {
    if (args[0] === '待清理文件将在下次重试' && args[1]?.message === 'persistent failure') persistentFailureLogs.push(args)
    else console.warn(...args)
  },
}
async function advance(ms) {
  const end = now + ms
  for (;;) {
    const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    now = next[1].at
    timers.delete(next[0])
    next[1].fn()
    // Flush asynchronous cloud requests and the continuation that schedules the next batch.
    for (let i = 0; i < 1000; i++) await Promise.resolve()
  }
  now = end
}
function resetTimers() { timers.clear(); now = 0 }
const wx = {
  getStorageSync: key => { if (failStorage) throw Error('storage'); return storage.get(key) || '' },
  setStorageSync: (key, value) => { if (failStorage) throw Error('storage'); storage.set(key, structuredClone(value)) },
}
function load() {
  const exports = {}
  vm.runInNewContext(code, { exports, wx, console: testConsole, Set, Array, JSON, Date: fakeDate,
    setTimeout: (fn, delay) => { const id = nextTimer++; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout: id => timers.delete(id), require: name => {
    if (name === './session') return { getSession: () => session }
    if (name === './cloud-api') return { callOurs: async (action, payload) => { calls.push(payload); return handler(payload) } }
    throw Error(name)
  } })
  return exports
}
const owner = { openid: 'a', coupleId: 'one' }
const entries = () => storage.get('OURS_UPLOAD_CLEANUP_V1') || []
async function main() {
  let q = load()
  q.holdUpload(owner, 'cloud://one/a')
  q.holdUpload(owner, 'cloud://one/a')
  assert.equal(entries().length, 1, 'deduplicate')
  await q.retryUploadCleanup()
  assert.equal(calls.length, 0, 'in-flight upload is held')
  q.releaseUploads(owner, ['cloud://one/a'], new Set())
  handler = async () => { throw Error('backup gate') }
  await q.retryUploadCleanup()
  assert.equal(entries().length, 1, 'business failure persists')
  q = load()
  handler = async () => { throw Error('network') }
  await q.retryUploadCleanup()
  assert.equal(entries().length, 1, 'network failure persists after restart')
  handler = async () => ({ queued: 1 })
  await advance(30000)
  assert.equal(entries().length, 0, 'success removes entry after backoff')
  resetTimers()
  q.holdUpload(owner, 'cloud://one/published')
  q.releaseUploads(owner, ['cloud://one/published'], new Set(['cloud://one/published']))
  assert.equal(entries().length, 0, 'confirmed published file removed locally')
  q.holdUpload(owner, 'cloud://one/uncertain')
  q.releaseUploads(owner, ['cloud://one/uncertain'], new Set())
  calls = []
  session = { status: 'ready', openid: 'b', coupleId: 'one' }
  await q.retryUploadCleanup()
  session = { status: 'ready', openid: 'a', coupleId: 'two' }
  await q.retryUploadCleanup()
  assert.equal(calls.length, 0, 'member and space isolation')
  session = { status: 'ready', ...owner }
  q = load()
  await q.retryUploadCleanup()
  assert.equal(calls[0].fileIDs[0], 'cloud://one/uncertain', 'uncertain publication goes through server delayed reference checks')
  q.holdUpload(owner, 'cloud://one/bad')
  q.holdUpload(owner, 'cloud://one/good')
  q.releaseUploads(owner, ['cloud://one/bad', 'cloud://one/good'], new Set())
  handler = async p => { if (p.fileIDs[0].endsWith('/bad')) throw Error('gate'); return { queued: 1 } }
  await q.retryUploadCleanup()
  assert.deepEqual(entries().map(e => e.fileID), ['cloud://one/bad'], 'one failure does not block others')
  failStorage = true
  assert.throws(() => q.holdUpload(owner, 'cloud://one/storage'), /storage/)
  handler = async () => ({ queued: 1 })
  assert.equal(await q.fallbackUploadCleanup(owner, ['cloud://one/storage']), true)
  handler = async () => { throw Error('network') }
  assert.equal(await q.fallbackUploadCleanup(owner, ['cloud://one/storage']), false)
  failStorage = false
  assert.equal(entries().length, 1, 'storage failure does not overwrite existing queue')
  // Failed publication recording must retain the in-memory hold and never enqueue it.
  resetTimers(); storage.clear(); calls = []; q = load()
  q.holdUpload(owner, 'cloud://one/published-storage-failure')
  failStorage = true
  assert.throws(() => q.releaseUploads(owner, ['cloud://one/published-storage-failure'], new Set(['cloud://one/published-storage-failure'])), /storage/)
  failStorage = false; handler = async () => ({ queued: 1 })
  await q.retryUploadCleanup()
  assert.equal(calls.length, 0, 'failed storage update keeps published file held')
  q.releaseUploads(owner, ['cloud://one/published-storage-failure'], new Set(['cloud://one/published-storage-failure']))
  assert.equal(entries().length, 0)

  resetTimers(); storage.clear(); calls = []; q = load()
  for (let i = 0; i < 125; i++) q.holdUpload(owner, `cloud://one/${i}`)
  q.releaseUploads(owner, entries().map(e => e.fileID), new Set())
  handler = async p => { if (Number(p.fileIDs[0].split('/').pop()) < 50) throw Error('persistent failure'); return { queued: 1 } }
  await q.retryUploadCleanup()
  assert.equal(calls.length, 50, 'first pass is bounded')
  await advance(200)
  assert.equal(calls.length, 125, 'later batches advance automatically')
  assert.equal(entries().length, 50, 'later successful entries are removed despite earlier failures')
  await advance(29799)
  assert.equal(calls.length, 125, 'failed entries respect backoff')
  await advance(1)
  assert.equal(calls.length, 175, 'failed entries retry after backoff')
  assert.equal(persistentFailureLogs.length, 100, 'each expected persistent failure is logged across both attempts')
  await advance(59999)
  assert.equal(calls.length, 175, 'repeated failures use longer backoff')

  resetTimers(); storage.clear(); calls = []; q = load()
  for (let i = 0; i < 60; i++) q.holdUpload(owner, `cloud://one/switch-${i}`)
  q.releaseUploads(owner, entries().map(e => e.fileID), new Set())
  handler = async () => ({ queued: 1 })
  await q.retryUploadCleanup()
  session = { status: 'ready', openid: 'a', coupleId: 'two' }
  await advance(1000)
  assert.equal(calls.length, 50, 'scheduled old-space batch stops after switch')
  session = { status: 'ready', ...owner }
  resetTimers(); storage.clear(); calls = []; q = load()
  q.holdUpload(owner, 'cloud://one/inflight-1')
  q.holdUpload(owner, 'cloud://one/inflight-2')
  q.releaseUploads(owner, entries().map(e => e.fileID), new Set())
  let resolveRequest
  handler = () => new Promise(resolve => { resolveRequest = resolve })
  const inflight = q.retryUploadCleanup()
  session = { status: 'ready', openid: 'a', coupleId: 'two' }
  resolveRequest({ queued: 1 })
  await inflight
  assert.equal(calls.length, 1, 'space switch stops an in-flight batch')
  assert.equal(entries().length, 2, 'old session response does not alter local queue')
  session = { status: 'ready', ...owner }
  resetTimers(); storage.clear(); calls = []; q = load()
  q.holdUpload(owner, 'cloud://one/network')
  q.releaseUploads(owner, ['cloud://one/network'], new Set())
  handler = async () => { throw Error('network') }
  await q.retryUploadCleanup()
  for (let i = 0; i < 5; i++) await q.retryUploadCleanup()
  await advance(29999)
  assert.equal(calls.length, 1, 'network failures and repeated events do not hot loop')
  resetTimers(); storage.clear(); calls = []; q = load()
  failStorage = true; handler = async () => { throw Error('offline') }
  assert.equal(await q.fallbackUploadCleanup(owner, ['cloud://one/emergency']), false)
  session = { status: 'ready', openid: 'b', coupleId: 'one' }
  failStorage = false; handler = async () => ({ queued: 1 }); calls = []
  await q.retryUploadCleanup()
  assert.equal(calls.length, 0, 'emergency record is isolated on account switch')
  assert.equal(entries().length, 1, 'emergency record persists when storage recovers')
  session = { status: 'ready', ...owner }
  await q.retryUploadCleanup()
  assert.equal(calls[0].fileIDs[0], 'cloud://one/emergency')
  assert.equal(entries().length, 0)

  resetTimers(); storage.clear(); calls = []; q = load()
  failStorage = true; handler = async () => { throw Error('offline') }
  assert.equal(await q.fallbackUploadCleanup(owner, ['cloud://one/network-recovery']), false)
  handler = async () => ({ queued: 1 }); calls = []
  await q.retryUploadCleanup()
  assert.equal(calls[0].fileIDs[0], 'cloud://one/network-recovery', 'network recovery registers while storage remains unavailable')
  failStorage = false; resetTimers()

  resetTimers(); storage.clear(); calls = []; q = load()
  q.holdUpload(owner, 'cloud://one/reheld')
  q.releaseUploads(owner, ['cloud://one/reheld'], new Set())
  handler = () => new Promise(resolve => { resolveRequest = resolve })
  const oldRequest = q.retryUploadCleanup()
  q.holdUpload(owner, 'cloud://one/reheld')
  resolveRequest({ queued: 1 }); await oldRequest
  assert.equal(entries().length, 1, 'old response cannot remove new hold')
  q.releaseUploads(owner, ['cloud://one/reheld'], new Set())
  handler = async () => ({ queued: 1 })
  await q.retryUploadCleanup()
  assert.equal(entries().length, 0)
  // A cached ready session must not start cleanup until bootstrap succeeds.
  const appSource = fs.readFileSync(require('node:path').join(__dirname, '../miniprogram/app.ts'), 'utf8')
  const appCode = ts.transpileModule(appSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  let app, network, bootCalls = 0, cleanupCalls = 0, resolveBoot
  const cached = { status: 'ready', ...owner }
  const appWx = { cloud: { init() {} }, onNetworkStatusChange: fn => { network = fn }, getAccountInfoSync: () => ({}), showModal() {}, reLaunch() {} }
  vm.runInNewContext(appCode, { exports: {}, wx: appWx, console, App: value => { app = value }, getCurrentPages: () => [], require: name => {
    if (name === './config/env') return { CLOUD_ENV_ID: 'test' }
    if (name === './services/theme') return { applyThemeChrome() {} }
    if (name === './services/upload-cleanup') return { retryUploadCleanup: async () => { cleanupCalls++ } }
    if (name === './services/session') return { getSession: () => cached, bootstrapSession: () => { bootCalls++; return bootCalls === 1 ? Promise.reject(Error('offline')) : new Promise(resolve => { resolveBoot = resolve }) } }
    throw Error(name)
  } })
  app.onLaunch({}); await app.waitBoot()
  app.onShow({}); assert.equal(cleanupCalls, 0, 'cached session is not verified')
  network({ isConnected: true }); network({ isConnected: true })
  assert.equal(bootCalls, 2, 'reconnect starts one verification')
  assert.equal(cleanupCalls, 0, 'verification must finish before cleanup')
  resolveBoot(cached); await app.waitBoot()
  assert.equal(cleanupCalls, 1, 'successful verification starts cleanup')
  network({ isConnected: true }); assert.equal(cleanupCalls, 2)
  console.log('upload cleanup behavioral checks passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
