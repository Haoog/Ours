import { backupManifestUpperBound, MAX_RECORDS, MAX_MANIFEST } from './backup.js';

const DB_NAME = 'ours-web';
const STORE = 'memories';
const META = 'sync-meta';
const STATE = 'state';
const SETTINGS = 'settings';
let dbPromise;

// Like the engine's revisions, these use 128 fresh random bits for each write.
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('此浏览器不支持本地存储，请换用较新的浏览器。'));
      let settled = false;
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) {
          const meta = db.createObjectStore(META);
          meta.put({ revision: randomId(), deviceId: randomId(), baseline: null, pending: null }, STATE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => { if (!settled) { settled = true; reject(request.error || new Error('无法打开本地存储。')); } };
      request.onblocked = () => { if (!settled) { settled = true; reject(new Error('本地存储被其他页面占用，请关闭其他 Ours 页面后重试。')); } };
    }).catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

function finish(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('本地存储操作未完成。'));
    tx.onerror = () => {}; // onabort reports the transaction's error once.
  });
}
function writeTransaction(db, stores) {
  // Older implementations ignore the optional durability hint; never split a transaction.
  return db.transaction(stores, 'readwrite', { durability: 'strict' });
}
function requireState(state) {
  if (!state || typeof state.revision !== 'string' || !state.revision ||
      typeof state.deviceId !== 'string' || !state.deviceId ||
      !Object.hasOwn(state, 'baseline') || !Object.hasOwn(state, 'pending')) {
    const error = new Error('本地同步元数据无法读取；请先导出备份，不要清除浏览器数据。');
    error.name = 'SyncMetadataError';
    throw error;
  }
  return state;
}
function staleError() {
  const error = new Error('本机数据在打开编辑器后发生变化。草稿仍在这里；请另存为新回忆，或复制文字后关闭并重新编辑。');
  error.name = 'StaleMemoryError';
  return error;
}
function syncSettingsChangedError() {
  const error = new Error('同步设置已变化，未删除；请重新确认。');
  error.name = 'SyncSettingsChangedError';
  return error;
}

function backupLimitError(detail, existingOverLimit = false) {
  const advice = existingOverLimit
    ? '本机现有回忆可能已超过单个 .ours 备份上限，完整导出可能失败；请保留浏览器数据，暂勿删除回忆。'
    : '请先导出当前备份，再减少记录或文字。';
  const error = new Error(`${detail}本次更改未保存；${advice}`);
  error.name = 'BackupLimitError';
  return error;
}

// The backup helper uses the longest possible CRC32; three extra bytes cover
// extended ISO years. Preview and transactional writes share the same limit.
export function exceedsBackupManifestLimit(memories, limit = MAX_MANIFEST) {
  return backupManifestUpperBound(memories) + 3 > limit;
}
function requireBackupFits(memories, maxTotal = MAX_RECORDS, maxManifestBytes = MAX_MANIFEST, existing = null) {
  const countLimit = Number.isFinite(maxTotal) ? Math.min(maxTotal, MAX_RECORDS) : MAX_RECORDS;
  const manifestLimit = Number.isFinite(maxManifestBytes) ? Math.min(maxManifestBytes, MAX_MANIFEST) : MAX_MANIFEST;
  let detail = '';
  if (memories.length > countLimit) detail = `回忆数量超过 .ours 备份支持的 ${countLimit} 条上限。`;
  else if (exceedsBackupManifestLimit(memories, manifestLimit)) detail = '.ours 备份目录可能超过大小上限。';
  if (detail) {
    const existingOverLimit = existing && (existing.length > MAX_RECORDS || exceedsBackupManifestLimit(existing));
    throw backupLimitError(detail, existingOverLimit);
  }
}

// Sync snapshots contain media sizes instead of Blobs; the backup manifest
// needs only that size. The engine also validates the journal before use.
export function requireSyncBackupFits(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.memories)) return;
  const memories = snapshot.memories.map(memory => ({
    ...memory,
    media: memory.media.map(item => ({ ...item, blob: { size: item.size } }))
  }));
  requireBackupFits(memories);
}

// One readonly transaction produces a detached, consistent view for the engine and UI.
export async function readLocal() {
  const db = await openDatabase();
  const tx = db.transaction([STORE, META], 'readonly');
  const memories = tx.objectStore(STORE).getAll();
  const state = tx.objectStore(META).get(STATE);
  await finish(tx);
  const meta = requireState(state.result);
  return { revision: meta.revision, memories: memories.result, baseline: meta.baseline, pending: meta.pending };
}

// Backup and import preview must remain usable if sync metadata is damaged.
// Reading just this store still gives a consistent snapshot of all memories.
export async function listMemories() {
  const db = await openDatabase();
  const tx = db.transaction(STORE, 'readonly');
  const memories = tx.objectStore(STORE).getAll();
  await finish(tx);
  return memories.result;
}

// Compare and replace all synchronized values in one transaction; a mismatch writes nothing.
export async function compareAndSwap({ expectedRevision, nextRevision, memories, baseline, pending }) {
  if (typeof nextRevision !== 'string' || !nextRevision || nextRevision === expectedRevision) throw new Error('无效的本地修订号。');
  const db = await openDatabase();
  const tx = writeTransaction(db, [STORE, META]);
  const done = finish(tx);
  const meta = tx.objectStore(META);
  let matched = false;
  let reason;
  meta.get(STATE).onsuccess = event => {
    try {
      const state = requireState(event.target.result);
      if (state.revision !== expectedRevision) return;
      requireBackupFits(memories);
      // The engine publishes pending.proposed after this transaction. Check the
      // merged snapshot now, while its journal and the local data are atomic.
      if (pending?.proposed) requireSyncBackupFits(pending.proposed);
      const store = tx.objectStore(STORE);
      store.clear();
      for (const memory of memories) store.add(memory);
      meta.put({ ...state, revision: nextRevision, baseline, pending }, STATE);
      matched = true;
    } catch (error) { reason = error; tx.abort(); }
  };
  try { await done; } catch (error) { throw reason || error; }
  return matched ? nextRevision : null;
}

async function writeMemory(memoryOrId, { expectedRevision, expectedSyncSettings, insertOnly = false, remove = false } = {}) {
  const db = await openDatabase();
  const tx = writeTransaction(db, [STORE, META]);
  const done = finish(tx);
  const meta = tx.objectStore(META);
  // Compare the settings shown in the deletion prompt in the same transaction
  // as the delete, even if another tab changes settings while it is open.
  const settingsRequest = expectedSyncSettings ? meta.get(SETTINGS) : null;
  let reason;
  meta.get(STATE).onsuccess = event => {
    try {
      const state = requireState(event.target.result);
      if (expectedRevision !== undefined && state.revision !== expectedRevision) throw staleError();
      if (settingsRequest) {
        const settings = settingsRequest.result || {};
        if (Boolean(settings.enabled) !== expectedSyncSettings.enabled || (settings.baseUrl || '') !== expectedSyncSettings.baseUrl) {
          throw syncSettingsChangedError();
        }
      }
      const store = tx.objectStore(STORE);
      const write = () => {
        if (remove) store.delete(memoryOrId);
        else if (insertOnly) store.add(memoryOrId);
        else store.put(memoryOrId);
        // Do not touch the baseline or pending journal, even if a network write is uncertain.
        meta.put({ ...state, revision: randomId() }, STATE);
      };
      if (remove) { write(); return; }
      store.getAll().onsuccess = result => {
        try {
          const current = result.target.result;
          const finalMemories = current.filter(memory => memory.id !== memoryOrId.id);
          finalMemories.push(memoryOrId);
          requireBackupFits(finalMemories, MAX_RECORDS, MAX_MANIFEST, current);
          write();
        } catch (error) { reason = error; tx.abort(); }
      };
    } catch (error) { reason = error; tx.abort(); }
  };
  try { await done; } catch (error) { throw reason || error; }
}
export function saveMemory(memory, options) { return writeMemory(memory, options); }
export function deleteMemory(id, options = {}) { return writeMemory(id, { ...options, remove: true }); }

// One transaction ensures a full import or no import, including on quota errors.
export async function importMemories(memories, { maxTotal = Infinity, maxManifestBytes = Infinity } = {}) {
  const db = await openDatabase();
  const tx = writeTransaction(db, [STORE, META]);
  const store = tx.objectStore(STORE);
  const meta = tx.objectStore(META);
  const done = finish(tx);
  let added = 0;
  let skipped = 0;
  let abortReason;
  const abort = error => { abortReason = error; tx.abort(); };
  const existingRequest = store.getAll();
  meta.get(STATE).onsuccess = stateEvent => {
    try {
      const state = requireState(stateEvent.target.result);
      const existing = existingRequest.result;
      const seen = new Set(existing.map(memory => memory.id));
      const additions = [];
      for (const memory of memories) {
        if (seen.has(memory.id)) { skipped++; continue; }
        seen.add(memory.id);
        additions.push(memory);
      }
      added = additions.length;
      if (added) requireBackupFits([...existing, ...additions], maxTotal, maxManifestBytes, existing);
      // Check and enqueue the same objects without yielding between these steps.
      for (const memory of additions) store.add(memory);
      if (added) meta.put({ ...state, revision: randomId() }, STATE);
    } catch (error) { abort(error); }
  };
  try { await done; }
  catch (error) { throw abortReason || error; }
  return { added, skipped };
}

export async function readSyncSettings() {
  const db = await openDatabase();
  const tx = db.transaction(META, 'readonly');
  const store = tx.objectStore(META);
  const settings = store.get(SETTINGS);
  const state = store.get(STATE);
  await finish(tx);
  return { settings: settings.result || { enabled: false, baseUrl: '', token: '' }, deviceId: requireState(state.result).deviceId };
}

// Call under the same Web Lock as sync so another tab cannot switch settings mid-flight.
export async function writeSyncSettings(settings) {
  const db = await openDatabase();
  const tx = writeTransaction(db, META);
  const done = finish(tx);
  const meta = tx.objectStore(META);
  let reason;
  meta.get(STATE).onsuccess = event => {
    try {
      const state = requireState(event.target.result);
      for (const journal of [state.baseline, state.pending]) {
        if (journal && journal.server !== settings.baseUrl) {
          throw new Error('这台设备已有同步历史或待处理日志，不能切换同步地址。请先在两端导出备份并妥善保管。');
        }
      }
      meta.put(settings, SETTINGS);
    } catch (error) { reason = error; tx.abort(); }
  };
  try { await done; } catch (error) { throw reason || error; }
}
