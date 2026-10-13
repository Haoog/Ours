import { todayKey } from '../services/date'

export interface MomentTiming {
  momentDate?: string
  sortAt?: number
  createdAt: number
}

export function dateKeyFromTs(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function sortAtForMomentDate(momentDate: string, createdAt: number): number {
  const base = new Date(`${momentDate}T00:00:00+08:00`).getTime()
  return base + (createdAt + 8 * 3600000) % 86400000
}

export function momentDateOf(m: MomentTiming): string {
  if (m.momentDate && /^\d{4}-\d{2}-\d{2}$/.test(m.momentDate)) return m.momentDate
  return dateKeyFromTs(m.createdAt)
}

export function momentDisplayAt(m: MomentTiming): number {
  return new Date(`${momentDateOf(m)}T12:00:00`).getTime()
}

export function isBackdatedMoment(m: MomentTiming): boolean {
  return momentDateOf(m) !== dateKeyFromTs(m.createdAt)
}

export function formatMomentDateLabel(dateKey: string): string {
  const today = todayKey()
  if (dateKey === today) return '今天'
  const [y, m, d] = dateKey.split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

export function monthDayKeyFromMoment(m: MomentTiming): string {
  const key = momentDateOf(m)
  const [, mo, da] = key.split('-')
  return `${mo}-${da}`
}
