// Independent synchronization engine for the Ours web memory schema.
//
// Integration contract:
//   createSyncEngine({ baseUrl, token, spaceId, deviceId, readLocal, compareAndSwap,
//                      withLock, fetch?, crypto?, allowLocalhost?, maxAttempts? }).sync()
// deviceId must be stable for this installation and unique across all independent
// devices/stores in the same space; generate a new one after restoring local data.
//
// readLocal() must atomically return { revision, memories, baseline, pending }.
// revision is a nonempty string which NEVER repeats and changes on every local
// memory, media, baseline, or pending mutation, including from other tabs. The
// returned values must be a detached, consistent view; Blob contents are immutable.
// baseline and pending start as null and are scoped to this server and spaceId.
// Application edits must preserve baseline and pending exactly.
//
// compareAndSwap({ expectedRevision, nextRevision, memories, baseline, pending })
// must, in ONE durable transaction, compare revision and, only if equal, replace
// all three values and set revision to nextRevision. Return that string only after
// commit, or null without changing anything on mismatch. Throw on failure. The
// engine generates nextRevision from 128 random bits; app writers must likewise
// use a new, never-reused revision for every write. All writers must participate.
// Calling the existing list/save/delete methods in sequence is NOT atomic.
// Active unsaved editor drafts must also be protected against stale saves: their
// eventual save must compare its starting record/revision or surface a conflict.
//
// withLock(callback) must serialize callback across ALL engines and tabs sharing
// this local store; hold the lock until its returned promise settles. It must return
// that result and invoke callback exactly once. User edits do not need this lock.
//
// sync() returns {status:'synced', etag, attempts},
// {status:'conflict', conflicts, attempts},
// {status:'pending_conflict', pending, local, remote, conflicts, conflictsMayBeIncomplete, attempts},
// {status:'pending_local_changed', pending, local, remote, conflicts, conflictsMayBeIncomplete, attempts},
// {status:'history_conflict', baseline, remote, attempts},
// {status:'local_changed', remoteCommitted, attempts}, or
// {status:'retry_exhausted', attempts}. It throws SyncError on other failures.
// Conflict versions contain snapshot records with media hashes, not Blob bytes;
// null means absent. No local or remote snapshot is changed on a merge conflict.
// A deletion relative to the baseline propagates only when the other side is
// unchanged or also deleted. Deleting a record edited on the other side conflicts.
// A pending journal is NOT a synchronized baseline; it must survive app edits and
// crashes. pending_local_changed/pending_conflict require an explicit, atomic UI
// reconciliation workflow, which this module does not implement. Do not clear a
// journal or baseline to bypass these states: that can lose a deletion or edit.
// Observable pending conflicts have against:'pending-proposal' or 'remote'; a
// record can have more than one detail. They may be incomplete and cannot prove
// the order of an uncertain upload and subsequent edits. Uploaded immutable media
// may remain after failure.
// Do not log errors together with options, requests, or credentials.

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_RECORDS = 10000;
const RESPONSE_LIMIT = MAX_SNAPSHOT_BYTES + 16 * 1024;
const FORMAT = 'ours-web-sync';
const BASELINE_FORMAT = 'ours-web-sync-baseline';
const PENDING_FORMAT = 'ours-web-sync-pending';
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const MIME = /^(image|video)\/[a-zA-Z0-9.+_-]+$/;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

export class SyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new SyncError(code, message, details); }
function invalid(message = 'Unsupported or invalid synchronization data.') {
  fail('INVALID_DATA', message);
}
function objectWithKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function validId(value) { return typeof value === 'string' && ID.test(value); }
function validTime(value) { return Number.isSafeInteger(value) && value >= 0; }
function validateRecordFields(record) {
  if (!objectWithKeys(record, ['id', 'date', 'text', 'createdAt', 'updatedAt', 'media']) ||
      !validId(record.id) || !validDate(record.date) || typeof record.text !== 'string' ||
      record.text.length > 10000 || !validTime(record.createdAt) || !validTime(record.updatedAt) ||
      !Array.isArray(record.media) || record.media.length > 9 ||
      (!record.text.trim() && record.media.length === 0)) invalid();
}
function validateMediaFields(item, local) {
  const keys = local ? ['id', 'name', 'type', 'blob'] : ['id', 'name', 'type', 'size', 'sha256'];
  if (!objectWithKeys(item, keys) || !validId(item.id) || typeof item.name !== 'string' ||
      item.name.length > 255 || typeof item.type !== 'string' || !MIME.test(item.type)) invalid();
  if (local) {
    if (!(item.blob instanceof Blob) || item.blob.size < 1 || item.blob.size > MAX_MEDIA_BYTES) invalid();
  } else if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_MEDIA_BYTES ||
             typeof item.sha256 !== 'string' || !HASH.test(item.sha256)) invalid();
}
function sorted(records) { return records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
function snapshot(records, spaceId, clock = []) {
  return { format: FORMAT, version: 1, spaceId, clock, memories: sorted(records) };
}
function normalizeClock(value) {
  if (!Array.isArray(value) || value.length > 1024) invalid();
  const seen = new Set();
  const result = value.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || !validId(entry[0]) ||
        !Number.isSafeInteger(entry[1]) || entry[1] < 1 || seen.has(entry[0])) invalid();
    seen.add(entry[0]);
    return [entry[0], entry[1]];
  });
  return result.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
function dominates(current, before) {
  const counts = new Map(current);
  return before.every(([id, number]) => (counts.get(id) || 0) >= number);
}
function joinClocks(a, b) {
  const counts = new Map(a);
  for (const [id, number] of b) counts.set(id, Math.max(counts.get(id) || 0, number));
  return normalizeClock([...counts]);
}
function nextClock(clock, deviceId) {
  const counts = new Map(clock);
  const next = (counts.get(deviceId) || 0) + 1;
  if (!Number.isSafeInteger(next)) invalid();
  counts.set(deviceId, next);
  return normalizeClock([...counts]);
}

// Normalize before comparison: property order is insignificant, but media order is not.
function normalizeSnapshot(value, spaceId) {
  if (!objectWithKeys(value, ['format', 'version', 'spaceId', 'clock', 'memories']) ||
      value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.memories) ||
      value.memories.length > MAX_RECORDS) invalid();
  if (value.spaceId !== spaceId) fail('SPACE_MISMATCH', 'The server snapshot belongs to another synchronization space.');
  const clock = normalizeClock(value.clock);
  const ids = new Set();
  const records = value.memories.map(record => {
    validateRecordFields(record);
    if (ids.has(record.id)) invalid();
    ids.add(record.id);
    const mediaIds = new Set();
    const media = record.media.map(item => {
      validateMediaFields(item, false);
      if (mediaIds.has(item.id)) invalid();
      mediaIds.add(item.id);
      return { id: item.id, name: item.name, type: item.type, size: item.size, sha256: item.sha256 };
    });
    return { id: record.id, date: record.date, text: record.text, createdAt: record.createdAt, updatedAt: record.updatedAt, media };
  });
  return snapshot(records, spaceId, clock);
}

// Copy the metadata synchronously before awaiting hashing, so an adapter's later
// mutations cannot alter the view captured for this attempt.
function captureLocal(memories) {
  if (!Array.isArray(memories) || memories.length > MAX_RECORDS) invalid();
  const ids = new Set();
  return memories.map(record => {
    validateRecordFields(record);
    if (ids.has(record.id)) invalid();
    ids.add(record.id);
    const mediaIds = new Set();
    const media = record.media.map(item => {
      validateMediaFields(item, true);
      if (mediaIds.has(item.id)) invalid();
      mediaIds.add(item.id);
      return { id: item.id, name: item.name, type: item.type, blob: item.blob };
    });
    return { id: record.id, date: record.date, text: record.text, createdAt: record.createdAt, updatedAt: record.updatedAt, media };
  });
}
async function digest(bytes, cryptoImpl) {
  let result;
  try { result = await cryptoImpl.subtle.digest('SHA-256', bytes); }
  catch { fail('HASH_FAILED', 'Could not calculate a media SHA-256 digest.'); }
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function encodeLocal(records, cryptoImpl, spaceId) {
  const blobs = new Map();
  const encoded = [];
  for (const record of records) {
    const media = [];
    for (const item of record.media) {
      let bytes;
      try { bytes = await item.blob.arrayBuffer(); }
      catch { fail('LOCAL_MEDIA_READ', 'Could not read local media.'); }
      const sha256 = await digest(bytes, cryptoImpl);
      blobs.set(sha256, item.blob);
      media.push({ id: item.id, name: item.name, type: item.type, size: item.blob.size, sha256 });
    }
    encoded.push({ id: record.id, date: record.date, text: record.text, createdAt: record.createdAt, updatedAt: record.updatedAt, media });
  }
  return { value: snapshot(encoded, spaceId), blobs };
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function mapRecords(value) { return new Map(value.memories.map(record => [record.id, record])); }
function merge(base, local, remote) {
  const baseMap = mapRecords(base), localMap = mapRecords(local), remoteMap = mapRecords(remote);
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const records = [], conflicts = [];
  for (const id of ids) {
    const before = baseMap.get(id) || null;
    const here = localMap.get(id) || null;
    const there = remoteMap.get(id) || null;
    if (before && (!here || !there)) {
      const survivor = here || there;
      if (survivor && !equal(survivor, before)) {
        conflicts.push({ id, kind: 'edit-delete', deletedBy: here ? 'remote' : 'local',
          base: before, local: here, remote: there });
      }
    } else if (equal(here, there)) {
      if (here) records.push(here);
    } else if (equal(here, before)) {
      if (there) records.push(there);
    } else if (equal(there, before)) {
      if (here) records.push(here);
    } else {
      conflicts.push({ id, kind: before ? 'concurrent-edit' : 'concurrent-add',
        base: before, local: here, remote: there });
    }
  }
  conflicts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { value: snapshot(records, remote.spaceId, remote.clock), conflicts };
}
// Preserve the distinct pending statuses, but expose observable delete/edit
// divergence against the current server snapshot as well as the pending proposal.
// Records identical to our proposal may be our own earlier publication. When
// the remote clock has observed the proposal, a later remote deletion likewise
// is not a conflict with an unchanged local record from that proposal.
function pendingConflicts(base, local, remote, pending) {
  const conflicts = merge(pending.local, local, pending.proposed).conflicts
    .map(conflict => ({ ...conflict, against: 'pending-proposal' }));
  const proposed = mapRecords(pending.proposed), originalLocal = mapRecords(pending.local);
  const observedProposal = dominates(remote.clock, pending.proposed.clock);
  const comparisonBase = observedProposal ? pending.proposed : base;
  for (const conflict of merge(comparisonBase, local, remote).conflicts) {
    if (conflict.kind === 'edit-delete' && !equal(conflict.remote, proposed.get(conflict.id) || null) &&
        !(observedProposal && equal(conflict.local, originalLocal.get(conflict.id) || null))) {
      conflicts.push({ ...conflict, against: 'remote' });
    }
  }
  return conflicts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function validETag(value) {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
}
function validateBaseline(value, server, spaceId) {
  if (value === null) return snapshot([], spaceId);
  if (!objectWithKeys(value, ['format', 'version', 'server', 'spaceId', 'etag', 'snapshot']) ||
      value.format !== BASELINE_FORMAT || value.version !== 1 || value.server !== server ||
      value.spaceId !== spaceId || !validETag(value.etag)) {
    fail('BASELINE_MISMATCH', 'The local baseline does not belong to this synchronization space.');
  }
  return normalizeSnapshot(value.snapshot, spaceId);
}
function validatePending(value, server, spaceId) {
  if (value === null) return null;
  if (!objectWithKeys(value, ['format', 'version', 'server', 'spaceId', 'id', 'revision', 'etag', 'local', 'proposed']) ||
      value.format !== PENDING_FORMAT || value.version !== 1 || value.server !== server ||
      value.spaceId !== spaceId || !validId(value.id) || !validId(value.revision) || !validETag(value.etag)) {
    fail('PENDING_MISMATCH', 'The pending journal does not belong to this synchronization space.');
  }
  return { format: PENDING_FORMAT, version: 1, server, spaceId, id: value.id, revision: value.revision, etag: value.etag,
    local: normalizeSnapshot(value.local, spaceId), proposed: normalizeSnapshot(value.proposed, spaceId) };
}
function newPendingId(cryptoImpl) {
  const bytes = new Uint8Array(16);
  try { cryptoImpl.getRandomValues(bytes); }
  catch { fail('RANDOM_FAILED', 'Could not create a synchronization journal.'); }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function endpoint(value, allowLocalhost) {
  let url;
  try { url = new URL(value); }
  catch { fail('INVALID_URL', 'The synchronization server URL is invalid.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && allowLocalhost === true && local))) {
    fail('INVALID_URL', 'Use an HTTPS origin, or explicitly allow a local HTTP origin.');
  }
  return url.origin;
}
async function boundedBody(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    fail('RESPONSE_TOO_LARGE', 'The server response exceeds the allowed size.');
  }
  if (!response.body) return new Uint8Array();
  if (typeof response.body.getReader !== 'function') fail('INVALID_RESPONSE', 'The server response is unreadable.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail('INVALID_RESPONSE', 'The server response is unreadable.');
      size += part.value.byteLength;
      if (size > limit) fail('RESPONSE_TOO_LARGE', 'The server response exceeds the allowed size.');
      chunks.push(part.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Ignore cancellation errors. */ }
    if (error instanceof SyncError) throw error;
    fail('NETWORK', 'The server response could not be read.');
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function readSnapshotResponse(response, spaceId) {
  const etag = response.headers.get('etag');
  if (!validETag(etag)) fail('INVALID_RESPONSE', 'The server did not return a valid strong ETag.');
  let wrapper;
  try { wrapper = JSON.parse(DECODER.decode(await boundedBody(response, RESPONSE_LIMIT))); }
  catch (error) {
    if (error instanceof SyncError) throw error;
    fail('INVALID_RESPONSE', 'The server returned an invalid snapshot response.');
  }
  if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper) ||
      typeof wrapper.revision !== 'string' || etag !== `"${wrapper.revision}"` || !Object.hasOwn(wrapper, 'snapshot')) {
    fail('INVALID_RESPONSE', 'The server returned an invalid snapshot response.');
  }
  if (wrapper.snapshot === null) {
    if (wrapper.revision !== '0') invalid('The server snapshot is not an Ours synchronization snapshot.');
    return { etag, value: snapshot([], spaceId), empty: true };
  }
  return { etag, value: normalizeSnapshot(wrapper.snapshot, spaceId), empty: false };
}
function snapshotBody(value) {
  if (value.memories.length > MAX_RECORDS) fail('TOO_MANY_RECORDS', 'The merged snapshot exceeds 10,000 records.');
  const text = JSON.stringify(value);
  if (ENCODER.encode(text).byteLength > MAX_SNAPSHOT_BYTES) {
    fail('SNAPSHOT_TOO_LARGE', 'The synchronization snapshot exceeds 16 MiB.');
  }
  return text;
}

export function createSyncEngine(options) {
  if (!options || typeof options !== 'object') fail('INVALID_OPTIONS', 'Synchronization options are required.');
  const { baseUrl, token, spaceId, deviceId, readLocal, compareAndSwap, withLock, allowLocalhost = false, maxAttempts = 3 } = options;
  const fetchImpl = options.fetch || globalThis.fetch;
  const cryptoImpl = options.crypto || globalThis.crypto;
  const server = endpoint(baseUrl, allowLocalhost);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !validId(spaceId) || !validId(deviceId) ||
      typeof readLocal !== 'function' || typeof compareAndSwap !== 'function' || typeof withLock !== 'function' ||
      typeof fetchImpl !== 'function' || !cryptoImpl?.subtle || typeof cryptoImpl.subtle.digest !== 'function' ||
      typeof cryptoImpl.getRandomValues !== 'function' ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    fail('INVALID_OPTIONS', 'Synchronization options are invalid.');
  }
  let running = false;
  async function request(path, method, headers = {}, body) {
    try {
      return await fetchImpl(server + path, {
        method, headers: { Authorization: `Bearer ${token}`, ...headers }, body,
        credentials: 'omit', cache: 'no-store', redirect: 'error'
      });
    } catch {
      const unknown = method === 'PUT' && path === '/v1/snapshot';
      fail('NETWORK', 'The synchronization server could not be reached.', unknown ? { remoteCommitUnknown: true } : {});
    }
  }
  function expect(response, statuses) {
    if (!response || !statuses.includes(response.status) || !response.headers || typeof response.headers.get !== 'function') {
      const status = response && Number.isInteger(response.status) ? response.status : undefined;
      fail('HTTP_ERROR', 'The synchronization server rejected the request.', { status });
    }
  }
  async function prepareMedia(value, localBlobs) {
    const available = new Map();
    for (const record of value.memories) {
      for (const item of record.media) {
        if (available.has(item.sha256)) {
          if (available.get(item.sha256).size !== item.size) invalid();
          continue;
        }
        const local = localBlobs.get(item.sha256);
        let blob;
        if (local) {
          if (local.size !== item.size) invalid();
          const response = await request(`/v1/media/${item.sha256}`, 'PUT', { 'Content-Type': 'application/octet-stream' }, local);
          expect(response, [200, 201]);
          if (response.headers.get('etag') !== `"${item.sha256}"`) fail('INVALID_RESPONSE', 'The server returned an invalid media ETag.');
          blob = local;
        } else {
          const response = await request(`/v1/media/${item.sha256}`, 'GET');
          expect(response, [200]);
          const bytes = await boundedBody(response, item.size);
          if (bytes.byteLength !== item.size || await digest(bytes, cryptoImpl) !== item.sha256) {
            fail('MEDIA_INTEGRITY', 'Downloaded media failed its size or SHA-256 check.');
          }
          blob = new Blob([bytes]);
        }
        available.set(item.sha256, blob);
      }
    }
    return value.memories.map(record => ({
      id: record.id, date: record.date, text: record.text, createdAt: record.createdAt, updatedAt: record.updatedAt,
      media: record.media.map(item => ({ id: item.id, name: item.name, type: item.type,
        blob: available.get(item.sha256).slice(0, item.size, item.type) }))
    }));
  }
  async function readState() {
    let state;
    try { state = await readLocal(); }
    catch { fail('LOCAL_READ', 'Could not read the local synchronization state.'); }
    if (!state || typeof state !== 'object' || typeof state.revision !== 'string' ||
        state.revision.length < 1 || state.revision.length > 256 ||
        !Object.hasOwn(state, 'baseline') || !Object.hasOwn(state, 'pending')) invalid();
    return state;
  }
  async function cas(change, remoteCommitted) {
    const nextRevision = change.nextRevision || newPendingId(cryptoImpl);
    let revision;
    try { revision = await compareAndSwap({ ...change, nextRevision }); }
    catch { fail('LOCAL_COMMIT', 'The local synchronization transaction failed.', { remoteCommitted }); }
    if (revision === null) return null;
    if (revision !== nextRevision || revision === change.expectedRevision) {
      fail('LOCAL_COMMIT', 'The local transaction did not return the requested new revision.', { remoteCommitted });
    }
    return revision;
  }
  async function getRemote() {
    const response = await request('/v1/snapshot', 'GET');
    expect(response, [200]);
    return readSnapshotResponse(response, spaceId);
  }
  // null means a definitive 412. Every other failure after dispatch may have
  // happened after the server committed; the pending journal must be retained.
  async function putSnapshot(value, etag) {
    const body = snapshotBody(value);
    const response = await request('/v1/snapshot', 'PUT', { 'Content-Type': 'application/json', 'If-Match': etag }, body);
    if (response?.status === 412) return null;
    try {
      expect(response, [200]);
      const confirmed = await readSnapshotResponse(response, spaceId);
      if (confirmed.empty || !equal(confirmed.value, value) || confirmed.etag === etag) {
        fail('INVALID_RESPONSE', 'The server did not confirm the proposed snapshot.');
      }
      return confirmed;
    } catch (error) {
      if (error instanceof SyncError) { error.remoteCommitUnknown = true; throw error; }
      fail('INVALID_RESPONSE', 'The server did not confirm the proposed snapshot.', { remoteCommitUnknown: true });
    }
  }
  // Only discard a definitively rejected journal if the user has not edited
  // since it was prepared. Otherwise it is needed to remember a newly created
  // and then deleted local record, even if another device published the same ID.
  async function discardRejectedPending(id, preparedRevision) {
    const current = await readState();
    const pending = validatePending(current.pending, server, spaceId);
    if (!pending || pending.id !== id || current.revision !== preparedRevision) return false;
    validateBaseline(current.baseline, server, spaceId);
    const memories = captureLocal(current.memories);
    const revision = await cas({ expectedRevision: current.revision, memories, baseline: current.baseline, pending: null }, false);
    return revision !== null;
  }
  async function lockedSync() {
    let remoteCommitted = false;
    for (let attempts = 1; attempts <= maxAttempts; attempts++) {
      const state = await readState();
      let base = validateBaseline(state.baseline, server, spaceId);
      const pending = validatePending(state.pending, server, spaceId);
      const captured = captureLocal(state.memories);
      const local = await encodeLocal(captured, cryptoImpl, spaceId);
      let remote = await getRemote();
      if (state.baseline !== null && (!dominates(remote.value.clock, base.clock) ||
          (equal(remote.value.clock, base.clock) && !equal(remote.value, base)))) {
        return { status: 'history_conflict', baseline: base, remote: remote.value, attempts };
      }

      if (pending) {
        // A before/after comparison cannot see a create-then-delete interval.
        // Any intervening local write requires explicit reconciliation, even if
        // the current bytes happen to match the captured view exactly.
        if (state.revision !== pending.revision) {
          return { status: 'pending_local_changed', pending, local: local.value, remote: remote.value,
            conflicts: pendingConflicts(base, local.value, remote.value, pending), conflictsMayBeIncomplete: true, attempts };
        }
        // Identical records can safely join both histories, whether the remote
        // observed our proposal or independently made the same deletion. This
        // also preserves every newer remote clock component across recovery.
        const sameRecords = !remote.empty && equal(remote.value.memories, pending.proposed.memories);
        if (remote.etag !== pending.etag && !sameRecords) {
          // The earlier write may have committed and then been superseded.
          return { status: 'pending_conflict', pending, local: local.value, remote: remote.value,
            conflicts: pendingConflicts(base, local.value, remote.value, pending), conflictsMayBeIncomplete: true, attempts };
        }
        const candidate = sameRecords ? snapshot([...remote.value.memories], spaceId,
          joinClocks(remote.value.clock, pending.proposed.clock)) : pending.proposed;
        // Check the current local view BEFORE retrying an uncertain publication.
        // pending.local detects deletions of records absent from the old baseline.
        const recovered = merge(pending.local, local.value, candidate);
        if (recovered.conflicts.length) {
          return { status: 'conflict', conflicts: recovered.conflicts, pending: true, attempts };
        }
        snapshotBody(recovered.value);
        await prepareMedia(candidate, local.blobs);
        const recoveredMemories = await prepareMedia(recovered.value, local.blobs);
        // A GET can expose a rename whose directory fsync failed. Re-PUT and
        // require 200 before treating the candidate as a durable baseline. If an
        // old request is still in flight, the ETag makes at most one PUT win.
        const confirmed = await putSnapshot(candidate, remote.etag);
        if (!confirmed) continue;
        remoteCommitted = true;
        const recoveredBaseline = { format: BASELINE_FORMAT, version: 1, server, spaceId,
          etag: confirmed.etag, snapshot: confirmed.value };
        // Keep later edits in memories but use the actual confirmed candidate as
        // baseline. Never replace the old journal with a new one before this CAS.
        const applied = await cas({ expectedRevision: state.revision, memories: recoveredMemories,
          baseline: recoveredBaseline, pending: null }, true);
        if (applied === null) return { status: 'local_changed', remoteCommitted: true, attempts };
        attempts--;
        continue;
      }
      // A routine check with no changes must not upload every photo/video or
      // create a new server revision. Re-read the local revision so an edit
      // made during hashing or the network request is never reported as synced.
      if (state.baseline !== null && remote.etag === state.baseline.etag &&
          equal(remote.value, base) && equal(local.value.memories, base.memories)) {
        const current = await readState();
        if (current.revision !== state.revision) return { status: 'local_changed', remoteCommitted, attempts };
        return { status: 'synced', etag: remote.etag, attempts };
      }
      const merged = merge(base, local.value, remote.value);
      if (merged.conflicts.length) return { status: 'conflict', conflicts: merged.conflicts, attempts };
      merged.value.clock = nextClock(remote.value.clock, deviceId);
      snapshotBody(merged.value);
      const memories = await prepareMedia(merged.value, local.blobs);
      const nextRevision = newPendingId(cryptoImpl);
      const nextPending = { format: PENDING_FORMAT, version: 1, server, spaceId,
        id: newPendingId(cryptoImpl), revision: nextRevision, etag: remote.etag,
        local: local.value, proposed: merged.value };
      const preparedRevision = await cas({ expectedRevision: state.revision, nextRevision, memories: captured,
        baseline: state.baseline, pending: nextPending }, remoteCommitted);
      if (preparedRevision === null) return { status: 'local_changed', remoteCommitted, attempts };

      const confirmed = await putSnapshot(merged.value, remote.etag);
      if (!confirmed) {
        if (!await discardRejectedPending(nextPending.id, preparedRevision)) return { status: 'local_changed', remoteCommitted, attempts };
        continue;
      }
      remoteCommitted = true;
      const baseline = { format: BASELINE_FORMAT, version: 1, server, spaceId, etag: confirmed.etag, snapshot: confirmed.value };
      const applied = await cas({ expectedRevision: preparedRevision, memories, baseline, pending: null }, true);
      if (applied === null) return { status: 'local_changed', remoteCommitted: true, attempts };
      return { status: 'synced', etag: confirmed.etag, attempts };
    }
    return { status: 'retry_exhausted', attempts: maxAttempts };
  }
  async function sync() {
    if (running) fail('BUSY', 'A synchronization is already running.');
    running = true;
    try {
      let called = false;
      const result = await withLock(async () => {
        if (called) fail('LOCK_FAILED', 'The local synchronization lock is invalid.');
        called = true;
        return lockedSync();
      });
      if (!called) fail('LOCK_FAILED', 'The local synchronization lock is invalid.');
      return result;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      fail('LOCK_FAILED', 'Could not acquire the local synchronization lock.');
    } finally { running = false; }
  }
  return Object.freeze({ sync });
}
