// End-to-end test with synthetic data only: real zipBackupPart, the real web UI,
// an isolated Chrome profile and mocked cloud downloads. No online service is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { zipBackupPart } = require('../../cloudfunctions/ours/backup.js');
const chrome = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'ours-wx-e2e-'));
const screenshotDir = await mkdtemp(path.join(os.tmpdir(), 'ours-wx-preview-'));
const keepScreenshot = process.env.OURS_WX_KEEP_SCREENSHOT === '1';
const port = 42000 + Math.floor(Math.random() * 15000);
let server, browser, socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, description, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await action(); if (last) return last; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${description}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
function captureProcess(child, name) {
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk.toString(); });
  child.stderr?.on('data', chunk => { output += chunk.toString(); });
  child.on('error', error => { output += ` ${name}: ${error.message}`; });
  return () => output.slice(-3000);
}
async function makeVolumes(records, manifest, groups, contents, prefix) {
  const result = [];
  const cloud = {
    async getTempFileURL({ fileList }) { return { fileList: fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://mock.invalid/${encodeURIComponent(fileID)}` })) }; },
    async uploadFile({ fileContent }) {
      const chunks = [];
      for await (const chunk of fileContent) chunks.push(chunk);
      result.push(Buffer.concat(chunks));
      return { fileID: 'cloud://synthetic/upload' };
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'mock.invalid');
    const data = contents.get(decodeURIComponent(parsed.pathname.slice(1)));
    assert.ok(data);
    return options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(data.length) } }) : new Response(data);
  };
  try {
    const snapshot = { id: `synthetic-${prefix}`, coupleId: 'synthetic-only', parts: groups.length, records, files: manifest };
    for (let part = 0; part < groups.length; part++) await zipBackupPart(cloud, snapshot, part, groups[part]);
  } finally { globalThis.fetch = original; }
  const files = [];
  for (let index = 0; index < result.length; index++) {
    const file = path.join(scratch, `${prefix}-${index + 1}.zip`);
    await writeFile(file, result[index]);
    files.push(file);
  }
  return files;
}

try {
  server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = captureProcess(server, 'server');
  await until(async () => {
    if (server.exitCode !== null) throw new Error(serverLog());
    try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; }
  }, 'local web server');
  const profile = path.join(scratch, 'profile');
  browser = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only',
    '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-default-apps',
    '--no-service-autorun', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const browserLog = captureProcess(browser, 'Chrome');
  const debugPort = await until(async () => {
    if (browser.exitCode !== null) throw new Error(browserLog());
    try { return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || false; } catch { return false; }
  }, 'isolated Chrome');
  if (process.env.OURS_WX_DEBUG === '1') console.error(`Synthetic web port ${port}; browser debugging port ${debugPort}`);
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map(), exceptions = [], recentEvents = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method) { recentEvents.push(message.method); if (recentEvents.length > 20) recentEvents.shift(); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}: ${(params.expression || '').slice(0, 160)}; recent events: ${recentEvents.join(', ')}`));
    }, 45000);
    pending.set(id, {
      method,
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('DOM.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: scratch });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/app` }, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const waitFor = (expression, description) => until(() => evaluate(expression), description);
  const selectFiles = async (selector, files) => {
    const { root: document } = await send('DOM.getDocument', { depth: 1 }, sessionId);
    const { nodeId } = await send('DOM.querySelector', { nodeId: document.nodeId, selector }, sessionId);
    assert.ok(nodeId, `missing file input ${selector}`);
    await send('DOM.setFileInputFiles', { nodeId, files }, sessionId);
  };
  const database = () => evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('ours-web'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('memories');
      const q = tx.objectStore('memories').getAll(); q.onerror = () => reject(q.error);
      q.onsuccess = () => { resolve(q.result.map(({ id, text, date, media }) => ({ id, text, date, media: media.map(m => ({ type: m.type, size: m.blob.size })) }))); db.close(); };
    };
  })`);
  await waitFor(`document.querySelector('#app') && !document.querySelector('#app').hidden && document.querySelector('#journal-content').textContent.includes('从第一条回忆开始')`, 'empty app');

  // Generate an actual PNG and playable WebM in the isolated browser.
  const syntheticMedia = await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#5b91d2'; ctx.fillRect(0, 0, 32, 32);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const stream = canvas.captureStream(12), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    const timer = setInterval(() => { ctx.fillStyle = ctx.fillStyle === '#e693a5' ? '#5b91d2' : '#e693a5'; ctx.fillRect(0, 0, 32, 32); }, 60);
    await new Promise(resolve => setTimeout(resolve, 450)); clearInterval(timer); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return { png, webm: btoa(binary) };
  })()`);
  const imageBytes = Buffer.from(syntheticMedia.png, 'base64'), videoBytes = Buffer.from(syntheticMedia.webm, 'base64');
  assert.ok(imageBytes.length > 20 && videoBytes.length > 20);
  const photo = 'cloud://synthetic/photo.png', movie = 'cloud://synthetic/video.webm', cover = 'cloud://synthetic/cover.png', voice = 'cloud://synthetic/voice.mp3';
  const contents = new Map([[photo, imageBytes], [movie, videoBytes], [cover, imageBytes], [voice, Buffer.from('synthetic voice')]]);
  const manifest = [...contents].map(([fileID, data], i) => ({ fileID, path: `media/${String(i + 1).padStart(5, '0')}.${fileID.split('.').at(-1)}`, size: data.length }));
  const lists = ['moments', 'anniversaries', 'moment_comments', 'moment_likes', 'checkins', 'notes', 'rants'];
  const record = (id, extra = {}) => {
    const value = { _id: id, coupleId: 'space-synthetic', kind: 'post', createdAt: 1700000000000, momentDate: '2024-01-01', content: `合成 ${id}`, images: [], videos: [], ...extra };
    const ids = [...value.images, ...value.videos, ...(value.videoCover ? [value.videoCover] : []), ...(value.voices || []).map(item => item.fileID)];
    // Match addMoment's persisted counters, including its per-file-ID byte deduplication.
    value.mediaItems ??= ids.length;
    value.mediaBytes ??= [...new Set(ids)].reduce((total, fileID) => total + contents.get(fileID).length, 0);
    return value;
  };
  const records = {
    exportedAt: 1700000000000, space: { memberA: null, memberB: null, startDate: '2020-01-01' },
    ...Object.fromEntries(lists.map(key => [key, []])),
    moments: [record('m1', { images: [photo] }), record('m2', { momentDate: '2024-01-02', videos: [movie], videoCover: cover }), record('voice', { voices: [{ fileID: voice, duration: 2 }] }), record('many', { images: Array(10).fill(photo) }), record('unknown-source', { coupleId: '' }), record('bad-count', { images: [photo], mediaItems: 2 }), record('bad-bytes', { images: [photo], mediaBytes: imageBytes.length + 1 })],
    moment_comments: [{ _id: 'comment', coupleId: 'space-synthetic', content: '不会导入的评论' }],
  };
  const files = await makeVolumes(records, manifest, [[manifest[0], manifest[3]], [manifest[1], manifest[2]]], contents, 'complete');
  const originalVolumes = await Promise.all(files.map(file => readFile(file)));
  await click('[data-open-backup]');
  await evaluate(`document.querySelector('#wx-import-input').focus()`);
  assert.equal(await evaluate(`document.activeElement.id`), 'wx-import-input', 'file picker must remain keyboard-focusable');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.wx-file-picker')).outlineStyle`), 'solid');
  await selectFiles('#wx-import-input', [files[0]]);
  await waitFor(`document.querySelector('#backup-status').textContent.includes('分卷不完整') && !document.querySelector('#wx-import-input').disabled`, 'missing volume rejection');
  assert.equal((await database()).length, 0);

  await selectFiles('#wx-import-input', [files[1], files[0]]);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-confirm').disabled`, 'read-only preview');
  assert.match(await text('#wx-preview-summary'), /拟新增 2 条，跳过 5 条/);
  assert.match(await text('#wx-preview-warnings'), /无法保证分卷来自同一次备份/);
  assert.match(await text('#wx-preview-warnings'), /不能证明媒体内容真实或未被篡改/);
  assert.match(await text('#wx-skipped-list'), /语音/);
  assert.match(await text('#wx-skipped-list'), /9 个/);
  assert.match(await text('#wx-skipped-list'), /来源空间/);
  assert.match(await text('#wx-skipped-list'), /媒体数量统计与可识别的引用不一致/);
  assert.match(await text('#wx-skipped-list'), /媒体大小统计与备份中的文件不一致/);
  assert.equal((await database()).length, 0, 'preview must not write');
  await evaluate(`document.querySelector('#wx-preview').scrollIntoView({ block: 'start' })`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const screenshotFile = path.join(screenshotDir, 'preview.png');
  await writeFile(screenshotFile, Buffer.from(screenshot.data, 'base64'));
  await click('#wx-cancel');
  assert.equal(await evaluate(`document.querySelector('#wx-preview').hidden`), true);
  assert.equal((await database()).length, 0, 'cancel must not write');

  await selectFiles('#wx-import-input', files);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-confirm').disabled`, 'second preview');
  await click('#wx-confirm');
  await waitFor(`document.querySelector('#backup-status').textContent.includes('小程序导入完成') && !document.querySelector('#wx-import-input').disabled`, 'atomic import');
  let stored = await database();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.find(item => item.text === '合成 m1').media.map(item => item.type), ['image/png']);
  assert.deepEqual(stored.find(item => item.text === '合成 m2').media.map(item => item.type), ['video/webm', 'image/png']);
  for (let i = 0; i < files.length; i++) assert.deepEqual(await readFile(files[i]), originalVolumes[i], 'source ZIP must remain unchanged');
  await click('[data-close-backup]');
  await waitFor(`document.querySelector('.memory-card img')?.naturalWidth > 0`, 'rendered synthetic image');
  await waitFor(`document.querySelector('.memory-card video')?.videoWidth > 0`, 'playable synthetic video');

  // Edit through the real UI, then verify repeat import cannot overwrite the edit.
  await click('button[aria-label="编辑 2024-01-01 的回忆"]');
  await evaluate(`document.querySelector('#memory-text').value = '网页修改保留'; document.querySelector('#memory-text').dispatchEvent(new Event('input', { bubbles: true }))`);
  await click('#save-memory');
  await waitFor(`!document.querySelector('#editor-dialog').open`, 'edited memory save');
  await click('[data-open-backup]');
  await selectFiles('#wx-import-input', files);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-cancel').disabled`, 'repeat preview');
  assert.match(await text('#wx-preview-summary'), /拟新增 0 条，跳过 7 条（其中 2 条已存在）/);
  assert.equal(await evaluate(`document.querySelector('#wx-confirm').disabled`), true);
  assert.ok((await database()).some(item => item.text === '网页修改保留'));
  await click('#wx-cancel');

  // Two insert requests: a simulated quota exception on the second must roll back the first.
  const quotaRecords = { ...records, moments: [record('q1', { images: [photo] }), record('q2', { videos: [movie] })], moment_comments: [] };
  const quotaManifest = manifest.slice(0, 2);
  const quotaFiles = await makeVolumes(quotaRecords, quotaManifest, [[quotaManifest[0]], [quotaManifest[1]]], contents, 'quota');
  await selectFiles('#wx-import-input', quotaFiles);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-confirm').disabled`, 'quota preview')
    .catch(async error => { throw new Error(`${error.message}; status: ${await text('#backup-status')}`); });
  const revisionBeforeFailure = await evaluate(`import('./storage.js').then(({ readLocal }) => readLocal()).then(state => state.revision)`);
  await evaluate(`window.__originalAdd = IDBObjectStore.prototype.add; window.__adds = 0; IDBObjectStore.prototype.add = function(...args) { if (++window.__adds === 2) throw new DOMException('synthetic quota', 'QuotaExceededError'); return window.__originalAdd.apply(this, args); }`);
  await click('#wx-confirm');
  await waitFor(`document.querySelector('#backup-status').textContent.includes('事务已回滚') && !document.querySelector('#wx-cancel').disabled`, 'quota rollback');
  assert.match(await text('#backup-status'), /存储空间不足/);
  await evaluate(`IDBObjectStore.prototype.add = window.__originalAdd`);
  stored = await database();
  assert.equal(stored.length, 2, 'quota failure must roll back all new records');
  assert.ok(stored.some(item => item.text === '网页修改保留'));
  assert.equal(await evaluate(`import('./storage.js').then(({ readLocal }) => readLocal()).then(state => state.revision)`), revisionBeforeFailure);

  // A native asynchronous IndexedDB request failure also aborts all additions
  // and the sync revision, even after an earlier add request was queued.
  const existingId = stored[0].id;
  await evaluate(`window.__adds = 0; IDBObjectStore.prototype.add = function(item, ...args) {
    if (this.name === 'memories' && ++window.__adds === 2) item = { ...item, id: ${JSON.stringify(existingId)} };
    return window.__originalAdd.call(this, item, ...args);
  }`);
  await click('#wx-confirm');
  await waitFor(`document.querySelector('#backup-status').textContent.includes('事务已回滚') && !document.querySelector('#wx-cancel').disabled`, 'asynchronous IndexedDB rollback');
  await evaluate(`IDBObjectStore.prototype.add = window.__originalAdd`);
  assert.deepEqual(await database(), stored, 'asynchronous request failure must roll back all records');
  assert.equal(await evaluate(`import('./storage.js').then(({ readLocal }) => readLocal()).then(state => state.revision)`), revisionBeforeFailure);
  await click('#wx-cancel');

  // A limit reached on a later item must also abort the entire transaction.
  const limitResult = await evaluate(`(async () => {
    const { importMemories } = await import('./storage.js');
    const make = id => ({ id, date: '2024-01-01', text: id, createdAt: 1, updatedAt: 1, media: [] });
    try { await importMemories([make('limit-a'), make('limit-b')], { maxTotal: 3 }); return 'unexpected success'; }
    catch (error) { return error.message; }
  })()`);
  assert.match(limitResult, /上限/);
  assert.equal((await database()).length, 2, 'count limit must roll back the whole transaction');

  // Crossing the manifest size on a later item must also abort the entire transaction.
  const manifestResult = await evaluate(`(async () => {
    const { importMemories, listMemories } = await import('./storage.js');
    const { backupManifestUpperBound } = await import('./backup.js');
    const make = id => ({ id, date: '2024-01-01', text: id, createdAt: 1, updatedAt: 1, media: [] });
    const first = make('manifest-a'), second = make('manifest-b');
    const maxManifestBytes = backupManifestUpperBound([...(await listMemories()), first]);
    try { await importMemories([first, second], { maxManifestBytes }); return 'unexpected success'; }
    catch (error) { return error.message; }
  })()`);
  assert.match(manifestResult, /备份目录/);
  assert.equal((await database()).length, 2, 'manifest limit must roll back the whole transaction');

  // Even an unexpected synchronous error while queueing requests cannot commit earlier items.
  const queueError = await evaluate(`(async () => {
    const { importMemories } = await import('./storage.js');
    const make = id => ({ id, date: '2024-01-01', text: 'test', createdAt: 1, updatedAt: 1, media: [] });
    try { await importMemories([make('queue-test'), make(undefined)]); return 'unexpected success'; }
    catch (error) { return error.name; }
  })()`);
  assert.equal(queueError, 'DataError');
  assert.equal((await database()).length, 2, 'request queueing error must roll back the transaction');

  // Export and restore through the existing .ours UI, preserving imported IDs and edits.
  const beforeBackup = await database();
  await click('#export-button');
  const backupFile = await until(async () => {
    const names = await readdir(scratch); const name = names.find(item => item.endsWith('.ours'));
    return name && path.join(scratch, name);
  }, '.ours download');
  await evaluate(`new Promise((resolve, reject) => { const open = indexedDB.open('ours-web'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('memories', 'readwrite'); tx.objectStore('memories').clear(); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; })`);
  assert.equal((await database()).length, 0);
  await selectFiles('#import-input', [backupFile]);
  await waitFor(`document.querySelector('#backup-status').textContent.includes('导入完成：新增 2 条') && !document.querySelector('#wx-import-input').disabled`, '.ours restore');
  assert.deepEqual((await database()).sort((a, b) => a.id.localeCompare(b.id)), beforeBackup.sort((a, b) => a.id.localeCompare(b.id)));
  await selectFiles('#import-input', [backupFile]);
  await waitFor(`document.querySelector('#backup-status').textContent.includes('新增 0 条，跳过已有的 2 条') && !document.querySelector('#wx-import-input').disabled`, '.ours repeated import');
  assert.deepEqual((await database()).sort((a, b) => a.id.localeCompare(b.id)), beforeBackup);
  await selectFiles('#wx-import-input', files);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-cancel').disabled`, 'repeat after .ours restore');
  assert.match(await text('#wx-preview-summary'), /拟新增 0 条，跳过 7 条（其中 2 条已存在）/);
  assert.equal(await evaluate(`document.querySelector('#wx-confirm').disabled`), true);
  await click('#wx-cancel');

  // The preview must block a projected .ours manifest over 8 MiB, before any import.
  await evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('ours-web'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('memories', 'readwrite'), store = tx.objectStore('memories');
      for (let i = 0; i < 840; i++) store.add({ id: 'large-test-' + i, date: '2024-01-01', text: 'x'.repeat(10000), createdAt: 1, updatedAt: 1, media: [] });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  })`);
  await selectFiles('#wx-import-input', quotaFiles);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-cancel').disabled`, 'oversized backup preview');
  assert.match(await text('#wx-preview-warnings'), /备份目录可能超过 8 MiB/);
  assert.match(await text('#wx-preview-warnings'), /现有回忆可能已超过.*完整导出可能失败.*保留浏览器数据.*暂勿删除/);
  assert.equal(await evaluate(`document.querySelector('#wx-confirm').disabled`), true);
  await click('#wx-cancel');
  await evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('ours-web'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('memories', 'readwrite'), store = tx.objectStore('memories');
      for (let i = 0; i < 840; i++) store.delete('large-test-' + i);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  })`);
  assert.equal((await database()).length, 2);

  // Another page may insert the same source ID after preview; confirmation skips it.
  await selectFiles('#wx-import-input', quotaFiles);
  await waitFor(`!document.querySelector('#wx-preview').hidden && !document.querySelector('#wx-confirm').disabled`, 'concurrent preview');
  const concurrentId = await evaluate(`(async () => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['space-synthetic', 'q1'])));
    const id = 'wx_' + [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    const { saveMemory } = await import('./storage.js');
    await saveMemory({ id, date: '2024-01-01', text: '并发网页修改', createdAt: 1, updatedAt: 1, media: [] });
    return id;
  })()`);
  await click('#wx-confirm');
  await waitFor(`document.querySelector('#backup-status').textContent.includes('小程序导入完成') && !document.querySelector('#wx-import-input').disabled`, 'concurrent import');
  assert.match(await text('#backup-status'), /新增 1 条.*确认时因已有同 ID 又跳过 1 条/);
  stored = await database();
  assert.equal(stored.length, 4);
  assert.equal(stored.find(item => item.id === concurrentId).text, '并发网页修改');
  assert.ok(stored.some(item => item.text === '合成 q2'));
  assert.deepEqual(exceptions, []);
  console.log('Browser: synthetic ZIP64 volumes, preview/cancel, missing volume, media playback, repeat and concurrent edits, quota/count/manifest rollback, manifest preview and .ours restore passed.');
} finally {
  if (socket) socket.close();
  if (browser) browser.kill();
  if (server) server.kill();
  await pause(300);
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  if (keepScreenshot) console.log(`Preview screenshot: ${path.join(screenshotDir, 'preview.png')}`);
  else await rm(screenshotDir, { recursive: true, force: true, maxRetries: 3 });
}
