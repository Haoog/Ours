import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseWxBackup, WxImportError, WX_IMPORT_LIMITS as limits } from '../wx-import.js';

const require = createRequire(import.meta.url);
const { zipBackupPart } = require('../../cloudfunctions/ours/backup.js');
const bytes = value => Buffer.from(value);
const json = value => JSON.stringify(value, null, 2);
const blobs = volumes => volumes.map(value => new Blob([value], { type: 'application/zip' }));
const lists = ['moments', 'anniversaries', 'moment_comments', 'moment_likes', 'checkins', 'notes', 'rants'];
function emptyRecords() {
  return { exportedAt: 1700000000000, space: { startDate: '2020-01-01', memberA: { nickname: 'A', avatarUrl: '' }, memberB: null }, ...Object.fromEntries(lists.map(key => [key, []])) };
}
function entry(fileID, index, content, includeSize = true) {
  const extension = fileID.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.bin';
  return { fileID, path: `media/${String(index + 1).padStart(5, '0')}${extension}`, ...(includeSize ? { size: bytes(content).length } : {}) };
}

// Independent bit-at-a-time CRC, used only for hand-crafted malicious fixtures.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function short(number) { const b = Buffer.alloc(2); b.writeUInt16LE(number); return b; }
function long(number) { const b = Buffer.alloc(4); b.writeUInt32LE(number >>> 0); return b; }
function quad(number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(number)); return b; }

// Minimal hand-crafted stored ZIP writer, including ZIP64 and data descriptors.
// This allows deliberate duplicate paths, hostile filenames and inconsistent headers.
function makeZip(items, { zip64 = true, zip64Entries = false, descriptor = false } = {}) {
  const locals = [], directories = [];
  let offset = 0;
  for (const item of items) {
    const name = bytes(item.name), localName = bytes(item.localName ?? item.name), data = bytes(item.data);
    const crc = item.crc ?? crc32(data), flags = item.flags ?? (descriptor ? 8 : 0), method = item.method ?? 0;
    const localExtra = zip64Entries ? Buffer.concat([short(1), short(16), quad(data.length), quad(data.length)]) : (item.localExtra ?? Buffer.alloc(0));
    const centralExtra = zip64Entries ? Buffer.concat([short(1), short(24), quad(data.length), quad(data.length), quad(offset)]) : (item.centralExtra ?? Buffer.alloc(0));
    const local = Buffer.concat([
      long(0x04034b50), short(zip64Entries ? 45 : 20), short(flags), short(method), long(0),
      long(descriptor ? 0 : crc), long(descriptor ? 0 : zip64Entries ? 0xffffffff : data.length), long(descriptor ? 0 : zip64Entries ? 0xffffffff : data.length),
      short(localName.length), short(localExtra.length), localName, localExtra, data,
      ...(descriptor ? [long(0x08074b50), long(crc), long(data.length), long(data.length)] : []),
    ]);
    const central = Buffer.concat([
      long(0x02014b50), short(0x031e), short(zip64Entries ? 45 : 20), short(flags), short(method), long(0), long(crc),
      long(zip64Entries ? 0xffffffff : data.length), long(zip64Entries ? 0xffffffff : data.length),
      short(name.length), short(centralExtra.length), short(0), short(0), short(0), long(item.attributes ?? 0x81a40000), long(zip64Entries ? 0xffffffff : offset), name, centralExtra,
    ]);
    locals.push(local); directories.push(central); offset += local.length;
  }
  const directory = Buffer.concat(directories), centralOffset = offset, centralSize = directory.length;
  let trailer;
  if (zip64) {
    trailer = Buffer.concat([
      long(0x06064b50), quad(44), short(45), short(45), long(0), long(0), quad(items.length), quad(items.length), quad(centralSize), quad(centralOffset),
      long(0x07064b50), long(0), quad(centralOffset + centralSize), long(1),
      long(0x06054b50), short(0), short(0), short(0xffff), short(0xffff), long(0xffffffff), long(0xffffffff), short(0),
    ]);
  } else {
    trailer = Buffer.concat([long(0x06054b50), short(0), short(0), short(items.length), short(items.length), long(centralSize), long(centralOffset), short(0)]);
  }
  return Buffer.concat([...locals, directory, trailer]);
}
function volume({ records = emptyRecords(), manifest = [], part = 0, parts = 1, media = [], missing = [], extraEntries = [], zipOptions = {}, rawRecords, rawManifest, status = { part, parts, missing } } = {}) {
  return makeZip([
    { name: 'records.json', data: rawRecords ?? json(records) },
    { name: 'media-manifest.json', data: rawManifest ?? json(manifest) },
    ...media.map(({ path, content }) => ({ name: path, data: content })),
    { name: 'backup-status.json', data: json(status) },
    ...extraEntries,
  ], zipOptions);
}
async function rejects(volumeList, code, message) {
  await assert.rejects(parseWxBackup(blobs(volumeList)), error => {
    assert.ok(error instanceof WxImportError);
    if (code) assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

// Invoke the real cloud generator with synthetic inputs and fully stubbed storage
// and HTTP; no requests, cloud files, or user data are accessed.
async function realVolumes(records, manifest, groups, contentByID) {
  const originalFetch = globalThis.fetch;
  const results = [];
  const cloud = {
    async getTempFileURL({ fileList }) { return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://mock.invalid/${encodeURIComponent(fileID)}` })) }; },
    async uploadFile({ fileContent }) {
      const chunks = [];
      for await (const chunk of fileContent) chunks.push(chunk);
      results.push(Buffer.concat(chunks));
      return { fileID: 'cloud://synthetic/upload' };
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'mock.invalid');
    const content = contentByID.get(decodeURIComponent(parsed.pathname.slice(1)));
    assert.ok(content !== undefined);
    if (options.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(bytes(content).length) } });
    return new Response(bytes(content));
  };
  try {
    const snapshot = { id: 'synthetic', coupleId: 'local-test', parts: groups.length, records, files: manifest };
    for (let part = 0; part < groups.length; part++) await zipBackupPart(cloud, snapshot, part, groups[part]);
  } finally { globalThis.fetch = originalFetch; }
  return results;
}

const photoID = 'cloud://example/memory/photo.jpg';
const voiceID = 'cloud://example/memory/voice.mp3';
const avatarID = 'cloud://example/member/avatar.png';
const one = entry(photoID, 0, 'photo');
const two = entry(voiceID, 1, 'audio');
const three = entry(avatarID, 2, 'face');
function withMedia() {
  const records = emptyRecords();
  records.moments.push({ _id: 'm1', images: [photoID, photoID], voices: [{ fileID: voiceID, duration: 2 }], content: 'saved raw' });
  records.space.memberA.avatarUrl = avatarID;
  return records;
}

await test('real cloud generator: no media, force ZIP64, no writes by parser', async () => {
  const records = emptyRecords();
  const generated = await realVolumes(records, [], [[]], new Map());
  assert.notEqual(generated[0].indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1);
  const result = await parseWxBackup(blobs(generated));
  assert.deepEqual(result.records, records);
  assert.deepEqual(result.manifest, []);
  assert.equal(result.mediaByFileID.size, 0);
  assert.equal(result.parts, 1);
  assert.equal(result.limits, limits);
  assert.equal(result.checks.crossBackupIdentityVerified, false);
  assert.equal(result.checks.mediaAuthenticityVerified, false);
  assert.match(result.warnings.join('\n'), /无法保证分卷来自同一次备份/);
  assert.match(result.warnings.join('\n'), /不能自动覆盖/);
});

await test('real cloud generator: all ZIP64 volumes and streamed descriptors, selected out of order', async () => {
  const records = withMedia(), manifest = [one, two, three];
  const generated = await realVolumes(records, manifest, [[one, two], [three]], new Map([[photoID, 'photo'], [voiceID, 'audio'], [avatarID, 'face']]));
  assert.notEqual(generated[0].indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])), -1);
  const result = await parseWxBackup(blobs(generated.reverse()));
  assert.deepEqual(result.records, records);
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.parts, 2);
  assert.equal(await result.mediaByFileID.get(photoID).text(), 'photo');
  assert.equal(await result.mediaByFileID.get(voiceID).text(), 'audio');
  assert.equal(await result.mediaByFileID.get(avatarID).text(), 'face');
  assert.equal(result.checks.zipCRC32, true);
  assert.equal(result.checks.allKnownMediaReferencesPresent, true);
});

await test('legacy ordinary ZIP, manifest without sizes, and ZIP64 entry extra fields', async () => {
  const records = emptyRecords(); records.moments.push({ images: [photoID] });
  const legacy = entry(photoID, 0, 'photo', false);
  for (const zipOptions of [{ zip64: false, descriptor: true }, { zip64: true, zip64Entries: true }]) {
    const result = await parseWxBackup(blobs([volume({ records, manifest: [legacy], media: [{ path: legacy.path, content: 'photo' }], zipOptions })]));
    assert.equal(await result.mediaByFileID.get(photoID).text(), 'photo');
    assert.ok(!Object.hasOwn(result.manifest[0], 'size'));
  }
  // Current generator can also export an old snapshot whose manifest lacks size.
  const generated = await realVolumes(records, [legacy], [[legacy]], new Map([[photoID, 'photo']]));
  const result = await parseWxBackup(blobs(generated));
  assert.equal(await result.mediaByFileID.get(photoID).text(), 'photo');
  assert.ok(!Object.hasOwn(result.manifest[0], 'size'));
});

await test('missing, duplicate, out-of-range and inconsistent volume statuses', async () => {
  const records = withMedia(), manifest = [one, two, three];
  const first = volume({ records, manifest, part: 0, parts: 2, media: [{ path: one.path, content: 'photo' }, { path: three.path, content: 'face' }] });
  const second = volume({ records, manifest, part: 1, parts: 2, media: [{ path: two.path, content: 'audio' }] });
  await rejects([first], 'PARTS');
  await rejects([first, first], 'PARTS', /重复/);
  await rejects([first, volume({ records, manifest, status: { part: 2, parts: 2, missing: [] } })], 'PARTS');
  await rejects([first, volume({ records, manifest, status: { part: 1, parts: 3, missing: [] } })], 'PARTS');
  await rejects([first, volume({ records, manifest, status: { part: 1, parts: 2, missing: [{ fileID: voiceID }] } })], 'PARTS');
  await rejects([first, volume({ records, manifest, status: { part: '1', parts: 2, missing: [] } })], 'PARTS');
  await rejects([first, volume({ records: { ...records, exportedAt: records.exportedAt + 1 }, manifest, part: 1, parts: 2 })], 'PARTS', /不一致/);
  await rejects([first, volume({ records, manifest: [one, two, { ...three, size: 5 }], part: 1, parts: 2 })], 'PARTS', /不一致/);
  assert.equal((await parseWxBackup(blobs([first, second]))).parts, 2);
});

await test('mixed backups with identical records/manifest cannot be authenticated', async () => {
  const records = emptyRecords(); records.moments.push({ images: [photoID, voiceID] });
  const first = volume({ records, manifest: [one, two], part: 0, parts: 2, media: [{ path: one.path, content: 'photo' }] });
  const otherBackupSecond = volume({ records, manifest: [one, two], part: 1, parts: 2, media: [{ path: two.path, content: 'other' }] });
  const result = await parseWxBackup(blobs([first, otherBackupSecond]));
  assert.equal(await result.mediaByFileID.get(voiceID).text(), 'other');
  assert.equal(result.checks.crossBackupIdentityVerified, false);
  assert.equal(result.checks.mediaAuthenticityVerified, false);
});

await test('missing, duplicate, unlisted or size-mismatched media are rejected', async () => {
  const records = emptyRecords(); records.moments.push({ images: [photoID] });
  const options = { records, manifest: [one], media: [{ path: one.path, content: 'photo' }] };
  await rejects([volume({ ...options, media: [] })], 'MEDIA', /缺少/);
  await rejects([volume({ ...options, media: [{ path: one.path, content: 'other!' }] })], 'MEDIA', /大小/);
  await rejects([volume({ ...options, extraEntries: [{ name: 'media/00002.jpg', data: 'x' }] })], 'MEDIA', /清单之外/);
  await rejects([volume({ ...options, extraEntries: [{ name: one.path, data: 'photo' }] })], 'ZIP_FORMAT', /重复/);
  const duplicateA = volume({ ...options, parts: 2, part: 0 });
  const duplicateB = volume({ ...options, parts: 2, part: 1 });
  await rejects([duplicateA, duplicateB], 'MEDIA', /多个分卷/);
  await rejects([volume({ ...options, manifest: [one, { ...one, path: 'media/00002.jpg' }] })], 'METADATA', /重复/);
});

await test('known media references are complete, unambiguous and offline', async () => {
  const records = emptyRecords(); records.moments.push({ images: [photoID] });
  await rejects([volume({ records })], 'MEDIA', /未列入清单/);
  await rejects([volume({ records: emptyRecords(), manifest: [one], media: [{ path: one.path, content: 'photo' }] })], 'MEDIA', /未引用/);
  const malformed = emptyRecords(); malformed.moments.push({ images: [{ fileID: photoID }] });
  await rejects([volume({ records: malformed })], 'MEDIA', /无法识别/);
  for (const incomplete of [
    { images: [null] }, { images: [''] }, { videos: [null] }, { voices: [{}] },
    { livePhotos: [{}] }, { livePhotos: [{ cover: photoID }] },
  ]) {
    const incompleteRecords = emptyRecords(); incompleteRecords.moments.push(incomplete);
    await rejects([volume({ records: incompleteRecords })], 'MEDIA', /缺少文件引用/);
  }
  const external = emptyRecords(); external.moments.push({ images: ['https://example.invalid/photo.jpg'] });
  await rejects([volume({ records: external })], 'MEDIA', /未打包/);
  const externalAvatar = emptyRecords(); externalAvatar.space.memberA.avatarUrl = 'https://example.invalid/avatar.png';
  await rejects([volume({ records: externalAvatar })], 'MEDIA', /未打包/);
  const plainText = emptyRecords(); plainText.notes.push({ content: photoID });
  await parseWxBackup(blobs([volume({ records: plainText })]));
});

await test('all source collector media fields and deduplicated references', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `cloud://example/${i}.bin`);
  const contents = ids.map((_, i) => `content-${i}`);
  const manifest = ids.map((id, i) => entry(id, i, contents[i]));
  const records = emptyRecords();
  records.moments.push({ images: [ids[0]], videos: [ids[1]], videoCover: ids[2], livePhotos: [{ cover: ids[3], video: ids[4] }], voices: [{ fileID: ids[5] }] });
  records.rants.push({ images: [ids[6], ids[0]] }); records.space.memberB = { avatarUrl: ids[7] };
  const result = await parseWxBackup(blobs([volume({ records, manifest, media: manifest.map((item, i) => ({ path: item.path, content: contents[i] })) })]));
  assert.equal(result.mediaByFileID.size, 8);
});

await test('empty media and CRC validation across chunk boundaries', async () => {
  const emptyID = 'cloud://example/empty.bin', largeID = 'cloud://example/large.bin';
  const large = Buffer.alloc(limits.readChunkBytes + 13);
  for (let i = 0; i < large.length; i++) large[i] = (i * 13) & 255;
  const manifest = [entry(emptyID, 0, ''), entry(largeID, 1, large)];
  const records = emptyRecords(); records.moments.push({ images: [emptyID, largeID] });
  const archive = volume({ records, manifest, media: [{ path: manifest[0].path, content: '' }, { path: manifest[1].path, content: large }] });
  const result = await parseWxBackup(blobs([archive]));
  assert.equal(result.mediaByFileID.get(emptyID).size, 0);
  assert.deepEqual(Buffer.from(await result.mediaByFileID.get(largeID).arrayBuffer()), large);
  const damaged = Buffer.from(archive), at = damaged.indexOf(large);
  assert.ok(at > 0); damaged[at + limits.readChunkBytes + 1] ^= 1;
  await rejects([damaged], 'ZIP_CRC');
});

await test('hostile paths, forged headers, symlinks, encryption, compression and extra fields', async () => {
  for (const name of ['../records.json', '/records.json', 'media/../00001.jpg', 'media\\00001.jpg', 'media/00001.jpg/evil', String.fromCharCode(0xfeff) + 'media/00001.jpg', 'other.json']) {
    await rejects([volume({ extraEntries: [{ name, data: 'x' }] })], 'ZIP_FORMAT');
  }
  await rejects([volume({ extraEntries: [{ name: 'media/00001.jpg', localName: '../outside.txt', data: 'x' }] })], 'ZIP_FORMAT');
  await rejects([volume({ extraEntries: [{ name: 'media/00001.jpg', attributes: 0xa1ff0000, data: 'x' }] })], 'ZIP_FORMAT');
  await rejects([volume({ extraEntries: [{ name: 'media/00001.jpg', flags: 1, data: 'x' }] })], 'ZIP_FORMAT');
  await rejects([volume({ extraEntries: [{ name: 'media/00001.jpg', method: 8, data: 'x' }] })], 'ZIP_FORMAT');
  await rejects([volume({ extraEntries: [{ name: 'media/00001.jpg', centralExtra: Buffer.from([0x75, 0x70, 0, 0]), data: 'x' }] })], 'ZIP_FORMAT');
  const prefixed = Buffer.concat([bytes('evil'), volume()]);
  await rejects([prefixed], 'ZIP_FORMAT');
  await rejects([Buffer.concat([volume(), bytes('trailing')])], 'ZIP_FORMAT');
  await rejects([volume().subarray(0, -1)], 'ZIP_FORMAT');
  const overlap = volume({ extraEntries: [{ name: 'media/00001.bin', data: 'x' }] });
  const centralName = overlap.lastIndexOf(bytes('media/00001.bin'));
  const centralStart = overlap.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), centralName);
  overlap.writeUInt32LE(0, centralStart + 42);
  await rejects([overlap], 'ZIP_FORMAT');
  const descriptor = volume({ zipOptions: { descriptor: true } });
  const descriptorStart = descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  assert.ok(descriptorStart > 0); descriptor[descriptorStart + 4] ^= 1;
  await rejects([descriptor], 'ZIP_FORMAT');
});

await test('tampering and duplicate JSON keys are rejected', async () => {
  const records = emptyRecords(); records.moments.push({ images: [photoID] });
  const archive = volume({ records, manifest: [one], media: [{ path: one.path, content: 'photo' }] });
  const damaged = Buffer.from(archive), mediaAt = damaged.indexOf(bytes('photo'), damaged.indexOf(bytes('media/00001.jpg')) + one.path.length);
  assert.ok(mediaAt >= 0); damaged[mediaAt] ^= 1;
  await rejects([damaged], 'ZIP_CRC');
  const duplicated = json(emptyRecords()).replace('"exportedAt": 1700000000000', '"exportedAt": 1, "exported\\u0041t": 1700000000000');
  await rejects([volume({ rawRecords: duplicated })], 'METADATA', /重复/);
  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  await rejects([volume({ rawRecords: invalidUtf8 })], 'METADATA', /UTF-8/);
  await rejects([volume({ rawRecords: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(json(emptyRecords()))]) })], 'METADATA');
  for (const token of ['1e400', '9007199254740993', '0.100000000000000005', '1e-324', '-0']) {
    const rawRecords = json(emptyRecords()).replace('"moments": []', `"moments": [{ "number": ${token} }]`);
    await rejects([volume({ rawRecords })], 'METADATA', /数值/);
  }
  const validNumbers = emptyRecords();
  validNumbers.moments.push({ a: 1e21, b: -1e-7, c: 0.1, d: 9007199254740992 });
  assert.deepEqual((await parseWxBackup(blobs([volume({ records: validNumbers })]))).records, validNumbers);
});

await test('500 long Unicode records exceeding 8 MiB remain importable', async () => {
  const records = emptyRecords(), content = '字'.repeat(6000);
  records.moments = Array.from({ length: 500 }, (_, i) => ({ _id: String(i), content }));
  assert.ok(Buffer.byteLength(json(records)) > 8 * 1024 * 1024);
  const result = await parseWxBackup(blobs([volume({ records })]));
  assert.equal(result.records.moments.length, 500);
  assert.equal(result.records.moments[499].content, content);
});

await test('input, zip bomb, metadata, nesting and record limits are enforced before returning', async () => {
  await assert.rejects(parseWxBackup([]), { code: 'INVALID_INPUT' });
  await assert.rejects(parseWxBackup([{}]), { code: 'INVALID_INPUT' });
  await assert.rejects(parseWxBackup(Array.from({ length: limits.maxParts + 1 }, () => new Blob(['x']))), { code: 'LIMIT' });
  const pretendSize = size => { const blob = new Blob([]); Object.defineProperty(blob, 'size', { value: size }); return blob; };
  await assert.rejects(parseWxBackup([pretendSize(limits.maxVolumeBytes + 1)]), { code: 'LIMIT' });
  await assert.rejects(parseWxBackup(Array.from({ length: 4 }, () => pretendSize(limits.maxVolumeBytes))), { code: 'LIMIT' });
  await rejects([volume({ rawRecords: Buffer.alloc(limits.maxRecordsJsonBytes + 1, 0x20) })], 'LIMIT');
  await rejects([volume({ rawRecords: '['.repeat(limits.maxJsonDepth + 1) + '0' + ']'.repeat(limits.maxJsonDepth + 1) })], 'LIMIT', /嵌套/);
  await rejects([volume({ rawRecords: '[' + '0,'.repeat(limits.maxJsonValues) + '0]' })], 'LIMIT', /JSON 值/);
  const tooManyRecords = emptyRecords(); tooManyRecords.moments = Array.from({ length: limits.maxRecords + 1 }, () => ({}));
  await rejects([volume({ records: tooManyRecords })], 'LIMIT', /记录数量/);
  await rejects([volume({ manifest: Array.from({ length: limits.maxMediaFiles + 1 }, () => null) })], 'LIMIT', /媒体数量/);
  await rejects([volume({ status: { part: 0, parts: limits.maxParts + 1, missing: [] } })], 'PARTS');
  const bomb = volume({ extraEntries: [{ name: 'media/00001.bin', data: 'x' }] });
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const fileNamePosition = bomb.lastIndexOf(bytes('media/00001.bin'));
  const centralPosition = bomb.lastIndexOf(signature, fileNamePosition);
  bomb.writeUInt32LE(limits.maxMediaBytes + 1, centralPosition + 20);
  bomb.writeUInt32LE(limits.maxMediaBytes + 1, centralPosition + 24);
  await rejects([bomb], 'LIMIT');
});
