import { daysBetween } from '../services/date'
import { Moment } from '../services/types'
import { formatSlate } from '../services/format'
import { tagLabel } from './tags'
import { momentDisplayAt, momentDateOf } from './moment-time'

export type SceneLayout = 'signal' | 'verse' | 'cinema' | 'collage' | 'reel'

export interface SceneVO {
  id: string
  sceneNo: string
  md: string
  dow: string
  timeText: string
  content: string
  previewImages: string[]
  imageCount: number
  layout: SceneLayout
  bentoClass: string
  coverUrl: string
  hasCover: boolean
  hasVideo: boolean
  hasLive: boolean
  hasVoice: boolean
  voiceDuration: number
  role: 'A' | 'B'
  author: string
  stagger: 'a' | 'b'
  location: string
  isSystem: boolean
  tagLabel: string
  commentCount: number
  likeCount: number
  likedByMe: boolean
}

export type TimelineRow =
  | { type: 'month'; key: string; label: string }
  | { type: 'milestone'; key: string; title: string; sub: string }
  | { type: 'moment'; key: string; scene: SceneVO }

const RELATION_MILESTONES = [100, 365, 500, 1000]
const POST_MILESTONES = [50, 100, 200]

function pickLayout(imageCount: number, hasMedia: boolean, isSystem: boolean): SceneLayout {
  if (isSystem) return 'signal'
  if (!hasMedia && imageCount === 0) return 'verse'
  if (imageCount >= 5) return 'reel'
  if (imageCount >= 2) return 'collage'
  return 'cinema'
}

function bentoClass(imageCount: number): string {
  if (imageCount === 2) return '2'
  if (imageCount === 3) return '3'
  if (imageCount >= 4) return '4'
  return '1'
}

function momentToScene(
  m: Moment,
  myRole: 'A' | 'B',
  sceneNo: string,
  stagger: 'a' | 'b',
): SceneVO {
  const slate = formatSlate(momentDisplayAt(m))
  const imageCount = m.images?.length || m.livePhotos?.length || 0
  let previewImages = m.previewImages?.length
    ? m.previewImages.slice(0, 9)
    : m.coverUrl
      ? [m.coverUrl]
      : []
  if (!previewImages.length && imageCount > 0 && m.coverUrl) {
    previewImages = [m.coverUrl]
  }
  const hasVideo = (m.videos?.length ?? 0) > 0
  const hasLive = (m.livePhotos?.length ?? 0) > 0
  const hasVoice = (m.voices?.length ?? 0) > 0
  const hasMedia = previewImages.length > 0 || hasVideo || hasLive || hasVoice
  const isSystem = m.kind === 'system'
  const layout = pickLayout(imageCount || previewImages.length, hasMedia, isSystem)

  return {
    id: m.id,
    sceneNo,
    md: slate.md,
    dow: slate.dow,
    timeText: `${slate.md} · ${slate.dow}`,
    content: (m.content || '').trim(),
    previewImages,
    imageCount: imageCount || previewImages.length,
    layout,
    bentoClass: bentoClass(imageCount || previewImages.length),
    coverUrl: previewImages[0] || m.coverUrl || '',
    hasCover: previewImages.length > 0,
    hasVideo,
    hasLive,
    hasVoice,
    voiceDuration: m.voices?.[0]?.duration ?? 0,
    role: m.authorRole,
    author: m.authorRole === myRole ? '我' : 'TA',
    stagger,
    location: m.location?.name ?? '',
    isSystem,
    tagLabel: tagLabel(m.tag),
    commentCount: m.commentCount ?? 0,
    likeCount: m.likeCount ?? 0,
    likedByMe: m.likedByMe ?? false,
  }
}

function collectMilestones(
  m: Moment,
  startDate: string,
  postNumber: number,
): { key: string; title: string; sub: string }[] {
  const out: { key: string; title: string; sub: string }[] = []
  if (m.kind === 'system') return out
  const days = daysBetween(startDate, new Date(momentDisplayAt(m)))
  for (const target of RELATION_MILESTONES) {
    if (days === target) {
      out.push({
        key: `rel-${target}-${m.id}`,
        title: `在一起 ${target} 天`,
        sub: formatSlate(momentDisplayAt(m)).md,
      })
    }
  }
  for (const n of POST_MILESTONES) {
    if (postNumber === n) {
      out.push({
        key: `post-${n}-${m.id}`,
        title: `第 ${n} 条回忆`,
        sub: '值得一直记住',
      })
    }
  }
  return out
}

export function buildTimelineRows(
  list: Moment[],
  total: number,
  skip: number,
  myRole: 'A' | 'B',
  startDate: string,
  previousMonth = '',
): TimelineRow[] {
  const rows: TimelineRow[] = []
  let lastMonth = previousMonth

  list.forEach((m, idx) => {
    const globalIdx = skip + idx
    const postNumber = total - globalIdx
    const sceneNo = String(total - globalIdx).padStart(2, '0')
    const stagger: 'a' | 'b' = globalIdx % 2 === 0 ? 'a' : 'b'
    const parts = momentDateOf(m).split('-')
    const mk = `${parts[0]}-${Number(parts[1])}`
    const d = new Date(momentDisplayAt(m))
    if (mk !== lastMonth) {
      lastMonth = mk
      rows.push({ type: 'month', key: `m-${mk}-${skip}`, label: `${d.getFullYear()} · ${d.getMonth() + 1} 月` })
    }
    for (const ms of collectMilestones(m, startDate, postNumber)) {
      rows.push({ type: 'milestone', key: ms.key, title: ms.title, sub: ms.sub })
    }
    rows.push({
      type: 'moment',
      key: m.id,
      scene: momentToScene(m, myRole, sceneNo, stagger),
    })
  })

  return rows
}

export function scenesFromMoments(
  list: Moment[],
  total: number,
  skip: number,
  myRole: 'A' | 'B',
): SceneVO[] {
  return list.map((m, idx) => {
    const globalIdx = skip + idx
    const sceneNo = String(total - globalIdx).padStart(2, '0')
    const stagger: 'a' | 'b' = globalIdx % 2 === 0 ? 'a' : 'b'
    return momentToScene(m, myRole, sceneNo, stagger)
  })
}
