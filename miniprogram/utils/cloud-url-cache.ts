import { callOurs } from '../services/cloud-api'
import { coupleId } from '../services/session'
const CACHE_TTL_MS = 90 * 60 * 1000
const BATCH_SIZE = 50
const STORAGE_KEY = 'OURS_URL_CACHE'
const urlCache = new Map<string, { url: string; expires: number }>()
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
function cacheSet(fileID: string, url: string) {
  if (!url) return
  urlCache.set(fileID, { url, expires: Date.now() + CACHE_TTL_MS })
  queueCacheSave()
}
async function fetchViaClientApi(fileIDs: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  for (let i = 0; i < fileIDs.length; i += BATCH_SIZE) {
    const batch = fileIDs.slice(i, i + BATCH_SIZE)
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: batch })
      for (const item of res.fileList || []) {
        if (item.status === 0 && item.tempFileURL) { map[item.fileID] = item.tempFileURL; cacheSet(item.fileID, item.tempFileURL) }
      }
    } catch {}
  }
  return map
}
async function fetchViaCloudFunction(fileIDs: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  for (let i = 0; i < fileIDs.length; i += BATCH_SIZE) {
    const batch = fileIDs.slice(i, i + BATCH_SIZE)
    try {
      const part = await callOurs<Record<string, string>>('resolveMediaUrls', { coupleId: coupleId(), fileIDs: batch })
      for (const [id, url] of Object.entries(part || {})) {
        if (url) { map[id] = url; cacheSet(id, url) }
      }
    } catch {}
  }
  return map
}
async function fetchCloudUrls(fileIDs: string[]): Promise<Record<string, string>> {
  const map = await fetchViaClientApi(fileIDs)
  const missing = fileIDs.filter(id => !map[id])
  if (missing.length) {
    const fallback = await fetchViaCloudFunction(missing)
    Object.assign(map, fallback)
  }
  const stillMissing = fileIDs.filter(id => !map[id])
  if (stillMissing.length) {
    const retry = await fetchViaClientApi(stillMissing)
    Object.assign(map, retry)
  }
  return map
}
export async function resolveCloudUrls(fileIDs: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const needResolve: string[] = []
  for (const id of fileIDs) {
    if (!id) continue
    if (!id.startsWith('cloud://')) { result[id] = id; continue }
    const cached = cacheGet(id)
    if (cached) result[id] = cached
    else needResolve.push(id)
  }
  const unique = [...new Set(needResolve)]
  if (unique.length) {
    const fetched = await fetchCloudUrls(unique)
    Object.assign(result, fetched)
  }
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