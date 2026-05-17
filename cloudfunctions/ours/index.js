// cloudfunctions/ours/index.js — Ours 业务云函数（鉴权 + 数据读写）

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const PARTNER_WECHAT_ID = 'cai852899'

function todayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function prevDayKey(dateKey) {
  const d = new Date(dateKey + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  return todayKey(d)
}

function daysBetween(startISO, end = new Date()) {
  const s = new Date(startISO + 'T00:00:00')
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const ms = e.getTime() - s.getTime()
  return Math.max(0, Math.floor(ms / 86400000)) + 1
}

function bothRolesOn(checkins) {
  const roles = new Set(checkins.map(c => c.role))
  return roles.has('A') && roles.has('B')
}

function roleOf(openid, couple) {
  if (couple.memberA && couple.memberA.openid === openid) return 'A'
  if (couple.memberB && couple.memberB.openid === openid) return 'B'
  return null
}

function serializeCouple(doc) {
  if (!doc) return null
  const id = doc._id
  const { _id, ...rest } = doc
  return { id, ...rest }
}

async function findCoupleByMember(openid) {
  const res = await db
    .collection('couples')
    .where(
      _.or([
        { 'memberA.openid': openid },
        { 'memberB.openid': openid },
      ]),
    )
    .limit(1)
    .get()
  return res.data[0] || null
}

async function getCoupleDoc(coupleId) {
  const res = await db.collection('couples').doc(coupleId).get()
  return res.data || null
}

async function requireMember(openid, coupleId) {
  const couple = await getCoupleDoc(coupleId)
  if (!couple) throw new Error('空间不存在')
  const role = roleOf(openid, couple)
  if (!role) throw new Error('无权访问该空间')
  return { couple, role }
}

async function listCheckinsForDate(coupleId, date) {
  const res = await db
    .collection('checkins')
    .where({ coupleId, date })
    .get()
  return res.data
}

async function reconcileStreak(coupleId, today) {
  const couple = await getCoupleDoc(coupleId)
  if (!couple) return couple

  const yesterday = prevDayKey(today)
  const yList = await listCheckinsForDate(coupleId, yesterday)
  if (yList.length > 0 && !bothRolesOn(yList)) {
    await db.collection('couples').doc(coupleId).update({
      data: { streakDays: 0, lastStreakDate: null },
    })
    couple.streakDays = 0
    couple.lastStreakDate = null
  }
  return couple
}

async function advanceStreak(coupleId, today) {
  let couple = await getCoupleDoc(coupleId)
  if (!couple) return

  const last = couple.lastStreakDate
  if (last === today) return

  let streakDays = couple.streakDays || 0
  if (!last) {
    streakDays = 1
  } else {
    const diff = daysBetween(last, new Date(today + 'T00:00:00')) - 1
    streakDays = diff === 1 ? streakDays + 1 : 1
  }

  await db.collection('couples').doc(coupleId).update({
    data: { streakDays, lastStreakDate: today },
  })
}

async function bootstrap(openid, payload = {}) {
  const { inviteCoupleId, nickname = '', avatarUrl = '' } = payload

  let couple = await findCoupleByMember(openid)
  if (couple) {
    return {
      status: 'ready',
      couple: serializeCouple(couple),
      role: roleOf(openid, couple),
      openid,
    }
  }

  if (inviteCoupleId) {
    couple = await joinCouple(openid, {
      coupleId: inviteCoupleId,
      nickname,
      avatarUrl,
    })
    return {
      status: 'ready',
      couple: serializeCouple(couple),
      role: 'B',
      openid,
    }
  }

  // 直接绑定：已有空间且 memberB 为空 → 第二人打开即加入
  const pending = await db
    .collection('couples')
    .where({ memberB: null })
    .limit(1)
    .get()

  const slot = pending.data[0]
  if (slot && slot.memberA && slot.memberA.openid !== openid) {
    couple = await joinCouple(openid, {
      coupleId: slot._id,
      nickname: nickname || '她',
      avatarUrl,
    })
    return {
      status: 'ready',
      couple: serializeCouple(couple),
      role: 'B',
      openid,
    }
  }

  return { status: 'needsSetup', openid }
}

async function createCouple(openid, payload = {}) {
  const existing = await findCoupleByMember(openid)
  if (existing) return serializeCouple(existing)

  const openSlots = await db.collection('couples').where({ memberB: null }).limit(1).get()
  if (openSlots.data.length > 0) {
    const slot = openSlots.data[0]
    if (slot.memberA && slot.memberA.openid === openid) {
      return serializeCouple(slot)
    }
    throw new Error('对方已创建空间，请关闭后重新打开小程序即可加入')
  }

  const { startDate, nickname = '你', avatarUrl = '' } = payload
  if (!startDate) throw new Error('请选择在一起的开始日期')

  const data = {
    startDate,
    memberA: { openid, nickname, avatarUrl },
    memberB: null,
    partnerWechatId: PARTNER_WECHAT_ID,
    streakDays: 0,
    lastStreakDate: null,
    createdAt: Date.now(),
  }

  const res = await db.collection('couples').add({ data })
  return serializeCouple({ _id: res._id, ...data })
}

async function joinCouple(openid, payload = {}) {
  const { coupleId, nickname = '她', avatarUrl = '' } = payload
  if (!coupleId) throw new Error('缺少空间 id')

  const couple = await getCoupleDoc(coupleId)
  if (!couple) throw new Error('空间不存在')
  if (couple.memberA && couple.memberA.openid === openid) {
    return serializeCouple(couple)
  }
  if (couple.memberB) {
    if (couple.memberB.openid === openid) return serializeCouple(couple)
    throw new Error('该空间已满')
  }

  const memberB = { openid, nickname, avatarUrl }
  await db.collection('couples').doc(coupleId).update({
    data: { memberB },
  })
  return serializeCouple({ ...couple, _id: coupleId, memberB })
}

async function updateStartDate(openid, payload = {}) {
  const { coupleId, startDate } = payload
  await requireMember(openid, coupleId)
  await db.collection('couples').doc(coupleId).update({
    data: { startDate },
  })
  const couple = await getCoupleDoc(coupleId)
  return serializeCouple(couple)
}

async function updateProfile(openid, payload = {}) {
  const { coupleId, nickname, avatarUrl } = payload
  const { couple, role } = await requireMember(openid, coupleId)
  const field = role === 'A' ? 'memberA' : 'memberB'
  const member = { ...couple[field], nickname, avatarUrl: avatarUrl ?? couple[field].avatarUrl }
  await db.collection('couples').doc(coupleId).update({
    data: { [field]: member },
  })
  const fresh = await getCoupleDoc(coupleId)
  return serializeCouple(fresh)
}

function collectMomentFileIDs(moment) {
  const ids = []
  const push = id => {
    if (id && typeof id === 'string' && id.startsWith('cloud://')) ids.push(id)
  }
  for (const id of moment.images || []) push(id)
  for (const id of moment.videos || []) push(id)
  for (const lp of moment.livePhotos || []) {
    push(lp.cover)
    push(lp.video)
  }
  for (const v of moment.voices || []) push(v.fileID)
  return [...new Set(ids)]
}

async function deleteCloudFiles(fileIDs) {
  if (!fileIDs.length) return
  const batchSize = 50
  for (let i = 0; i < fileIDs.length; i += batchSize) {
    const batch = fileIDs.slice(i, i + batchSize)
    try {
      await cloud.deleteFile({ fileList: batch })
    } catch (e) {
      console.warn('deleteFile partial fail', e.message)
    }
  }
}

async function assertTextSafe(openid, text, label = '内容') {
  const content = (text || '').trim()
  if (!content) return
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid,
      version: 2,
      scene: 2,
      content,
    })
    const suggest = res.result?.suggest || res.suggest
    if (res.errCode !== 0 && res.errCode !== undefined) {
      throw new Error(res.errMsg || '内容审核未通过')
    }
    if (suggest && suggest !== 'pass') {
      throw new Error(`${label}含有不合适的信息，请修改后重试`)
    }
  } catch (err) {
    if (err.message && (err.message.indexOf('内容') !== -1 || err.message.indexOf('不合适') !== -1)) {
      throw err
    }
    throw new Error(`${label}含有不合适的信息，请修改后重试`)
  }
}

function daysUntilAnniversary(dateStr, yearly = true) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const parts = dateStr.split('-').map(Number)
  let target
  if (yearly && parts.length >= 3) {
    target = new Date(now.getFullYear(), parts[1] - 1, parts[2])
    if (target < now) target = new Date(now.getFullYear() + 1, parts[1] - 1, parts[2])
  } else {
    target = new Date(dateStr + 'T00:00:00')
  }
  target.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((target - now) / 86400000))
}

function pickCoverFileID(m) {
  if (m.images?.length) return m.images[0]
  if (m.livePhotos?.[0]?.cover) return m.livePhotos[0].cover
  return ''
}

function pickPreviewFileIDs(m, max = 9) {
  const ids = []
  if (m.images?.length) {
    for (const id of m.images) {
      if (ids.length >= max) break
      ids.push(id)
    }
    return ids
  }
  if (m.livePhotos?.length) {
    for (const lp of m.livePhotos) {
      if (lp.cover && ids.length < max) ids.push(lp.cover)
    }
  }
  return ids
}

async function resolveFileUrls(fileIDs) {
  const cloudIds = [...new Set(fileIDs.filter(id => id && typeof id === 'string' && id.startsWith('cloud://')))]
  const map = {}
  if (!cloudIds.length) return map
  const batchSize = 50
  for (let i = 0; i < cloudIds.length; i += batchSize) {
    const batch = cloudIds.slice(i, i + batchSize)
    try {
      const res = await cloud.getTempFileURL({ fileList: batch })
      for (const item of res.fileList || []) {
        if (item.status === 0 && item.tempFileURL) map[item.fileID] = item.tempFileURL
      }
    } catch (e) {
      console.warn('resolveFileUrls', e.message)
    }
  }
  return map
}

function passesMediaFilter(m, mediaFilter) {
  if (!mediaFilter) return true
  if (mediaFilter === 'image') return (m.images?.length > 0) || (m.livePhotos?.length > 0)
  if (mediaFilter === 'voice') return (m.voices?.length > 0)
  if (mediaFilter === 'live') return (m.livePhotos?.length > 0)
  return true
}

async function enrichMomentsList(items, coupleId, role) {
  if (!items.length) return []
  const momentIds = items.map(m => m.id)
  let commentsRes = { data: [] }
  let likesRes = { data: [] }
  try {
    ;[commentsRes, likesRes] = await Promise.all([
      db.collection('moment_comments').where({ coupleId, momentId: _.in(momentIds) }).get(),
      db.collection('moment_likes').where({ coupleId, momentId: _.in(momentIds) }).get(),
    ])
  } catch (e) {
    console.warn('enrichMomentsList', e.message)
  }
  const commentCount = {}
  for (const c of commentsRes.data) {
    commentCount[c.momentId] = (commentCount[c.momentId] || 0) + 1
  }
  const likeMap = {}
  for (const l of likesRes.data) {
    if (!likeMap[l.momentId]) likeMap[l.momentId] = { count: 0, likedByMe: false }
    likeMap[l.momentId].count += 1
    if (l.role === role) likeMap[l.momentId].likedByMe = true
  }
  const previewIds = []
  for (const m of items) previewIds.push(...pickPreviewFileIDs(m))
  const urlMap = await resolveFileUrls([...new Set([...previewIds, ...items.map(pickCoverFileID)])].filter(Boolean))
  return items.map(m => {
    const coverId = pickCoverFileID(m)
    const coverUrl =
      coverId && coverId.startsWith('cloud://') ? urlMap[coverId] || '' : coverId || ''
    const previewImages = pickPreviewFileIDs(m)
      .map(id => (id && id.startsWith('cloud://') ? urlMap[id] || '' : id || ''))
      .filter(Boolean)
    return {
      ...m,
      commentCount: commentCount[m.id] || 0,
      likeCount: likeMap[m.id]?.count || 0,
      likedByMe: likeMap[m.id]?.likedByMe || false,
      coverUrl,
      previewImages,
    }
  })
}

async function queryMomentsPage(openid, payload, withKeyword) {
  const { coupleId, limit = 20, skip = 0, tag, mediaFilter, keyword } = payload
  const { role } = await requireMember(openid, coupleId)
  const pageSize = Math.min(Math.max(limit, 1), 50)
  const where = { coupleId }
  if (tag) where.tag = tag
  if (withKeyword && keyword) {
    where.content = db.RegExp({ regexp: keyword, options: 'i' })
  }

  if (mediaFilter) {
    const fetchSize = Math.min(pageSize * 4, 100)
    const res = await db
      .collection('moments')
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(fetchSize)
      .get()
    const raw = res.data
      .map(m => {
        const { _id, ...rest } = m
        return { id: _id, ...rest }
      })
      .filter(m => passesMediaFilter(m, mediaFilter))
    const slice = raw.slice(0, pageSize)
    const items = await enrichMomentsList(slice, coupleId, role)
    return {
      items,
      total: skip + slice.length,
      hasMore: raw.length >= pageSize,
    }
  }

  const [countRes, res] = await Promise.all([
    db.collection('moments').where(where).count(),
    db
      .collection('moments')
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(pageSize)
      .get(),
  ])
  const total = countRes.total || 0
  const raw = res.data.map(m => {
    const { _id, ...rest } = m
    return { id: _id, ...rest }
  })
  const items = await enrichMomentsList(raw, coupleId, role)
  return {
    items,
    total,
    hasMore: skip + items.length < total,
  }
}

async function listMoments(openid, payload = {}) {
  return queryMomentsPage(openid, payload, false)
}

async function searchMoments(openid, payload = {}) {
  const { keyword } = payload
  if (!(keyword || '').trim()) {
    return { items: [], total: 0, hasMore: false }
  }
  return queryMomentsPage(openid, payload, true)
}

async function getOnThisDay(openid, payload = {}) {
  const { coupleId } = payload
  const { role } = await requireMember(openid, coupleId)
  const now = new Date()
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const res = await db.collection('moments').where({ coupleId }).orderBy('createdAt', 'desc').limit(300).get()
  const filtered = res.data
    .filter(m => {
      const d = new Date(m.createdAt)
      const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return key === md && m.kind !== 'system'
    })
    .map(m => {
      const { _id, ...rest } = m
      return { id: _id, ...rest }
    })
  const items = await enrichMomentsList(filtered, coupleId, role)
  return items
}

async function getMomentsStats(openid, payload = {}) {
  const { coupleId, year, month } = payload
  await requireMember(openid, coupleId)
  const y = Number(year) || new Date().getFullYear()
  const m = Number(month)
  const res = await db.collection('moments').where({ coupleId }).limit(500).get()
  let list = res.data.filter(doc => doc.kind !== 'system')
  if (m >= 1 && m <= 12) {
    list = list.filter(doc => {
      const d = new Date(doc.createdAt)
      return d.getFullYear() === y && d.getMonth() + 1 === m
    })
  } else {
    list = list.filter(doc => new Date(doc.createdAt).getFullYear() === y)
  }
  const tagCount = { daily: 0, travel: 0, rant: 0, '': 0 }
  const places = new Set()
  let countA = 0
  let countB = 0
  for (const doc of list) {
    if (doc.authorRole === 'A') countA += 1
    else countB += 1
    const t = doc.tag || ''
    tagCount[t] = (tagCount[t] || 0) + 1
    if (doc.location?.name) places.add(doc.location.name)
  }
  const topTag =
    Object.entries(tagCount)
      .filter(([k]) => k)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  return {
    year: y,
    month: m || 0,
    total: list.length,
    countA,
    countB,
    placeCount: places.size,
    topTag,
  }
}

async function listMomentCollections(openid, payload = {}) {
  const { coupleId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('moments').where({ coupleId }).limit(500).get()
  const byTag = {}
  const byPlace = {}
  for (const doc of res.data) {
    if (doc.kind === 'system') continue
    if (doc.tag) {
      byTag[doc.tag] = (byTag[doc.tag] || 0) + 1
    }
    if (doc.location?.name) {
      byPlace[doc.location.name] = (byPlace[doc.location.name] || 0) + 1
    }
  }
  const tagLabels = { daily: '日常', travel: '旅行', rant: '吐槽' }
  return {
    tags: Object.entries(byTag).map(([key, count]) => ({
      key,
      label: tagLabels[key] || key,
      count,
    })),
    places: Object.entries(byPlace)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  }
}

async function getMomentNeighbors(openid, payload = {}) {
  const { coupleId, momentId, tag } = payload
  await requireMember(openid, coupleId)
  const where = { coupleId }
  if (tag) where.tag = tag
  const res = await db
    .collection('moments')
    .where(where)
    .orderBy('createdAt', 'desc')
    .field({ _id: true })
    .limit(500)
    .get()
  const ids = res.data.map(doc => doc._id)
  const idx = ids.indexOf(momentId)
  return {
    prevId: idx > 0 ? ids[idx - 1] : null,
    nextId: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null,
    index: idx >= 0 ? idx + 1 : 0,
    total: ids.length,
  }
}

async function getMomentsBriefStats(openid, payload = {}) {
  const { coupleId } = payload
  await requireMember(openid, coupleId)
  const [totalRes, aRes, bRes] = await Promise.all([
    db.collection('moments').where({ coupleId, kind: 'post' }).count(),
    db.collection('moments').where({ coupleId, authorRole: 'A' }).count(),
    db.collection('moments').where({ coupleId, authorRole: 'B' }).count(),
  ])
  return {
    total: totalRes.total || 0,
    countA: aRes.total || 0,
    countB: bRes.total || 0,
  }
}

async function getMoment(openid, payload = {}) {
  const { coupleId, momentId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('moments').doc(momentId).get()
  const m = res.data
  if (!m || m.coupleId !== coupleId) return null
  const { _id, ...rest } = m
  return { id: _id, ...rest }
}

async function addMoment(openid, payload = {}) {
  const { coupleId, content, images, videos, livePhotos, voices, location, tag } = payload
  const { role } = await requireMember(openid, coupleId)
  await assertTextSafe(openid, content, '文字')
  const allowed = ['', 'daily', 'travel', 'rant']
  const momentTag = allowed.includes(tag) ? tag : ''
  const data = {
    coupleId,
    kind: 'post',
    systemKind: null,
    content: (content || '').trim(),
    images: images || [],
    videos: videos || [],
    livePhotos: livePhotos || [],
    voices: voices || [],
    location: location || null,
    tag: momentTag,
    authorOpenid: openid,
    authorRole: role,
    createdAt: Date.now(),
  }
  const res = await db.collection('moments').add({ data })
  await grantPetExp(coupleId, 12)
  return { id: res._id, ...data }
}

async function insertCheckinSystemMoment(coupleId, date, streakDays) {
  const exists = await db
    .collection('moments')
    .where({ coupleId, kind: 'system', systemKind: 'checkin', checkinDate: date })
    .limit(1)
    .get()
  if (exists.data.length > 0) return

  await db.collection('moments').add({
    data: {
      coupleId,
      kind: 'system',
      systemKind: 'checkin',
      checkinDate: date,
      content: `今天你们都签到了 · 连续双人签到 ${streakDays} 天`,
      images: [],
      videos: [],
      livePhotos: [],
      voices: [],
      location: null,
      tag: '',
      authorOpenid: 'system',
      authorRole: 'A',
      createdAt: Date.now(),
      meta: { date, streakDays },
    },
  })
}

async function deleteMoment(openid, payload = {}) {
  const { coupleId, momentId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('moments').doc(momentId).get()
  if (!res.data || res.data.coupleId !== coupleId) throw new Error('动态不存在')
  const fileIDs = collectMomentFileIDs(res.data)
  await deleteCloudFiles(fileIDs)
  await db.collection('moments').doc(momentId).remove()
  return { ok: true }
}

async function listCheckins(openid, payload = {}) {
  const { coupleId, year, month } = payload
  await requireMember(openid, coupleId)
  const y = Number(year)
  const m = Number(month)
  if (!y || !m || m < 1 || m > 12) throw new Error('请选择有效月份')

  const prefix = `${y}-${String(m).padStart(2, '0')}`
  const lastDay = new Date(y, m, 0).getDate()
  const startKey = `${prefix}-01`
  const endKey = `${prefix}-${String(lastDay).padStart(2, '0')}`

  const res = await db
    .collection('checkins')
    .where({
      coupleId,
      date: _.gte(startKey).and(_.lte(endKey)),
    })
    .get()

  return res.data.map(c => {
    const { _id, ...rest } = c
    return { id: _id, ...rest }
  })
}

async function addCheckin(openid, payload = {}) {
  const { coupleId, mood, note } = payload
  const { role } = await requireMember(openid, coupleId)
  await assertTextSafe(openid, note, '签到备注')
  const date = todayKey()

  await reconcileStreak(coupleId, date)

  const existing = await db
    .collection('checkins')
    .where({ coupleId, date, openid })
    .limit(1)
    .get()

  if (existing.data.length > 0) {
    const couple = await getCoupleDoc(coupleId)
    const list = await listCheckinsForDate(coupleId, date)
    return {
      checkin: existing.data[0],
      bothChecked: bothRolesOn(list),
      streakDays: couple?.streakDays || 0,
    }
  }

  const data = {
    coupleId,
    date,
    openid,
    role,
    mood: mood || null,
    note: (note || '').trim(),
    createdAt: Date.now(),
  }
  const res = await db.collection('checkins').add({ data })
  await grantPetExp(coupleId, 8)

  const list = await listCheckinsForDate(coupleId, date)
  const both = bothRolesOn(list)
  if (both) {
    await advanceStreak(coupleId, date)
    const coupleAfter = await getCoupleDoc(coupleId)
    await insertCheckinSystemMoment(coupleId, date, coupleAfter?.streakDays || 1)
    await grantPetExp(coupleId, 15)
  }

  const couple = await getCoupleDoc(coupleId)
  return {
    checkin: { id: res._id, ...data },
    bothChecked: both,
    streakDays: couple?.streakDays || 0,
  }
}

async function getCheckinState(openid, payload = {}) {
  const { coupleId, date = todayKey() } = payload
  await requireMember(openid, coupleId)
  const list = await listCheckinsForDate(coupleId, date)
  const couple = await getCoupleDoc(coupleId)
  const my = list.find(c => c.openid === openid)
  return {
    checkins: list,
    bothChecked: bothRolesOn(list),
    hasCheckedIn: !!my,
    streakDays: couple?.streakDays || 0,
  }
}

async function wipeCoupleV02(coupleId) {
  const cols = ['anniversaries', 'rants', 'notes', 'moment_comments', 'moment_likes']
  for (const name of cols) {
    try {
      const res = await db.collection(name).where({ coupleId }).get()
      for (const doc of res.data) {
        if (name === 'rants' && doc.images?.length) {
          await deleteCloudFiles(doc.images.filter(id => id && id.startsWith('cloud://')))
        }
        await db.collection(name).doc(doc._id).remove()
      }
    } catch (e) {
      console.warn('wipeCoupleV02', name, e.message)
    }
  }
}

async function listAnniversaries(openid, payload = {}) {
  const { coupleId } = payload
  await requireMember(openid, coupleId)
  const res = await db
    .collection('anniversaries')
    .where({ coupleId })
    .orderBy('date', 'asc')
    .get()
  return res.data.map(a => {
    const { _id, ...rest } = a
    return { id: _id, ...rest, daysLeft: daysUntilAnniversary(a.date, a.yearly !== false) }
  })
}

async function addAnniversary(openid, payload = {}) {
  const { coupleId, title, date, yearly = true, remind = true } = payload
  await requireMember(openid, coupleId)
  await assertTextSafe(openid, title, '纪念日名称')
  if (!date) throw new Error('请选择日期')
  const data = {
    coupleId,
    title: (title || '').trim(),
    date,
    yearly: !!yearly,
    remind: !!remind,
    createdAt: Date.now(),
  }
  const res = await db.collection('anniversaries').add({ data })
  return { id: res._id, ...data, daysLeft: daysUntilAnniversary(date, yearly) }
}

async function deleteAnniversary(openid, payload = {}) {
  const { coupleId, anniversaryId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('anniversaries').doc(anniversaryId).get()
  if (!res.data || res.data.coupleId !== coupleId) throw new Error('纪念日不存在')
  await db.collection('anniversaries').doc(anniversaryId).remove()
  return { ok: true }
}

async function getNextAnniversary(openid, payload = {}) {
  const list = await listAnniversaries(openid, payload)
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a.daysLeft - b.daysLeft)
  const next = sorted[0]
  return {
    id: next.id,
    title: next.title,
    date: next.date,
    daysLeft: next.daysLeft,
    label: next.daysLeft === 0 ? '就是今天' : `还有 ${next.daysLeft} 天`,
  }
}

function isCollectionMissingError(e) {
  const msg = `${e?.message || ''}${e?.errMsg || ''}`
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exist|集合不存在|ResourceNotFound/i.test(msg)
}

function mapDocsWithId(data) {
  return (data || []).map(doc => {
    const { _id, ...rest } = doc
    return { id: _id, ...rest }
  })
}

async function listRants(openid, payload = {}) {
  const { coupleId, limit = 50 } = payload
  await requireMember(openid, coupleId)
  const cap = Math.min(limit, 100)
  try {
    const res = await db
      .collection('rants')
      .where({ coupleId })
      .orderBy('createdAt', 'desc')
      .limit(cap)
      .get()
    return mapDocsWithId(res.data)
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    try {
      const res = await db.collection('rants').where({ coupleId }).limit(100).get()
      const sorted = res.data.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return mapDocsWithId(sorted.slice(0, cap))
    } catch (e2) {
      if (isCollectionMissingError(e2)) return []
      throw e2
    }
  }
}

async function addRant(openid, payload = {}) {
  const { coupleId, content, images = [] } = payload
  const { role } = await requireMember(openid, coupleId)
  await assertTextSafe(openid, content, '吐槽')
  const imgs = (images || []).slice(0, 3)
  const data = {
    coupleId,
    content: (content || '').trim(),
    images: imgs,
    authorOpenid: openid,
    authorRole: role,
    createdAt: Date.now(),
  }
  const res = await db.collection('rants').add({ data })
  return { id: res._id, ...data }
}

async function deleteRant(openid, payload = {}) {
  const { coupleId, rantId } = payload
  const { role } = await requireMember(openid, coupleId)
  const res = await db.collection('rants').doc(rantId).get()
  if (!res.data || res.data.coupleId !== coupleId) throw new Error('吐槽不存在')
  await deleteCloudFiles((res.data.images || []).filter(id => id && id.startsWith('cloud://')))
  await db.collection('rants').doc(rantId).remove()
  return { ok: true }
}

async function listNotes(openid, payload = {}) {
  const { coupleId } = payload
  const { role } = await requireMember(openid, coupleId)
  const mapNotes = data =>
    (data || []).map(n => {
      const { _id, ...rest } = n
      return {
        id: _id,
        ...rest,
        isMine: n.fromRole === role,
        isUnread: n.toRole === role && !n.readAt,
      }
    })
  try {
    const res = await db
      .collection('notes')
      .where({ coupleId })
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()
    return mapNotes(res.data)
  } catch (e) {
    if (isCollectionMissingError(e)) return []
    try {
      const res = await db.collection('notes').where({ coupleId }).limit(100).get()
      const sorted = res.data.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return mapNotes(sorted)
    } catch (e2) {
      if (isCollectionMissingError(e2)) return []
      throw e2
    }
  }
}

async function sendNote(openid, payload = {}) {
  const { coupleId, content } = payload
  const { couple, role } = await requireMember(openid, coupleId)
  if (!couple.memberB) throw new Error('她加入后才能发小纸条')
  await assertTextSafe(openid, content, '小纸条')
  const toRole = role === 'A' ? 'B' : 'A'
  const data = {
    coupleId,
    content: (content || '').trim(),
    fromRole: role,
    toRole,
    readAt: null,
    createdAt: Date.now(),
  }
  const res = await db.collection('notes').add({ data })
  return { id: res._id, ...data }
}

async function markNoteRead(openid, payload = {}) {
  const { coupleId, noteId } = payload
  const { role } = await requireMember(openid, coupleId)
  const res = await db.collection('notes').doc(noteId).get()
  if (!res.data || res.data.coupleId !== coupleId) throw new Error('小纸条不存在')
  if (res.data.toRole !== role) throw new Error('这不是发给你的纸条')
  await db.collection('notes').doc(noteId).update({ data: { readAt: Date.now() } })
  return { ok: true }
}

async function listComments(openid, payload = {}) {
  const { coupleId, momentId } = payload
  await requireMember(openid, coupleId)
  const res = await db
    .collection('moment_comments')
    .where({ coupleId, momentId })
    .orderBy('createdAt', 'asc')
    .get()
  return res.data.map(c => {
    const { _id, ...rest } = c
    return { id: _id, ...rest }
  })
}

async function addComment(openid, payload = {}) {
  const { coupleId, momentId, content } = payload
  const { role } = await requireMember(openid, coupleId)
  const m = await db.collection('moments').doc(momentId).get()
  if (!m.data || m.data.coupleId !== coupleId) throw new Error('动态不存在')
  if (m.data.kind === 'system') throw new Error('系统卡片暂不支持评论')
  await assertTextSafe(openid, content, '评论')
  const data = {
    coupleId,
    momentId,
    content: (content || '').trim(),
    authorOpenid: openid,
    authorRole: role,
    createdAt: Date.now(),
  }
  const res = await db.collection('moment_comments').add({ data })
  return { id: res._id, ...data }
}

async function deleteComment(openid, payload = {}) {
  const { coupleId, commentId } = payload
  const { role } = await requireMember(openid, coupleId)
  const res = await db.collection('moment_comments').doc(commentId).get()
  if (!res.data || res.data.coupleId !== coupleId) throw new Error('评论不存在')
  if (res.data.authorRole !== role) throw new Error('只能删除自己的评论')
  await db.collection('moment_comments').doc(commentId).remove()
  return { ok: true }
}

async function getMomentLikes(openid, payload = {}) {
  const { coupleId, momentId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('moment_likes').where({ coupleId, momentId }).get()
  const likedByA = res.data.some(l => l.role === 'A')
  const likedByB = res.data.some(l => l.role === 'B')
  return { likedByA, likedByB, count: res.data.length }
}

async function toggleMomentLike(openid, payload = {}) {
  const { coupleId, momentId } = payload
  const { role } = await requireMember(openid, coupleId)
  const m = await db.collection('moments').doc(momentId).get()
  if (!m.data || m.data.coupleId !== coupleId) throw new Error('动态不存在')
  const existing = await db
    .collection('moment_likes')
    .where({ coupleId, momentId, openid })
    .limit(1)
    .get()
  if (existing.data.length > 0) {
    await db.collection('moment_likes').doc(existing.data[0]._id).remove()
  } else {
    await db.collection('moment_likes').add({
      data: { coupleId, momentId, openid, role, createdAt: Date.now() },
    })
  }
  return getMomentLikes(openid, { coupleId, momentId })
}

async function listMapPlaces(openid, payload = {}) {
  const { coupleId } = payload
  await requireMember(openid, coupleId)
  const res = await db.collection('moments').where({ coupleId }).limit(200).get()
  const placeMap = new Map()
  const cityMap = new Map()
  for (const m of res.data) {
    if (!m.location || m.location.latitude == null) continue
    const loc = m.location
    const key = `${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`
    if (!placeMap.has(key)) {
      placeMap.set(key, {
        id: key,
        name: loc.name,
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        momentCount: 0,
      })
    }
    placeMap.get(key).momentCount += 1
    const city = (loc.address || loc.name || '未知').split(/省|市/)[0] || loc.name
    cityMap.set(city, (cityMap.get(city) || 0) + 1)
  }
  return {
    places: [...placeMap.values()],
    cities: [...cityMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  }
}

async function wipeMomentsAndCheckins(coupleId) {
  await wipeCoupleV02(coupleId)
  const moments = await db.collection('moments').where({ coupleId }).get()
  const allFileIDs = []
  for (const m of moments.data) {
    allFileIDs.push(...collectMomentFileIDs(m))
    await db.collection('moments').doc(m._id).remove()
  }
  await deleteCloudFiles([...new Set(allFileIDs)])
  const checkins = await db.collection('checkins').where({ coupleId }).get()
  for (const c of checkins.data) {
    await db.collection('checkins').doc(c._id).remove()
  }
  await db.collection('couples').doc(coupleId).update({
    data: { streakDays: 0, lastStreakDate: null },
  })
}

const PET_LEVEL_EXP = [0, 40, 100, 200, 350, 550, 800, 1200]
const PET_SPECIES = ['cat']

function levelFromExp(exp) {
  let lv = 1
  for (let i = 1; i < PET_LEVEL_EXP.length; i++) {
    if (exp >= PET_LEVEL_EXP[i]) lv = i + 1
    else break
  }
  return Math.min(lv, PET_LEVEL_EXP.length)
}

function expProgress(exp) {
  const level = levelFromExp(exp)
  const base = PET_LEVEL_EXP[level - 1] || 0
  const next = PET_LEVEL_EXP[level] ?? PET_LEVEL_EXP[PET_LEVEL_EXP.length - 1]
  return {
    level,
    expCurrent: exp - base,
    expNeed: Math.max(1, next - base),
    stage: level <= 2 ? 'baby' : level <= 4 ? 'teen' : 'adult',
  }
}

function defaultPetData(name = '小咪', species = 'cat') {
  return {
    name,
    species: PET_SPECIES.includes(species) ? species : 'cat',
    exp: 0,
    happiness: 72,
    lastFedDate: '',
    lastPetDate: '',
    adoptedAt: Date.now(),
  }
}

function petMoodFromHappiness(h) {
  if (h >= 75) return 'happy'
  if (h >= 45) return 'normal'
  if (h >= 25) return 'hungry'
  return 'sleepy'
}

function petFlavor(mood, level, name) {
  const msgs = {
    happy: [`${name}开心地蹭了蹭你们`, '今天能量满满', '一起记录的日子，它也在长大'],
    normal: [`${name}在打盹`, '喂点零食会更开心', '记一条动态，它也会成长'],
    hungry: [`${name}饿了…`, '今天还没喂食哦', '来喂一口吧'],
    sleepy: [`${name}蔫蔫的`, '好久没见你们了', '喂食或抚摸一下'],
  }
  const list = msgs[mood] || msgs.normal
  return list[level % list.length]
}

async function applyHappinessDecay(coupleId, pet) {
  const today = todayKey()
  if (!pet.lastFedDate) return pet
  const last = pet.lastFedDate
  if (last === today) return pet
  const lastD = new Date(last + 'T12:00:00')
  const todayD = new Date(today + 'T12:00:00')
  const gap = Math.floor((todayD - lastD) / 86400000)
  if (gap <= 0) return pet
  const drop = Math.min(40, gap * 12)
  const happiness = Math.max(15, (pet.happiness || 70) - drop)
  const next = { ...pet, happiness }
  await db.collection('couples').doc(coupleId).update({ data: { pet: next } })
  return next
}

function buildPetView(pet) {
  if (!pet || !pet.adoptedAt) return { adopted: false }
  const exp = pet.exp || 0
  const prog = expProgress(exp)
  const happiness = Math.min(100, Math.max(0, pet.happiness ?? 70))
  const mood = petMoodFromHappiness(happiness)
  const today = todayKey()
  return {
    adopted: true,
    name: pet.name || '小咪',
    species: pet.species || 'cat',
    exp,
    happiness,
    mood,
    level: prog.level,
    stage: prog.stage,
    expCurrent: prog.expCurrent,
    expNeed: prog.expNeed,
    canFeed: pet.lastFedDate !== today,
    canPet: pet.lastPetDate !== today,
    expPercent: Math.min(100, Math.round((prog.expCurrent / prog.expNeed) * 100)),
    message: petFlavor(mood, prog.level, pet.name || '小咪'),
  }
}

async function grantPetExp(coupleId, amount) {
  if (!amount) return
  const couple = await getCoupleDoc(coupleId)
  if (!couple?.pet?.adoptedAt) return
  const exp = (couple.pet.exp || 0) + amount
  await db.collection('couples').doc(coupleId).update({
    data: { 'pet.exp': exp },
  })
}

async function getPet(openid, payload = {}) {
  const { coupleId } = payload
  await requireMember(openid, coupleId)
  const couple = await getCoupleDoc(coupleId)
  if (!couple?.pet?.adoptedAt) return { adopted: false }
  const pet = await applyHappinessDecay(coupleId, couple.pet)
  return buildPetView(pet)
}

async function adoptPet(openid, payload = {}) {
  const { coupleId, name } = payload
  await requireMember(openid, coupleId)
  const couple = await getCoupleDoc(coupleId)
  if (couple?.pet?.adoptedAt) throw new Error('已经领养过小猫了')
  const petName = (name || '小咪').trim() || '小咪'
  await assertTextSafe(openid, petName, '小猫名字')
  const pet = defaultPetData(petName, 'cat')
  await db.collection('couples').doc(coupleId).update({ data: { pet } })
  return buildPetView(pet)
}

async function petInteract(openid, payload = {}) {
  const { coupleId, action } = payload
  await requireMember(openid, coupleId)
  const couple = await getCoupleDoc(coupleId)
  if (!couple?.pet?.adoptedAt) throw new Error('请先领养宠物')
  let pet = await applyHappinessDecay(coupleId, couple.pet)
  const today = todayKey()
  if (action === 'feed') {
    if (pet.lastFedDate === today) throw new Error('今天已经喂过了')
    pet = {
      ...pet,
      lastFedDate: today,
      happiness: Math.min(100, (pet.happiness || 70) + 22),
      exp: (pet.exp || 0) + 8,
    }
  } else if (action === 'pet') {
    if (pet.lastPetDate === today) throw new Error('今天已经抚摸过了')
    pet = {
      ...pet,
      lastPetDate: today,
      happiness: Math.min(100, (pet.happiness || 70) + 14),
      exp: (pet.exp || 0) + 5,
    }
  } else {
    throw new Error('未知操作')
  }
  await db.collection('couples').doc(coupleId).update({ data: { pet } })
  return buildPetView(pet)
}

async function seedDemoData(openid, payload = {}) {
  const { coupleId, envVersion, reset = true } = payload
  if (envVersion !== 'develop' && envVersion !== 'trial') {
    throw new Error('演示数据仅可在开发版/体验版使用')
  }
  const { couple, role } = await requireMember(openid, coupleId)
  if (reset) await wipeMomentsAndCheckins(coupleId)

  const annList = [
    { title: '在一起', date: couple.startDate, yearly: true },
    { title: '她的生日', date: '2000-08-15', yearly: true },
    { title: '第一次旅行', date: '2024-10-01', yearly: true },
  ]
  let annCount = 0
  for (const a of annList) {
    try {
      await db.collection('anniversaries').add({
        data: { coupleId, ...a, remind: true, createdAt: Date.now() },
      })
      annCount++
    } catch (e) {
      console.warn('seed anniversaries', e.message)
    }
  }

  const partnerRole = role === 'A' ? 'B' : 'A'
  const moods = ['happy', 'soft', 'low', 'rant']
  let momentCount = 0

  for (let i = 0; i < 22; i++) {
    const d = new Date()
    d.setDate(d.getDate() - Math.floor(i / 2))
    d.setHours(10 + (i % 8), 30, 0, 0)
    let authorRole = role
    let authorOpenid = openid
    if (couple.memberB && i % 3 === 0) {
      authorRole = partnerRole
      authorOpenid =
        authorRole === 'A' ? couple.memberA.openid : couple.memberB.openid
    }
    const tags = ['daily', 'travel', 'rant', '']
    const tag = tags[i % tags.length]
    const loc =
      i % 5 === 0
        ? {
            name: `演示地点 ${i}`,
            address: '演示市演示区',
            latitude: 31.23 + i * 0.01,
            longitude: 121.47 + i * 0.01,
          }
        : null
    await db.collection('moments').add({
      data: {
        coupleId,
        kind: 'post',
        systemKind: null,
        content: `【演示 #${22 - i}】测试回忆分页与时间轴（纯文字）。`,
        images: [],
        videos: [],
        livePhotos: [],
        voices: [],
        location: loc,
        tag,
        authorOpenid,
        authorRole,
        createdAt: d.getTime(),
      },
    })
    momentCount++
  }

  const otd = new Date()
  otd.setFullYear(otd.getFullYear() - 1)
  otd.setHours(18, 0, 0, 0)
  await db.collection('moments').add({
    data: {
      coupleId,
      kind: 'post',
      systemKind: null,
      content: '【演示 · 那年今日】一年前的今天，适合测横滑条。',
      images: [],
      videos: [],
      livePhotos: [],
      voices: [],
      location: null,
      tag: 'daily',
      authorOpenid: openid,
      authorRole: role,
      createdAt: otd.getTime(),
    },
  })
  momentCount++

  let checkinCount = 0
  const addCheckinFor = async (r, member, date, mood, note) => {
    if (!member) return
    const exists = await db
      .collection('checkins')
      .where({ coupleId, date, role: r })
      .limit(1)
      .get()
    if (exists.data.length) return
    await db.collection('checkins').add({
      data: {
        coupleId,
        date,
        openid: member.openid,
        role: r,
        mood,
        note,
        createdAt: Date.now(),
      },
    })
    checkinCount++
  }

  for (let i = 0; i < 14; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const date = todayKey(d)
    const mood = moods[i % moods.length]
    await addCheckinFor('A', couple.memberA, date, mood, i === 0 ? '' : `演示 ${date}`)
    if (couple.memberB && i % 2 === 0) {
      await addCheckinFor('B', couple.memberB, date, moods[(i + 1) % moods.length], `演示 ${date}`)
    }
  }

  let streakDays = 0
  let lastStreakDate = null
  if (couple.memberB) {
    for (let i = 0; i < 14; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const date = todayKey(d)
      const list = await listCheckinsForDate(coupleId, date)
      if (bothRolesOn(list)) {
        streakDays++
        lastStreakDate = date
      } else {
        break
      }
    }
    if (streakDays > 0) {
      await db.collection('couples').doc(coupleId).update({
        data: { streakDays, lastStreakDate },
      })
    }
  }

  const firstMoment = await db
    .collection('moments')
    .where({ coupleId, kind: 'post' })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
  const mid = firstMoment.data[0]?._id
  if (mid) {
    await db.collection('moment_comments').add({
      data: {
        coupleId,
        momentId: mid,
        content: '演示评论：这条回忆真不错',
        authorOpenid: openid,
        authorRole: role,
        createdAt: Date.now(),
      },
    })
    await db.collection('moment_likes').add({
      data: { coupleId, momentId: mid, openid, role, createdAt: Date.now() },
    })
  }

  let rantCount = 0
  for (let r = 0; r < 5; r++) {
    try {
      await db.collection('rants').add({
        data: {
          coupleId,
          content: `【演示吐槽 #${r + 1}】今天也要开心呀`,
          images: [],
          authorOpenid: openid,
          authorRole: role,
          createdAt: Date.now() - r * 600000,
        },
      })
      rantCount++
    } catch (e) {
      console.warn('seed rants', e.message)
      break
    }
  }

  let noteCount = 0
  if (couple.memberB) {
    try {
      await db.collection('notes').add({
        data: {
          coupleId,
          content: '演示小纸条：晚安',
          fromRole: role,
          toRole: partnerRole,
          readAt: null,
          createdAt: Date.now(),
        },
      })
      noteCount = 1
    } catch (e) {
      console.warn('seed notes', e.message)
    }
  }

  if (couple.memberB && streakDays > 0) {
    await insertCheckinSystemMoment(coupleId, todayKey(), streakDays)
  }

  const demoPet = defaultPetData('小紫', 'cat')
  demoPet.exp = 120
  demoPet.happiness = 88
  demoPet.lastFedDate = todayKey()
  await db.collection('couples').doc(coupleId).update({ data: { pet: demoPet } })

  return {
    moments: momentCount,
    checkins: checkinCount,
    streakDays,
    anniversaries: annCount,
    rants: rantCount,
    notes: noteCount,
  }
}

async function clearAll(openid, payload = {}) {
  const { coupleId } = payload
  const { couple, role } = await requireMember(openid, coupleId)
  if (role !== 'A') throw new Error('仅创建者可清空空间')

  const moments = await db.collection('moments').where({ coupleId }).get()
  const allFileIDs = []
  for (const m of moments.data) {
    allFileIDs.push(...collectMomentFileIDs(m))
    await db.collection('moments').doc(m._id).remove()
  }
  await deleteCloudFiles([...new Set(allFileIDs)])
  const checkins = await db.collection('checkins').where({ coupleId }).get()
  for (const c of checkins.data) {
    await db.collection('checkins').doc(c._id).remove()
  }
  await wipeCoupleV02(coupleId)
  await db.collection('couples').doc(couple._id).remove()
  return { ok: true }
}

exports.main = async (event) => {
  const { action, payload = {} } = event
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) {
    return { ok: false, error: '未获取到 openid，请用真机或开发者工具登录' }
  }

  try {
    let data
    switch (action) {
      case 'bootstrap':
        data = await bootstrap(openid, payload)
        break
      case 'createCouple':
        data = await createCouple(openid, payload)
        break
      case 'joinCouple':
        data = await joinCouple(openid, payload)
        break
      case 'updateStartDate':
        data = await updateStartDate(openid, payload)
        break
      case 'updateProfile':
        data = await updateProfile(openid, payload)
        break
      case 'listMoments':
        data = await listMoments(openid, payload)
        break
      case 'searchMoments':
        data = await searchMoments(openid, payload)
        break
      case 'getOnThisDay':
        data = await getOnThisDay(openid, payload)
        break
      case 'getMomentsStats':
        data = await getMomentsStats(openid, payload)
        break
      case 'listMomentCollections':
        data = await listMomentCollections(openid, payload)
        break
      case 'getMomentNeighbors':
        data = await getMomentNeighbors(openid, payload)
        break
      case 'getMomentsBriefStats':
        data = await getMomentsBriefStats(openid, payload)
        break
      case 'getMoment':
        data = await getMoment(openid, payload)
        break
      case 'addMoment':
        data = await addMoment(openid, payload)
        break
      case 'deleteMoment':
        data = await deleteMoment(openid, payload)
        break
      case 'listCheckins':
        data = await listCheckins(openid, payload)
        break
      case 'seedDemoData':
        data = await seedDemoData(openid, payload)
        break
      case 'addCheckin':
        data = await addCheckin(openid, payload)
        break
      case 'getCheckinState':
        data = await getCheckinState(openid, payload)
        break
      case 'getPet':
        data = await getPet(openid, payload)
        break
      case 'adoptPet':
        data = await adoptPet(openid, payload)
        break
      case 'petInteract':
        data = await petInteract(openid, payload)
        break
      case 'clearAll':
        data = await clearAll(openid, payload)
        break
      case 'listAnniversaries':
        data = await listAnniversaries(openid, payload)
        break
      case 'addAnniversary':
        data = await addAnniversary(openid, payload)
        break
      case 'deleteAnniversary':
        data = await deleteAnniversary(openid, payload)
        break
      case 'getNextAnniversary':
        data = await getNextAnniversary(openid, payload)
        break
      case 'listRants':
        data = await listRants(openid, payload)
        break
      case 'addRant':
        data = await addRant(openid, payload)
        break
      case 'deleteRant':
        data = await deleteRant(openid, payload)
        break
      case 'listNotes':
        data = await listNotes(openid, payload)
        break
      case 'sendNote':
        data = await sendNote(openid, payload)
        break
      case 'markNoteRead':
        data = await markNoteRead(openid, payload)
        break
      case 'listComments':
        data = await listComments(openid, payload)
        break
      case 'addComment':
        data = await addComment(openid, payload)
        break
      case 'deleteComment':
        data = await deleteComment(openid, payload)
        break
      case 'getMomentLikes':
        data = await getMomentLikes(openid, payload)
        break
      case 'toggleMomentLike':
        data = await toggleMomentLike(openid, payload)
        break
      case 'listMapPlaces':
        data = await listMapPlaces(openid, payload)
        break
      default:
        return { ok: false, error: `未知 action: ${action}` }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}
