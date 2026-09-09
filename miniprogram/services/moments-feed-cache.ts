// 回忆列表预取：在进入列表前用空闲时间提前发起首屏请求，命中后秒开
const DEFAULT_KEY = 'default'
let prefetchKey: string | null = null
let prefetchPromise: Promise<unknown> | null = null

export function feedCacheKey(options?: { tag?: string; keyword?: string; locationName?: string }): string {
  const tag = options?.tag || ''
  const kw = (options?.keyword || '').trim()
  const loc = (options?.locationName || '').trim()
  if (!tag && !kw && !loc) return DEFAULT_KEY
  return 't:' + tag + '|k:' + kw + '|l:' + loc
}

export function prefetchMomentsFeed<T>(key: string, load: () => Promise<T>): void {
  prefetchKey = key
  prefetchPromise = load()
}

export async function takePrefetchedFeed<T>(key: string): Promise<T | null> {
  if (prefetchKey !== key || !prefetchPromise) return null
  const p = prefetchPromise as Promise<T>
  prefetchKey = null
  prefetchPromise = null
  try { return await p } catch { return null }
}

export function invalidateMomentsFeedPrefetch(): void { prefetchKey = null; prefetchPromise = null }