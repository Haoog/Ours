export function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysBetween(startISO: string, end: Date = new Date()): number {
  const s = new Date(startISO + 'T00:00:00')
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const ms = e.getTime() - s.getTime()
  return Math.max(0, Math.floor(ms / 86400000)) + 1
}
