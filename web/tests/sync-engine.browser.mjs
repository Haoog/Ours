import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Optional Playwright browser test. Install Playwright or point
// SYNC_ENGINE_PLAYWRIGHT at its index.mjs; no application data is used.
async function playwright() {
  try {
    return process.env.SYNC_ENGINE_PLAYWRIGHT
      ? await import(pathToFileURL(process.env.SYNC_ENGINE_PLAYWRIGHT).href)
      : await import('playwright');
  } catch { return null; }
}
async function appServer(t) {
  const source = await readFile(new URL('../sync-engine.js', import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === '/sync-engine.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      response.end(source);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><title>Synthetic synchronization test</title>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function backend(t, origin) {
  const dir = await mkdtemp(join(tmpdir(), 'ours-sync-browser-test-'));
  const source = fileURLToPath(new URL('../../ours-sync/', import.meta.url));
  await Promise.all(['server.js', 'package.json'].map(name => copyFile(join(source, name), join(dir, name))));
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [join(dir, 'server.js')], {
    cwd: dir, env: { OURS_SYNC_TOKEN: token, OURS_SYNC_PORT: '0', OURS_SYNC_ALLOWED_ORIGINS: origin },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Browser test backend did not start')), 10000);
    child.stdout.on('data', data => {
      output += data.toString();
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Browser test backend exited early')); });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function initialize(page, settings, preserveState = false) {
  await page.evaluate(async ({ config, preserveState }) => {
    const { createSyncEngine } = await import('/sync-engine.js');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('ours-sync-engine-synthetic-test', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    async function readLocal() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readonly');
        let value;
        tx.objectStore('state').get('current').onsuccess = event => { value = event.target.result; };
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error);
      });
    }
    async function compareAndSwap({ expectedRevision, nextRevision, memories, baseline, pending }) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
        const objectStore = tx.objectStore('state');
        let next = null;
        objectStore.get('current').onsuccess = event => {
          if (event.target.result.revision !== expectedRevision) return;
          next = nextRevision;
          objectStore.put({ revision: next, memories, baseline, pending }, 'current');
        };
        tx.oncomplete = () => resolve(next);
        tx.onabort = () => reject(tx.error);
      });
    }
    async function edit(mutator) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
        const objectStore = tx.objectStore('state');
        objectStore.get('current').onsuccess = event => {
          const state = event.target.result;
          mutator(state.memories);
          state.revision = crypto.randomUUID();
          objectStore.put(state, 'current');
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    }
    if (!preserveState) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
        tx.objectStore('state').put({ revision: crypto.randomUUID(), memories: [], baseline: null, pending: null }, 'current');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    }
    let duringPut = null, losePutResponse = false;
    const engine = createSyncEngine({ ...config, allowLocalhost: true, readLocal, compareAndSwap,
      withLock: callback => navigator.locks.request('ours-sync-engine-synthetic-test', callback),
      fetch: async (url, options) => {
        const response = await fetch(url, options);
        if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
          if (duringPut) {
            const value = duringPut; duringPut = null;
            await edit(records => { const record = records.find(item => item.id === value.id); record.text = value.text; record.updatedAt++; });
          }
          if (losePutResponse) {
            losePutResponse = false;
            throw new Error('Synthetic lost snapshot response');
          }
        }
        return response;
      }
    });
    window.syntheticSync = {
      add: (id, text, mediaBytes) => edit(records => records.push({ id, date: '2025-01-15', text,
        createdAt: 1, updatedAt: 1, media: mediaBytes ? [{ id: `media-${id}`, name: 'test.png', type: 'image/png',
          blob: new Blob([new Uint8Array(mediaBytes)], { type: 'image/png' }) }] : [] })),
      change: (id, text) => edit(records => { const record = records.find(item => item.id === id); record.text = text; record.updatedAt++; }),
      remove: id => edit(records => { const index = records.findIndex(item => item.id === id); if (index < 0) throw new Error('Missing test record'); records.splice(index, 1); }),
      arm: (id, text) => { duringPut = { id, text }; },
      loseNextPutResponse: () => { losePutResponse = true; },
      read: async () => {
        const state = await readLocal();
        return { ...state, memories: await Promise.all(state.memories.map(async item => ({ ...item,
          media: await Promise.all(item.media.map(async media => ({ ...media, blob: [...new Uint8Array(await media.blob.arrayBuffer())] }))) }))) };
      },
      sync: () => engine.sync()
    };
  }, { config: settings, preserveState });
}

test('two real browser contexts use IndexedDB, Web Locks, CORS, media, and local CAS', async t => {
  const library = await playwright();
  if (!library) { t.skip('Playwright is not installed; set SYNC_ENGINE_PLAYWRIGHT to its index.mjs'); return; }
  const origin = await appServer(t), remote = await backend(t, origin);
  const browser = await library.chromium.launch({ headless: true,
    ...(process.env.SYNC_ENGINE_CHROMIUM ? { executablePath: process.env.SYNC_ENGINE_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  const a = await contextA.newPage(), b = await contextB.newPage();
  let leaked = false;
  for (const page of [a, b]) {
    page.on('request', request => { if (request.url().includes(remote.token)) leaked = true; });
    await page.goto(origin);
  }
  await initialize(a, { ...remote, spaceId: 'browser-space', deviceId: 'browser-a' });
  await initialize(b, { ...remote, spaceId: 'browser-space', deviceId: 'browser-b' });
  await a.evaluate(() => window.syntheticSync.add('a', '甲', [0, 255, 7, 128]));
  await b.evaluate(() => window.syntheticSync.add('b', '乙'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  const bState = await b.evaluate(() => window.syntheticSync.read());
  assert.deepEqual(bState.memories.find(item => item.id === 'a').media[0].blob, [0, 255, 7, 128]);
  assert.equal(bState.memories.find(item => item.id === 'b').text, '乙');
  await a.evaluate(() => window.syntheticSync.change('a', '甲修改'));
  await b.evaluate(() => window.syntheticSync.change('a', '乙修改'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  const conflict = await b.evaluate(() => window.syntheticSync.sync());
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.conflicts[0].local.text, '乙修改');
  assert.equal(conflict.conflicts[0].remote.text, '甲修改');
  await a.evaluate(async () => { await window.syntheticSync.change('a', '上传中的版本'); window.syntheticSync.arm('a', '上传期间的新修改'); });
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'local_changed');
  assert.equal((await a.evaluate(() => window.syntheticSync.read())).memories.find(item => item.id === 'a').text, '上传期间的新修改');
  const pending = await a.evaluate(() => window.syntheticSync.sync());
  assert.equal(pending.status, 'pending_local_changed');
  assert.equal(pending.local.memories.find(item => item.id === 'a').text, '上传期间的新修改');
  const final = await a.evaluate(() => window.syntheticSync.read());
  assert.equal(final.memories.find(item => item.id === 'a').text, '上传期间的新修改');
  assert.ok(final.pending);
  assert.equal(leaked, false);
});

test('browser deletion survives offline reload, synchronizes additions, and preserves an edit-delete conflict', async t => {
  const library = await playwright();
  if (!library) { t.skip('Playwright is not installed; set SYNC_ENGINE_PLAYWRIGHT to its index.mjs'); return; }
  const origin = await appServer(t), remote = await backend(t, origin);
  const browser = await library.chromium.launch({ headless: true,
    ...(process.env.SYNC_ENGINE_CHROMIUM ? { executablePath: process.env.SYNC_ENGINE_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  const a = await contextA.newPage(), b = await contextB.newPage();
  await Promise.all([a.goto(origin), b.goto(origin)]);
  const configA = { ...remote, spaceId: 'browser-deletion', deviceId: 'browser-a' };
  const configB = { ...remote, spaceId: 'browser-deletion', deviceId: 'browser-b' };
  await initialize(a, configA);
  await initialize(b, configB);
  await a.evaluate(() => window.syntheticSync.add('old', '待删除', [1, 2, 3]));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  await b.evaluate(() => window.syntheticSync.remove('old'));
  const offlineBefore = await b.evaluate(() => window.syntheticSync.read());
  await contextB.setOffline(true);
  const offlineError = await b.evaluate(async () => {
    try { await window.syntheticSync.sync(); return null; } catch (error) { return error.code; }
  });
  assert.equal(offlineError, 'NETWORK');
  assert.deepEqual(await b.evaluate(() => window.syntheticSync.read()), offlineBefore);
  await contextB.setOffline(false);
  await b.reload();
  await initialize(b, configB, true);
  assert.deepEqual(await b.evaluate(() => window.syntheticSync.read()), offlineBefore);
  await a.evaluate(() => window.syntheticSync.add('new', '另一端新增'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  for (const page of [a, b]) {
    const state = await page.evaluate(() => window.syntheticSync.read());
    assert.deepEqual(state.memories.map(item => item.id), ['new']);
    assert.equal(state.pending, null);
  }
  await a.evaluate(() => window.syntheticSync.add('conflict', '原文'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  await a.evaluate(() => window.syntheticSync.remove('conflict'));
  await b.evaluate(() => window.syntheticSync.change('conflict', '另一端的编辑'));
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  const localBefore = await a.evaluate(() => window.syntheticSync.read());
  const readRemote = async () => {
    const response = await fetch(`${remote.baseUrl}/v1/snapshot`, { headers: { Authorization: `Bearer ${remote.token}` } });
    assert.equal(response.status, 200);
    return { etag: response.headers.get('etag'), ...(await response.json()) };
  };
  const remoteBefore = await readRemote();
  const result = await a.evaluate(() => window.syntheticSync.sync());
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'edit-delete');
  assert.equal(result.conflicts[0].deletedBy, 'local');
  assert.equal(result.conflicts[0].remote.text, '另一端的编辑');
  assert.deepEqual(await a.evaluate(() => window.syntheticSync.read()), localBefore);
  assert.deepEqual(await readRemote(), remoteBefore);
});

test('browser reload retains an uncertain deletion journal and reconciles only an unsuperseded write', async t => {
  const library = await playwright();
  if (!library) { t.skip('Playwright is not installed; set SYNC_ENGINE_PLAYWRIGHT to its index.mjs'); return; }
  const origin = await appServer(t), remote = await backend(t, origin);
  const browser = await library.chromium.launch({ headless: true,
    ...(process.env.SYNC_ENGINE_CHROMIUM ? { executablePath: process.env.SYNC_ENGINE_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  const a = await contextA.newPage(), b = await contextB.newPage();
  await Promise.all([a.goto(origin), b.goto(origin)]);
  const configA = { ...remote, spaceId: 'browser-pending', deviceId: 'browser-a' };
  const configB = { ...remote, spaceId: 'browser-pending', deviceId: 'browser-b' };
  await initialize(a, configA);
  await initialize(b, configB);
  async function deleteWithLostResponse(id) {
    await a.evaluate(async value => {
      await window.syntheticSync.remove(value);
      window.syntheticSync.loseNextPutResponse();
    }, id);
    const error = await a.evaluate(async () => {
      try { await window.syntheticSync.sync(); return null; }
      catch (failure) { return { code: failure.code, remoteCommitUnknown: failure.remoteCommitUnknown }; }
    });
    assert.deepEqual(error, { code: 'NETWORK', remoteCommitUnknown: true });
    const beforeReload = await a.evaluate(() => window.syntheticSync.read());
    assert.ok(beforeReload.pending);
    assert.ok(!beforeReload.memories.some(item => item.id === id));
    await a.reload();
    await initialize(a, configA, true);
    assert.deepEqual(await a.evaluate(() => window.syntheticSync.read()), beforeReload);
    return beforeReload;
  }
  await a.evaluate(() => window.syntheticSync.add('first', '待删除'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  await deleteWithLostResponse('first');
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.deepEqual((await b.evaluate(() => window.syntheticSync.read())).memories, []);
  await a.evaluate(() => window.syntheticSync.add('second', '再次删除'));
  assert.equal((await a.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  const pending = await deleteWithLostResponse('second');
  await b.evaluate(() => window.syntheticSync.add('new', '另一端新增'));
  assert.equal((await b.evaluate(() => window.syntheticSync.sync())).status, 'synced');
  const result = await a.evaluate(() => window.syntheticSync.sync());
  assert.equal(result.status, 'pending_conflict');
  assert.deepEqual(result.remote.memories.map(item => item.id), ['new']);
  assert.deepEqual(await a.evaluate(() => window.syntheticSync.read()), pending);
  assert.deepEqual((await b.evaluate(() => window.syntheticSync.read())).memories.map(item => item.id), ['new']);
});
