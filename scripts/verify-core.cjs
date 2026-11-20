const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
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
  const realSdk = require(path.join(root, 'cloudfunctions/ours/node_modules/wx-server-sdk'))
  realSdk.init({ env: 'offline-test' })
  const realCommand = realSdk.database().command
  const { UpdateSerializer } = require(path.join(root, 'cloudfunctions/ours/node_modules/@cloudbase/database/dist/commonjs/serializer/update'))
  const replacement = { tickets: {}, backup: null }
  const serialized = UpdateSerializer.encode({ spaceGate: realCommand.set(replacement) })
  assert.deepEqual(serialized, { $set: { spaceGate: replacement } })
  assert.deepEqual(UpdateSerializer.encode({ spaceGate: replacement }), { $set: { 'spaceGate.backup': null } })
  const existing = { spaceGate: { tickets: { old: 123 }, backup: null } }
  Object.assign(existing, serialized.$set)
  assert.deepEqual(existing.spaceGate.tickets, {})
  console.log('PASS: real SDK atomically replaces gate including empty tickets')
  let documents = { couples: {
    space: {
      _id: 'space', memberA: { openid: 'a' }, memberB: { openid: 'b' },
      startDate: '2026-01-01', usageVersion: 2,
      usage: { momentCount: 0, mediaItems: 0, storageBytes: 0 },
    },
  }, moments: {}, moment_likes: {}, moment_comments: {}, rants: {} }
  const removedFiles = []
  let failFiles = false
  let omitDeleteResults = false
  let failTransaction = false
  let failRegistration = false
  let afterQuery = null
  let currentOpenid = 'a'
  let uploadHook = null
  let zipHook = null
  let measureHook = null
  let transactionTail = Promise.resolve()
  const snapshotContents = new Map()
  const unreadableFiles = new Set()
  let nextResponse = { statusCode: 200, headers: { 'content-length': '300' } }
  const fakeHttps = {
    request(url, options, callback) {
      const request = new EventEmitter()
      request.destroy = () => {}
      request.end = () => setImmediate(() => callback({ ...nextResponse, destroy() {} }))
      return request
    },
  }
  const matches = (row, filter) => {
    if (filter.or) return filter.or.some(part => matches(row, part))
    return Object.entries(filter).every(([key, expected]) => {
      const actual = key.split('.').reduce((value, part) => value?.[part], row)
      if (expected?.gt !== undefined) return actual > expected.gt
      if (expected?.lt !== undefined) return actual < expected.lt
      if (expected?.in) return expected.in.includes(actual)
      return actual === expected
    })
  }
  const db = {
    command: {
      remove: () => ({ remove: true }),
      set: value => ({ __set: value }),
      or: or => ({ or }),
      gt: gt => ({ gt }),
      lt: lt => ({ lt }),
      in: values => ({ in: values }),
    },
    collection(name) {
      documents[name] ||= {}
      const query = (filter, offset = 0, size = 100, order = []) => ({
        skip(value) { return query(filter, value, size, order) },
        limit(value) { return query(filter, offset, value, order) },
        orderBy(field, direction) { return query(filter, offset, size, [...order, [field, direction]]) },
        field() { return this },
        async count() { return { total: Object.values(documents[name]).filter(row => matches(row, filter)).length } },
        async get() {
          const rows = Object.values(documents[name]).filter(row => matches(row, filter))
          rows.sort((a, b) => {
            for (const [key, direction] of order) {
              if (a[key] === b[key]) continue
              return (a[key] > b[key] ? 1 : -1) * (direction === 'asc' ? 1 : -1)
            }
            return 0
          })
          const result = { data: rows.slice(offset, offset + size).map(clone) }
          if (afterQuery) await afterQuery(name, result)
          return result
        },
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
              if (failRegistration && Object.keys(data).some(key => key.startsWith('mediaCleanup.'))) throw new Error('registration unavailable')
              const apply = (key, value) => {
                if (value && typeof value === 'object' && !Array.isArray(value) && !value.remove && !Object.hasOwn(value, '__set')) {
                  for (const [child, item] of Object.entries(value)) apply(`${key}.${child}`, item)
                  return
                }
                const keys = key.split('.')
                let object = doc
                for (const part of keys.slice(0, -1)) object = object[part] ||= {}
                if (value?.remove) delete object[keys.at(-1)]
                else object[keys.at(-1)] = clone(value && Object.hasOwn(value, '__set') ? value.__set : value)
              }
              for (const [key, value] of Object.entries(data)) apply(key, value)
            },
          }
        },
      }
    },
    async runTransaction(run) {
      if (failTransaction) throw new Error('transaction unavailable')
      let unlock
      const previous = transactionTail
      transactionTail = new Promise(resolve => { unlock = resolve })
      await previous
      const before = clone(documents)
      const transaction = { collection: name => ({ doc: db.collection(name).doc }) }
      try { return await run(transaction) } catch (error) { documents = before; throw error } finally { unlock() }
    },
  }
  const sdk = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: currentOpenid }),
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = `cloud://test.bucket/${cloudPath}`
      snapshotContents.set(fileID, JSON.parse(fileContent.toString('utf8')))
      if (uploadHook) await uploadHook(fileID)
      return { fileID }
    },
    async getTempFileURL({ fileList }) {
      return { fileList: fileList.map(fileID => unreadableFiles.has(fileID)
        ? { fileID, status: -503003 }
        : { fileID, tempFileURL: 'https://example.invalid/media', status: 0 }) }
    },
    async downloadFile({ fileID }) {
      if (!snapshotContents.has(fileID)) throw new Error('download unavailable')
      return { fileContent: Buffer.from(JSON.stringify(snapshotContents.get(fileID))) }
    },
    async deleteFile({ fileList }) {
      if (!failFiles) removedFiles.push(...fileList)
      if (omitDeleteResults) return { fileList: [] }
      return { fileList: fileList.map(fileID => ({ fileID, status: failFiles ? -503001 : 0 })) }
    },
  }
  const context = vm.createContext({
    exports: {}, console, Date, Buffer, process: { env: {} },
    require: id => id === 'wx-server-sdk' ? sdk : id === 'https' ? fakeHttps : id === './backup' ? { planFiles: async (_cloud, files) => [files.map(file => ({ ...file, size: 100 }))], zipBackupPart: (...args) => zipHook(...args) } : require(id),
    readRecords: name => Object.values(documents[name] || {}).map(clone),
    onMeasure: async () => { if (measureHook) await measureHook() },
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/ours/index.js'), 'utf8') + `
    assertTextSafe = async () => {};
    const originalMeasurements = [measureCloudFileSizes, measureCloudFileBytes];
    globalThis.restoreMediaMeasurements = () => {
      [measureCloudFileSizes, measureCloudFileBytes] = originalMeasurements;
    };
    measureCloudFileSizes = async ids => { await onMeasure(); return new Map(ids.map(id => [id, 100])); };
    measureCloudFileBytes = async ids => { await onMeasure(); return ids.length * 100; };
    globalThis.api = { addMoment, deleteMoment, cleanupUploadedFiles, drainMediaCleanup, updateMoment, setMomentLike, compareMomentOrder,
      createPartnerInvite, joinPartnerInvite, getAllByWhere, redeemAccessCode, seedDemoData, queryMomentsPage, getMomentNeighbors, deleteCloudFiles, cloudFileInPath,
      prevDayKey, daysUntilAnniversary, dateKeyEpoch, rebuildUsage, listComments, listAnniversaries, deleteComment, deleteAnniversary,
      addComment, addAnniversary, updateStartDate, requestContentLength, listMapPlaces, listMomentCollections };
  `, context)
  const api = context.api
  assert.equal(api.prevDayKey('2024-03-01'), '2024-02-29')
  assert.equal(api.prevDayKey('2026-01-01'), '2025-12-31')
  assert(Number.isNaN(api.dateKeyEpoch('2026-02-29')))
  const anniversaryNow = new Date('2026-11-19T16:00:00Z') // 2026-11-20 in Beijing
  assert.equal(api.daysUntilAnniversary('2027-12-01', true, anniversaryNow), 376)
  assert.equal(api.daysUntilAnniversary('2020-11-19', true, anniversaryNow), 364)
  assert.equal(api.daysUntilAnniversary('2026-11-20', true, anniversaryNow), 0)
  assert.equal(api.daysUntilAnniversary('2020-11-20', true, anniversaryNow), 0)
  const nonLeapFeb28 = new Date('2025-02-27T16:00:00Z')
  assert.equal(api.daysUntilAnniversary('2028-02-29', true, nonLeapFeb28), 1096)
  assert.equal(api.daysUntilAnniversary('2020-02-29', true, nonLeapFeb28), 0)
  assert.equal(api.daysUntilAnniversary('2020-02-29', true, new Date('2025-02-28T16:00:00Z')), 364)

  documents.anniversaries = {
    future: { _id: 'future', coupleId: 'space', title: '未来纪念日', date: '2027-12-01', yearly: true },
    legacy: { _id: 'legacy', coupleId: 'space', title: '历史纪念日', date: '2020-12-10' },
    past: { _id: 'past', coupleId: 'space', title: '一次性纪念日', date: '2026-11-19', yearly: false },
  }
  context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [anniversaryNow.getTime()])) }
    static now() { return anniversaryNow.getTime() }
  }
  try {
    const payload = { coupleId: 'space' }
    const list = await context.exports.main({ action: 'listAnniversaries', payload })
    assert.equal(list.ok, true, list.error)
    assert.deepEqual(clone(list.data.map(({ id, daysLeft }) => [id, daysLeft])), [['legacy', 20], ['past', -1], ['future', 376]])
    const next = await context.exports.main({ action: 'getNextAnniversary', payload })
    assert.deepEqual(clone(next), {
      ok: true, data: { id: 'legacy', title: '历史纪念日', date: '2020-12-10', daysLeft: 20, label: '还有 20 天' },
    })
  } finally {
    context.Date = Date
    delete documents.anniversaries
  }
  assert.equal(await api.requestContentLength('https://example.invalid/file'), 300)
  nextResponse = { statusCode: 206, headers: { 'content-length': '1', 'content-range': 'bytes 0-0/300' } }
  assert.equal(await api.requestContentLength('https://example.invalid/file', 'GET'), 300)
  nextResponse = { statusCode: 206, headers: { 'content-length': '1' } }
  assert.equal(await api.requestContentLength('https://example.invalid/file', 'GET'), null)
  nextResponse = { statusCode: 404, headers: { 'content-length': '100' } }
  assert.equal(await api.requestContentLength('https://example.invalid/file'), null)
  const image = 'cloud://test.bucket/moments/space/images/image.jpg'
  assert(api.cloudFileInPath(image, 'moments/space/'))
  assert(!api.cloudFileInPath('cloud://test.bucket/moments/other/moments/space/file.jpg', 'moments/space/'))
  assert(!api.cloudFileInPath('cloud://test.bucket/moments/space/../other/file.jpg', 'moments/space/'))
  omitDeleteResults = true
  assert.equal((await api.deleteCloudFiles([image])).length, 1)
  omitDeleteResults = false
  removedFiles.length = 0
  await assert.rejects(() => api.addMoment('a', { coupleId: 'space', requestId: 'empty_request', momentDate: '2026-10-13' }), /请填写/)
  await assert.rejects(() => api.updateStartDate('a', { coupleId: 'space', startDate: '2026-02-29' }), /日期格式/)
  await assert.rejects(() => api.addAnniversary('a', { coupleId: 'space', title: '生日', date: '2026-02-29' }), /日期格式/)
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
  const previousStartDate = documents.couples.space.startDate
  documents.couples.space.startDate = '2026-10-13'
  const original = clone(documents.moments[first.id])
  await api.updateMoment('a', { coupleId: 'space', momentId: first.id, content: 'edited with legacy date', momentDate: original.momentDate })
  const partial = await context.exports.main({
    action: 'updateMomentFields', payload: { coupleId: 'space', momentId: first.id, content: 'body only' },
  })
  assert.equal(partial.ok, true, partial.error)
  const updated = documents.moments[first.id]
  assert.equal(updated.content, 'body only')
  assert.equal(updated.momentDate, original.momentDate)
  assert.equal(updated.sortAt, original.sortAt)
  assert.deepEqual(updated.location, original.location)
  assert.equal(updated.tag, original.tag)
  await assert.rejects(() => api.updateMoment('a', { coupleId: 'space', momentId: first.id, momentDate: '2026-10-11' }), /开始日/)
  await assert.rejects(() => api.updateMoment('a', { coupleId: 'space', momentId: first.id, momentDate: '2026-02-29' }), /日期格式/)
  await assert.rejects(() => api.addMoment('a', { ...payload, requestId: 'date_regression', momentDate: original.momentDate }), /开始日/)
  documents.couples.space.startDate = previousStartDate
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

  documents.paging = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(id => [id, { _id: id, coupleId: 'space' }]))
  afterQuery = async name => {
    if (name === 'paging') { delete documents.paging.a; afterQuery = null }
  }
  const paged = await api.getAllByWhere('paging', { coupleId: 'space' }, { batchSize: 2 })
  assert.deepEqual(Array.from(paged, row => row._id), ['a', 'b', 'c', 'd', 'e'])

  documents.paging = {
    a: { _id: 'a', coupleId: 'space', momentDate: '2020-01-01', createdAt: 1 },
    b: { _id: 'b', coupleId: 'space', momentDate: '2024-01-01', createdAt: 1 },
    c: { _id: 'c', coupleId: 'space', momentDate: '2024-01-01', createdAt: 2 },
  }
  const sorted = await api.getAllByWhere('paging', { coupleId: 'space' }, { batchSize: 2, orderBy: [['momentDate', 'desc'], ['createdAt', 'desc']] })
  assert.deepEqual(Array.from(sorted, row => row._id), ['c', 'b', 'a'])

  const snapshotID = 'cloud://test.bucket/backups/space/test/snapshot.json'
  const snapshot = { coupleId: 'space', records: { exportedAt: Date.now() }, files: [{ fileID: image }] }
  snapshotContents.set(snapshotID, snapshot)
  documents.couples.space.mediaCleanup = {
    snapshot: { fileIDs: [snapshotID], readyAt: Date.now() + 86400000 },
    media: { fileIDs: [image], readyAt: 0 },
  }
  removedFiles.length = 0
  await api.drainMediaCleanup('space')
  assert(!removedFiles.includes(image))
  assert.deepEqual(documents.couples.space.mediaCleanup.media.fileIDs, [image])
  documents.couples.space.mediaCleanup.media.readyAt = 0
  snapshotContents.delete(snapshotID)
  await assert.rejects(() => api.drainMediaCleanup('space'), /download unavailable/)
  assert(!removedFiles.includes(image))
  assert(documents.couples.space.mediaCleanup.media)
  snapshot.records.exportedAt = Date.now() - 86400000 - 15 * 60 * 1000 - 1
  snapshotContents.set(snapshotID, snapshot)
  await api.drainMediaCleanup('space')
  assert(removedFiles.includes(image), 'Expired snapshot media can be cleaned')
  delete documents.couples.space.mediaCleanup.snapshot
  console.log('PASS: ordered pagination, registered snapshot media retention, download failure and expiry')

  // Exercise the actual entry point while requests are paused inside their work.
  const invoke = (action, payload = {}) => context.exports.main({ action, payload: { coupleId: 'space', ...payload } })
  let resumeQuery, queryEntered
  const queryStarted = new Promise(resolve => { queryEntered = resolve })
  const queryRelease = new Promise(resolve => { resumeQuery = resolve })
  afterQuery = async name => {
    if (name === 'moments') { afterQuery = null; queryEntered(); await queryRelease }
  }
  const reading = invoke('listMoments')
  await queryStarted
  const blockedBackup = await invoke('startBackup')
  assert.equal(blockedBackup.ok, false)
  assert.match(blockedBackup.error, /备份或处理/)
  resumeQuery()
  await reading
  assert.equal(Object.keys(documents.couples.space.spaceGate.tickets).length, 0)
  const raceImage = 'cloud://test.bucket/moments/space/images/race.jpg'
  documents.couples.space.mediaCleanup = { race: { fileIDs: [raceImage], readyAt: 0 } }
  let resumeScan, scanEntered
  const scanStarted = new Promise(resolve => { scanEntered = resolve })
  const scanRelease = new Promise(resolve => { resumeScan = resolve })
  afterQuery = async name => {
    if (name === 'moments') { afterQuery = null; scanEntered(); await scanRelease }
  }
  const maintenance = invoke('deleteMoment', { momentId: 'missing' })
  await scanStarted
  const racingPublish = await invoke('addMoment', { requestId: 'race_request_123', content: 'race', momentDate: '2026-10-13', images: [raceImage] })
  assert.equal(racingPublish.ok, false)
  assert.match(racingPublish.error, /备份或处理/)
  const bootDuringMaintenance = await invoke('bootstrap')
  assert.equal(bootDuringMaintenance.ok, true, bootDuringMaintenance.error)
  assert(documents.couples.space.mediaCleanup.race)
  resumeScan()
  assert.equal((await maintenance).ok, true)
  assert(removedFiles.includes(raceImage))
  const publishedImage = 'cloud://test.bucket/moments/space/images/publish-race.jpg'
  documents.couples.space.mediaCleanup = { publishRace: { fileIDs: [publishedImage], readyAt: 0 } }
  let resumeMeasure, measureEntered
  const measureStarted = new Promise(resolve => { measureEntered = resolve })
  const measureRelease = new Promise(resolve => { resumeMeasure = resolve })
  measureHook = async () => { measureHook = null; measureEntered(); await measureRelease }
  const publishing = invoke('addMoment', { requestId: 'publish_race_123', content: 'published', momentDate: '2026-10-13', images: [publishedImage] })
  await measureStarted
  const blockedMaintenance = await invoke('deleteMoment', { momentId: 'missing' })
  assert.equal(blockedMaintenance.ok, false)
  const busyBoot = await invoke('bootstrap')
  assert.equal(busyBoot.ok, true, busyBoot.error)
  assert(documents.couples.space.mediaCleanup.publishRace)
  resumeMeasure()
  const published = await publishing
  assert.equal(published.ok, true)
  assert.equal((await invoke('deleteMoment', { momentId: 'missing' })).ok, true)
  assert(!removedFiles.includes(publishedImage), 'Published media survives subsequent maintenance')
  assert.equal((await invoke('deleteMoment', { momentId: published.data.id })).ok, true)
  const invalidWrite = await invoke('updateStartDate', { startDate: 'invalid' })
  assert.equal(invalidWrite.ok, false)
  // A failed action must release its ticket.
  assert.equal(Object.keys(documents.couples.space.spaceGate.tickets).length, 0)

  currentOpenid = 'stranger'
  const denied = await invoke('startBackup')
  assert.equal(denied.ok, false)
  assert.equal(Object.keys(documents.couples.space.spaceGate.tickets).length, 0)
  assert.equal(documents.couples.space.spaceGate.backup, null)
  currentOpenid = 'a'

  const protectedImage = 'cloud://test.bucket/moments/space/images/protected.jpg'
  documents.moments.concurrent = { _id: 'concurrent', coupleId: 'space', images: [protectedImage], authorRole: 'A', createdAt: Date.now(), momentDate: '2026-01-01' }
  let releaseUpload, uploadEntered
  const uploadStarted = new Promise(resolve => { uploadEntered = resolve })
  const uploadRelease = new Promise(resolve => { releaseUpload = resolve })
  uploadHook = async () => { uploadEntered(); await uploadRelease }
  const creating = invoke('startBackup')
  await uploadStarted
  const blockedDelete = await invoke('deleteMoment', { momentId: 'concurrent' })
  assert.equal(blockedDelete.ok, false)
  assert(!removedFiles.includes(protectedImage))
  assert(documents.moments.concurrent)
  const blockedBootstrap = await context.exports.main({ action: 'bootstrap', payload: {} })
  assert.equal(blockedBootstrap.ok, true, blockedBootstrap.error)
  releaseUpload()
  const created = await creating
  uploadHook = null
  assert.equal(created.ok, true, created.error)
  const deleted = await invoke('deleteMoment', { momentId: 'concurrent' })
  assert.equal(deleted.ok, true, deleted.error)
  assert(!removedFiles.includes(protectedImage), 'Registered snapshot protects deleted media')
  failRegistration = true
  let failedSnapshot
  uploadHook = async fileID => { failedSnapshot = fileID }
  const failedBackup = await invoke('startBackup')
  assert.equal(failedBackup.ok, false)
  assert(removedFiles.includes(failedSnapshot), 'Unregistered snapshot is deleted')
  uploadHook = null
  const failedZip = 'cloud://test.bucket/backups/space/test/part-1.zip'
  zipHook = async () => ({ fileID: failedZip, missing: 0 })
  const failedExport = await invoke('exportBackupPart', { snapshotFileID: created.data.snapshotFileID, part: 0 })
  assert.equal(failedExport.ok, false)
  assert(removedFiles.includes(failedZip), 'Unregistered ZIP is deleted')
  zipHook = null
  failRegistration = false
  const registered = snapshotContents.get(created.data.snapshotFileID)
  registered.records.exportedAt = Date.now() - 86400000 - 1
  for (const task of Object.values(documents.couples.space.mediaCleanup)) {
    if (task.fileIDs.includes(created.data.snapshotFileID)) task.readyAt = 0
  }
  for (const task of Object.values(documents.couples.space.mediaCleanup)) {
    if (task.fileIDs.includes(protectedImage)) task.readyAt = 0
  }
  await api.drainMediaCleanup('space')
  assert(!removedFiles.includes(protectedImage), 'Grace protects an export started before expiry')
  assert(!removedFiles.includes(created.data.snapshotFileID), 'Grace protects older snapshot registrations')
  registered.records.exportedAt -= 15 * 60 * 1000
  for (const task of Object.values(documents.couples.space.mediaCleanup)) {
    if (task.fileIDs.includes(protectedImage)) task.readyAt = 0
  }
  await api.drainMediaCleanup('space')
  assert(removedFiles.includes(protectedImage), 'Expired protection eventually releases media')
  documents.couples.space.spaceGate = { tickets: { stale: Date.now() - 1 }, backup: { token: 'stale', expiresAt: Date.now() - 1 } }
  const recovered = await invoke('startBackup')
  assert.equal(recovered.ok, true, recovered.error)
  assert.equal(documents.couples.space.spaceGate.backup, null)
  assert.equal(Object.keys(documents.couples.space.spaceGate.tickets).length, 0)
  console.log('PASS: entry point leases, authorization, snapshot registration, grace and recovery')

  const hash = value => createHash('sha256').update(value).digest('hex')
  documents.couples.latest = { _id: 'latest', memberA: { openid: 'latest-owner' }, memberB: null }
  documents.space_invites = { legacy: { _id: 'legacy', coupleId: 'latest', tokenHash: hash('old'), status: 'active' } }
  const firstInvite = await api.createPartnerInvite('latest-owner', { coupleId: 'latest' })
  failTransaction = true
  await assert.rejects(() => api.createPartnerInvite('latest-owner', { coupleId: 'latest' }), /transaction unavailable/)
  failTransaction = false
  assert.equal(documents.couples.latest.inviteTokenHash, hash(firstInvite.token))
  const secondInvite = await api.createPartnerInvite('latest-owner', { coupleId: 'latest' })
  await assert.rejects(() => api.joinPartnerInvite('guest', { inviteToken: 'old' }), /失效/)
  await assert.rejects(() => api.joinPartnerInvite('guest', { inviteToken: firstInvite.token }), /失效/)
  await api.joinPartnerInvite('guest', { inviteToken: secondInvite.token })
  assert.equal(documents.couples.latest.memberB.openid, 'guest')
  documents.couples.invited = { _id: 'invited', memberA: { openid: 'owner' }, memberB: null }
  documents.space_invites = {
    invite: { _id: 'invite', coupleId: 'invited', tokenHash: hash('token'), status: 'active' },
  }
  await assert.rejects(() => api.joinPartnerInvite('owner', { inviteToken: 'token' }), /不能加入自己/)
  await assert.rejects(() => api.joinPartnerInvite('a', { inviteToken: 'token' }), /已加入/)
  assert.equal(documents.space_invites.invite.status, 'active')
  await api.joinPartnerInvite('partner', { inviteToken: 'token' })
  await api.joinPartnerInvite('partner', { inviteToken: 'token' })
  assert.equal(documents.couples.invited.memberB.openid, 'partner')
  assert.equal(documents.space_memberships[hash('partner').slice(0, 32)].coupleId, 'invited')

  documents.access_codes = { code: { _id: 'code', codeHash: hash('ABCD1234'), status: 'unused' } }
  const activated = await api.redeemAccessCode('new-owner', { code: 'ABCD1234', startDate: '2026-01-01' })
  assert.equal(documents.access_codes.code.coupleId, activated.id)
  assert.equal(documents.space_memberships[hash('new-owner').slice(0, 32)].coupleId, activated.id)
  await assert.rejects(() => api.seedDemoData('a', { coupleId: 'space', envVersion: 'trial' }), /未启用/)

  for (let i = 0; i < 102; i++) {
    const _id = String(i).padStart(3, '0')
    documents.moments[_id] = {
      _id, coupleId: 'space', kind: 'post', momentDate: '2026-10-13', createdAt: 1,
      images: i <= 1 ? [image] : [],
    }
  }
  const pageOptions = { coupleId: 'space', mediaFilter: 'image', limit: 1 }
  const pageOne = await api.queryMomentsPage('a', pageOptions, false)
  const pageTwo = await api.queryMomentsPage('a', { ...pageOptions, skip: 1 }, false)
  assert.equal((await api.rebuildUsage('space')).storageBytes, 200, 'Shared files are charged per record during legacy usage rebuild')
  assert.equal(pageOne.items[0].id, '001')
  assert.equal(pageOne.total, 2)
  assert.equal(pageOne.hasMore, true)
  assert.equal(pageTwo.items[0].id, '000')
  assert.equal(pageTwo.hasMore, false)
  const neighbors = await api.getMomentNeighbors('a', { coupleId: 'space', momentId: '100' })
  assert.deepEqual(clone(neighbors), { prevId: '101', nextId: '099', index: 2, total: 102 })
  for (let i = 0; i < 205; i++) {
    const _id = `comment-${String(i).padStart(3, '0')}`
    documents.moment_comments[_id] = { _id, coupleId: 'space', momentId: '001', authorRole: 'a', createdAt: 205 - i }
  }
  const comments = await api.listComments('a', { coupleId: 'space', momentId: '001' })
  assert.equal(comments.length, 205)
  assert.equal(comments[0].id, 'comment-204')
  const enriched = await api.queryMomentsPage('a', pageOptions, false)
  assert.equal(enriched.items[0].commentCount, 205)
  await assert.rejects(() => api.addComment('a', { coupleId: 'space', momentId: '001', content: ' ' }), /填写/)
  await api.deleteComment('a', { coupleId: 'space', commentId: 'already-deleted' })
  await api.deleteAnniversary('a', { coupleId: 'space', anniversaryId: 'already-deleted' })
  documents.moments['001'].location = { name: '__proto__', address: 'Shanghai', latitude: '31.1234', longitude: '121.1234' }
  documents.moments['002'].location = { name: 'bad', latitude: 31 }
  const places = await api.listMapPlaces('a', { coupleId: 'space' })
  assert.equal(places.places.length, 1)
  assert.equal(places.places[0].latitude, 31.1234)
  const collections = await api.listMomentCollections('a', { coupleId: 'space' })
  assert.equal(collections.places.find(place => place.name === '__proto__').count, 1)
  console.log('PASS: invite ownership, activation, server-only demo gate, filtered pages and tied neighbor order')
  console.log('PASS: calendar boundaries, media ownership, cleanup failures, empty input, comment pagination and idempotent deletion')

  nextResponse = { statusCode: 200, headers: { 'content-length': '300' } }
  context.restoreMediaMeasurements()
  for (const [caseName, usageVersion, targetBytes] of [
    ['current-usage', 2, undefined],
    ['legacy-usage', undefined, undefined],
    ['legacy-usage-with-target-bytes', undefined, 600],
  ]) {
    const coupleId = `delete-${caseName}`
    const targetId = `${coupleId}-target`
    const remainingId = `${coupleId}-remaining`
    const missing = `cloud://test.bucket/moments/${coupleId}/images/missing.jpg`
    const shared = `cloud://test.bucket/moments/${coupleId}/images/shared.jpg`
    const initialUsage = { momentCount: 2, mediaItems: 5, storageBytes: 999 }
    documents.couples[coupleId] = { _id: coupleId, memberA: { openid: 'a' }, usageVersion, usage: clone(initialUsage) }
    documents.moments[targetId] = {
      _id: targetId, coupleId, images: [missing, shared],
      ...(targetBytes === undefined ? {} : { mediaBytes: targetBytes }),
    }
    documents.moments[remainingId] = { _id: remainingId, coupleId, images: [shared] }
    documents.rants[coupleId] = { _id: coupleId, coupleId, images: [shared] }
    unreadableFiles.add(missing)
    const removeTarget = () => invoke('deleteMoment', { coupleId, momentId: targetId })

    unreadableFiles.add(shared)
    const blocked = await removeTarget()
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /媒体文件无法读取/)
    assert(documents.moments[targetId])
    assert.deepEqual(documents.couples[coupleId].usage, initialUsage)
    assert.equal(documents.couples[coupleId].mediaCleanup, undefined)
    unreadableFiles.delete(shared)

    failRegistration = true
    const rolledBack = await removeTarget()
    failRegistration = false
    assert.equal(rolledBack.ok, false)
    assert.match(rolledBack.error, /registration unavailable/, caseName)
    assert(documents.moments[targetId])
    assert.deepEqual(documents.couples[coupleId].usage, initialUsage)
    assert.equal(documents.couples[coupleId].mediaCleanup, undefined)
    assert(!removedFiles.includes(missing))

    failFiles = true
    const deleted = await removeTarget()
    failFiles = false
    assert.equal(deleted.ok, true, deleted.error)
    assert(!documents.moments[targetId])
    assert(documents.moments[remainingId])
    const expected = { momentCount: 1, mediaItems: 2, storageBytes: 600 }
    assert.deepEqual(documents.couples[coupleId].usage, expected)
    assert.equal(documents.couples[coupleId].usageVersion, 2)
    const [queued] = Object.values(documents.couples[coupleId].mediaCleanup)
    assert.equal(queued.momentId, targetId)
    assert.deepEqual(queued.fileIDs, [missing])
    queued.readyAt = 0
    assert.equal((await removeTarget()).ok, true)
    assert.deepEqual(documents.couples[coupleId].usage, expected)
    assert.equal(Object.keys(documents.couples[coupleId].mediaCleanup).length, 0)
    assert(!removedFiles.includes(shared))
  }
  console.log('PASS: legacy media deletion rebuilds remaining usage, rolls back with cleanup registration, and safely retries')
}

async function verifyDraft(directory) {
  const storage = new Map()
  let copies = 0
  let failWrite = false
  let openid = 'user'
  const original = path.join(directory, 'photo.jpg')
  fs.writeFileSync(original, Buffer.from([1, 2, 3, 4]))
  const context = loadTS('miniprogram/services/compose-draft.ts', {
    './session': { coupleId: () => 'space', requireSession: () => ({ coupleId: 'space', role: 'B', openid }) },
  }, { wx: {
    env: { USER_DATA_PATH: directory },
    setStorageSync: (key, value) => {
      if (failWrite) throw new Error('storage write failed')
      storage.set(key, clone(value))
    },
    getStorageSync: key => storage.get(key),
    removeStorageSync: key => storage.delete(key),
    getFileSystemManager: () => ({
      mkdirSync: (name, recursive) => fs.mkdirSync(name, { recursive }),
      readdirSync: name => fs.readdirSync(name),
      unlinkSync: name => fs.unlinkSync(name),
      copyFile: ({ srcPath, destPath, success, fail }) => {
        copies++
        fs.copyFile(srcPath, destPath, error => error ? fail(error) : success())
      },
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
  assert.equal(copies, 1, 'The same file referenced by multiple media fields is copied only once')
  assert(fs.readFileSync(restored.images[0]).equals(fs.readFileSync(original)))
  const draftDirectory = path.dirname(restored.video)
  const otherDraft = { ...restored, requestId: 'other_request', images: [original], video: '', videoCover: '', livePhotos: [], voice: null }
  await api.saveComposeDraft(otherDraft, 'moment')
  const otherCopy = api.readComposeDraft('moment').images[0]

  const empty = { ...restored, images: [], video: '', videoCover: '', livePhotos: [], voice: null }
  const movie = path.join(directory, 'movie.mp4')
  const cover = path.join(directory, 'cover.jpg')
  fs.writeFileSync(movie, 'movie')
  fs.writeFileSync(cover, 'cover')
  fs.writeFileSync(path.join(draftDirectory, 'old-copy.mp4'), 'obsolete')
  for (let i = 0; i < 2; i++) {
    await api.saveComposeDraft({ ...empty, images: [restored.images[0]], video: movie, videoCover: cover })
    const stored = api.readComposeDraft()
    assert.deepEqual(fs.readdirSync(draftDirectory).sort(), [stored.images[0], stored.video, stored.videoCover].map(file => path.basename(file)).sort())
    assert.equal(fs.readFileSync(stored.video, 'utf8'), 'movie')
    assert.equal(fs.readFileSync(stored.videoCover, 'utf8'), 'cover')

    if (i === 0) {
      const previousFiles = fs.readdirSync(draftDirectory).sort()
      failWrite = true
      await assert.rejects(api.saveComposeDraft({ ...empty, video: otherCopy }), /storage write failed/)
      failWrite = false
      assert.deepEqual(clone(api.readComposeDraft()), clone(stored))
      assert.deepEqual(fs.readdirSync(draftDirectory).sort(), previousFiles)

      const copyCount = copies
      const inFlight = api.saveComposeDraft({ ...empty, video: otherCopy })
      const queued = api.saveComposeDraft({ ...empty, videoCover: otherCopy })
      openid = 'other-user'
      await Promise.all([assert.rejects(inFlight, /切换/), assert.rejects(queued, /切换/)])
      openid = 'user'
      assert.equal(copies, copyCount + 1, 'Queued saves must recheck identity before copying')
      assert.deepEqual(clone(api.readComposeDraft()), clone(stored))
      assert.deepEqual(fs.readdirSync(draftDirectory).sort(), previousFiles)

      let filesAfterRemoval
      const removal = api.saveComposeDraft({ ...empty, images: [restored.images[0]] })
        .then(() => { filesAfterRemoval = fs.readdirSync(draftDirectory) })
      const reuse = api.saveComposeDraft({ ...empty, video: stored.video, videoCover: cover })
      await Promise.all([removal, reuse])
      assert(filesAfterRemoval.includes(path.basename(stored.video)), 'Queued snapshots must protect direct draft paths')
      assert(filesAfterRemoval.includes(path.basename(stored.videoCover)), 'Queued snapshots must protect cached copies')
      assert.equal(api.readComposeDraft().video, stored.video)
      assert.equal(api.readComposeDraft().videoCover, stored.videoCover)
    }

    await api.saveComposeDraft({ ...empty, images: [original] })
    const retained = api.readComposeDraft().images[0]
    assert.deepEqual(fs.readdirSync(draftDirectory), [path.basename(retained)])
    assert(fs.readFileSync(retained).equals(fs.readFileSync(original)))
    restored.images[0] = retained
  }

  const writing = api.saveComposeDraft({ ...empty, content: 'queued text', images: [movie] })
  const reopening = api.waitForComposeDraftSave().then(() => api.readComposeDraft())
  assert.notEqual(api.readComposeDraft().content, 'queued text', 'Fixture has a save in flight')
  const settledDraft = await reopening
  await writing
  assert.equal(settledDraft.content, 'queued text')
  assert.equal(fs.readFileSync(settledDraft.images[0], 'utf8'), 'movie')

  api.clearComposeDraft('draft_request', 'moment')
  assert.equal(api.readComposeDraft('moment').images[0], otherCopy, 'A stale clear must leave the edit draft intact')
  api.clearComposeDraft('draft_request')
  assert(!fs.existsSync(draftDirectory))
  assert([original, movie, cover, otherCopy].every(file => fs.existsSync(file)))
  assert.equal(api.readComposeDraft('moment').images[0], otherCopy)
  console.log('PASS: draft media persistence, queued references, repeated cleanup, storage failure rollback and draft scope')
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
  const dstCheck = `
    const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
    const source = fs.readFileSync('miniprogram/services/date.ts', 'utf8');
    const ctx = {exports: {}, Date, Math}; vm.createContext(ctx);
    vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,ctx);
    if (ctx.exports.daysBetween('2024-03-09', new Date(2024,2,11)) !== 3) process.exit(1);
  `
  execFileSync(process.execPath, ['-e', dstCheck], { cwd: root, env: { ...process.env, TZ: 'America/New_York' } })
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
  page.data.hasMore = true
  page.data.filterTag = 'daily'
  const staleMore = page.loadMore()
  page.data.filterTag = 'travel'
  const freshFeed = page.refresh()
  await new Promise(resolve => setImmediate(resolve))
  pending.get('travel')({ items: [{ id: 'latest' }], total: 1, hasMore: false })
  await freshFeed
  pending.get('daily')({ items: [{ id: 'obsolete' }], total: 1, hasMore: false })
  await staleMore
  assert.equal(page.data.rows[0].key, 'latest')
  assert.equal(page.data.loadingMore, false, 'Changing the filter must release the previous loading-more state')

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

async function verifyUploadCancellation() {
  const pool = loadTS('miniprogram/utils/async-pool.ts').exports
  let task, abortCount = 0, progress = 0, completeImmediately = false
  const cloud = {
    uploadFile(options) {
      task = {
        abort() { abortCount++; options.fail(new Error('upload cancelled')) },
        onProgressUpdate(callback) { this.progress = callback },
      }
      if (completeImmediately) setImmediate(() => options.success({ fileID: 'cloud://test.bucket/moments/space/images/new.jpg' }))
      return task
    },
  }
  const api = loadTS('miniprogram/services/store.ts', {
    './cloud-api': { callOurs: async action => action === 'getPublishedMoment' ? null : {} },
    '../utils/async-pool': pool,
    './session': { coupleId: () => 'space', requireSession: () => ({ coupleId: 'space', openid: 'user' }), getSession: () => ({ status: 'ready', coupleId: 'space', openid: 'user' }) },
    './upload-cleanup': { holdUpload() {}, releaseUploads() {}, forgetUploadHolds() {}, retryUploadCleanup: async () => {}, fallbackUploadCleanup: async () => true },
  }, { wx: { cloud, getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: 10 }) }) } }).exports
  const publish = api.addMoment({ content: 'memory', images: ['local.jpg'], location: null, requestId: 'request_upload' },
    value => { progress = Math.max(progress, value) })
  await new Promise(resolve => setImmediate(resolve))
  assert(task && typeof task.progress === 'function')
  task.progress({ progress: 50 })
  assert(progress > 0)
  api.cancelMomentUpload()
  await assert.rejects(() => publish, /取消上传/)
  assert.equal(abortCount, 1)
  completeImmediately = true
  const result = await api.uploadMomentImages(['later.jpg'])
  assert.equal(result.length, 1, 'A cancelled publication must not poison later uploads')
  console.log('PASS: actual upload task receives progress, aborts on cancellation, and later uploads work')
}

async function verifyComposeSubmitDraftRace() {
  const identity = { status: 'ready', coupleId: 'space', role: 'A', openid: 'user' }
  async function scenario({ backgroundFailure = false, switchIdentity = false, preflightFailure = false, publishFailure = false, uncertain = false }) {
    let definition, page, saves = 0, publishes = 0, clears = 0, stale = 0
    let session = identity
    const toasts = []
    const timers = []
    const wx = { showToast: value => toasts.push(value), switchTab() {}, navigateBack() {} }
    loadTS('miniprogram/pages/compose/compose.ts', {
      '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
      '../../services/date': { todayKey: () => '2026-01-01' },
      '../../utils/tags': { MOMENT_TAG_POST: [] },
      '../../services/session': { getSession: () => session },
      '../../services/compose-draft': {
        saveComposeDraft: async () => {
          saves++
          if ((preflightFailure && saves === 1) || (backgroundFailure && saves === 2)) throw new Error('draft failed')
        },
        clearComposeDraft: () => { clears++ },
      },
      '../../services/store': {
        addMoment: async (payload, progress, onCreateState) => {
          publishes++
          if (backgroundFailure) {
            page.onHide()
            await page.draftSaveQueue.catch(() => {})
          }
          if (switchIdentity) session = { ...identity, openid: 'other' }
          if (uncertain || (backgroundFailure && !publishFailure)) {
            progress(98, '')
            onCreateState('sending')
          }
          if (uncertain) onCreateState('uncertain')
          if (publishFailure) throw new Error('publish failed')
        },
        listMomentsPage: async () => [],
      },
      '../../services/moments-list-state': { markMomentsListStale: () => { stale++ } },
      '../../services/moments-feed-cache': { feedCacheKey: () => 'feed', prefetchMomentsFeed() {} },
    }, { Page: value => { definition = value }, wx, setTimeout: fn => { timers.push(fn); return 1 } })
    page = {
      ...definition,
      data: { ...definition.data, canPost: true, content: 'memory' },
      requestId: 'draft123', draftIdentity: identity, draftSaveQueue: Promise.resolve(),
      setData(patch) { Object.assign(this.data, patch) },
      stopVoicePreview() {},
    }
    await page.onSubmit()
    return { page, saves, publishes, clears, stale, toasts, timers }
  }

  for (const switchIdentity of [false, true]) {
    const result = await scenario({ backgroundFailure: true, switchIdentity })
    assert.equal(result.saves, 2, 'The preflight and onHide saves must both run')
    assert.equal(result.publishes, 1)
    assert.equal(result.clears, switchIdentity ? 0 : 1, 'Only clear a draft for the original identity')
    assert.equal(result.stale, 1)
    assert.equal(result.page.data.pendingResult, false)
    assert(result.toasts.some(toast => toast.title === '已保存' && toast.icon === 'success'))
    assert(!result.toasts.some(toast => toast.title === 'draft failed'))
    assert.equal(result.timers.length, 1, 'Confirmed publication navigates away')
  }
  const preflight = await scenario({ preflightFailure: true })
  assert.equal(preflight.publishes, 0, 'A failed preflight draft must block publication')
  assert.equal(preflight.clears, 0)
  assert.equal(preflight.page.data.pendingResult, false)
  assert(preflight.toasts.some(toast => toast.title === 'draft failed'))

  for (const uncertain of [false, true]) {
    const result = await scenario({ backgroundFailure: true, publishFailure: true, uncertain })
    assert.equal(result.clears, 0)
    assert.equal(result.stale, 0)
    assert.equal(result.page.data.pendingResult, uncertain)
    assert(result.toasts.some(toast => toast.title === 'publish failed'))
    assert(!result.toasts.some(toast => toast.title === '已保存'))
    if (uncertain) assert.equal(result.saves, 3, 'Persist an unconfirmed result for retry')
  }
  console.log('PASS: compose publication and background draft failure race, identity and unconfirmed results')
}

async function verifyRecording() {
  let definition, onStart, onStop, onError, startCount = 0, registrations = 0
  const recorder = {
    onStart(fn) { onStart = fn },
    onStop(fn) { registrations++; onStop = fn },
    onError(fn) { onError = fn },
    start() { startCount++ },
    stop() {},
  }
  let allowed = false
  const wx = {
    getRecorderManager: () => recorder,
    getSystemInfoSync: () => ({ platform: 'ios' }),
    authorize(options) { allowed ? options.success() : options.fail({ errMsg: 'auth denied' }) },
    showModal(options) { options.success({ confirm: true }) },
    openSetting(options) { allowed = true; options.success({ authSetting: { 'scope.record': true } }) },
    showToast() {},
  }
  loadTS('miniprogram/pages/compose/compose.ts', {
    '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
    '../../services/store': { getIdentity: () => ({ role: 'A' }), getCouple: () => ({ startDate: '2020-01-01' }) },
    '../../services/page-boot': { ensureCloudReady: async () => true },
    '../../services/session': { getSession: () => ({ status: 'ready', coupleId: 'space', openid: 'user', role: 'A' }) },
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/date': { todayKey: () => '2026-01-01' },
    '../../utils/moment-time': { formatMomentDateLabel: () => '今天' },
    '../../services/compose-draft': { newPublishId: () => 'draft123', readComposeDraft: () => null, waitForComposeDraftSave: async () => {} },
    '../../utils/tags': { MOMENT_TAG_POST: [] },
  }, { Page: value => { definition = value }, wx, setInterval, clearInterval })
  const makePage = () => ({
    ...definition,
    data: { ...definition.data },
    setData(patch) { Object.assign(this.data, patch) },
    scheduleDraftSave() {},
  })
  const page = makePage()
  await page.onLoad({})
  page.data.voice = { path: 'old.mp3', duration: 2 }
  page.startRecord()
  assert.equal(startCount, 1, 'Granting permission in settings resumes recording')
  assert.equal(page.data.recording, false)
  onStart()
  assert.equal(page.data.recording, true)
  onError({ errMsg: 'microphone unavailable' })
  assert.equal(page.data.voice.path, 'old.mp3', 'A failed re-record must not delete the old voice')
  page.startRecord()
  onStart()
  page.recordStartedAt = Date.now() - 2000
  onStop({ tempFilePath: 'new.mp3' })
  assert.equal(page.data.voice.path, 'new.mp3')
  assert.equal(page.data.voice.duration, 2)
  const nextPage = makePage()
  await nextPage.onLoad({})
  assert.equal(registrations, 1, 'Recorder listeners must not accumulate across compose pages')
  console.log('PASS: microphone permissions, confirmed recording start, failure recovery and recorder listener lifecycle')
}

async function verifyVoicePlayback() {
  let definition, invalidateCount = 0, toastCount = 0
  let lookup = async () => 'https://example.invalid/voice.mp3'
  const players = []
  const wx = {
    cloud: { downloadFile: async () => ({ tempFilePath: 'wxfile://voice.mp3' }) },
    showToast() { toastCount++ },
    createInnerAudioContext() {
      const player = {
        play() {}, destroy() {},
        onPlay(fn) { this.started = fn },
        onEnded(fn) { this.ended = fn },
        onError(fn) { this.failed = fn },
      }
      players.push(player)
      return player
    },
  }
  loadTS('miniprogram/pages/moment-detail/moment-detail.ts', {
    '../../services/theme': { getThemeStyle: () => '' },
    '../../services/store': { resolveCloudUrl: () => lookup() },
    '../../utils/cloud-url-cache': { invalidateCachedUrl: () => { invalidateCount++ } },
  }, { Page: value => { definition = value }, wx })
  const page = {
    ...definition, data: { ...definition.data, loading: false, item: { voiceFileID: 'cloud://bucket/voice.mp3' } },
    setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('item.')) this.data.item[key.slice(5)] = value
        else this.data[key] = value
      }
    },
  }
  await page.onTapVoice()
  assert.equal(page.data.item.voiceLoading, true)
  players[0].failed()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invalidateCount, 1)
  assert.equal(players[1].src, 'wxfile://voice.mp3')
  players[1].started()
  assert.equal(page.data.item.voicePlaying, true)
  players[1].failed()
  assert.equal(page.data.item.voicePlaying, false)
  assert.equal(toastCount, 1)
  let resolveLookup
  lookup = () => new Promise(resolve => { resolveLookup = resolve })
  const pending = page.onTapVoice()
  page.onHide()
  resolveLookup('https://example.invalid/late.mp3')
  await pending
  assert.equal(players.length, 2, 'A hidden page must not start delayed audio playback')
  console.log('PASS: voice playback falls back, clears stale URLs, reports errors and cancels on hide')
}

async function verifyAdminSafety() {
  const sdk = require(path.join(root, 'cloudfunctions/admin-api/node_modules/@cloudbase/node-sdk'))
  const realApp = sdk.init({ env: sdk.SYMBOL_CURRENT_ENV })
  assert.equal(typeof realApp.auth().getUserInfo, 'function')
  assert.equal(typeof realApp.getTempFileURL, 'function')
  assert.equal(typeof realApp.deleteFile, 'function')
  assert.equal(typeof realApp.database().collection, 'function')
  let deleted = [], space = { status: 'revoked', deletedAt: 1 }, failWrite = false
  const db = { collection: () => ({ doc: id => ({
    async get() { return { data: id === 'missing' ? [] : [space] } },
    async update(value) {
      if (failWrite) return { code: 'PERMISSION_DENIED', message: 'write denied' }
      Object.assign(space, value)
      return { updated: 1 }
    },
  }) }) }
  const app = {
    database: () => db,
    async deleteFile({ fileList }) {
      deleted.push(...fileList)
      return { fileList: [{ fileID: fileList[0], code: 'SUCCESS' }] }
    },
  }
  const context = vm.createContext({
    exports: {}, console, Date,
    require: id => id === '@cloudbase/node-sdk' ? { init: () => app } : require(id),
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/admin-api/index.js'), 'utf8') + `
    globalThis.api = { readDocument, getSpaceDetail, resumeSpace, deleteSpace, collectSpaceFileIDs, deleteCloudFiles };
  `, context)
  const api = context.api
  assert.equal((await api.readDocument('couples', 'space')).status, 'revoked')
  assert.equal((await api.readDocument('couples', 'space'))._id, 'space')
  assert.equal(await api.readDocument('couples', 'missing'), null)
  await assert.rejects(() => api.resumeSpace({ coupleId: 'space' }), /无法恢复/)
  space = { status: 'active', usageVersion: 2, usage: { momentCount: 3 }, startDate: '2020-01-01' }
  const detail = await api.getSpaceDetail({ coupleId: 'space' })
  assert.equal(detail.space.usage.momentCount, 3)
  assert.equal(detail.space.startDate, '2020-01-01')
  failWrite = true
  await assert.rejects(() => api.deleteSpace({ coupleId: 'space' }), /write denied/)
  assert.equal(space.status, 'active', 'Do not delete records after the pause write fails')
  assert.equal(deleted.length, 0)
  failWrite = false
  const owned = 'cloud://bucket/moments/space/images/1.jpg'
  const other = 'cloud://bucket/moments/other/moments/space/file.jpg'
  const files = api.collectSpaceFileIDs('space', { pendingDeleteFiles: [owned, other] }, [], [])
  assert.deepEqual(clone(files), [owned])
  const result = await api.deleteCloudFiles([owned, 'cloud://bucket/moments/space/images/2.jpg'])
  assert.equal(result.failed, 1, 'Missing per-file delete results must be retried')
  assert.equal(deleted.length, 2)
  const codes = Array.from({ length: 5 }, (_, i) => ({ _id: String(i), createdAt: i, status: 'unused' }))
  const fallbackDb = { collection: () => ({
    orderBy() { throw new Error('index unavailable') },
    async count() { return { total: codes.length } },
  }) }
  const fallbackContext = vm.createContext({
    exports: {}, console, Date, fixtures: codes,
    require: id => id === '@cloudbase/node-sdk' ? { init: () => ({ database: () => fallbackDb }) } : require(id),
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/admin-api/index.js'), 'utf8') + `
    getAllCollectionDocs = async () => fixtures.slice();
    globalThis.listAccessCodes = listAccessCodes;
  `, fallbackContext)
  const fallbackPage = await fallbackContext.listAccessCodes({ skip: 1, limit: 2 })
  assert.deepEqual(clone(fallbackPage.items.map(item => item.id)), ['3', '2'])
  console.log('PASS: partial space deletion cannot be resumed; file ownership and incomplete delete results are guarded')
}

async function verifyBackup(directory) {
  const { zipBackupPart, planFiles, PART_BYTES } = require(path.join(root, 'cloudfunctions/ours/backup'))
  const target = path.join(directory, 'backup.zip')
  const originalFetch = global.fetch
  const sizes = { a: 4, b: PART_BYTES, huge: PART_BYTES + 1, missing: 4 }
  const cloud = {
    async getTempFileURL({ fileList }) { return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://example.invalid/${fileID}` })) } },
    async uploadFile({ fileContent }) { await require('stream/promises').pipeline(fileContent, fs.createWriteStream(target)); return { fileID: 'backup-file' } },
  }
  global.fetch = async (url, opts) => {
    const id = new URL(url).pathname.slice(1)
    if (id === 'missing' && opts.method !== 'HEAD') throw new Error('network failure secret')
    return opts.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': String(sizes[id]) } })
      : new Response(Buffer.from([1, 2, 3, 4]))
  }
  try {
    const files = [{ fileID: 'a', path: 'media/photo.jpg' }, { fileID: 'b', path: 'media/b.jpg' }]
    const groups = await planFiles(cloud, files)
    assert.deepEqual(groups.map(group => group.length), [1, 1])
    assert.equal((await planFiles(cloud, [{ fileID: 'huge' }]))[0][0].size, PART_BYTES + 1)
    const snapshot = { version: 1, coupleId: 'space', id: 'backup', parts: 1, records: { moments: [{ content: 'memory' }] }, files: [files[0]] }
    const result = await zipBackupPart(cloud, snapshot, 0, snapshot.files)
    assert.equal(result.missing, 0)
    assert.equal(JSON.parse(execFileSync('unzip', ['-p', target, 'records.json'])).moments[0].content, 'memory')
    assert(execFileSync('unzip', ['-p', target, 'media/photo.jpg']).equals(Buffer.from([1, 2, 3, 4])))
    await assert.rejects(() => zipBackupPart(cloud, snapshot, 0, [{ fileID: 'missing', path: 'media/missing' }]), /媒体读取失败/)
    await assert.rejects(() => zipBackupPart(cloud, snapshot, 0, [{ fileID: 'huge', path: 'media/huge' }]), /大小发生变化/)
    console.log('PASS: byte-based parts, oversized media, legacy ZIP and safe download failure')
  } finally { global.fetch = originalFetch }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ours-verify-'))
  try {
    await verifyServer()
    await verifyDraft(directory)
    await verifyBackup(directory)
    await verifyClient()
    await verifyFeedRace()
    await verifyUploadCancellation()
    await verifyComposeSubmitDraftRace()
    await verifyRecording()
    await verifyVoicePlayback()
    await verifyAdminSafety()
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
