const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.join(__dirname, '../miniprogram')
const sources = new Map()
const turn = () => new Promise(resolve => setImmediate(resolve))
const original = {
  id: 'space', startDate: '2026-01-01',
  memberA: { openid: 'a', nickname: '原昵称', avatarUrl: 'cloud://old-avatar' },
  memberB: null,
}
const offline = new Error('fixture offline')

function runtime(initial = original) {
  let server = structuredClone(initial)
  let loadedPage
  const native = { modal: [], sheet: [], image: [], upload: [], tab: [], relaunch: [], toast: [], timer: [] }
  const requests = []
  const storage = new Map(initial ? [['OURS_SESSION_V1', {
    status: 'ready', openid: 'a', role: 'A', coupleId: initial.id, couple: structuredClone(initial),
  }]] : [])
  const state = { offline: false, avatarOffline: false, uploadOffline: false, write: async () => {} }
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 720 }),
    showModal: options => native.modal.push(options),
    showActionSheet: options => native.sheet.push(options),
    chooseImage: options => native.image.push(options),
    showToast: options => native.toast.push(options.title),
    showLoading() {}, hideLoading() {}, stopPullDownRefresh() {},
    switchTab: options => native.tab.push(options),
    reLaunch: options => native.relaunch.push(options.url),
    cloud: {
      uploadFile(options) {
        native.upload.push(options.filePath)
        if (state.uploadOffline) options.fail(offline)
        else options.success({ fileID: 'cloud://new-avatar' })
      },
    },
  }
  const mocks = {
    'app.ts': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    'services/theme.ts': { getThemeStyle: () => '', getThemeId: () => 'lavender', syncTheme() {} },
    'services/upload-cleanup.ts': {},
    'utils/cloud-url-cache.ts': {
      async resolveCloudUrl(file) { return state.avatarOffline ? '' : `/display/${file.slice(8)}` },
    },
    'services/cloud-api.ts': {
      async callOurs(action, payload) {
        requests.push({ action, payload })
        if (state.offline) throw offline
        if (action === 'bootstrap') return server
          ? { status: 'ready', openid: 'a', role: 'A', couple: structuredClone(server) }
          : { status: 'needsInviteCode', openid: 'a' }
        if (action === 'listMoments') return []
        if (action === 'getNextAnniversary') return null
        if (action === 'createPartnerInvite') return { token: 'fixture-token', expiresAt: Date.now() + 60000 }
        if (action === 'redeemAccessCode') {
          if (payload.code === 'OURS-EXPIRED') throw new Error('邀请码已过期')
          server = { ...structuredClone(original), startDate: payload.startDate }
          return structuredClone(server)
        }
        if (action === 'updateProfile') {
          await state.write(payload)
          const { coupleId, ...fields } = payload
          assert.equal(coupleId, server.id)
          Object.assign(server.memberA, fields)
          return structuredClone(server)
        }
        if (action === 'updateStartDate') {
          server.startDate = payload.startDate
          return structuredClone(server)
        }
        throw new Error(`Unexpected local API action: ${action}`)
      },
    },
  }
  const context = vm.createContext({
    wx, Error, console, Page: definition => { loadedPage = definition },
    setTimeout: fn => native.timer.push(fn), clearTimeout() {},
  })
  const modules = new Map()
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative]
    if (modules.has(relative)) return modules.get(relative)
    let script = sources.get(relative)
    if (!script) {
      const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText
      script = new vm.Script(`(function(exports, require) {\n${code}\n})`, { filename: relative })
      sources.set(relative, script)
    }
    const exports = {}
    modules.set(relative, exports)
    script.runInContext(context)(exports, id => load(path.join(path.dirname(relative), `${id}.ts`)))
    return exports
  }
  return {
    state, native, requests, server: () => server,
    setServer: couple => { server = structuredClone(couple) },
    page(name) {
      load(`pages/${name}/${name}.ts`)
      const page = loadedPage
      page.setData = patch => Object.assign(page.data, patch)
      page.dispatch = (method, event) => {
        const wxml = fs.readFileSync(path.join(root, `pages/${name}/${name}.wxml`), 'utf8')
        assert.match(wxml, new RegExp(`(?:bind|catch)[-:\\w]*="${method}"`), `${method} must be bound in ${name}.wxml`)
        return page[method](event)
      }
      return page
    },
  }
}

const avatarTap = { currentTarget: { dataset: { slot: 'A' } } }
const confirmName = { confirm: true, content: '新昵称' }

function selectAvatar(run) {
  run.native.sheet.at(-1).success({ tapIndex: 0 })
  run.native.image.at(-1).success({ tempFilePaths: ['/selected.jpg'] })
}

const cases = {
  async 'profile-offline'() {
    const run = runtime()
    const page = run.page('profile')
    run.state.offline = run.state.avatarOffline = true
    await page.onShow()
    assert.equal(page.data.youName, '原昵称')
    assert.ok(page.data.profileError)
    run.state.offline = false
    await page.dispatch('onRetryProfile')
    assert.match(page.data.profileError, /头像/)
    run.state.avatarOffline = false
    await page.dispatch('onRetryProfile')
    assert.equal(page.data.profileError, '')
    assert.equal(page.data.youAvatarSrc, '/display/old-avatar')
  },

  async 'avatar-retry'() {
    const run = runtime()
    const page = run.page('profile')
    await page.onShow()
    run.state.uploadOffline = true
    page.dispatch('onTapAvatar', avatarTap)
    selectAvatar(run)
    await turn()
    assert.equal(page.data.avatarRetry, true)
    run.state.uploadOffline = false
    run.state.offline = true
    await page.dispatch('onRetryAvatar')
    assert.equal(page.data.avatarRetry, true)
    run.state.offline = false
    await page.dispatch('onRetryAvatar')
    assert.equal(page.data.avatarRetry, false)
    assert.equal(page.data.youAvatarSrc, '/display/new-avatar')
    assert.deepEqual(run.native.upload, ['/selected.jpg', '/selected.jpg'])
    assert.equal(run.native.image.length, 1)
  },

  async 'profile-native'() {
    const run = runtime()
    const page = run.page('profile')
    await page.onShow()
    page.dispatch('onEditNickname')
    page.dispatch('onPickStartDate', { detail: { value: '2026-02-10' } })
    page.dispatch('onTapAvatar', avatarTap)
    run.native.sheet[0].success({ tapIndex: 0 })
    page.onHide?.()
    await page.onShow()
    await run.native.modal[0].success(confirmName)
    await run.native.modal[1].success({ confirm: true })
    run.native.image[0].success({ tempFilePaths: ['/stale.jpg'] })
    await turn()
    assert.equal(run.requests.filter(({ action }) => action.startsWith('update')).length, 0)
    assert.deepEqual(run.native.upload, [])
    page.dispatch('onEditNickname')
    await run.native.modal.at(-1).success(confirmName)
    assert.equal(run.server().memberA.nickname, '新昵称')
  },

  async 'profile-fields'() {
    const run = runtime()
    const page = run.page('profile')
    await page.onShow()
    let unblockNickname
    let unblockAvatar
    const nicknameDelay = new Promise(resolve => { unblockNickname = resolve })
    const avatarDelay = new Promise(resolve => { unblockAvatar = resolve })
    run.state.write = payload => payload.avatarUrl ? avatarDelay : nicknameDelay
    page.dispatch('onEditNickname')
    const nickname = run.native.modal[0].success(confirmName)
    page.dispatch('onTapAvatar', avatarTap)
    selectAvatar(run)
    await turn()
    unblockNickname()
    await nickname
    unblockAvatar()
    await turn()
    assert.equal(run.server().memberA.nickname, '新昵称')
    assert.equal(run.server().memberA.avatarUrl, 'cloud://new-avatar')
    assert.equal(page.data.youName, '新昵称')
    assert.equal(page.data.youAvatarSrc, '/display/new-avatar')
  },

  async 'bind-native'() {
    const run = runtime()
    const page = run.page('bind')
    await page.onShow()
    page.dispatch('onGenerateInvite')
    const old = run.native.modal[0]
    page.onHide()
    await page.onShow()
    page.dispatch('onGenerateInvite')
    assert.equal(run.native.modal.length, 2)
    await old.success({ confirm: true })
    old.complete()
    assert.equal(run.requests.filter(({ action }) => action === 'createPartnerInvite').length, 0)
    page.dispatch('onGenerateInvite')
    assert.equal(run.native.modal.length, 2)
    await run.native.modal[1].success({ confirm: true })
    run.native.modal[1].complete()
    assert.match(page.onShareAppMessage().path, /inviteToken=fixture-token$/)
  },

  async 'home-return'() {
    const run = runtime()
    const page = run.page('home')
    await page.onLoad({})
    await page.onShow()
    page.onHide()
    run.server().memberB = { openid: 'b', nickname: '乙', avatarUrl: '' }
    run.server().startDate = '2026-02-01'
    await page.onShow()
    assert.equal(page.data.bound, true)
    assert.equal(page.data.startDate, '2026-02-01')
    run.server().startDate = '2026-03-01'
    await page.onPullDownRefresh()
    assert.equal(page.data.startDate, '2026-03-01')
    run.server().startDate = '2026-04-01'
    await page.dispatch('onRetryRecent')
    assert.equal(page.data.startDate, '2026-04-01')
  },

  async 'setup-repeat'() {
    const run = runtime(null)
    const page = run.page('setup')
    await page.onLoad()
    page.dispatch('onCodeInput', { detail: { value: 'OURS-TEST-CODE' } })
    await page.dispatch('onSubmit')
    await page.dispatch('onSubmit')
    assert.equal(run.requests.filter(({ action }) => action === 'redeemAccessCode').length, 1)
    assert.equal(run.native.timer.length, 1)
    run.native.timer.shift()()
    run.native.tab[0].fail(new Error('fixture navigation failure'))
    await page.dispatch('onSubmit')
    assert.equal(run.requests.filter(({ action }) => action === 'redeemAccessCode').length, 1)
    assert.equal(run.native.tab.length, 2)
    assert.ok(run.native.tab.every(({ url }) => url === '/pages/home/home'))
  },

  async 'bind-offline-recovery'() {
    const run = runtime(null)
    const page = run.page('bind')
    run.state.offline = true
    await page.onShow()
    assert.equal(page.data.inviteLoading, false)
    assert.match(page.data.inviteError, /重试/)
    run.setServer(original)
    run.state.offline = false
    await page.dispatch('refreshInvite')
    assert.equal(page.data.inviteError, '')
    assert.equal(page.data.inviteAvailable, true)
  },

  async 'setup-expired-recovery'() {
    const run = runtime(null)
    const page = run.page('setup')
    await page.onLoad()
    page.dispatch('onCodeInput', { detail: { value: 'OURS-EXPIRED' } })
    await page.dispatch('onSubmit')
    assert.equal(run.native.toast.at(-1), '邀请码已过期')
    assert.equal(page.data.submitting, false)
    assert.equal(run.native.timer.length, 0)
    page.dispatch('onCodeInput', { detail: { value: 'OURS-VALID' } })
    await page.dispatch('onSubmit')
    assert.equal(run.native.toast.at(-1), '已激活空间')
    assert.equal(run.native.timer.length, 1)
  },
}

async function main() {
  const selected = process.argv.slice(2)
  for (const [name, verify] of Object.entries(cases)) {
    if (selected.length && !selected.includes(name)) continue
    try {
      await verify()
      console.log(`PASS ${name}`)
    } catch (error) {
      console.error(`FAIL ${name}`, error)
      process.exitCode = 1
    }
  }
}

void main()
