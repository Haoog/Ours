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

export interface Couple {
  id: string
  startDate: string
  partnerWechatId?: string
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
  livePhotos?: MomentLivePhoto[]
  voices?: MomentVoice[]
  location: MomentLocation | null
  authorOpenid: string
  authorRole: 'A' | 'B'
  createdAt: number
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

export type Mood = 'happy' | 'soft' | 'low' | 'rant'

export interface Checkin {
  id: string
  date: string
  openid: string
  role: 'A' | 'B'
  mood: Mood | null
  note: string
  createdAt: number
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
}

export interface MapCityStat {
  name: string
  count: number
}
