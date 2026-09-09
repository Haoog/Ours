import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  callAdmin,
  describeError,
  hasLoginSession,
  signIn,
  signOut,
} from './cloudbase'
import type {
  AccessCode,
  AdminIdentity,
  AdminMoment,
  Overview,
  PageResult,
  Quota,
  Space,
} from './types'

type View = 'overview' | 'codes' | 'spaces'
type IssuedAccessCode = AccessCode & { code: string }
type AccessCodeInput = Partial<AccessCode> & { _id?: string; codeId?: string }
type QuotaForm = {
  maxMoments: string
  maxStorageGB: string
  maxMediaItems: string
  maxMediaPerMoment: string
}

const EMPTY_QUOTA = {
  maxMoments: 500,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxMediaItems: 2000,
  maxMediaPerMoment: 12,
}

function formatDate(value: number | string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(value: number): string {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

function formatCodeStatus(status: AccessCode['status']): string {
  return {
    unused: '未使用',
    active: '已激活',
    revoked: '已撤销',
    expired: '已过期',
  }[status]
}

function normalizeAccessCode(code: AccessCodeInput): AccessCode {
  return {
    ...code,
    // Older admin-api deployments returned _id (or no normalized id at all).
    // Normalize all known shapes at the UI boundary so actions use the real
    // CloudBase document id instead of sending undefined.
    id: String(code.id || code._id || code.codeId || '').trim(),
    status: code.status || 'unused',
    coupleId: code.coupleId ?? null,
    planId: code.planId || 'legacy',
    quota: {
      ...EMPTY_QUOTA,
      ...(code.quota || {}),
    },
    expiresAt: code.expiresAt ?? null,
    createdAt: code.createdAt || 0,
  }
}

const OPTIMISTIC_CODE_WINDOW_MS = 2 * 60 * 1000

function sameAccessCode(left: AccessCode, right: AccessCode): boolean {
  if (left.id && right.id) return left.id === right.id
  return Boolean(
    left.createdAt > 0 &&
      right.createdAt > 0 &&
      left.createdAt === right.createdAt &&
      left.planId === right.planId,
  )
}

function uniqueAccessCodes(items: AccessCode[]): AccessCode[] {
  return items.reduce<AccessCode[]>((result, item) => {
    if (!result.some(existing => sameAccessCode(existing, item))) result.push(item)
    return result
  }, [])
}

function quotaToForm(quota: Quota | null | undefined): QuotaForm {
  const value = quota || EMPTY_QUOTA
  const storageGB = value.maxStorageBytes / (1024 * 1024 * 1024)
  return {
    maxMoments: String(value.maxMoments),
    maxStorageGB: String(Number(storageGB.toFixed(2))),
    maxMediaItems: String(value.maxMediaItems),
    maxMediaPerMoment: String(value.maxMediaPerMoment),
  }
}

function sameQuota(left: Quota | null | undefined, right: Quota | null | undefined): boolean {
  if (!left || !right) return false
  return (
    left.maxMoments === right.maxMoments &&
    left.maxStorageBytes === right.maxStorageBytes &&
    left.maxMediaItems === right.maxMediaItems &&
    left.maxMediaPerMoment === right.maxMediaPerMoment
  )
}

const LAST_ISSUED_CODE_STORAGE = 'ours-admin:last-issued-code'

function readLastIssuedCode(): IssuedAccessCode | null {
  try {
    const raw = sessionStorage.getItem(LAST_ISSUED_CODE_STORAGE)
    if (!raw) return null
    const parsed = JSON.parse(raw) as IssuedAccessCode
    if (!parsed?.id || !parsed.code) return null
    return normalizeAccessCode(parsed) as IssuedAccessCode
  } catch {
    return null
  }
}

function saveLastIssuedCode(code: IssuedAccessCode | null): void {
  try {
    if (code) sessionStorage.setItem(LAST_ISSUED_CODE_STORAGE, JSON.stringify(code))
    else sessionStorage.removeItem(LAST_ISSUED_CODE_STORAGE)
  } catch {
    // sessionStorage is only a convenience; the server-side code remains unaffected.
  }
}

function formatSpaceStatus(status: Space['status']): string {
  return {
    active: '使用中',
    suspended: '已暂停',
    revoked: '已撤销',
    expired: '已过期',
  }[status]
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    window.dispatchEvent(new CustomEvent('ours-notice', { detail: '已复制' }))
  } catch {
    window.prompt('复制邀请码', value)
  }
}

function LoginScreen({
  onSuccess,
  error,
  identity,
}: {
  onSuccess: (username: string, password: string) => Promise<void>
  error: string
  identity: AdminIdentity | null
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!username.trim() || !password) return
    setSubmitting(true)
    try {
      await onSuccess(username.trim(), password)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand-mark">O</div>
        <p className="eyebrow">OURS / CONTROL ROOM</p>
        <h1>欢迎回来</h1>
        <p className="auth-copy">登录管理台，管理授权空间和客户的记录。</p>
        <form onSubmit={submit} className="auth-form">
          <label>
            <span>管理员账号</span>
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="用户名、邮箱或手机号"
              autoComplete="username"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="输入密码"
              type="password"
              autoComplete="current-password"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          {identity && !identity.isAdmin && (
            <div className="setup-hint">
              <strong>当前账号尚未授权</strong>
              <span>请将这个 UID 添加到 CloudBase 的 admins 集合：</span>
              <code>{identity.uid}</code>
            </div>
          )}
          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? '登录中…' : '进入管理台'}
          </button>
        </form>
        <p className="auth-foot">仅限管理员使用 · Ours</p>
      </section>
    </main>
  )
}

function StatCard({ label, value, hint, accent = '' }: { label: string; value: string; hint: string; accent?: string }) {
  return (
    <article className={`stat-card ${accent}`}>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      <span className="stat-hint">{hint}</span>
    </article>
  )
}

function SpaceSummary({
  space,
  onOpen,
  onDelete,
}: {
  space: Space
  onOpen: () => void
  onDelete?: () => void
}) {
  return (
    <div className="space-row">
      <button className="space-row-main" onClick={onOpen} type="button">
        <div className="space-members">
          <div className="avatar-pair">
            <span>{space.memberA?.nickname?.slice(0, 1) || 'A'}</span>
            <span>{space.memberB?.nickname?.slice(0, 1) || 'B'}</span>
          </div>
          <div>
            <strong>
              {space.memberA?.nickname || '未命名'} <em>&amp;</em> {space.memberB?.nickname || '等待加入'}
            </strong>
            <small>{space.id}</small>
          </div>
        </div>
        <div className="space-row-meta">
          <span className={`status-pill status-${space.status}`}>{formatSpaceStatus(space.status)}</span>
          <span>{space.usage.momentCount} 条动态</span>
          <span>{formatBytes(space.usage.storageBytes)}</span>
          <span className="row-arrow">→</span>
        </div>
      </button>
      {onDelete && <button className="danger-text space-delete" onClick={onDelete} type="button">删除</button>}
    </div>
  )
}

function MomentCard({ moment }: { moment: AdminMoment }) {
  const imageItems = moment.media?.images || []
  const videoItems = moment.media?.videos || []
  const livePhotos = moment.media?.livePhotos || []
  const voiceItems = moment.media?.voices || []
  return (
    <article className="moment-card">
      <div className="moment-meta">
        <span className={`role-dot role-${moment.authorRole}`}>{moment.authorRole}</span>
        <span>{moment.authorRole === 'A' ? '成员 A' : '成员 B'}</span>
        <span>·</span>
        <span>{moment.momentDate || formatDate(moment.createdAt)}</span>
        <span className="moment-kind">{moment.kind === 'system' ? '系统记录' : moment.tag || '日常'}</span>
      </div>
      {moment.content && <p className="moment-content">{moment.content}</p>}
      {moment.location?.name && <p className="moment-location">⌖ {moment.location.name}</p>}
      {imageItems.length > 0 && (
        <div className="media-grid">
          {imageItems.map(item => <img key={item.fileID} src={item.url} alt="动态图片" loading="lazy" />)}
        </div>
      )}
      {videoItems.length > 0 && (
        <div className="video-list">
          {videoItems.map(item => <video key={item.fileID} src={item.url} controls preload="metadata" />)}
        </div>
      )}
      {livePhotos.length > 0 && (
        <div className="live-list">
          {livePhotos.map(item => (
            <div className="live-item" key={item.video.fileID}>
              <img src={item.cover.url} alt="实况封面" loading="lazy" />
              <video src={item.video.url} controls preload="metadata" />
            </div>
          ))}
        </div>
      )}
      {voiceItems.length > 0 && (
        <div className="voice-list">
          {voiceItems.map(item => <audio key={item.fileID} src={item.url} controls preload="metadata" />)}
        </div>
      )}
    </article>
  )
}

function SpaceDetail({
  space,
  onBack,
  onRefresh,
  onDelete,
}: {
  space: Space
  onBack: () => void
  onRefresh: (updatedSpace?: Space) => Promise<void>
  onDelete: () => void
}) {
  const [moments, setMoments] = useState<AdminMoment[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [editingQuota, setEditingQuota] = useState(false)
  const [savingQuota, setSavingQuota] = useState(false)
  const [quotaForm, setQuotaForm] = useState<QuotaForm>(() => quotaToForm(space.quota))

  async function load(reset = true) {
    if (reset) setLoading(true)
    else setLoadingMore(true)
    try {
      const result = await callAdmin<PageResult<AdminMoment>>('listMoments', {
        coupleId: space.id,
        skip: reset ? 0 : moments.length,
        limit: 20,
      })
      setMoments(reset ? result.items : [...moments, ...result.items])
      setTotal(result.total)
      setHasMore(result.hasMore)
      setError('')
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load()
    // The selected space is immutable for this view; reload when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.id])

  useEffect(() => {
    if (!editingQuota) setQuotaForm(quotaToForm(space.quota))
  }, [editingQuota, space.id, space.quota])

  async function resume() {
    try {
      await callAdmin('resumeSpace', { coupleId: space.id })
      await onRefresh()
    } catch (err) {
      setError(describeError(err))
    }
  }

  function beginEditQuota() {
    setQuotaForm(quotaToForm(space.quota))
    setError('')
    setEditingQuota(true)
  }

  async function saveQuota() {
    const maxMoments = Number(quotaForm.maxMoments)
    const maxStorageGB = Number(quotaForm.maxStorageGB)
    const maxMediaItems = Number(quotaForm.maxMediaItems)
    const maxMediaPerMoment = Number(quotaForm.maxMediaPerMoment)
    if (!Number.isInteger(maxMoments) || maxMoments < 1) {
      setError('动态上限必须是大于 0 的整数')
      return
    }
    if (!Number.isFinite(maxStorageGB) || maxStorageGB <= 0) {
      setError('存储上限必须是大于 0 的数字')
      return
    }
    if (!Number.isInteger(maxMediaItems) || maxMediaItems < 1) {
      setError('媒体文件上限必须是大于 0 的整数')
      return
    }
    if (!Number.isInteger(maxMediaPerMoment) || maxMediaPerMoment < 1) {
      setError('单条动态媒体上限必须是大于 0 的整数')
      return
    }

    const quota: Quota = {
      maxMoments,
      maxStorageBytes: Math.round(maxStorageGB * 1024 * 1024 * 1024),
      maxMediaItems,
      maxMediaPerMoment,
    }
    const warnings: string[] = []
    if (quota.maxMoments < space.usage.momentCount) warnings.push(`动态当前已使用 ${space.usage.momentCount} 条`)
    if (quota.maxMediaItems < space.usage.mediaItems) warnings.push(`媒体当前已使用 ${space.usage.mediaItems} 个`)
    if (quota.maxStorageBytes < space.usage.storageBytes) warnings.push(`存储当前已使用 ${formatBytes(space.usage.storageBytes)}`)
    if (warnings.length > 0 && !window.confirm(`新的额度低于当前用量：\n${warnings.join('\n')}\n\n已有内容不会被删除，但后续新增会受到限制。仍要保存吗？`)) return

    setSavingQuota(true)
    setError('')
    try {
      const result = await callAdmin<{ quota: Quota; space?: Space; verified?: boolean }>('updateSpaceQuota', { coupleId: space.id, quota })
      // 只有后端回读到最新空间文档才允许提示成功，避免页面暂时显示新值、刷新后又回退。
      if (!result.space || !sameQuota(result.space.quota, quota) || result.verified === false) {
        throw new Error('管理台后端尚未返回已落库的新额度，请先部署最新 admin-api')
      }
      await onRefresh(result.space)
      setEditingQuota(false)
      window.dispatchEvent(new CustomEvent('ours-notice', {
        detail: '空间额度已更新并确认落库，后续操作立即按新额度校验',
      }))
    } catch (err) {
      setError(`保存额度失败：${describeError(err)}`)
    } finally {
      setSavingQuota(false)
    }
  }

  return (
    <section className="detail-view">
      <button className="back-button" onClick={onBack} type="button">← 返回空间列表</button>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">SPACE DETAIL</p>
          <h2>{space.memberA?.nickname || '成员 A'} <em>&amp;</em> {space.memberB?.nickname || '等待加入'}</h2>
          <p className="muted">{space.id} · 创建于 {formatDate(space.createdAt)}</p>
        </div>
        <div className="detail-actions">
          <span className={`status-pill status-${space.status}`}>{formatSpaceStatus(space.status)}</span>
          {space.status !== 'active' && <button className="secondary-button" onClick={() => void resume()} type="button">恢复空间</button>}
          <button className="danger-button" onClick={onDelete} type="button">删除空间</button>
        </div>
      </div>

      <div className="detail-grid">
        <article className="detail-card member-card">
          <div className="section-title"><span>空间成员</span><small>最多 2 人</small></div>
          <div className="member-list">
            {[space.memberA, space.memberB].map((member, index) => (
              <div className="member-item" key={member?.openid || index}>
                <div className="member-avatar">{member?.nickname?.slice(0, 1) || (index === 0 ? 'A' : 'B')}</div>
                <div><strong>{member?.nickname || '尚未加入'}</strong><small>{member?.openid || '—'}</small></div>
                <span>{index === 0 ? '成员 A' : '成员 B'}</span>
              </div>
            ))}
          </div>
        </article>
        <article className="detail-card">
          <div className="section-title"><div><span>授权与资源</span><small>{space.planId}</small></div>{!editingQuota && <button className="text-button" onClick={beginEditQuota} type="button">编辑额度</button>}</div>
          {editingQuota ? (
            <div className="quota-editor">
              <div className="quota-editor-fields">
                <label><span>动态上限</span><input min="1" type="number" value={quotaForm.maxMoments} onChange={event => setQuotaForm(current => ({ ...current, maxMoments: event.target.value }))} /></label>
                <label><span>存储上限（GB）</span><input min="0.1" step="0.1" type="number" value={quotaForm.maxStorageGB} onChange={event => setQuotaForm(current => ({ ...current, maxStorageGB: event.target.value }))} /></label>
                <label><span>媒体文件上限</span><input min="1" type="number" value={quotaForm.maxMediaItems} onChange={event => setQuotaForm(current => ({ ...current, maxMediaItems: event.target.value }))} /></label>
                <label><span>单条动态媒体上限</span><input min="1" type="number" value={quotaForm.maxMediaPerMoment} onChange={event => setQuotaForm(current => ({ ...current, maxMediaPerMoment: event.target.value }))} /></label>
              </div>
              <p className="quota-editor-hint">降低上限不会删除已有内容，但会限制后续新增；保存后立即生效。</p>
              {error && <p className="form-error quota-editor-error">{error}</p>}
              <div className="quota-editor-actions"><button className="secondary-button" disabled={savingQuota} onClick={() => { setEditingQuota(false); setError('') }} type="button">取消</button><button className="primary-button" disabled={savingQuota} onClick={() => void saveQuota()} type="button">{savingQuota ? '保存中…' : '保存额度'}</button></div>
            </div>
          ) : (
            <div className="quota-list">
              <div><span>动态</span><strong>{space.usage.momentCount} / {space.quota?.maxMoments ?? '∞'}</strong></div>
              <div><span>媒体文件</span><strong>{space.usage.mediaItems} / {space.quota?.maxMediaItems ?? '∞'}</strong></div>
              <div><span>单条动态媒体</span><strong>最多 {space.quota?.maxMediaPerMoment ?? '∞'} 个</strong></div>
              <div><span>存储空间</span><strong>{formatBytes(space.usage.storageBytes)} / {space.quota ? formatBytes(space.quota.maxStorageBytes) : '∞'}</strong></div>
              <div><span>到期时间</span><strong>{space.expiresAt ? formatDate(space.expiresAt) : '长期'}</strong></div>
            </div>
          )}
        </article>
      </div>

      <div className="content-heading">
        <div><p className="eyebrow">PRIVATE MEMORIES</p><h3>全部动态与照片 <small>{total} 条</small></h3></div>
        <button className="secondary-button" onClick={() => void load()} type="button">刷新</button>
      </div>
      {!editingQuota && error && <p className="form-error inline-error">{error}</p>}
      {loading ? <div className="loading-card">正在读取这个空间的记录…</div> : moments.length === 0 ? <div className="empty-card">这个空间还没有动态。</div> : (
        <div className="moments-list">
          {moments.map(moment => <MomentCard key={moment.id} moment={moment} />)}
          {hasMore && <button className="load-more" disabled={loadingMore} onClick={() => void load(false)} type="button">{loadingMore ? '加载中…' : '加载更多'}</button>}
        </div>
      )}
    </section>
  )
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checking, setChecking] = useState(true)
  const [identity, setIdentity] = useState<AdminIdentity | null>(null)
  const [authError, setAuthError] = useState('')
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [codes, setCodes] = useState<AccessCode[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null)
  const [lastIssuedCode, setLastIssuedCode] = useState<IssuedAccessCode | null>(() => readLastIssuedCode())
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const creatingCodeRef = useRef(false)
  const [codeForm, setCodeForm] = useState({
    planId: 'basic',
    maxMoments: String(EMPTY_QUOTA.maxMoments),
    maxStorageGB: '1',
    maxMediaItems: String(EMPTY_QUOTA.maxMediaItems),
    maxMediaPerMoment: String(EMPTY_QUOTA.maxMediaPerMoment),
    expiresAt: '',
  })

  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        if (!(await hasLoginSession())) return
        const result = await callAdmin<AdminIdentity>('identity')
        if (!mounted) return
        setIdentity(result)
        if (result.isAdmin) setAuthenticated(true)
      } catch {
        // A missing or expired browser session simply shows the login page.
      } finally {
        if (mounted) setChecking(false)
      }
    })()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const handler = (event: Event) => setNotice((event as CustomEvent<string>).detail)
    window.addEventListener('ours-notice', handler)
    return () => window.removeEventListener('ours-notice', handler)
  }, [])

  async function login(username: string, password: string) {
    try {
      await signIn(username, password)
      const result = await callAdmin<AdminIdentity>('identity')
      setIdentity(result)
      if (!result.isAdmin) {
        setAuthError('账号登录成功，但尚未获得管理台权限')
        return
      }
      setAuthError('')
      setAuthenticated(true)
    } catch (err) {
      setAuthError(describeError(err))
    }
  }

  async function logout() {
    await signOut()
    setAuthenticated(false)
    setIdentity(null)
  }

  async function refreshAll() {
    setLoading(true)
    let nextSpaces = spaces
    try {
      const results = await Promise.allSettled([
        callAdmin<Overview>('overview'),
        callAdmin<PageResult<AccessCode>>('listAccessCodes', { limit: 100 }),
        callAdmin<PageResult<Space>>('listSpaces', { limit: 100 }),
      ])
      const errors: string[] = []
      const [overviewResult, codesResult, spacesResult] = results

      if (overviewResult.status === 'fulfilled') {
        setOverview(overviewResult.value)
      } else {
        errors.push(`概览：${describeError(overviewResult.reason)}`)
      }

      if (codesResult.status === 'fulfilled') {
        // 兼容旧版邀请码记录，避免缺少 quota 时渲染阶段报错导致白屏。
        const fetchedCodes = (Array.isArray(codesResult.value?.items) ? codesResult.value.items : []).map(normalizeAccessCode)
        // 刚生成的邀请码可能还在 CloudBase 的最终一致性窗口内；只在两分钟内保留
        // 这条本地结果，并按文档 id/创建时间去重，避免“本地一条 + 接口一条”。
        const recentCode = lastIssuedCode && normalizeAccessCode(lastIssuedCode)
        const recentAge = recentCode?.createdAt ? Date.now() - recentCode.createdAt : Number.POSITIVE_INFINITY
        const recentIsFresh = Boolean(
          recentCode &&
            recentCode.id &&
            recentCode.createdAt > 0 &&
            recentAge >= -OPTIMISTIC_CODE_WINDOW_MS &&
            recentAge <= OPTIMISTIC_CODE_WINDOW_MS,
        )
        const mergedCodes = recentIsFresh && recentCode && !fetchedCodes.some(code => sameAccessCode(code, recentCode))
          ? [recentCode, ...fetchedCodes]
          : fetchedCodes
        setCodes(uniqueAccessCodes(mergedCodes))
        if (recentCode && !recentIsFresh) {
          setLastIssuedCode(null)
          saveLastIssuedCode(null)
        }
      } else {
        errors.push(`邀请码：${describeError(codesResult.reason)}`)
      }

      if (spacesResult.status === 'fulfilled') {
        nextSpaces = spacesResult.value.items
        setSpaces(nextSpaces)
      } else {
        errors.push(`空间：${describeError(spacesResult.reason)}`)
      }

      if (errors.length > 0) setNotice(`部分数据同步失败：${errors.join('；')}`)
      return nextSpaces
    } catch (err) {
      setNotice(describeError(err))
      return spaces
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (authenticated) void refreshAll()
  }, [authenticated])

  async function createCode(event: FormEvent) {
    event.preventDefault()
    // setLoading 更新不是同步的，快速连续点击可能在同一轮渲染内触发两次提交；
    // 用 ref 在请求发出前就锁住按钮，确保一次点击最多创建一条记录。
    if (creatingCodeRef.current) return
    creatingCodeRef.current = true
    setLoading(true)
    try {
      const quota = {
        maxMoments: Number(codeForm.maxMoments),
        maxStorageBytes: Math.round(Number(codeForm.maxStorageGB) * 1024 * 1024 * 1024),
        maxMediaItems: Number(codeForm.maxMediaItems),
        maxMediaPerMoment: Number(codeForm.maxMediaPerMoment),
      }
      const result = await callAdmin<{
        id: string
        code: string
        status: AccessCode['status']
        planId: string
        quota: AccessCode['quota']
        expiresAt: number | null
        createdAt: number
      }>('createAccessCode', {
        planId: codeForm.planId,
        ...quota,
        expiresAt: codeForm.expiresAt ? new Date(`${codeForm.expiresAt}T23:59:59`).getTime() : null,
      })
      const createdCode = normalizeAccessCode({
        id: result.id,
        status: result.status || 'unused',
        coupleId: null,
        planId: result.planId || codeForm.planId,
        quota: result.quota || quota,
        expiresAt: result.expiresAt ?? null,
        createdAt: result.createdAt || Date.now(),
      })
      const issuedCode = { ...createdCode, code: result.code }
      setLastIssuedCode(issuedCode)
      saveLastIssuedCode(issuedCode)
      // 先把服务器返回的完整结果放进列表，再做后台同步；即使统计接口暂时失败，
      // 用户也能立即看到并复制这条刚刚生成的邀请码。
      setCodes(previous => [createdCode, ...previous.filter(code => code.id !== createdCode.id)])
      await refreshAll()
      setCodes(previous => previous.some(code => code.id === createdCode.id)
        ? previous
        : [createdCode, ...previous])
      await copyText(result.code)
      setNotice(`邀请码 ${result.code} 已生成并复制`)
    } catch (err) {
      setNotice(describeError(err))
    } finally {
      creatingCodeRef.current = false
      setLoading(false)
    }
  }

  async function revokeCode(code: AccessCode) {
    const id = String(code.id || '').trim()
    if (!id) {
      setNotice('这条邀请码记录缺少数据库 ID，请先重新部署 admin-api 后刷新页面')
      return
    }
    if (!window.confirm(`确定撤销 ${code.id} 对应的邀请码吗？已激活的空间也会暂停。`)) return
    try {
      await callAdmin('revokeAccessCode', { id })
      await refreshAll()
      setNotice('邀请码已撤销')
    } catch (err) {
      setNotice(describeError(err))
    }
  }

  async function deleteCode(code: AccessCode) {
    const id = String(code.id || '').trim()
    if (!id) {
      setNotice('这条邀请码记录缺少数据库 ID，请先重新部署 admin-api 后刷新页面')
      return
    }
    if (!window.confirm(`确定永久删除未兑换的邀请码 ${id} 吗？删除后不能恢复。`)) return
    try {
      await callAdmin('deleteAccessCode', { id })
      setCodes(previous => previous.filter(item => item.id !== id))
      if (lastIssuedCode?.id === id) {
        setLastIssuedCode(null)
        saveLastIssuedCode(null)
      }
      await refreshAll()
      setNotice('邀请码已删除')
    } catch (err) {
      setNotice(describeError(err))
    }
  }

  async function deleteSpace(space: Space) {
    const name = `${space.memberA?.nickname || '成员 A'} & ${space.memberB?.nickname || '等待加入'}`
    if (!window.confirm(`确定删除「${name}」这个空间吗？\n\n这会永久删除空间内的动态、照片、评论、签到和授权记录，不能恢复。`)) return
    setLoading(true)
    try {
      const result = await callAdmin<{ deletedRecords: number; deletedFiles: number; failedFiles: number }>('deleteSpace', {
        coupleId: space.id,
      })
      if (selectedSpace?.id === space.id) setSelectedSpace(null)
      if (lastIssuedCode?.id && lastIssuedCode.id === space.licenseId) {
        setLastIssuedCode(null)
        saveLastIssuedCode(null)
      }
      await refreshAll()
      setNotice(result.failedFiles > 0
        ? `空间已删除，但有 ${result.failedFiles} 个媒体文件未能清理`
        : '空间及其数据已删除')
    } catch (err) {
      setNotice(describeError(err))
    } finally {
      setLoading(false)
    }
  }

  const activeSpaceCount = useMemo(() => spaces.filter(space => space.status === 'active').length, [spaces])

  if (checking) return <div className="loading-screen">正在连接管理台…</div>
  if (!authenticated) return <LoginScreen onSuccess={login} error={authError} identity={identity} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-mark small">O</span><div><strong>Ours</strong><small>Control room</small></div></div>
        <nav className="side-nav">
          <button className={view === 'overview' ? 'active' : ''} onClick={() => { setView('overview'); setSelectedSpace(null) }} type="button"><span>⌂</span>概览</button>
          <button className={view === 'codes' ? 'active' : ''} onClick={() => { setView('codes'); setSelectedSpace(null) }} type="button"><span>✦</span>邀请码</button>
          <button className={view === 'spaces' ? 'active' : ''} onClick={() => { setView('spaces'); setSelectedSpace(null) }} type="button"><span>♡</span>双人空间</button>
        </nav>
        <div className="side-bottom">
          <div className="admin-chip"><span>{identity?.uid?.slice(0, 1).toUpperCase() || 'A'}</span><div><strong>管理员</strong><small>{identity?.uid?.slice(0, 14) || '当前账号'}</small></div></div>
          <button className="logout-button" onClick={() => void logout()} type="button">退出登录</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">{view === 'overview' ? 'TODAY AT A GLANCE' : view === 'codes' ? 'ACCESS CONTROL' : 'PRIVATE SPACES'}</p><h1>{view === 'overview' ? '管理台' : view === 'codes' ? '邀请码' : '双人空间'}</h1></div>
          <button className="refresh-button" disabled={loading} onClick={() => void refreshAll()} type="button">↻ {loading ? '同步中' : '刷新数据'}</button>
        </header>

        {view === 'overview' && (
          <section className="page-view">
            <div className="welcome-banner"><div><p className="eyebrow">Ours / 运营概览</p><h2>把每一段记录，照顾好。</h2><p>这里可以生成授权、查看空间状态，并进入客户的私密记录。</p></div><div className="banner-orbit">♡</div></div>
            <div className="stats-grid">
              <StatCard label="双人空间" value={String(overview?.spaces ?? 0)} hint={`${activeSpaceCount} 个正在使用`} accent="purple" />
              <StatCard label="邀请码" value={String(overview?.accessCodes ?? 0)} hint={`${codes.filter(code => code.status === 'unused').length} 个待发放`} accent="yellow" />
              <StatCard label="全部动态" value={String(overview?.moments ?? 0)} hint="跨所有空间汇总（不含系统记录）" accent="blue" />
              <StatCard label="存储用量" value={formatBytes(overview?.storageBytes ?? 0)} hint="所有空间媒体文件实际大小汇总" accent="pink" />
            </div>
            <div className="overview-columns">
              <section className="panel-card"><div className="panel-heading"><div><p className="eyebrow">RECENT SPACES</p><h3>最近的空间</h3></div><button className="text-button" onClick={() => setView('spaces')} type="button">查看全部 →</button></div>{spaces.length === 0 ? <div className="empty-card compact">还没有激活的空间。</div> : spaces.slice(0, 5).map(space => <SpaceSummary key={space.id} space={space} onOpen={() => { setSelectedSpace(space); setView('spaces') }} onDelete={() => void deleteSpace(space)} />)}</section>
              <section className="panel-card"><div className="panel-heading"><div><p className="eyebrow">QUICK ACTION</p><h3>现在可以做什么</h3></div></div><button className="quick-action" onClick={() => setView('codes')} type="button"><span className="quick-icon">✦</span><div><strong>生成一个邀请码</strong><small>为新的双人空间发放授权</small></div><span>→</span></button><div className="tip-box">邀请码只在客户首次激活时消耗；第二位成员通过空间邀请链接加入。</div></section>
            </div>
          </section>
        )}

        {view === 'codes' && (
          <section className="page-view">
            <div className="section-intro"><div><p className="eyebrow">ONE CODE / ONE SPACE</p><h2>发放一个新的空间</h2><p>生成后把邀请码发给客户；兑换一次后，它会自动绑定到一个双人空间，额度也会写入并持续校验。每次点击只创建一条，历史邀请码会继续保留在列表中。</p></div></div>
            <form className="code-create-card" onSubmit={createCode}><div className="form-heading"><span className="number-badge">01</span><div><strong>生成邀请码</strong><small>额度可以按客户情况调整</small></div></div><div className="form-fields"><label><span>套餐名称</span><input value={codeForm.planId} onChange={event => setCodeForm({ ...codeForm, planId: event.target.value })} /></label><label><span>动态上限</span><input min="1" type="number" value={codeForm.maxMoments} onChange={event => setCodeForm({ ...codeForm, maxMoments: event.target.value })} /></label><label><span>存储上限（GB）</span><input min="0.1" step="0.1" type="number" value={codeForm.maxStorageGB} onChange={event => setCodeForm({ ...codeForm, maxStorageGB: event.target.value })} /></label><label><span>媒体文件上限</span><input min="1" type="number" value={codeForm.maxMediaItems} onChange={event => setCodeForm({ ...codeForm, maxMediaItems: event.target.value })} /></label><label><span>单条动态媒体上限</span><input min="1" type="number" value={codeForm.maxMediaPerMoment} onChange={event => setCodeForm({ ...codeForm, maxMediaPerMoment: event.target.value })} /></label><label><span>授权到期日（可选）</span><input type="date" value={codeForm.expiresAt} onChange={event => setCodeForm({ ...codeForm, expiresAt: event.target.value })} /></label></div><button className="primary-button compact-button" disabled={loading} type="submit">{loading ? '生成中…' : '生成并复制邀请码'}</button></form>
            {lastIssuedCode && (
              <div className="issued-code-card">
                <div>
                  <p className="eyebrow">JUST CREATED</p>
                  <strong>本次生成的邀请码</strong>
                  <small>邀请码只在服务器保存哈希；请在本次会话中复制并发给客户。</small>
                </div>
                <code>{lastIssuedCode.code}</code>
                <button className="secondary-button" onClick={() => void copyText(lastIssuedCode.code)} type="button">复制</button>
                <button className="dismiss-button" onClick={() => { setLastIssuedCode(null); saveLastIssuedCode(null) }} type="button" aria-label="关闭本次邀请码提示">×</button>
              </div>
            )}
            <div className="panel-card table-card"><div className="panel-heading"><div><p className="eyebrow">ISSUED CODES</p><h3>邀请码列表 <small>{codes.length}</small></h3></div></div><div className="data-table"><div className="table-row table-head"><span>状态</span><span>套餐 / 额度</span><span>对应空间</span><span>创建时间</span><span>操作</span></div>{codes.length === 0 ? <div className="empty-card compact">还没有生成邀请码。</div> : codes.map(code => <div className="table-row" key={code.id}><span><b className={`status-pill status-code-${code.status}`}>{formatCodeStatus(code.status)}</b></span><span><strong>{code.planId}</strong><small>{code.quota.maxMoments} 动态 · {formatBytes(code.quota.maxStorageBytes)}</small></span><span className="mono">{code.coupleId || '待兑换'}</span><span>{formatDate(code.createdAt)}</span><span className="table-actions">{code.status === 'unused' && <button className="danger-text" onClick={() => void revokeCode(code)} type="button">撤销</button>}{code.status === 'active' && <button className="danger-text" onClick={() => void revokeCode(code)} type="button">暂停</button>}{!code.coupleId && code.status !== 'active' && <button className="danger-text" onClick={() => void deleteCode(code)} type="button">删除</button>}</span></div>)}</div><p className="table-note">已兑换的邀请码会绑定空间，不能单独删除；未兑换、已撤销或已过期的邀请码可以直接删除。</p></div>
          </section>
        )}

        {view === 'spaces' && (
          selectedSpace ? <SpaceDetail space={selectedSpace} onBack={() => setSelectedSpace(null)} onDelete={() => void deleteSpace(selectedSpace)} onRefresh={async (updatedSpace?: Space) => {
            const selectedId = selectedSpace.id
            const previousSpace = selectedSpace
            const nextSpaces = await refreshAll()
            const refreshedSpace = nextSpaces.find(item => item.id === selectedId)
            const baseSpace = refreshedSpace?.id === selectedId ? refreshedSpace : previousSpace
            const nextSpace = updatedSpace?.id === selectedId
              ? {
                  ...baseSpace,
                  ...updatedSpace,
                  // Updating quota cannot change membership metadata. Keep the
                  // current detail visible even if a partial API response is returned.
                  memberA: updatedSpace.memberA || baseSpace.memberA,
                  memberB: updatedSpace.memberB || baseSpace.memberB,
                  createdAt: updatedSpace.createdAt || baseSpace.createdAt,
                  usage: refreshedSpace?.id === selectedId ? refreshedSpace.usage : updatedSpace.usage || baseSpace.usage,
                }
              : baseSpace
            setSelectedSpace(nextSpace)
          }} /> : <section className="page-view"><div className="section-intro"><div><p className="eyebrow">ALL CUSTOMER SPACES</p><h2>双人空间 <small>{spaces.length}</small></h2><p>选择一个空间，可以查看成员信息、授权额度和全部私密动态。</p></div></div><div className="panel-card spaces-card">{spaces.length === 0 ? <div className="empty-card">还没有客户空间。</div> : spaces.map(space => <SpaceSummary key={space.id} space={space} onOpen={() => setSelectedSpace(space)} onDelete={() => void deleteSpace(space)} />)}</div></section>
        )}
      </main>
      {notice && <div className="toast">{notice}</div>}
    </div>
  )
}
