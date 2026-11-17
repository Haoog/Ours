import { listMemories, readLocal, readSyncSettings, saveMemory, deleteMemory, importMemories, exceedsBackupManifestLimit } from './storage.js';
import { createSyncController, normalizeOrigin } from './sync.js';
import { createBackup, readBackup, validDate, MAX_MEDIA, MAX_RECORDS, MAX_MANIFEST } from './backup.js';
import { parseWxBackup } from './wx-import.js';
import { prepareWxMemories } from './wx-prepare.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const landing = $('#landing');
const app = $('#app');
const content = $('#journal-content');
const editor = $('#editor-dialog');
const backupDialog = $('#backup-dialog');
const installDialog = $('#install-dialog');
const syncDialog = $('#sync-dialog');
const editorForm = $('#editor-form');
const dateInput = $('#memory-date');
const textInput = $('#memory-text');
const mediaInput = $('#media-input');
const editorError = $('#editor-error');
const backupStatus = $('#backup-status');
const importInput = $('#import-input');
const wxImportInput = $('#wx-import-input');
const wxPreviewBox = $('#wx-preview');
let wxPreview = null;
let memories = [];
let dbReady = false;
let editing = null;
let editingRevision = null;
let displayRevision = null;
let refreshSequence = 0;
let draftMedia = [];
let listUrls = [];
let editorUrls = [];
let saving = false;
let backupBusy = false;
let installPrompt = null;
let toastTimer;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('ours-web-updates') : null;

function notify(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}
function errorMessage(error) {
  if (error?.name === 'QuotaExceededError') return '设备存储空间不足，请先释放空间或减少媒体文件，再重试。';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '浏览器未允许使用本地存储，请检查浏览器设置或退出无痕模式后重试。';
  return error?.message || '本地存储操作失败，请检查浏览器设置或可用空间后重试。';
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function revoke(urls) { urls.forEach(url => URL.revokeObjectURL(url)); urls.length = 0; }
function show(dialog) { if (!dialog.open) dialog.showModal(); }
function setEditorError(message = '', allowBackup = false) {
  editorError.textContent = message;
  editorError.hidden = !message;
  $('#editor-backup').hidden = !allowBackup;
}
function warning(message) { const node = $('#storage-warning'); node.textContent = message; node.hidden = !message; }

async function refresh() {
  const sequence = ++refreshSequence;
  const state = await readLocal();
  if (sequence !== refreshSequence) return;
  memories = state.memories.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  displayRevision = state.revision;
  dbReady = true;
  render();
}
const syncController = createSyncController({
  canAutoSync: () => !editor.open && !backupBusy,
  onStatus: ({ message, conflict }) => {
    $('#sync-status').textContent = message;
    $('#sync-form-status').textContent = message;
    $('#sync-panel').classList.toggle('conflict', conflict);
    $('#sync-backup').hidden = !conflict;
  },
  onDataChanged: () => {
    channel?.postMessage('sync-state');
    refresh().catch(error => warning(errorMessage(error)));
  }
});
function changed() { channel?.postMessage('local-change'); syncController.localChanged(); }
if (channel) channel.onmessage = event => {
  if (event.data === 'settings') syncController.externalSettingsChanged();
  if (event.data === 'local-change') syncController.localChanged();
  refresh().catch(error => warning(errorMessage(error)));
};
syncController.start();

function route() {
  const inApp = location.hash === '#/app';
  landing.hidden = inApp;
  app.hidden = !inApp;
  document.title = inApp ? '我们的回忆 · Ours' : 'Ours · 把一起的日子慢慢记下来';
  if (inApp) {
    window.scrollTo(0, 0);
    refresh().catch(error => {
      dbReady = false;
      warning(errorMessage(error));
      content.replaceChildren(el('p', 'form-error', '无法读取回忆，请检查本地存储设置后刷新页面。'));
    });
  }
}
window.addEventListener('hashchange', route);
route();

function emptyState(searching) {
  const box = el('div', 'empty-state');
  const art = el('div', 'empty-art');
  art.setAttribute('aria-hidden', 'true');
  const sheet = el('div', 'empty-sheet');
  sheet.append(el('div'), el('span'));
  art.append(sheet, el('span', 'empty-spark', '✳'));
  box.append(art, el('h2', '', searching ? '没有找到相关回忆' : '从第一条回忆开始'));
  box.append(el('p', '', searching ? '换个词再找找，或者清除搜索条件。' : '一张照片、一段话，或今天的好天气，都可以从这里开始。'));
  const button = el('button', 'button button-primary', searching ? '清除搜索' : '＋ 写一条回忆');
  button.type = 'button';
  button.addEventListener('click', () => {
    if (searching) { $('#search').value = ''; render(); }
    else openEditor();
  });
  box.append(button);
  return box;
}
function card(memory, revision) {
  const article = el('article', 'memory-card');
  const top = el('div', 'memory-card-top');
  const date = el('div', 'memory-date', `${Number(memory.date.slice(5, 7))}月 ${Number(memory.date.slice(8, 10))}日`);
  date.append(el('span', 'memory-year', `${memory.date.slice(0, 4)} 年`));
  const menu = el('div', 'memory-menu');
  const edit = el('button', '', '编辑'); edit.type = 'button'; edit.setAttribute('aria-label', `编辑 ${memory.date} 的回忆`); edit.addEventListener('click', () => openEditor(memory, revision));
  const remove = el('button', '', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', `删除 ${memory.date} 的回忆`); remove.addEventListener('click', () => removeMemory(memory, revision));
  menu.append(edit, remove); top.append(date, menu); article.append(top);
  if (memory.text) article.append(el('p', 'memory-text', memory.text));
  if (memory.media.length) {
    const gallery = el('div', `memory-media${memory.media.length === 1 ? ' single' : ''}`);
    memory.media.forEach((item, index) => {
      const url = URL.createObjectURL(item.blob); listUrls.push(url);
      const media = document.createElement(item.type.startsWith('video/') ? 'video' : 'img');
      media.src = url;
      if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata'; media.setAttribute('playsinline', ''); media.setAttribute('aria-label', `回忆视频 ${index + 1}`); }
      else { media.alt = `回忆图片 ${index + 1}`; media.loading = 'lazy'; }
      gallery.append(media);
    });
    article.append(gallery);
  }
  article.append(el('div', 'memory-footer', '留给以后的我们 ♡'));
  return article;
}
function render() {
  revoke(listUrls);
  content.replaceChildren();
  const query = $('#search').value.trim().toLocaleLowerCase();
  const visible = memories.filter(memory => memory.text.toLocaleLowerCase().includes(query));
  $('#memory-count').textContent = memories.length ? `已经收藏 ${memories.length} 条回忆，慢慢翻看吧。` : '每一个平凡的瞬间，都值得收藏。';
  if (!visible.length) { content.append(emptyState(Boolean(query))); return; }
  let month = '';
  let grid;
  for (const memory of visible) {
    const nextMonth = memory.date.slice(0, 7);
    if (nextMonth !== month) {
      month = nextMonth;
      const group = el('section', 'month-group');
      group.append(el('h2', 'month-title', `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`));
      grid = el('div', 'memory-grid'); group.append(grid); content.append(group);
    }
    grid.append(card(memory, displayRevision));
  }
}
$('#search').addEventListener('input', render);

function openEditor(memory = null, revision = displayRevision) {
  if (!dbReady) { notify('本地存储尚未就绪，请检查页面提示。'); return; }
  editing = memory;
  editingRevision = revision;
  $('#save-copy').hidden = true;
  draftMedia = memory ? [...memory.media] : [];
  $('#editor-title').textContent = memory ? '编辑回忆' : '写一条回忆';
  dateInput.value = memory?.date || today();
  textInput.value = memory?.text || '';
  mediaInput.value = '';
  setEditorError();
  renderEditorMedia();
  show(editor);
}
function closeEditor() { if (!saving && editor.open) editor.close(); }
function renderEditorMedia() {
  revoke(editorUrls);
  const container = $('#editor-media'); container.replaceChildren();
  draftMedia.forEach((item, index) => {
    const box = el('div', 'editor-media-item');
    const media = document.createElement(item.type.startsWith('video/') ? 'video' : 'img');
    const url = URL.createObjectURL(item.blob); editorUrls.push(url); media.src = url;
    if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata'; media.setAttribute('playsinline', ''); media.setAttribute('aria-label', `已选择的视频 ${index + 1}`); }
    else media.alt = `已选择的图片 ${index + 1}`;
    const remove = el('button', 'remove-media', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除媒体 ${index + 1}`);
    remove.addEventListener('click', () => { draftMedia.splice(index, 1); renderEditorMedia(); });
    box.append(media, remove); container.append(box);
  });
}
mediaInput.addEventListener('change', () => {
  const files = [...mediaInput.files]; mediaInput.value = '';
  if (draftMedia.length + files.length > 9) { setEditorError('每条回忆最多添加 9 个照片或视频，请减少选择后重试。'); return; }
  if (files.some(file => !/^(image|video)\/[a-zA-Z0-9.+_-]+$/.test(file.type) || !file.size || file.size > MAX_MEDIA || file.name.length > 255)) {
    setEditorError('请选择不超过 100 MB、文件名不超过 255 字的有效图片或视频。'); return;
  }
  draftMedia.push(...files.map(file => ({ id: newId(), name: file.name, type: file.type, blob: file })));
  setEditorError(); renderEditorMedia();
});
editor.addEventListener('close', () => { revoke(editorUrls); draftMedia = []; editing = null; editingRevision = null; syncController.resume(); });
editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$$('[data-new]').forEach(button => button.addEventListener('click', () => openEditor()));
$$('[data-close-editor]').forEach(button => button.addEventListener('click', closeEditor));
async function saveDraft(asCopy = false) {
  if (saving) return;
  const text = textInput.value.trim();
  if (!validDate(dateInput.value)) { setEditorError('请选择有效的回忆日期。'); return; }
  if (!text && !draftMedia.length) { setEditorError('写点文字，或者添加照片、视频后再保存。'); return; }
  const now = Date.now();
  const wasEditing = Boolean(editing) && !asCopy;
  const memory = { id: wasEditing ? editing.id : newId(), date: dateInput.value, text, createdAt: wasEditing ? editing.createdAt : now, updatedAt: now, media: [...draftMedia] };
  saving = true; $('#save-memory').disabled = true; $('#save-copy').disabled = true; $('#save-memory').textContent = '正在保存…'; setEditorError();
  try {
    await saveMemory(memory, asCopy ? { insertOnly: true } : { expectedRevision: editingRevision, insertOnly: !wasEditing });
    saving = false; editor.close();
    changed();
    notify(wasEditing ? '回忆已更新' : '回忆已保存');
    await refresh();
  } catch (error) {
    if (error.name === 'StaleMemoryError') $('#save-copy').hidden = false;
    if (editor.open) setEditorError(`保存失败：${errorMessage(error)}`, error.name === 'BackupLimitError');
    else warning(`回忆已保存，但列表刷新失败：${errorMessage(error)}`);
  } finally { saving = false; $('#save-memory').disabled = false; $('#save-copy').disabled = false; $('#save-memory').textContent = '保存回忆'; }
}
editorForm.addEventListener('submit', event => { event.preventDefault(); saveDraft(); });
$('#save-copy').addEventListener('click', () => saveDraft(true));
async function removeMemory(memory, revision) {
  let settings;
  try { ({ settings } = await readSyncSettings()); }
  catch (error) { notify(`无法检查同步设置，未删除：${errorMessage(error)}`); return; }
  let syncNotice = '尚未配置同步，此次删除仅发生在本机。';
  if (settings.enabled) {
    syncNotice = '删除可能同步到另一台设备；如果另一台设备同时编辑这条回忆，可能产生同步冲突，同步会暂停并提示两端核对。';
  } else if (settings.baseUrl) {
    syncNotice = '同步目前已暂停，删除先发生在本机；重新启用后删除可能同步到另一台设备，如果另一端同时编辑可能产生同步冲突。';
  }
  if (!window.confirm(`确定删除这条回忆吗？文字和媒体会从此设备移除，此操作无法撤销。${syncNotice}`)) return;
  const expectedSyncSettings = { enabled: Boolean(settings.enabled), baseUrl: settings.baseUrl || '' };
  try { await deleteMemory(memory.id, { expectedRevision: revision, expectedSyncSettings }); changed(); notify('回忆已删除'); await refresh(); }
  catch (error) { notify(error.name === 'StaleMemoryError' ? '本机数据已变化，未删除；请刷新列表后重新确认。' : error.name === 'SyncSettingsChangedError' ? error.message : `删除失败：${errorMessage(error)}`); await refresh().catch(() => {}); }
}

function setBackupBusy(busy) {
  backupBusy = busy;
  $('#export-button').disabled = busy;
  importInput.disabled = busy;
  wxImportInput.disabled = busy;
  $('#wx-cancel').disabled = busy;
  $('#wx-report').disabled = busy;
  $('#wx-confirm').disabled = busy || !wxPreview || !wxPreview.toImport.length || wxPreview.overLimit;
  if (!busy) syncController.resume();
}
function clearWxPreview() {
  wxPreview = null;
  wxPreviewBox.hidden = true;
  $('#wx-ready-list').replaceChildren();
  $('#wx-skipped-list').replaceChildren();
  $('#wx-preview-warnings').replaceChildren();
  $('#wx-ready-details').open = false;
  $('#wx-skipped-details').open = false;
  setBackupBusy(backupBusy);
}
$$('[data-open-backup], #editor-backup').forEach(button => button.addEventListener('click', () => { backupStatus.textContent = ''; show(backupDialog); }));
$$('[data-close-backup]').forEach(button => button.addEventListener('click', () => { if (!backupBusy) backupDialog.close(); }));
backupDialog.addEventListener('cancel', event => { if (backupBusy) event.preventDefault(); });
backupDialog.addEventListener('close', clearWxPreview);
$('#export-button').addEventListener('click', async () => {
  if (backupBusy) return;
  setBackupBusy(true); backupStatus.textContent = '正在准备备份，媒体较多时可能需要一些时间…';
  try {
    const current = await listMemories();
    const blob = await createBackup(current);
    const url = URL.createObjectURL(blob);
    const link = el('a'); link.href = url; link.download = `Ours-备份-${today()}.ours`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    backupStatus.textContent = `已准备 ${current.length} 条回忆的备份，请检查浏览器的下载文件。`;
  } catch (error) { backupStatus.textContent = `导出失败：${errorMessage(error)}`; }
  finally { setBackupBusy(false); }
});
importInput.addEventListener('change', async () => {
  const file = importInput.files[0]; importInput.value = '';
  if (!file || backupBusy) return;
  clearWxPreview();
  setBackupBusy(true); backupStatus.textContent = '正在检查备份并导入，请不要关闭页面…';
  try {
    const records = await readBackup(file);
    const result = await importMemories(records);
    changed();
    backupStatus.textContent = `导入完成：新增 ${result.added} 条，跳过已有的 ${result.skipped} 条。`;
    try { await refresh(); } catch (error) { warning(`导入成功，但列表刷新失败：${errorMessage(error)}`); }
  } catch (error) { backupStatus.textContent = errorMessage(error); }
  finally { setBackupBusy(false); }
});

function fillPreviewList(selector, entries, describe) {
  const list = $(selector);
  list.replaceChildren();
  for (const entry of entries.slice(0, 100)) list.append(el('li', '', describe(entry)));
  if (entries.length > 100) list.append(el('li', '', `只显示前 100 条，共 ${entries.length} 条。`));
}
function showWxPreview(parsed, prepared, current) {
  const existing = new Set(current.map(memory => memory.id));
  const toImport = prepared.ready.filter(item => !existing.has(item.memory.id));
  const alreadyPresent = prepared.ready.filter(item => existing.has(item.memory.id));
  const skipped = [...prepared.skipped, ...alreadyPresent.map(item => ({ label: item.label, reason: '网页中已有相同来源和原 ID，不覆盖' }))];
  const overCount = current.length + toImport.length > MAX_RECORDS;
  const overManifest = exceedsBackupManifestLimit([...current, ...toImport.map(item => item.memory)]);
  wxPreview = { toImport, skipped, overLimit: overCount || overManifest };
  $('#wx-preview-summary').textContent = `已检查 ${parsed.parts} 个分卷、${parsed.records.moments.length} 条回忆：拟新增 ${toImport.length} 条，跳过 ${skipped.length} 条（其中 ${alreadyPresent.length} 条已存在）。`;
  const other = prepared.omitted;
  const warnings = [
    ...parsed.warnings,
    `不导入：纪念日 ${other.anniversaries} 条、评论 ${other.comments} 条、点赞 ${other.likes} 条、打卡 ${other.checkins} 条、便签 ${other.notes} 条、吐槽 ${other.rants} 条。`,
    '缺少发生日期的旧回忆，仅在创建时间有效时按小程序使用的 UTC+8 日期还原；无有效创建时间时，网页创建时间按发生日期补记。',
    '媒体类型只根据文件头识别，无法证明文件完整可播放；仅支持 JPEG、PNG、GIF、WebP、MP4、MOV、WebM。',
    '如果不同来源复制后复用了相同的空间 ID 和原始 ID，网页无法区分，会将它们视为同一条回忆。',
  ];
  if (prepared.conflictingSources) warnings.push('备份中的来源空间标识不一致，因此不能安全导入这些回忆。');
  if (overCount) warnings.push(`导入后会超过网页版备份支持的 ${MAX_RECORDS} 条上限。`);
  if (overManifest) warnings.push('导入后的网页版备份目录可能超过 8 MiB 上限。');
  if (overCount || overManifest) {
    const existingOverLimit = current.length > MAX_RECORDS || (overManifest && exceedsBackupManifestLimit(current));
    warnings.push(existingOverLimit
      ? '本机现有回忆可能已超过单个 .ours 备份上限，完整导出可能失败；请保留浏览器数据，暂勿删除回忆。'
      : '请先导出当前备份，再减少记录或文字并重新预览。');
  }
  const warningList = $('#wx-preview-warnings'); warningList.replaceChildren();
  for (const message of warnings) warningList.append(el('li', '', message));
  fillPreviewList('#wx-ready-list', toImport, item => {
    const excerpt = item.memory.text.replace(/\s+/g, ' ').slice(0, 120) || '无文字';
    return `${item.label}：${item.memory.date}；${excerpt}；${item.memory.media.length} 个媒体`;
  });
  fillPreviewList('#wx-skipped-list', skipped, item => `${item.label}：${item.reason}`);
  $('#wx-ready-details').hidden = !toImport.length;
  $('#wx-skipped-details').hidden = !skipped.length;
  $('#wx-report').hidden = !skipped.length;
  wxPreviewBox.hidden = false;
  setBackupBusy(backupBusy);
}
wxImportInput.addEventListener('change', async () => {
  const files = [...wxImportInput.files]; wxImportInput.value = '';
  if (!files.length || backupBusy) return;
  clearWxPreview();
  setBackupBusy(true); backupStatus.textContent = '正在只读检查全部分卷，请不要关闭页面…';
  try {
    const parsed = await parseWxBackup(files);
    const prepared = await prepareWxMemories(parsed);
    const current = await listMemories();
    showWxPreview(parsed, prepared, current);
    backupStatus.textContent = '检查完成，尚未写入任何记录。请阅读预览后决定是否导入。';
  } catch (error) {
    backupStatus.textContent = `检查失败，未导入任何记录：${errorMessage(error)}`;
  } finally { setBackupBusy(false); }
});
$('#wx-cancel').addEventListener('click', () => {
  if (backupBusy) return;
  clearWxPreview();
  backupStatus.textContent = '已取消小程序导入，未写入任何记录。';
});
$('#wx-report').addEventListener('click', () => {
  if (!wxPreview || backupBusy) return;
  const lines = ['小程序备份导入：跳过的回忆', '', ...wxPreview.skipped.map(item => `${item.label}：${item.reason}`)];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
  const link = el('a'); link.href = url; link.download = 'Ours-小程序导入跳过清单.txt'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
$('#wx-confirm').addEventListener('click', async () => {
  if (backupBusy || !wxPreview || !wxPreview.toImport.length || wxPreview.overLimit) return;
  const preview = wxPreview;
  setBackupBusy(true); backupStatus.textContent = '正在一次性导入，请不要关闭页面…';
  let result;
  try {
    result = await importMemories(preview.toImport.map(item => item.memory), { maxTotal: MAX_RECORDS, maxManifestBytes: MAX_MANIFEST });
  } catch (error) {
    backupStatus.textContent = `导入失败，事务已回滚，没有写入任何新记录：${errorMessage(error)}`;
    setBackupBusy(false);
    return;
  }
  clearWxPreview();
  backupStatus.textContent = `小程序导入完成：新增 ${result.added} 条，预览时跳过 ${preview.skipped.length} 条，确认时因已有同 ID 又跳过 ${result.skipped} 条。原始备份未删除。`;
  try { changed(); await refresh(); }
  catch (error) { warning(`导入成功，但列表刷新失败：${errorMessage(error)}`); }
  finally { setBackupBusy(false); }
});

let syncSettingsBusy = false;
let credentialInputOrigin = '';
function syncInputOrigin() {
  try { return normalizeOrigin($('#sync-url').value.trim()); }
  catch { return ''; }
}
$('#sync-token').addEventListener('input', () => { credentialInputOrigin = syncInputOrigin(); });
$('#sync-url').addEventListener('input', () => {
  if ($('#sync-token').value && (!credentialInputOrigin || syncInputOrigin() !== credentialInputOrigin)) {
    $('#sync-token').value = '';
    credentialInputOrigin = '';
    $('#sync-form-status').textContent = '服务地址已更改，请重新输入该服务的共享凭证。';
  }
});
$$('[data-open-sync]').forEach(button => button.addEventListener('click', async () => {
  $('#sync-form-status').textContent = syncController.message;
  $('#sync-token').value = '';
  try {
    const { settings } = await readSyncSettings();
    $('#sync-enabled').checked = settings.enabled;
    $('#sync-url').value = settings.baseUrl;
    show(syncDialog);
  } catch (error) { warning(errorMessage(error)); }
}));
$$('[data-close-sync]').forEach(button => button.addEventListener('click', () => { if (!syncSettingsBusy) syncDialog.close(); }));
syncDialog.addEventListener('cancel', event => { if (syncSettingsBusy) event.preventDefault(); });
syncDialog.addEventListener('close', () => { $('#sync-token').value = ''; });
$('#sync-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (syncSettingsBusy) return;
  syncSettingsBusy = true;
  $('#sync-save').disabled = true; $('#sync-now').disabled = true;
  $('#sync-form-status').textContent = '正在保存设置…';
  try {
    const enabled = $('#sync-enabled').checked;
    await syncController.saveSettings({ enabled, baseUrl: $('#sync-url').value, token: $('#sync-token').value });
    $('#sync-token').value = '';
    $('#sync-form-status').textContent = enabled ? '设置已保存，尚未确认服务连接。' : '同步已暂停，历史与待处理日志会保留。';
    channel?.postMessage('settings');
  } catch (error) { $('#sync-form-status').textContent = errorMessage(error); }
  finally { syncSettingsBusy = false; $('#sync-save').disabled = false; $('#sync-now').disabled = false; }
});
$('#sync-now').addEventListener('click', () => { if (!syncSettingsBusy) syncController.run(); });

$$('[data-open-install]').forEach(button => button.addEventListener('click', () => { $('#install-status').textContent = ''; show(installDialog); }));
$$('[data-close-install]').forEach(button => button.addEventListener('click', () => installDialog.close()));
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('#install-button').hidden = false; });
$('#install-button').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt; installPrompt = null; $('#install-button').hidden = true;
  try { await prompt.prompt(); const choice = await prompt.userChoice; $('#install-status').textContent = choice.outcome === 'accepted' ? '已请求安装，请按照浏览器提示完成。' : '你可以稍后从浏览器菜单安装。'; }
  catch { $('#install-status').textContent = '请使用浏览器菜单中的安装选项。'; }
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-button').hidden = true; notify('Ours 已添加到设备'); });

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' }).catch(() => warning('离线功能暂未准备好；请联网重新打开，重要回忆请及时备份。'));
} else warning('当前环境不支持离线缓存；请通过 HTTPS 或本机开发地址使用，并及时备份。');
