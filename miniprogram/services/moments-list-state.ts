import { invalidateMomentsFeedPrefetch } from './moments-feed-cache'
let listStale = true
export function markMomentsListStale(): void {
  listStale = true
  invalidateMomentsFeedPrefetch()
}
export function consumeMomentsListStale(): boolean {
  const v = listStale
  listStale = false
  return v
}
export function peekMomentsListStale(): boolean { return listStale }
let savedScrollTop = 0
let pendingContext: { locationKey: string; label: string } | null = null
export function openMomentsContext(context: { locationKey: string; label: string }): void { pendingContext = context }
export function takeMomentsContext(): typeof pendingContext {
  const context = pendingContext
  pendingContext = null
  return context
}
export function saveMomentsScrollTop(top: number): void { savedScrollTop = Math.max(0, Math.round(top)) }
export function consumeMomentsScrollTop(): number { const v = savedScrollTop; savedScrollTop = 0; return v }
