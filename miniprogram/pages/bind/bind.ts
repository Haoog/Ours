// pages/bind/bind.ts —— 邀请 TA

import { createPartnerInvite } from '../../services/store'
import { ensureCloudReady } from '../../services/page-boot'
import { getSession } from '../../services/session'
import { getThemeStyle, syncTheme } from '../../services/theme'

type PartnerInvite = Awaited<ReturnType<typeof createPartnerInvite>>

const localInvites = new Map<string, PartnerInvite | null>()
const pendingInvites = new Map<string, Promise<void>>()

function getInviteKey(session = getSession()): string {
  const couple = session?.couple
  if (session?.status !== 'ready' || session.role !== 'A' || !session.openid ||
      !session.coupleId || session.coupleId !== couple?.id || couple.memberA?.openid !== session.openid || couple.memberB) return ''
  return `OURS_PARTNER_INVITE_V1:${encodeURIComponent(session.openid)}:${encodeURIComponent(couple.id)}`
}

function isUsableInvite(value: unknown): value is PartnerInvite {
  const invite = value as Partial<PartnerInvite> | null
  return typeof invite?.token === 'string' && /^[A-Za-z0-9_-]+$/.test(invite.token) &&
    typeof invite.expiresAt === 'number' && Number.isSafeInteger(invite.expiresAt) && invite.expiresAt > Date.now()
}

function saveInvite(key: string, invite: PartnerInvite | null) {
  localInvites.set(key, invite)
  try {
    if (invite) wx.setStorageSync(key, invite)
    else wx.removeStorageSync(key)
  } catch { /* 本次运行仍可使用内存缓存。 */ }
}

function readInvite(key: string): PartnerInvite | null {
  let invite: unknown = localInvites.get(key)
  if (invite === undefined) {
    try { invite = wx.getStorageSync(key) } catch { return null }
  }
  if (isUsableInvite(invite)) {
    localInvites.set(key, invite)
    return invite
  }
  if (invite) saveInvite(key, null)
  return null
}

function requestInvite(key: string): Promise<void> {
  const pending = pendingInvites.get(key)
  if (pending) return pending
  // 请求可能已提交但响应丢失，先移除可能被替换的本机链接。
  saveInvite(key, null)
  const request = createPartnerInvite().then(invite => {
    if (!isUsableInvite(invite)) throw new Error('邀请链接无效')
    saveInvite(key, { token: invite.token, expiresAt: invite.expiresAt })
  }).finally(() => { pendingInvites.delete(key) })
  pendingInvites.set(key, request)
  return request
}

Page({
  data: {
    themeStyle: getThemeStyle(),
    youName: '你',
    themName: 'TA',
    startDate: '',
    inviteAvailable: false,
    inviteReady: false,
    inviteLoading: true,
    inviteError: '',
  },
  inviteKey: '',
  loadVersion: 0,
  expiryTimer: 0,
  confirmingInviteVersion: -1,

  onLoad() {
    syncTheme(this)
  },

  onShow() {
    return this.refreshInvite()
  },

  onHide() {
    this.loadVersion++
    this.inviteKey = ''
    clearTimeout(this.expiryTimer)
  },

  onUnload() {
    this.onHide()
  },

  async refreshInvite() {
    const version = ++this.loadVersion
    this.inviteKey = ''
    clearTimeout(this.expiryTimer)
    this.setData({ inviteAvailable: false, inviteReady: false, inviteLoading: true, inviteError: '' })
    const ready = await ensureCloudReady().catch(() => false)
    if (version !== this.loadVersion) return
    if (!ready) {
      this.setData({ inviteLoading: false, inviteError: '连接失败，请重试' })
      return
    }
    const session = getSession()
    const couple = session?.couple
    const me = session?.role === 'A' ? couple?.memberA : couple?.memberB
    const partner = session?.role === 'A' ? couple?.memberB : couple?.memberA
    const key = getInviteKey(session)
    this.inviteKey = key
    this.setData({
      youName: me?.nickname ?? '你',
      themName: partner?.nickname ?? '她',
      startDate: couple?.startDate ?? '',
    })
    await this.finishInvite(version, pendingInvites.get(key))
  },

  onGenerateInvite() {
    const key = this.inviteKey
    const version = this.loadVersion
    if (!key || key !== getInviteKey() || this.data.inviteLoading || this.confirmingInviteVersion === version) return
    this.confirmingInviteVersion = version
    wx.showModal({
      title: '生成新邀请链接？',
      content: '生成后，之前发出的邀请卡片会失效。',
      confirmText: '生成',
      success: async ({ confirm }) => {
        if (!confirm || version !== this.loadVersion || key !== getInviteKey()) return
        this.setData({ inviteReady: false, inviteLoading: true, inviteError: '' })
        await this.finishInvite(version, requestInvite(key))
      },
      fail: () => {
        if (version === this.loadVersion) this.setData({ inviteError: '无法打开确认窗口，请重试' })
      },
      complete: () => {
        if (this.confirmingInviteVersion === version) this.confirmingInviteVersion = -1
      },
    })
  },

  async finishInvite(version: number, request?: Promise<void>) {
    let inviteError = ''
    try {
      if (request) await request
    } catch {
      inviteError = '生成失败，旧卡片的状态暂时无法确认，请重试'
    }
    if (version !== this.loadVersion) return
    const inviteAvailable = !!this.inviteKey && this.inviteKey === getInviteKey()
    this.setData({ inviteAvailable, inviteLoading: false, inviteError })
    this.refreshShareState()
  },

  getShareInvite(): PartnerInvite | null {
    const key = this.inviteKey
    if (!key || key !== getInviteKey() || this.data.inviteLoading || pendingInvites.has(key)) return null
    return readInvite(key)
  },

  refreshShareState() {
    clearTimeout(this.expiryTimer)
    const invite = this.getShareInvite()
    this.setData({ inviteReady: !!invite })
    if (invite) {
      const delay = Math.min(invite.expiresAt - Date.now(), 0x7fffffff)
      this.expiryTimer = setTimeout(() => this.refreshShareState(), delay)
    }
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const invite = this.getShareInvite()
    if (!invite) {
      this.refreshShareState()
      wx.showToast({ title: '暂无可分享的邀请链接', icon: 'none' })
      return { title: 'Ours', path: '/pages/setup/setup' }
    }
    return {
      title: `${this.data.youName} 邀请你一起写「Ours」`,
      path: `/pages/home/home?inviteToken=${invite.token}`,
    }
  },
})
