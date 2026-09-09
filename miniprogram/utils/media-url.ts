// utils/media-url.ts — 列表/详情展示用临时链接

import { resolveCloudUrl } from '../services/store'
import { Moment } from '../services/types'

export async function toDisplayUrl(fileIDOrPath: string): Promise<string> {
  if (!fileIDOrPath) return ''
  if (fileIDOrPath.startsWith('cloud://')) return resolveCloudUrl(fileIDOrPath)
  return fileIDOrPath
}

export async function resolveMomentImages(images: string[]): Promise<string[]> {
  return Promise.all(images.map(toDisplayUrl))
}

export async function resolveMomentLivePhotos(
  livePhotos: { cover: string; video: string; duration: number }[],
): Promise<{ cover: string; video: string; duration: number }[]> {
  return Promise.all(
    livePhotos.map(async lp => ({
      cover: await toDisplayUrl(lp.cover),
      video: lp.video,
      duration: lp.duration,
    })),
  )
}

export async function pickMomentCover(m: Moment): Promise<string> {
  const raw = m.coverUrl || m.images?.[0] || m.livePhotos?.[0]?.cover || m.videoCover || ''
  return toDisplayUrl(raw)
}
