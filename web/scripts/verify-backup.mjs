import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBackup, readBackup, validDate } from '../backup.js';

const bytes = value => new Blob([value], { type: 'image/png' });
const original = {
  id: 'moment-1', date: '2024-02-29', text: '一起散步', createdAt: 123, updatedAt: 456,
  media: [
    { id: 'image-1', name: '照片.png', type: 'image/png', blob: bytes(new Uint8Array([0, 1, 2, 127, 255])) },
    { id: 'video-1', name: '视频.webm', type: 'video/webm', blob: new Blob([new Uint8Array([10, 20, 30])], { type: 'video/webm' }) }
  ]
};
const digest = async blob => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const backup = await createBackup([original]);
const restored = await readBackup(backup);
assert.equal(restored[0].text, original.text);
assert.equal(restored[0].date, original.date);
for (let i = 0; i < original.media.length; i++) {
  assert.equal(restored[0].media[i].type, original.media[i].type);
  assert.equal(await digest(restored[0].media[i].blob), await digest(original.media[i].blob));
}
const corrupted = new Uint8Array(await backup.arrayBuffer());
corrupted[corrupted.length - 1] ^= 1;
await assert.rejects(readBackup(new Blob([corrupted])), /媒体校验失败/);
const corruptedHeader = new Uint8Array(await backup.arrayBuffer());
corruptedHeader[20] ^= 1;
await assert.rejects(readBackup(new Blob([corruptedHeader])), /目录校验失败/);
await assert.rejects(readBackup(backup.slice(0, backup.size - 1)), /不完整/);
await assert.rejects(readBackup(new Blob([backup, new Uint8Array([0])])), /长度不匹配/);
await assert.rejects(readBackup(await createBackup([original, original])), /无效或重复/);
await assert.rejects(readBackup(await createBackup([{ ...original, date: '2023-02-29' }])), /无效或重复/);
assert.equal(validDate('2024-02-29'), true);
assert.equal(validDate('1900-02-29'), false);
console.log('Backup round trip, byte integrity, corruption, duplicate IDs and dates: passed.');
