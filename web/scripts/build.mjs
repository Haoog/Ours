import { cp, mkdir, readFile, access, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js', 'storage.js', 'sync.js', 'sync-engine.js', 'backup.js', 'wx-import.js', 'wx-prepare.js', 'service-worker.js', 'manifest.webmanifest'];
for (const name of ['app.js', 'storage.js', 'sync.js', 'sync-engine.js', 'backup.js', 'wx-import.js', 'wx-prepare.js', 'service-worker.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons) await access(path.join(root, icon.src));

async function assetFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const name = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? assetFiles(name) : [name];
  }));
  return files.flat();
}

// A release-wide fingerprint keeps unchanged source URLs fresh even with long-lived HTTP caches.
const assets = (await assetFiles('assets')).sort();
const precache = ['./', './index.html', ...files.filter(name => name !== 'index.html' && name !== 'service-worker.js').map(name => `./${name}`), ...assets.map(name => `./${name}`)];
const hash = createHash('sha256');
for (const name of [...files, ...assets].sort()) {
  hash.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
}
const version = hash.digest('hex').slice(0, 16);
const versioned = url => `${url}?v=${version}`;

await mkdir(output, { recursive: true });
for (const name of files) {
  const source = path.join(root, name);
  const target = path.join(output, name);
  if (name === 'index.html') {
    const html = await readFile(source, 'utf8');
    // Only static resource attributes are rewritten; navigation URLs stay unchanged.
    const versionedHtml = html.replace(/(\b(?:src|href)\s*=\s*['"])(\.\/[^'"?#]+\.(?:js|css|svg|png|webmanifest))(['"])/g,
      (_match, prefix, url, quote) => `${prefix}${versioned(url)}${quote}`);
    await writeFile(target, versionedHtml);
  } else if (name === 'manifest.webmanifest') {
    for (const icon of manifest.icons) icon.src = versioned(icon.src);
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (name === 'service-worker.js') {
    const worker = await readFile(source, 'utf8');
    const placeholder = "const BUILD_VERSION = 'dev';";
    const assetsPlaceholder = 'const BUILD_ASSETS = null;';
    if (!worker.includes(placeholder) || !worker.includes(assetsPlaceholder)) throw new Error('Service Worker build placeholder is missing');
    await writeFile(target, worker.replace(placeholder, `const BUILD_VERSION = '${version}';`)
      .replace(assetsPlaceholder, `const BUILD_ASSETS = ${JSON.stringify(precache)};`));
  } else if (name.endsWith('.js')) {
    const script = await readFile(source, 'utf8');
    // Version relative module imports as well as the entry point in index.html.
    const versionedScript = script.replace(/\b(from\s*|import\s*(?:\(\s*)?)(['"])(\.{1,2}\/[^'"?#]+\.m?js)\2/g,
      (_match, prefix, quote, url) => `${prefix}${quote}${versioned(url)}${quote}`);
    await writeFile(target, versionedScript);
  } else {
    await cp(source, target);
  }
}
await cp(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });
console.log(`Built static site in web/dist (version ${version}). Serve it over HTTPS (or localhost).`);
