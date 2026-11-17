// Uncompressed container: magic, big-endian manifest length and CRC32, UTF-8 JSON, then media bytes.
// Media are sliced in chunks for checksums; the backup keeps videos out of base64 strings.
const MAGIC = 'OURSBAK1';
const HEADER_SIZE = 16;
const MAX_MANIFEST = 8 * 1024 * 1024;
const MAX_MEDIA = 100 * 1024 * 1024;
const MAX_RECORDS = 10000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
function crcBytes(bytes) { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
async function crcBlob(blob) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    crc = crcUpdate(crc, new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export { validDate, MAX_MEDIA, MAX_RECORDS, MAX_MANIFEST };

// Upper bound: a CRC32 can use up to ten decimal digits. Use the same fields and
// JSON layout as createBackup so an import cannot make .ours export impossible.
export function backupManifestUpperBound(memories) {
  const records = memories.map(memory => ({
    id: memory.id, date: memory.date, text: memory.text, createdAt: memory.createdAt, updatedAt: memory.updatedAt,
    media: memory.media.map(item => ({ id: item.id, name: item.name, type: item.type, size: item.blob.size, crc32: 4294967295 })),
  }));
  return encoder.encode(JSON.stringify({ format: 'ours-web-backup', version: 1, exportedAt: '2000-01-01T00:00:00.000Z', memories: records })).byteLength;
}

export async function createBackup(memories) {
  if (memories.length > MAX_RECORDS) throw new Error('回忆数量超过单个备份支持的上限。');
  const parts = [];
  const records = [];
  for (const memory of memories) {
    const media = [];
    for (const item of memory.media) {
      parts.push(item.blob);
      media.push({ id: item.id, name: item.name, type: item.type, size: item.blob.size, crc32: await crcBlob(item.blob) });
    }
    records.push({ id: memory.id, date: memory.date, text: memory.text, createdAt: memory.createdAt, updatedAt: memory.updatedAt, media });
  }
  const manifest = encoder.encode(JSON.stringify({ format: 'ours-web-backup', version: 1, exportedAt: new Date().toISOString(), memories: records }));
  if (manifest.byteLength > MAX_MANIFEST) throw new Error('备份目录过大，无法导出。');
  const prefix = new Uint8Array(HEADER_SIZE);
  prefix.set(encoder.encode(MAGIC), 0);
  const view = new DataView(prefix.buffer);
  view.setUint32(8, manifest.byteLength, false);
  view.setUint32(12, crcBytes(manifest), false);
  return new Blob([prefix, manifest, ...parts], { type: 'application/octet-stream' });
}

export async function readBackup(file) {
  const fail = message => { throw new Error(`无法导入备份：${message}`); };
  if (file.size < HEADER_SIZE) fail('文件不完整或格式不正确。');
  const prefix = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer());
  if (String.fromCharCode(...prefix.slice(0, 8)) !== MAGIC) fail('请选择网页版导出的 .ours 文件。');
  const view = new DataView(prefix.buffer);
  const length = view.getUint32(8, false);
  if (!length || length > MAX_MANIFEST || HEADER_SIZE + length > file.size) fail('文件目录不完整或过大。');
  const manifestBytes = new Uint8Array(await file.slice(HEADER_SIZE, HEADER_SIZE + length).arrayBuffer());
  if (crcBytes(manifestBytes) !== view.getUint32(12, false)) fail('文件目录校验失败，请换用完整的备份。');
  let manifest;
  try { manifest = JSON.parse(decoder.decode(manifestBytes)); }
  catch { fail('文件目录无法读取。'); }
  if (!manifest || manifest.format !== 'ours-web-backup' || manifest.version !== 1 || !Array.isArray(manifest.memories) || manifest.memories.length > MAX_RECORDS) fail('备份版本或内容不受支持。');
  let offset = HEADER_SIZE + length;
  const ids = new Set();
  const idOk = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const records = [];
  for (const record of manifest.memories) {
    if (!record || !idOk(record.id) || ids.has(record.id) || !validDate(record.date) || typeof record.text !== 'string' || record.text.length > 10000 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 || !Array.isArray(record.media) || record.media.length > 9) fail('回忆信息无效或重复。');
    ids.add(record.id);
    const mediaIds = new Set();
    const media = [];
    for (const item of record.media) {
      if (!item || !idOk(item.id) || mediaIds.has(item.id) || typeof item.name !== 'string' || item.name.length > 255 || typeof item.type !== 'string' || !/^(image|video)\/[a-zA-Z0-9.+_-]+$/.test(item.type) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_MEDIA || !Number.isInteger(item.crc32) || item.crc32 < 0 || item.crc32 > 0xffffffff || offset + item.size > file.size) fail('媒体信息无效或文件不完整。');
      mediaIds.add(item.id);
      const blob = file.slice(offset, offset + item.size, item.type);
      offset += item.size;
      if (await crcBlob(blob) !== item.crc32) fail('媒体校验失败，请换用完整的备份。');
      media.push({ id: item.id, name: item.name, type: item.type, blob });
    }
    if (!record.text.trim() && !media.length) fail('备份包含没有内容的回忆。');
    records.push({ id: record.id, date: record.date, text: record.text, createdAt: record.createdAt, updatedAt: record.updatedAt, media });
  }
  if (offset !== file.size) fail('文件长度不匹配。');
  return records;
}
