const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const clone = value => JSON.parse(JSON.stringify(value))

function loadTS(file, imports = {}, globals = {}) {
  const context = vm.createContext({
    exports: {}, console, Date, Error, setTimeout, clearTimeout,
    require: id => imports[id] || {}, ...globals,
  })
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context)
  return context
}

async function verifyServer() {
  let documents = { couples: {
    space: {
      _id: 'space', memberA: { openid: 'a' }, memberB: { openid: 'b' },
      startDate: '2026-01-01', usageVersion: 2,
      usage: { momentCount: 0, mediaItems: 0, storageBytes: 0 },
    },
  }, moments: {}, moment_likes: {}, moment_comments: {}, rants: {} }
  const removedFiles = []
  let failFiles = false
  let failTransaction = false
  const db = {
    command: { remove: () => ({ remove: true }) },
    collection(name) {
      documents[name] ||= {}
      const query = filter => ({
        async get() { return { data: Object.values(documents[name]).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).map(clone) } },
        async remove() {
          for (const row of (await this.get()).data) delete documents[name][row._id]
        },
      })
      return {
        where: query,
        doc(id) {
          return {
            async get() { return { data: documents[name][id] ? clone(documents[name][id]) : null } },
            async set({ data }) { documents[name][id] = { ...clone(data), _id: id } },
            async remove() { delete documents[name][id] },
            async update({ data }) {
              const doc = documents[name][id]
              assert(doc)
              for (const [key, value] of Object.entries(data)) {
                const keys = key.split('.')
                let object = doc
                for (const part of keys.slice(0, -1)) object = object[part] ||= {}
                if (value?.remove) delete object[keys.at(-1)]
                else object[keys.at(-1)] = clone(value)
              }
            },
          }
        },
      }
    },
    async runTransaction(run) {
      if (failTransaction) throw new Error('transaction unavailable')
      const before = clone(documents)
      try { return await run(db) } catch (error) { documents = before; throw error }
    },
  }
  const sdk = {
    init() {}, database: () => db,
    async deleteFile({ fileList }) {
      if (!failFiles) removedFiles.push(...fileList)
      return { fileList: fileList.map(fileID => ({ fileID, status: failFiles ? -503001 : 0 })) }
    },
  }
  const context = vm.createContext({
    exports: {}, console, Date, Buffer,
    require: id => id === 'wx-server-sdk' ? sdk : require(id),
    readRecords: name => Object.values(documents[name] || {}).map(clone),
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/ours/index.js'), 'utf8') + `
    assertTextSafe = async () => {};
    getAllByWhere = async name => readRecords(name);
    measureCloudFileBytes = async ids => ids.length * 100;
    globalThis.api = { addMoment, deleteMoment, cleanupUploadedFiles, drainMediaCleanup, updateMoment, setMomentLike, compareMomentOrder };
  `, context)
  const api = context.api
  const image = 'cloud://test.bucket/moments/space/images/image.jpg'
  const payload = { coupleId: 'space', requestId: 'request_123456', content: 'first', momentDate: '2026-10-13', images: [image] }
  const first = await api.addMoment('a', payload)
  const repeat = await api.addMoment('a', payload)
  assert.equal(first.id, repeat.id)
  assert.equal(Object.keys(documents.moments).length, 1)
  assert.equal(documents.couples.space.usage.momentCount, 1)
  await api.cleanupUploadedFiles('a', { coupleId: 'space', fileIDs: [image] })
  for (const task of Object.values(documents.couples.space.mediaCleanup)) task.readyAt = 0
  await api.drainMediaCleanup('space')
  assert.equal(removedFiles.length, 0, 'Published media must never be cleaned as failed uploads')
  await assert.rejects(() => api.updateMoment('b', { coupleId: 'space', momentId: first.id, content: 'wrong owner', momentDate: '2026-10-13' }), /只能编辑/)
  await api.updateMoment('a', { coupleId: 'space', momentId: first.id, content: 'edited', momentDate: '2026-10-12' })
  assert.equal(documents.moments[first.id].content, 'edited')
  assert.equal(documents.couples.space.usage.momentCount, 1)
  await api.setMomentLike('b', { coupleId: 'space', momentId: first.id, liked: true })
  await api.setMomentLike('b', { coupleId: 'space', momentId: first.id, liked: true })
  assert.equal(Object.keys(documents.moment_likes).length, 1)
  failTransaction = true
  await assert.rejects(() => api.deleteMoment('a', { coupleId: 'space', momentId: first.id }), /transaction unavailable/)
  assert(documents.moments[first.id])
  assert.equal(removedFiles.length, 0, 'No file deletion before the transaction commits')
  failTransaction = false
  failFiles = true
  await api.deleteMoment('a', { coupleId: 'space', momentId: first.id })
  assert(!documents.moments[first.id])
  assert.equal(documents.couples.space.usage.momentCount, 0)
  assert.equal(Object.keys(documents.couples.space.mediaCleanup).length, 1)
  failFiles = false
  for (const task of Object.values(documents.couples.space.mediaCleanup)) task.readyAt = 0
  await api.drainMediaCleanup('space')
  assert(removedFiles.includes(image))
  assert.equal(Object.keys(documents.couples.space.mediaCleanup).length, 0)
  await api.deleteMoment('a', { coupleId: 'space', momentId: first.id })
  assert(api.compareMomentOrder(
    { momentDate: '2026-10-13', createdAt: new Date('2026-10-13T18:00:10+08:00').getTime() },
    { momentDate: '2026-10-13', createdAt: new Date('2026-10-13T10:00:50+08:00').getTime() },
  ) < 0)
  console.log('PASS: publish deduplication, protected media, transaction rollback, cleanup retry, edit ownership, stable likes, chronological order')
}

async function verifyDraft(directory) {
  const storage = new Map()
  const original = path.join(directory, 'photo.jpg')
  fs.writeFileSync(original, Buffer.from([1, 2, 3, 4]))
  const context = loadTS('miniprogram/services/compose-draft.ts', {
    './session': { coupleId: () => 'space', requireSession: () => ({ role: 'B' }) },
  }, { wx: {
    env: { USER_DATA_PATH: directory },
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    getStorageSync: key => storage.get(key),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({
      mkdirSync: (name, recursive) => fs.mkdirSync(name, { recursive }),
      copyFile: ({ srcPath, destPath, success, fail }) => fs.copyFile(srcPath, destPath, error => error ? fail(error) : success()),
      accessSync: name => fs.accessSync(name),
      rmdirSync: name => fs.rmSync(name, { recursive: true, force: true }),
    }),
  } })
  const api = context.exports
  await api.saveComposeDraft({
    requestId: 'draft_request', content: '', tagSelected: 'travel', momentDate: '2026-10-01',
    location: 'Shanghai', locationFull: { name: 'Shanghai', latitude: 31, longitude: 121 },
    images: [original], video: original, videoCover: original,
    livePhotos: [{ id: 'live', cover: original, video: original, duration: 3 }],
    voice: { path: original, duration: 5 },
  })
  const restored = api.readComposeDraft()
  assert.equal(restored.momentDate, '2026-10-01')
  assert.equal(restored.location, 'Shanghai')
  assert(restored.images[0].includes('ours-draft-draft_request'))
  assert.equal(restored.video, restored.images[0])
  assert.equal(restored.voice.path, restored.images[0])
  assert.equal(restored.livePhotos[0].video, restored.images[0])
  assert(fs.readFileSync(restored.images[0]).equals(fs.readFileSync(original)))
  api.clearComposeDraft('draft_request')
  assert(fs.existsSync(original), 'Clearing a draft must only remove its own copies')
  console.log('PASS: full media-only draft persistence, scoped storage, original-file preservation')
}

async function verifyClient() {
  let calls = 0
  const api = loadTS('miniprogram/services/cloud-api.ts', {}, {
    wx: { cloud: { callFunction: async () => { calls++; throw new Error('response lost') } } },
  }).exports
  await assert.rejects(() => api.callOurs('addComment', {}), /response lost/)
  assert.equal(calls, 1, 'Non-idempotent writes must never automatically retry')
  calls = 0
  await assert.rejects(() => api.callOurs('addMoment', { requestId: 'same-request' }), /response lost/)
  assert.equal(calls, 2, 'Publishing may retry only with a stable request ID')

  let definition
  const context = loadTS('miniprogram/pages/home/home.ts', {
    '../../services/theme': { getThemeStyle: () => '' },
  }, {
    Page: value => { definition = value },
    wx: { getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 720 }) },
  })
  const page = { ...definition, data: { ...definition.data, fabLeft: 300, fabTop: 500 }, setData(data) { Object.assign(this.data, data) } }
  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [] })
  page.onFabTouchStart(touch(300, 500))
  page.onFabTouchMove(touch(150, 350))
  assert.equal(page.data.fabLeft, 150)
  assert.equal(page.data.fabTop, 350)
  assert(context)
  console.log('PASS: write retry policy and live + drag coordinates')
}

async function verifyFeedRace() {
  const pending = new Map()
  let definition
  loadTS('miniprogram/pages/moments/moments.ts', {
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => 'lavender' },
    '../../services/store': {
      getIdentity: () => ({ role: 'B' }), getCouple: () => ({ startDate: '2026-01-01' }),
      listMomentsPage: options => new Promise(resolve => pending.set(options.tag, resolve)),
      getOnThisDayMoments: async () => [], getMomentsBriefStats: async () => ({ total: 1 }),
    },
    '../../services/moments-feed-cache': { feedCacheKey: () => 'key', takePrefetchedFeed: async () => null },
    '../../utils/moments-timeline': {
      buildTimelineRows: items => items.map(item => ({ type: 'moment', key: item.id })),
      scenesFromMoments: () => [],
    },
  }, { Page: value => { definition = value }, wx: { showToast() {} } })
  const page = { ...definition, data: { ...definition.data }, setData(data) { Object.assign(this.data, data) } }
  page.data.filterTag = 'daily'
  const oldRequest = page.refresh()
  await new Promise(resolve => setImmediate(resolve))
  page.data.filterTag = 'travel'
  const newRequest = page.refresh()
  await new Promise(resolve => setImmediate(resolve))
  pending.get('travel')({ items: [{ id: 'travel-memory' }], total: 1, hasMore: false })
  await newRequest
  pending.get('daily')({ items: [{ id: 'daily-memory' }], total: 1, hasMore: false })
  await oldRequest
  assert.equal(page.data.rows[0].key, 'travel-memory')
  assert.equal(page.data.loading, false)

  const timing = loadTS('miniprogram/utils/moment-time.ts', {
    '../services/date': { todayKey: () => '2026-10-13' },
  }).exports
  const timeline = loadTS('miniprogram/utils/moments-timeline.ts', {
    '../services/date': { daysBetween: () => 20 },
    '../services/format': { formatSlate: () => ({ md: '10.13', dow: 'Tue' }) },
    './tags': { tagLabel: () => '' },
    './moment-time': timing,
  }).exports
  const record = id => ({ id, images: [], content: 'memory', momentDate: '2026-10-13', createdAt: 1, authorRole: 'B' })
  const first = timeline.buildTimelineRows([record('first')], 2, 0, 'B', '2026-01-01')
  const next = timeline.buildTimelineRows([record('next')], 2, 1, 'B', '2026-01-01', '2026-10')
  assert.equal(first.filter(row => row.type === 'month').length, 1)
  assert.equal(next.filter(row => row.type === 'month').length, 0)
  assert.equal(next[0].scene.author, '我')
  assert.equal(timing.momentDateOf({ momentDate: '2026-10-13', createdAt: 1 }), '2026-10-13')
  assert.equal(new Date(timing.momentDisplayAt(record('first'))).getDate(), 13)
  console.log('PASS: rapid filter switching ignores stale results; pagination avoids repeated month headings; B identity and display dates stay correct')
}

async function verifyBackup(directory) {
  const { zipBackupPart } = require(path.join(root, 'cloudfunctions/ours/backup'))
  const target = path.join(directory, 'backup.zip')
  const snapshot = {
    coupleId: 'space', id: 'backup', parts: 1, records: { moments: [{ content: 'memory' }] },
    files: [{ fileID: 'file-1', path: 'media/photo.jpg' }, { fileID: 'missing', path: 'media/missing.jpg' }],
  }
  const result = await zipBackupPart({
    async downloadFile({ fileID }) {
      if (fileID === 'missing') throw new Error('file unavailable')
      return { fileContent: Buffer.from([1, 2, 3, 4]) }
    },
    async uploadFile({ fileContent }) {
      const chunks = []
      for await (const chunk of fileContent) chunks.push(chunk)
      fs.writeFileSync(target, Buffer.concat(chunks))
      return { fileID: 'backup-file' }
    },
  }, snapshot, 0, snapshot.files)
  assert.equal(result.missing, 1)
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', target, 'records.json'])).moments[0].content, 'memory')
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', target, 'backup-status.json'])).missing.length, 1)
  assert(execFileSync('unzip', ['-p', target, 'media/photo.jpg']).equals(Buffer.from([1, 2, 3, 4])))
  console.log('PASS: ZIP contains records, original media bytes, and an explicit missing-file manifest')
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ours-verify-'))
  try {
    await verifyServer()
    await verifyDraft(directory)
    await verifyBackup(directory)
    await verifyClient()
    await verifyFeedRace()
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
