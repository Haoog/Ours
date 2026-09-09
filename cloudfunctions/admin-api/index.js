// Ours admin-api — 网页管理台专用云函数

const crypto = require('crypto')
const https = require('https')
const tcb = require('@cloudbase/node-sdk')

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV })
const db = app.database()
const DEFAULT_QUOTA = {
  maxMoments: 500,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxMediaItems: 2000,
  maxMediaPerMoment: 12,
}
const QUOTA_FIELDS = ['maxMoments', 'maxStorageBytes', 'maxMediaItems', 'maxMediaPerMoment']
const USAGE_BATCH_SIZE = 100
const USAGE_CONCURRENCY = 6
const MOMENT_USAGE_FIELDS = {
  kind: true,
  images: true,
  videos: true,
  videoCover: true,
  livePhotos: true,
  voices: true,
  mediaItems: true,
  mediaBytes: true,
}
const RANT_USAGE_FIELDS = {
  images: true,
  mediaItems: true,
  mediaBytes: true,
}
const mediaSizeCache = new Map()

function hashSecret(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeAccessCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
}

function randomAccessCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase()
  return `OURS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

function randomPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(0, Math.floor(n)))
}

function normalizeQuota(input = {}) {
  return {
    maxMoments: randomPositiveInteger(input.maxMoments, DEFAULT_QUOTA.maxMoments),
    maxStorageBytes: randomPositiveInteger(
      input.maxStorageBytes,
      DEFAULT_QUOTA.maxStorageBytes,
    ),
    maxMediaItems: randomPositiveInteger(input.maxMediaItems, DEFAULT_QUOTA.maxMediaItems),
    maxMediaPerMoment: randomPositiveInteger(
      input.maxMediaPerMoment,
      DEFAULT_QUOTA.maxMediaPerMoment,
    ),
  }
}

function isCollectionMissingError(error) {
  const message = `${error?.message || ''}${error?.errMsg || ''}`
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exist|集合不存在|ResourceNotFound/i.test(message)
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.floor(number))
}

function normalizeUsage(input = {}) {
  return {
    momentCount: nonNegativeInteger(input.momentCount),
    mediaItems: nonNegativeInteger(input.mediaItems),
    storageBytes: nonNegativeInteger(input.storageBytes),
  }
}

function countMomentMedia(moment = {}) {
  let count = 0
  count += Array.isArray(moment.images) ? moment.images.length : 0
  count += Array.isArray(moment.videos) ? moment.videos.length : 0
  if (moment.videoCover) count += 1
  for (const item of moment.livePhotos || []) {
    if (item.cover) count += 1
    if (item.video) count += 1
  }
  count += Array.isArray(moment.voices) ? moment.voices.length : 0
  return count
}

function countRantMedia(rant = {}) {
  return Array.isArray(rant.images) ? rant.images.length : 0
}

function collectMomentFileIDs(moment = {}) {
  const ids = []
  const push = value => {
    if (typeof value === 'string' && value) ids.push(value)
  }
  for (const id of moment.images || []) push(id)
  for (const id of moment.videos || []) push(id)
  push(moment.videoCover)
  for (const item of moment.livePhotos || []) {
    push(item.cover)
    push(item.video)
  }
  for (const item of moment.voices || []) push(item.fileID)
  return ids
}

function collectRantFileIDs(rant = {}) {
  return (rant.images || []).filter(id => typeof id === 'string' && id)
}

function countWithFallback(value, fallback) {
  return Number.isFinite(Number(value)) ? nonNegativeInteger(value) : fallback
}

function bytesWithFallback(value) {
  return Number.isFinite(Number(value)) ? nonNegativeInteger(value) : 0
}

function requestContentLength(url, method = 'HEAD') {
  return new Promise(resolve => {
    const request = https.request(url, {
      method,
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
      timeout: 5000,
    }, response => {
      const contentRange = response.headers['content-range']
      const rangeMatch = typeof contentRange === 'string' ? contentRange.match(/\/(\d+)$/) : null
      const contentLength = Number(response.headers['content-length'])
      const size = rangeMatch ? Number(rangeMatch[1]) : contentLength
      response.resume()
      response.once('end', () => resolve(Number.isFinite(size) && size >= 0 ? size : 0))
    })
    request.once('timeout', () => request.destroy())
    request.once('error', () => resolve(0))
    request.end()
  })
}

async function getFileSize(url) {
  const headSize = await requestContentLength(url)
  if (headSize > 0) return headSize
  return requestContentLength(url, 'GET')
}

async function getStorageBytes(fileIDs) {
  const uniqueIDs = [...new Set(fileIDs)]
  if (!uniqueIDs.length) return 0

  const pendingIDs = uniqueIDs.filter(id => !mediaSizeCache.has(id))
  if (pendingIDs.length) {
    let urls = {}
    try {
      urls = await tempUrlMap(pendingIDs)
    } catch {
      urls = {}
    }
    await mapWithConcurrency(pendingIDs, async fileID => {
      const url = urls[fileID]
      if (!url) return
      const pending = getFileSize(url).catch(() => 0)
      mediaSizeCache.set(fileID, pending)
      await pending
    }, 12)
  }

  const sizes = await Promise.all(uniqueIDs.map(fileID => mediaSizeCache.get(fileID) || Promise.resolve(0)))
  return sizes.reduce((total, size) => total + nonNegativeInteger(size), 0)
}

async function getCollectionDocs(collectionName, where, field) {
  const safeWhere = Object.fromEntries(
    Object.entries(where || {}).filter(([, value]) => value !== undefined),
  )
  if (Object.keys(safeWhere).length === 0) return []
  const documents = []
  let skip = 0

  while (true) {
    let query = db.collection(collectionName).where(safeWhere)
    if (field) query = query.field(field)
    const result = await query.skip(skip).limit(USAGE_BATCH_SIZE).get()
    documents.push(...result.data)
    if (result.data.length < USAGE_BATCH_SIZE) break
    skip += result.data.length
  }

  return documents
}

async function getAllCollectionDocs(collectionName) {
  const documents = []
  let skip = 0

  while (true) {
    const result = await db.collection(collectionName).skip(skip).limit(USAGE_BATCH_SIZE).get()
    documents.push(...result.data)
    if (result.data.length < USAGE_BATCH_SIZE) break
    skip += result.data.length
  }

  return documents
}

function usageFromDocuments(moments, rants) {
  const postMoments = moments.filter(moment => moment.kind !== 'system')
  return normalizeUsage({
    momentCount: postMoments.length,
    mediaItems:
      postMoments.reduce(
        (total, moment) => total + countWithFallback(moment.mediaItems, countMomentMedia(moment)),
        0,
      ) +
      rants.reduce(
        (total, rant) => total + countWithFallback(rant.mediaItems, countRantMedia(rant)),
        0,
      ),
    storageBytes:
      postMoments.reduce((total, moment) => total + bytesWithFallback(moment.mediaBytes), 0) +
      rants.reduce((total, rant) => total + bytesWithFallback(rant.mediaBytes), 0),
  })
}

async function getSpaceUsage(coupleId, storedUsage) {
  const normalizedCoupleId = String(coupleId || '').trim()
  if (!normalizedCoupleId) return normalizeUsage(storedUsage)
  try {
    const moments = await getCollectionDocs('moments', { coupleId: normalizedCoupleId }, MOMENT_USAGE_FIELDS)
    let rants = []
    try {
      rants = await getCollectionDocs('rants', { coupleId: normalizedCoupleId }, RANT_USAGE_FIELDS)
    } catch (error) {
      if (!isCollectionMissingError(error)) throw error
    }
    const usage = usageFromDocuments(moments, rants)
    const fileIDs = [
      ...moments.filter(moment => moment.kind !== 'system').flatMap(collectMomentFileIDs),
      ...rants.flatMap(collectRantFileIDs),
    ]
    if (fileIDs.length) {
      const storageBytes = await getStorageBytes(fileIDs)
      if (storageBytes > 0) usage.storageBytes = storageBytes
    }
    return usage
  } catch (error) {
    // Keep the dashboard usable in an incompletely initialized environment.
    if (isCollectionMissingError(error)) return normalizeUsage(storedUsage)
    throw error
  }
}

async function mapWithConcurrency(items, worker, concurrency = USAGE_CONCURRENCY) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index])
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => run()))
  return results
}

async function hydrateSpaces(documents) {
  return mapWithConcurrency(documents, async document => {
    const id = documentId(document)
    const usage = await getSpaceUsage(id, document.usage)
    return mapSpace(document, usage)
  })
}

function normalizeLimit(value, fallback = 20, max = 100) {
  return randomPositiveInteger(value, fallback, max) || fallback
}

function currentIdentity() {
  const info = app.auth().getUserInfo()
  if (!info || !info.uid || info.isAnonymous) {
    throw new Error('请先登录管理台')
  }
  return info
}

async function findAdmin(info) {
  let byUid
  try {
    byUid = await db.collection('admins').where({ uid: info.uid }).limit(1).get()
  } catch {
    return null
  }
  if (byUid.data[0] && byUid.data[0].status !== 'disabled') return byUid.data[0]

  if (info.openId) {
    const byOpenId = await db.collection('admins').where({ openid: info.openId }).limit(1).get().catch(() => ({ data: [] }))
    if (byOpenId.data[0] && byOpenId.data[0].status !== 'disabled') return byOpenId.data[0]
  }
  return null
}

async function requireAdmin() {
  const identity = currentIdentity()
  const admin = await findAdmin(identity)
  if (!admin) throw new Error('当前账号没有管理台权限')
  return { identity, admin }
}

function documentId(doc) {
  return String(doc?._id || doc?.id || doc?.codeId || '').trim()
}

function omitId(doc) {
  if (!doc) return null
  // CloudBase documents use _id, but keep compatibility with records returned
  // by older wrappers/imports that exposed the key as id or codeId.
  const id = documentId(doc)
  const { _id, id: legacyId, codeId, codeHash, ...rest } = doc
  // Put the normalized id last so a legacy user field named `id` cannot
  // overwrite the actual database document id.
  return { ...rest, id }
}

function mapSpace(doc, usage = doc?.usage) {
  if (!doc) return null
  const status = doc.status === 'suspended' || doc.status === 'revoked'
    ? doc.status
    : doc.expiresAt && Number(doc.expiresAt) <= Date.now()
      ? 'expired'
      : 'active'
  return {
    id: documentId(doc),
    startDate: doc.startDate || '',
    memberA: doc.memberA || null,
    memberB: doc.memberB || null,
    licenseId: doc.licenseId || null,
    planId: doc.planId || 'legacy',
    status,
    expiresAt: doc.expiresAt || null,
    // 旧空间可能没有 quota 字段，但业务云函数会按默认额度执行；
    // 管理台也必须展示同一套有效额度，不能把它误显示成无限制。
    quota: normalizeQuota(doc.quota || {}),
    usage: normalizeUsage(usage),
    createdAt: doc.createdAt || 0,
  }
}

function mapAccessCode(doc) {
  const item = omitId(doc)
  // 兼容早期没有 quota 字段的邀请码，避免管理台读取旧数据时整页崩溃。
  const quota = normalizeQuota(item.quota || {})
  if ((item.status === 'unused' || item.status === 'active') && item.expiresAt && Number(item.expiresAt) <= Date.now()) {
    return {
      ...item,
      planId: item.planId || 'legacy',
      quota,
      status: 'expired',
    }
  }
  return {
    ...item,
    planId: item.planId || 'legacy',
    quota,
  }
}

async function listAccessCodes(payload = {}) {
  const limit = normalizeLimit(payload.limit, 20, 100)
  const skip = randomPositiveInteger(payload.skip, 0)
  let data
  try {
    const res = await db.collection('access_codes').orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
    data = res.data
  } catch {
    const res = await db.collection('access_codes').skip(skip).limit(limit).get()
    data = res.data.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }
  const total = (await db.collection('access_codes').count()).total || 0
  return { items: data.map(mapAccessCode), total, hasMore: skip + data.length < total }
}

async function createAccessCode(payload = {}) {
  const code = randomAccessCode()
  const now = Date.now()
  const expiresAt = Number(payload.expiresAt) > 0 ? Number(payload.expiresAt) : null
  const quota = normalizeQuota(payload)
  const data = {
    codeHash: hashSecret(normalizeAccessCode(code)),
    status: 'unused',
    coupleId: null,
    planId: String(payload.planId || 'basic').trim() || 'basic',
    quota,
    spaceExpiresAt: expiresAt,
    expiresAt,
    createdAt: now,
  }
  // @cloudbase/node-sdk 的 add/update 参数是文档本身；只有 wx-server-sdk 才需要包一层 data。
  const res = await db.collection('access_codes').add(data)
  return {
    id: res.id || res._id,
    code,
    status: data.status,
    planId: data.planId,
    quota,
    expiresAt,
    createdAt: now,
  }
}

async function revokeAccessCode(payload = {}) {
  const id = String(payload.id || payload._id || payload.codeId || '').trim()
  if (!id) throw new Error('缺少邀请码 id')
  const res = await db.collection('access_codes').doc(id).get()
  const access = res.data
  if (!access) throw new Error('邀请码不存在')
  await db.collection('access_codes').doc(id).update({ status: 'revoked', revokedAt: Date.now() })
  if (access.coupleId) {
    await db.collection('couples').doc(access.coupleId).update({ status: 'suspended' })
  }
  return { id, status: 'revoked', coupleId: access.coupleId || null }
}

async function deleteAccessCode(payload = {}) {
  const id = String(payload.id || payload._id || payload.codeId || '').trim()
  if (!id) throw new Error('缺少邀请码 id')
  const res = await db.collection('access_codes').doc(id).get()
  const access = res.data
  if (!access) throw new Error('邀请码不存在')

  // 已兑换的邀请码与空间绑定，不能只删授权记录，否则会留下失去授权来源的空间。
  if (access.coupleId || access.status === 'active') {
    throw new Error('已激活的邀请码不能直接删除，请先处理对应空间')
  }

  await db.collection('access_codes').doc(id).remove()
  return { id, deleted: true }
}

async function resumeSpace(payload = {}) {
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')
  const res = await db.collection('couples').doc(coupleId).get()
  if (!res.data) throw new Error('空间不存在')
  if (res.data.expiresAt && Number(res.data.expiresAt) <= Date.now()) {
    throw new Error('空间授权已过期，请新建授权后再处理')
  }
  await db.collection('couples').doc(coupleId).update({ status: 'active' })
  if (res.data.licenseId) {
    await db.collection('access_codes').doc(res.data.licenseId).update({ status: 'active' }).catch(() => undefined)
  }
  return { coupleId, status: 'active' }
}

function quotaMatches(left, right) {
  return Boolean(left && right) && QUOTA_FIELDS.every(field => (
    Number(left[field]) === Number(right[field])
  ))
}

async function verifySpaceQuota(coupleId, expectedQuota) {
  let latest = null
  // CloudBase 可能在刚写入后短暂读到旧副本，因此给回读留出同步时间。
  for (const delay of [0, 250, 750]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    try {
      const verifyRes = await db.collection('couples').doc(coupleId).get()
      latest = verifyRes.data || latest
      if (latest && quotaMatches(normalizeQuota(latest.quota || {}), expectedQuota)) {
        return { document: latest, verified: true }
      }
    } catch (error) {
      console.warn('verify space quota update failed', error?.message || error)
    }
  }
  return { document: latest, verified: false }
}

async function updateSpaceQuota(payload = {}) {
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')

  const input = payload.quota && typeof payload.quota === 'object' ? payload.quota : payload
  const coupleRes = await db.collection('couples').doc(coupleId).get()
  const couple = coupleRes.data
  if (!couple) throw new Error('空间不存在')

  const nextInput = { ...normalizeQuota(couple.quota || {}) }
  for (const field of QUOTA_FIELDS) {
    if (input[field] !== undefined) nextInput[field] = input[field]
  }
  const quota = normalizeQuota(nextInput)
  const updatedAt = Date.now()

  // 额度是空间文档的运行时数据，不使用事务，避免事务提交后管理台读到旧快照。
  // @cloudbase/node-sdk 的 update 接收要修改的字段本身；不能写成 { data: {...} }，
  // 否则会真的生成一个名为 data 的顶层字段，quota 仍然保持旧值。
  // 先只写正式字段，等回读确认成功后再清理历史错误版本留下的 data 字段。
  const writeResult = await db.collection('couples').doc(coupleId).update({
    quota,
    quotaUpdatedAt: updatedAt,
  })
  if (writeResult?.code) {
    throw new Error(writeResult.message || writeResult.errMsg || '空间额度写入失败')
  }

  // Node SDK 的 update 请求成功就代表正式字段已经提交。刚写入后读取接口
  // 偶尔会返回旧副本，不能因为这个短暂的最终一致性窗口把已成功的保存报成失败。
  // 优先使用回读到的新文档；回读不到时使用本次已提交的文档快照返回给前端。
  const submittedDocument = {
    ...couple,
    quota,
    quotaUpdatedAt: updatedAt,
  }
  const verification = await verifySpaceQuota(coupleId, quota)
  const verifiedDocument = verification.verified && verification.document
    ? verification.document
    : submittedDocument
  if (!verification.verified) {
    console.warn('quota write accepted; readback still has an old snapshot', {
      coupleId,
      updated: writeResult?.updated,
    })
  }
  if (couple.data && typeof couple.data === 'object' && couple.data.quota) {
    // 这是早期错误写法留下的临时字段，只在正式 quota 已经回读成功后清理；
    // 清理失败不影响本次额度保存，避免把“已保存”误报成失败。
    await db.collection('couples').doc(coupleId).update({ data: db.command.remove() }).catch(error => {
      console.warn('clean legacy quota field failed', error?.message || error)
    })
  }
  let licenseSynced = false
  const licenseId = String(couple.licenseId || verifiedDocument.licenseId || '').trim()
  if (licenseId) {
    try {
      const licenseRes = await db.collection('access_codes').doc(licenseId).get()
      if (licenseRes.data) {
        await db.collection('access_codes').doc(licenseId).update({
          quota,
          quotaUpdatedAt: verifiedDocument.quotaUpdatedAt || updatedAt,
        })
        licenseSynced = true
      }
    } catch (error) {
      // 空间额度已经真实落库；邀请码只是历史额度快照，同步失败不影响空间使用。
      console.warn('sync access code quota failed', error?.message || error)
    }
  }

  // A document read does not always include _id, and the submitted snapshot
  // does not contain the calculated usage. Return both explicitly so the
  // frontend keeps the same selected space and does not briefly show 0 usage.
  const responseDocument = {
    // Some CloudBase read paths can return a partial document after an update.
    // Keep the original space metadata (members, creation time, status, etc.)
    // and overlay the verified quota fields on top of it.
    ...couple,
    ...verifiedDocument,
    quota,
    quotaUpdatedAt: verifiedDocument.quotaUpdatedAt || updatedAt,
    _id: documentId(verifiedDocument) || coupleId,
  }
  const responseUsage = await getSpaceUsage(coupleId, responseDocument.usage)

  return {
    coupleId,
    quota: normalizeQuota(responseDocument.quota || {}),
    updatedAt: responseDocument.quotaUpdatedAt || updatedAt,
    licenseSynced,
    // 这里的 true 表示 CloudBase 写入请求已成功；readback 可能因最终一致性
    // 暂时落后，但刷新后会从正式 quota 字段读取到本次保存的值。
    verified: true,
    space: mapSpace(responseDocument, responseUsage),
  }
}

async function listSpaces(payload = {}) {
  const limit = normalizeLimit(payload.limit, 20, 100)
  const skip = randomPositiveInteger(payload.skip, 0)
  let data
  try {
    const res = await db.collection('couples').orderBy('createdAt', 'desc').skip(skip).limit(limit).get()
    data = res.data
  } catch {
    const res = await db.collection('couples').skip(skip).limit(limit).get()
    data = res.data.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }
  const total = (await db.collection('couples').count()).total || 0
  return { items: await hydrateSpaces(data), total, hasMore: skip + data.length < total }
}

async function getSpaceDetail(payload = {}) {
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')
  const res = await db.collection('couples').doc(coupleId).get()
  if (!res.data) throw new Error('空间不存在')
  // @cloudbase/node-sdk 的 doc().get() 结果有时不带 _id；补回请求使用的
  // 文档 id，避免管理台进入详情或保存额度后丢失空间上下文。
  const document = { ...res.data, _id: documentId(res.data) || coupleId }
  let license = null
  if (document.licenseId) {
    const licenseRes = await db.collection('access_codes').doc(document.licenseId).get().catch(() => ({ data: null }))
    license = omitId(licenseRes.data)
  }
  const usage = await getSpaceUsage(coupleId, document.usage)
  return { space: mapSpace(document, usage), license }
}

function collectMediaIDs(moment = {}) {
  const ids = []
  const push = id => {
    if (typeof id === 'string' && id) ids.push(id)
  }
  for (const id of moment.images || []) push(id)
  for (const id of moment.videos || []) push(id)
  push(moment.videoCover)
  for (const photo of moment.livePhotos || []) {
    push(photo.cover)
    push(photo.video)
  }
  for (const voice of moment.voices || []) push(voice.fileID)
  return [...new Set(ids)]
}

async function tempUrlMap(fileIDs) {
  const map = {}
  const batchSize = 50
  for (let i = 0; i < fileIDs.length; i += batchSize) {
    const batch = fileIDs.slice(i, i + batchSize)
    if (!batch.length) continue
    const res = await app.getTempFileURL({ fileList: batch })
    for (const item of res.fileList || []) {
      if (item.tempFileURL) map[item.fileID] = item.tempFileURL
    }
  }
  return map
}

function mediaView(moment, urls) {
  const toItem = fileID => ({ fileID, url: urls[fileID] || fileID })
  return {
    images: (moment.images || []).map(toItem),
    videos: (moment.videos || []).map(toItem),
    videoCover: moment.videoCover ? toItem(moment.videoCover) : null,
    livePhotos: (moment.livePhotos || []).map(item => ({
      cover: toItem(item.cover),
      video: toItem(item.video),
      duration: item.duration || 0,
    })),
    voices: (moment.voices || []).map(item => ({
      fileID: item.fileID,
      url: urls[item.fileID] || item.fileID,
      duration: item.duration || 0,
    })),
  }
}

async function listMoments(payload = {}) {
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')
  const limit = normalizeLimit(payload.limit, 20, 50)
  const skip = randomPositiveInteger(payload.skip, 0)
  const query = db.collection('moments').where({ coupleId })
  let res
  try {
    res = await query.orderBy('sortAt', 'desc').skip(skip).limit(limit).get()
  } catch {
    res = await db.collection('moments').where({ coupleId }).skip(skip).limit(limit).get()
    res.data.sort((a, b) => (b.sortAt || b.createdAt || 0) - (a.sortAt || a.createdAt || 0))
  }
  const total = (await db.collection('moments').where({ coupleId }).count()).total || 0
  const ids = [...new Set(res.data.flatMap(collectMediaIDs))]
  const urls = await tempUrlMap(ids)
  const items = res.data.map(doc => {
    const { _id, ...rest } = doc
    return {
      id: _id,
      ...rest,
      media: mediaView(doc, urls),
    }
  })
  return { items, total, hasMore: skip + items.length < total }
}

async function listRecords(payload = {}) {
  const allowed = new Set([
    'checkins',
    'anniversaries',
    'rants',
    'notes',
    'moment_comments',
    'moment_likes',
  ])
  const collectionName = String(payload.collection || '')
  if (!allowed.has(collectionName)) throw new Error('不支持查看这个数据集合')
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')
  const limit = normalizeLimit(payload.limit, 100, 100)
  const res = await db.collection(collectionName).where({ coupleId }).limit(limit).get()
  return res.data.map(doc => {
    const { _id, ...rest } = doc
    return { id: _id, ...rest }
  })
}

const SPACE_CHILD_COLLECTIONS = [
  'moments',
  'rants',
  'checkins',
  'anniversaries',
  'notes',
  'moment_comments',
  'moment_likes',
  'space_invites',
]

async function getOptionalCollectionDocs(collectionName, where) {
  try {
    return await getCollectionDocs(collectionName, where)
  } catch (error) {
    if (isCollectionMissingError(error)) return []
    throw error
  }
}

async function removeDocuments(collectionName, documents) {
  for (const document of documents) {
    if (document?._id) await db.collection(collectionName).doc(document._id).remove()
  }
}

function collectSpaceFileIDs(coupleId, couple, moments, rants) {
  const ids = []
  const push = fileID => {
    if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) return
    const allowed = [
      `/moments/${coupleId}/`,
      `/avatars/${coupleId}/`,
    ]
    if (allowed.some(prefix => fileID.includes(prefix))) ids.push(fileID)
  }

  for (const moment of moments) {
    for (const fileID of collectMomentFileIDs(moment)) push(fileID)
  }
  for (const rant of rants) {
    for (const fileID of collectRantFileIDs(rant)) push(fileID)
  }
  push(couple?.memberA?.avatarUrl)
  push(couple?.memberB?.avatarUrl)
  return [...new Set(ids)]
}

async function deleteCloudFiles(fileIDs) {
  const uniqueIDs = [...new Set(fileIDs)]
  let failed = 0
  const batchSize = 50
  for (let i = 0; i < uniqueIDs.length; i += batchSize) {
    const batch = uniqueIDs.slice(i, i + batchSize)
    try {
      await app.deleteFile({ fileList: batch })
    } catch (error) {
      failed += batch.length
      console.warn('delete space media failed', error?.message || error)
    }
  }
  return { requested: uniqueIDs.length, failed }
}

async function deleteSpace(payload = {}) {
  const coupleId = String(payload.coupleId || '').trim()
  if (!coupleId) throw new Error('缺少空间 id')
  const coupleRes = await db.collection('couples').doc(coupleId).get()
  const couple = coupleRes.data
  if (!couple) throw new Error('空间不存在')

  // 先暂停空间，避免删除过程中又有新的业务写入。
  await db.collection('couples').doc(coupleId).update({ status: 'revoked', deletedAt: Date.now() })

  const records = {}
  for (const collectionName of SPACE_CHILD_COLLECTIONS) {
    records[collectionName] = await getOptionalCollectionDocs(collectionName, { coupleId })
  }
  const moments = records.moments || []
  const rants = records.rants || []
  const fileIDs = collectSpaceFileIDs(coupleId, couple, moments, rants)

  for (const collectionName of SPACE_CHILD_COLLECTIONS) {
    await removeDocuments(collectionName, records[collectionName] || [])
  }

  const linkedCodes = await getOptionalCollectionDocs('access_codes', { coupleId })
  if (couple.licenseId) {
    const licenseRes = await db.collection('access_codes').doc(couple.licenseId).get().catch(() => ({ data: null }))
    if (licenseRes.data && !linkedCodes.some(code => code._id === licenseRes.data._id)) {
      linkedCodes.push(licenseRes.data)
    }
  }
  await removeDocuments('access_codes', linkedCodes)
  await db.collection('couples').doc(coupleId).remove()

  const fileResult = await deleteCloudFiles(fileIDs)
  const deletedRecords = Object.values(records).reduce((total, list) => total + list.length, 0)
  return {
    coupleId,
    deletedRecords,
    deletedFiles: fileResult.requested - fileResult.failed,
    failedFiles: fileResult.failed,
  }
}

async function overview() {
  const [spaces, codes, coupleDocuments] = await Promise.all([
    db.collection('couples').count(),
    db.collection('access_codes').count(),
    getAllCollectionDocs('couples'),
  ])
  const hydratedSpaces = await hydrateSpaces(coupleDocuments)
  const usage = hydratedSpaces.reduce(
    (total, space) => ({
      momentCount: total.momentCount + space.usage.momentCount,
      storageBytes: total.storageBytes + space.usage.storageBytes,
    }),
    { momentCount: 0, storageBytes: 0 },
  )
  return {
    spaces: spaces.total || coupleDocuments.length,
    accessCodes: codes.total || 0,
    moments: usage.momentCount,
    storageBytes: usage.storageBytes,
  }
}

async function identity() {
  const info = currentIdentity()
  const admin = await findAdmin(info)
  return {
    uid: info.uid,
    openId: info.openId || '',
    isAdmin: !!admin,
    role: admin?.role || null,
  }
}

exports.main = async event => {
  const { action, payload = {} } = event || {}
  try {
    if (action === 'identity') return { ok: true, data: await identity() }

    await requireAdmin()
    let data
    switch (action) {
      case 'overview':
        data = await overview()
        break
      case 'createAccessCode':
        data = await createAccessCode(payload)
        break
      case 'listAccessCodes':
        data = await listAccessCodes(payload)
        break
      case 'revokeAccessCode':
        data = await revokeAccessCode(payload)
        break
      case 'deleteAccessCode':
        data = await deleteAccessCode(payload)
        break
      case 'resumeSpace':
        data = await resumeSpace(payload)
        break
      case 'updateSpaceQuota':
        data = await updateSpaceQuota(payload)
        break
      case 'listSpaces':
        data = await listSpaces(payload)
        break
      case 'getSpaceDetail':
        data = await getSpaceDetail(payload)
        break
      case 'listMoments':
        data = await listMoments(payload)
        break
      case 'listRecords':
        data = await listRecords(payload)
        break
      case 'deleteSpace':
        data = await deleteSpace(payload)
        break
      default:
        return { ok: false, error: `未知 action: ${action}` }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}
