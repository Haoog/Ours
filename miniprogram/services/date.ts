export function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function daysBetween(startISO: string, end: Date = new Date()): number {
  const [y, m, d] = startISO.split('-').map(Number)
  const s = Date.UTC(y, m - 1, d)
  const e = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
  const ms = e - s
  return Math.max(0, Math.floor(ms / 86400000)) + 1
}
