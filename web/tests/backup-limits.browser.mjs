// Exercises real IndexedDB transactions and downloads with synthetic records only.
// Set OURS_TEST_PLAYWRIGHT to Playwright's index.mjs and CHROME_PATH to Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = process.env.OURS_TEST_PLAYWRIGHT ? await import(pathToFileURL(process.env.OURS_TEST_PLAYWRIGHT).href) : await import('playwright');

async function fixture(t) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(root + path.sep)) return res.writeHead(403).end();
      const data = await readFile(filename);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ executablePath: chrome, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
  ] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${origin}/#/app`);
  await page.waitForSelector('#journal-content .empty-state');
  return page;
}

test('record limit serializes competing additions and rolls back copy, import and sync', { timeout: 120000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const { readLocal, compareAndSwap, saveMemory, importMemories, deleteMemory } = await import('./storage.js');
    const { createBackup, readBackup, MAX_RECORDS } = await import('./backup.js');
    const make = id => ({ id, date: '2024-01-01', text: 'synthetic', createdAt: 1, updatedAt: 1, media: [] });
    let state = await readLocal();
    await compareAndSwap({ expectedRevision: state.revision, nextRevision: crypto.randomUUID(), memories: [],
      baseline: { marker: 'baseline' }, pending: { marker: 'pending' } });
    await importMemories(Array.from({ length: MAX_RECORDS - 1 }, (_, i) => make(`r${i}`)));
    const concurrent = await Promise.allSettled([
      saveMemory(make('new-a'), { insertOnly: true }), saveMemory(make('new-b'), { insertOnly: true })
    ]);
    const full = await readLocal();
    await saveMemory({ ...full.memories.find(item => item.id === 'r0'), text: 'updated' }, { expectedRevision: full.revision });
    const before = await readLocal();
    const errors = [];
    const attempt = async fn => { try { await fn(); errors.push('unexpected success'); } catch (error) { errors.push(error.name); } };
    await attempt(() => saveMemory(make('copy'), { insertOnly: true }));
    await attempt(() => importMemories([make('r0'), make('imported')], { maxTotal: Infinity, maxManifestBytes: Infinity }));
    await attempt(() => compareAndSwap({ expectedRevision: before.revision, nextRevision: crypto.randomUUID(),
      memories: [...before.memories, make('synced')], baseline: null, pending: null }));
    const after = await readLocal();
    const exported = await readBackup(await createBackup(after.memories));
    // Simulate a pre-existing oversized library, then remove the extra synthetic item.
    const db = await (await import('./storage.js')).openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('memories', 'readwrite');
      tx.objectStore('memories').add(make('legacy-extra'));
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    const legacyBefore = await readLocal();
    let legacyError = '';
    try { await saveMemory({ ...legacyBefore.memories.find(item => item.id === 'r0'), text: 'not saved' }); }
    catch (error) { legacyError = error.message; }
    const legacyAfter = await readLocal();
    await deleteMemory('legacy-extra');
    return {
      accepted: concurrent.filter(item => item.status === 'fulfilled').length,
      rejected: concurrent.filter(item => item.status === 'rejected' && item.reason.name === 'BackupLimitError').length,
      count: after.memories.length, max: MAX_RECORDS, exported: exported.length, errors,
      edited: after.memories.find(item => item.id === 'r0').text === 'updated' && full.revision !== before.revision,
      unchanged: before.revision === after.revision && JSON.stringify(before.memories) === JSON.stringify(after.memories) &&
        JSON.stringify(before.baseline) === JSON.stringify(after.baseline) && JSON.stringify(before.pending) === JSON.stringify(after.pending),
      legacyError, legacyUnchanged: legacyBefore.revision === legacyAfter.revision && legacyAfter.memories.length === MAX_RECORDS + 1 &&
        legacyAfter.memories.find(item => item.id === 'r0').text === 'updated', legacyCount: (await readLocal()).memories.length
    };
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.count, result.max);
  assert.equal(result.exported, result.max);
  assert.equal(result.edited, true);
  assert.deepEqual(result.errors, Array(3).fill('BackupLimitError'));
  assert.equal(result.unchanged, true);
  assert.match(result.legacyError, /现有回忆可能已超过.*完整导出可能失败.*保留浏览器数据.*暂勿删除/);
  assert.equal(result.legacyUnchanged, true);
  assert.equal(result.legacyCount, result.max);
});

test('import checks the same records it enqueues even if input changes during the transaction', { timeout: 60000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const { saveMemory, importMemories, readLocal, exceedsBackupManifestLimit } = await import('./storage.js');
    const { backupManifestUpperBound, createBackup, readBackup } = await import('./backup.js');
    const record = (id, text) => ({ id, date: '2024-01-01', text, createdAt: 1, updatedAt: 1, media: [] });
    await saveMemory(record('existing', '原有记录'));
    const before = await readLocal();
    const candidate = record('incoming', '待导入');
    const limit = backupManifestUpperBound([...before.memories, candidate]) + 3;
    const atLimit = exceedsBackupManifestLimit([...before.memories, candidate], limit);
    const originalGet = IDBObjectStore.prototype.get;
    let mutated = false, failure = '';
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'sync-meta' && key === 'state' && !mutated) {
        candidate.text += 'x';
        mutated = true;
      }
      return originalGet.call(this, key);
    };
    try { await importMemories([candidate], { maxManifestBytes: limit }); }
    catch (error) { failure = error.name; }
    finally { IDBObjectStore.prototype.get = originalGet; }
    const after = await readLocal();
    const overLimit = exceedsBackupManifestLimit([...before.memories, candidate], limit);
    const restored = await readBackup(await createBackup(after.memories));
    return { mutated, failure, atLimit, overLimit,
      unchanged: JSON.stringify(before) === JSON.stringify(after),
      restored: restored.length === 1 && restored[0].text === '原有记录' };
  });
  assert.equal(result.mutated, true);
  assert.equal(result.atLimit, false);
  assert.equal(result.overLimit, true);
  assert.equal(result.failure, 'BackupLimitError');
  assert.equal(result.unchanged, true);
  assert.equal(result.restored, true);
});

test('manifest limit rolls back edits and permits a real backup without losing the draft', { timeout: 180000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const { readLocal, importMemories, saveMemory, compareAndSwap } = await import('./storage.js');
    const { backupManifestUpperBound, MAX_MANIFEST } = await import('./backup.js');
    const make = (id, text) => ({ id, date: '2024-01-01', text, createdAt: 1, updatedAt: 1, media: [] });
    const records = [make('target', '边界原稿\n“琴”')];
    records[0].media.push({ id: 'image', name: 'synthetic.png', type: 'image/png', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) });
    const empty = backupManifestUpperBound([]);
    let bytes = backupManifestUpperBound(records);
    const target = MAX_MANIFEST - 2048 - 3;
    for (let i = 0; ; i++) {
      const item = make(`m${i}`, '');
      const overhead = backupManifestUpperBound([item]) - empty + 1;
      const available = target - bytes - overhead;
      if (available < 1) throw new Error('synthetic boundary generation failed');
      if (available <= 29997) {
        item.text = '琴'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
        records.push(item); bytes += overhead + available; break;
      }
      const fill = Math.min(30000, 3 * Math.floor((available - 500) / 3));
      item.text = '琴'.repeat(fill / 3);
      records.push(item); bytes += overhead + fill;
    }
    await importMemories(records);
    // Fill the conservative limit exactly; one more byte must be rejected.
    const edge = make('edge', '');
    const edgeOverhead = backupManifestUpperBound([edge]) - empty + 1;
    const edgeLength = MAX_MANIFEST - 3 - bytes - edgeOverhead;
    if (edgeLength < 1 || edgeLength > 10000) throw new Error('synthetic exact boundary generation failed');
    edge.text = 'x'.repeat(edgeLength);
    await saveMemory(edge, { insertOnly: true });
    const before = await readLocal();
    const enlarged = make('extra', '琴'.repeat(1000));
    const errors = [];
    const attempt = async fn => { try { await fn(); errors.push('unexpected success'); } catch (error) { errors.push(error.name); } };
    await attempt(() => saveMemory(enlarged, { insertOnly: true }));
    await attempt(() => saveMemory({ ...records[0], text: records[0].text + 'x' }, { expectedRevision: before.revision }));
    await attempt(() => importMemories([records[0], enlarged]));
    await attempt(() => compareAndSwap({ expectedRevision: before.revision, nextRevision: crypto.randomUUID(),
      memories: [...before.memories, enlarged], baseline: { changed: true }, pending: null }));
    // The current local records fit, but the proposed sync merge does not.
    // Reject its journal before the engine can publish the merged snapshot.
    const proposed = [...before.memories, enlarged].map(({ media, ...memory }) => ({ ...memory,
      media: media.map(({ blob, ...item }) => ({ ...item, size: blob.size, sha256: '0'.repeat(64) })) }));
    await attempt(() => compareAndSwap({ expectedRevision: before.revision, nextRevision: crypto.randomUUID(),
      memories: before.memories, baseline: before.baseline, pending: { proposed: { memories: proposed } } }));
    const after = await readLocal();
    return { count: after.memories.length, bytes: backupManifestUpperBound(after.memories), max: MAX_MANIFEST,
      errors, unchanged: before.revision === after.revision && before.memories.length === after.memories.length &&
        before.memories.find(item => item.id === 'target').text === after.memories.find(item => item.id === 'target').text &&
        JSON.stringify(before.baseline) === JSON.stringify(after.baseline) && JSON.stringify(before.pending) === JSON.stringify(after.pending) };
  });
  assert.equal(result.bytes + 3, result.max);
  assert.deepEqual(result.errors, Array(5).fill('BackupLimitError'));
  assert.equal(result.unchanged, true);

  await page.reload();
  await page.locator('#search').fill('边界原稿');
  await page.locator('.memory-card').filter({ hasText: '边界原稿' }).getByText('编辑', { exact: true }).click();
  const draft = '编辑草稿' + '琴'.repeat(1000);
  await page.locator('#memory-text').fill(draft);
  await page.locator('#save-memory').click();
  await page.locator('#editor-backup').waitFor({ state: 'visible' });
  assert.match(await page.locator('#editor-error').innerText(), /备份目录.*上限.*未保存/);
  assert.equal(await page.locator('#memory-text').inputValue(), draft);
  const saved = await page.evaluate(async () => {
    const state = await (await import('./storage.js')).readLocal();
    return { count: state.memories.length, text: state.memories.find(item => item.id === 'target').text };
  });
  assert.equal(saved.count, result.count);
  assert.equal(saved.text, '边界原稿\n“琴”');
  await page.locator('#editor-backup').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const data = await readFile(await (await download).path());
  assert.equal(data.subarray(0, 8).toString(), 'OURSBAK1');
  const manifest = JSON.parse(data.subarray(16, 16 + data.readUInt32BE(8)).toString('utf8'));
  assert.equal(manifest.memories.length, result.count);
  assert.equal(manifest.memories.find(item => item.id === 'target').text, '边界原稿\n“琴”');
  await page.locator('[data-close-backup]').click();
  assert.equal(await page.locator('#memory-text').inputValue(), draft);
});

test('new and copied drafts at the record limit remain intact and the existing library can be downloaded', { timeout: 120000 }, async t => {
  const page = await fixture(t);
  await page.locator('#search').fill('数目边界');
  await page.evaluate(async () => {
    const { importMemories } = await import('./storage.js');
    const { MAX_RECORDS } = await import('./backup.js');
    await importMemories(Array.from({ length: MAX_RECORDS - 1 }, (_, i) => ({
      id: `seed-${i}`, date: '2024-01-01', text: '合成记录', createdAt: 1, updatedAt: 1, media: []
    })));
    window.dispatchEvent(new Event('hashchange'));
  });
  await page.waitForFunction(() => document.querySelector('#memory-count').textContent.includes('已经收藏 9999 条回忆'));
  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-01');
  await page.locator('#memory-text').fill('数目边界成功');
  await page.locator('#save-memory').click();
  await page.locator('.memory-card').filter({ hasText: '数目边界成功' }).waitFor();

  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-01');
  await page.locator('#memory-text').fill('数目边界草稿');
  await page.locator('#save-memory').click();
  await page.locator('#editor-backup').waitFor({ state: 'visible' });
  assert.match(await page.locator('#editor-error').innerText(), /数量.*上限.*未保存/);
  assert.equal(await page.locator('#memory-text').inputValue(), '数目边界草稿');
  await page.locator('#editor-backup').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const data = await readFile(await (await download).path());
  const manifest = JSON.parse(data.subarray(16, 16 + data.readUInt32BE(8)).toString('utf8'));
  assert.equal(manifest.memories.length, 10000);
  assert.equal(manifest.memories.some(item => item.text === '数目边界成功'), true);
  assert.equal(manifest.memories.some(item => item.text === '数目边界草稿'), false);
  await page.locator('[data-close-backup]').click();
  assert.equal(await page.locator('#memory-text').inputValue(), '数目边界草稿');
  await page.locator('[data-close-editor]').last().click();

  await page.locator('.memory-card').filter({ hasText: '数目边界成功' }).getByText('编辑', { exact: true }).click();
  await page.locator('#memory-text').fill('保留的复制草稿');
  await page.evaluate(async () => {
    const { readLocal, saveMemory } = await import('./storage.js');
    const state = await readLocal();
    const record = state.memories.find(item => item.id === 'seed-0');
    await saveMemory({ ...record, text: '另一页面的修改' });
  });
  await page.locator('#save-memory').click();
  await page.locator('#save-copy').waitFor({ state: 'visible' });
  const before = await page.evaluate(async () => {
    const state = await (await import('./storage.js')).readLocal();
    return { revision: state.revision, count: state.memories.length };
  });
  await page.locator('#save-copy').click();
  await page.locator('#editor-backup').waitFor({ state: 'visible' });
  assert.match(await page.locator('#editor-error').innerText(), /数量.*上限.*未保存/);
  assert.equal(await page.locator('#memory-text').inputValue(), '保留的复制草稿');
  const after = await page.evaluate(async () => {
    const state = await (await import('./storage.js')).readLocal();
    return { revision: state.revision, count: state.memories.length,
      original: state.memories.some(item => item.text === '数目边界成功'),
      otherEdit: state.memories.some(item => item.text === '另一页面的修改'),
      copied: state.memories.some(item => item.text === '保留的复制草稿') };
  });
  assert.deepEqual(after, { ...before, original: true, otherEdit: true, copied: false });
});

test('sync rejects an oversized merge before publishing while the local library remains exportable', { timeout: 120000 }, async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const { readLocal, compareAndSwap, importMemories } = await import('./storage.js');
    const { createBackup, readBackup } = await import('./backup.js');
    const { createSyncEngine } = await import('./sync-engine.js');
    const make = id => ({ id, date: '2024-01-01', text: '琴'.repeat(10000), createdAt: 1, updatedAt: 1, media: [] });
    const local = Array.from({ length: 145 }, (_, i) => make(`local-${i}`));
    const remote = Array.from({ length: 145 }, (_, i) => make(`remote-${i}`));
    await importMemories(local);
    const before = await readLocal();
    const spaceId = 'synthetic-space';
    const snapshot = { format: 'ours-web-sync', version: 1, spaceId, clock: [['remote-device', 1]], memories: remote };
    let requests = 0, snapshotWrites = 0, storageFailure = '';
    const random = crypto.getRandomValues(new Uint8Array(32));
    const credential = btoa(String.fromCharCode(...random)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const engine = createSyncEngine({
      baseUrl: 'http://127.0.0.1:9', allowLocalhost: true, token: credential, spaceId, deviceId: 'local-device',
      readLocal, withLock: callback => callback(),
      compareAndSwap: async change => {
        try { return await compareAndSwap(change); }
        catch (error) { storageFailure = error.name; throw error; }
      },
      fetch: async (url, options) => {
        requests++;
        if (options.method !== 'GET' || !url.endsWith('/v1/snapshot')) { snapshotWrites++; throw new Error('unexpected write'); }
        return new Response(JSON.stringify({ revision: '1', snapshot }), { headers: { etag: '"1"' } });
      }
    });
    let failure = '';
    try { await engine.sync(); } catch (error) { failure = error.code; }
    const after = await readLocal();
    const restored = await readBackup(await createBackup(after.memories));
    return { requests, snapshotWrites, storageFailure, failure, restored: restored.length,
      unchanged: before.revision === after.revision && before.memories.length === after.memories.length &&
        before.baseline === after.baseline && before.pending === after.pending };
  });
  assert.equal(result.requests, 1);
  assert.equal(result.snapshotWrites, 0);
  assert.equal(result.storageFailure, 'BackupLimitError');
  assert.equal(result.failure, 'LOCAL_COMMIT');
  assert.equal(result.unchanged, true);
  assert.equal(result.restored, 145);
});
