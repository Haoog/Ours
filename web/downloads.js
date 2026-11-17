// 首页下载区的渲染层：只负责把 releases.json 变成 DOM。
// 拿不到清单时保留 HTML 里的静态说明，不假装有版本可以下载。

import { parseReleases, describeDownload, statusLabel } from './releases.js';

const container = document.getElementById('download-options');
const statusLine = document.getElementById('download-status');

if (container) load(container).catch(error => {
  // 离线、部署缺文件、清单写坏都会走到这里：保持静态内容，只补一句说明。
  container.dataset.state = 'unavailable';
  container.setAttribute('aria-busy', 'false');
  if (statusLine) {
    statusLine.hidden = false;
    statusLine.textContent = '暂时读不到版本清单，下面显示的是默认说明。网页版仍然可以直接使用。';
  }
  console.warn('读取发布清单失败：', error);
});

async function load(box) {
  box.dataset.state = 'loading';
  const response = await fetch('./releases.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const model = parseReleases(await response.json());
  if (model.platforms.length === 0) throw new Error('发布清单里没有平台');
  render(box, model);
  box.dataset.state = 'ready';
  box.setAttribute('aria-busy', 'false');
  if (statusLine) {
    statusLine.hidden = false;
    statusLine.textContent = model.updatedAt
      ? `版本信息更新于 ${model.updatedAt}。`
      : '这是当前的版本信息。';
  }
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function render(box, model) {
  const fragment = document.createDocumentFragment();
  for (const platform of model.platforms) fragment.append(renderPlatform(platform));
  if (model.changelog.length > 0) fragment.append(renderChangelog(model.changelog));
  fragment.append(text('p', 'download-help',
    '安装包没有经过应用商店签名分发：下载后第一次打开可能需要手动允许。请核对校验和，从这一页下载。'));
  box.replaceChildren(fragment);
}

function renderPlatform(platform) {
  const wrapper = document.createElement('div');
  wrapper.className = 'download-option';
  wrapper.dataset.state = platform.status;

  if (platform.status === 'published') {
    for (const download of platform.downloads) wrapper.append(renderDownloadRow(platform, download));
    if (platform.note) wrapper.append(text('p', 'download-note', platform.note));
    return wrapper;
  }

  const row = document.createElement('div');
  row.className = 'download-option-row';
  const info = document.createElement('div');
  info.append(text('strong', '', platform.name));
  if (platform.detail) info.append(text('span', '', platform.detail));
  row.append(info);

  if (platform.status === 'available' && platform.cta) {
    const link = document.createElement('a');
    link.href = platform.cta.href;
    link.textContent = `${platform.cta.label} ↗`;
    row.append(link);
  } else {
    row.append(text('span', 'coming', statusLabel(platform.status)));
  }
  wrapper.append(row);
  if (platform.note) wrapper.append(text('p', 'download-note', platform.note));
  return wrapper;
}

function renderDownloadRow(platform, download) {
  const row = document.createElement('div');
  row.className = 'download-option-row';
  const info = document.createElement('div');
  const label = download.label ? `${platform.name} · ${download.label}` : platform.name;
  info.append(text('strong', '', label));
  info.append(text('span', '', describeDownload(download)));
  if (download.notes) info.append(text('p', 'download-notes', download.notes));
  row.append(info);

  const action = document.createElement('div');
  action.className = 'download-option-action';
  const link = document.createElement('a');
  link.className = 'download-link';
  link.href = download.url;
  link.setAttribute('download', download.file);
  link.textContent = '下载 ↓';
  action.append(link);
  action.append(text('span', 'download-checksum', `sha256 ${download.sha256.slice(0, 12)}…`));
  row.append(action);
  return row;
}

function renderChangelog(entries) {
  const section = document.createElement('div');
  section.className = 'download-changelog';
  section.append(text('p', 'section-kicker', '最近更新'));
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'download-changelog-item';
    item.append(text('strong', '', entry.version));
    item.append(text('span', '', entry.releasedAt));
    item.append(text('p', '', entry.notes));
    section.append(item);
  }
  return section;
}
