// 按成员和空间保存待清理文件。服务端负责延迟删除和引用检查。
import { callOurs } from './cloud-api'
import { getSession } from './session'

type Owner = { openid: string; coupleId: string }
type Entry = Owner & { fileID: string }
const KEY = 'OURS_UPLOAD_CLEANUP_V1'
const active = new Set<string>()
// 仅在当前进程有效；存储恢复后合并到持久队列。
const emergency = new Map<string, Entry>()
const generations = new Map<string, number>()
let running = false
const failures = new Map<string, { count: number; retryAt: number }>()
const BATCH_SIZE = 50
const BATCH_DELAY = 100
const RETRY_BASE = 30000
const RETRY_MAX = 30 * 60 * 1000
let timer: ReturnType<typeof setTimeout> | undefined
let timerOwner: Owner | undefined
let rerun = false

function schedule(owner: Owner, delay: number): void {
  if (!current(owner)) return
  if (timer) clearTimeout(timer)
  timerOwner = owner
  timer = setTimeout(() => {
    timer = undefined
    timerOwner = undefined
    if (current(owner)) void retryUploadCleanup()
  }, delay)
}

function failed(id: string): void {
  const count = Math.min((failures.get(id)?.count || 0) + 1, 16)
  failures.set(id, { count, retryAt: Date.now() + Math.min(RETRY_MAX, RETRY_BASE * Math.pow(2, count - 1)) })
}

export function forgetUploadHolds(owner: Owner, fileIDs: string[]): void {
  for (const id of fileIDs) active.delete(identity(owner, id))
}

function identity(owner: Owner, fileID: string): string {
  return JSON.stringify([owner.openid, owner.coupleId, fileID])
}
function current(owner: Owner): boolean {
  const session = getSession()
  return !!session && session.status === 'ready' && session.openid === owner.openid && session.coupleId === owner.coupleId
}
function read(): Entry[] {
  const value = wx.getStorageSync(KEY)
  if (value === '' || value == null) return []
  if (!Array.isArray(value) || value.some(item => !item || typeof item.openid !== 'string' || typeof item.coupleId !== 'string' || typeof item.fileID !== 'string')) {
    throw new Error('清理队列读取失败')
  }
  return value as Entry[]
}
function write(entries: Entry[]): void { wx.setStorageSync(KEY, entries) }

export function holdUpload(owner: Owner, fileID: string): void {
  const id = identity(owner, fileID)
  generations.set(id, (generations.get(id) || 0) + 1)
  active.add(id)
  const entries = read()
  if (!entries.some(e => identity(e, e.fileID) === identity(owner, fileID))) {
    write([...entries, { ...owner, fileID }])
  }
}

export function releaseUploads(owner: Owner, fileIDs: string[], published: Set<string>): void {
  // Never remove an active hold until the storage update succeeds.
  const entries = read()
  const ids = new Set(fileIDs.filter(id => published.has(id)))
  write(entries.filter(e => !(e.openid === owner.openid && e.coupleId === owner.coupleId && ids.has(e.fileID))))
  for (const id of fileIDs) active.delete(identity(owner, id))
}

export async function retryUploadCleanup(): Promise<void> {
  const session = getSession()
  if (timer && (!session || !timerOwner || !current(timerOwner))) {
    clearTimeout(timer)
    timer = undefined
    timerOwner = undefined
  }
  if (running) { rerun = true; return }
  if (!session || session.status !== 'ready' || !session.openid || !session.coupleId) return
  if (timer) { clearTimeout(timer); timer = undefined; timerOwner = undefined }
  const owner: Owner = { openid: session.openid, coupleId: session.coupleId }
  running = true
  try {
    // 合并所有所属账号的应急记录，但只提交当前会话的记录。
    if (emergency.size) {
      const entries = read()
      const existing = new Set(entries.map(e => identity(e, e.fileID)))
      for (const [id, entry] of emergency) if (!existing.has(id)) entries.push(entry)
      write(entries)
      emergency.clear()
    }
    const eligible = read().filter(e => e.openid === owner.openid && e.coupleId === owner.coupleId && !active.has(identity(e, e.fileID)))
    const now = Date.now()
    const pending = eligible.filter(e => (failures.get(identity(e, e.fileID))?.retryAt || 0) <= now).slice(0, BATCH_SIZE)
    for (const entry of pending) {
      if (!current(owner)) break
      const id = identity(entry, entry.fileID)
      // A hold may have been added while an earlier request was in flight.
      if (active.has(id)) continue
      const generation = generations.get(id)
      try {
        const result = await callOurs<{ queued: number }>('cleanupUploadedFiles', { coupleId: owner.coupleId, fileIDs: [entry.fileID] })
        if (!current(owner)) break
        if (active.has(id) || generations.get(id) !== generation) continue
        if (result?.queued !== 1) { failed(id); continue }
        const entries = read()
        write(entries.filter(e => identity(e, e.fileID) !== id))
        failures.delete(id)
      } catch (err) {
        failed(id)
        console.warn('待清理文件将在下次重试', err)
      }
    }
    if (current(owner)) {
      const remaining = read().filter(e => e.openid === owner.openid && e.coupleId === owner.coupleId && !active.has(identity(e, e.fileID)))
      if (remaining.length) {
        const earliest = remaining.reduce((min, e) => Math.min(min, failures.get(identity(e, e.fileID))?.retryAt || 0), Infinity)
        schedule(owner, Math.max(BATCH_DELAY, earliest - Date.now()))
      }
    }
  } catch (err) {
    console.warn('无法读取待清理文件', err)
    // 存储仍不可用时也尝试服务端登记；失败后按退避时间重试。
    for (const [id, entry] of emergency) {
      if (!current(owner)) break
      if (entry.openid !== owner.openid || entry.coupleId !== owner.coupleId || active.has(id) || (failures.get(id)?.retryAt || 0) > Date.now()) continue
      const generation = generations.get(id)
      try {
        const result = await callOurs<{ queued: number }>('cleanupUploadedFiles', { coupleId: owner.coupleId, fileIDs: [entry.fileID] })
        if (!current(owner)) break
        if (active.has(id) || generations.get(id) !== generation) continue
        if (result?.queued === 1) { emergency.delete(id); failures.delete(id) } else failed(id)
      } catch { failed(id) }
    }
    if (current(owner)) schedule(owner, RETRY_BASE)
  } finally {
    running = false
    if (rerun) { rerun = false; void retryUploadCleanup() }
  }
}

// Storage can fail (quota/device errors). Try server registration while the ID is
// still in memory, and tell the user if durable recording could not be assured.
export async function fallbackUploadCleanup(owner: Owner, fileIDs: string[]): Promise<boolean> {
  const ids = Array.from(new Set(fileIDs))
  for (const fileID of ids) emergency.set(identity(owner, fileID), { ...owner, fileID })
  for (const fileID of ids) {
    if (!current(owner)) break
    const id = identity(owner, fileID)
    const generation = generations.get(id)
    try {
      const result = await callOurs<{ queued: number }>('cleanupUploadedFiles', { coupleId: owner.coupleId, fileIDs: [fileID] })
      if (current(owner) && result?.queued === 1 && generations.get(id) === generation) emergency.delete(id)
    } catch { /* 留在内存中等待重试 */ }
  }
  return ids.every(fileID => !emergency.has(identity(owner, fileID)))
}
