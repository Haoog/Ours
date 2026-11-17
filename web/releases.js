// 发布清单的校验与展示逻辑。
// 页面只负责渲染，规则集中在这里，方便用 node --test 直接测。
// 清单的格式说明见 README「发布安装包」。

export const RELEASE_SCHEMA_VERSION = 1;

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

const STATUSES = new Set(['available', 'published', 'unpublished']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 只接受站内相对路径和 https：清单是可编辑文件，不能让一个笔误变成任意跳转。
const SAFE_HREF_PATTERN = /^(?:#|\.\/|https:\/\/)/;

function readText(value, field, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ReleaseError(`${field} 缺失`);
    return '';
  }
  if (typeof value !== 'string') throw new ReleaseError(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ReleaseError(`${field} 不能为空`);
  return trimmed;
}

function readDate(value, field) {
  const date = readText(value, field);
  if (!DATE_PATTERN.test(date)) throw new ReleaseError(`${field} 必须是 YYYY-MM-DD：${date}`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new ReleaseError(`${field} 不是有效日期：${date}`);
  }
  return date;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

// 只比较 major.minor.patch；同号时预发布版本排在正式版前面。
export function compareVersions(a, b) {
  const parts = version => version.split('-')[0].split('.').map(Number);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  const preLeft = a.includes('-');
  const preRight = b.includes('-');
  if (preLeft !== preRight) return preLeft ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function readDownload(raw, platformId, index) {
  const field = `${platformId}.downloads[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError(`${field} 必须是对象`);
  const version = readText(raw.version, `${field}.version`);
  if (!VERSION_PATTERN.test(version)) throw new ReleaseError(`${field}.version 不合法：${version}`);
  const releasedAt = readDate(raw.releasedAt, `${field}.releasedAt`);
  const url = readText(raw.url, `${field}.url`);
  if (!SAFE_HREF_PATTERN.test(url)) throw new ReleaseError(`${field}.url 只能是相对路径或 https 链接：${url}`);
  if (url.includes('..')) throw new ReleaseError(`${field}.url 不能跳出站点目录：${url}`);
  const file = readText(raw.file, `${field}.file`);
  if (!SAFE_FILE_PATTERN.test(file) || file === '.' || file === '..') {
    throw new ReleaseError(`${field}.file 只能是文件名，不能带路径：${file}`);
  }
  if (!Number.isInteger(raw.bytes) || raw.bytes <= 0) throw new ReleaseError(`${field}.bytes 必须是正整数`);
  const sha256 = readText(raw.sha256, `${field}.sha256`).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new ReleaseError(`${field}.sha256 必须是 64 位十六进制`);
  return {
    version,
    releasedAt,
    url,
    file,
    bytes: raw.bytes,
    sha256,
    label: readText(raw.label, `${field}.label`, { required: false }),
    minOS: readText(raw.minOS, `${field}.minOS`, { required: false }),
    notes: readText(raw.notes, `${field}.notes`, { required: false }),
  };
}

function readPlatform(raw, index, seen) {
  const field = `platforms[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError(`${field} 必须是对象`);
  const id = readText(raw.id, `${field}.id`);
  if (!ID_PATTERN.test(id)) throw new ReleaseError(`平台 id 不合法：${id}`);
  if (seen.has(id)) throw new ReleaseError(`平台 id 重复：${id}`);
  seen.add(id);
  const status = readText(raw.status, `${id}.status`);
  if (!STATUSES.has(status)) throw new ReleaseError(`${id}.status 只能是 ${[...STATUSES].join(' / ')}`);
  const name = readText(raw.name, `${id}.name`);
  const detail = readText(raw.detail, `${id}.detail`, { required: false });
  const note = readText(raw.note, `${id}.note`, { required: false });

  let cta = null;
  if (status === 'available') {
    const value = raw.cta;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReleaseError(`${id} 是可直接使用的平台，必须提供 cta`);
    const href = readText(value.href, `${id}.cta.href`);
    if (!SAFE_HREF_PATTERN.test(href)) throw new ReleaseError(`${id}.cta.href 只能是相对路径或 https 链接：${href}`);
    cta = { label: readText(value.label, `${id}.cta.label`), href };
  }

  let downloads = [];
  if (status === 'published') {
    if (!Array.isArray(raw.downloads) || raw.downloads.length === 0) {
      throw new ReleaseError(`${id} 标成了已发布，但没有 downloads`);
    }
    downloads = raw.downloads
      .map((download, downloadIndex) => readDownload(download, id, downloadIndex))
      .sort((left, right) => compareVersions(right.version, left.version));
  } else if (Array.isArray(raw.downloads) && raw.downloads.length > 0) {
    throw new ReleaseError(`${id} 不是已发布状态，却带了 downloads`);
  }

  // 未发布的平台必须写清楚为什么，避免页面上出现一个没有解释的空档位。
  if (status === 'unpublished' && !note) throw new ReleaseError(`${id} 未发布时必须写明 note`);

  return { id, name, detail, status, cta, note, downloads };
}

function readChangelogEntry(raw, index) {
  const field = `changelog[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError(`${field} 必须是对象`);
  const version = readText(raw.version, `${field}.version`);
  if (!VERSION_PATTERN.test(version)) throw new ReleaseError(`${field}.version 不合法：${version}`);
  return {
    version,
    releasedAt: readDate(raw.releasedAt, `${field}.releasedAt`),
    notes: readText(raw.notes, `${field}.notes`),
  };
}

// 把 releases.json 解析成页面可直接使用的模型；任何一条不合格都会抛错，
// 而不是让页面显示半真半假的数据。
export function parseReleases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError('发布清单必须是对象');
  if (raw.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new ReleaseError(`发布清单版本不受支持：${raw.schemaVersion}`);
  }
  const platforms = raw.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) throw new ReleaseError('发布清单里没有平台');
  const seen = new Set();
  const changelog = Array.isArray(raw.changelog) ? raw.changelog : [];
  return {
    updatedAt: readText(raw.updatedAt, 'updatedAt', { required: false }),
    platforms: platforms.map((platform, index) => readPlatform(platform, index, seen)),
    changelog: changelog
      .map((entry, index) => readChangelogEntry(entry, index))
      .sort((left, right) => compareVersions(right.version, left.version)),
  };
}

export function describeDownload(download) {
  return [download.version, download.releasedAt, formatBytes(download.bytes), download.minOS]
    .filter(Boolean)
    .join(' · ');
}

export function latestDownload(downloads) {
  return downloads.length > 0 ? downloads[0] : null;
}

export function statusLabel(status) {
  if (status === 'available') return '可以直接使用';
  if (status === 'published') return '可以下载';
  return '未发布';
}
