import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseReleases,
  formatBytes,
  compareVersions,
  describeDownload,
  latestDownload,
  statusLabel,
  ReleaseError,
} from '../releases.js';

const sha = 'a'.repeat(64);

function publishedPlatform(overrides = {}) {
  return {
    id: 'macos',
    name: 'macOS',
    status: 'published',
    downloads: [{
      version: '0.1.0',
      releasedAt: '2026-11-20',
      url: './downloads/Ours-0.1.0-arm64.dmg',
      file: 'Ours-0.1.0-arm64.dmg',
      bytes: 52428800,
      sha256: sha,
    }],
    ...overrides,
  };
}

function doc(platforms, extra = {}) {
  return { schemaVersion: 1, updatedAt: '2026-11-17', platforms, ...extra };
}

test('仓库里的 releases.json 能通过校验', async () => {
  const raw = JSON.parse(await readFile(new URL('../releases.json', import.meta.url), 'utf8'));
  const model = parseReleases(raw);
  assert.ok(model.platforms.length > 0);
  const web = model.platforms.find(platform => platform.id === 'web');
  assert.equal(web.status, 'available');
  assert.equal(web.cta.href, '#/app');
  for (const platform of model.platforms) {
    if (platform.status === 'unpublished') assert.ok(platform.note, `${platform.id} 未发布却没有说明`);
    if (platform.status === 'published') assert.ok(platform.downloads.length > 0);
  }
});

test('未发布的平台必须写清楚原因', () => {
  assert.throws(
    () => parseReleases(doc([{ id: 'ios', name: 'iPhone', status: 'unpublished' }])),
    error => error instanceof ReleaseError && /note/.test(error.message),
  );
});

test('已发布的平台必须有安装包', () => {
  assert.throws(
    () => parseReleases(doc([{ id: 'macos', name: 'macOS', status: 'published' }])),
    /没有 downloads/,
  );
});

test('未发布却带了安装包会被拒绝', () => {
  assert.throws(
    () => parseReleases(doc([publishedPlatform({ status: 'unpublished', note: '还没好' })])),
    /却带了 downloads/,
  );
});

test('安装包地址只允许站内相对路径或 https', () => {
  const bad = [
    'http://example.com/a.dmg',
    'javascript:alert(1)',
    '../../etc/passwd',
  ];
  for (const url of bad) {
    const platform = publishedPlatform();
    platform.downloads[0].url = url;
    assert.throws(() => parseReleases(doc([platform])), ReleaseError, `应当拒绝 ${url}`);
  }
});

test('文件名不能带路径', () => {
  for (const file of ['../a.dmg', 'sub/a.dmg', '.hidden', 'a b.dmg']) {
    const platform = publishedPlatform();
    platform.downloads[0].file = file;
    assert.throws(() => parseReleases(doc([platform])), ReleaseError, `应当拒绝 ${file}`);
  }
});

test('校验和必须是 64 位十六进制', () => {
  for (const value of ['abc', 'z'.repeat(64), sha.slice(0, 32)]) {
    const platform = publishedPlatform();
    platform.downloads[0].sha256 = value;
    assert.throws(() => parseReleases(doc([platform])), /sha256/);
  }
  const platform = publishedPlatform();
  platform.downloads[0].sha256 = sha.toUpperCase();
  assert.equal(parseReleases(doc([platform])).platforms[0].downloads[0].sha256, sha);
});

test('字节数必须是正整数', () => {
  for (const bytes of [0, -1, 1.5, '100']) {
    const platform = publishedPlatform();
    platform.downloads[0].bytes = bytes;
    assert.throws(() => parseReleases(doc([platform])), /bytes/);
  }
});

test('日期必须是真实的 YYYY-MM-DD', () => {
  for (const releasedAt of ['2026-13-01', '2026-2-3', 'yesterday']) {
    const platform = publishedPlatform();
    platform.downloads[0].releasedAt = releasedAt;
    assert.throws(() => parseReleases(doc([platform])), ReleaseError, `应当拒绝 ${releasedAt}`);
  }
});

test('平台 id 不能重复，也不能有奇怪字符', () => {
  assert.throws(() => parseReleases(doc([
    { id: 'ios', name: 'a', status: 'unpublished', note: 'x' },
    { id: 'ios', name: 'b', status: 'unpublished', note: 'y' },
  ])), /重复/);
  assert.throws(() => parseReleases(doc([
    { id: 'Mac OS', name: 'a', status: 'unpublished', note: 'x' },
  ])), /id 不合法/);
});

test('清单版本不对时整体拒绝', () => {
  assert.throws(() => parseReleases({ ...doc([]), schemaVersion: 2 }), /版本不受支持/);
});

test('多个安装包按版本从新到旧排列', () => {
  const platform = publishedPlatform({
    downloads: [
      { version: '0.1.0', releasedAt: '2026-11-01', url: './downloads/a.dmg', file: 'a.dmg', bytes: 10, sha256: sha },
      { version: '0.10.0', releasedAt: '2026-11-10', url: './downloads/b.dmg', file: 'b.dmg', bytes: 10, sha256: sha },
      { version: '0.2.0-rc1', releasedAt: '2026-11-05', url: './downloads/c.dmg', file: 'c.dmg', bytes: 10, sha256: sha },
    ],
  });
  const { downloads } = parseReleases(doc([platform])).platforms[0];
  assert.deepEqual(downloads.map(item => item.version), ['0.10.0', '0.2.0-rc1', '0.1.0']);
  assert.equal(latestDownload(downloads).version, '0.10.0');
});

test('直接可用的平台必须有合法的 cta', () => {
  assert.throws(() => parseReleases(doc([{ id: 'web', name: '网页版', status: 'available' }])), /cta/);
  assert.throws(() => parseReleases(doc([{
    id: 'web', name: '网页版', status: 'available', cta: { label: '打开', href: 'http://x.com' },
  }])), /cta.href/);
});

test('更新日志按版本排序并校验', () => {
  const model = parseReleases(doc([publishedPlatform()], {
    changelog: [
      { version: '0.1.0', releasedAt: '2026-11-01', notes: '第一版' },
      { version: '0.2.0', releasedAt: '2026-11-10', notes: '修了几处' },
    ],
  }));
  assert.deepEqual(model.changelog.map(entry => entry.version), ['0.2.0', '0.1.0']);
  assert.throws(() => parseReleases(doc([publishedPlatform()], {
    changelog: [{ version: 'v1', releasedAt: '2026-11-01', notes: 'x' }],
  })), /version 不合法/);
});

test('版本比较与字节格式化', () => {
  assert.ok(compareVersions('0.2.0', '0.10.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc1') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(52428800), '50.0 MB');
  assert.equal(formatBytes(0), '0 B');
});

test('展示文案把版本、日期、大小和系统要求拼起来', () => {
  const line = describeDownload({
    version: '0.1.0', releasedAt: '2026-11-20', bytes: 52428800, minOS: 'macOS 12 或更新',
  });
  assert.equal(line, '0.1.0 · 2026-11-20 · 50.0 MB · macOS 12 或更新');
  assert.equal(describeDownload({ version: '0.1.0', releasedAt: '2026-11-20', bytes: 1024 }), '0.1.0 · 2026-11-20 · 1.0 KB');
  assert.equal(statusLabel('published'), '可以下载');
  assert.equal(statusLabel('unpublished'), '未发布');
  assert.equal(statusLabel('available'), '可以直接使用');
});
