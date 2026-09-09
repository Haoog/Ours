export type SpaceStatus = 'active' | 'suspended' | 'revoked' | 'expired'

export interface Member {
  openid: string
  nickname: string
  avatarUrl?: string
}

export interface Quota {
  maxMoments: number
  maxStorageBytes: number
  maxMediaItems: number
  maxMediaPerMoment: number
}

export interface Usage {
  momentCount: number
  mediaItems: number
  storageBytes: number
}

export interface Space {
  id: string
  startDate: string
  memberA: Member | null
  memberB: Member | null
  licenseId: string | null
  planId: string
  status: SpaceStatus
  expiresAt: number | null
  quota: Quota | null
  usage: Usage
  createdAt: number
}

export interface AccessCode {
  id: string
  status: 'unused' | 'active' | 'revoked' | 'expired'
  coupleId: string | null
  planId: string
  quota: Quota
  expiresAt: number | null
  redeemedBy?: string
  redeemedAt?: number
  createdAt: number
}

export interface MediaItem {
  fileID: string
  url: string
}

export interface AdminMedia {
  images: MediaItem[]
  videos: MediaItem[]
  videoCover: MediaItem | null
  livePhotos: Array<{ cover: MediaItem; video: MediaItem; duration: number }>
  voices: Array<MediaItem & { duration: number }>
}

export interface AdminMoment {
  id: string
  content: string
  images: string[]
  videos?: string[]
  videoCover?: string
  livePhotos?: Array<{ cover: string; video: string; duration: number }>
  voices?: Array<{ fileID: string; duration: number }>
  location?: { name?: string; address?: string } | null
  authorRole: 'A' | 'B'
  createdAt: number
  momentDate?: string
  kind?: 'post' | 'system'
  tag?: string
  mediaItems?: number
  mediaBytes?: number
  media: AdminMedia
}

export interface PageResult<T> {
  items: T[]
  total: number
  hasMore: boolean
}

export interface Overview {
  spaces: number
  accessCodes: number
  moments: number
  storageBytes: number
}

export interface AdminIdentity {
  uid: string
  openId: string
  isAdmin: boolean
  role: string | null
}
