// services/store.ts — v0.1 云开发数据层

import { getAppInstance } from '../app'
import { callOurs } from './cloud-api'
import { resolveCloudUrl as resolveCachedCloudUrl } from '../utils/cloud-url-cache'
import { asyncPool } from '../utils/async-pool'
import {
  coupleId,
  getSession,
  requireSession,
  bootstrapSession,
  redeemAccessCodeAndCache,
  persistSession,
} from './session'
import {
  Couple,
  Moment,
  MomentLocation,
  MomentVoice,
  MomentLivePhoto,
  MomentTag,
  Anniversary,
  AnniversaryNext,
  Rant,
  LoveNote,
  MomentComment,
  MomentLikes,
  MapPlace,
  MapCityStat,
  MomentsStats,
  MomentCollectionTag,
  MomentCollectionPlace,
  MomentNeighbors,
  MomentsBriefStats,
  PetView,
} from './types'

export { todayKey, daysBetween } from './date'

export type UploadProgressFn = (percent: number, hint: string) => void

export function getIdentity() {
  const s = requireSession()
  const member = s.role === 'A' ? s.couple!.memberA : s.couple!.memberB!
  return {
    openid: s.openid,
    role: s.role,
    nickname: member.nickname,
    avatarUrl: member.avatarUrl,
  }
}

/** 按当前登录角色返回“我”和“对方”，避免页面固定使用 memberA。 */
export function getRelationshipMembers() {
  const s = requireSession()
  const couple = s.couple!
  if (s.role === 'A') {
    return { me: couple.memberA, partner: couple.memberB }
  }
  return { me: couple.memberB!, partner: couple.memberA }
}

export function getCouple(): Couple | null {
  return getSession()?.couple ?? null
}

export async function refreshCouple(): Promise<Couple | null> {
  const s = await bootstrapSession()
  return s.couple
}

export async function redeemAccessCode(input: {
  code: string
  startDate: string
  nickname: string
  avatarUrl?: string
}): Promise<Couple> {
  const s = await redeemAccessCodeAndCache(input)
  return s.couple!
}

export async function createPartnerInvite(): Promise<{ token: string; expiresAt: number }> {
  return callOurs<{ token: string; expiresAt: number }>('createPartnerInvite', {
    coupleId: coupleId(),
  })
}

export async function updateStartDate(startDate: string): Promise<Couple> {
  const couple = await callOurs<Couple>('updateStartDate', {
    coupleId: coupleId(),
    startDate,
  })
  const s = requireSession()
  s.couple = couple
  persistSession()
  return couple
}

export async function updateProfile(input: { nickname: string; avatarUrl?: string }): Promise<Couple> {
  const payload: Record<string, string> = {
    coupleId: coupleId(),
    nickname: input.nickname,
  }
  if (input.avatarUrl !== undefined) payload.avatarUrl = input.avatarUrl
  const couple = await callOurs<Couple>('updateProfile', payload)
  const s = requireSession()
  s.couple = couple
  persistSession()
  return couple
}

export async function uploadAvatar(localPath: string): Promise<string> {
  const cid = coupleId()
  const ext = fileExt(localPath, 'jpg')
  const cloudPath = `avatars/${cid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
  return uploadOne(localPath, cloudPath)
}

const DEFAULT_PAGE_SIZE = 20

export interface MomentsPage {
  items: Moment[]
  total: number
  hasMore: boolean
}

export async function listMomentsPage(options?: {
  limit?: number
  skip?: number
  tag?: MomentTag | ''
  mediaFilter?: 'image' | 'voice' | 'live' | ''
  keyword?: string
}): Promise<MomentsPage> {
  const payload: Record<string, unknown> = {
    coupleId: coupleId(),
    limit: options?.limit ?? DEFAULT_PAGE_SIZE,
    skip: options?.skip ?? 0,
  }
  if (options?.tag) payload.tag = options.tag
  if (options?.mediaFilter) payload.mediaFilter = options.mediaFilter
  const action = options?.keyword?.trim() ? 'searchMoments' : 'listMoments'
  if (options?.keyword?.trim()) payload.keyword = options.keyword.trim()
  const data = await callOurs<MomentsPage | Moment[]>(action, payload)
  if (Array.isArray(data)) {
    return { items: data, total: data.length, hasMore: false }
  }
  return data
}

export async function getOnThisDayMoments(): Promise<Moment[]> {
  return callOurs<Moment[]>('getOnThisDay', { coupleId: coupleId() })
}

export async function getMomentsStats(year: number, month?: number): Promise<MomentsStats> {
  return callOurs<MomentsStats>('getMomentsStats', {
    coupleId: coupleId(),
    year,
    month: month ?? 0,
  })
}

export async function listMomentCollections(): Promise<{
  tags: MomentCollectionTag[]
  places: MomentCollectionPlace[]
}> {
  return callOurs<{ tags: MomentCollectionTag[]; places: MomentCollectionPlace[] }>(
    'listMomentCollections',
    { coupleId: coupleId() },
  )
}

export async function getMomentNeighbors(
  momentId: string,
  tag?: MomentTag | '',
): Promise<MomentNeighbors> {
  const payload: Record<string, unknown> = { coupleId: coupleId(), momentId }
  if (tag) payload.tag = tag
  return callOurs<MomentNeighbors>('getMomentNeighbors', payload)
}

export async function getMomentsBriefStats(): Promise<MomentsBriefStats> {
  return callOurs<MomentsBriefStats>('getMomentsBriefStats', { coupleId: coupleId() })
}

export async function getPet(): Promise<PetView> {
  return callOurs<PetView>('getPet', { coupleId: coupleId() })
}

export async function adoptPet(name: string): Promise<PetView> {
  return callOurs<PetView>('adoptPet', { coupleId: coupleId(), name })
}

export async function petInteract(action: 'feed' | 'pet'): Promise<PetView> {
  return callOurs<PetView>('petInteract', { coupleId: coupleId(), action })
}

/** 仅开发/体验版：注入演示动态与纪念日（纯文字，无需上传媒体） */
export async function seedDemoData(reset = true): Promise<{
  moments: number
  anniversaries?: number
  rants?: number
  notes?: number
}> {
  const envVersion = getAppInstance().globalData.envVersion
  return callOurs<{
    moments: number
    anniversaries?: number
    rants?: number
    notes?: number
  }>('seedDemoData', {
    coupleId: coupleId(),
    envVersion,
    reset,
  })
}

export async function listMomentsRecent(limit = 3): Promise<Moment[]> {
  const page = await listMomentsPage({ limit, skip: 0 })
  return page.items
}

export async function getMoment(id: string): Promise<Moment | null> {
  return callOurs<Moment | null>('getMoment', { coupleId: coupleId(), momentId: id })
}

function fileExt(path: string, fallback: string): string {
  const m = /\.(\w+)(\?|$)/.exec(path)
  return m ? m[1] : fallback
}

/** 单文件失败重试次数（弱网/大文件容错） */
const UPLOAD_RETRY = 2
/** 仅在发布动态流程内跟踪上传任务，供「取消上传」中断 */
let trackingUploads = false
let activeUploadTasks: { abort: () => void }[] = []
let uploadAborted = false

function resetUploadState() {
  activeUploadTasks = []
  uploadAborted = false
}

/** 取消当前发布的所有在途上传 */
export function cancelMomentUpload(): void {
  uploadAborted = true
  for (const t of activeUploadTasks) {
    try {
      t.abort()
    } catch (e) {}
  }
  activeUploadTasks = []
}

function uploadDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function uploadOne(
  filePath: string,
  cloudPath: string,
  onFileProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({ cloudPath, filePath }) as any
    if (trackingUploads && task && typeof task.abort === 'function') {
      activeUploadTasks.push(task)
    }
    if (onFileProgress && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((res: any) => onFileProgress(res.progress))
    }
    task.then((res: any) => resolve(res.fileID)).catch(reject)
  })
}

async function uploadOneWithRetry(
  filePath: string,
  cloudPath: string,
  onFileProgress?: (percent: number) => void,
): Promise<string> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= UPLOAD_RETRY; attempt++) {
    if (uploadAborted) throw new Error('已取消上传')
    try {
      return await uploadOne(filePath, cloudPath, onFileProgress)
    } catch (err) {
      lastErr = err
      if (uploadAborted) throw new Error('已取消上传')
      if (attempt < UPLOAD_RETRY) await uploadDelay(600 * (attempt + 1))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('上传失败')
}

type ProgressCtx = {
  onProgress?: UploadProgressFn
  onUploaded?: (fileID: string, bytes: number) => void
  base: number
  span: number
  label: string
}

/** 上传并发数：多图/多实况时显著快于串行 */
const UPLOAD_CONCURRENCY = 4

function localFileSize(filePath: string): Promise<number> {
  return new Promise(resolve => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: res => resolve(Number(res.size) || 0),
        fail: () => resolve(0),
      })
    } catch {
      resolve(0)
    }
  })
}

async function uploadLocalFiles(
  localPaths: string[],
  subfolder: 'images' | 'videos' | 'voices',
  defaultExt: string,
  progress?: ProgressCtx,
): Promise<string[]> {
  const cid = coupleId()
  const locals = localPaths.filter(p => !p.startsWith('cloud://'))
  let localDone = 0

  // asyncPool 保序：返回的 fileID 顺序与 localPaths 一致
  return asyncPool(localPaths, UPLOAD_CONCURRENCY, async filePath => {
    if (filePath.startsWith('cloud://')) return filePath
    const ext = fileExt(filePath, defaultExt)
    const bytes = await localFileSize(filePath)
    const cloudPath = `moments/${cid}/${subfolder}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`
    const id = await uploadOneWithRetry(filePath, cloudPath, p => {
      if (!progress?.onProgress || locals.length === 0) return
      const slice = progress.span / locals.length
      const overall = progress.base + slice * (localDone + p / 100)
      const at = Math.min(localDone + 1, locals.length)
      progress.onProgress(Math.min(99, Math.round(overall)), `${progress.label} ${at}/${locals.length}`)
    })
    progress?.onUploaded?.(id, bytes)
    localDone += 1
    return id
  })
}

export async function uploadMomentImages(
  localPaths: string[],
  onProgress?: UploadProgressFn,
  onUploaded?: (fileID: string, bytes: number) => void,
): Promise<string[]> {
  return uploadLocalFiles(localPaths, 'images', 'jpg', {
    onProgress,
    onUploaded,
    base: 0,
    span: 70,
    label: '上传图片',
  })
}

export async function uploadMomentVideos(
  localPaths: string[],
  onProgress?: UploadProgressFn,
  onUploaded?: (fileID: string, bytes: number) => void,
): Promise<string[]> {
  return uploadLocalFiles(localPaths, 'videos', 'mp4', {
    onProgress,
    onUploaded,
    base: 70,
    span: 20,
    label: '上传视频',
  })
}

export async function uploadMomentVoice(
  localPath: string,
  onProgress?: UploadProgressFn,
  onUploaded?: (fileID: string, bytes: number) => void,
): Promise<string> {
  const ids = await uploadLocalFiles([localPath], 'voices', 'mp3', {
    onProgress,
    onUploaded,
    base: 90,
    span: 8,
    label: '上传语音',
  })
  return ids[0]
}

export async function resolveCloudUrl(fileID: string): Promise<string> {
  const url = await resolveCachedCloudUrl(fileID)
  if (!url && fileID.startsWith('cloud://')) throw new Error('媒体加载失败')
  return url
}

async function uploadLivePhotos(
  items: { cover: string; video: string; duration: number }[],
  onProgress?: UploadProgressFn,
  onUploaded?: (fileID: string, bytes: number) => void,
): Promise<MomentLivePhoto[]> {
  const out: MomentLivePhoto[] = []
  const total = items.length
  for (let i = 0; i < items.length; i++) {
    const lp = items[i]
    const base = 50 + (40 * i) / Math.max(total, 1)
    const span = 40 / Math.max(total, 1)
    const cover = lp.cover.startsWith('cloud://')
      ? lp.cover
      : (await uploadLocalFiles([lp.cover], 'images', 'jpg', {
          onProgress,
          onUploaded,
          base,
          span: span * 0.4,
          label: `实况封面 ${i + 1}/${total}`,
        }))[0]
    const video = lp.video.startsWith('cloud://')
      ? lp.video
      : (await uploadLocalFiles([lp.video], 'videos', 'mov', {
          onProgress,
          onUploaded,
          base: base + span * 0.4,
          span: span * 0.6,
          label: `实况视频 ${i + 1}/${total}`,
        }))[0]
    out.push({ cover, video, duration: lp.duration })
  }
  return out
}

function countLocalUploads(input: {
  images: string[]
  videos?: string[]
  videoCover?: string
  livePhotos?: { cover: string; video: string; duration: number }[]
  voices?: { path: string; duration: number }[]
}): number {
  let n = 0
  for (const p of input.images) if (!p.startsWith('cloud://')) n++
  for (const p of input.videos ?? []) if (!p.startsWith('cloud://')) n++
  if (input.videoCover && !input.videoCover.startsWith('cloud://')) n++
  for (const lp of input.livePhotos ?? []) {
    if (!lp.cover.startsWith('cloud://')) n++
    if (!lp.video.startsWith('cloud://')) n++
  }
  if (input.voices?.[0] && !input.voices[0].path.startsWith('cloud://')) n++
  return n
}

export async function addMoment(
  input: {
    content: string
    images: string[]
    videos?: string[]
    videoCover?: string
    livePhotos?: { cover: string; video: string; duration: number }[]
    voices?: { path: string; duration: number }[]
    location: MomentLocation | null
    tag?: MomentTag | ''
    momentDate?: string
  },
  onProgress?: UploadProgressFn,
): Promise<Moment> {
  const tick = (pct: number, hint: string) => onProgress?.(pct, hint)
  const hasUpload = countLocalUploads(input) > 0
  if (hasUpload) tick(2, '准备上传…')

  const cid = coupleId()
  const uploadedFileIDs: string[] = []
  let uploadedMediaBytes = 0
  const trackUploaded = (fileID: string, bytes: number) => {
    uploadedFileIDs.push(fileID)
    uploadedMediaBytes += Math.max(0, Number(bytes) || 0)
  }

  resetUploadState()
  trackingUploads = true
  try {
    await callOurs('validateMoment', {
      coupleId: cid,
      content: input.content,
      tag: input.tag ?? '',
      momentDate: input.momentDate,
    })

    let images = input.images
    let videos = input.videos ?? []
    let videoCover = videos.length ? input.videoCover ?? '' : ''
    const imageLocals = [
      ...images.filter(p => !p.startsWith('cloud://')),
      ...(videoCover && !videoCover.startsWith('cloud://') ? [videoCover] : []),
    ]
    if (imageLocals.length > 0) {
      const uploaded = await uploadMomentImages(imageLocals, (p, h) => tick(Math.min(55, p), h), trackUploaded)
      let u = 0
      images = images.map(p => (p.startsWith('cloud://') ? p : uploaded[u++]))
      if (videoCover && !videoCover.startsWith('cloud://')) videoCover = uploaded[u++]
    }

    if (videos.some(p => !p.startsWith('cloud://'))) {
      const locals = videos.filter(p => !p.startsWith('cloud://'))
      const uploaded = await uploadMomentVideos(locals, (p, h) => tick(55 + Math.min(25, p * 0.25), h), trackUploaded)
      let u = 0
      videos = videos.map(p => (p.startsWith('cloud://') ? p : uploaded[u++]))
    }

    let livePhotos: MomentLivePhoto[] = []
    if (input.livePhotos && input.livePhotos.length > 0) {
      tick(80, '上传实况…')
      livePhotos = await uploadLivePhotos(input.livePhotos, (p, h) => tick(80 + Math.min(15, p * 0.15), h), trackUploaded)
    }

    let voices: MomentVoice[] = []
    if (input.voices && input.voices.length > 0) {
      const v = input.voices[0]
      const fileID = v.path.startsWith('cloud://')
        ? v.path
        : await uploadMomentVoice(v.path, (p, h) => tick(95 + Math.min(4, p * 0.04), h), trackUploaded)
      voices = [{ fileID, duration: v.duration }]
    }

    tick(98, '保存记录…')
    const moment = await callOurs<Moment>('addMoment', {
      coupleId: cid,
      content: input.content,
      images,
      videos,
      videoCover,
      livePhotos,
      voices,
      mediaBytes: uploadedMediaBytes,
      location: input.location,
      tag: input.tag ?? '',
      momentDate: input.momentDate,
    })
    tick(100, '完成')
    return moment
  } catch (err) {
    if (uploadedFileIDs.length > 0) {
      await callOurs('cleanupUploadedFiles', { coupleId: cid, fileIDs: uploadedFileIDs }).catch(() => undefined)
    }
    throw err
  } finally {
    trackingUploads = false
    activeUploadTasks = []
  }
}

export async function listAnniversaries(): Promise<Anniversary[]> {
  return callOurs<Anniversary[]>('listAnniversaries', { coupleId: coupleId() })
}

export async function addAnniversary(input: {
  title: string
  date: string
  yearly?: boolean
  remind?: boolean
}): Promise<Anniversary> {
  return callOurs<Anniversary>('addAnniversary', { coupleId: coupleId(), ...input })
}

export async function deleteAnniversary(anniversaryId: string): Promise<void> {
  await callOurs('deleteAnniversary', { coupleId: coupleId(), anniversaryId })
}

export async function getNextAnniversary(): Promise<AnniversaryNext | null> {
  return callOurs<AnniversaryNext | null>('getNextAnniversary', { coupleId: coupleId() })
}

export async function listRants(): Promise<Rant[]> {
  const raw = await callOurs<Rant[]>('listRants', { coupleId: coupleId() })
  return Array.isArray(raw) ? raw : []
}

export async function addRant(content: string, images: string[] = []): Promise<Rant> {
  return callOurs<Rant>('addRant', { coupleId: coupleId(), content, images })
}

export async function deleteRant(rantId: string): Promise<void> {
  await callOurs('deleteRant', { coupleId: coupleId(), rantId })
}

export async function uploadRantImages(localPaths: string[]): Promise<string[]> {
  return uploadLocalFiles(localPaths.slice(0, 3), 'images', 'jpg')
}

export async function listNotes(): Promise<LoveNote[]> {
  const raw = await callOurs<LoveNote[]>('listNotes', { coupleId: coupleId() })
  return Array.isArray(raw) ? raw : []
}

export async function sendNote(content: string): Promise<LoveNote> {
  return callOurs<LoveNote>('sendNote', { coupleId: coupleId(), content })
}

export async function markNoteRead(noteId: string): Promise<void> {
  await callOurs('markNoteRead', { coupleId: coupleId(), noteId })
}

export async function listComments(momentId: string): Promise<MomentComment[]> {
  return callOurs<MomentComment[]>('listComments', { coupleId: coupleId(), momentId })
}

export async function addComment(momentId: string, content: string): Promise<MomentComment> {
  return callOurs<MomentComment>('addComment', { coupleId: coupleId(), momentId, content })
}

export async function deleteComment(commentId: string): Promise<void> {
  await callOurs('deleteComment', { coupleId: coupleId(), commentId })
}

export async function getMomentLikes(momentId: string): Promise<MomentLikes> {
  return callOurs<MomentLikes>('getMomentLikes', { coupleId: coupleId(), momentId })
}

export async function toggleMomentLike(momentId: string): Promise<MomentLikes> {
  return callOurs<MomentLikes>('toggleMomentLike', { coupleId: coupleId(), momentId })
}

function mapLocationKey(location: MomentLocation | null | undefined): string {
  if (!location || location.latitude == null || location.longitude == null) return ''
  return `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`
}

/** 兼容旧版 listMapPlaces：旧云函数没有返回地点对应的最近回忆字段时，从回忆列表补齐。 */
async function hydrateMapPlaceStories(places: MapPlace[]): Promise<MapPlace[]> {
  if (!places.length) return places
  const latestByLocation = new Map<string, Moment>()
  let skip = 0
  for (let page = 0; page < 10; page++) {
    const result = await listMomentsPage({ limit: 50, skip })
    for (const moment of result.items) {
      const key = mapLocationKey(moment.location)
      if (key && !latestByLocation.has(key)) latestByLocation.set(key, moment)
    }
    if (!result.hasMore || result.items.length === 0) break
    skip += result.items.length
  }

  return Promise.all(places.map(async place => {
    const latest = latestByLocation.get(place.id)
    if (!latest) return place
    const cover =
      place.latestMomentCover ||
      latest.coverUrl ||
      latest.previewImages?.[0] ||
      latest.images?.[0] ||
      latest.livePhotos?.[0]?.cover ||
      ''
    let latestMomentCover = cover
    if (cover.startsWith('cloud://')) {
      try {
        latestMomentCover = await resolveCloudUrl(cover)
      } catch {
        latestMomentCover = ''
      }
    }
    return {
      ...place,
      latestMomentId: place.latestMomentId || latest.id,
      latestMomentDate: place.latestMomentDate || latest.momentDate || '',
      latestMomentContent: place.latestMomentContent || latest.content || '',
      latestMomentCover,
      latestMomentHasVideo: place.latestMomentHasVideo ?? (latest.videos?.length ?? 0) > 0,
    }
  }))
}

export async function listMapPlaces(): Promise<{ places: MapPlace[]; cities: MapCityStat[] }> {
  const data = await callOurs<{ places: MapPlace[]; cities: MapCityStat[] }>('listMapPlaces', {
    coupleId: coupleId(),
  })
  const needsStoryFallback = data.places.some(
    place => !place.latestMomentId || typeof place.latestMomentCover === 'undefined',
  )
  if (!needsStoryFallback) return data
  try {
    return { ...data, places: await hydrateMapPlaceStories(data.places) }
  } catch {
    // 地图本身仍可用；故事卡拿不到补充数据时保留地点统计和占位状态。
    return data
  }
}

export async function deleteMoment(momentId: string): Promise<void> {
  await callOurs('deleteMoment', { coupleId: coupleId(), momentId })
}

