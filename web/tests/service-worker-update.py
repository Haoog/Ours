#!/usr/bin/env python3
"""Exercise actual builds and Service Worker updates in a Chromium browser.

Requires the Python playwright package and a Playwright Chromium installation.
Set CHROME_PATH to use an existing Chrome/Chromium executable instead.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from playwright.sync_api import sync_playwright


WEB = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XrWQAAAAASUVORK5CYII=')

# The old cache-first strategy, kept here to exercise v1 migration.
LEGACY_WORKER = '''const CACHE_PREFIX = `ours-web-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE = `${CACHE_PREFIX}v1`;
const ASSETS = ['./', './index.html', './styles.css', './app.js', './storage.js', './backup.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-180.png', './assets/icon-192.png', './assets/icon-512.png', './assets/walk.svg', './assets/evening.svg', './assets/table.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', scope).href)));
  } else {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
'''


def build_inputs(root):
    files = [item for item in root.iterdir() if item.is_file() and
             (item.suffix in ('.js', '.mjs', '.css', '.html', '.webmanifest') or item.name == 'package.json')]
    files.append(root / 'scripts/build.mjs')
    for directory in ('assets', 'vendor'):
        folder = root / directory
        if folder.is_dir():
            files.extend(item for item in folder.rglob('*') if item.is_file())
    return sorted(files)


def source_signature(root):
    # Detect parallel edits to files that can affect the build being exercised.
    digest = hashlib.sha256()
    for item in build_inputs(root):
        digest.update(item.relative_to(root).as_posix().encode() + b'\0')
        digest.update(item.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def build_fixture(work, snapshot, version, entry_only=False):
    source = work / ('source-' + version)
    shutil.copytree(snapshot, source)
    app = source / 'app.js'
    app.write_text(app.read_text(encoding='utf-8') +
                   "\ndocument.documentElement.dataset.updateTestJs = '" + version + "';\n", encoding='utf-8')
    other_version = 'old' if entry_only else version
    # This asset is never requested online; an offline fetch must use the build's precache list.
    (source / 'assets/update-test-extra.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>' + other_version + '</text></svg>', encoding='utf-8')
    for module in ('storage', 'backup', 'sync', 'sync-engine'):
        script = source / (module + '.js')
        script.write_text(script.read_text(encoding='utf-8') +
                          '\nglobalThis[' + json.dumps('updateTest_' + module) + '] = ' +
                          json.dumps(other_version) + ';\n', encoding='utf-8')
    css = source / 'styles.css'
    css.write_text(css.read_text(encoding='utf-8') +
                   '\nhtml { --update-test-css: ' + version + '; }\n', encoding='utf-8')
    index = source / 'index.html'
    index.write_text(index.read_text(encoding='utf-8').replace(
        '<head>', '<head>\n  <meta name="update-test-html" content="' + other_version + '">', 1), encoding='utf-8')
    result = subprocess.run(['npm', 'run', 'build'], cwd=source, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return source / 'dist'


class Server(ThreadingHTTPServer):
    # Chrome opens several module and asset connections at once. The default
    # five-slot backlog can reset requests before a test handler accepts them.
    request_queue_size = 64

    def __init__(self, root):
        super().__init__(('127.0.0.1', 0), Handler)
        self.root = root.resolve()
        self.online = True
        self.fail_paths = set()
        self.requests = []
        self.request_details = []
        self.lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def record_request(self, path, status):
        with self.server.lock:
            self.server.requests.append((path, status, self.headers.get('Cache-Control', '')))
            self.server.request_details.append({
                'url': self.path, 'status': status,
                'cache_control': self.headers.get('Cache-Control', ''),
                'if_none_match': self.headers.get('If-None-Match', ''),
            })

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        file = (self.server.root / path.lstrip('/')).resolve()
        if not file.is_relative_to(self.server.root):
            self.record_request(path, 403)
            self.send_error(403)
            return
        if file.is_dir():
            file = file / 'index.html'
        if not self.server.online or (path in self.server.fail_paths and urlsplit(self.path).query.startswith('v=')):
            self.record_request(path, 503)
            self.send_error(503)
            return
        if not file.is_file():
            self.record_request(path, 404)
            self.send_error(404)
            return
        body = file.read_bytes()
        etag = '"' + hashlib.sha256(body).hexdigest() + '"'
        status = 304 if self.headers.get('If-None-Match') == etag else 200
        self.record_request(path, status)
        self.send_response(status)
        types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                 '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
                 '.png': 'image/png', '.webmanifest': 'application/manifest+json'}
        self.send_header('Content-Type', types.get(file.suffix, 'application/octet-stream'))
        # Force the worker to cope with an otherwise long-lived browser HTTP cache.
        self.send_header('Cache-Control', 'public, max-age=31536000')
        self.send_header('ETag', etag)
        self.send_header('Content-Length', str(len(body) if status == 200 else 0))
        self.end_headers()
        if status == 200:
            self.wfile.write(body)


def deploy(build, root, scope):
    destination = root / scope.strip('/')
    shutil.copytree(build, destination, dirs_exist_ok=True)


def versions(page):
    return page.evaluate('''() => ({
      html: document.querySelector('meta[name="update-test-html"]')?.content,
      js: document.documentElement.dataset.updateTestJs,
      css: getComputedStyle(document.documentElement).getPropertyValue('--update-test-css').trim(),
      storage: globalThis.updateTest_storage,
      backup: globalThis.updateTest_backup,
      sync: globalThis.updateTest_sync,
      sync_engine: globalThis['updateTest_sync-engine']
    })''')


def assert_version(actual, expected):
    if isinstance(expected, str):
        expected = {key: expected for key in ('html', 'js', 'css', 'storage', 'backup', 'sync', 'sync_engine')}
    assert actual == expected, actual


def expect_version(page, expected):
    assert_version(versions(page), expected)


def assert_memory(page, text, expected_record=None):
    page.get_by_text(text, exact=True).wait_for()
    # Compare the whole persisted record, including the original image bytes.
    stored = page.evaluate('''async text => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('ours-web');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise((resolve, reject) => {
        const request = db.transaction('memories').objectStore('memories').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const record = records.find(item => item.text === text);
      if (!record) return null;
      const media = await Promise.all(record.media.map(async item => {
        const {blob, ...metadata} = item;
        return {...metadata, blobType: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer()))};
      }));
      return {...record, media, count: records.length};
    }''', text)
    assert stored and stored['count'] == 1 and stored['date'] == '2026-11-17', stored
    assert len(stored['media']) == 1 and stored['media'][0]['blobType'] == 'image/png', stored
    assert stored['media'][0]['bytes'] == list(PNG), stored
    if expected_record is not None:
        assert stored == expected_record, (stored, expected_record)
    image = page.locator('.memory-card img')
    assert image.count() == 1
    image.scroll_into_view_if_needed()
    page.wait_for_function('''() => {
      const image = document.querySelector('.memory-card img');
      return image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }''')
    return stored


def save_memory(page, text):
    page.get_by_role('link', name='开始记录').click()
    page.locator('.empty-state button').click()
    page.locator('#memory-date').fill('2026-11-17')
    page.locator('#memory-text').fill(text)
    page.locator('#media-input').set_input_files({'name': 'test.png', 'mimeType': 'image/png', 'buffer': PNG})
    page.locator('#save-memory').click()
    return assert_memory(page, text)


def disable_http_cache(page):
    cdp = page.context.new_cdp_session(page)
    cdp.send('Network.enable')
    cdp.send('Network.setCacheDisabled', {'cacheDisabled': True})
    return cdp


def check_offline(context, page, server, url, expected, memory, record, lazy_asset=None):
    # Block at both the browser and server, and avoid browser HTTP cache hits.
    cdp = disable_http_cache(page)
    server.online = False
    context.set_offline(True)
    try:
        for address in (url + '#/app', url + 'index.html?offline=1#/app'):
            page.goto(address, wait_until='load')
            expect_version(page, expected)
            assert_memory(page, memory, record)
        if lazy_asset:
            version, contents = lazy_asset
            try:
                bodies = page.evaluate('''async version => {
                  const bodies = [];
                  for (const suffix of ['?v=' + version, '']) {
                    const response = await fetch('./assets/update-test-extra.svg' + suffix);
                    if (!response.ok) throw new Error('Offline asset status: ' + response.status);
                    bodies.push(await response.text());
                  }
                  return bodies;
                }''', version)
            except Exception as error:
                details = page.evaluate('''async version => {
                  const url = new URL('./assets/update-test-extra.svg?v=' + version, location.href).href;
                  const names = await caches.keys();
                  return {url, controller: navigator.serviceWorker.controller?.scriptURL,
                    caches: await Promise.all(names.map(async name => ({name,
                      entries: (await (await caches.open(name)).keys()).map(request => request.url)})))};
                }''', version)
                raise AssertionError(f'Offline asset fetch failed: {details}') from error
            assert all('<text>' + contents + '</text>' in body for body in bodies), bodies
            fresh_page = context.new_page()
            fresh_cdp = disable_http_cache(fresh_page)
            try:
                fresh_page.goto(url + '?source=homescreen#/app', wait_until='load')
                expect_version(fresh_page, expected)
                assert_memory(fresh_page, memory, record)
            finally:
                fresh_cdp.detach()
                fresh_page.close()
    finally:
        server.online = True
        context.set_offline(False)
        cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
        cdp.detach()


def check_server_error(page, server, url, expected, memory, record):
    # Verify that network requests really receive 503, rather than merely
    # getting successful responses from a browser cache.
    cdp = disable_http_cache(page)
    with server.lock:
        start = len(server.requests)
    server.online = False
    try:
        page.goto(url + '#/app', wait_until='load')
        expect_version(page, expected)
        assert_memory(page, memory, record)
        with server.lock:
            requests = server.requests[start:]
        scope = urlsplit(url).path
        for path in (scope, *(scope + name for name in (
                'styles.css', 'app.js', 'storage.js', 'backup.js', 'sync.js',
                'sync-engine.js', 'wx-import.js', 'wx-prepare.js'))):
            assert any(request_path == path and status == 503 for request_path, status, _ in requests), (path, requests)
    finally:
        server.online = True
        cdp.send('Network.setCacheDisabled', {'cacheDisabled': False})
        cdp.detach()


def run_case(browser, server, base, root, scope, old_build, new_build, legacy=False, entry_only=False):
    deploy(old_build, root, scope)
    context = browser.new_context()
    page = context.new_page()
    errors = []
    failed_requests = []
    console_errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append((request.url, request.failure)))
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    bad_responses = []
    page.on('response', lambda response: bad_responses.append((response.url, response.status)) if response.status >= 400 else None)
    with server.lock:
        start = len(server.requests)
    try:
        page.goto(base + scope, wait_until='networkidle')
        try:
            expect_version(page, 'old')
        except AssertionError as error:
            with server.lock:
                requests = server.requests[start:]
            raise AssertionError(
                f'{error}; requests={requests}; failures={failed_requests}; '
                f'HTTP errors={bad_responses}; console={console_errors}; page errors={errors}'
            ) from error
        page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller')
        memory = '更新回归记录：' + ('旧版迁移 ' if legacy else '常规更新 ') + scope
        record = save_memory(page, memory)
        other_cache = 'ours-web-%2Fjournal%2F-v-check' if scope == '/' else 'ours-web-%2F-v-check'
        page.evaluate('(name) => caches.open(name)', other_cache)
        check_offline(context, page, server, base + scope, 'old', memory, record)
        # Offline navigation may deliberately fail requests; report only the
        # diagnostics belonging to the first online update below.
        failed_requests.clear()
        console_errors.clear()
        bad_responses.clear()

        with server.lock:
            start = len(server.requests)
        deploy(new_build, root, scope)
        page.reload(wait_until='networkidle')
        first_refresh = versions(page)
        with server.lock:
            requests = server.requests[start:]
        expected = {'html': 'old', 'js': 'entry', 'css': 'entry', 'storage': 'old', 'backup': 'old',
                    'sync': 'old', 'sync_engine': 'old'} if entry_only else 'new'
        try:
            expect_version(page, expected)
        except AssertionError as error:
            raise AssertionError(
                f'{error}; requests={requests}; failures={failed_requests}; '
                f'HTTP errors={bad_responses}; console={console_errors}; page errors={errors}'
            ) from error
        assert_memory(page, memory, record)
        for name in ('app.js', 'styles.css', 'storage.js', 'backup.js', 'sync.js', 'sync-engine.js',
                     'wx-import.js', 'wx-prepare.js'):
            assert any(path == scope + name and status == 200 for path, status, _ in requests), (name, requests)

        new_worker = (new_build / 'service-worker.js').read_text(encoding='utf-8')
        new_version = re.search(r"const BUILD_VERSION = '([^']+)';", new_worker).group(1)
        page.evaluate('''async version => {
          const deadline = Date.now() + 20000;
          let details;
          while (Date.now() < deadline) {
            const registration = await navigator.serviceWorker.getRegistration();
            const prefix = registration && `ours-web-${encodeURIComponent(new URL(registration.scope).pathname)}-`;
            const key = prefix + 'v2-' + version;
            const keys = await caches.keys();
            details = {keys, state: registration?.active?.state,
              controlsPage: !!registration?.active && navigator.serviceWorker.controller === registration.active};
            if (details.controlsPage && details.state === 'activated' && keys.includes(key) &&
                !keys.some(name => name.startsWith(prefix) && name !== key)) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('New Service Worker did not take control: ' + JSON.stringify(details));
        }''', new_version)
        assert page.evaluate('(name) => caches.has(name)', other_cache), 'another scope cache was removed'
        check_offline(context, page, server, base + scope, expected, memory, record,
                      lazy_asset=(new_version, 'old' if entry_only else 'new'))
        check_server_error(page, server, base + scope, expected, memory, record)
        assert not errors, errors
        scenario = 'v1-migration' if legacy else ('app-css-only' if entry_only else 'unchanged-worker-source')
        print('PASS scope=' + scope + ' scenario=' + scenario +
              ' first-refresh=' + str(first_refresh) +
              ' offline=matches-online fresh-tab=ok lazy-asset=cached server-503=fallback record-and-image=preserved')
        screenshot = os.environ.get('OURS_WEB_SCREENSHOT')
        if screenshot and scope == '/' and not legacy and not entry_only:
            page.screenshot(path=screenshot, full_page=True)
    finally:
        context.close()


def main():
    # Keep all generated releases in a disposable directory inside the workspace.
    with tempfile.TemporaryDirectory(prefix='.ours-web-update-', dir=WEB.parent) as temp:
        work = Path(temp)
        snapshot = work / 'snapshot'
        # Copy build inputs only; never traverse unrelated files or real backups.
        for source in build_inputs(WEB):
            target = snapshot / source.relative_to(WEB)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        old_build = build_fixture(work, snapshot, 'old')
        new_build = build_fixture(work, snapshot, 'new')
        entry_build = build_fixture(work, snapshot, 'entry', entry_only=True)
        for original in (work / 'source-old').rglob('*'):
            relative = original.relative_to(work / 'source-old')
            if original.is_file() and relative.parts[0] != 'dist' and str(relative) not in ('app.js', 'styles.css'):
                assert original.read_bytes() == (work / 'source-entry' / relative).read_bytes(), relative
        assert (work / 'source-old/service-worker.js').read_bytes() == (work / 'source-new/service-worker.js').read_bytes()
        assert (old_build / 'service-worker.js').read_bytes() != (new_build / 'service-worker.js').read_bytes()
        versions_by_release = {
            name: re.search(r"const BUILD_VERSION = '([^']+)';", (build / 'service-worker.js').read_text(encoding='utf-8')).group(1)
            for name, build in (('old', old_build), ('app-css', entry_build), ('new', new_build))
        }
        assert len(set(versions_by_release.values())) == 3, versions_by_release
        legacy_build = work / 'legacy-dist'
        shutil.copytree(old_build, legacy_build)
        # Model a v1 release with unversioned HTML/imports and cache-first assets.
        # Its precache contains this fixture's complete old app, including any new modules.
        for name in ('index.html', 'manifest.webmanifest'):
            shutil.copy2(work / 'source-old' / name, legacy_build / name)
        for script in legacy_build.rglob('*.js'):
            relative = script.relative_to(legacy_build)
            source = work / 'source-old' / relative
            if str(relative) != 'service-worker.js' and source.is_file():
                shutil.copy2(source, script)
        legacy_app = legacy_build / 'app.js'
        legacy_app.write_text(legacy_app.read_text(encoding='utf-8').replace(
            "register('./service-worker.js', { updateViaCache: 'none' })",
            "register('./service-worker.js')"), encoding='utf-8')
        legacy_assets = ['./', './index.html'] + [
            './' + item.relative_to(legacy_build).as_posix()
            for item in sorted(legacy_build.rglob('*'))
            if item.is_file() and item.relative_to(legacy_build).as_posix() not in ('index.html', 'service-worker.js')
        ]
        legacy_worker = re.sub(r'const ASSETS = \[.*?\];',
                               'const ASSETS = ' + json.dumps(legacy_assets) + ';', LEGACY_WORKER, count=1)
        (legacy_build / 'service-worker.js').write_text(legacy_worker, encoding='utf-8')
        root = work / 'deployed'
        root.mkdir()
        server = Server(root)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with sync_playwright() as playwright:
                launch = {'headless': True}
                if os.environ.get('CHROME_PATH'):
                    launch['executable_path'] = os.environ['CHROME_PATH']
                browser = playwright.chromium.launch(**launch)
                try:
                    for scope in ('/', '/journal/'):
                        run_case(browser, server, base, root, scope, old_build, new_build)
                        run_case(browser, server, base, root, scope, old_build, entry_build, entry_only=True)
                        run_case(browser, server, base, root, scope, legacy_build, new_build, legacy=True)
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        snapshot_signature = source_signature(snapshot)
        assert snapshot_signature == source_signature(WEB), 'Web build inputs changed during the test; run it again.'
    print('PASS unchanged Service Worker source produced distinct build versions: ' + str(versions_by_release) +
          '; HTTP cache max-age=31536000; source-sha256=' + snapshot_signature)


if __name__ == '__main__':
    main()
