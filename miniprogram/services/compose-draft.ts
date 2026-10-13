import { MomentLocation, MomentTag } from './types'
import { coupleId, requireSession } from './session'
import { todayKey } from './date'

export interface ComposeDraft {
  requestId: string
  content: string
  tagSelected: MomentTag
  momentDate: string
  location: string
  locationFull: MomentLocation | null
  images: string[]
  video: string
  videoCover: string
  livePhotos: { id: string; cover: string; video: string; duration: number }[]
  voice: { path: string; duration: number } | null
  pendingResult?: boolean
}

const copied = new Map<string, string>()

export function newPublishId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function draftKey(editId = ''): string {
  return `OURS_DRAFT_V2_${coupleId()}_${requireSession().role}_${editId || 'new'}`
}

function folder(requestId: string): string {
  return `${wx.env.USER_DATA_PATH}/ours-draft-${requestId}`
}

async function keepFile(filePath: string, requestId: string): Promise<string> {
  // 草稿持久化自己的副本，避免临时媒体失效，也不删除用户原文件。
  if (!filePath || filePath.startsWith('cloud://') || filePath.startsWith(folder(requestId) + '/')) return filePath
  const key = `${requestId}:${filePath}`
  const existing = copied.get(key)
  if (existing) return existing
  const fs = wx.getFileSystemManager()
  const directory = folder(requestId)
  try { fs.mkdirSync(directory, true) } catch { /* already created */ }
  const ext = filePath.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.bin'
  const target = `${directory}/${newPublishId()}${ext}`
  await new Promise<void>((resolve, reject) => fs.copyFile({
    srcPath: filePath, destPath: target, success: () => resolve(), fail: reject,
  }))
  copied.set(key, target)
  return target
}

export async function saveComposeDraft(snapshot: ComposeDraft, editId = ''): Promise<void> {
  const persist = (file: string) => keepFile(file, snapshot.requestId)
  const draft: ComposeDraft = {
    ...snapshot,
    images: await Promise.all(snapshot.images.map(persist)),
    video: await persist(snapshot.video),
    videoCover: await persist(snapshot.videoCover),
    livePhotos: await Promise.all(snapshot.livePhotos.map(async item => ({
      ...item, cover: await persist(item.cover), video: await persist(item.video),
    }))),
    voice: snapshot.voice ? { ...snapshot.voice, path: await persist(snapshot.voice.path) } : null,
  }
  wx.setStorageSync(draftKey(editId), draft)
}

export function readComposeDraft(editId = ''): ComposeDraft | null {
  let draft = wx.getStorageSync(draftKey(editId)) as ComposeDraft | undefined
  if (!draft && !editId) {
    const legacy = wx.getStorageSync('OURS_COMPOSE_DRAFT')
    if (legacy?.content) {
      draft = {
        requestId: newPublishId(), content: legacy.content, tagSelected: legacy.tag || 'daily',
        momentDate: todayKey(), location: '', locationFull: null,
        images: [], video: '', videoCover: '', livePhotos: [], voice: null,
      }
      wx.setStorageSync(draftKey(), draft)
      wx.removeStorageSync('OURS_COMPOSE_DRAFT')
    }
  }
  if (!draft?.requestId) return null
  const exists = (file: string) => {
    if (!file || file.startsWith('cloud://')) return true
    try { wx.getFileSystemManager().accessSync(file); return true } catch { return false }
  }
  return {
    ...draft,
    images: (draft.images || []).filter(exists),
    video: exists(draft.video) ? draft.video : '',
    videoCover: exists(draft.videoCover) ? draft.videoCover : '',
    livePhotos: (draft.livePhotos || []).filter(item => exists(item.cover) && exists(item.video)),
    voice: draft.voice && exists(draft.voice.path) ? draft.voice : null,
  }
}

export function clearComposeDraft(requestId: string, editId = ''): void {
  wx.removeStorageSync(draftKey(editId))
  try { wx.getFileSystemManager().rmdirSync(folder(requestId), true) } catch { /* no local files */ }
  for (const key of copied.keys()) if (key.startsWith(requestId + ':')) copied.delete(key)
}
