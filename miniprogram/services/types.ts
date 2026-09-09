// services/types.ts — 数据模型

export interface CoupleMember {
  openid: string
  nickname: string
  avatarUrl: string
}

export type PetSpecies = 'cat'
export type PetMood = 'happy' | 'normal' | 'hungry' | 'sleepy'
export type PetStage = 'baby' | 'teen' | 'adult'

export interface CouplePet {
  name: string
  species: PetSpecies
  exp: number
  happiness: number
  lastFedDate: string
  lastPetDate: string
  adoptedAt: number
}

export interface PetView {
  adopted: boolean
  name?: string
  species?: PetSpecies
  exp?: number
  happiness?: number
  mood?: PetMood
  level?: number
  stage?: PetStage
  expCurrent?: number
  expNeed?: number
  canFeed?: boolean
  canPet?: boolean
  expPercent?: number
  message?: string
}

export interface AccessQuota {
  maxMoments: number
  maxStorageBytes: number
  maxMediaItems: number
  maxMediaPerMoment: number
}

export interface AccessUsage {
  momentCount: number
  mediaItems: number
  storageBytes: number
}

export interface Couple {
  id: string
  startDate: string
  partnerWechatId?: string
  licenseId?: string
  planId?: string
  status?: 'active' | 'suspended' | 'revoked'
  expiresAt?: number | null
  quota?: AccessQuota
  usage?: AccessUsage
  memberA: CoupleMember
  memberB: CoupleMember | null
  streakDays: number
  lastStreakDate: string | null
  createdAt: number
  pet?: CouplePet
}

export interface MomentLocation {
  name: string
  address: string
  latitude: number
  longitude: number
}

export interface MomentVoice {
  fileID: string
  duration: number
}

export interface MomentLivePhoto {
  cover: string
  video: string
  duration: number
}

export type MomentTag = 'daily' | 'travel' | 'rant' | ''
export type MomentKind = 'post' | 'system'

export interface Moment {
  id: string
  content: string
  images: string[]
  videos?: string[]
  /** 普通视频的列表缩略图 fileID / 临时链接 */
  videoCover?: string
  livePhotos?: MomentLivePhoto[]
  voices?: MomentVoice[]
  location: MomentLocation | null
  authorOpenid: string
  authorRole: 'A' | 'B'
  createdAt: number
  /** 回忆发生的日期 YYYY-MM-DD，默认同 createdAt 当天 */
  momentDate?: string
  /** 列表排序用时间戳（由 momentDate + 发布时间衍生） */
  sortAt?: number
  tag?: MomentTag
  kind?: MomentKind
  systemKind?: 'checkin' | null
  meta?: { date?: string; streakDays?: number }
  /** 列表接口聚合字段 */
  coverUrl?: string
  previewImages?: string[]
  commentCount?: number
  likeCount?: number
  likedByMe?: boolean
  mediaItems?: number
  mediaBytes?: number
}

export interface MomentsStats {
  year: number
  month: number
  total: number
  countA: number
  countB: number
  placeCount: number
  topTag: string
}

export interface MomentCollectionTag {
  key: string
  label: string
  count: number
}

export interface MomentCollectionPlace {
  name: string
  count: number
}

export interface MomentNeighbors {
  prevId: string | null
  nextId: string | null
  index: number
  total: number
}

export interface MomentsBriefStats {
  total: number
  countA: number
  countB: number
}

export interface Identity {
  openid: string
  role: 'A' | 'B'
  nickname: string
  avatarUrl: string
}

export interface Anniversary {
  id: string
  coupleId: string
  title: string
  date: string
  yearly: boolean
  remind: boolean
  createdAt: number
  daysLeft?: number
}

export interface AnniversaryNext {
  id: string
  title: string
  date: string
  daysLeft: number
  label: string
}

export interface Rant {
  id: string
  coupleId: string
  content: string
  images: string[]
  authorOpenid: string
  authorRole: 'A' | 'B'
  createdAt: number
}

export interface LoveNote {
  id: string
  coupleId: string
  content: string
  fromRole: 'A' | 'B'
  toRole: 'A' | 'B'
  readAt: number | null
  createdAt: number
  isMine?: boolean
  isUnread?: boolean
}

export interface MomentComment {
  id: string
  coupleId: string
  momentId: string
  content: string
  authorOpenid: string
  authorRole: 'A' | 'B'
  createdAt: number
}

export interface MomentLikes {
  likedByA: boolean
  likedByB: boolean
  count: number
}

export interface MapPlace {
  id: string
  name: string
  address: string
  latitude: number
  longitude: number
  momentCount: number
  /** 地点卡片展示的最近一条回忆 */
  latestMomentId?: string
  latestMomentDate?: string
  latestMomentContent?: string
  latestMomentCover?: string
  latestMomentHasVideo?: boolean
}

export interface MapCityStat {
  name: string
  count: number
}
