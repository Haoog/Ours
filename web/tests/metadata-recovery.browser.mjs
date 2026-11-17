// Recovery regression: only synthetic data and isolated browser contexts are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = process.env.OURS_TEST_PLAYWRIGHT
  ? await import(pathToFileURL(process.env.OURS_TEST_PLAYWRIGHT).href) : await import('playwright');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XrWQAAAAASUVORK5CYII=', 'base64');

test('damaged sync metadata pauses sync but leaves memory and media exportable', { timeout: 60000 }, async t => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(await readFile(filename));
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
  browser = await playwright.chromium.launch({ executablePath: chrome, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
  ] });
  async function open() {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/#/app`);
    await page.locator('.empty-state').waitFor();
    return page;
  }
  const page = await open();
  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-01');
  await page.locator('#memory-text').fill('需要恢复的合成回忆');
  await page.locator('#media-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image });
  await page.locator('#save-memory').click();
  await page.locator('.memory-card').filter({ hasText: '需要恢复的合成回忆' }).waitFor();
  const damaged = await page.evaluate(async () => {
    const { openDatabase } = await import('./storage.js');
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync-meta', 'readwrite');
      const store = tx.objectStore('sync-meta');
      let value;
      store.get('state').onsuccess = event => {
        value = { ...event.target.result, baseline: { sentinel: 'baseline' }, pending: { sentinel: 'pending' } };
        delete value.revision;
        store.put(value, 'state');
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error);
    });
  });
  await page.reload();
  await page.getByText('本地同步元数据无法读取，同步已暂停', { exact: false }).first().waitFor();
  await page.locator('#sync-backup').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const backup = await readFile(await (await download).path());
  const after = await page.evaluate(async () => {
    const { openDatabase } = await import('./storage.js');
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('sync-meta').objectStore('sync-meta').get('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  assert.deepEqual(after, damaged, 'export must not reset damaged metadata or pending journal');

  const restored = await open();
  await restored.locator('.app-header [data-open-backup]').click();
  await restored.locator('#import-input').setInputFiles({ name: 'synthetic.ours', mimeType: 'application/octet-stream', buffer: backup });
  await restored.getByText('导入完成：新增 1 条', { exact: false }).waitFor();
  const recovered = await restored.evaluate(async () => {
    const { readLocal } = await import('./storage.js');
    const { memories } = await readLocal();
    return { text: memories[0].text, image: [...new Uint8Array(await memories[0].media[0].blob.arrayBuffer())] };
  });
  assert.equal(recovered.text, '需要恢复的合成回忆');
  assert.deepEqual(Buffer.from(recovered.image), image);
});
