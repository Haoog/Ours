import { MomentLocation, MomentTag } from './types'
import { coupleId, requireSession } from './session'
import { todayKey } from './date'

export interface EditDraftFields {
  content: string
  tagSelected: MomentTag
  momentDate: string
  locationFull: MomentLocation | null
}

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
  editBase?: EditDraftFields
}

const copied = new Map<string, Map<string, string>>()
const saveQueues = new Map<string, Promise<void>>()
const queuedMedia = new Map<string, Set<string[]>>()

export function newPublishId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function draftKey(editId = ''): string {
  return `OURS_DRAFT_V2_${coupleId()}_${requireSession().role}_${editId || 'new'}`
}

function folder(requestId: string): string {
  if (!/^[\w.-]+$/.test(requestId)) throw new Error('草稿编号无效')
  return `${wx.env.USER_DATA_PATH}/ours-draft-${requestId}`
}

function mediaPaths(draft: ComposeDraft): string[] {
  return [
    ...draft.images, draft.video, draft.videoCover,
    ...draft.livePhotos.flatMap(item => [item.cover, item.video]), draft.voice?.path || '',
  ]
}

function removeCopy(fs: WechatMiniprogram.FileSystemManager, file: string): void {
  try { fs.unlinkSync(file) } catch { /* next successful save can retry */ }
}

function pruneCopies(fs: WechatMiniprogram.FileSystemManager, directory: string, retained: Set<string>): void {
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return }
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) continue
    const file = `${directory}/${name}`
    if (!retained.has(file)) removeCopy(fs, file)
  }
}

export async function saveComposeDraft(snapshot: ComposeDraft, editId = ''): Promise<void> {
  const { coupleId, role, openid } = requireSession()
  const key = draftKey(editId)
  const directory = folder(snapshot.requestId)
  const files = mediaPaths(snapshot)
  const queued = queuedMedia.get(directory) || new Set<string[]>()
  queuedMedia.set(directory, queued)
  queued.add(files)

  const checkIdentity = () => {
    const current = requireSession()
    if (current.coupleId !== coupleId || current.role !== role || current.openid !== openid) {
      throw new Error('空间或账号已切换，草稿未保存')
    }
  }
  const save = async () => {
    checkIdentity()
    const fs = wx.getFileSystemManager()
    const cache = copied.get(directory) || new Map<string, string>()
    const created = new Map<string, string>()
    const copy = async (file: string) => {
      if (!file || file.startsWith('cloud://') || file.startsWith(directory + '/') || cache.has(file)) return
      try { fs.mkdirSync(directory, true) } catch { /* already created */ }
      const ext = file.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.bin'
      const target = `${directory}/${newPublishId()}${ext}`
      created.set(file, target)
      await new Promise<void>((resolve, reject) => fs.copyFile({
        srcPath: file, destPath: target, success: () => resolve(), fail: reject,
      }))
    }
    const persist = (file: string) => created.get(file) || cache.get(file) || file
    let draft: ComposeDraft
    try {
      // 等所有复制结束，失败时也能回收这次写入的半成品。
      const results = await Promise.allSettled(Array.from(new Set(files), copy))
      for (const result of results) if (result.status === 'rejected') throw result.reason
      draft = {
        ...snapshot,
        images: snapshot.images.map(persist),
        video: persist(snapshot.video),
        videoCover: persist(snapshot.videoCover),
        livePhotos: snapshot.livePhotos.map(item => ({ ...item, cover: persist(item.cover), video: persist(item.video) })),
        voice: snapshot.voice ? { ...snapshot.voice, path: persist(snapshot.voice.path) } : null,
      }
      checkIdentity()
      wx.setStorageSync(key, draft)
    } catch (error) {
      for (const target of created.values()) removeCopy(fs, target)
      throw error
    }

    for (const [source, target] of created) cache.set(source, target)
    const retained = new Set(mediaPaths(draft))
    for (const pendingFiles of queued) {
      if (pendingFiles === files) continue
      for (const file of pendingFiles) retained.add(persist(file))
    }
    pruneCopies(fs, directory, retained)
    for (const [source, target] of cache) if (!retained.has(target)) cache.delete(source)
    if (cache.size) copied.set(directory, cache)
    else copied.delete(directory)
  }

  const previous = saveQueues.get(key)
  const pending = (previous ? previous.then(save, save) : save()).finally(() => {
    queued.delete(files)
    if (!queued.size) queuedMedia.delete(directory)
    if (saveQueues.get(key) === pending) saveQueues.delete(key)
  })
  saveQueues.set(key, pending)
  return pending
}

export async function waitForComposeDraftSave(editId = ''): Promise<void> {
  const key = draftKey(editId)
  let pending = saveQueues.get(key)
  while (pending) {
    try { await pending } catch { /* read the last successfully saved draft */ }
    pending = saveQueues.get(key)
  }
}

export function readComposeDraft(editId = ''): (ComposeDraft & { missingMedia: boolean }) | null {
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
    if (!file) return false
    if (file.startsWith('cloud://')) return true
    try { wx.getFileSystemManager().accessSync(file); return true } catch { return false }
  }
  const images = (draft.images || []).filter(exists)
  const video = exists(draft.video) ? draft.video : ''
  const videoCover = video && exists(draft.videoCover) ? draft.videoCover : ''
  const livePhotos = (draft.livePhotos || []).filter(item => exists(item.cover) && exists(item.video))
  const voice = draft.voice && exists(draft.voice.path) ? draft.voice : null
  const missingMedia = images.length !== (draft.images || []).length || livePhotos.length !== (draft.livePhotos || []).length ||
    (!video && !!draft.video) || (!videoCover && !!draft.videoCover) || (!voice && !!draft.voice)
  return { ...draft, images, video, videoCover, livePhotos, voice, missingMedia }
}

export function clearComposeDraft(requestId: string, editId = ''): void {
  const key = draftKey(editId)
  const directory = folder(requestId)
  const stored = wx.getStorageSync(key) as ComposeDraft | undefined
  if (stored?.requestId !== requestId || saveQueues.has(key) || queuedMedia.has(directory)) return
  wx.removeStorageSync(key)
  try { wx.getFileSystemManager().rmdirSync(directory, true) } catch { /* no local files */ }
  copied.delete(directory)
}
