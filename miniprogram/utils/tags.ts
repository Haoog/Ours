import { MomentTag } from '../services/types'

export const MOMENT_TAG_FILTERS: { key: MomentTag | ''; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'daily', label: '日常' },
  { key: 'travel', label: '旅行' },
  { key: 'rant', label: '吐槽' },
]

export const MOMENT_TAG_POST: { key: MomentTag; label: string }[] = [
  { key: 'daily', label: '日常' },
  { key: 'travel', label: '旅行' },
  { key: 'rant', label: '吐槽' },
]

export function tagLabel(tag?: MomentTag | ''): string {
  if (!tag) return ''
  const found = MOMENT_TAG_POST.find(t => t.key === tag)
  return found?.label ?? ''
}
