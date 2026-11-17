import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, readBackup, MAX_MEDIA } from '../backup.js';
import { prepareWxMemories } from '../wx-prepare.js';

const lists = ['moments', 'anniversaries', 'moment_comments', 'moment_likes', 'checkins', 'notes', 'rants'];
const photo = 'cloud://test/image.jpg', video = 'cloud://test/movie.mp4', cover = 'cloud://test/cover.png';
const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);
const mp4 = new Blob([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])]);
const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]);
const media = new Map([[photo, jpeg], [video, mp4], [cover, png]]);
const moment = overrides => ({ _id: 'original-id', coupleId: 'space-a', kind: 'post', content: '原文', momentDate: '2024-02-29', createdAt: 1700000000000, images: [], videos: [], ...overrides });
function input(moments, overrides = {}) {
  const records = { space: {}, exportedAt: 1, ...Object.fromEntries(lists.map(key => [key, []])), moments, ...overrides };
  return { records, mediaByFileID: media };
}
async function skip(record, reason) {
  const result = await prepareWxMemories(input([record]));
  assert.equal(result.ready.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, reason);
}

test('stable IDs use source and original ID, and survive .ours round trip', async () => {
  const one = await prepareWxMemories(input([moment({ images: [photo], videos: [video], videoCover: cover })]));
  const differentExport = await prepareWxMemories(input([moment({ content: 'later edit' })]));
  const otherSpace = await prepareWxMemories(input([moment({ coupleId: 'space-b' })]));
  const otherRecord = await prepareWxMemories(input([moment({ _id: 'other' })]));
  assert.equal(one.ready[0].memory.id, differentExport.ready[0].memory.id);
  assert.notEqual(one.ready[0].memory.id, otherSpace.ready[0].memory.id);
  assert.notEqual(one.ready[0].memory.id, otherRecord.ready[0].memory.id);
  const memory = one.ready[0].memory;
  assert.deepEqual(memory.media.map(item => item.type), ['image/jpeg', 'video/mp4', 'image/png']);
  assert.equal(memory.media.length, 3);
  const restored = await readBackup(await createBackup([memory]));
  assert.equal(restored[0].id, memory.id);
  assert.equal(restored[0].text, '原文');
  for (let i = 0; i < memory.media.length; i++) assert.deepEqual(await restored[0].media[i].blob.arrayBuffer(), await memory.media[i].blob.arrayBuffer());
});

test('imports real moment media counters and skips inconsistent counters without losing media', async () => {
  const normal = await prepareWxMemories(input([moment({
    images: [photo], videos: [video], videoCover: cover,
    mediaItems: 3, mediaBytes: jpeg.size + mp4.size + png.size,
  })]));
  assert.equal(normal.ready.length, 1);
  assert.deepEqual(normal.ready[0].memory.media.map(item => item.type), ['image/jpeg', 'video/mp4', 'image/png']);

  // The source counts repeated references, but counts bytes only once per file ID.
  const repeated = await prepareWxMemories(input([moment({
    images: [photo, photo], videoCover: photo, mediaItems: 3, mediaBytes: jpeg.size,
  })]));
  assert.equal(repeated.ready.length, 1);
  assert.equal(repeated.ready[0].memory.media.length, 2);

  await skip(moment({ mediaItems: 1, mediaBytes: 0 }), /媒体数量统计/);
  await skip(moment({ images: [photo], mediaItems: 2 }), /媒体数量统计/);
  await skip(moment({ images: [photo], mediaItems: '1' }), /媒体数量统计/);
  await skip(moment({ mediaBytes: -1 }), /媒体大小统计/);
  await skip(moment({ mediaBytes: { fileID: photo } }), /媒体大小统计/);
  await skip(moment({ images: [photo], mediaItems: 1, mediaBytes: jpeg.size + 1 }), /媒体大小统计/);
  await skip(moment({ mediaBytes: jpeg.size }), /媒体大小统计/);
});

test('rejects ambiguous identity and does not merge independent record kinds', async () => {
  await skip(moment({ coupleId: '' }), /来源空间/);
  await skip(moment({ _id: undefined }), /原始 _id/);
  await skip(moment({ kind: 'system' }), /系统记录/);
  await skip(moment({ kind: undefined }), /普通回忆/);
  const duplicate = await prepareWxMemories(input([moment(), moment({ content: 'conflict' })]));
  assert.equal(duplicate.ready.length, 0);
  assert.equal(duplicate.skipped.length, 2);
  assert.ok(duplicate.skipped.every(item => /重复/.test(item.reason)));
  const mixed = await prepareWxMemories(input([moment()], { notes: [{ coupleId: 'space-b' }], rants: [{ coupleId: 'space-a' }] }));
  assert.equal(mixed.conflictingSources, true);
  assert.equal(mixed.ready.length, 0);
  assert.equal(mixed.omitted.notes, 1);
  assert.equal(mixed.omitted.rants, 1);
});

test('uses occurrence date or the same UTC+8 fallback as the mini-program', async () => {
  const old = moment({ momentDate: undefined, createdAt: Date.parse('2024-01-01T16:30:00Z') });
  const prepared = await prepareWxMemories(input([old]));
  assert.equal(prepared.ready[0].memory.date, '2024-01-02');
  await skip(moment({ momentDate: '2023-02-29' }), /日期无效/);
  await skip(moment({ momentDate: undefined, createdAt: 'unknown' }), /日期无效/);
  const noTimestamp = await prepareWxMemories(input([moment({ createdAt: null })]));
  assert.equal(noTimestamp.ready[0].memory.createdAt, Date.parse('2024-02-29T00:00:00+08:00'));
});

test('skips whole records with unsupported, missing, unrecognized, or oversized media', async () => {
  await skip(moment({ voices: [{ fileID: 'cloud://test/voice' }] }), /语音/);
  await skip(moment({ livePhotos: [{ cover: photo, video }] }), /实况/);
  await skip(moment({ images: Array(10).fill(photo) }), /9 个/);
  await skip(moment({ images: [photo], videos: [video], attachments: ['elsewhere'] }), /其他媒体/);
  await skip(moment({ images: ['cloud://test/missing'] }), /缺失/);
  await skip(moment({ images: [video] }), /格式/);
  const unknown = input([moment({ images: [photo] })]);
  unknown.mediaByFileID = new Map([[photo, new Blob(['unknown'])]]);
  const invalid = await prepareWxMemories(unknown);
  assert.match(invalid.skipped[0].reason, /格式/);
  class Oversized extends Blob { get size() { return MAX_MEDIA + 1; } }
  const tooBig = input([moment({ images: [photo] })]);
  tooBig.mediaByFileID = new Map([[photo, new Oversized(['x'])]]);
  const oversized = await prepareWxMemories(tooBig);
  assert.equal(oversized.ready.length, 0);
  assert.match(oversized.skipped[0].reason, /100 MB/);
});

test('rejects invalid text and empty content rather than creating partial memories', async () => {
  await skip(moment({ content: 12 }), /文字格式/);
  await skip(moment({ content: 'x'.repeat(10001) }), /10000/);
  await skip(moment({ content: '  ' }), /没有可导入/);
  await skip(moment({ content: 'normal', custom: { attachment: 'https://elsewhere.invalid/a' } }), /其他媒体/);
  await skip(moment({ imageUrl: 'https://elsewhere.invalid/a' }), /其他媒体/);
  await skip(moment({ metadata: { videoPath: '/local/file' } }), /其他媒体/);
  await skip(moment({ metadata: { attachmentCount: 1 } }), /其他媒体/);
  const noExtraMedia = await prepareWxMemories(input([moment({ metadata: { hasVideo: false, imageCount: 0 } })]));
  assert.equal(noExtraMedia.ready.length, 1);
});
