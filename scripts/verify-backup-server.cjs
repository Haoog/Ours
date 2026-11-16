const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Writable } = require('stream')
const { execFileSync } = require('child_process')
const { planFiles, zipBackupPart, PART_BYTES } = require('../cloudfunctions/ours/backup')

const originalFetch = global.fetch
const file = (n, size) => ({ fileID: `cloud://${n}`, path: `media/${n}.bin`, size })
let calls = 0, running = 0, peak = 0, mode = 'ok', upload = 0, archived
const cloud = {
  getTempFileURL: async ({ fileList }) => { calls++; return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://example.test/${fileID.slice(8)}` })) } },
  uploadFile: async ({ fileContent }) => { upload++; fileContent.on('error', () => {}); if (mode !== 'large' && mode !== 'upload-error') archived = fs.readFileSync(fileContent.path); fileContent.destroy(); if (mode === 'upload-error') throw Error('upload failed'); return { fileID: 'cloud://zip' } },
}
const webStream = (size, byte = 65) => new ReadableStream({ pull(controller) { if (!size) return controller.close(); const n = Math.min(size, 65536); size -= n; controller.enqueue(new Uint8Array(n).fill(byte)) } })
global.fetch = async (url, options = {}) => {
  const id = url.split('/').pop()
  if (options.method === 'HEAD') {
    running++; peak = Math.max(peak, running); await new Promise(resolve => setTimeout(resolve, 1)); running--
    return new Response(null, { status: mode === 'range' || mode === 'unknown' ? 405 : 200, headers: { 'content-length': id === 'large' ? String(PART_BYTES + 1) : '3' } })
  }
  if (options.headers?.Range) return mode === 'unknown' ? new Response(null, { status: 200 }) : new Response(webStream(1), { status: 206, headers: { 'content-range': 'bytes 0-0/3' } })
  return new Response(webStream(id === 'large' ? PART_BYTES + 1 : mode === 'short' ? 2 : 3), { status: 200 })
}
const snapshot = { coupleId: 'space', id: 'test', parts: 1, records: { moments: [] }, files: [file('small', 3)] }
;(async () => {
  const files = Array.from({ length: 120 }, (_, i) => file(String(i)))
  const groups = await planFiles(cloud, files)
  assert.equal(groups.flat().length, 120); assert.equal(calls, 3); assert.ok(peak <= 6 && peak > 1)
  mode = 'range'; assert.equal((await planFiles(cloud, [file('small')]))[0][0].size, 3)
  mode = 'unknown'; await assert.rejects(planFiles(cloud, [file('small')]), /无法确认媒体大小/)
  mode = 'ok'; const planned = await planFiles(cloud, [file('large'), file('small')]); assert.equal(planned.length, 2); assert.equal(planned[0][0].size, PART_BYTES + 1)
  await zipBackupPart(cloud, snapshot, 0, [file('small', 3)])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ours-verify-'))
  try {
    const zip = path.join(dir, 'a.zip'); fs.writeFileSync(zip, archived)
    execFileSync('unzip', ['-t', zip], { stdio: 'pipe' })
    assert.equal(execFileSync('unzip', ['-p', zip, 'media/small.bin']).toString(), 'AAA')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const before = upload
  const tempDirs = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ours-backup-')).sort()
  const existing = tempDirs()
  mode = 'short'; await assert.rejects(zipBackupPart(cloud, snapshot, 0, [file('small', 3)]), /大小发生变化/); assert.equal(upload, before)
  assert.deepEqual(tempDirs(), existing)
  mode = 'upload-error'; await assert.rejects(zipBackupPart(cloud, snapshot, 0, [file('small', 3)]), /upload failed/)
  assert.deepEqual(tempDirs(), existing)
  mode = 'ok'; await zipBackupPart(cloud, snapshot, 0, [file('small')]) // version 1 lacks size
  const create = fs.createWriteStream
  try {
    mode = 'large'
    fs.createWriteStream = () => new Writable({ write(chunk, encoding, done) { done() } })
    await zipBackupPart(cloud, snapshot, 0, [file('large', PART_BYTES + 1)])
  } finally { fs.createWriteStream = create }
  console.log('PASS: batched planning, range fallback, unknown size, ZIP integrity, legacy sizes, failures and virtual >64 MiB stream')
})().finally(() => { global.fetch = originalFetch }).catch(error => { console.error(error); process.exitCode = 1 })
