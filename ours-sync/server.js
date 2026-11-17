import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, mkdir, lstat, readFile, rename, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(ROOT, 'data');
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVE_WRITES = 4;
const RESPONSE_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 60 * 60 * 1000;
const MEDIA_IDLE_TIMEOUT_MS = 60_000;
const MEDIA_PATH_PATTERN = /^\/v1\/media\/([0-9a-f]{64})$/i;
const MEDIA_TEMP_PATTERN = /^\.upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const REVISION_PATTERN = '(?:0|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const IF_MATCH_PATTERN = new RegExp(`^"(${REVISION_PATTERN})"$`);
const STORED_PREFIX_PATTERN = new RegExp(`^\\{"revision":"(${REVISION_PATTERN})","snapshot":`);
const decoder = new TextDecoder('utf-8', { fatal: true });

class StartupError extends Error {}
class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function loadConfig() {
  if (process.platform === 'win32') {
    throw new StartupError('This service requires POSIX file permissions and is not supported on native Windows.');
  }
  const token = process.env.OURS_SYNC_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      Buffer.from(token, 'base64url').length !== 32 ||
      Buffer.from(token, 'base64url').toString('base64url') !== token ||
      new Set(token).size < 16) {
    throw new StartupError('Set OURS_SYNC_TOKEN to a freshly generated, 32-byte random base64url credential.');
  }

  const portText = process.env.OURS_SYNC_PORT ?? '8787';
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(portText) || Number(portText) > 65535) {
    throw new StartupError('OURS_SYNC_PORT must be an integer from 0 to 65535.');
  }

  const slot = process.env.OURS_SYNC_DATA_SLOT ?? 'default';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slot)) {
    throw new StartupError('OURS_SYNC_DATA_SLOT must contain 1–64 letters, digits, underscores, or hyphens.');
  }

  const origins = new Set();
  const originList = process.env.OURS_SYNC_ALLOWED_ORIGINS ?? '';
  for (const candidate of originList.split(',').map((item) => item.trim()).filter(Boolean)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new StartupError('OURS_SYNC_ALLOWED_ORIGINS contains an invalid origin.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== candidate ||
        url.username || url.password) {
      throw new StartupError('Allowed origins must be exact http(s) origins without paths or trailing slashes.');
    }
    origins.add(candidate);
  }

  return { token: Buffer.from(token, 'ascii'), port: Number(portText), slot, origins };
}

async function privateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new StartupError('Data directories must be real directories accessible only to their owner.');
  }
  // Persist the child's directory entry, even if a previous start created it.
  try {
    await syncDirectory(dirname(path));
  } catch {
    throw new StartupError('Data directory parent does not support the required synchronization.');
  }
}

async function cleanupAbandonedUploads(mediaDir) {
  let removed = false;
  const directory = await opendir(mediaDir);
  for await (const entry of directory) {
    if (MEDIA_TEMP_PATTERN.test(entry.name)) {
      await unlink(join(mediaDir, entry.name));
      removed = true;
    }
  }
  if (removed) await syncDirectory(mediaDir);
}

async function acquireLock(dataDir) {
  const lockPath = join(dataDir, '.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new StartupError('Data slot is locked; stop the other process or check for a stale lock.');
    }
    throw error;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.close();
  } catch (error) {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  return async () => { await unlink(lockPath).catch(() => {}); };
}

function validateSnapshot(raw) {
  try {
    JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function envelope(revision, snapshot) {
  return `{"revision":"${revision}","snapshot":${snapshot}}`;
}

async function syncDirectory(dataDir) {
  const directory = await open(dataDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function loadSnapshot(dataDir) {
  const path = join(dataDir, 'snapshot.json');
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: '0', snapshot: 'null' };
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_BODY_BYTES + 128 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new StartupError('Stored snapshot is invalid or its permissions are too broad.');
  }
  let contents;
  try {
    contents = decoder.decode(await readFile(path));
  } catch {
    throw new StartupError('Unable to read stored snapshot as UTF-8.');
  }
  const match = STORED_PREFIX_PATTERN.exec(contents);
  if (!match || match[1] === '0' || !contents.endsWith('}')) {
    throw new StartupError('Stored snapshot is invalid; refusing to reset it.');
  }
  const snapshot = contents.slice(match[0].length, -1);
  try {
    if (Buffer.byteLength(snapshot, 'utf8') > MAX_BODY_BYTES) throw new Error();
    validateSnapshot(snapshot);
  } catch {
    throw new StartupError('Stored snapshot is invalid; refusing to reset it.');
  }
  return { revision: match[1], snapshot };
}

async function storeSnapshot(dataDir, state, committed) {
  const tempPath = join(dataDir, `.snapshot-${randomUUID()}.tmp`);
  const snapshotPath = join(dataDir, 'snapshot.json');
  let file;
  let renamed = false;
  try {
    file = await open(tempPath, 'wx', 0o600);
    await file.writeFile(envelope(state.revision, state.snapshot), 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(tempPath, snapshotPath);
    renamed = true;
    // Rename is the commit point. Even if the following directory sync fails,
    // memory must agree with the new file and the client must reconcile a 500.
    committed();
    await syncDirectory(dataDir);
  } finally {
    if (file) await file.close().catch(() => {});
    if (!renamed) await unlink(tempPath).catch(() => {});
  }
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count;
}

function authenticate(request, expected) {
  if (headerCount(request, 'authorization') !== 1) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'ascii');
  return timingSafeEqual(supplied, expected);
}

function rejectUnexpectedBody(request) {
  if (request.headers['transfer-encoding'] ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
    throw new HttpError(400, 'unexpected_body');
  }
}

function receiveBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new HttpError(413, 'payload_too_large');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    request.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        chunks.length = 0;
        request.pause();
        reject(new HttpError(413, 'payload_too_large'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (!finished) {
        finished = true;
        resolve(Buffer.concat(chunks, size));
      }
    });
    request.on('aborted', () => {
      if (!finished) {
        finished = true;
        reject(new HttpError(400, 'request_aborted'));
      }
    });
    request.on('error', () => {
      if (!finished) {
        finished = true;
        reject(new HttpError(400, 'request_aborted'));
      }
    });
  });
}

function checkMediaLength(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_MEDIA_BYTES)) {
    throw new HttpError(413, 'payload_too_large');
  }
}

async function openMedia(mediaDir, digest) {
  let file;
  try {
    // Do not follow a substituted symlink or block on a special file.
    file = await open(join(mediaDir, digest), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_MEDIA_BYTES) {
      throw new Error('Invalid media file');
    }
    return { file, size: stat.size };
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (error.code === 'ENOENT') throw new HttpError(404, 'not_found');
    throw error;
  }
}

async function verifyExistingMedia(mediaDir, digest, expectedSize) {
  const { file, size } = await openMedia(mediaDir, digest);
  try {
    if (size !== expectedSize) throw new Error('Existing media has an unexpected size');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest('hex') !== digest) throw new Error('Existing media has an unexpected digest');
  } finally {
    await file.close();
  }
}

async function storeMedia(request, mediaDir, digest) {
  const tempPath = join(mediaDir, `.upload-${randomUUID()}.tmp`);
  const destination = join(mediaDir, digest);
  let file;
  let tempExists = false;
  try {
    file = await open(tempPath, 'wx', 0o600);
    tempExists = true;
    const hash = createHash('sha256');
    let size = 0;
    try {
      // Await each disk write before reading more data to keep memory bounded.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_MEDIA_BYTES) throw new HttpError(413, 'payload_too_large');
        hash.update(chunk);
        await file.writeFile(chunk);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (request.aborted || (request.destroyed && !request.complete)) {
        throw new HttpError(400, 'request_aborted');
      }
      throw error;
    }
    if (!request.complete || request.aborted) throw new HttpError(400, 'request_aborted');
    if (hash.digest('hex') !== digest) throw new HttpError(400, 'hash_mismatch');

    await file.sync();
    await file.close();
    file = undefined;
    let created = false;
    try {
      // A hard link atomically publishes the complete file without replacing an existing one.
      await link(tempPath, destination);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never treat an existing corrupt or unsafe file as a successful duplicate.
      await verifyExistingMedia(mediaDir, digest, size);
    }
    await unlink(tempPath);
    tempExists = false;
    await syncDirectory(mediaDir);
    return created;
  } finally {
    if (file) await file.close().catch(() => {});
    if (tempExists) await unlink(tempPath).catch(() => {});
  }
}

async function sendMedia(request, response, mediaDir, digest, cors) {
  const { file, size } = await openMedia(mediaDir, digest);
  try {
    response.writeHead(200, {
      ...cors,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'Content-Length': String(size),
      ETag: `"${digest}"`,
    });
    request.resume();
    await pipeline(file.createReadStream({ autoClose: false }), response);
  } finally {
    await file.close();
  }
}

function respond(request, response, status, body, headers = {}, close = false) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...(close ? { Connection: 'close' } : {}),
    ...headers,
  });
  if (close) {
    request.pause();
    response.once('finish', () => request.destroy());
  } else if (!request.readableEnded) {
    request.resume();
  }
  response.end(body);
}

async function waitForWriteResponse(response) {
  // Errors that have not produced a response must reach the outer error handler.
  if (!response.writableEnded || response.writableFinished || response.destroyed) return;
  await new Promise((resolve) => {
    const done = () => {
      response.off('finish', done);
      response.off('close', done);
      resolve();
    };
    response.once('finish', done);
    response.once('close', done);
  });
}

async function main() {
  const config = loadConfig();
  await privateDirectory(DATA_ROOT);
  const dataDir = join(DATA_ROOT, config.slot);
  await privateDirectory(dataDir);
  const releaseLock = await acquireLock(dataDir);

  try {
    const mediaDir = join(dataDir, 'media');
    await privateDirectory(mediaDir);
    await cleanupAbandonedUploads(mediaDir);
    try {
      await syncDirectory(dataDir);
      await syncDirectory(mediaDir);
    } catch {
      throw new StartupError('Data directory does not support the required synchronization.');
    }
    let current = await loadSnapshot(dataDir);
    let writeQueue = Promise.resolve();
    let activeWrites = 0;
    const inFlight = new Set();

    async function handle(request, response) {
      // A disconnected or malformed client must not crash the process.
      request.on('error', () => {});
      let cors = { Vary: 'Origin' };
      try {
        if (headerCount(request, 'origin') > 1) throw new HttpError(400, 'invalid_origin');
        const origin = request.headers.origin;
        if (origin !== undefined) {
          if (!config.origins.has(origin)) throw new HttpError(403, 'origin_not_allowed');
          cors = { ...cors, 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'ETag' };
        }

        const snapshotPath = request.url === '/v1/snapshot';
        const mediaPath = MEDIA_PATH_PATTERN.exec(request.url ?? '');
        if (request.method === 'OPTIONS' && (snapshotPath || mediaPath) && origin !== undefined &&
            request.headers['access-control-request-method'] !== undefined) {
          rejectUnexpectedBody(request);
          const requestedMethod = request.headers['access-control-request-method'];
          const requestedHeaders = (request.headers['access-control-request-headers'] ?? '')
            .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
          if (!['GET', 'PUT'].includes(requestedMethod) ||
              requestedHeaders.some((name) => !['authorization', 'content-type', 'if-match'].includes(name))) {
            throw new HttpError(403, 'preflight_not_allowed');
          }
          respond(request, response, 204, null, {
            ...cors,
            Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
            'Access-Control-Allow-Methods': 'GET, PUT',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
          });
          return;
        }

        if (!authenticate(request, config.token)) {
          throw new HttpError(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
        }
        if (!snapshotPath && !mediaPath) throw new HttpError(404, 'not_found');
        if (request.method === 'GET') {
          rejectUnexpectedBody(request);
          if (mediaPath) {
            await sendMedia(request, response, mediaDir, mediaPath[1].toLowerCase(), cors);
          } else {
            respond(request, response, 200, envelope(current.revision, current.snapshot), {
              ...cors, ETag: `"${current.revision}"`,
            });
          }
          return;
        }
        if (request.method !== 'PUT') {
          throw new HttpError(405, 'method_not_allowed', { Allow: 'GET, PUT, OPTIONS' });
        }
        if (mediaPath) {
          if (request.headers['content-encoding'] !== undefined) {
            throw new HttpError(415, 'unsupported_media_type');
          }
          checkMediaLength(request);
          if (activeWrites >= MAX_ACTIVE_WRITES) {
            throw new HttpError(503, 'server_busy', { 'Retry-After': '1' });
          }
          activeWrites++;
          try {
            const digest = mediaPath[1].toLowerCase();
            const created = await storeMedia(request, mediaDir, digest);
            respond(request, response, created ? 201 : 200, null, { ...cors, ETag: `"${digest}"` });
          } finally {
            await waitForWriteResponse(response);
            activeWrites--;
          }
          return;
        }
        if (headerCount(request, 'if-match') === 0) throw new HttpError(428, 'precondition_required');
        if (headerCount(request, 'if-match') !== 1) throw new HttpError(400, 'invalid_if_match');
        const condition = IF_MATCH_PATTERN.exec(request.headers['if-match'] ?? '');
        if (!condition) throw new HttpError(400, 'invalid_if_match');
        if (headerCount(request, 'content-type') !== 1 ||
            !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers['content-type'] ?? '') ||
            request.headers['content-encoding'] !== undefined) {
          throw new HttpError(415, 'unsupported_media_type');
        }
        if (activeWrites >= MAX_ACTIVE_WRITES) {
          throw new HttpError(503, 'server_busy', { 'Retry-After': '1' });
        }
        activeWrites++;
        try {
          const bytes = await receiveBody(request);
          let snapshot;
          try {
            snapshot = decoder.decode(bytes);
          } catch {
            throw new HttpError(400, 'invalid_utf8');
          }
          validateSnapshot(snapshot);
          const operation = writeQueue.then(async () => {
            if (condition[1] !== current.revision) {
              return { conflict: true, revision: current.revision };
            }
            const next = { revision: randomUUID(), snapshot };
            await storeSnapshot(dataDir, next, () => { current = next; });
            return { conflict: false, ...next };
          });
          writeQueue = operation.catch(() => {});
          const result = await operation;
          if (result.conflict) {
            respond(request, response, 412, JSON.stringify({ error: 'revision_conflict', revision: result.revision }), {
              ...cors, ETag: `"${result.revision}"`,
            });
          } else {
            respond(request, response, 200, envelope(result.revision, result.snapshot), {
              ...cors, ETag: `"${result.revision}"`,
            });
          }
        } finally {
          // A slow reader can keep the large response buffered after response.end().
          await waitForWriteResponse(response);
          activeWrites--;
        }
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const known = error instanceof HttpError;
        const status = known ? error.status : 500;
        const code = known ? error.code : 'storage_error';
        // Close rejected requests so an unread or oversized body cannot keep streaming.
        respond(request, response, status, JSON.stringify({ error: code }), {
          ...cors, ...(known ? error.headers : {}),
        }, true);
      }
    }

    const activeSockets = new WeakSet();
    const server = createServer({
      maxHeaderSize: 8192,
      headersTimeout: 10_000,
      requestTimeout: MEDIA_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
      keepAliveTimeout: 5_000,
    }, (request, response) => {
      const socket = request.socket;
      // Do not buffer an unbounded number of pipelined responses for a slow reader.
      if (activeSockets.has(socket)) {
        socket.destroy();
        return;
      }
      activeSockets.add(socket);
      const isMedia = MEDIA_PATH_PATTERN.test(request.url ?? '');
      const deadline = setTimeout(() => socket.destroy(), isMedia ? MEDIA_TIMEOUT_MS : RESPONSE_TIMEOUT_MS);
      deadline.unref();
      let idleTimer;
      if (isMedia) {
        let lastActivity = Date.now();
        let bytesTransferred = socket.bytesRead + socket.bytesWritten;
        idleTimer = setInterval(() => {
          const currentBytes = socket.bytesRead + socket.bytesWritten;
          if (currentBytes !== bytesTransferred) {
            bytesTransferred = currentBytes;
            lastActivity = Date.now();
          } else if (Date.now() - lastActivity >= MEDIA_IDLE_TIMEOUT_MS) {
            socket.destroy();
          }
        }, 5000);
        idleTimer.unref();
      }
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(deadline);
        clearInterval(idleTimer);
        activeSockets.delete(socket);
      };
      response.once('finish', cleanup);
      response.once('close', cleanup);
      const operation = handle(request, response);
      inFlight.add(operation);
      void operation.then(() => inFlight.delete(operation), () => {
        inFlight.delete(operation);
        response.destroy();
      });
    });
    server.maxHeadersCount = 64;
    server.maxConnections = 64;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    console.log(`Ours sync listening on 127.0.0.1:${server.address().port}`);

    let stopping = false;
    async function stop() {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled(inFlight);
      await writeQueue;
      clearTimeout(deadline);
      await releaseLock();
    }
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof StartupError ? error.message : 'Unable to start Ours sync.');
  process.exitCode = 1;
});
