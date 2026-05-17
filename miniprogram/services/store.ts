// services/store.ts — v0.1 云开发数据层

import { getAppInstance } from '../app'
import { callOurs } from './cloud-api'
import {
  coupleId,
  getSession,
  requireSession,
  clearSessionCache,
  bootstrapSession,
  createCoupleAndCache,
} from './session'
import { todayKey } from './date'
import {
  Couple,
  Moment,
  MomentLocation,
  MomentVoice,
  MomentLivePhoto,
  MomentTag,
  Checkin,
  Mood,
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

export function getCouple(): Couple | null {
  return getSession()?.couple ?? null
}

export async function refreshCouple(): Promise<Couple | null> {
  const s = await bootstrapSession()
  return s.couple
}

export async function createCouple(input: {
  startDate: string
  nickname: string
  avatarUrl?: string
}): Promise<Couple> {
  const s = await createCoupleAndCache(input)
  return s.couple!
}

export async function updateStartDate(startDate: string): Promise<Couple> {
  const couple = await callOurs<Couple>('updateStartDate', {
    coupleId: coupleId(),
    startDate,
  })
  const s = requireSession()
  s.couple = couple
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
  return couple
}

export async function uploadAvatar(localPath: string): Promise<string> {
  const cid = coupleId()
  const ext = fileExt(localPath, 'jpg')
  const cloudPath = `avatars/${cid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
  return uploadOne(localPath, cloudPath)
}

export async function clearAll(): Promise<void> {
  await callOurs('clearAll', { coupleId: coupleId() })
  clearSessionCache()
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

/** 仅开发/体验版：注入演示动态与签到（纯文字，无需上传媒体） */
export async function seedDemoData(reset = true): Promise<{
  moments: number
  checkins: number
  streakDays?: number
  anniversaries?: number
  rants?: number
  notes?: number
}> {
  const envVersion = getAppInstance().globalData.envVersion
  return callOurs<{
    moments: number
    checkins: number
    streakDays?: number
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

function uploadOne(
  filePath: string,
  cloudPath: string,
  onFileProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({ cloudPath, filePath })
    if (onFileProgress && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate(res => onFileProgress(res.progress))
    }
    task.then(res => resolve(res.fileID)).catch(reject)
  })
}

type ProgressCtx = { onProgress?: UploadProgressFn; base: number; span: number; label: string }

async function uploadLocalFiles(
  localPaths: string[],
  subfolder: 'images' | 'videos' | 'voices',
  defaultExt: string,
  progress?: ProgressCtx,
): Promise<string[]> {
  const cid = coupleId()
  const fileIDs: string[] = []
  const locals = localPaths.filter(p => !p.startsWith('cloud://'))
  let localDone = 0

  for (const filePath of localPaths) {
    if (filePath.startsWith('cloud://')) {
      fileIDs.push(filePath)
      continue
    }
    const ext = fileExt(filePath, defaultExt)
    const cloudPath = `moments/${cid}/${subfolder}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`
    const fileNo = localDone + 1
    const id = await uploadOne(filePath, cloudPath, p => {
      if (!progress?.onProgress || locals.length === 0) return
      const slice = progress.span / locals.length
      const overall = progress.base + slice * (localDone + p / 100)
      progress.onProgress(Math.min(99, Math.round(overall)), `${progress.label} ${fileNo}/${locals.length}`)
    })
    localDone += 1
    fileIDs.push(id)
  }
  return fileIDs
}

export async function uploadMomentImages(
  localPaths: string[],
  onProgress?: UploadProgressFn,
): Promise<string[]> {
  return uploadLocalFiles(localPaths, 'images', 'jpg', {
    onProgress,
    base: 0,
    span: 70,
    label: '上传图片',
  })
}

export async function uploadMomentVideos(
  localPaths: string[],
  onProgress?: UploadProgressFn,
): Promise<string[]> {
  return uploadLocalFiles(localPaths, 'videos', 'mp4', {
    onProgress,
    base: 70,
    span: 20,
    label: '上传视频',
  })
}

export async function uploadMomentVoice(localPath: string, onProgress?: UploadProgressFn): Promise<string> {
  const ids = await uploadLocalFiles([localPath], 'voices', 'mp3', {
    onProgress,
    base: 90,
    span: 8,
    label: '上传语音',
  })
  return ids[0]
}

export async function resolveCloudUrl(fileID: string): Promise<string> {
  if (!fileID.startsWith('cloud://')) return fileID
  const res = await wx.cloud.getTempFileURL({ fileList: [fileID] })
  const item = res.fileList[0]
  if (!item || item.status !== 0 || !item.tempFileURL) {
    throw new Error('媒体加载失败')
  }
  return item.tempFileURL
}

async function uploadLivePhotos(
  items: { cover: string; video: string; duration: number }[],
  onProgress?: UploadProgressFn,
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
          base,
          span: span * 0.4,
          label: `实况封面 ${i + 1}/${total}`,
        }))[0]
    const video = lp.video.startsWith('cloud://')
      ? lp.video
      : (await uploadLocalFiles([lp.video], 'videos', 'mov', {
          onProgress,
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
  livePhotos?: { cover: string; video: string; duration: number }[]
  voices?: { path: string; duration: number }[]
}): number {
  let n = 0
  for (const p of input.images) if (!p.startsWith('cloud://')) n++
  for (const p of input.videos ?? []) if (!p.startsWith('cloud://')) n++
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

  let images = input.images
  if (images.some(p => !p.startsWith('cloud://'))) {
    const locals = images.filter(p => !p.startsWith('cloud://'))
    const uploaded = await uploadMomentImages(locals, (p, h) => tick(Math.min(55, p), h))
    let u = 0
    images = images.map(p => (p.startsWith('cloud://') ? p : uploaded[u++]))
  }

  let videos = input.videos ?? []
  if (videos.some(p => !p.startsWith('cloud://'))) {
    const locals = videos.filter(p => !p.startsWith('cloud://'))
    const uploaded = await uploadMomentVideos(locals, (p, h) => tick(55 + Math.min(25, p * 0.25), h))
    let u = 0
    videos = videos.map(p => (p.startsWith('cloud://') ? p : uploaded[u++]))
  }

  let livePhotos: MomentLivePhoto[] = []
  if (input.livePhotos && input.livePhotos.length > 0) {
    tick(80, '上传实况…')
    livePhotos = await uploadLivePhotos(input.livePhotos, (p, h) => tick(80 + Math.min(15, p * 0.15), h))
  }

  let voices: MomentVoice[] = []
  if (input.voices && input.voices.length > 0) {
    const v = input.voices[0]
    const fileID = v.path.startsWith('cloud://')
      ? v.path
      : await uploadMomentVoice(v.path, (p, h) => tick(95 + Math.min(4, p * 0.04), h))
    voices = [{ fileID, duration: v.duration }]
  }

  tick(98, '保存记录…')
  const moment = await callOurs<Moment>('addMoment', {
    coupleId: coupleId(),
    content: input.content,
    images,
    videos,
    livePhotos,
    voices,
    location: input.location,
    tag: input.tag ?? '',
    momentDate: input.momentDate,
  })
  tick(100, '完成')
  return moment
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

export async function listMapPlaces(): Promise<{ places: MapPlace[]; cities: MapCityStat[] }> {
  return callOurs<{ places: MapPlace[]; cities: MapCityStat[] }>('listMapPlaces', {
    coupleId: coupleId(),
  })
}

export async function deleteMoment(momentId: string): Promise<void> {
  await callOurs('deleteMoment', { coupleId: coupleId(), momentId })
}

export async function getCheckinState(date?: string) {
  const day = date ?? todayKey()
  return callOurs<{
    checkins: Checkin[]
    bothChecked: boolean
    hasCheckedIn: boolean
    streakDays: number
  }>('getCheckinState', { coupleId: coupleId(), date: day })
}

export async function listCheckins(year: number, month: number): Promise<Checkin[]> {
  return callOurs<Checkin[]>('listCheckins', { coupleId: coupleId(), year, month })
}

export async function addCheckin(input: { mood: Mood | null; note: string }) {
  const result = await callOurs<{
    checkin: Checkin
    bothChecked: boolean
    streakDays: number
  }>('addCheckin', {
    coupleId: coupleId(),
    mood: input.mood,
    note: input.note,
  })
  const s = requireSession()
  if (s.couple) s.couple.streakDays = result.streakDays
  return result
}
