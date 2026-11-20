import { getSession } from './session'

// 回忆列表预取：在进入列表前用空闲时间提前发起首屏请求，命中后秒开
const DEFAULT_KEY = 'default'
const PREFETCH_MAX_AGE_MS = 15_000
let prefetch: { key: string; scope: string; startedAt: number; promise: Promise<unknown> } | null = null
let revision = 0

function sessionScope(): string | null {
  const session = getSession()
  if (session?.status !== 'ready' || !session.coupleId) return null
  return JSON.stringify([session.openid, session.coupleId, session.role])
}

export function feedCacheKey(options?: { tag?: string; keyword?: string; locationName?: string }): string {
  const tag = options?.tag || ''
  const kw = (options?.keyword || '').trim()
  const loc = (options?.locationName || '').trim()
  if (!tag && !kw && !loc) return DEFAULT_KEY
  return 't:' + tag + '|k:' + kw + '|l:' + loc
}

export function prefetchMomentsFeed<T>(key: string, load: () => Promise<T>): void {
  const scope = sessionScope()
  prefetch = scope === null ? null : { key, scope, startedAt: Date.now(), promise: load().catch(() => null) }
}

export async function takePrefetchedFeed<T>(key: string): Promise<T | null> {
  const entry = prefetch
  // 返回时查询不匹配，也应丢弃这次发布留下的首屏快照。
  prefetch = null
  if (!entry || entry.key !== key || Date.now() - entry.startedAt >= PREFETCH_MAX_AGE_MS || entry.scope !== sessionScope()) return null
  const takenAtRevision = revision
  const result = await entry.promise as T | null
  return takenAtRevision === revision && entry.scope === sessionScope() ? result : null
}

export function invalidateMomentsFeedPrefetch(): void {
  revision++
  prefetch = null
}
