import { MAX_MEDIA, validDate } from './backup.js';

const RECORD_LISTS = ['moments', 'anniversaries', 'moment_comments', 'moment_likes', 'checkins', 'notes', 'rants'];
const HANDLED_MEDIA = new Set(['images', 'videos', 'videoCover', 'livePhotos', 'voices', 'mediaItems', 'mediaBytes']);
const MEDIA_FIELD = /(?:image|photo|picture|video|voice|audio|media|attachment|cover|thumbnail|poster|avatar|file(?:id|url|path|name|list|ref))/i;
const mediaField = key => MEDIA_FIELD.test(key) || /(?:^|[_-])files?$/i.test(key) || /File(?:s)?$/.test(key);
const CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();

function usableId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !CONTROL.test(value);
}

async function stableId(spaceId, recordId) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器无法生成稳定标识；请使用较新的浏览器并通过 HTTPS 或本机地址打开。');
  // JSON preserves component boundaries, and the prefix remains valid in .ours backups.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([spaceId, recordId])));
  return `wx_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function list(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : null;
}
function populated(value) {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
}
function unknownMedia(record) {
  function visit(value, key) {
    if (typeof value === 'string') return value.startsWith('cloud://') || (mediaField(key) && value !== '');
    if (Array.isArray(value)) return (mediaField(key) && value.length > 0) || value.some(item => visit(item, ''));
    if (value && typeof value === 'object') return (mediaField(key) && Object.keys(value).length > 0) || Object.entries(value).some(([child, item]) => visit(item, child));
    return mediaField(key) && (value === true || (typeof value === 'number' && value !== 0));
  }
  return Object.entries(record).some(([key, value]) => key !== 'content' && !HANDLED_MEDIA.has(key) && visit(value, key));
}
function sourceDate(record) {
  if (record.momentDate !== undefined && record.momentDate !== null && record.momentDate !== '') {
    return validDate(record.momentDate) ? record.momentDate : null;
  }
  // The mini-program displays legacy moments without momentDate in UTC+8.
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || record.createdAt > 8640000000000000 - 28800000) return null;
  const date = new Date(record.createdAt + 28800000).toISOString().slice(0, 10);
  return validDate(date) ? date : null;
}
function timestamp(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// Identify a small, explicit set by file bytes rather than trusting a filename or URL.
// Signatures do not establish that the complete file is decodable or authentic.
async function mediaFormat(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return { type: 'image/png', extension: 'png' };
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { type: 'image/gif', extension: 'gif' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { type: 'image/webp', extension: 'webp' };
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'qt  ') return { type: 'video/quicktime', extension: 'mov' };
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |3gp[0-9]|3g2[0-9]|dash)$/.test(brand)) return { type: 'video/mp4', extension: 'mp4' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(0, bytes.length).includes('webm')) return { type: 'video/webm', extension: 'webm' };
  return null;
}
function label(record, index) {
  const raw = typeof record._id === 'string' ? record._id.replace(/[\u0000-\u001f\u007f]/g, '�') : '缺少 ID';
  return `回忆 ${index + 1}（原 ID：${raw}）`;
}

// This phase is read-only. Every prepared object has the shape accepted by .ours.
export async function prepareWxMemories(parsed) {
  const { records, mediaByFileID } = parsed;
  const sourceIds = new Set();
  for (const key of RECORD_LISTS) {
    for (const item of records[key]) if (usableId(item.coupleId)) sourceIds.add(item.coupleId);
  }
  const conflictingSources = sourceIds.size > 1;
  const ready = [], skipped = [];
  const idCounts = new Map();
  for (const record of records.moments) {
    if (usableId(record.coupleId) && usableId(record._id)) {
      const key = JSON.stringify([record.coupleId, record._id]);
      idCounts.set(key, (idCounts.get(key) || 0) + 1);
    }
  }
  const reject = (record, index, reason) => skipped.push({ label: label(record, index), reason });
  for (let index = 0; index < records.moments.length; index++) {
    const record = records.moments[index];
    if (record.kind !== 'post') { reject(record, index, '不是可安全识别的普通回忆（可能是签到生成的系统记录）'); continue; }
    if (conflictingSources) { reject(record, index, '备份中的来源空间标识相互矛盾，无法安全确定来源'); continue; }
    if (!usableId(record.coupleId) || !usableId(record._id)) { reject(record, index, '缺少或无法安全识别来源空间 coupleId 或原始 _id'); continue; }
    if (idCounts.get(JSON.stringify([record.coupleId, record._id])) !== 1) { reject(record, index, '同一来源空间中原始 _id 重复，无法判断哪条是原记录'); continue; }
    const date = sourceDate(record);
    if (!date) { reject(record, index, '发生日期无效，且无法从创建时间安全还原'); continue; }
    if (record.content !== undefined && record.content !== null && typeof record.content !== 'string') { reject(record, index, '文字格式无法识别'); continue; }
    const text = record.content ?? '';
    if (text.length > 10000) { reject(record, index, '文字超过网页版每条 10000 字的上限'); continue; }
    const images = list(record.images), videos = list(record.videos), voices = list(record.voices), livePhotos = list(record.livePhotos);
    if (!images || !videos || !voices || !livePhotos) { reject(record, index, '媒体列表格式无法识别'); continue; }
    if (voices.length || livePhotos.length) { reject(record, index, '包含暂不支持的语音或实况照片'); continue; }
    if (unknownMedia(record)) { reject(record, index, '包含无法安全识别的其他媒体字段或引用'); continue; }
    // addMoment records these counters separately from its media references. The
    // cover is counted even if it happens to refer to the same image. A mismatch
    // can indicate missing references, so never silently import only the text.
    const sourceCount = images.length + videos.length + (populated(record.videoCover) ? 1 : 0);
    if (record.mediaItems != null && (!Number.isSafeInteger(record.mediaItems) || record.mediaItems < 0 || record.mediaItems !== sourceCount)) {
      reject(record, index, '媒体数量统计与可识别的引用不一致'); continue;
    }
    if (record.mediaBytes != null && (!Number.isSafeInteger(record.mediaBytes) || record.mediaBytes < 0)) {
      reject(record, index, '媒体大小统计无法安全识别'); continue;
    }
    const references = [
      ...images.map(id => ({ id, kind: 'image' })),
      ...videos.map(id => ({ id, kind: 'video' })),
    ];
    if (populated(record.videoCover) && !images.includes(record.videoCover)) references.push({ id: record.videoCover, kind: 'image' });
    if (references.length > 9) { reject(record, index, `包含 ${references.length} 个媒体文件，超过网页版每条 9 个的上限`); continue; }
    const media = [];
    const countedIds = new Set();
    let totalBytes = 0;
    let reason = '';
    for (const [position, ref] of references.entries()) {
      if (typeof ref.id !== 'string' || !ref.id.startsWith('cloud://') || !mediaByFileID.has(ref.id)) { reason = '媒体引用无效或对应文件缺失'; break; }
      const blob = mediaByFileID.get(ref.id);
      if (!(blob instanceof Blob) || blob.size < 1) { reason = '媒体文件为空或无法读取'; break; }
      if (blob.size > MAX_MEDIA) { reason = '媒体文件超过网页版单个 100 MB 的上限'; break; }
      const format = await mediaFormat(blob);
      if (!format || !format.type.startsWith(`${ref.kind}/`)) { reason = '媒体内容格式无法安全识别，或与图片/视频字段不符'; break; }
      if (!countedIds.has(ref.id)) { countedIds.add(ref.id); totalBytes += blob.size; }
      media.push({ id: `media_${position + 1}`, name: `媒体-${position + 1}.${format.extension}`, type: format.type, blob: blob.slice(0, blob.size, format.type) });
    }
    if (reason) { reject(record, index, reason); continue; }
    // The source counts bytes once per distinct cloud file ID.
    if (record.mediaBytes != null && record.mediaBytes !== totalBytes) {
      reject(record, index, '媒体大小统计与备份中的文件不一致'); continue;
    }
    if (!text.trim() && !media.length) { reject(record, index, '没有可导入的文字、图片或视频'); continue; }
    const fallback = Math.max(0, Date.parse(`${date}T00:00:00+08:00`) || 0);
    const createdAt = timestamp(record.createdAt, fallback);
    const updatedAt = timestamp(record.updatedAt, createdAt);
    ready.push({ label: label(record, index), memory: { id: await stableId(record.coupleId, record._id), date, text, createdAt, updatedAt, media } });
  }
  const omitted = {
    anniversaries: records.anniversaries.length, comments: records.moment_comments.length, likes: records.moment_likes.length,
    checkins: records.checkins.length, notes: records.notes.length, rants: records.rants.length,
  };
  return { ready, skipped, omitted, conflictingSources };
}
