// Read-only parser for ZIPs produced by cloudfunctions/ours/backup.js.
//
// API: await parseWxBackup(fileInput.files) -> {
//   records, manifest, mediaByFileID: Map<cloudFileID, Blob>, parts,
//   limits, checks, warnings
// }
// It returns only after all selected volumes, references and CRC-32 values pass.
// A caller must separately obtain confirmation and define a conflict policy before
// writing anything. CRC-32 is not a cryptographic hash or proof of provenance.

const MiB = 1024 * 1024;
export const WX_IMPORT_LIMITS = Object.freeze({
  maxParts: 128,
  maxVolumeBytes: 640 * MiB,
  maxArchiveBytes: 1536 * MiB,
  maxMediaBytes: 512 * MiB,
  maxTotalMediaBytes: 1024 * MiB,
  maxMediaFiles: 10000,
  maxRecords: 50000,
  maxRecordsJsonBytes: 16 * MiB,
  maxManifestJsonBytes: 8 * MiB,
  maxStatusJsonBytes: 64 * 1024,
  maxDirectoryBytes: 2 * MiB,
  maxPathBytes: 255,
  maxFileIDChars: 4096,
  maxJsonDepth: 64,
  maxJsonValues: 250000,
  readChunkBytes: 256 * 1024,
});

export class WxImportError extends Error {
  constructor(code, message) {
    super(`无法解析小程序备份：${message}`);
    this.name = 'WxImportError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new WxImportError(code, message); };
// Preserve a BOM as a character so it cannot disappear from a ZIP path or JSON.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const RECORD_LISTS = ['moments', 'anniversaries', 'moment_comments', 'moment_likes', 'checkins', 'notes', 'rants'];
const FIXED_FILES = new Set(['records.json', 'media-manifest.json', 'backup-status.json']);
const MEDIA_PATH = /^media\/[0-9]{5}\.[a-zA-Z0-9]+$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const u16 = (view, offset) => view.getUint16(offset, true);
const u32 = (view, offset) => view.getUint32(offset, true);

function u64(view, offset) {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('ZIP_FORMAT', 'ZIP64 数值超出安全范围。');
  return Number(value);
}

async function readBytes(blob, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > blob.size) {
    fail('ZIP_FORMAT', 'ZIP 文件位置或长度无效。');
  }
  try {
    const bytes = new Uint8Array(await Blob.prototype.slice.call(blob, start, start + length).arrayBuffer());
    if (bytes.length !== length) fail('READ_ERROR', '读取文件时长度发生变化。');
    return bytes;
  } catch (error) {
    if (error instanceof WxImportError) throw error;
    fail('READ_ERROR', '无法读取所选文件，请重新选择。');
  }
}

function viewOf(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();
function updateCRC(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function verifyCRC(bytes, entry) {
  if (((updateCRC(0xffffffff, bytes) ^ 0xffffffff) >>> 0) !== entry.crc) {
    fail('ZIP_CRC', `文件校验失败：${entry.name}。`);
  }
}
async function verifyMediaCRC(blob, entry) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < entry.size; offset += WX_IMPORT_LIMITS.readChunkBytes) {
    const bytes = await readBytes(blob, entry.dataOffset + offset, Math.min(WX_IMPORT_LIMITS.readChunkBytes, entry.size - offset));
    crc = updateCRC(crc, bytes);
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('ZIP_CRC', `媒体校验失败：${entry.name}。`);
}

// Reject duplicate JSON object keys and bound nesting and parsed object counts
// before JSON.parse allocates the object graph. JSON.parse remains the syntax parser.
function parseJSON(bytes, label) {
  let text;
  try { text = decoder.decode(bytes); } catch { fail('METADATA', `${label} 不是有效的 UTF-8。`); }
  const stack = [];
  let values = 0;
  const count = () => { if (++values > WX_IMPORT_LIMITS.maxJsonValues) fail('LIMIT', `${label} 包含过多 JSON 值。`); };
  const isSpace = char => char === ' ' || char === '\n' || char === '\r' || char === '\t';
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (isSpace(char) || char === ',' || char === ':') { i++; continue; }
    if (char === '{' || char === '[') {
      count();
      stack.push({ type: char, keys: char === '{' ? new Set() : null });
      if (stack.length > WX_IMPORT_LIMITS.maxJsonDepth) fail('LIMIT', `${label} 的 JSON 嵌套过深。`);
      i++; continue;
    }
    if (char === '}' || char === ']') {
      const top = stack.pop();
      if (!top || (char === '}' ? top.type !== '{' : top.type !== '[')) fail('METADATA', `${label} 的 JSON 结构无效。`);
      i++; continue;
    }
    if (char === '"') {
      count();
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') { closed = true; break; }
      }
      if (!closed) fail('METADATA', `${label} 的 JSON 字符串不完整。`);
      let next = i;
      while (next < text.length && isSpace(text[next])) next++;
      if (text[next] === ':' && stack.length && stack[stack.length - 1].type === '{') {
        let key;
        try { key = JSON.parse(text.slice(start, i)); } catch { fail('METADATA', `${label} 的 JSON 属性无效。`); }
        const keys = stack[stack.length - 1].keys;
        if (keys.has(key)) fail('METADATA', `${label} 包含重复的 JSON 属性。`);
        keys.add(key);
      }
      continue;
    }
    count();
    const start = i;
    while (i < text.length && !isSpace(text[i]) && !'{}[],:"'.includes(text[i])) i++;
    if (i === start) fail('METADATA', `${label} 的 JSON 内容无效。`);
    const token = text.slice(start, i);
    // The exporter uses JSON.stringify. Requiring the same numeric spelling
    // prevents JSON.parse from silently rounding or turning a number into Infinity.
    if (/^[-0-9]/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || JSON.stringify(number) !== token) fail('METADATA', `${label} 含有不能原样表示的 JSON 数值。`);
    }
  }
  if (stack.length) fail('METADATA', `${label} 的 JSON 结构不完整。`);
  try { return JSON.parse(text); } catch { fail('METADATA', `${label} 的 JSON 内容无效。`); }
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ZIP64 extra values appear only for the corresponding 0xffffffff fields,
// in the order uncompressed size, compressed size, local-header offset.
function zip64Fields(extra, fields) {
  let position = 0, zip64 = null;
  while (position < extra.length) {
    if (position + 4 > extra.length) fail('ZIP_FORMAT', 'ZIP 扩展字段不完整。');
    const header = viewOf(extra);
    const id = u16(header, position), length = u16(header, position + 2);
    position += 4;
    if (position + length > extra.length || id !== 1 || zip64) fail('ZIP_FORMAT', 'ZIP 包含不支持或重复的扩展字段。');
    zip64 = extra.subarray(position, position + length);
    position += length;
  }
  const needed = fields.filter(field => field.value === 0xffffffff);
  if (!needed.length) {
    if (zip64) fail('ZIP_FORMAT', 'ZIP64 扩展字段与文件信息不一致。');
    return;
  }
  if (!zip64 || zip64.length !== needed.length * 8) fail('ZIP_FORMAT', 'ZIP64 扩展字段不完整。');
  const view = viewOf(zip64);
  needed.forEach((field, index) => { field.value = u64(view, index * 8); });
}

async function readDirectory(blob) {
  if (blob.size < 22) fail('ZIP_FORMAT', 'ZIP 文件不完整。');
  const endOffset = blob.size - 22;
  const end = viewOf(await readBytes(blob, endOffset, 22));
  if (u32(end, 0) !== 0x06054b50 || u16(end, 20) !== 0 || u16(end, 4) !== 0 || u16(end, 6) !== 0) {
    fail('ZIP_FORMAT', 'ZIP 结束记录无效；不支持多磁盘 ZIP、注释或尾随数据。');
  }
  const diskEntries = u16(end, 8), shortCount = u16(end, 10), shortSize = u32(end, 12), shortOffset = u32(end, 16);
  let count = shortCount, size = shortSize, offset = shortOffset, directoryEnd = endOffset;
  if (diskEntries === 0xffff || shortCount === 0xffff || shortSize === 0xffffffff || shortOffset === 0xffffffff) {
    if (endOffset < 20) fail('ZIP_FORMAT', 'ZIP64 定位记录缺失。');
    const locator = viewOf(await readBytes(blob, endOffset - 20, 20));
    if (u32(locator, 0) !== 0x07064b50 || u32(locator, 4) !== 0 || u32(locator, 16) !== 1) fail('ZIP_FORMAT', 'ZIP64 定位记录无效。');
    const zip64Offset = u64(locator, 8);
    if (zip64Offset + 56 !== endOffset - 20) fail('ZIP_FORMAT', 'ZIP64 结束记录位置无效。');
    const zip64 = viewOf(await readBytes(blob, zip64Offset, 56));
    if (u32(zip64, 0) !== 0x06064b50 || u64(zip64, 4) !== 44 || u32(zip64, 16) !== 0 || u32(zip64, 20) !== 0) fail('ZIP_FORMAT', 'ZIP64 结束记录无效。');
    const onDisk = u64(zip64, 24);
    count = u64(zip64, 32); size = u64(zip64, 40); offset = u64(zip64, 48);
    if (onDisk !== count || (diskEntries !== 0xffff && diskEntries !== count) || (shortCount !== 0xffff && shortCount !== count) ||
        (shortSize !== 0xffffffff && shortSize !== size) || (shortOffset !== 0xffffffff && shortOffset !== offset)) {
      fail('ZIP_FORMAT', 'ZIP64 文件数量或目录与结束记录不一致。');
    }
    directoryEnd = zip64Offset;
  } else if (diskEntries !== count) fail('ZIP_FORMAT', '不支持多磁盘 ZIP。');
  if (count < 3 || count > WX_IMPORT_LIMITS.maxMediaFiles + 3 || size > WX_IMPORT_LIMITS.maxDirectoryBytes) fail('LIMIT', 'ZIP 目录中的文件数量或目录大小超过上限。');
  if (offset + size !== directoryEnd) fail('ZIP_FORMAT', 'ZIP 中央目录位置或大小无效。');
  const bytes = await readBytes(blob, offset, size), view = viewOf(bytes), entries = [], names = new Set();
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > bytes.length || u32(view, position) !== 0x02014b50) fail('ZIP_FORMAT', 'ZIP 中央目录不完整。');
    const flags = u16(view, position + 8), method = u16(view, position + 10);
    const nameLength = u16(view, position + 28), extraLength = u16(view, position + 30), commentLength = u16(view, position + 32);
    const endPosition = position + 46 + nameLength + extraLength + commentLength;
    if (endPosition > bytes.length || !nameLength || nameLength > WX_IMPORT_LIMITS.maxPathBytes || extraLength > 28 || commentLength || u16(view, position + 34) !== 0) fail('ZIP_FORMAT', 'ZIP 目录项无效。');
    if ((flags & ~0x0808) !== 0 || method !== 0) fail('ZIP_FORMAT', '只支持未加密、未压缩的小程序备份 ZIP。');
    const madeBy = u16(view, position + 4) >>> 8, attributes = u32(view, position + 38);
    const fileType = (attributes >>> 16) & 0xf000;
    if ((attributes & 0x10) || (madeBy === 3 && fileType !== 0 && fileType !== 0x8000)) fail('ZIP_FORMAT', 'ZIP 包含目录、链接或特殊文件。');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    let name;
    try { name = decoder.decode(nameBytes); } catch { fail('ZIP_FORMAT', 'ZIP 文件名不是有效 UTF-8。'); }
    if ((!FIXED_FILES.has(name) && !MEDIA_PATH.test(name)) || names.has(name)) fail('ZIP_FORMAT', 'ZIP 包含重复或非预期的文件路径。');
    names.add(name);
    const uncompressed = { value: u32(view, position + 24) }, compressed = { value: u32(view, position + 20) }, localOffset = { value: u32(view, position + 42) };
    zip64Fields(bytes.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength), [uncompressed, compressed, localOffset]);
    if (uncompressed.value !== compressed.value) fail('ZIP_FORMAT', 'ZIP 条目的压缩和原始大小不一致。');
    if (uncompressed.value > WX_IMPORT_LIMITS.maxMediaBytes) fail('LIMIT', 'ZIP 条目超过单个媒体大小上限。');
    entries.push({ name, nameBytes, flags, crc: u32(view, position + 16), size: uncompressed.value, localOffset: localOffset.value });
    position = endPosition;
  }
  if (position !== bytes.length || [...FIXED_FILES].some(name => !names.has(name))) fail('ZIP_FORMAT', 'ZIP 目录不完整或包含额外数据。');

  // Local headers, data, and descriptors must form one contiguous, nonoverlapping
  // sequence. Never trust central-directory sizes without checking these bounds.
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (byOffset[0].localOffset !== 0) fail('ZIP_FORMAT', 'ZIP 包含非预期的前置数据。');
  for (let i = 0; i < byOffset.length; i++) {
    const entry = byOffset[i], next = i + 1 < byOffset.length ? byOffset[i + 1].localOffset : offset;
    if (entry.localOffset + 30 > next) fail('ZIP_FORMAT', 'ZIP 条目重叠或不完整。');
    const local = viewOf(await readBytes(blob, entry.localOffset, 30));
    if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== entry.flags || u16(local, 8) !== 0) fail('ZIP_FORMAT', 'ZIP 本地文件头与目录不一致。');
    const nameLength = u16(local, 26), extraLength = u16(local, 28);
    if (nameLength !== entry.nameBytes.length || extraLength > 20 || entry.localOffset + 30 + nameLength + extraLength > next) fail('ZIP_FORMAT', 'ZIP 本地文件名或扩展字段无效。');
    const variable = await readBytes(blob, entry.localOffset + 30, nameLength + extraLength);
    if (!equalBytes(variable.subarray(0, nameLength), entry.nameBytes)) fail('ZIP_FORMAT', 'ZIP 本地文件名与目录不一致。');
    const uncompressed = { value: u32(local, 22) }, compressed = { value: u32(local, 18) };
    zip64Fields(variable.subarray(nameLength), [uncompressed, compressed]);
    const localCRC = u32(local, 14), usesDescriptor = !!(entry.flags & 8);
    if ((!usesDescriptor && (localCRC !== entry.crc || uncompressed.value !== entry.size || compressed.value !== entry.size)) ||
        (usesDescriptor && ((localCRC !== 0 && localCRC !== entry.crc) || (uncompressed.value !== 0 && uncompressed.value !== entry.size) || (compressed.value !== 0 && compressed.value !== entry.size)))) {
      fail('ZIP_FORMAT', 'ZIP 本地文件大小或校验值与目录不一致。');
    }
    entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = entry.dataOffset + entry.size, descriptorLength = next - dataEnd;
    if (dataEnd > next) fail('ZIP_FORMAT', 'ZIP 条目数据重叠或不完整。');
    if (!usesDescriptor) {
      if (descriptorLength !== 0) fail('ZIP_FORMAT', 'ZIP 条目之间存在非预期数据。');
    } else {
      if (![12, 16, 20, 24].includes(descriptorLength)) fail('ZIP_FORMAT', 'ZIP 数据描述符长度无效。');
      const descriptor = viewOf(await readBytes(blob, dataEnd, descriptorLength));
      const signed = descriptorLength === 16 || descriptorLength === 24, wide = descriptorLength === 20 || descriptorLength === 24;
      const start = signed ? 4 : 0;
      if ((signed && u32(descriptor, 0) !== 0x08074b50) || u32(descriptor, start) !== entry.crc ||
          (wide ? u64(descriptor, start + 4) : u32(descriptor, start + 4)) !== entry.size ||
          (wide ? u64(descriptor, start + 12) : u32(descriptor, start + 8)) !== entry.size) fail('ZIP_FORMAT', 'ZIP 数据描述符与目录不一致。');
    }
  }
  return entries;
}

async function readJSONEntry(blob, entry, limit) {
  if (!entry.size || entry.size > limit) fail('LIMIT', `${entry.name} 为空或超过大小上限。`);
  const bytes = await readBytes(blob, entry.dataOffset, entry.size);
  verifyCRC(bytes, entry);
  return bytes;
}

function validateRecords(records) {
  if (!isObject(records) || !Number.isSafeInteger(records.exportedAt) || records.exportedAt < 0 || !isObject(records.space)) fail('METADATA', '记录文件结构无效。');
  let count = 0;
  for (const key of RECORD_LISTS) {
    if (!Array.isArray(records[key]) || records[key].some(item => !isObject(item))) fail('METADATA', `记录列表 ${key} 无效。`);
    count += records[key].length;
    if (count > WX_IMPORT_LIMITS.maxRecords) fail('LIMIT', '备份记录数量超过上限。');
  }
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest)) fail('METADATA', '媒体清单不是数组。');
  if (manifest.length > WX_IMPORT_LIMITS.maxMediaFiles) fail('LIMIT', '媒体数量超过上限。');
  const byPath = new Map(), byID = new Map();
  manifest.forEach((item, index) => {
    if (!isObject(item) || typeof item.fileID !== 'string' || !item.fileID.startsWith('cloud://') || item.fileID.length <= 8 ||
        item.fileID.length > WX_IMPORT_LIMITS.maxFileIDChars || /[\u0000-\u001f\u007f]/.test(item.fileID) || typeof item.path !== 'string') {
      fail('METADATA', '媒体清单条目无效。');
    }
    const extension = item.fileID.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.bin';
    const expectedPath = `media/${String(index + 1).padStart(5, '0')}${extension}`;
    if (item.path !== expectedPath || !MEDIA_PATH.test(item.path) || item.path.length > WX_IMPORT_LIMITS.maxPathBytes) fail('METADATA', '媒体清单包含非预期的路径。');
    if (own(item, 'size') && (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > WX_IMPORT_LIMITS.maxMediaBytes)) fail('METADATA', '媒体清单中的大小无效或超过上限。');
    if (byPath.has(item.path) || byID.has(item.fileID)) fail('METADATA', '媒体清单包含重复文件或文件 ID。');
    byPath.set(item.path, item); byID.set(item.fileID, item);
  });
  return { byPath, byID };
}

// Implemented against the exact fields collected by startBackup; arbitrary text
// mentioning a cloud:// URL is not itself a media reference.
function validateReferences(records, manifestByID) {
  const references = new Set();
  function add(value, required = false) {
    if (value === undefined || value === null || value === '') {
      if (required) fail('MEDIA', '记录中的媒体条目缺少文件引用。');
      return;
    }
    if (typeof value !== 'string') fail('MEDIA', '记录包含无法识别的媒体引用。');
    // The exporter stores only cloud:// media. An external or local path in a
    // known media field has no bytes in this ZIP and cannot be migrated safely.
    if (!value.startsWith('cloud://')) fail('MEDIA', '记录包含未打包的外部或本地媒体引用，备份无法完整离线迁移。');
    references.add(value);
  }
  function list(record, key) {
    const value = record[key];
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value)) fail('MEDIA', `记录中的 ${key} 媒体列表无效。`);
    return value;
  }
  for (const record of [...records.moments, ...records.rants]) {
    for (const value of list(record, 'images')) add(value, true);
    for (const value of list(record, 'videos')) add(value, true);
    add(record.videoCover);
    for (const item of list(record, 'livePhotos')) {
      if (!isObject(item)) fail('MEDIA', '记录中的实况照片引用无效。');
      add(item.cover, true); add(item.video, true);
    }
    for (const item of list(record, 'voices')) {
      if (!isObject(item)) fail('MEDIA', '记录中的语音引用无效。');
      add(item.fileID, true);
    }
  }
  for (const key of ['memberA', 'memberB']) {
    const member = records.space[key];
    if (member === undefined || member === null) continue;
    if (!isObject(member)) fail('MEDIA', '空间成员信息无效。');
    add(member.avatarUrl);
  }
  for (const id of references) if (!manifestByID.has(id)) fail('MEDIA', '记录引用的媒体未列入清单。');
  for (const id of manifestByID.keys()) if (!references.has(id)) fail('MEDIA', '媒体清单包含记录中未引用的文件。');
}

/**
 * Parse all selected volumes from one local mini-program backup. Accepts an
 * iterable of File/Blob objects, including a FileList, and performs no writes.
 * Unsupported layouts and limits throw WxImportError with a stable `code`.
 */
export async function parseWxBackup(selectedFiles) {
  if (!selectedFiles || typeof selectedFiles[Symbol.iterator] !== 'function') fail('INVALID_INPUT', '请选择全部备份分卷。');
  const files = [];
  let totalArchiveBytes = 0;
  for (const file of selectedFiles) {
    if (files.length >= WX_IMPORT_LIMITS.maxParts) fail('LIMIT', '所选分卷数量超过上限。');
    try { Blob.prototype.slice.call(file, 0, 0); } catch { fail('INVALID_INPUT', '所选内容必须是文件。'); }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > WX_IMPORT_LIMITS.maxVolumeBytes) fail('LIMIT', '所选分卷为空或超过单卷大小上限。');
    totalArchiveBytes += file.size;
    if (totalArchiveBytes > WX_IMPORT_LIMITS.maxArchiveBytes) fail('LIMIT', '所选 ZIP 总大小超过上限。');
    files.push(file);
  }
  if (!files.length) fail('INVALID_INPUT', '请选择全部备份分卷。');

  let recordsBytes, manifestBytes, records, manifest, manifestIndex, expectedParts, totalEntries = 0, totalMediaBytes = 0;
  const seenParts = new Set(), mediaEntries = new Map();
  for (const blob of files) {
    const entries = await readDirectory(blob);
    totalEntries += entries.length;
    if (totalEntries > WX_IMPORT_LIMITS.maxMediaFiles + 3 * files.length) fail('LIMIT', 'ZIP 条目总数超过上限。');
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    const thisRecords = await readJSONEntry(blob, byName.get('records.json'), WX_IMPORT_LIMITS.maxRecordsJsonBytes);
    const thisManifest = await readJSONEntry(blob, byName.get('media-manifest.json'), WX_IMPORT_LIMITS.maxManifestJsonBytes);
    const statusBytes = await readJSONEntry(blob, byName.get('backup-status.json'), WX_IMPORT_LIMITS.maxStatusJsonBytes);
    const status = parseJSON(statusBytes, 'backup-status.json');
    if (!isObject(status) || !Number.isSafeInteger(status.part) || !Number.isSafeInteger(status.parts) || status.parts < 1 ||
        status.parts > WX_IMPORT_LIMITS.maxParts || status.part < 0 || status.part >= status.parts || !Array.isArray(status.missing) || status.missing.length !== 0) {
      fail('PARTS', '分卷编号、总数或缺失媒体状态无效。');
    }
    if (expectedParts === undefined) expectedParts = status.parts;
    if (status.parts !== expectedParts || seenParts.has(status.part)) fail('PARTS', '分卷总数不一致或分卷重复。');
    seenParts.add(status.part);
    if (!recordsBytes) {
      recordsBytes = thisRecords; manifestBytes = thisManifest;
      records = parseJSON(recordsBytes, 'records.json'); validateRecords(records);
      manifest = parseJSON(manifestBytes, 'media-manifest.json'); manifestIndex = validateManifest(manifest);
    } else if (!equalBytes(recordsBytes, thisRecords) || !equalBytes(manifestBytes, thisManifest)) {
      fail('PARTS', '各分卷的记录或完整媒体清单不一致。');
    }
    for (const entry of entries) {
      if (FIXED_FILES.has(entry.name)) continue;
      const item = manifestIndex.byPath.get(entry.name);
      if (!item) fail('MEDIA', 'ZIP 包含媒体清单之外的文件。');
      if (mediaEntries.has(entry.name)) fail('MEDIA', '多个分卷包含同一个媒体文件。');
      if (own(item, 'size') && item.size !== entry.size) fail('MEDIA', '媒体文件大小与清单不一致。');
      totalMediaBytes += entry.size;
      if (totalMediaBytes > WX_IMPORT_LIMITS.maxTotalMediaBytes) fail('LIMIT', '媒体总大小超过上限。');
      mediaEntries.set(entry.name, { blob, entry, item });
    }
  }
  if (files.length !== expectedParts || seenParts.size !== expectedParts) fail('PARTS', '备份分卷不完整，请选择所有分卷。');
  for (let part = 0; part < expectedParts; part++) if (!seenParts.has(part)) fail('PARTS', '备份缺少分卷。');
  if (mediaEntries.size !== manifest.length) fail('MEDIA', '备份缺少媒体清单中的文件。');
  validateReferences(records, manifestIndex.byID);

  const mediaByFileID = new Map();
  for (const item of manifest) {
    const { blob, entry } = mediaEntries.get(item.path);
    await verifyMediaCRC(blob, entry);
    mediaByFileID.set(item.fileID, Blob.prototype.slice.call(blob, entry.dataOffset, entry.dataOffset + entry.size));
  }
  return {
    records, manifest, mediaByFileID, parts: expectedParts, limits: WX_IMPORT_LIMITS,
    checks: Object.freeze({ zipCRC32: true, allKnownMediaReferencesPresent: true, crossBackupIdentityVerified: false, mediaAuthenticityVerified: false }),
    warnings: [
      '仅检查小程序已知媒体字段及成员头像；未知自定义字段可能包含未识别的引用。',
      '旧备份没有可靠的跨卷备份标识；即使记录和清单相同，也无法保证分卷来自同一次备份。',
      '媒体没有可信内容哈希；ZIP CRC-32 只能发现常见损坏，不能证明媒体内容真实或未被篡改。',
      '解析不会写入数据；后续导入必须由用户确认并明确冲突处理策略，不能自动覆盖。',
    ],
  };
}
