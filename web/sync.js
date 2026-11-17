import { createSyncEngine, SyncError } from './sync-engine.js';
import { readLocal, compareAndSwap, readSyncSettings, writeSyncSettings, requireSyncBackupFits } from './storage.js';

const LOCK = 'ours-web-sync';
const SPACE = 'ours-web';
const REFRESH_MS = 120000;

function supportsLock() {
  return window.isSecureContext && typeof navigator.locks?.request === 'function' && !!crypto.subtle;
}
function withLock(callback) {
  if (!supportsLock()) throw new Error('此浏览器没有可用的安全跨标签锁，同步已暂停；本地记录仍可使用。');
  return navigator.locks.request(LOCK, { mode: 'exclusive' }, callback);
}
export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的同步服务地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('请输入 HTTPS 服务地址；仅本机 localhost、127.0.0.1 或 [::1] 可使用 HTTP。地址不能包含路径、账号或参数。');
  }
  return url.origin;
}
function storedOrigin(value) {
  if (!value) return '';
  try { return normalizeOrigin(value); }
  catch { return null; }
}
function validateSettings(input, previous) {
  const enabled = Boolean(input.enabled);
  const baseUrl = input.baseUrl.trim() ? normalizeOrigin(input.baseUrl.trim()) : '';
  const suppliedToken = input.token.trim();
  // Legacy settings have no reliable binding: an older version could have
  // saved a different address while retaining the credential. Never infer one.
  const previousOrigin = storedOrigin(previous.baseUrl);
  const credentialOrigin = storedOrigin(previous.tokenOrigin);
  const sameOrigin = Boolean(baseUrl && baseUrl === previousOrigin && baseUrl === credentialOrigin);
  const token = suppliedToken || (sameOrigin ? previous.token : '') || '';
  if (suppliedToken && !baseUrl) throw new Error('请先填写同步服务地址，再保存共享凭证。');
  if (enabled && (!baseUrl || !token)) {
    if (baseUrl && !sameOrigin && previous.token) throw new Error('已有凭证未绑定到此服务地址，请重新输入该服务的共享凭证。');
    throw new Error('启用同步时需要填写服务地址和共享凭证。');
  }
  if (token && !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) {
    throw new Error('共享凭证应为 32 字节随机值的 43 位无填充 base64url 编码。');
  }
  return { enabled, baseUrl, token, tokenOrigin: token ? baseUrl : '' };
}
function statusForError(error) {
  if (error.name === 'SyncMetadataError') return '本地同步元数据无法读取，同步已暂停；请先导出备份，不要清除浏览器数据。';
  if (error.remoteCommitUnknown) return '同步时连接或服务响应中断，远端是否已提交尚不确定。待处理日志和本机记录已保留；将重新核对，请勿清除网站数据。';
  if (error.code === 'NETWORK') return '无法连接同步服务，本机记录和待处理状态已保留；网络恢复后会重试。';
  if (error.code === 'INVALID_SETTINGS') return '同步设置或凭证与服务地址不匹配，已暂停；本机记录和同步日志已保留，请检查地址并重新输入凭证。';
  if (error.code === 'HTTP_ERROR' && error.status === 401) return '共享凭证未被服务接受；本机记录和待处理状态已保留，请检查设置。';
  if (error.code === 'HTTP_ERROR' && error.status === 403) return '服务未允许此网页来源；本机记录和待处理状态已保留，请检查服务的来源配置。';
  if (error.code === 'HTTP_ERROR') return `同步服务返回错误${error.status ? `（${error.status}）` : ''}；本机记录和待处理状态已保留。`;
  if (error.code === 'SNAPSHOT_TOO_LARGE' || error.code === 'TOO_MANY_RECORDS') return '同步数据超过服务支持的大小或数量上限；本机记录已保留，请先导出备份。';
  if (error.code === 'BASELINE_MISMATCH' || error.code === 'PENDING_MISMATCH' || error.code === 'SPACE_MISMATCH') return '同步历史与当前服务不匹配，已暂停；本机记录和待处理日志已保留，请先导出备份。';
  if (error.code === 'INVALID_DATA') return '本机或远端含同步引擎不支持的数据，已暂停；本机记录已保留，请先导出备份。';
  if (error.code === 'LOCAL_COMMIT' || error.code === 'LOCAL_READ') return '本地同步事务未完成，远端提交结果可能需要核对；请保留数据并导出备份。';
  if (error.code === 'LOCK_FAILED') return '无法取得安全的跨标签同步锁，同步已暂停；本机记录已保留。';
  return '同步未完成，本机记录和待处理状态已保留；请检查连接并导出备份。';
}
function describeResult(result) {
  if (result.status === 'synced') return { message: '上次同步成功；回忆也保存在本机。', conflict: false };
  if (result.status === 'conflict') {
    const kinds = [...new Set(result.conflicts.map(item => ({
      'concurrent-edit': '两端编辑', 'concurrent-add': '同 ID 新增', 'edit-delete': '编辑与删除'
    })[item.kind] || '内容不一致'))].join('、');
    return { message: `发现 ${result.conflicts.length} 条同步冲突（${kinds}），已暂停。请在两端导出备份并核对；备份不含同步日志，请勿清除浏览器数据。网页暂不自动解决冲突。`, conflict: true };
  }
  if (result.status === 'pending_conflict' || result.status === 'pending_local_changed') {
    return { message: '上次同步的提交结果或期间的本机修改需要人工核对，已暂停。待处理日志和本机记录均已保留；请在两端导出备份。备份不含同步日志，请勿清除浏览器数据。', conflict: true };
  }
  if (result.status === 'history_conflict') return { message: '远端同步历史发生变化，已暂停。请保留两端现状并分别导出备份，网页不会自动覆盖。', conflict: true };
  if (result.status === 'local_changed' && result.remoteCommitted) return { message: '同步期间本机数据发生变化，远端已有提交；本机记录以及已有的待处理日志均已保留。请在两端导出备份并核对；备份不含同步日志，请勿清除浏览器数据。', conflict: true };
  if (result.status === 'local_changed') return { message: '同步期间本机数据发生变化，本机内容已保留；正在重新检查。', conflict: false, retry: true };
  return { message: '同步未完成，多次检查后仍有变化；本机记录已保留，请稍后重试。', conflict: false };
}

export function createSyncController({ onStatus, onDataChanged, canAutoSync }) {
  let running = false;
  let rerun = false;
  let conflict = false;
  let enabled = null;
  let timer;
  let lastMessage = '';
  function report(message, isConflict = false) {
    lastMessage = message;
    onStatus({ message, conflict: isConflict });
  }
  function schedule(delay = 1200) {
    if (conflict) return;
    clearTimeout(timer);
    timer = setTimeout(() => { run(false); }, delay);
  }
  async function run(manual = false) {
    if (running) { if (!conflict) rerun = true; return; }
    if (conflict && !manual) return;
    if (!manual && !canAutoSync()) return;
    running = true;
    let backupLimitFailure = false;
    try {
      const stored = await readSyncSettings();
      const { deviceId } = stored;
      enabled = stored.settings.enabled;
      if (!enabled) {
        conflict = false;
        report(supportsLock() ? (stored.settings.baseUrl ? '同步未启用或已暂停；本机记录和已有的同步历史、待处理日志均会保留。' : '尚未启用同步，回忆保存在当前浏览器。') : '同步已暂停；此浏览器缺少安全跨标签锁，本地记录仍可使用。');
        return;
      }
      if (!supportsLock()) { report('此浏览器没有可用的安全跨标签锁，同步已暂停；本地记录仍可使用。'); return; }
      // Check the binding again before sending any requests, including after
      // upgrading settings saved by older versions of the app.
      let settings;
      try { settings = validateSettings({ ...stored.settings, token: '' }, stored.settings); }
      catch { throw new SyncError('INVALID_SETTINGS', 'Invalid synchronization settings.'); }
      if (!navigator.onLine) { report('当前离线，本机记录已保留；联网后会重试同步。'); return; }
      report('正在检查同步，本机记录仍可使用…');
      const engine = createSyncEngine({
        ...settings, spaceId: SPACE, deviceId, allowLocalhost: true,
        readLocal: async () => {
          const local = await readLocal();
          // Older versions could persist a proposal that cannot be exported.
          // Check it under the sync lock, before recovery can contact the server.
          if (local.pending?.proposed) {
            try { requireSyncBackupFits(local.pending.proposed); }
            catch (error) { if (error.name === 'BackupLimitError') backupLimitFailure = true; throw error; }
          }
          return local;
        },
        compareAndSwap: async change => {
          try { return await compareAndSwap(change); }
          catch (error) { if (error.name === 'BackupLimitError') backupLimitFailure = true; throw error; }
        },
        withLock: callback => withLock(async () => {
          // Settings may have changed while waiting behind another tab's sync.
          let latest;
          try { latest = await readSyncSettings(); }
          catch { throw new SyncError('LOCAL_READ', 'Could not read local synchronization settings.'); }
          if (!latest.settings.enabled || latest.settings.baseUrl !== stored.settings.baseUrl ||
              latest.settings.token !== stored.settings.token || latest.settings.tokenOrigin !== stored.settings.tokenOrigin ||
              latest.deviceId !== deviceId) {
            throw new SyncError('SETTINGS_CHANGED', 'Settings changed while waiting for the lock.');
          }
          return callback();
        }),
        // Aborting a timed-out PUT leaves the engine's pending journal for recovery.
        fetch: async (url, options) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), options.method === 'PUT' && url.includes('/v1/media/') ? 600000 : 45000);
          try { return await fetch(url, { ...options, signal: controller.signal }); }
          finally { clearTimeout(timeout); }
        }
      });
      const result = await engine.sync();
      const status = describeResult(result);
      conflict = status.conflict;
      report(status.message, conflict);
      if (status.retry) rerun = true;
    } catch (error) {
      if (error.code === 'SETTINGS_CHANGED') { rerun = true; report('同步设置已变化，正在重新检查。'); }
      else {
        conflict = error.name === 'SyncMetadataError' || ['BASELINE_MISMATCH', 'PENDING_MISMATCH', 'SPACE_MISMATCH', 'INVALID_DATA', 'INVALID_SETTINGS', 'LOCAL_COMMIT', 'LOCAL_READ', 'LOCK_FAILED'].includes(error.code);
        if (backupLimitFailure) {
          conflict = true;
          report('同步后的回忆可能超过 .ours 备份上限，本机记录和同步日志已保留。远端可能已有提交；请在两端导出备份并核对。', true);
        } else report(statusForError(error), conflict);
      }
    } finally {
      running = false;
      // A journal or baseline can have changed even on failure.
      onDataChanged();
      if (rerun && !conflict) { rerun = false; schedule(1500); }
      else rerun = false;
    }
  }
  async function saveSettings(input) {
    if (!supportsLock()) throw new Error('此浏览器没有可用的安全跨标签锁，同步已暂停；本地记录仍可使用。');
    await withLock(async () => {
      const { settings } = await readSyncSettings();
      const next = validateSettings(input, settings);
      if (storedOrigin(settings.baseUrl) !== next.baseUrl) {
        // Do not silently switch even if damaged or legacy settings disagree
        // with the server named by the existing history. The storage transaction
        // also checks the journals when committing the settings.
        const { baseline, pending } = await readLocal();
        if (baseline !== null || pending !== null) {
          throw new Error('这台设备已有同步历史或待处理日志，不能切换同步地址。请先在两端导出备份并妥善保管。');
        }
      }
      await writeSyncSettings(next);
    });
    conflict = false;
    enabled = Boolean(input.enabled);
    schedule(0);
  }
  function localChanged() {
    if (!conflict) {
      report(enabled ? '本机修改已保存，等待同步。' : '本机修改已保存；同步未启用。');
      schedule();
    }
  }
  function externalSettingsChanged() {
    conflict = false;
    report('同步设置已在其他页面更新，正在检查。');
    schedule(0);
  }
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('offline', () => { if (!conflict && enabled) report('当前离线，本机记录已保留；联网后会重试同步。'); });
  window.addEventListener('focus', () => schedule());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  // Browsers can throttle or suspend background tabs; visibility/online events
  // also trigger a fresh check when execution resumes.
  setInterval(() => schedule(0), REFRESH_MS);
  return { run: () => run(true), start: () => schedule(0), localChanged, externalSettingsChanged,
    resume: () => schedule(), saveSettings, get message() { return lastMessage; } };
}
