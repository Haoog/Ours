// Real-browser regression for synchronization settings and pending-journal safety.
// Credentials are generated inside the isolated browser and never returned or logged.
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = process.env.OURS_TEST_PLAYWRIGHT
  ? await import(pathToFileURL(process.env.OURS_TEST_PLAYWRIGHT).href) : await import('playwright');

class CheckFailure extends Error {}
function check(result, message) {
  if (result !== true) throw new CheckFailure(message);
}
function scenario(name, callback) {
  test(name, { timeout: 60000 }, async t => {
    try { await callback(t); }
    catch (error) {
      if (error instanceof CheckFailure) throw error;
      // Browser and transport exceptions can include evaluated values. Never print them.
      throw new Error('Browser scenario did not complete.');
    }
  });
}

async function fixture(t) {
  const files = new Set(['/sync.js', '/sync-engine.js', '/storage.js', '/backup.js']);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><title>test</title>');
      } else if (files.has(pathname)) {
        const data = await readFile(fileURLToPath(new URL(`.${pathname}`, root)));
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(data);
      } else response.writeHead(404).end();
    } catch { response.writeHead(500).end(); }
  });
  let browser;
  t.after(async () => {
    try { await browser?.close(); } catch { /* No diagnostic may include browser values. */ }
    try { await new Promise(resolve => server.close(resolve)); } catch { /* Server already closed. */ }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch({ executablePath: chrome, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
  ] });
  async function context() {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return ctx;
  }
  async function page(ctx) {
    const result = await ctx.newPage();
    await result.goto(origin);
    await result.evaluate(async () => {
      const sync = await import('/sync.js');
      const storage = await import('/storage.js');
      const makeCredential = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      };
      const state = { first: makeCredential(), second: makeCredential(), calls: [], messages: [] };
      const controller = sync.createSyncController({
        onStatus: status => state.messages.push(status.message), onDataChanged() {}, canAutoSync: () => false
      });
      globalThis.fetch = async (url, options) => {
        state.calls.push({ origin: new URL(url).origin, method: options.method,
          first: options.headers.Authorization === `Bearer ${state.first}`,
          second: options.headers.Authorization === `Bearer ${state.second}` });
        return new Response(null, { status: 401 });
      };
      globalThis.harness = { sync, storage, state, controller };
    });
    return result;
  }
  return { context, page };
}

scenario('origin binding retains only credentials for the same normalized origin', async t => {
  const f = await fixture(t), ctx = await f.context(), page = await f.page(ctx);
  const results = await page.evaluate(async () => {
    const { controller, storage, state, sync } = globalThis.harness;
    const firstOrigin = 'https://service-a.invalid', secondOrigin = 'https://service-b.invalid';
    const results = [sync.normalizeOrigin('HTTP://LOCALHOST:80/') === 'http://localhost',
      sync.normalizeOrigin('http://[::1]:80/') === 'http://[::1]'];
    for (const invalid of ['http://service-a.invalid', `${firstOrigin}/path`, `${firstOrigin}/?query=1`,
      `https://${state.first}@service-a.invalid`]) {
      let rejected = false;
      try { sync.normalizeOrigin(invalid); } catch { rejected = true; }
      results.push(rejected);
    }
    await controller.saveSettings({ enabled: false, baseUrl: ' HTTPS://SERVICE-A.INVALID:443/ ', token: state.first });
    let saved = (await storage.readSyncSettings()).settings;
    results.push(saved.baseUrl === firstOrigin && saved.tokenOrigin === firstOrigin && saved.token === state.first);
    await controller.saveSettings({ enabled: true, baseUrl: 'https://SERVICE-A.invalid/', token: '' });
    saved = (await storage.readSyncSettings()).settings;
    results.push(saved.enabled && saved.baseUrl === firstOrigin && saved.token === state.first && saved.tokenOrigin === firstOrigin);
    await controller.run();
    results.push(state.calls.length === 1 && state.calls[0].origin === firstOrigin && state.calls[0].first);
    await controller.saveSettings({ enabled: false, baseUrl: secondOrigin, token: '' });
    saved = (await storage.readSyncSettings()).settings;
    results.push(!saved.enabled && saved.baseUrl === secondOrigin && !saved.token && !saved.tokenOrigin);
    let rejected = false;
    try { await controller.saveSettings({ enabled: true, baseUrl: secondOrigin, token: '' }); } catch { rejected = true; }
    saved = (await storage.readSyncSettings()).settings;
    results.push(rejected && !saved.enabled && saved.baseUrl === secondOrigin && !saved.token);
    await controller.run();
    results.push(state.calls.length === 1);
    await controller.saveSettings({ enabled: true, baseUrl: secondOrigin, token: state.second });
    saved = (await storage.readSyncSettings()).settings;
    results.push(saved.enabled && saved.baseUrl === secondOrigin && saved.token === state.second && saved.tokenOrigin === secondOrigin);
    await controller.run();
    results.push(state.calls.length === 2 && state.calls[1].origin === secondOrigin && state.calls[1].second && !state.calls[1].first);
    rejected = false;
    try { await controller.saveSettings({ enabled: true, baseUrl: firstOrigin, token: '' }); } catch { rejected = true; }
    saved = (await storage.readSyncSettings()).settings;
    results.push(rejected && saved.enabled && saved.baseUrl === secondOrigin && saved.token === state.second);
    return results;
  });
  check(results.length === 15 && results.every(Boolean), 'Origin normalization or credential binding failed.');
});

scenario('legacy or mismatched bindings cannot send requests until explicitly reentered', async t => {
  const f = await fixture(t), ctx = await f.context(), page = await f.page(ctx);
  const result = await page.evaluate(async () => {
    const { controller, storage, state } = globalThis.harness;
    const origin = 'https://service-a.invalid';
    await storage.writeSyncSettings({ enabled: true, baseUrl: origin, token: state.first });
    await controller.run();
    const legacyStopped = state.calls.length === 0 && state.messages.at(-1).includes('凭证');
    let rejected = false;
    try { await controller.saveSettings({ enabled: true, baseUrl: origin, token: '' }); } catch { rejected = true; }
    await controller.saveSettings({ enabled: false, baseUrl: origin, token: '' });
    const cleared = (await storage.readSyncSettings()).settings;
    await controller.saveSettings({ enabled: true, baseUrl: origin, token: state.first });
    await controller.run();
    const explicitSent = state.calls.length === 1 && state.calls[0].first;
    await storage.writeSyncSettings({ enabled: true, baseUrl: origin, token: state.first, tokenOrigin: 'https://service-b.invalid' });
    await controller.run();
    return legacyStopped && rejected && !cleared.token && !cleared.tokenOrigin && explicitSent &&
      state.calls.length === 1 && state.messages.at(-1).includes('凭证');
  });
  check(result, 'An unbound credential was reused or explicit entry failed.');
});

scenario('history blocks changing or clearing the configured origin', async t => {
  const f = await fixture(t);
  for (const kind of ['baseline', 'pending', 'different-journal-origin']) {
    const ctx = await f.context(), page = await f.page(ctx);
    const result = await page.evaluate(async kind => {
      const { controller, storage, state } = globalThis.harness;
      const firstOrigin = 'https://service-a.invalid', secondOrigin = 'https://service-b.invalid';
      await controller.saveSettings({ enabled: false, baseUrl: firstOrigin, token: state.first });
      const old = await storage.readLocal();
      const journal = { server: kind === 'different-journal-origin' ? secondOrigin : firstOrigin };
      await storage.compareAndSwap({ expectedRevision: old.revision, nextRevision: crypto.randomUUID(), memories: old.memories,
        baseline: kind === 'pending' ? null : journal, pending: kind === 'pending' ? journal : null });
      const attempts = [secondOrigin, ''];
      let allRejected = true;
      for (const baseUrl of attempts) {
        try { await controller.saveSettings({ enabled: false, baseUrl, token: baseUrl ? state.second : '' }); allRejected = false; }
        catch { /* The whole settings write must be rejected. */ }
      }
      const settings = (await storage.readSyncSettings()).settings, current = await storage.readLocal();
      const kept = !settings.enabled && settings.baseUrl === firstOrigin && settings.token === state.first &&
        settings.tokenOrigin === firstOrigin && (current.baseline || current.pending)?.server === journal.server;
      return allRejected && kept && state.calls.length === 0;
    }, kind);
    check(result, 'History allowed an origin change or failed to preserve the existing state.');
    await ctx.close();
  }
});

scenario('equivalent spellings remain usable with an existing canonical history', async t => {
  const f = await fixture(t), ctx = await f.context(), page = await f.page(ctx);
  const result = await page.evaluate(async () => {
    const { controller, storage, state } = globalThis.harness;
    const origin = 'https://service-a.invalid';
    await storage.writeSyncSettings({ enabled: false, baseUrl: 'https://SERVICE-A.INVALID:443/',
      token: state.first, tokenOrigin: 'https://service-a.invalid/' });
    const old = await storage.readLocal();
    await storage.compareAndSwap({ expectedRevision: old.revision, nextRevision: crypto.randomUUID(), memories: old.memories,
      baseline: { server: origin }, pending: null });
    await controller.saveSettings({ enabled: false, baseUrl: origin, token: '' });
    const settings = (await storage.readSyncSettings()).settings, current = await storage.readLocal();
    return settings.baseUrl === origin && settings.tokenOrigin === origin && settings.token === state.first && current.baseline.server === origin;
  });
  check(result, 'Equivalent origins were treated as a history or credential change.');
});

scenario('the shared lock prevents a switch after another tab creates history', async t => {
  const f = await fixture(t), ctx = await f.context(), writer = await f.page(ctx), saver = await f.page(ctx);
  await writer.evaluate(async () => {
    const { controller, state } = globalThis.harness;
    await controller.saveSettings({ enabled: false, baseUrl: 'https://service-a.invalid', token: state.first });
    globalThis.lockAcquired = false;
    globalThis.lockFinished = navigator.locks.request('ours-web-sync', async () => {
      globalThis.lockAcquired = true;
      await new Promise(resolve => { globalThis.releaseLock = resolve; });
      const { storage } = globalThis.harness;
      const old = await storage.readLocal();
      await storage.compareAndSwap({ expectedRevision: old.revision, nextRevision: crypto.randomUUID(), memories: old.memories,
        baseline: { server: 'https://service-a.invalid' }, pending: null });
    });
  });
  await writer.waitForFunction(() => globalThis.lockAcquired);
  await saver.evaluate(() => {
    const { controller, state } = globalThis.harness;
    globalThis.saveFinished = controller.saveSettings({ enabled: false, baseUrl: 'https://service-b.invalid', token: state.second })
      .then(() => false, () => true);
  });
  await writer.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'ours-web-sync'));
  await writer.evaluate(async () => { globalThis.releaseLock(); await globalThis.lockFinished; });
  const result = await saver.evaluate(async () => {
    const rejected = await globalThis.saveFinished;
    const { settings } = await globalThis.harness.storage.readSyncSettings();
    const local = await globalThis.harness.storage.readLocal();
    return rejected && settings.baseUrl === 'https://service-a.invalid' && local.baseline?.server === settings.baseUrl;
  });
  check(result, 'A queued switch did not observe the newly created history.');
});

scenario('a queued sync cannot send stale credentials after another tab changes settings', async t => {
  const f = await fixture(t), ctx = await f.context();
  const holder = await f.page(ctx), saver = await f.page(ctx), runner = await f.page(ctx);
  await holder.evaluate(async () => {
    const { controller, state } = globalThis.harness;
    await controller.saveSettings({ enabled: true, baseUrl: 'https://service-a.invalid', token: state.first });
    globalThis.lockAcquired = false;
    globalThis.lockFinished = navigator.locks.request('ours-web-sync', async () => {
      globalThis.lockAcquired = true;
      await new Promise(resolve => { globalThis.releaseLock = resolve; });
    });
  });
  await holder.waitForFunction(() => globalThis.lockAcquired);
  await saver.evaluate(() => {
    globalThis.saveFinished = globalThis.harness.controller.saveSettings({ enabled: false, baseUrl: 'https://service-b.invalid', token: '' });
  });
  await holder.waitForFunction(async () => (await navigator.locks.query()).pending.filter(lock => lock.name === 'ours-web-sync').length === 1);
  await runner.evaluate(() => { globalThis.runFinished = globalThis.harness.controller.run(); });
  await holder.waitForFunction(async () => (await navigator.locks.query()).pending.filter(lock => lock.name === 'ours-web-sync').length === 2);
  await holder.evaluate(async () => { globalThis.releaseLock(); await globalThis.lockFinished; });
  const result = await runner.evaluate(async () => {
    await globalThis.runFinished;
    const { storage, state } = globalThis.harness;
    const { settings } = await storage.readSyncSettings();
    return state.calls.length === 0 && settings.baseUrl === 'https://service-b.invalid' && !settings.enabled && !settings.token &&
      state.messages.at(-1).includes('设置已变化');
  });
  await saver.evaluate(() => globalThis.saveFinished);
  check(result, 'A waiting synchronization used settings that another tab replaced.');
});

scenario('an oversized legacy pending proposal stops before any network request', async t => {
  const f = await fixture(t), ctx = await f.context(), page = await f.page(ctx);
  const result = await page.evaluate(async () => {
    const { controller, storage, state } = globalThis.harness;
    const origin = 'https://service-a.invalid';
    await controller.saveSettings({ enabled: true, baseUrl: origin, token: state.first });
    const db = await storage.openDatabase();
    const tx = db.transaction('sync-meta', 'readwrite'), store = tx.objectStore('sync-meta');
    const stateRequest = store.get('state');
    stateRequest.onsuccess = () => {
      const local = stateRequest.result;
      const snapshot = memories => ({ format: 'ours-web-sync', version: 1, spaceId: 'ours-web', clock: [], memories });
      const memories = Array.from({ length: 850 }, (_, index) => ({ id: `record-${index}`, date: '2024-01-01',
        text: 'x'.repeat(10000), createdAt: 1, updatedAt: 1, media: [] }));
      local.pending = { format: 'ours-web-sync-pending', version: 1, server: origin, spaceId: 'ours-web', id: 'journal',
        revision: local.revision, etag: '"0"', local: snapshot([]), proposed: snapshot(memories) };
      store.put(local, 'state');
    };
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
    await controller.run();
    const local = await storage.readLocal();
    return state.calls.length === 0 && local.pending?.proposed.memories.length === 850 &&
      state.messages.at(-1).includes('备份上限') && state.messages.at(-1).includes('导出');
  });
  check(result, 'Oversized pending recovery contacted the service or lost its journal.');
});

scenario('a newly merged oversized proposal is never published and reports capacity', async t => {
  const f = await fixture(t), ctx = await f.context(), page = await f.page(ctx);
  const result = await page.evaluate(async () => {
    const { controller, storage, state } = globalThis.harness;
    const origin = 'https://service-a.invalid';
    await controller.saveSettings({ enabled: true, baseUrl: origin, token: state.first });
    const memories = Array.from({ length: 850 }, (_, index) => ({ id: `record-${index}`, date: '2024-01-01',
      text: 'x'.repeat(10000), createdAt: 1, updatedAt: 1, media: [] }));
    const snapshot = { format: 'ours-web-sync', version: 1, spaceId: 'ours-web', clock: [], memories };
    globalThis.fetch = async (url, options) => {
      state.calls.push({ origin: new URL(url).origin, method: options.method });
      return new Response(JSON.stringify({ revision: '1', snapshot }), { status: 200, headers: { etag: '"1"' } });
    };
    await controller.run();
    const local = await storage.readLocal();
    return state.calls.length === 1 && state.calls[0].method === 'GET' && !local.baseline && !local.pending &&
      local.memories.length === 0 && state.messages.at(-1).includes('备份上限') && state.messages.at(-1).includes('导出');
  });
  check(result, 'Oversized merged data was published or the capacity warning was lost.');
});
