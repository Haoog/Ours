const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

// A grouping target, not a limit on the size of an individual media file.
const PART_BYTES = 64 * 1024 * 1024
const URL_BATCH = 50
const SIZE_CONCURRENCY = 6

async function mediaURLs(cloud, files) {
  const urls = []
  for (let i = 0; i < files.length; i += URL_BATCH) {
    let result
    try { result = await cloud.getTempFileURL({ fileList: files.slice(i, i + URL_BATCH).map(file => file.fileID) }) }
    catch { throw new Error('无法获取媒体下载地址，请检查云文件和网络后重试') }
    const items = result.fileList || []
    const byID = new Map(items.filter(item => item.fileID).map(item => [item.fileID, item]))
    for (let j = i; j < Math.min(i + URL_BATCH, files.length); j++) {
      const item = byID.get(files[j].fileID) || (items[j - i]?.fileID ? null : items[j - i])
      try {
        if (!item || (item.status !== undefined && item.status !== 0) || (item.code && item.code !== 'SUCCESS')) throw new Error()
        const url = new URL(item.tempFileURL)
        if (url.protocol !== 'https:') throw new Error()
        urls.push(url.href)
      } catch { throw new Error(`无法获取媒体下载地址：${files[j].path}，请检查云文件后重试`) }
    }
  }
  return urls
}

function parseSize(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

async function mediaSize(url, file) {
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) })
    const size = head.ok ? parseSize(head.headers.get('content-length')) : null
    if (size !== null) return size
  } catch { /* Some storage endpoints do not support HEAD. */ }
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    const range = response.headers.get('content-range') || ''
    const match = /^bytes 0-0\/(\d+)$/.exec(range)
    const size = response.status === 206 && match ? parseSize(match[1]) : null
    if (response.body) await response.body.cancel()
    if (size !== null && size > 0) return size
  } catch { /* Report a single actionable failure below. */ }
  throw new Error(`无法确认媒体大小：${file.path}；请检查云文件和网络后重试，备份未完成`)
}

async function planFiles(cloud, files) {
  const urls = await mediaURLs(cloud, files)
  const sizes = new Array(files.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(SIZE_CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const index = next++
      sizes[index] = await mediaSize(urls[index], files[index])
    }
  }))
  const groups = [[]]
  let bytes = 0
  for (let i = 0; i < files.length; i++) {
    const size = sizes[i]
    if (groups[groups.length - 1].length && bytes + size > PART_BYTES) { groups.push([]); bytes = 0 }
    groups[groups.length - 1].push({ ...files[i], size })
    bytes += size
  }
  return groups
}

async function zipBackupPart(cloud, snapshot, part, mediaFiles) {
  const urls = await mediaURLs(cloud, mediaFiles)
  const files = []
  for (let i = 0; i < mediaFiles.length; i++) {
    const file = mediaFiles[i]
    const size = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : await mediaSize(urls[i], file)
    files.push({ ...file, size })
  }
  const { ZipArchive } = await import('archiver')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ours-backup-'))
  const archivePath = path.join(directory, 'backup.zip')
  const output = fs.createWriteStream(archivePath)
  const archive = new ZipArchive({ store: true, forceZip64: true })
  let active
  const failure = new Promise((resolve, reject) => {
    const fail = error => { if (active) active.destroy(error); reject(error) }
    output.once('error', fail); archive.once('error', fail); archive.once('warning', fail)
  })
  failure.catch(() => {})
  const closed = new Promise(resolve => output.once('close', resolve))
  archive.pipe(output)
  try {
    archive.append(JSON.stringify(snapshot.records, null, 2), { name: 'records.json' })
    archive.append(JSON.stringify(snapshot.files, null, 2), { name: 'media-manifest.json' })
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      let response
      try { response = await fetch(urls[i], { redirect: 'error', signal: AbortSignal.timeout(120000) }) }
      catch { throw new Error(`媒体读取失败：${file.path}`) }
      if (!response.ok || !response.body) throw new Error(`媒体读取失败：${file.path}`)
      let count = 0
      const guard = new Transform({ transform(chunk, encoding, callback) {
        count += chunk.length
        callback(count > file.size ? new Error('媒体大小发生变化') : null, chunk)
      }, flush(callback) { callback(count === file.size ? null : new Error('媒体大小发生变化')) } })
      active = guard
      const entry = new Promise(resolve => {
        const onEntry = item => { if (item.name === file.path) { archive.removeListener('entry', onEntry); resolve() } }
        archive.on('entry', onEntry)
      })
      archive.append(guard, { name: file.path })
      await Promise.race([Promise.all([pipeline(Readable.fromWeb(response.body), guard), entry]), failure])
      active = null
    }
    archive.append(JSON.stringify({ part, parts: snapshot.parts, missing: [] }, null, 2), { name: 'backup-status.json' })
    await Promise.race([Promise.all([archive.finalize(), closed]), failure])
    const input = fs.createReadStream(archivePath)
    const inputError = new Promise((resolve, reject) => input.once('error', reject))
    inputError.catch(() => {})
    let result
    try {
      result = await Promise.race([cloud.uploadFile({ cloudPath: `backups/${snapshot.coupleId}/${snapshot.id}/part-${part + 1}.zip`, fileContent: input }), inputError])
    } finally { input.destroy() }
    if (!result.fileID) throw new Error('云存储未返回备份文件 ID')
    return { fileID: result.fileID, missing: 0 }
  } catch (error) {
    throw new Error(`备份分卷生成失败：${error.message || '请检查网络、云函数临时磁盘和云存储限制'}；请重试或重新生成备份`)
  } finally {
    if (active) active.destroy()
    archive.abort(); output.destroy()
    await closed
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = { zipBackupPart, planFiles, PART_BYTES }
