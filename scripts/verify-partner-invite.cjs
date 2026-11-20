const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const pageSource = ts.transpileModule(fs.readFileSync(path.join(root, 'miniprogram/pages/bind/bind.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const serverSource = fs.readFileSync(path.join(root, 'cloudfunctions/ours/index.js'), 'utf8')
const week = 7 * 24 * 60 * 60 * 1000
const fallbackPath = '/pages/setup/setup'

function harness() {
  let now = Date.UTC(2026, 0, 1)
  const date = { now: () => now }
  const storage = new Map()
  const collections = new Map()
  const command = { or: parts => ({ parts }), set: value => value }
  const db = {
    command,
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map())
      const records = collections.get(name)
      return {
        where(filter) {
          const matches = row => (filter.parts || [filter]).some(part =>
            Object.entries(part).every(([key, expected]) =>
              key.split('.').reduce((value, field) => value?.[field], row) === expected))
          return { limit: count => ({ get: async () => ({ data: [...records.values()].filter(matches).slice(0, count).map(row => structuredClone(row)) }) }) }
        },
        doc(id) {
          return {
            get: async () => ({ data: structuredClone(records.get(id)) }),
            set: async ({ data }) => records.set(id, { ...structuredClone(data), _id: id }),
            update: async ({ data }) => Object.assign(records.get(id), structuredClone(data)),
          }
        },
      }
    },
    runTransaction: callback => callback(db),
  }
  let caller
  const sdk = { init() {}, database: () => db, getWXContext: () => ({ OPENID: caller }) }
  const exports = {}
  vm.runInNewContext(serverSource, {
    exports, Date: date, process: { env: {} }, console,
    require: id => id === 'wx-server-sdk' ? sdk : require(id),
  })
  async function callAs(openid, action, payload) {
    caller = openid
    const result = await exports.main({ action, payload })
    if (!result.ok) throw new Error(result.error)
    return result.data
  }

  const createOnServer = (openid, coupleId) => callAs(openid, 'createPartnerInvite', { coupleId })
  const openCard = (openid, card) => callAs(openid, 'bootstrap', {
    inviteToken: new URL(card, 'https://offline.test').searchParams.get('inviteToken'),
  })
  const addSpace = (id, openid) => db.collection('couples').doc(id).set({ data: {
    startDate: '2026-01-01', memberA: { openid, nickname: 'A' }, memberB: null,
  } })

  const state = { createCalls: 0, online: true, storageWritable: true, deliver: invite => invite }
  const timers = new Map()
  function runtime() {
    let session
    let modal
    const wx = {
      getStorageSync: key => structuredClone(storage.get(key)),
      setStorageSync(key, value) {
        if (!state.storageWritable) throw new Error('storage unavailable')
        storage.set(key, structuredClone(value))
      },
      removeStorageSync: key => storage.delete(key),
      showModal: options => { modal = options },
      showToast() {},
    }
    const modules = {
      '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
      '../../services/theme': { getThemeStyle: () => '', syncTheme() {} },
      '../../services/page-boot': { ensureCloudReady: async () => state.online },
      '../../services/session': { getSession: () => session },
      '../../services/store': {
        getCouple: () => session.couple,
        getRelationshipMembers: () => ({ me: session.couple.memberA, partner: session.couple.memberB }),
        createPartnerInvite: async () => {
          state.createCalls++
          return state.deliver(await createOnServer(session.openid, session.coupleId))
        },
      },
    }
    let definition
    vm.runInNewContext(pageSource, {
      require: id => modules[id] || {}, exports: {}, wx, Date: date, Page: options => { definition = options },
      setTimeout: (callback, delay) => {
        const id = Symbol()
        timers.set(id, { callback, at: now + delay })
        return id
      },
      clearTimeout: id => timers.delete(id),
    })
    return {
      async signIn(openid) {
        session = await callAs(openid, 'bootstrap', {})
        session.coupleId = session.couple?.id
      },
      switchScope(openid, coupleId) {
        session = {
          ...session, openid, coupleId,
          couple: { ...session.couple, id: coupleId, memberA: { ...session.couple.memberA, openid } },
        }
      },
      async open() {
        const page = { ...definition, data: structuredClone(definition.data) }
        page.setData = patch => Object.assign(page.data, patch)
        await page.onLoad?.()
        return { page, shown: page.onShow?.() }
      },
      confirm(page, confirm = true) {
        page.onGenerateInvite()
        assert(modal, 'The generate button must ask for confirmation')
        const options = modal
        modal = null
        const result = options.success({ confirm })
        options.complete?.()
        return result
      },
    }
  }
  function advance(ms) {
    now += ms
    for (const [id, entry] of timers) {
      if (entry.at > now) continue
      timers.delete(id)
      entry.callback()
    }
  }
  return { addSpace, advance, createOnServer, openCard, runtime, state, storage }
}

const share = page => page.onShareAppMessage().path

async function verifyReopenAndJoin() {
  const test = harness()
  await test.addSpace('space', 'owner')
  const legacyInvite = await test.createOnServer('owner', 'space')
  const firstRuntime = test.runtime()
  await firstRuntime.signIn('owner')
  const { page, shown } = await firstRuntime.open()
  await shown
  assert.equal(test.state.createCalls, 0, 'Opening with an empty cache must leave existing cards alone')
  await firstRuntime.confirm(page, false)
  assert.equal(test.state.createCalls, 0, 'Cancelling must not create an invitation')
  const legacyCard = `/pages/home/home?inviteToken=${legacyInvite.token}`
  assert.equal((await test.openCard('guest', legacyCard)).role, 'B')
  page.onUnload()

  await test.addSpace('other-space', 'other-owner')
  await firstRuntime.signIn('other-owner')
  const original = await firstRuntime.open()
  await original.shown
  await firstRuntime.confirm(original.page)
  assert.equal(original.page.data.inviteReady, true)
  const oldCard = share(original.page)
  assert(oldCard.startsWith('/pages/home/home?inviteToken='))
  original.page.onUnload()
  test.advance(week - 1)

  for (const runtime of [firstRuntime, test.runtime()]) {
    await runtime.signIn('other-owner')
    const reopened = await runtime.open()
    await reopened.shown
    assert(share(reopened.page) === oldCard, 'Reopening must share the same card, including after restart')
    reopened.page.onUnload()
  }
  assert.equal(test.state.createCalls, 1)
  const joined = await test.openCard('new-guest', oldCard)
  assert.equal(joined.role, 'B')
  assert.equal(joined.couple.id, 'other-space')
  await firstRuntime.signIn('other-owner')
  const bound = await firstRuntime.open()
  await bound.shown
  assert.equal(bound.page.data.inviteAvailable, false)
  assert.equal(share(bound.page), fallbackPath)
}

async function verifyRotationAndExpiry() {
  const test = harness()
  await test.addSpace('space', 'owner')
  const runtime = test.runtime()
  await runtime.signIn('owner')
  const { page, shown } = await runtime.open()
  await shown
  await runtime.confirm(page)
  const firstCard = share(page)
  // A different client can replace the server invite without updating this device's cache.
  await test.createOnServer('owner', 'space')
  await page.onShow()
  assert(share(page) === firstCard, 'Opening must not perform an implicit replacement')
  await assert.rejects(() => test.openCard('guest', firstCard), /已失效/)
  await runtime.confirm(page)
  const secondCard = share(page)
  assert(secondCard !== firstCard && secondCard !== fallbackPath)
  const [[key, expiredEntry]] = test.storage
  test.advance(week)
  assert.equal(page.data.inviteReady, false, 'An open page must stop offering a card at expiry')
  assert.equal(share(page), fallbackPath)

  // When the app is closed at expiry, disk can still contain the old entry.
  test.storage.set(key, expiredEntry)
  const coldRuntime = test.runtime()
  await coldRuntime.signIn('owner')
  const reopened = await coldRuntime.open()
  await reopened.shown
  assert.equal(share(reopened.page), fallbackPath)
  assert.equal(test.storage.size, 0)
  assert.equal(test.state.createCalls, 2, 'Expiry must not trigger an automatic request')
  await assert.rejects(() => test.openCard('guest', secondCard), /已失效|已过期/)
  await runtime.confirm(page)
  assert.equal((await test.openCard('guest', share(page))).couple.id, 'space')
}

async function verifyConcurrencyAndRecovery() {
  const test = harness()
  await test.addSpace('space', 'owner')
  await test.addSpace('other-space', 'other-owner')
  const runtime = test.runtime()
  await runtime.signIn('owner')
  const { page, shown } = await runtime.open()
  await shown
  let release
  const delayed = new Promise(resolve => { release = resolve })
  test.state.deliver = invite => delayed.then(() => invite)
  const sibling = await runtime.open()
  await sibling.shown
  const generating = runtime.confirm(page)
  const concurrent = runtime.confirm(sibling.page)
  assert.equal(test.state.createCalls, 1, 'Concurrent pages must share the same creation request')
  page.onUnload()
  sibling.page.onUnload()
  const reopened = await runtime.open()
  assert.equal(share(reopened.page), fallbackPath)
  release()
  await Promise.all([generating, concurrent, reopened.shown])
  assert.equal(test.state.createCalls, 1)
  const originalCard = share(reopened.page)
  assert(originalCard !== fallbackPath)

  // Simulate a committed rotation whose result was lost in transit.
  test.state.deliver = () => { throw new Error('response lost') }
  await runtime.confirm(reopened.page)
  assert(reopened.page.data.inviteError, 'A lost response must leave a visible retry state')
  assert.equal(share(reopened.page), fallbackPath)
  assert.equal(test.storage.size, 0)
  test.state.deliver = invite => invite
  test.state.storageWritable = false
  await runtime.confirm(reopened.page)
  const recoveredCard = share(reopened.page)
  assert(recoveredCard !== fallbackPath)
  await reopened.page.onShow()
  assert(share(reopened.page) === recoveredCard, 'Memory must retain the latest invite if storage is unavailable')

  runtime.switchScope('other-owner', 'space')
  assert.equal(share(reopened.page), fallbackPath, 'An existing page must stop sharing after an account change')
  await reopened.page.onShow()
  assert.equal(share(reopened.page), fallbackPath)
  runtime.switchScope('owner', 'other-space')
  await reopened.page.onShow()
  assert.equal(share(reopened.page), fallbackPath, 'The same account in another space must not reuse the card')
  test.state.online = false
  await reopened.page.onShow()
  assert(reopened.page.data.inviteError)
  test.state.online = true
  await reopened.page.refreshInvite()
  assert.equal(reopened.page.data.inviteAvailable, true)
}

async function main() {
  await verifyReopenAndJoin()
  await verifyRotationAndExpiry()
  await verifyConcurrencyAndRecovery()
  console.log('Partner invite verification passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
