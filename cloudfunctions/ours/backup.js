const fs = require('fs')
const os = require('os')
const path = require('path')
const archiver = require('archiver')
const crypto = require('crypto')

async function zipBackupPart(cloud, snapshot, part, mediaFiles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ours-backup-'))
  const archivePath = path.join(directory, 'backup.zip')
  const missing = []
  const output = fs.createWriteStream(archivePath)
  const archive = archiver('zip', { store: true })
  const closed = new Promise((resolve, reject) => {
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.once('warning', reject)
  })
  // 提前监听压缩流错误，避免下载期间出现未处理的异常。
  closed.catch(() => undefined)
  archive.pipe(output)
  try {
    archive.append(JSON.stringify(snapshot.records, null, 2), { name: 'records.json' })
    archive.append(JSON.stringify(snapshot.files, null, 2), { name: 'media-manifest.json' })
    for (const file of mediaFiles) {
      try {
        const localPath = path.join(directory, crypto.createHash('sha256').update(file.fileID).digest('hex'))
        const downloaded = await cloud.downloadFile({ fileID: file.fileID })
        fs.writeFileSync(localPath, downloaded.fileContent)
        archive.file(localPath, { name: file.path })
      } catch (error) {
        missing.push({ fileID: file.fileID, path: file.path, error: error.message })
      }
    }
    archive.append(JSON.stringify({ part, parts: snapshot.parts, missing }, null, 2), { name: 'backup-status.json' })
    await archive.finalize()
    await closed
    const result = await cloud.uploadFile({
      cloudPath: `backups/${snapshot.coupleId}/${snapshot.id}/part-${part + 1}.zip`,
      fileContent: fs.createReadStream(archivePath),
    })
    return { fileID: result.fileID, missing: missing.length }
  } finally {
    archive.abort()
    output.destroy()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = { zipBackupPart }
