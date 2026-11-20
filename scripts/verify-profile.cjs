const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/profile.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

const memberA = { openid: 'a', nickname: '甲', avatarUrl: 'cloud://a' }
const memberB = { openid: 'b', nickname: '乙', avatarUrl: '/b.png' }
const unbound = { id: 'space', startDate: '2026-01-01', memberA, memberB: null }
const paired = { ...unbound, startDate: '2026-02-01', memberB, partnerWechatId: 'partner' }

function sessionFor(couple, role = 'A') {
  return { status: 'ready', openid: couple[`member${role}`].openid, role, couple, coupleId: couple.id }
}

function harness() {
  let server = sessionFor(unbound)
  let session = server
  let page
  let refreshes = 0
  const requests = []
  const writes = []
  let finishAvatarChange
  const modules = {
    '../../app': { getAppInstance: () => ({ waitBoot: async () => {} }) },
    '../../services/session': {
      getSession: () => session,
      async syncSession(force) {
        assert.equal(force, true)
        refreshes++
        session = server
      },
    },
    '../../services/store': {
      getCouple: () => session.couple,
      getIdentity: () => session,
      getRelationshipMembers: () => ({
        me: session.couple[`member${session.role}`],
        partner: session.couple[session.role === 'A' ? 'memberB' : 'memberA'],
      }),
      daysBetween: date => date === paired.startDate ? 10 : 41,
    },
    '../../services/theme': { getThemeStyle: () => '', getThemeId: () => 'lavender', syncTheme() {} },
    '../../utils/avatar': {
      pickLocalAvatar() {
        return new Promise(resolve => { finishAvatarChange = resolve })
      },
    },
    '../../utils/media-url': {
      toDisplayUrl(file) {
        if (!file.startsWith('cloud://')) return Promise.resolve(file)
        return new Promise(resolve => requests.push({ file, resolve }))
      },
    },
  }
  vm.runInNewContext(source, { exports: {}, require: id => modules[id], Page: value => { page = value } })
  page.setData = patch => {
    writes.push({ ...patch })
    Object.assign(page.data, patch)
  }
  return {
    page, requests, writes,
    get refreshes() { return refreshes },
    finishAvatarChange: () => finishAvatarChange('/selected.png'),
    setServer: value => { server = value },
    switchSession: value => { session = server = value },
  }
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

async function startTwoShows(run) {
  const first = run.page.onShow()
  await nextTurn()
  assert.equal(run.requests.length, 1, '第一次进入应在未绑定快照的头像处等待')
  run.page.onHide?.()
  run.setServer(sessionFor(paired))
  const second = run.page.onShow()
  await nextTurn()
  assert.equal(run.refreshes, 2)
  assert.deepEqual(run.requests.map(({ file }) => file), ['cloud://a', 'cloud://a'])
  return { first, second }
}

async function verifyLatestShow() {
  const run = harness()
  const { first, second } = await startTwoShows(run)
  run.requests[1].resolve('/new-a.png')
  await second
  const expected = {
    youName: '甲', themName: '乙', youAvatarSrc: '/new-a.png', themAvatarSrc: '/b.png',
    startDate: '2026-02-01', days: 10, role: 'A', bound: true, partnerWechatId: 'partner',
  }
  for (const [field, value] of Object.entries(expected)) assert.equal(run.page.data[field], value, field)
  const writeCount = run.writes.length
  run.requests[0].resolve('/old-a.png')
  await first
  assert.equal(run.page.data.bound, true, '旧头像结果把已连接覆盖成了待连接')
  assert.equal(run.writes.length, writeCount, '旧请求不得回写任何页面字段')
}

async function verifyUnload() {
  const run = harness()
  const { first, second } = await startTwoShows(run)
  run.page.onUnload()
  const writeCount = run.writes.length
  run.requests[1].resolve('/new-a.png')
  run.requests[0].resolve('/old-a.png')
  await Promise.all([first, second])
  assert.equal(run.writes.length, writeCount, '页面卸载后，最新和旧头像请求均不得回写')

  const beforeBoot = harness()
  const showing = beforeBoot.page.onShow()
  beforeBoot.page.onUnload()
  await showing
  assert.equal(beforeBoot.refreshes, 0, '页面卸载后，启动中的 onShow 不得发起刷新')

  const avatarEdit = harness()
  const avatarPageShown = avatarEdit.page.onShow()
  await nextTurn()
  avatarEdit.requests[0].resolve('/old-a.png')
  await avatarPageShown
  const changingAvatar = avatarEdit.page.onTapAvatar({ currentTarget: { dataset: { slot: 'A' } } })
  avatarEdit.page.onUnload()
  avatarEdit.finishAvatarChange()
  await changingAvatar
  assert.equal(avatarEdit.refreshes, 1, '页面卸载后，换头像回调不得重新发起刷新')
}

async function verifyAccountIsolation() {
  const run = harness()
  const first = run.page.onShow()
  await nextTurn()
  run.switchSession(sessionFor(paired, 'B'))
  run.requests[0].resolve('/old-a.png')
  await first
  assert.equal(run.writes.length, 0, '其他账号的头像和关系快照不得回写')

  const second = run.page.onShow()
  await nextTurn()
  run.requests[1].resolve('/a-as-partner.png')
  await second
  assert.equal(run.page.data.role, 'B')
  assert.equal(run.page.data.youName, '乙')
  assert.equal(run.page.data.youAvatarSrc, '/b.png')
  assert.equal(run.page.data.themName, '甲')
  assert.equal(run.page.data.themAvatarSrc, '/a-as-partner.png')

  run.switchSession(sessionFor(unbound))
  const reopened = run.page.onShow()
  await nextTurn()
  assert.equal(run.page.data.youAvatarSrc, '')
  assert.equal(run.page.data.themAvatarSrc, '')
  assert.equal(run.page.data.partnerWechatId, '')
  run.requests[2].resolve('/a-as-self.png')
  await reopened
  assert.equal(run.page.data.role, 'A')
  assert.equal(run.page.data.youAvatarSrc, '/a-as-self.png')
  assert.equal(run.page.data.themName, '尚未加入')
  assert.equal(run.page.data.bound, false)
}

async function main() {
  await verifyLatestShow()
  await verifyUnload()
  await verifyAccountIsolation()
  console.log('我们页回归通过（头像乱序、卸载、账号隔离）')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
