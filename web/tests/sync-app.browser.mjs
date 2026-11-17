// Full UI regression with synthetic data, isolated browser contexts, and a real local service.
// Set OURS_TEST_PLAYWRIGHT to Playwright's index.mjs and CHROME_PATH to a local Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = process.env.OURS_TEST_PLAYWRIGHT ? await import(pathToFileURL(process.env.OURS_TEST_PLAYWRIGHT).href) : await import('playwright');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await action(); if (last) return last; } catch (error) { last = error; }
    await wait(80);
  }
  throw new Error(`Timed out: ${description}; ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ours-web-sync-ui-'));
  let browser, child;
  const web = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/missing') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>'); return; }
      const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const data = await readFile(filename);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  t.after(async () => {
    await browser?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await new Promise(resolve => web.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const origin = `http://127.0.0.1:${web.address().port}`;
  const source = fileURLToPath(new URL('../../ours-sync/', import.meta.url));
  await Promise.all(['server.js', 'package.json'].map(name => copyFile(path.join(source, name), path.join(dir, name))));
  const token = randomBytes(32).toString('base64url');
  child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir, env: { OURS_SYNC_TOKEN: token, OURS_SYNC_PORT: '0', OURS_SYNC_ALLOWED_ORIGINS: origin }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('local sync service did not start')), 10000);
    child.stdout.on('data', part => {
      output += part;
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('local sync service exited early')));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  browser = await playwright.chromium.launch({ executablePath: chrome, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
  ] });
  const requests = [], errors = [];
  async function context(options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block', ...options });
    await ctx.route('**/*', async route => {
      const url = route.request().url(); requests.push(url);
      if (![origin, baseUrl].includes(new URL(url).origin)) return route.abort();
      return route.continue();
    });
    ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return ctx;
  }
  return { origin, baseUrl, token, context, requests, errors };
}
async function open(ctx, origin) {
  const page = await ctx.newPage();
  await page.goto(`${origin}/#/app`);
  await page.waitForSelector('#journal-content .empty-state, #journal-content .memory-card');
  return page;
}
async function state(page) {
  return page.evaluate(async () => {
    const { readLocal } = await import('./storage.js');
    const value = await readLocal();
    return { ...value, memories: await Promise.all(value.memories.map(async memory => ({ ...memory,
      media: await Promise.all(memory.media.map(async media => ({ ...media, blob: [...new Uint8Array(await media.blob.arrayBuffer())] }))) }))) };
  });
}
async function create(page, text, files = []) {
  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-02');
  await page.locator('#memory-text').fill(text);
  if (files.length) await page.locator('#media-input').setInputFiles(files);
  await page.locator('#save-memory').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  await until(() => page.locator('.memory-card').filter({ hasText: text }).count(), `created ${text}`);
}
async function edit(page, before, after) {
  await page.locator('.memory-card').filter({ hasText: before }).getByText('编辑', { exact: true }).click();
  await page.locator('#memory-text').fill(after);
  await page.locator('#save-memory').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  await until(() => page.locator('.memory-card').filter({ hasText: after }).count(), `edited ${after}`);
}
async function configure(page, baseUrl, token) {
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill(baseUrl);
  await page.locator('#sync-token').fill(token);
  await page.locator('#sync-enabled').check();
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('上次同步成功'), 'initial synchronization');
  await page.locator('[data-close-sync]').click();
}
async function checkNow(page) {
  await page.locator('#sync-panel [data-open-sync]').click();
  const baseUrl = await page.evaluate(async () => (await (await import('./storage.js')).readSyncSettings()).settings.baseUrl);
  const checked = page.waitForResponse(response => response.url() === `${baseUrl}/v1/snapshot` && response.request().method() === 'GET');
  await page.locator('#sync-now').click();
  await checked;
  await until(async () => (await page.locator('#sync-status').innerText()).includes('上次同步成功'), 'manual synchronization');
  await page.locator('[data-close-sync]').click();
}
async function media(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d'); context.fillStyle = '#8a79ba'; context.fillRect(0, 0, 16, 16);
    const image = await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer();
    const stream = canvas.captureStream(12), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    const timer = setInterval(() => {
      context.fillStyle = context.fillStyle === '#d9a6b3' ? '#8a79ba' : '#d9a6b3';
      context.fillRect(0, 0, 16, 16);
    }, 60);
    await new Promise(resolve => setTimeout(resolve, 600));
    clearInterval(timer); recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    return { image: [...new Uint8Array(image)], video: [...new Uint8Array(await new Blob(chunks).arrayBuffer())] };
  });
  return [
    { name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(bytes.image) },
    { name: 'synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes.video) }
  ];
}
async function wxVolume(image) {
  const { zipBackupPart } = require('../../cloudfunctions/ours/backup.js');
  const fileID = 'cloud://synthetic/photo.png';
  const manifest = [{ fileID, path: 'media/00001.png', size: image.length }];
  const records = { exportedAt: 1700000000000, space: { memberA: null, memberB: null, startDate: '2020-01-01' },
    moments: [{ _id: 'wx1', coupleId: 'synthetic-space', kind: 'post', createdAt: 1700000000000, momentDate: '2024-01-04',
      content: '小程序合成回忆', images: [fileID], videos: [], mediaItems: 1, mediaBytes: image.length }],
    anniversaries: [], moment_comments: [], moment_likes: [], checkins: [], notes: [], rants: [] };
  const result = [];
  const cloud = {
    async getTempFileURL() { return { fileList: [{ fileID, status: 0, tempFileURL: 'https://mock.invalid/synthetic' }] }; },
    async uploadFile({ fileContent }) { const chunks = []; for await (const chunk of fileContent) chunks.push(chunk); result.push(Buffer.concat(chunks)); return { fileID: 'cloud://synthetic/result' }; }
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, 'https://mock.invalid/synthetic');
    return options.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(image.length) } }) : new Response(image);
  };
  try { await zipBackupPart(cloud, { id: 'synthetic-test', coupleId: 'synthetic-space', parts: 1, records, files: manifest }, 0, manifest); }
  finally { globalThis.fetch = original; }
  return result[0];
}

test('real UI migrates old data, synchronizes media/imports, recovers offline and stops on conflicts', { timeout: 120000 }, async t => {
  const f = await fixture(t), aContext = await f.context(), bContext = await f.context();
  const a = await aContext.newPage();
  await a.goto(`${f.origin}/missing`);
  await a.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('ours-web', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('memories', { keyPath: 'id' });
    request.onsuccess = () => { const db = request.result, tx = db.transaction('memories', 'readwrite');
      tx.objectStore('memories').add({ id: 'legacy', date: '2024-01-01', text: '旧版回忆', createdAt: 1, updatedAt: 1, media: [] });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    }; request.onerror = () => reject(request.error);
  }));
  await a.goto(`${f.origin}/#/app`);
  await until(() => a.locator('.memory-card').filter({ hasText: '旧版回忆' }).count(), 'old record after upgrade');
  const initial = await state(a);
  assert.ok(initial.revision); assert.equal(initial.baseline, null); assert.equal(initial.pending, null);
  const b = await open(bContext, f.origin);
  const files = await media(a);
  await create(a, '甲的照片和视频', files);
  await create(b, '乙的回忆');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0, 'unconfigured pages must not contact sync');
  await configure(a, f.baseUrl, f.token);
  await configure(b, f.baseUrl, f.token);
  await checkNow(a);
  await until(() => a.locator('.memory-card').filter({ hasText: '乙的回忆' }).count(), 'A receives B record');
  await until(() => b.locator('.memory-card').filter({ hasText: '甲的照片和视频' }).count(), 'B receives A record');
  const remoteMedia = (await state(b)).memories.find(record => record.text === '甲的照片和视频').media;
  assert.deepEqual(Buffer.from(remoteMedia[0].blob), files[0].buffer);
  assert.deepEqual(Buffer.from(remoteMedia[1].blob), files[1].buffer);
  await b.bringToFront(); // Background tabs may defer media loading.
  await until(() => b.locator('.memory-card').filter({ hasText: '甲的照片和视频' }).locator('img').evaluate(img => img.naturalWidth > 0), 'displayed image');
  await until(() => b.locator('.memory-card').filter({ hasText: '甲的照片和视频' }).locator('video').evaluate(video => video.videoWidth > 0), 'playable video');
  await bContext.setOffline(true);
  await create(b, '乙离线新建');
  assert.match(await b.locator('#sync-status').innerText(), /离线|等待同步/);
  await bContext.setOffline(false);
  await until(async () => (await b.locator('#sync-status').innerText()).includes('上次同步成功'), 'offline recovery');
  await checkNow(a);
  await until(() => a.locator('.memory-card').filter({ hasText: '乙离线新建' }).count(), 'A receives offline record');
  await edit(a, '甲的照片和视频', '甲修改后的媒体回忆');
  await until(async () => (await a.locator('#sync-status').innerText()).includes('上次同步成功'), 'A edit sync');
  await checkNow(b);
  await until(() => b.locator('.memory-card').filter({ hasText: '甲修改后的媒体回忆' }).count(), 'B receives edit');
  const volume = await wxVolume(files[0].buffer);
  await b.locator('#sync-panel [data-open-backup]').count(); // backup entry is the header on desktop
  await b.locator('.app-header [data-open-backup]').click();
  await b.locator('#wx-import-input').setInputFiles({ name: 'synthetic.zip', mimeType: 'application/zip', buffer: volume });
  await until(async () => !(await b.locator('#wx-confirm').isDisabled()), 'mini-program preview');
  await b.locator('#wx-confirm').click();
  await until(async () => (await b.locator('#backup-status').innerText()).includes('小程序导入完成'), 'mini-program import');
  await b.locator('[data-close-backup]').click();
  await until(async () => (await b.locator('#sync-status').innerText()).includes('上次同步成功'), 'mini-program sync');
  await checkNow(a);
  const imported = (await state(a)).memories.find(record => record.text === '小程序合成回忆');
  assert.ok(imported); assert.deepEqual(Buffer.from(imported.media[0].blob), files[0].buffer);
  if (process.env.OURS_TEST_SCREENSHOT) await a.screenshot({ path: process.env.OURS_TEST_SCREENSHOT, fullPage: false });
  await aContext.setOffline(true); await bContext.setOffline(true);
  await edit(a, '旧版回忆', '甲离线修改');
  await edit(b, '旧版回忆', '乙离线修改');
  await aContext.setOffline(false);
  await until(async () => (await a.locator('#sync-status').innerText()).includes('上次同步成功'), 'A publishes conflicting edit');
  await bContext.setOffline(false);
  await until(async () => (await b.locator('#sync-status').innerText()).includes('同步冲突'), 'B detects conflict');
  assert.equal((await state(b)).memories.find(record => record.id === 'legacy').text, '乙离线修改');
  assert.equal((await state(a)).memories.find(record => record.id === 'legacy').text, '甲离线修改');
  await b.locator('#sync-backup').click();
  const downloadPromise = b.waitForEvent('download');
  await b.locator('#export-button').click();
  const download = await downloadPromise;
  const backup = await readFile(await download.path());
  await b.locator('[data-close-backup]').click();
  const cContext = await f.context(), c = await open(cContext, f.origin);
  await c.locator('.app-header [data-open-backup]').click();
  await c.locator('#import-input').setInputFiles({ name: 'synthetic.ours', mimeType: 'application/octet-stream', buffer: backup });
  await until(async () => (await c.locator('#backup-status').innerText()).includes('导入完成'), 'backup restore');
  const restored = await state(c);
  assert.equal(restored.memories.find(record => record.id === 'legacy').text, '乙离线修改');
  const restoredMedia = restored.memories.find(record => record.text === '甲修改后的媒体回忆').media;
  assert.deepEqual(Buffer.from(restoredMedia[0].blob), files[0].buffer);
  assert.deepEqual(Buffer.from(restoredMedia[1].blob), files[1].buffer);
  await b.reload();
  await until(async () => (await b.locator('#sync-status').innerText()).includes('同步冲突'), 'conflict after reload');
  await b.locator('#sync-panel [data-open-sync]').click();
  await b.locator('#sync-url').fill('http://127.0.0.1:9');
  await b.locator('#sync-token').fill(f.token);
  await b.locator('#sync-save').click();
  await until(async () => (await b.locator('#sync-form-status').innerText()).includes('不能切换同步地址'), 'refused history switch');
  assert.equal(f.requests.some(url => url.includes(f.token)), false, 'credential must never appear in URLs');
  assert.deepEqual(f.errors, []);
});

test('cross-tab lock and pending journal survive an edit during a real snapshot PUT', { timeout: 90000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), a = await open(ctx, f.origin);
  await create(a, '同步前');
  await configure(a, f.baseUrl, f.token);
  let release, seen;
  const blocked = new Promise(resolve => { release = resolve; });
  const putSeen = new Promise(resolve => { seen = resolve; });
  let armed = true;
  await ctx.route('**/v1/snapshot', async route => {
    if (armed && route.request().method() === 'PUT') { armed = false; seen(); await blocked; }
    await route.continue();
  });
  await edit(a, '同步前', '正在上传的版本');
  await Promise.race([putSeen, wait(15000).then(() => { throw new Error('snapshot PUT was not dispatched'); })]);
  const pendingBefore = await state(a);
  assert.ok(pendingBefore.pending);
  const second = await open(ctx, f.origin);
  await second.locator('#sync-panel [data-open-sync]').click();
  await second.locator('#sync-now').click();
  await until(() => second.evaluate(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'ours-web-sync')), 'second tab waits on Web Lock');
  await second.locator('[data-close-sync]').click();
  await edit(second, '正在上传的版本', '上传期间的本机修改');
  const changed = await state(second);
  assert.notEqual(changed.revision, pendingBefore.revision);
  assert.deepEqual(changed.pending, pendingBefore.pending);
  await second.close();
  release();
  await until(async () => (await a.locator('#sync-status').innerText()).includes('远端已有提交'), 'local change after remote commit');
  const retained = await state(a);
  assert.equal(retained.memories[0].text, '上传期间的本机修改');
  assert.deepEqual(retained.pending, pendingBefore.pending);
  await a.reload();
  await until(async () => (await a.locator('#sync-status').innerText()).includes('需要人工核对'), 'pending edit conflict after reload');
  assert.deepEqual((await state(a)).pending, pendingBefore.pending);
  assert.deepEqual(f.errors, []);
});

test('IndexedDB CAS and every application write preserve the baseline and pending journal', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  const result = await page.evaluate(async () => {
    const { readLocal, compareAndSwap, saveMemory, deleteMemory, importMemories } = await import('./storage.js');
    const record = id => ({ id, date: '2024-01-01', text: id, createdAt: 1, updatedAt: 1, media: [] });
    const id = () => crypto.randomUUID().replaceAll('-', '');
    const first = await readLocal(), next = id();
    const baseline = { sentinel: 'baseline' }, pending = { sentinel: 'pending' };
    const committed = await compareAndSwap({ expectedRevision: first.revision, nextRevision: next, memories: [record('one')], baseline, pending });
    const revisions = [first.revision, committed];
    const oldCas = await compareAndSwap({ expectedRevision: first.revision, nextRevision: id(), memories: [], baseline: null, pending: null });
    await saveMemory(record('two'));
    const afterSave = await readLocal(); revisions.push(afterSave.revision);
    await saveMemory({ ...record('two'), text: 'edited' }, { expectedRevision: afterSave.revision });
    const afterEdit = await readLocal(); revisions.push(afterEdit.revision);
    await deleteMemory('one');
    const afterDelete = await readLocal(); revisions.push(afterDelete.revision);
    await importMemories([record('three')]);
    const afterImport = await readLocal(); revisions.push(afterImport.revision);
    let failure = false;
    try { await compareAndSwap({ expectedRevision: afterImport.revision, nextRevision: id(), memories: [record('duplicate'), record('duplicate')], baseline: null, pending: null }); }
    catch { failure = true; }
    const afterFailure = await readLocal();
    return { committed, next, oldCas, revisions, afterImport, afterFailure, failure };
  });
  assert.equal(result.committed, result.next);
  assert.equal(result.oldCas, null);
  assert.equal(new Set(result.revisions).size, result.revisions.length);
  assert.deepEqual(result.afterImport.baseline, { sentinel: 'baseline' });
  assert.deepEqual(result.afterImport.pending, { sentinel: 'pending' });
  assert.equal(result.failure, true);
  assert.deepEqual(result.afterFailure, result.afterImport, 'a failed CAS must roll back memories, metadata and revision');
});

test('no Web Locks means no network synchronization and stale drafts cannot overwrite', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context();
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
  const page = await open(ctx, f.origin);
  await until(async () => (await page.locator('#sync-status').innerText()).includes('跨标签锁'), 'unsupported lock status');
  await create(page, '原记录');
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill(f.baseUrl);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-enabled').check();
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-form-status').innerText()).includes('跨标签锁'), 'unsafe setup rejected');
  await page.locator('[data-close-sync]').click();
  await page.locator('.memory-card').filter({ hasText: '原记录' }).getByText('编辑', { exact: true }).click();
  await page.locator('#memory-text').fill('未保存草稿');
  await page.evaluate(async () => {
    const { readLocal, saveMemory } = await import('./storage.js');
    const current = await readLocal();
    await saveMemory({ ...current.memories[0], text: '另一页面的新版本' });
  });
  await page.locator('#save-memory').click();
  await until(() => page.locator('#save-copy').isVisible(), 'stale draft rejected');
  assert.equal(await page.locator('#memory-text').inputValue(), '未保存草稿');
  assert.equal((await state(page)).memories[0].text, '另一页面的新版本');
  await page.locator('#save-copy').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual((await state(page)).memories.map(item => item.text).sort(), ['另一页面的新版本', '未保存草稿'].sort());
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  assert.deepEqual(f.errors, []);
});

test('changing the service origin requires a freshly entered credential', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill('http://127.0.0.1:9');
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-enabled').check();
  await page.locator('#sync-save').click();
  await until(() => page.evaluate(async () => {
    const { settings } = await (await import('./storage.js')).readSyncSettings();
    return settings.enabled && settings.baseUrl === 'http://127.0.0.1:9' && Boolean(settings.token);
  }), 'initial settings saved');
  await page.locator('#sync-url').fill(f.baseUrl);
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-form-status').innerText()).includes('重新输入'), 'credential required for new origin');
  const savedOrigin = await page.evaluate(async () => (await (await import('./storage.js')).readSyncSettings()).settings.baseUrl);
  assert.equal(savedOrigin, 'http://127.0.0.1:9');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('上次同步成功'), 'new origin checked after explicit credential');
  assert.equal(f.requests.some(url => url.includes(f.token)), false);
  assert.deepEqual(f.errors, []);
});

test('disabled address changes clear credentials and equivalent origins retain them', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  const inspect = () => page.evaluate(async expected => {
    const { settings } = await (await import('./storage.js')).readSyncSettings();
    return { baseUrl: settings.baseUrl, enabled: settings.enabled, hasCredential: Boolean(settings.token),
      matches: Boolean(settings.token && settings.token === expected), bound: settings.tokenOrigin === settings.baseUrl };
  }, f.token);
  const save = async () => {
    await page.locator('#sync-save').click();
    await until(() => page.locator('#sync-save').isEnabled(), 'disabled settings saved');
  };
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill('http://localhost:9');
  await page.locator('#sync-token').fill(f.token);
  await save();
  await page.locator('#sync-url').fill('http://LOCALHOST:00009/');
  await save();
  let settings = await inspect();
  assert.equal(settings.baseUrl, 'http://localhost:9');
  assert.ok(settings.matches && settings.bound, 'same normalized origin retains its credential');

  // A credential typed before editing the address must not follow it to a
  // different origin, while an equivalent spelling keeps the in-progress input.
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-url').fill('http://localhost:9/');
  assert.equal(await page.locator('#sync-token').evaluate(input => Boolean(input.value)), true);
  await page.locator('#sync-url').fill(f.baseUrl);
  assert.equal(await page.locator('#sync-token').evaluate(input => Boolean(input.value)), false);
  await save();
  settings = await inspect();
  assert.equal(settings.baseUrl, f.baseUrl);
  assert.equal(settings.hasCredential, false, 'switching while disabled removes the old credential');
  await page.locator('#sync-enabled').check();
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-form-status').innerText()).includes('需要填写'), 'new credential required');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);

  await page.locator('#sync-enabled').uncheck();
  await page.locator('#sync-url').fill('http://localhost:9');
  await page.locator('#sync-token').fill(f.token);
  await save();
  await page.locator('#sync-url').fill('');
  await save();
  settings = await inspect();
  assert.equal(settings.baseUrl, '');
  assert.equal(settings.hasCredential, false, 'clearing the origin removes its credential');
  await page.locator('#sync-url').fill(f.baseUrl);
  await page.locator('#sync-enabled').check();
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-form-status').innerText()).includes('需要填写'), 'credential required after clearing origin');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('上次同步成功'), 'new origin with explicitly entered credential');
  settings = await inspect();
  assert.ok(settings.enabled && settings.matches && settings.bound);
  assert.deepEqual(f.errors, []);
});

test('legacy unbound credentials require explicit entry before any request', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  // Simulate an older version which saved an address without recording which
  // origin the credential came from. Its previous address is unknowable.
  await page.evaluate(async ({ origin, credential }) => {
    await (await import('./storage.js')).writeSyncSettings({ enabled: true, baseUrl: origin, token: credential });
  }, { origin: f.baseUrl, credential: f.token });
  await page.reload();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('凭证与服务地址不匹配'), 'unbound credential paused on startup');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-form-status').innerText()).includes('重新输入'), 'unbound credential requires entry');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-save').click();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('上次同步成功'), 'explicitly bound credential works');
  const valid = await page.evaluate(async credential => {
    const { settings } = await (await import('./storage.js')).readSyncSettings();
    return settings.enabled && settings.tokenOrigin === settings.baseUrl && settings.token === credential;
  }, f.token);
  assert.equal(valid, true);
  assert.deepEqual(f.errors, []);
});

test('a baseline or pending journal prevents clearing or changing the origin', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const kind of ['baseline', 'pending']) {
    const ctx = await f.context(), page = await open(ctx, f.origin);
    await page.locator('#sync-panel [data-open-sync]').click();
    await page.locator('#sync-url').fill(f.baseUrl);
    await page.locator('#sync-token').fill(f.token);
    await page.locator('#sync-save').click();
    await until(() => page.locator('#sync-save').isEnabled(), 'initial paused settings saved');
    await page.evaluate(async ({ origin, journal }) => {
      const { readLocal, compareAndSwap } = await import('./storage.js');
      const current = await readLocal();
      await compareAndSwap({ expectedRevision: current.revision, nextRevision: crypto.randomUUID(), memories: current.memories,
        baseline: journal === 'baseline' ? { server: origin } : null,
        pending: journal === 'pending' ? { server: origin } : null });
    }, { origin: f.baseUrl, journal: kind });
    for (const next of ['', 'http://localhost:9']) {
      await page.locator('#sync-url').fill(next);
      await page.locator('#sync-save').click();
      await until(async () => (await page.locator('#sync-form-status').innerText()).includes('不能切换同步地址'), 'history switch rejected');
      const preserved = await page.evaluate(async ({ origin, credential }) => {
        const { settings } = await (await import('./storage.js')).readSyncSettings();
        return !settings.enabled && settings.baseUrl === origin && settings.token === credential && settings.tokenOrigin === origin;
      }, { origin: f.baseUrl, credential: f.token });
      assert.equal(preserved, true);
    }
    await ctx.close();
  }
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  assert.deepEqual(f.errors, []);
});

test('a mismatched credential binding cannot start synchronization', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill(f.baseUrl);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-save').click();
  await until(() => page.locator('#sync-save').isEnabled(), 'settings saved');
  await page.evaluate(async () => {
    const { readSyncSettings, writeSyncSettings } = await import('./storage.js');
    const { settings } = await readSyncSettings();
    await writeSyncSettings({ ...settings, enabled: true, tokenOrigin: 'http://localhost:9' });
  });
  await page.locator('#sync-now').click();
  await until(async () => (await page.locator('#sync-status').innerText()).includes('凭证与服务地址不匹配'), 'invalid binding rejected');
  assert.equal(f.requests.filter(url => url.startsWith(f.baseUrl)).length, 0);
  assert.deepEqual(f.errors, []);
});

test('delete confirmation explains unconfigured and paused synchronization', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  await create(page, '待确认的回忆');
  let prompt = '';
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.dismiss(); });
  await page.locator('.memory-card').getByText('删除', { exact: true }).click();
  await until(() => prompt, 'unconfigured deletion confirmation');
  assert.match(prompt, /尚未配置同步.*仅发生在本机/);
  assert.equal((await state(page)).memories.length, 1);
  await page.locator('#sync-panel [data-open-sync]').click();
  await page.locator('#sync-url').fill(f.baseUrl);
  await page.locator('#sync-token').fill(f.token);
  await page.locator('#sync-save').click();
  await until(() => page.locator('#sync-save').isEnabled(), 'paused settings saved');
  await page.locator('[data-close-sync]').click();
  prompt = '';
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.dismiss(); });
  await page.locator('.memory-card').getByText('删除', { exact: true }).click();
  await until(() => prompt, 'paused deletion confirmation');
  assert.match(prompt, /暂停.*重新启用后删除可能同步到另一台设备.*同时编辑.*同步冲突/);
  assert.equal((await state(page)).memories.length, 1);
  assert.deepEqual(f.errors, []);
});

test('a settings change during deletion confirmation requires another confirmation', { timeout: 60000 }, async t => {
  const f = await fixture(t), ctx = await f.context(), page = await open(ctx, f.origin);
  const other = await open(ctx, f.origin);
  await create(page, '跨页面确认的回忆');
  let prompt = '';
  page.once('dialog', async dialog => {
    prompt = dialog.message();
    await other.evaluate(async () => {
      await (await import('./storage.js')).writeSyncSettings({ enabled: false, baseUrl: 'http://localhost:9', token: '', tokenOrigin: '' });
    });
    await dialog.accept();
  });
  await page.locator('.memory-card').getByText('删除', { exact: true }).click();
  await until(async () => (await page.locator('#toast').innerText()).includes('同步设置已变化'), 'changed settings block deletion');
  assert.match(prompt, /尚未配置同步.*仅发生在本机/);
  assert.equal((await state(page)).memories.length, 1);
  prompt = '';
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.dismiss(); });
  await page.locator('.memory-card').getByText('删除', { exact: true }).click();
  await until(() => prompt, 'updated deletion confirmation');
  assert.match(prompt, /暂停.*重新启用后删除可能同步到另一台设备/);
  assert.equal((await state(page)).memories.length, 1);
  assert.deepEqual(f.errors, []);
});

test('a deletion can synchronize to the other device', { timeout: 60000 }, async t => {
  const f = await fixture(t), aContext = await f.context(), bContext = await f.context();
  const a = await open(aContext, f.origin), b = await open(bContext, f.origin);
  await create(a, '可同步删除的回忆');
  await configure(a, f.baseUrl, f.token);
  await configure(b, f.baseUrl, f.token);
  await until(() => b.locator('.memory-card').filter({ hasText: '可同步删除的回忆' }).count(), 'second device receives record');
  a.once('dialog', dialog => dialog.accept());
  await a.locator('.memory-card').filter({ hasText: '可同步删除的回忆' }).getByText('删除', { exact: true }).click();
  await until(async () => (await state(a)).memories.length === 0 &&
    (await a.locator('#sync-status').innerText()).includes('上次同步成功'), 'deletion published');
  await b.locator('#sync-panel [data-open-sync]').click();
  await b.locator('#sync-now').click();
  await until(async () => (await state(b)).memories.length === 0, 'deletion received by second device');
  assert.deepEqual(f.errors, []);
});

test('concurrent deletion and edit pause and permit an empty backup', { timeout: 60000 }, async t => {
  const f = await fixture(t), aContext = await f.context(), bContext = await f.context();
  const a = await open(aContext, f.origin), b = await open(bContext, f.origin);
  await create(a, '唯一的合成回忆');
  await configure(a, f.baseUrl, f.token);
  await configure(b, f.baseUrl, f.token);
  await until(() => b.locator('.memory-card').filter({ hasText: '唯一的合成回忆' }).count(), 'second device receives record');
  await aContext.setOffline(true); await bContext.setOffline(true);
  await edit(b, '唯一的合成回忆', '另一端的并发编辑');
  let prompt = '';
  a.once('dialog', dialog => { prompt = dialog.message(); return dialog.accept(); });
  await a.locator('.memory-card').filter({ hasText: '唯一的合成回忆' }).getByText('删除', { exact: true }).click();
  await until(() => prompt, 'enabled deletion confirmation');
  assert.match(prompt, /删除可能同步到另一台设备.*同时编辑.*同步冲突.*暂停.*两端核对/);
  await until(async () => (await state(a)).memories.length === 0, 'local deletion');
  await bContext.setOffline(false);
  await until(async () => (await b.locator('#sync-status').innerText()).includes('上次同步成功'), 'concurrent edit published');
  await aContext.setOffline(false);
  await until(async () => (await a.locator('#sync-status').innerText()).includes('编辑与删除'), 'deletion versus edit conflict');
  assert.equal((await state(a)).memories.length, 0);
  assert.equal((await state(b)).memories[0].text, '另一端的并发编辑');
  await a.locator('#sync-backup').click();
  const downloadPromise = a.waitForEvent('download');
  await a.locator('#export-button').click();
  const backup = await readFile(await (await downloadPromise).path());
  const cContext = await f.context(), c = await open(cContext, f.origin);
  await c.locator('.app-header [data-open-backup]').click();
  await c.locator('#import-input').setInputFiles({ name: 'empty.ours', mimeType: 'application/octet-stream', buffer: backup });
  await until(async () => (await c.locator('#backup-status').innerText()).includes('新增 0 条'), 'empty backup restored');
  assert.equal((await state(c)).memories.length, 0);
  assert.deepEqual(f.errors, []);
});

test('two devices sync and recover offline with service workers active', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const aContext = await f.context({ serviceWorkers: 'allow' });
  const bContext = await f.context({ serviceWorkers: 'allow' });
  const a = await open(aContext, f.origin), b = await open(bContext, f.origin);
  await Promise.all([a, b].map(page => page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XrWQAAAAASUVORK5CYII=', 'base64');
  await create(a, '离线缓存里的图片', [{ name: 'synthetic.png', mimeType: 'image/png', buffer: image }]);
  await configure(a, f.baseUrl, f.token);
  await configure(b, f.baseUrl, f.token);
  await until(() => b.locator('.memory-card').filter({ hasText: '离线缓存里的图片' }).count(), 'PWA device receives image');
  assert.deepEqual(Buffer.from((await state(b)).memories[0].media[0].blob), image);
  for (const page of [a, b]) {
    const cachedApi = await page.evaluate(async () => {
      const entries = await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)));
      return entries.flat().filter(url => new URL(url).pathname.startsWith('/v1/'));
    });
    assert.deepEqual(cachedApi, [], 'synchronization responses must never enter the PWA cache');
  }
  await bContext.setOffline(true);
  await b.reload();
  await b.locator('.memory-card').filter({ hasText: '离线缓存里的图片' }).waitFor();
  await edit(b, '离线缓存里的图片', '离线刷新后修改');
  await bContext.setOffline(false);
  await until(async () => (await b.locator('#sync-status').innerText()).includes('上次同步成功'), 'PWA reconnect sync');
  await checkNow(a);
  await until(() => a.locator('.memory-card').filter({ hasText: '离线刷新后修改' }).count(), 'PWA peer receives offline edit');
  assert.deepEqual(Buffer.from((await state(a)).memories[0].media[0].blob), image);
  assert.deepEqual(f.errors, []);
});
