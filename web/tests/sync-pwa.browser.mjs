// Run after `npm run build`: exercise the built PWA with synthetic local data.
// Chrome and Playwright run in an isolated browser context; only localhost is served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = process.env.OURS_TEST_PLAYWRIGHT
  ? await import(pathToFileURL(process.env.OURS_TEST_PLAYWRIGHT).href) : await import('playwright');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XrWQAAAAASUVORK5CYII=', 'base64');

test('built PWA precaches sync modules and reloads local records offline', { timeout: 60000 }, async t => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const filename = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      const data = await readFile(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(data);
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
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/app`);
  await page.locator('.empty-state').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  const cachedPaths = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    }
    return result;
  });
  assert.ok(cachedPaths.includes('/sync.js'), 'built sync controller was not precached');
  assert.ok(cachedPaths.includes('/sync-engine.js'), 'built sync engine was not precached');
  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-01');
  await page.locator('#memory-text').fill('离线前的合成回忆');
  await page.locator('#media-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await page.locator('#save-memory').click();
  await page.locator('.memory-card').filter({ hasText: '离线前的合成回忆' }).waitFor();
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.locator('.memory-card').filter({ hasText: '离线前的合成回忆' }).waitFor();
  const stored = await page.evaluate(async () => {
    const { readLocal } = await import('./storage.js');
    const state = await readLocal();
    return [...new Uint8Array(await state.memories[0].media[0].blob.arrayBuffer())];
  });
  assert.deepEqual(Buffer.from(stored), png);
  await page.locator('.journal-heading-actions [data-new]').click();
  await page.locator('#memory-date').fill('2024-01-02');
  await page.locator('#memory-text').fill('离线时写的合成回忆');
  await page.locator('#save-memory').click();
  await page.locator('.memory-card').filter({ hasText: '离线时写的合成回忆' }).waitFor();
  await page.reload({ waitUntil: 'load' });
  await page.locator('.memory-card').filter({ hasText: '离线前的合成回忆' }).waitFor();
  await page.locator('.memory-card').filter({ hasText: '离线时写的合成回忆' }).waitFor();
  assert.deepEqual(errors, []);
});
