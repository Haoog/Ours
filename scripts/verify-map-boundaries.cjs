const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/ours/index.js'), 'utf8')
const coupleId = 'space'
const owner = 'owner'
const latitude = -31.28125
const longitude = 121.1234
const locationKey = '-31.2813,121.1234'

function post(id, lat, lon, fields = {}) {
  return {
    _id: id, coupleId, kind: 'post', momentDate: '2024-10-12', createdAt: 1728720000000,
    location: { latitude: lat, longitude: lon, name: 'Park', address: '上海市' },
    ...fields,
  }
}

const command = test => ({ test, and: other => command(value => test(value) && other.test(value)) })
const numberOrString = (bound, compare) => command(value => typeof value === typeof bound && compare(value, bound))

function matches(row, where) {
  if (where.and) return where.and.every(part => matches(row, part))
  if (where.or) return where.or.some(part => matches(row, part))
  return Object.entries(where).every(([key, expected]) => {
    const value = key.split('.').reduce((data, part) => data?.[part], row)
    return expected?.test ? expected.test(value) : value === expected
  })
}

function loadCloud(moments, comments = [], { likes = [], failRead, sign } = {}) {
  const records = {
    couples: [{ _id: coupleId, memberA: { openid: owner }, momentOrderVersion: 2 }],
    moments,
    moment_comments: comments,
    moment_likes: likes,
  }
  const queries = []
  const db = {
    command: {
      and: parts => ({ and: parts }),
      or: parts => ({ or: parts }),
      exists: expected => command(value => (value !== undefined) === expected),
      gt: bound => numberOrString(bound, (a, b) => a > b),
      gte: bound => numberOrString(bound, (a, b) => a >= b),
      lt: bound => numberOrString(bound, (a, b) => a < b),
      lte: bound => numberOrString(bound, (a, b) => a <= b),
      in: values => command(value => values.includes(value)),
      set: value => value,
    },
    RegExp: ({ regexp, options }) => command(value => new RegExp(regexp, options).test(value)),
    collection(name) {
      assert.ok(Object.hasOwn(records, name), name)
      function query(where, order = [], skip = 0, limit = 100, fields = null) {
        function filtered() {
          return records[name].filter(row => matches(row, where))
        }
        return {
          orderBy: (field, direction) => query(where, [...order, [field, direction]], skip, limit, fields),
          skip: offset => query(where, order, offset, limit, fields),
          limit: size => query(where, order, skip, size, fields),
          field: selected => query(where, order, skip, limit, selected),
          async count() {
            queries.push({ name, type: 'count' })
            return { total: filtered().length }
          },
          async get() {
            assert.ok(limit > 0 && limit <= 100)
            const data = filtered().sort((left, right) => {
              for (const [field, direction] of order) {
                if (left[field] === right[field]) continue
                return (left[field] < right[field] ? -1 : 1) * (direction === 'asc' ? 1 : -1)
              }
              return 0
            }).slice(skip, skip + limit)
            const projected = fields ? data.map(row => Object.fromEntries(Object.keys(fields).map(key => [key, row[key]]))) : data
            queries.push({ name, type: 'get', skip, limit, ids: data.map(row => row._id), bytes: Buffer.byteLength(JSON.stringify(projected)) })
            await failRead?.(name, data)
            return { data: structuredClone(projected) }
          },
        }
      }
      return {
        where: query,
        doc(id) {
          const row = records[name].find(doc => doc._id === id)
          return {
            async get() { return { data: structuredClone(row) } },
            async update({ data }) { Object.assign(row, structuredClone(data)) },
          }
        },
      }
    },
    runTransaction: run => run(db),
  }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: owner }), getTempFileURL: sign }
  const context = { exports: {}, console, require: id => id === 'wx-server-sdk' ? cloud : require(id) }
  vm.runInNewContext(source, context, { filename: 'cloudfunctions/ours/index.js' })
  const invoke = (action, options) => context.exports.main({ action, payload: { coupleId, ...options } })
  return {
    queries,
    invoke,
    async call(action, options) {
      const result = await invoke(action, options)
      assert.equal(result.ok, true, result.error)
      return structuredClone(result.data)
    },
  }
}

function adjacent(value, direction) {
  if (value === 0) return direction * Number.MIN_VALUE
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(value)
  bytes.writeBigUInt64BE(bytes.readBigUInt64BE() + BigInt(direction * Math.sign(value)))
  return bytes.readDoubleBE()
}

function sortedIds(rows) {
  return [...rows].sort((a, b) => b.momentDate.localeCompare(a.momentDate) || b.createdAt - a.createdAt || b._id.localeCompare(a._id))
    .map(row => row._id)
}

function verifyPage(page, expected, skip, limit) {
  const ids = expected.slice(skip, skip + limit)
  assert.deepEqual(page.items.map(item => item.id), ids)
  assert.equal(page.total, expected.length)
  assert.equal(page.hasMore, skip + ids.length < expected.length)
}

async function verifyReportedCase() {
  const { call } = loadCloud([post('reported', latitude, longitude)])
  const { places } = await call('listMapPlaces')
  assert.deepEqual(places.map(place => [place.id, place.momentCount]), [[locationKey, 1]])
  verifyPage(await call('listMoments', { locationKey }), ['reported'], 0, 20)
  console.log('PASS: reported -31.28125,121.1234 position opens the original map ID and returns one post')
}

async function verifyAdjacentBuckets() {
  const coordinates = [
    ...[-31.28125, 31.28125].flatMap(lat => [-1, 0, 1].map(step => [step ? adjacent(lat, step) : lat, longitude])),
    ...[-121.12345, 121.12345].flatMap(lon => [-1, 0, 1].map(step => [30, step ? adjacent(lon, step) : lon])),
    ...[-0.00005, 0.00005].flatMap(edge => [-1, 0, 1].map(step => {
      const value = step ? adjacent(edge, step) : edge
      return [value, value]
    })),
    [-0, -0], [-Number.MIN_VALUE, Number.MIN_VALUE], [Number.MIN_VALUE, -Number.MIN_VALUE],
    [-90, -180], [90, 180], ['-31.28125', '121.1234'], [latitude, '121.1234'],
  ]
  const rows = coordinates.map(([lat, lon], index) => post(`boundary-${String(index).padStart(2, '0')}`, lat, lon))
  const { call, invoke } = loadCloud([
    ...rows,
    post('system', latitude, longitude, { kind: 'system' }),
    post('other-space', latitude, longitude, { coupleId: 'other' }),
    post('unknown-kind', latitude, longitude, { kind: 'unknown' }),
    post('missing', undefined, longitude), post('null', null, longitude),
    post('not-a-number', 'invalid', longitude), post('too-large', adjacent(90, 1), 180),
  ])
  const expected = new Map()
  for (const row of rows) {
    const loc = row.location
    const id = `${Number(loc.latitude).toFixed(4)},${Number(loc.longitude).toFixed(4)}`
    if (!expected.has(id)) expected.set(id, [])
    expected.get(id).push(row)
  }
  const { places, cities } = await call('listMapPlaces')
  assert.equal(places.length, expected.size)
  assert.deepEqual(cities, [{ name: '上海市', count: rows.length }])
  assert.ok(places.some(place => place.id === '-0.0000,0.0000'))
  assert.ok(places.some(place => place.id === '0.0000,-0.0000'))
  for (const place of places) {
    const ids = sortedIds(expected.get(place.id))
    assert.equal(place.momentCount, ids.length, place.id)
    assert.equal(place.latestMomentId, ids[0], place.id)
    verifyPage(await call('listMoments', { locationKey: place.id }), ids, 0, 20)
  }
  verifyPage(await call('listMoments', { locationKey: ' -31.2813 , 121.12340 ' }), sortedIds(expected.get(locationKey)), 0, 20)
  for (const key of ['31,', '31,180.0001', '91,121', '31,121,0', 'NaN,121']) {
    const result = await invoke('listMoments', { locationKey: key })
    assert.equal(result.ok, false)
    assert.equal(result.error, '地点无效')
  }
  console.log('PASS: positive and negative ties, adjacent binary doubles, signed zero, limits and legacy coordinate strings')
}

async function verifyPagination() {
  const rows = Array.from({ length: 226 }, (_, index) => {
    const lat = index % 2 ? latitude : adjacent(latitude, 1)
    const row = post(`page-${String(index).padStart(3, '0')}`, index % 7 === 0 ? String(lat) : lat, longitude, {
      momentDate: index % 3 === 0 ? '2024-10-12' : '2024-09-12',
      createdAt: 1728720000000 + index % 5,
      tag: index % 5 === 0 ? 'daily' : 'travel',
      content: index % 7 === 0 ? 'A+B' : 'AAB',
      voices: index % 11 < 8 ? [{ fileID: 'voice', duration: 2 }] : [],
    })
    row.location.name = index % 13 < 10 ? 'Park' : 'Beach'
    return row
  })
  const matching = rows.filter((_, index) => index % 2 === 1)
  const ids = sortedIds(matching)
  const { call, queries } = loadCloud([...rows, post('no-coordinates', undefined, longitude)], [
    { _id: 'visible-comment', coupleId, momentId: ids[0] },
    { _id: 'later-comment', coupleId, momentId: ids[50] },
  ])
  const { places } = await call('listMapPlaces')
  const place = places.find(item => item.id === locationKey)
  assert.equal(place.momentCount, 113)
  assert.equal(place.latestMomentId, ids[0])
  queries.length = 0
  const firstPage = await call('listMoments', { locationKey, limit: 50 })
  verifyPage(firstPage, ids, 0, 50)
  assert.deepEqual(queries.filter(query => query.name === 'moments').map(({ type, skip, limit }) => [type, skip, limit]), [
    ['get', 0, 100], ['get', 100, 100], ['get', 200, 100],
  ])
  assert.equal(firstPage.items[0].commentCount, 1)
  assert.deepEqual(queries.filter(query => query.name === 'moment_comments').flatMap(query => query.ids), ['visible-comment'])
  for (const skip of [50, 100, 112, 113, 1000]) {
    verifyPage(await call('listMoments', { locationKey, skip, limit: 50 }), ids, skip, 50)
  }
  const combined = {
    locationKey, locationName: 'Park', year: 2024, month: 10, tag: 'travel', mediaFilter: 'voice', keyword: 'a+b',
  }
  const filtered = sortedIds(matching.filter(row => row.location.name === 'Park' && row.momentDate.startsWith('2024-10') &&
    row.tag === 'travel' && row.voices.length && row.content === 'A+B'))
  assert.ok(filtered.length > 1)
  verifyPage(await call('searchMoments', { ...combined, limit: 1 }), filtered, 0, 1)
  const cursorRequested = await call('searchMoments', { ...combined, limit: 1, cursor: null })
  verifyPage(cursorRequested, filtered, 0, 1)
  assert.equal(Object.hasOwn(cursorRequested, 'nextCursor'), false)
  verifyPage(await call('searchMoments', { ...combined, skip: 1, limit: 1 }), filtered, 1, 1)
  verifyPage(await call('searchMoments', { ...combined, skip: filtered.length, limit: 1 }), filtered, filtered.length, 1)
  verifyPage(await call('listMoments', { limit: 3 }), sortedIds([...rows, post('no-coordinates', undefined, longitude)]), 0, 3)
  console.log('PASS: 113 posts over three database batches, post-filter totals and offsets, tied order and combined filters')
}

async function verifyListEnrichment() {
  const cover = 'cloud://env/cover'
  const moment = post('enriched', latitude, longitude, { images: [cover] })
  const comments = Array.from({ length: 101 }, (_, index) => ({
    _id: String(index).padStart(3, '0'), coupleId, momentId: moment._id, content: '往'.repeat(400),
  }))
  const likes = [{ _id: 'like', coupleId, momentId: moment._id, role: 'A' }]
  let startSigning
  let allowComments
  const signingStarted = new Promise(resolve => { startSigning = resolve })
  const commentsMayFinish = new Promise(resolve => { allowComments = resolve })
  const { call, queries } = loadCloud([moment], comments, {
    likes,
    failRead: name => name === 'moment_comments' ? commentsMayFinish : undefined,
    sign({ fileList }) {
      startSigning()
      return { fileList: Array.from(fileList, fileID => ({ fileID, status: 0, tempFileURL: 'https://example.test/cover' })) }
    },
  })
  const pending = call('listMoments', { cursor: null })
  const startedBeforeComments = await Promise.race([signingStarted.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))])
  allowComments()
  const result = await pending
  assert.equal(startedBeforeComments, true, 'cover signing should overlap comment reads')
  const [{ commentCount, likeCount, likedByMe, coverUrl }] = result.items
  assert.deepEqual({ commentCount, likeCount, likedByMe, coverUrl }, { commentCount: 101, likeCount: 1, likedByMe: true, coverUrl: 'https://example.test/cover' })
  const fullBytes = Buffer.byteLength(JSON.stringify(comments))
  const projectedBytes = queries.filter(query => query.name === 'moment_comments').reduce((sum, query) => sum + query.bytes, 0)
  assert.ok(projectedBytes < fullBytes * 0.1, `comment payload ${projectedBytes}/${fullBytes} bytes`)

  const failing = loadCloud([moment], comments, { likes, failRead(name) {
    if (name === 'moment_comments') throw new Error('mock comments unavailable')
  }, sign() { return { fileList: [] } } })
  const [kept] = (await failing.call('listMoments', {})).items
  assert.equal(kept.likeCount, 1)
  assert.equal(kept.likedByMe, true)
  console.log(`PASS: cover signing overlaps reads, independent counts, comment rows ${fullBytes} -> ${projectedBytes} bytes`)
}

async function main() {
  await verifyReportedCase()
  await verifyAdjacentBuckets()
  await verifyPagination()
  await verifyListEnrichment()
}

module.exports = { loadCloud, post }

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
