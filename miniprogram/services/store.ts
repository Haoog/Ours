// services/store.ts — v0.1 云开发数据层

import { callOurs } from './cloud-api'
import { holdUpload, releaseUploads, forgetUploadHolds, retryUploadCleanup, fallbackUploadCleanup } from './upload-cleanup'
import { resolveCloudUrl as resolveCachedCloudUrl } from '../utils/cloud-url-cache'
import { asyncPool } from '../utils/async-pool'
import {
  coupleId,
  getSession,
  requireSession,
  bootstrapSession,
  captureCoupleWriteSession,
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
  const request = captureCoupleWriteSession()
  const couple = await callOurs<Couple>('updateStartDate', {
    coupleId: request.coupleId,
    startDate,
  })
  const s = request.getCurrent()
  if (s?.couple) {
    s.couple = { ...s.couple, startDate: couple.startDate }
    persistSession()
  }
  return couple
}

export async function updateProfile(input: { nickname: string; avatarUrl?: string }): Promise<Couple> {
  const request = captureCoupleWriteSession()
  const { nickname, avatarUrl } = input
  const couple = await callOurs<Couple>('updateProfile', {
    coupleId: request.coupleId,
    nickname,
    ...(avatarUrl == null ? {} : { avatarUrl }),
  })
  const s = request.getCurrent()
  const field = request.role === 'A' ? 'memberA' : 'memberB'
  const member = s?.couple?.[field]
  const updated = couple[field]
  if (s?.couple && member && updated) {
    s.couple = {
      ...s.couple,
      [field]: {
        ...member,
        nickname: updated.nickname,
        ...(avatarUrl == null ? {} : { avatarUrl: updated.avatarUrl }),
      },
    }
    persistSession()
  }
  return couple
}

export async function uploadAvatar(localPath: string): Promise<string> {
  const cid = coupleId()
  const ext = fileExt(localPath, 'jpg')
  const cloudPath = `avatars/${cid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
  return uploadOne(localPath, cloudPath)
}

const DEFAULT_PAGE_SIZE = 20

export interface MomentsCursor {
  momentDate: string
  createdAt: number
  id: string
}

export interface MomentsPage {
  items: Moment[]
  total: number
  hasMore: boolean
  // Omitted for offset responses, null when cursor pagination reaches the end.
  nextCursor?: MomentsCursor | null
}

export async function listMomentsPage(options?: {
  limit?: number
  skip?: number
  cursor?: MomentsCursor | null
  tag?: MomentTag | ''
  mediaFilter?: 'image' | 'voice' | 'live' | ''
  keyword?: string
  locationName?: string
  locationKey?: string
  year?: number
  month?: number
}): Promise<MomentsPage> {
  const payload: Record<string, unknown> = {
    coupleId: coupleId(),
    limit: options?.limit ?? DEFAULT_PAGE_SIZE,
    skip: options?.skip ?? 0,
  }
  if (options?.cursor !== undefined) payload.cursor = options.cursor
  if (options?.tag) payload.tag = options.tag
  if (options?.mediaFilter) payload.mediaFilter = options.mediaFilter
  if (options?.locationName) payload.locationName = options.locationName
  if (options?.locationKey) payload.locationKey = options.locationKey
  if (options?.year) payload.year = options.year
  if (options?.month) payload.month = options.month
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

/** 仅在启用演示数据的云环境：追加演示动态与纪念日（纯文字，无需上传媒体） */
export async function seedDemoData(): Promise<{
  moments: number
  anniversaries?: number
  rants?: number
  notes?: number
}> {
  return callOurs<{
    moments: number
    anniversaries?: number
    rants?: number
    notes?: number
  }>('seedDemoData', {
    coupleId: coupleId(),
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
let uploadOwner: { openid: string; coupleId: string } | null = null

function ensureUploadOwner(): void {
  if (!uploadOwner) return
  const session = getSession()
  if (!session || session.status !== 'ready' || session.openid !== uploadOwner.openid || session.coupleId !== uploadOwner.coupleId) {
    throw new Error('空间或账号已变化，请重新发布')
  }
}
let activeUploadTasks: { abort: () => void }[] = []
let uploadAborted = false

function resetUploadState() {
  activeUploadTasks = []
  uploadAborted = false
}

/** 取消当前发布的所有在途上传 */
export function cancelMomentUpload(): void {
  if (!trackingUploads) return
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
    let settled = false
    const task = wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: res => {
        settled = true
        resolve(res.fileID)
      },
      fail: err => {
        settled = true
        reject(err)
      },
    })
    if (trackingUploads && task && typeof task.abort === 'function') {
      activeUploadTasks.push(task)
    }
    if (onFileProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate(res => {
        if (!settled && !uploadAborted) onFileProgress(res.progress)
      })
    }
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

const VIDEO_MAX_LONG_SIDE = 1280
const VIDEO_MAX_BITRATE_KBPS = 2500
const VIDEO_MAX_FPS = 30

function getVideoInfo(filePath: string): Promise<WechatMiniprogram.GetVideoInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => {
    wx.getVideoInfo({
      src: filePath,
      success: resolve,
      fail: reject,
    })
  })
}

/** 发布普通视频前统一压到适合移动端回忆播放的规格；失败时不回退原视频。 */
async function compressVideoFile(filePath: string): Promise<string> {
  if (filePath.startsWith('cloud://')) return filePath

  try {
    const info = await getVideoInfo(filePath)
    const width = Number(info.width) || 0
    const height = Number(info.height) || 0
    const longSide = Math.max(width, height)
    const resolution = longSide > VIDEO_MAX_LONG_SIDE
      ? Math.max(0.1, Math.min(1, VIDEO_MAX_LONG_SIDE / longSide))
      : 1
    const sourceBitrate = Number(info.bitrate)
    const bitrate = Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? Math.min(sourceBitrate, VIDEO_MAX_BITRATE_KBPS)
      : VIDEO_MAX_BITRATE_KBPS
    const sourceFps = Number(info.fps)
    const fps = Number.isFinite(sourceFps) && sourceFps > 0
      ? Math.min(sourceFps, VIDEO_MAX_FPS)
      : VIDEO_MAX_FPS

    return await new Promise<string>((resolve, reject) => {
      wx.compressVideo({
        src: filePath,
        bitrate,
        fps,
        resolution,
        success: res => {
          if (res?.tempFilePath) resolve(res.tempFilePath)
          else reject(new Error('视频压缩失败，请重试'))
        },
        fail: () => reject(new Error('视频压缩失败，请重试')),
      })
    })
  } catch {
    throw new Error('视频压缩失败，请重试')
  }
}

async function compressMomentVideos(
  videos: string[],
  onProgress?: (percent: number, hint: string) => void,
): Promise<string[]> {
  const localCount = videos.filter(video => !video.startsWith('cloud://')).length
  if (!localCount) return videos

  let done = 0
  return Promise.all(videos.map(async video => {
    if (video.startsWith('cloud://')) return video
    onProgress?.(4 + Math.round((done / localCount) * 6), `压缩视频 ${done + 1}/${localCount}`)
    const compressed = await compressVideoFile(video)
    done += 1
    onProgress?.(4 + Math.round((done / localCount) * 6), `压缩视频 ${done}/${localCount}`)
    return compressed
  }))
}

async function uploadLocalFiles(
  localPaths: string[],
  subfolder: 'images' | 'videos' | 'voices',
  defaultExt: string,
  progress?: ProgressCtx,
): Promise<string[]> {
  if (trackingUploads) ensureUploadOwner()
  const cid = trackingUploads && uploadOwner ? uploadOwner.coupleId : coupleId()
  const localCount = localPaths.filter(p => !p.startsWith('cloud://')).length
  let localDone = 0
  let totalProgress = 0

  // asyncPool 保序：返回的 fileID 顺序与 localPaths 一致
  return asyncPool(localPaths, UPLOAD_CONCURRENCY, async filePath => {
    if (filePath.startsWith('cloud://')) return filePath
    const ext = fileExt(filePath, defaultExt)
    const bytes = await localFileSize(filePath)
    const cloudPath = `moments/${cid}/${subfolder}/${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`
    let fileProgress = 0
    const reportFileProgress = (percent: number) => {
      if (!progress?.onProgress || uploadAborted || !Number.isFinite(percent)) return
      const highest = Math.max(fileProgress, Math.min(100, percent))
      totalProgress += highest - fileProgress
      fileProgress = highest
      const overall = progress.base + progress.span * (totalProgress / (localCount * 100))
      progress.onProgress(Math.min(99, Math.round(overall)), `${progress.label} ${localDone + 1}/${localCount}`)
    }
    const id = await uploadOneWithRetry(filePath, cloudPath, reportFileProgress)
    progress?.onUploaded?.(id, bytes)
    reportFileProgress(100)
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

type PublishState = ['sending', receipt: string] | ['uncertain'] | ['correctable'] | ['different', momentId: string]

type PublishFields = Pick<Moment, 'content' | 'tag' | 'momentDate' | 'location'>
type PublishMedia = Pick<Moment, 'images' | 'videos' | 'videoCover' | 'livePhotos' | 'voices'>

function samePublishFields(saved: PublishFields, draft: PublishFields): boolean {
  const savedLocation = saved.location
  const draftLocation = draft.location
  return saved.content.trim() === draft.content.trim() && (saved.tag || '') === (draft.tag || '') &&
    (!draft.momentDate || saved.momentDate === draft.momentDate) &&
    (savedLocation && draftLocation
      ? savedLocation.name === draftLocation.name && savedLocation.address === draftLocation.address &&
        savedLocation.latitude === draftLocation.latitude && savedLocation.longitude === draftLocation.longitude
      : !savedLocation && !draftLocation)
}

function publishMediaReceipt({ images, videos, videoCover, livePhotos, voices }: PublishMedia): string {
  return JSON.stringify([
    images, videos || [], videoCover || '',
    (livePhotos || []).map(({ cover, video, duration }) => [cover, video, duration]),
    (voices || []).map(({ fileID, duration }) => [fileID, duration]),
  ])
}

// invoke marks every cloud ok=false as business, including service and database errors.
const correctableMomentValidationMessages = new Set([
  '已达到媒体数量额度，请联系管理员',
  '已达到存储空间额度，请联系管理员',
  '文字含有不合适的信息，请修改后重试',
  '日期格式不正确',
  '回忆日期不能晚于今天',
  '回忆日期不能早于「在一起」开始日',
])

function isCorrectableMomentValidation(error: unknown): boolean {
  const failure = error as { business?: boolean; message?: string } | undefined
  if (!failure?.business || !failure.message) return false
  return correctableMomentValidationMessages.has(failure.message) || /^一条动态最多添加 \d+ 个媒体文件$/.test(failure.message)
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
    requestId: string
  },
  onProgress?: UploadProgressFn,
  onCreateState?: (...event: PublishState) => void,
  pendingMediaReceipts: readonly string[] = [],
): Promise<Moment> {
  let reportedProgress = 0
  const tick = (pct: number, hint: string) => {
    reportedProgress = Math.max(reportedProgress, pct)
    onProgress?.(reportedProgress, hint)
  }
  const hasUpload = countLocalUploads(input) > 0
  if (hasUpload) tick(2, '准备上传…')

  const session = requireSession()
  const cid = session.coupleId!
  if (!session.openid) throw new Error('登录状态异常，请重新进入小程序')
  const owner = { openid: session.openid, coupleId: cid }
  const uploadedFileIDs: string[] = []
  let uploadedMediaBytes = 0
  const trackUploaded = (fileID: string, bytes: number) => {
    uploadedFileIDs.push(fileID)
    uploadedMediaBytes += Math.max(0, Number(bytes) || 0)
    try {
      holdUpload(owner, fileID)
    } catch {
      throw new Error('本地存储不可用，已停止发布，请检查存储空间后重试')
    }
  }
  const finishUploads = async (published: Set<string>) => {
    try {
      releaseUploads(owner, uploadedFileIDs, published)
      void retryUploadCleanup()
    } catch {
      const pending = uploadedFileIDs.filter(id => !published.has(id))
      const saved = await fallbackUploadCleanup(owner, pending)
      forgetUploadHolds(owner, uploadedFileIDs)
      void retryUploadCleanup()
      if (saved) {
        wx.showToast({ title: '本地存储不可用', icon: 'none', duration: 3000 })
      } else {
        wx.showModal({ title: '清理记录暂未保存', content: '请恢复网络和本地存储，并切回原账号和空间以重试。记录暂时仅保存在本次运行中，退出小程序后可能丢失。', showCancel: false })
      }
    }
  }

  resetUploadState()
  trackingUploads = true
  uploadOwner = owner
  try {
    const previous = await callOurs<Moment | null>('getPublishedMoment', { coupleId: cid, requestId: input.requestId })
    if (previous !== null) {
      if (!previous?.id) throw new Error('保存结果未确认，请重试')
      const receipt = publishMediaReceipt(previous)
      const current = publishMediaReceipt({
        ...input,
        videoCover: input.videos?.length ? input.videoCover : '',
        voices: input.voices?.slice(0, 1).map(({ path, duration }) => ({ fileID: path, duration })),
      })
      if (!samePublishFields(previous, input) || (receipt !== current && !pendingMediaReceipts.includes(receipt))) {
        onCreateState?.('different', previous.id)
      }
      return previous
    }
    if (!input.content.trim() && !input.images.length && !input.videos?.length && !input.livePhotos?.length && !input.voices?.length) {
      onCreateState?.('correctable')
      throw new Error('请填写文字或添加媒体')
    }
    const validate = async (payload: Record<string, unknown>) => {
      try {
        await callOurs('validateMoment', payload)
      } catch (error) {
        if (isCorrectableMomentValidation(error)) onCreateState?.('correctable')
        throw error
      }
    }
    const localPaths = [
      ...input.images, ...(input.videos || []), ...(input.videoCover ? [input.videoCover] : []),
      ...(input.livePhotos || []).flatMap(item => [item.cover, item.video]),
      ...(input.voices || []).map(item => item.path),
    ]
    const videoSources = new Set(input.videos || [])
    const mediaBytes = (await Promise.all(localPaths.filter(file => !videoSources.has(file)).map(localFileSize))).reduce((sum, size) => sum + size, 0)
    await validate({
      coupleId: cid,
      content: input.content,
      tag: input.tag ?? '',
      momentDate: input.momentDate,
      mediaItems: localPaths.length,
      mediaBytes,
    })

    let images = input.images
    let videos = input.videos ?? []
    let videoCover = videos.length ? input.videoCover ?? '' : ''

    if (videos.some(video => !video.startsWith('cloud://'))) {
      try {
        videos = await compressMomentVideos(videos, (p, h) => tick(p, h))
      } catch (error) {
        onCreateState?.('correctable')
        throw error
      }
      const compressedBytes = (await Promise.all(videos.map(localFileSize))).reduce((sum, size) => sum + size, 0)
      await validate({
        coupleId: cid, momentDate: input.momentDate, mediaItems: localPaths.length, mediaBytes: mediaBytes + compressedBytes,
      })
    }

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
        : await uploadMomentVoice(v.path, (p, h) => tick(95 + (p - 90) * 3 / 8, h), trackUploaded)
      voices = [{ fileID, duration: v.duration }]
    }

    tick(98, '保存记录…')
    if (uploadAborted) throw new Error('已取消上传')
    ensureUploadOwner()
    const payload = {
      requestId: input.requestId,
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
    }
    const receipt = publishMediaReceipt(payload)
    onCreateState?.('sending', receipt)
    const moment = await callOurs<Moment>('addMoment', payload).then(result => {
      if (!result?.id) throw new Error('保存结果未确认，请重试')
      return result
    }).catch((err: unknown) => {
      if (!(err as { business?: boolean })?.business) onCreateState?.('uncertain')
      throw err
    })
    const used = new Set([
      ...moment.images, ...(moment.videos || []), ...(moment.videoCover ? [moment.videoCover] : []),
      ...(moment.livePhotos || []).flatMap(item => [item.cover, item.video]),
      ...(moment.voices || []).map(item => item.fileID),
    ])
    await finishUploads(used)
    const savedReceipt = publishMediaReceipt(moment)
    if (!samePublishFields(moment, payload) || (savedReceipt !== receipt && !pendingMediaReceipts.includes(savedReceipt))) {
      onCreateState?.('different', moment.id)
    }
    tick(100, '完成')
    return moment
  } catch (err) {
    if (uploadedFileIDs.length > 0) await finishUploads(new Set())
    throw err
  } finally {
    trackingUploads = false
    uploadOwner = null
    activeUploadTasks = []
    uploadAborted = false
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
  requestId: string
}): Promise<Anniversary> {
  try {
    const anniversary = await callOurs<Anniversary>('addAnniversaryOnce', { coupleId: coupleId(), ...input })
    if (typeof anniversary?.id !== 'string' || !anniversary.id) throw new Error('保存结果未确认，请重试')
    return anniversary
  } catch (err) {
    if (err instanceof Error && err.message === '未知 action: addAnniversaryOnce') {
      throw new Error('云端暂不支持保存，请稍后重试')
    }
    throw err
  }
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

export async function addComment(momentId: string, content: string, requestId: string): Promise<MomentComment> {
  const comment = await callOurs<MomentComment>('addCommentOnce', { coupleId: coupleId(), momentId, content, requestId })
  if (typeof comment?.id !== 'string' || !comment.id) throw new Error('评论发送结果未确认，请重试')
  return comment
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

export async function setMomentLike(momentId: string, liked: boolean): Promise<MomentLikes> {
  return callOurs<MomentLikes>('setMomentLike', { coupleId: coupleId(), momentId, liked })
}

export async function updateMoment(momentId: string, input: {
  content?: string
  momentDate?: string
  tag?: MomentTag
  location?: MomentLocation | null
}): Promise<Moment> {
  return callOurs<Moment>('updateMomentFields', { coupleId: coupleId(), momentId, ...input })
}

function mapLocationKey(location: MomentLocation | null | undefined): string {
  if (!location || location.latitude == null || location.longitude == null) return ''
  const latitude = Number(location.latitude)
  const longitude = Number(location.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return ''
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`
}

function withMapPlaceStory(place: MapPlace, latest: Moment): MapPlace {
  const fileID = place.latestMomentCoverFileID ?? (
    latest.images?.[0] || latest.livePhotos?.[0]?.cover || latest.videoCover || ''
  )
  return {
    ...place,
    latestMomentId: latest.id,
    latestMomentDate: place.latestMomentDate || latest.momentDate || '',
    latestMomentContent: place.latestMomentContent || latest.content || '',
    latestMomentCover: place.latestMomentCover || latest.coverUrl || latest.previewImages?.[0] || undefined,
    latestMomentCoverFileID: fileID,
    latestMomentHasVideo: place.latestMomentHasVideo ?? (latest.videos?.length ?? 0) > 0,
  }
}

// 旧云函数可能忽略地点参数，保留原有的有限分页回退。
async function findMapPlaceStories(placeIds: Set<string>, spaceId: string): Promise<Map<string, Moment>> {
  const latestByLocation = new Map<string, Moment>()
  let skip = 0
  for (let page = 0; page < 10 && getSession()?.coupleId === spaceId; page++) {
    const result = await listMomentsPage({ limit: 50, skip })
    for (const moment of result.items) {
      const key = mapLocationKey(moment.location)
      if (moment.kind !== 'system' && placeIds.has(key) && !latestByLocation.has(key)) latestByLocation.set(key, moment)
    }
    if (latestByLocation.size === placeIds.size || !result.hasMore || !result.items.length) break
    skip += result.items.length
  }
  return latestByLocation
}

/** 按需补齐足迹页选中的旧版地点故事，云封面交由页面单独解析。 */
export async function getMapPlaceStory(place: MapPlace): Promise<MapPlace> {
  if (place.latestMomentId) {
    const latest = await getMoment(place.latestMomentId)
    return latest?.id === place.latestMomentId && mapLocationKey(latest.location) === place.id
      ? withMapPlaceStory(place, latest)
      : place
  }

  const spaceId = coupleId()
  let latest: Moment | undefined
  try {
    const { items } = await listMomentsPage({ limit: 1, locationKey: place.id })
    latest = items.find(moment => moment.kind !== 'system' && mapLocationKey(moment.location) === place.id)
  } catch {
    // 部分旧云函数可能不支持地点筛选。
  }
  if (!latest) latest = (await findMapPlaceStories(new Set([place.id]), spaceId)).get(place.id)
  return latest ? withMapPlaceStory(place, latest) : place
}

export async function listMapPlaces({ deferCoverUrls = false } = {}): Promise<{ places: MapPlace[]; cities: MapCityStat[] }> {
  const spaceId = coupleId()
  const data = await callOurs<{ places: MapPlace[]; cities: MapCityStat[] }>('listMapPlaces', {
    coupleId: spaceId,
    ...(deferCoverUrls ? { deferCoverUrls: true } : {}),
  })
  let places: MapPlace[] = data.places.map(place => {
    const cover = place.latestMomentCover
    return { ...place, latestMomentCover: cover && !cover.startsWith('cloud://') ? cover : place.latestMomentCoverUrl || cover }
  })
  if (deferCoverUrls) return { ...data, places }

  const missingStory = places.filter(place => !place.latestMomentId || (
    place.latestMomentCover == null && place.latestMomentCoverFileID == null
  ))
  if (missingStory.length) {
    try {
      const stories = await findMapPlaceStories(new Set(missingStory.map(place => place.id)), spaceId)
      places = places.map(place => {
        const latest = stories.get(place.id)
        return latest && (!place.latestMomentId || place.latestMomentId === latest.id)
          ? withMapPlaceStory(place, latest)
          : place
      })
    } catch {
      // 补充失败时仍返回地点统计。
    }
  }
  return {
    ...data,
    places: await Promise.all(places.map(async place => {
      const cover = place.latestMomentCover ?? place.latestMomentCoverFileID
      if (!cover) return place
      if (!cover.startsWith('cloud://')) return { ...place, latestMomentCover: cover }
      const latestMomentCover = await resolveCloudUrl(cover).catch(() => '')
      return { ...place, latestMomentCover }
    })),
  }
}

export async function deleteMoment(momentId: string): Promise<void> {
  await callOurs('deleteMoment', { coupleId: coupleId(), momentId })
}

