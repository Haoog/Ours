import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataRoot = join(root, 'data');
const serverFile = join(root, 'server.js');
const maxBytes = 16 * 1024 * 1024;
const allowedOrigin = 'http://127.0.0.1:5173';

function newCredential() {
  return randomBytes(32).toString('base64url');
}

function environment(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OURS_SYNC_')));
  return { ...env, OURS_SYNC_PORT: '0', ...extra };
}

function runUntilExit(extra) {
  return spawnSync(process.execPath, [serverFile], {
    cwd: root,
    env: environment(extra),
    encoding: 'utf8',
    timeout: 5000,
  });
}

function launch(extra) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: environment(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start in time')), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /Ours sync listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before becoming ready (${code})`));
    });
  });
  return {
    child, done, ready,
    output: () => stdout + stderr,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return done;
    },
  };
}

function rawRequest(base, { method = 'GET', path = '/v1/snapshot', headers = {}, body }) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openSocket(base) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}

function waitForClose(socket, timeout) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return resolve();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Server did not close the connection in time'));
    }, timeout);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('local snapshot API', { timeout: 60_000 }, async (t) => {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataDir = await mkdtemp(join(dataRoot, 'test-'));
  const slot = basename(dataDir);
  const token = newCredential();
  const settings = { OURS_SYNC_TOKEN: token, OURS_SYNC_DATA_SLOT: slot, OURS_SYNC_ALLOWED_ORIGINS: allowedOrigin };
  const processes = [];
  let server;
  let base;
  let revision;
  let lastSnapshot;
  const authorization = `Bearer ${token}`;

  async function start() {
    server = launch(settings);
    processes.push(server);
    base = await server.ready;
  }
  async function get(extra = {}) {
    return fetch(`${base}/v1/snapshot`, { headers: { Authorization: authorization, ...extra } });
  }
  async function put(body, etag = revision, extra = {}) {
    return fetch(`${base}/v1/snapshot`, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': etag, ...extra },
      body,
    });
  }
  t.after(async () => {
    for (const process of processes) {
      await process.stop().catch(() => {});
      assert.equal(process.output().includes(token), false, 'credentials must not appear in process output');
    }
    await chmod(dataDir, 0o700).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  await t.test('requires explicit strong credentials and valid configuration', () => {
    const missing = runUntilExit({ OURS_SYNC_DATA_SLOT: slot });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /OURS_SYNC_TOKEN/);
    const weak = Buffer.alloc(32).toString('base64url');
    const result = runUntilExit({ ...settings, OURS_SYNC_TOKEN: weak });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(weak), false);
    assert.equal(runUntilExit({ ...settings, OURS_SYNC_DATA_SLOT: '../outside' }).status, 1);
    assert.equal(runUntilExit({ ...settings, OURS_SYNC_ALLOWED_ORIGINS: '*' }).status, 1);
  });

  await start();

  await t.test('rejects absent, incorrect, duplicate, and malformed authorization', async () => {
    const absent = await fetch(`${base}/v1/snapshot`);
    assert.equal(absent.status, 401);
    assert.equal(absent.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await absent.json(), { error: 'unauthorized' });
    assert.equal((await get({ Authorization: `Bearer ${newCredential()}` })).status, 401);
    assert.equal((await get({ Authorization: `bearer ${token}` })).status, 401);
    const duplicate = await rawRequest(base, {
      headers: ['Host', new URL(base).host, 'Authorization', authorization, 'Authorization', authorization],
    });
    assert.equal(duplicate.status, 401);
  });

  await t.test('starts with a null snapshot and rejects unconditional or unknown writes', async () => {
    const initial = await get();
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await initial.json(), { revision: '0', snapshot: null });
    revision = initial.headers.get('etag');
    assert.equal(revision, '"0"');

    const missing = await fetch(`${base}/v1/snapshot`, {
      method: 'PUT', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(missing.status, 428);
    assert.equal((await put('{}', '*')).status, 400);
    assert.equal((await put('{}', 'W/"0"')).status, 400);
    const unknown = await put('{}', `"${randomUUID()}"`);
    assert.equal(unknown.status, 412);
    assert.equal(unknown.headers.get('etag'), '"0"');
    assert.deepEqual(await unknown.json(), { error: 'revision_conflict', revision: '0' });
    assert.deepEqual(await (await get()).json(), { revision: '0', snapshot: null });
  });

  await t.test('stores arbitrary JSON without changing its number representation', async () => {
    lastSnapshot = '{"large":9007199254740993123456789,"items":[null,true,"x"]}';
    const updated = await put(lastSnapshot);
    assert.equal(updated.status, 200);
    revision = updated.headers.get('etag');
    assert.match(revision, /^"[0-9a-f-]{36}"$/);
    assert.ok((await updated.text()).includes(lastSnapshot));
    const current = await get();
    assert.equal(current.headers.get('etag'), revision);
    assert.ok((await current.text()).includes(lastSnapshot));
    assert.ok((await readFile(join(dataDir, 'snapshot.json'), 'utf8')).includes(lastSnapshot));

    const stale = await put('{"replace":true}', '"0"');
    assert.equal(stale.status, 412);
    assert.equal(stale.headers.get('etag'), revision);
    assert.ok((await (await get()).text()).includes(lastSnapshot));
  });

  await t.test('only one simultaneous write from the same revision succeeds', async () => {
    const candidates = ['{"candidate":1}', '{"candidate":2}'];
    const results = await Promise.all(candidates.map((body) => put(body, revision)));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 412]);
    const winner = results.findIndex((result) => result.status === 200);
    const updated = results[winner];
    revision = updated.headers.get('etag');
    lastSnapshot = candidates[winner];
    assert.equal(results[1 - winner].headers.get('etag'), revision);
    assert.ok((await (await get()).text()).includes(lastSnapshot));
  });

  await t.test('validates media type, UTF-8, JSON, paths, and methods', async () => {
    assert.equal((await put('{}', revision, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await put('{}', revision, { 'Content-Encoding': 'gzip' })).status, 415);
    const invalidJson = await put('{');
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error, 'invalid_json');
    const invalidUtf8 = await put(Buffer.from([0xff]));
    assert.equal(invalidUtf8.status, 400);
    assert.equal((await invalidUtf8.json()).error, 'invalid_utf8');
    assert.equal((await fetch(`${base}/v1/snapshot?path=anything`, { headers: { Authorization: authorization } })).status, 404);
    assert.equal((await fetch(`${base}/v1/snapshot`, { method: 'DELETE', headers: { Authorization: authorization } })).status, 405);
    assert.ok((await (await get()).text()).includes(lastSnapshot));
  });

  await t.test('accepts exactly 16 MiB and rejects larger content-length and chunked snapshots', async () => {
    const headers = {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'If-Match': revision,
    };
    // Use a real 16 MiB JSON value with a multibyte UTF-8 character.
    const exact = Buffer.alloc(maxBytes, 0x78);
    exact[0] = 0x22;
    exact[exact.length - 1] = 0x22;
    exact.write('琴', 1, 'utf8');
    assert.equal(exact.length, 16_777_216);

    const tooLong = await rawRequest(base, { method: 'PUT', headers: { ...headers, 'Content-Length': String(maxBytes + 1) } });
    assert.equal(tooLong.status, 413);
    assert.deepEqual(JSON.parse(tooLong.body), { error: 'payload_too_large' });
    const oversized = Buffer.concat([exact, Buffer.from(' ')]);
    const chunked = await rawRequest(base, {
      method: 'PUT', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, body: oversized,
    });
    assert.equal(chunked.status, 413);
    assert.deepEqual(JSON.parse(chunked.body), { error: 'payload_too_large' });
    const unchanged = await get();
    assert.equal(unchanged.headers.get('etag'), revision);
    assert.ok((await unchanged.text()).includes(lastSnapshot));

    async function checkEnvelope(response, etag) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), etag);
      const bytes = Buffer.from(await response.arrayBuffer());
      const prefix = Buffer.from(`{"revision":${etag},"snapshot":`);
      assert.equal(prefix.length + 1, 63);
      assert.equal(bytes.length, maxBytes + 63);
      assert.ok(bytes.subarray(0, prefix.length).equals(prefix));
      assert.ok(bytes.subarray(prefix.length, -1).equals(exact));
      assert.equal(bytes.at(-1), 0x7d);
    }

    const accepted = await put(exact);
    assert.equal(accepted.status, 200);
    revision = accepted.headers.get('etag');
    assert.match(revision, /^"[0-9a-f-]{36}"$/);
    await checkEnvelope(accepted, revision);
    await checkEnvelope(await get(), revision);

    assert.deepEqual(await server.stop(), { code: 0, signal: null });
    await start();
    await checkEnvelope(await get(), revision);

    const chunkedAccepted = await fetch(`${base}/v1/snapshot`, {
      method: 'PUT',
      headers: { ...headers, 'If-Match': revision },
      body: Readable.from([exact.subarray(0, maxBytes / 2), exact.subarray(maxBytes / 2)]),
      duplex: 'half',
    });
    assert.equal(chunkedAccepted.status, 200);
    revision = chunkedAccepted.headers.get('etag');
    assert.match(revision, /^"[0-9a-f-]{36}"$/);
    await checkEnvelope(chunkedAccepted, revision);
    await checkEnvelope(await get(), revision);

    const reset = await put('{"after_limit":true}');
    assert.equal(reset.status, 200);
    revision = reset.headers.get('etag');
    lastSnapshot = '{"after_limit":true}';
  });

  await t.test('holds a write slot while a large snapshot response is stalled', { timeout: 10_000 }, async (subtest) => {
    const snapshot = Buffer.alloc(maxBytes, 0x78);
    snapshot[0] = 0x22;
    snapshot[snapshot.length - 1] = 0x22;
    const url = new URL(base);
    const req = httpRequest({
      hostname: url.hostname, port: url.port, method: 'PUT', path: '/v1/snapshot',
      headers: {
        Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': revision,
        'Content-Length': String(snapshot.length),
      },
    });
    req.on('error', () => {});
    subtest.after(() => req.destroy());
    const pendingResponse = once(req, 'response');
    req.end(snapshot);
    const [stalled] = await pendingResponse;
    assert.equal(stalled.statusCode, 200);
    revision = stalled.headers.etag;
    assert.match(revision, /^"[0-9a-f-]{36}"$/);
    // Leave the 16 MiB response unread so the server cannot finish writing it.
    stalled.pause();
    subtest.after(() => stalled.destroy());

    const sockets = [];
    subtest.after(() => { for (const socket of sockets) socket.destroy(); });
    for (let index = 0; index < 3; index++) {
      const socket = await openSocket(base);
      sockets.push(socket);
      socket.write(`PUT /v1/media/${String(index).repeat(64)} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${authorization}\r\nContent-Length: 2\r\n\r\nx`);
    }
    const mediaDir = join(dataDir, 'media');
    const temporaryFiles = async () => (await readdir(mediaDir)).filter((name) => name.startsWith('.upload-'));
    await waitUntil(async () => (await temporaryFiles()).length === 3, 'three active media uploads');
    const busy = await put('{}', revision);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '1');
    assert.deepEqual(await busy.json(), { error: 'server_busy' });

    stalled.destroy();
    await waitUntil(async () => {
      const retried = await put('{"after_slow_write":true}', revision);
      if (retried.status === 503) {
        await retried.arrayBuffer();
        return false;
      }
      assert.equal(retried.status, 200);
      revision = retried.headers.get('etag');
      await retried.arrayBuffer();
      return true;
    }, 'stalled response to release its write slot');
    for (const socket of sockets) socket.destroy();
    await waitUntil(async () => (await temporaryFiles()).length === 0, 'interrupted media upload cleanup');
    lastSnapshot = '{"after_slow_write":true}';
  });

  await t.test('bounds pipelining and closes a stalled snapshot connection', async (subtest) => {
    const largeSnapshot = `"${'x'.repeat(maxBytes - 2)}"`;
    const written = await put(largeSnapshot);
    assert.equal(written.status, 200);
    revision = written.headers.get('etag');
    await written.arrayBuffer();

    const host = new URL(base).host;
    const request = `GET /v1/snapshot HTTP/1.1\r\nHost: ${host}\r\nAuthorization: ${authorization}\r\n\r\n`;
    const pipelined = await openSocket(base);
    subtest.after(() => pipelined.destroy());
    const pipelineClosed = waitForClose(pipelined, 3000);
    pipelined.write(request.repeat(8));
    pipelined.resume();
    await pipelineClosed;
    let healthy = await get();
    assert.equal(healthy.status, 200);
    await healthy.arrayBuffer();

    // Do not read a near-limit response until the absolute response deadline has passed.
    const stalled = await openSocket(base);
    subtest.after(() => stalled.destroy());
    const stalledClosed = waitForClose(stalled, 20_000);
    stalled.pause();
    stalled.write(request);
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    stalled.resume();
    await stalledClosed;
    healthy = await get();
    assert.equal(healthy.status, 200);
    await healthy.arrayBuffer();

    const reset = await put('{"after_connection_checks":true}');
    assert.equal(reset.status, 200);
    revision = reset.headers.get('etag');
    lastSnapshot = '{"after_connection_checks":true}';
  });

  await t.test('permits only configured origins and a narrowly scoped preflight', async () => {
    const preflight = await fetch(`${base}/v1/snapshot`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type, if-match',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /If-Match/);
    const allowed = await get({ Origin: allowedOrigin });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-expose-headers'), 'ETag');
    const denied = await get({ Origin: 'http://127.0.0.1:5174' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const badPreflight = await fetch(`${base}/v1/snapshot`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, x-unapproved',
      },
    });
    assert.equal(badPreflight.status, 403);
    const unauthenticated = await fetch(`${base}/v1/snapshot`, { headers: { Origin: allowedOrigin } });
    assert.equal(unauthenticated.status, 401);
  });

  await t.test('rejects a second process using the same data slot', async () => {
    const second = runUntilExit(settings);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /locked/);
    assert.equal(second.stderr.includes(token), false);
    assert.equal((await get()).status, 200);
  });

  await t.test('failed disk writes do not advance the revision', async (subtest) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      subtest.skip('POSIX permission failure cannot be reliably simulated');
      return;
    }
    await chmod(dataDir, 0o500);
    try {
      const failed = await put('{"should_not_persist":true}');
      assert.equal(failed.status, 500);
    } finally {
      await chmod(dataDir, 0o700);
    }
    const current = await get();
    assert.equal(current.headers.get('etag'), revision);
    assert.ok((await current.text()).includes(lastSnapshot));
  });

  await t.test('survives clean and forced restarts without losing the snapshot', async () => {
    assert.deepEqual(await server.stop(), { code: 0, signal: null });
    await start();
    let current = await get();
    assert.equal(current.headers.get('etag'), revision);
    assert.ok((await current.text()).includes(lastSnapshot));

    assert.equal((await server.stop('SIGKILL')).signal, 'SIGKILL');
    const locked = runUntilExit(settings);
    assert.equal(locked.status, 1);
    assert.match(locked.stderr, /locked/);
    await unlink(join(dataDir, '.lock'));
    await start();
    current = await get();
    assert.equal(current.headers.get('etag'), revision);
    assert.ok((await current.text()).includes(lastSnapshot));
    assert.deepEqual(await server.stop(), { code: 0, signal: null });
  });

  await t.test('refuses to silently reset corrupt on-disk data', async () => {
    await writeFile(join(dataDir, 'snapshot.json'), '{bad json', { mode: 0o600 });
    const corrupt = runUntilExit(settings);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /refusing to reset/);
    assert.equal(await readFile(join(dataDir, 'snapshot.json'), 'utf8'), '{bad json');
  });

  await t.test('refuses an on-disk snapshot one byte over the limit without changing it', async () => {
    const snapshot = Buffer.alloc(maxBytes + 1, 0x78);
    snapshot[0] = 0x22;
    snapshot[snapshot.length - 1] = 0x22;
    const stored = Buffer.concat([
      Buffer.from(`{"revision":${revision},"snapshot":`), snapshot, Buffer.from('}'),
    ]);
    const snapshotPath = join(dataDir, 'snapshot.json');
    await writeFile(snapshotPath, stored, { mode: 0o600 });
    const oversized = runUntilExit(settings);
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /refusing to reset/);
    assert.ok((await readFile(snapshotPath)).equals(stored));
  });
});

const mediaLimit = 100 * 1024 * 1024;
const mediaChunk = Buffer.alloc(64 * 1024, 0x61);

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestOfRepeatedChunk(size) {
  const hash = createHash('sha256');
  for (let remaining = size; remaining > 0; remaining -= Math.min(remaining, mediaChunk.length)) {
    hash.update(mediaChunk.subarray(0, Math.min(remaining, mediaChunk.length)));
  }
  return hash.digest('hex');
}

function streamMediaUpload(base, path, authorization, size, chunked = false) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = httpRequest({
      hostname: url.hostname, port: url.port, method: 'PUT', path,
      headers: {
        Authorization: authorization,
        ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': String(size) }),
      },
    }, (res) => {
      responded = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', (error) => { if (!responded) reject(error); });
    void (async () => {
      for (let remaining = size; remaining > 0;) {
        const part = mediaChunk.subarray(0, Math.min(remaining, mediaChunk.length));
        remaining -= part.length;
        if (!req.write(part)) await once(req, 'drain');
      }
      req.end();
    })().catch((error) => { if (!responded) reject(error); });
  });
}

function streamMediaDownload(base, path, authorization) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, headers: { Authorization: authorization } }, (res) => {
      let size = 0;
      const hash = createHash('sha256');
      res.on('data', (chunk) => { size += chunk.length; hash.update(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, size, digest: hash.digest('hex') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitUntil(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('local content-addressed media API', { timeout: 120_000 }, async (t) => {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataDir = await mkdtemp(join(dataRoot, 'test-media-'));
  const mediaDir = join(dataDir, 'media');
  const token = newCredential();
  const authorization = `Bearer ${token}`;
  const settings = {
    OURS_SYNC_TOKEN: token, OURS_SYNC_DATA_SLOT: basename(dataDir), OURS_SYNC_ALLOWED_ORIGINS: allowedOrigin,
  };
  const processes = [];
  let server;
  let base;
  const sample = Buffer.from([0x00, 0xff, 0xd8, 0x37, 0x80, 0x00, 0x42]);
  const digest = digestOf(sample);
  const path = (hash) => `/v1/media/${hash}`;
  const temporaryFiles = async () => (await readdir(mediaDir)).filter((name) => name.startsWith('.upload-'));
  async function start() {
    server = launch(settings);
    processes.push(server);
    base = await server.ready;
  }
  async function getMedia(hash, headers = {}) {
    return fetch(`${base}${path(hash)}`, { headers: { Authorization: authorization, ...headers } });
  }
  async function putMedia(hash, body, headers = {}) {
    return fetch(`${base}${path(hash)}`, { method: 'PUT', headers: { Authorization: authorization, ...headers }, body });
  }
  t.after(async () => {
    for (const process of processes) {
      await process.stop().catch(() => {});
      assert.equal(process.output().includes(token), false, 'credentials must not appear in process output');
    }
    await chmod(mediaDir, 0o700).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });

  await start();

  await t.test('uploads and downloads exact bytes with private permissions', async () => {
    const uploaded = await putMedia(digest.toUpperCase(), sample, { 'Content-Type': 'image/jpeg' });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.headers.get('etag'), `"${digest}"`);
    assert.equal(await uploaded.text(), '');
    const downloaded = await getMedia(digest);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
    assert.equal(downloaded.headers.get('content-disposition'), 'attachment');
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    assert.equal(downloaded.headers.get('content-length'), String(sample.length));
    assert.equal(downloaded.headers.get('etag'), `"${digest}"`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), sample);
    assert.equal((await lstat(mediaDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(mediaDir, digest))).mode & 0o777, 0o600);
    assert.deepEqual(await temporaryFiles(), []);

    const emptyDigest = digestOf(Buffer.alloc(0));
    assert.equal((await putMedia(emptyDigest, Buffer.alloc(0))).status, 201);
    assert.equal((await (await getMedia(emptyDigest)).arrayBuffer()).byteLength, 0);
  });

  await t.test('checks every body hash, including when a file already exists', async () => {
    const wrong = digestOf(Buffer.from('different media'));
    const rejected = await putMedia(wrong, sample);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'hash_mismatch' });
    assert.equal((await getMedia(wrong)).status, 404);
    assert.equal((await putMedia(digest, Buffer.from('wrong body'))).status, 400);
    assert.deepEqual(Buffer.from(await (await getMedia(digest)).arrayBuffer()), sample);
    assert.deepEqual(await temporaryFiles(), []);
  });

  await t.test('protects authorization, CORS, routes, and unencoded request bodies', async () => {
    assert.equal((await fetch(`${base}${path(digest)}`)).status, 401);
    assert.equal((await fetch(`${base}${path(digest)}`, { method: 'PUT', body: sample })).status, 401);
    assert.equal((await getMedia(digest, { Authorization: `Bearer ${newCredential()}` })).status, 401);
    const duplicateAuth = await rawRequest(base, {
      path: path(digest),
      headers: ['Host', new URL(base).host, 'Authorization', authorization, 'Authorization', authorization],
    });
    assert.equal(duplicateAuth.status, 401);
    assert.equal((await putMedia(digest, sample, { 'Content-Encoding': 'gzip' })).status, 415);
    assert.equal((await fetch(`${base}${path(digest)}`, { method: 'DELETE', headers: { Authorization: authorization } })).status, 405);
    for (const invalidPath of [
      `${path(digest)}?x=1`, path('a'.repeat(63)), path('g'.repeat(64)),
      '/v1/media/../../snapshot.json', '/v1/media/%2e%2e%2fsnapshot.json', `${path(digest)}/extra`,
    ]) {
      assert.equal((await rawRequest(base, { path: invalidPath, headers: { Authorization: authorization } })).status, 404);
    }
    const preflight = await fetch(`${base}${path(digest)}`, {
      method: 'OPTIONS', headers: {
        Origin: allowedOrigin, 'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type, if-match',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    const allowed = await getMedia(digest, { Origin: allowedOrigin });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-expose-headers'), 'ETag');
    await allowed.arrayBuffer();
    const denied = await getMedia(digest, { Origin: 'http://127.0.0.1:5174' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const unauthorized = await fetch(`${base}${path(digest)}`, { headers: { Origin: allowedOrigin } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), allowedOrigin);
    const badPreflight = await fetch(`${base}${path(digest)}`, {
      method: 'OPTIONS', headers: {
        Origin: allowedOrigin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-extra',
      },
    });
    assert.equal(badPreflight.status, 403);
  });

  await t.test('makes duplicates idempotent and concurrent commits non-overwriting', async () => {
    assert.equal((await putMedia(digest, sample)).status, 200);
    const content = randomBytes(256 * 1024);
    const hash = digestOf(content);
    const responses = await Promise.all(Array.from({ length: 4 }, () => putMedia(hash, content)));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 200).length, 3);
    assert.deepEqual(Buffer.from(await (await getMedia(hash)).arrayBuffer()), content);
    assert.deepEqual(await temporaryFiles(), []);
  });

  await t.test('shares four write slots across snapshots and media, then releases them', { timeout: 10_000 }, async (subtest) => {
    const initial = await fetch(`${base}/v1/snapshot`, { headers: { Authorization: authorization } });
    const revision = initial.headers.get('etag');
    assert.equal(revision, '"0"');
    await initial.arrayBuffer();

    // Keep two media requests open; their temporary files prove both occupy a slot.
    const sockets = await Promise.all([openSocket(base), openSocket(base)]);
    subtest.after(() => { for (const socket of sockets) socket.destroy(); });
    for (const [index, socket] of sockets.entries()) {
      socket.write(`PUT ${path(String(index).repeat(64))} HTTP/1.1\r\nHost: ${new URL(base).host}\r\nAuthorization: ${authorization}\r\nContent-Length: 2\r\n\r\nx`);
    }
    await waitUntil(async () => (await temporaryFiles()).length === 2, 'two active media uploads');

    async function holdSnapshot() {
      const url = new URL(base);
      const req = httpRequest({
        hostname: url.hostname, port: url.port, method: 'PUT', path: '/v1/snapshot',
        headers: {
          Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': revision,
          'Content-Length': '2', Expect: '100-continue',
        },
      });
      subtest.after(() => req.destroy());
      const response = new Promise((resolve, reject) => {
        req.once('response', resolve);
        req.once('error', reject);
      });
      response.catch(() => {});
      const continued = once(req, 'continue');
      req.flushHeaders();
      await continued;
      req.write('{');
      return { req, response };
    }

    // A 100 Continue handshake ensures the server has begun handling each request.
    const held = [await holdSnapshot(), await holdSnapshot()];
    const busySnapshot = await rawRequest(base, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': revision, Origin: allowedOrigin },
      body: '{}',
    });
    assert.equal(busySnapshot.status, 503);
    assert.equal(busySnapshot.headers['retry-after'], '1');
    assert.equal(busySnapshot.headers['access-control-allow-origin'], allowedOrigin);
    assert.equal(busySnapshot.headers['access-control-expose-headers'], 'ETag');
    assert.deepEqual(JSON.parse(busySnapshot.body), { error: 'server_busy' });
    const busyMedia = await putMedia(digest, sample, { Origin: allowedOrigin });
    assert.equal(busyMedia.status, 503);
    assert.equal(busyMedia.headers.get('retry-after'), '1');
    assert.equal(busyMedia.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.equal(busyMedia.headers.get('access-control-expose-headers'), 'ETag');
    assert.deepEqual(await busyMedia.json(), { error: 'server_busy' });
    const readable = await fetch(`${base}/v1/snapshot`, { headers: { Authorization: authorization } });
    assert.equal(readable.status, 200);
    assert.equal(readable.headers.get('etag'), revision);
    await readable.arrayBuffer();

    held[0].req.end('}');
    const completed = await held[0].response;
    assert.equal(completed.statusCode, 200);
    const updatedRevision = completed.headers.etag;
    completed.resume();
    await once(completed, 'end');
    assert.notEqual(updatedRevision, revision);

    // A completed snapshot releases a slot for a media write.
    const retriedMedia = await putMedia(digest, sample);
    assert.equal(retriedMedia.status, 200);
    assert.equal(retriedMedia.headers.get('etag'), `"${digest}"`);
    await retriedMedia.arrayBuffer();

    // The other held snapshot still has its original ETag and must conflict.
    held[1].req.end('}');
    const conflict = await held[1].response;
    assert.equal(conflict.statusCode, 412);
    assert.equal(conflict.headers.etag, updatedRevision);
    conflict.resume();
    await once(conflict, 'end');
    for (const socket of sockets) socket.destroy();
    await waitUntil(async () => (await temporaryFiles()).length === 0, 'interrupted media upload cleanup');
    const after = await fetch(`${base}/v1/snapshot`, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'If-Match': updatedRevision },
      body: '{"after_busy":true}',
    });
    assert.equal(after.status, 200);
    await after.arrayBuffer();
  });

  await t.test('rejects unsafe or corrupted existing files without replacing them', async () => {
    const content = Buffer.from('right content');
    const hash = digestOf(content);
    const corrupt = Buffer.from('wrong content');
    assert.equal(corrupt.length, content.length);
    await writeFile(join(mediaDir, hash), corrupt, { mode: 0o600 });
    assert.equal((await putMedia(hash, content)).status, 500);
    assert.deepEqual(await readFile(join(mediaDir, hash)), corrupt);

    const external = Buffer.from('private outside the media directory');
    const externalPath = join(dataDir, 'outside-private');
    const symlinkHash = digestOf(external);
    await writeFile(externalPath, external, { mode: 0o600 });
    await symlink(externalPath, join(mediaDir, symlinkHash));
    assert.equal((await getMedia(symlinkHash)).status, 500);
    assert.equal((await putMedia(symlinkHash, external)).status, 500);
    assert.equal((await lstat(join(mediaDir, symlinkHash))).isSymbolicLink(), true);
    assert.deepEqual(await readFile(externalPath), external);

    await chmod(join(mediaDir, digest), 0o644);
    try {
      assert.equal((await getMedia(digest)).status, 500);
      assert.equal((await putMedia(digest, sample)).status, 500);
    } finally {
      await chmod(join(mediaDir, digest), 0o600);
    }
    assert.deepEqual(await temporaryFiles(), []);
  });

  await t.test('removes a partially uploaded file when the client disconnects', async (subtest) => {
    const hash = digestOf(Buffer.alloc(1024 * 1024, 0x69));
    const socket = await openSocket(base);
    subtest.after(() => socket.destroy());
    socket.write(`PUT ${path(hash)} HTTP/1.1\r\nHost: ${new URL(base).host}\r\nAuthorization: ${authorization}\r\nContent-Length: 1048576\r\n\r\n`);
    socket.write(Buffer.alloc(4096, 0x69));
    await waitUntil(async () => (await temporaryFiles()).length === 1, 'upload temporary file');
    const [temporary] = await temporaryFiles();
    assert.equal((await lstat(join(mediaDir, temporary))).mode & 0o777, 0o600);
    socket.destroy();
    await waitUntil(async () => (await temporaryFiles()).length === 0, 'interrupted upload cleanup');
    assert.equal((await getMedia(hash)).status, 404);
  });

  await t.test('allows a media upload to outlast the snapshot deadline', { timeout: 25_000 }, async () => {
    const content = Buffer.from('slow media transfer');
    const hash = digestOf(content);
    const url = new URL(base);
    const result = new Promise((resolve) => {
      const req = httpRequest({
        hostname: url.hostname, port: url.port, method: 'PUT', path: path(hash),
        headers: { Authorization: authorization, 'Content-Length': String(content.length) },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
        res.on('error', (error) => resolve({ error: error.code }));
      });
      req.on('error', (error) => resolve({ error: error.code }));
      req.write(content.subarray(0, 1));
      setTimeout(() => req.end(content.subarray(1)), 16_000);
    });
    assert.deepEqual(await result, { status: 201 });
    assert.deepEqual(Buffer.from(await (await getMedia(hash)).arrayBuffer()), content);
  });

  await t.test('accepts exactly 100 MiB and rejects oversized declared and chunked bodies', { timeout: 90_000 }, async () => {
    const tooLong = await rawRequest(base, {
      method: 'PUT', path: path('a'.repeat(64)),
      headers: { Authorization: authorization, 'Content-Length': String(mediaLimit + 1) },
    });
    assert.equal(tooLong.status, 413);
    assert.deepEqual(await temporaryFiles(), []);

    const hash = digestOfRepeatedChunk(mediaLimit);
    const uploaded = await streamMediaUpload(base, path(hash), authorization, mediaLimit);
    assert.equal(uploaded.status, 201);
    assert.deepEqual(await streamMediaDownload(base, path(hash), authorization), { status: 200, size: mediaLimit, digest: hash });
    const partialDownload = await getMedia(hash);
    const reader = partialDownload.body.getReader();
    assert.ok((await reader.read()).value.length > 0);
    await reader.cancel();
    assert.deepEqual(Buffer.from(await (await getMedia(digest)).arrayBuffer()), sample);

    const chunked = await streamMediaUpload(base, path('b'.repeat(64)), authorization, mediaLimit + 1, true);
    assert.equal(chunked.status, 413);
    assert.deepEqual(JSON.parse(chunked.body), { error: 'payload_too_large' });
    assert.equal((await getMedia('b'.repeat(64))).status, 404);
    assert.deepEqual(await temporaryFiles(), []);
  });

  await t.test('survives clean and forced restart and removes abandoned temporary uploads', async (subtest) => {
    assert.deepEqual(await server.stop(), { code: 0, signal: null });
    await start();
    assert.deepEqual(Buffer.from(await (await getMedia(digest)).arrayBuffer()), sample);

    const interruptedDigest = digestOf(Buffer.alloc(1024 * 1024, 0x7a));
    const socket = await openSocket(base);
    subtest.after(() => socket.destroy());
    socket.write(`PUT ${path(interruptedDigest)} HTTP/1.1\r\nHost: ${new URL(base).host}\r\nAuthorization: ${authorization}\r\nContent-Length: 1048576\r\n\r\n`);
    socket.write(Buffer.alloc(4096, 0x7a));
    await waitUntil(async () => (await temporaryFiles()).length === 1, 'temporary file before forced stop');
    assert.equal((await server.stop('SIGKILL')).signal, 'SIGKILL');
    socket.destroy();
    assert.equal((await temporaryFiles()).length, 1);
    assert.equal(runUntilExit(settings).status, 1);
    await unlink(join(dataDir, '.lock'));
    await start();
    assert.deepEqual(await temporaryFiles(), []);
    assert.equal((await getMedia(interruptedDigest)).status, 404);
    assert.deepEqual(Buffer.from(await (await getMedia(digest)).arrayBuffer()), sample);
    assert.deepEqual(await server.stop(), { code: 0, signal: null });

    await chmod(mediaDir, 0o755);
    const unsafe = runUntilExit(settings);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /accessible only to their owner/);
    await chmod(mediaDir, 0o700);
  });
});
