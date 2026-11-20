import { callOurs } from '../services/cloud-api'
import { getSession } from '../services/session'
const CACHE_TTL_MS = 90 * 60 * 1000
const BATCH_SIZE = 50
const STORAGE_KEY = 'OURS_URL_CACHE'
const urlCache = new Map<string, { url: string; expires: number }>()

interface PendingUrl {
  promise: Promise<string>
  resolve: (url: string) => void
}

interface RequestScope {
  key: string
  coupleId: string | null
  pending: Map<string, PendingUrl>
}

let activeScope: RequestScope | undefined

function currentScope(): RequestScope {
  const session = getSession()
  const coupleId = session?.status === 'ready' ? (session.coupleId || null) : null
  const key = JSON.stringify([session?.status, session?.openid, coupleId])
  if (activeScope?.key !== key) activeScope = { key, coupleId, pending: new Map() }
  return activeScope
}

function createPendingUrl(): PendingUrl {
  let resolve!: PendingUrl['resolve']
  const promise = new Promise<string>(done => { resolve = done })
  return { promise, resolve }
}
function loadCacheFromStorage() {
  try {
    const data = wx.getStorageSync(STORAGE_KEY)
    if (data) {
      const parsed = JSON.parse(data)
      const now = Date.now()
      for (const [key, value] of Object.entries(parsed)) {
        if ((value as any).expires > now) urlCache.set(key, value as any)
      }
    }
  } catch (e) {}
}
loadCacheFromStorage()
let saveTimer: any = null
function queueCacheSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const obj: Record<string, { url: string; expires: number }> = {}
      urlCache.forEach((value, key) => { obj[key] = value })
      wx.setStorage({ key: STORAGE_KEY, data: JSON.stringify(obj) })
    } catch (e) {}
  }, 5000)
}
function cacheGet(fileID: string): string | null {
  const hit = urlCache.get(fileID)
  if (!hit || hit.expires <= Date.now()) {
    if (hit) urlCache.delete(fileID)
    return null
  }
  return hit.url
}
function cacheSet(fileID: string, url: string, maxAgeSeconds?: number) {
  if (!url) return
  const lifetime = maxAgeSeconds && maxAgeSeconds > 0
    ? Math.max(0, maxAgeSeconds * 1000 - 30000)
    : CACHE_TTL_MS
  urlCache.set(fileID, { url, expires: Date.now() + Math.min(CACHE_TTL_MS, lifetime) })
  queueCacheSave()
}
export function invalidateCachedUrl(fileID: string): void {
  urlCache.delete(fileID)
  const pending = currentScope().pending
  const request = pending.get(fileID)
  pending.delete(fileID)
  request?.resolve('')
  queueCacheSave()
}

async function fetchCloudUrls(scope: RequestScope, requests: Map<string, PendingUrl>): Promise<void> {
  const fileIDs = [...requests.keys()]
  // 失效后，同一文件可能已经由新的请求负责。
  const pendingRequest = (id: string) => {
    const request = requests.get(id)
    return scope.pending.get(id) === request ? request : undefined
  }
  const accept = (id: string, url: string, maxAgeSeconds?: number) => {
    const request = pendingRequest(id)
    if (!request) return
    cacheSet(id, url, maxAgeSeconds)
    scope.pending.delete(id)
    request.resolve(url)
  }
  const fetchBatches = async (ids: string[], fetchBatch: (batch: string[]) => Promise<void>) => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      if (currentScope() !== scope) return
      const batch = ids.slice(i, i + BATCH_SIZE).filter(pendingRequest)
      if (!batch.length) continue
      try { await fetchBatch(batch) } catch {}
    }
  }
  const fetchSdkBatch = async (batch: string[]) => {
    const res = await wx.cloud.getTempFileURL({ fileList: batch })
    if (currentScope() !== scope) return
    for (const item of res.fileList || []) {
      if (item.status === 0 && item.tempFileURL && batch.includes(item.fileID)) {
        accept(item.fileID, item.tempFileURL, item.maxAge)
      }
    }
  }

  try {
    await fetchBatches(fileIDs, fetchSdkBatch)

    const { coupleId } = scope
    if (coupleId) {
      await fetchBatches(fileIDs.filter(pendingRequest), async batch => {
        const urls = await callOurs<Record<string, string>>('resolveMediaUrls', { coupleId, fileIDs: batch })
        if (currentScope() !== scope) return
        for (const id of batch) {
          const url = urls?.[id]
          if (url) accept(id, url)
        }
      })
    }

    // 复用同一条在途请求，只重试兜底后仍待解析的文件。
    await fetchBatches(fileIDs.filter(pendingRequest), fetchSdkBatch)
  } finally {
    for (const [id, request] of requests) {
      if (!pendingRequest(id)) continue
      scope.pending.delete(id)
      request.resolve('')
    }
  }
}

export async function resolveCloudUrls(fileIDs: string[]): Promise<Record<string, string>> {
  const scope = currentScope()
  const result: Record<string, string> = {}
  const requests = new Map<string, PendingUrl>()
  const waiting: Promise<void>[] = []
  for (const id of new Set(fileIDs)) {
    if (!id) continue
    if (!id.startsWith('cloud://')) { result[id] = id; continue }
    const cached = cacheGet(id)
    if (cached) {
      result[id] = cached
      continue
    }
    let request = scope.pending.get(id)
    if (!request) {
      request = createPendingUrl()
      scope.pending.set(id, request)
      requests.set(id, request)
    }
    waiting.push(request.promise.then(url => {
      if (url) result[id] = url
    }))
  }
  if (requests.size) waiting.push(fetchCloudUrls(scope, requests))
  await Promise.all(waiting)
  return result
}
export async function resolveCloudUrl(fileID: string): Promise<string> {
  if (!fileID) return ''
  if (!fileID.startsWith('cloud://')) return fileID
  const map = await resolveCloudUrls([fileID])
  return map[fileID] || ''
}

/** 同步读缓存（命中且未过期才返回），用于冷启动乐观渲染，不触发网络 */
export function peekCachedUrl(fileID: string): string {
  if (!fileID) return ''
  if (!fileID.startsWith('cloud://')) return fileID
  return cacheGet(fileID) || ''
}
