import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncEngine, MAX_MEDIA_BYTES, MAX_RECORDS } from '../sync-engine.js';

// Every server is an isolated copy in an OS temporary directory with a random
// test credential and synthetic data. The real backend's data directory is never used.
async function server(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ours-sync-engine-test-'));
  const source = fileURLToPath(new URL('../../ours-sync/', import.meta.url));
  await Promise.all(['server.js', 'package.json'].map(name => copyFile(join(source, name), join(dir, name))));
  const token = randomBytes(32).toString('base64url');
  let child, port = 0;
  async function start() {
    child = spawn(process.execPath, [join(dir, 'server.js')], {
      cwd: dir, env: { OURS_SYNC_TOKEN: token, OURS_SYNC_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Local test server did not start')), 10000);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Local test server exited before startup')); });
    });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  return { baseUrl: `http://127.0.0.1:${port}`, token, start, stop };
}
function memory(id, text, media = []) {
  return { id, date: '2025-01-15', text, createdAt: 1, updatedAt: 1, media };
}
function medium(id, bytes, type = 'image/png') {
  return { id, name: `${id}.bin`, type, blob: new Blob([new Uint8Array(bytes)], { type }) };
}
function store(initial = []) {
  let generation = 0;
  let state = { revision: '0', memories: structuredClone(initial), baseline: null, pending: null };
  return {
    readLocal: async () => structuredClone(state),
    compareAndSwap: async ({ expectedRevision, nextRevision, memories, baseline, pending }) => {
      if (state.revision !== expectedRevision) return null;
      state = { revision: nextRevision, memories: structuredClone(memories),
        baseline: structuredClone(baseline), pending: structuredClone(pending) };
      return state.revision;
    },
    // A single test owns each store. A real browser must use a cross-tab lock.
    withLock: async callback => callback(),
    change: mutate => {
      const records = structuredClone(state.memories);
      mutate(records);
      state = { ...state, memories: records, revision: String(++generation) };
    },
    state: () => structuredClone(state)
  };
}
function client(remote, local, deviceId, extra = {}) {
  return createSyncEngine({ ...remote, spaceId: 'synthetic-space', deviceId, ...local,
    allowLocalhost: true, ...extra });
}
async function bytes(blob) { return [...new Uint8Array(await blob.arrayBuffer())]; }
async function snapshot(remote) {
  const response = await fetch(`${remote.baseUrl}/v1/snapshot`, { headers: { Authorization: `Bearer ${remote.token}` } });
  assert.equal(response.status, 200);
  return { etag: response.headers.get('etag'), ...(await response.json()) };
}
async function replaceSnapshot(remote, etag, value) {
  return fetch(`${remote.baseUrl}/v1/snapshot`, {
    method: 'PUT', headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify(value)
  });
}
function record(state, id) { return state.memories.find(item => item.id === id); }
function edit(local, id, text) {
  local.change(memories => { const item = memories.find(value => value.id === id); item.text = text; item.updatedAt++; });
}

test('unchanged checks do not re-upload media and notice concurrent local edits', async t => {
  const remote = await server(t);
  const local = store([memory('a', '已有回忆', [medium('image', [1, 2, 3])])]);
  assert.equal((await client(remote, local, 'device').sync()).status, 'synced');
  const before = local.state(), remoteBefore = await snapshot(remote), requests = [];
  const engine = client(remote, local, 'device', { fetch: async (url, options) => {
    requests.push(`${options.method} ${new URL(url).pathname}`);
    return fetch(url, options);
  } });
  assert.equal((await engine.sync()).status, 'synced');
  assert.deepEqual(requests, ['GET /v1/snapshot']);
  assert.deepEqual(local.state(), before);
  assert.deepEqual(await snapshot(remote), remoteBefore);

  let changed = false;
  const racing = client(remote, local, 'device', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (!changed && options.method === 'GET' && new URL(url).pathname === '/v1/snapshot') {
      changed = true;
      local.change(items => items.push(memory('new', '检查期间新增')));
    }
    return response;
  } });
  assert.equal((await racing.sync()).status, 'local_changed');
  assert.ok(record(local.state(), 'new'));
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

test('two clients exchange independent records, edits, and verified binary media', async t => {
  const remote = await server(t);
  const a = store([memory('a', '甲的初始文字', [medium('image-a', [0, 255, 1, 2, 128])])]);
  const b = store([memory('b', '乙的初始文字', [medium('video-b', [42, 0, 17, 255], 'video/mp4')])]);
  const engineA = client(remote, a, 'device-a'), engineB = client(remote, b, 'device-b');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.deepEqual(await bytes(record(b.state(), 'a').media[0].blob), [0, 255, 1, 2, 128]);
  assert.deepEqual(await bytes(record(a.state(), 'b').media[0].blob), [42, 0, 17, 255]);
  assert.equal(record(a.state(), 'b').media[0].blob.type, 'video/mp4');
  edit(a, 'a', '甲独立修改');
  edit(b, 'b', '乙独立修改');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  assert.equal((await engineA.sync()).status, 'synced');
  for (const local of [a, b]) {
    assert.equal(record(local.state(), 'a').text, '甲独立修改');
    assert.equal(record(local.state(), 'b').text, '乙独立修改');
    assert.equal(local.state().pending, null);
  }
  const saved = await snapshot(remote);
  assert.equal(saved.snapshot.spaceId, 'synthetic-space');
  assert.ok(saved.snapshot.clock.some(([id]) => id === 'device-a'));
  assert.ok(saved.snapshot.clock.some(([id]) => id === 'device-b'));
  assert.ok(saved.snapshot.memories.every(item => item.media.every(media => /^[0-9a-f]{64}$/.test(media.sha256))));
  assert.ok(!JSON.stringify(saved.snapshot).includes(remote.token));
});

test('same-record edits retain both versions and do not advance the losing baseline', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  const engineA = client(remote, a, 'a'), engineB = client(remote, b, 'b');
  await engineA.sync(); await engineB.sync();
  edit(a, 'same', '甲的版本'); edit(b, 'same', '乙的版本');
  await engineA.sync();
  const before = b.state();
  const result = await engineB.sync();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'concurrent-edit');
  assert.equal(result.conflicts[0].base.text, '原文');
  assert.equal(result.conflicts[0].local.text, '乙的版本');
  assert.equal(result.conflicts[0].remote.text, '甲的版本');
  assert.deepEqual(b.state(), before);
  assert.equal((await snapshot(remote)).snapshot.memories[0].text, '甲的版本');
});

test('a deletion propagates while independent additions keep synchronizing', async t => {
  const remote = await server(t), a = store([memory('old', '待删除', [medium('image', [1, 2, 3])])]), b = store();
  const engineA = client(remote, a, 'a'), engineB = client(remote, b, 'b');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  a.change(items => { items.splice(0, 1); items.push(memory('new-a', '甲的新记录')); });
  b.change(items => items.push(memory('new-b', '乙的新记录', [medium('new-image', [4, 5, 6])])));
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  for (const local of [a, b]) {
    assert.deepEqual(local.state().memories.map(item => item.id), ['new-a', 'new-b']);
    assert.deepEqual(await bytes(record(local.state(), 'new-b').media[0].blob), [4, 5, 6]);
    assert.equal(local.state().pending, null);
    assert.deepEqual(local.state().baseline.snapshot.memories.map(item => item.id), ['new-a', 'new-b']);
  }
  const saved = await snapshot(remote);
  assert.deepEqual(saved.snapshot.memories.map(item => item.id), ['new-a', 'new-b']);
  assert.ok(saved.snapshot.clock.some(([id]) => id === 'a'));
  assert.ok(saved.snapshot.clock.some(([id]) => id === 'b'));
});

test('concurrent deletions retry a real ETag race and do not resurrect the record', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  const normalA = client(remote, a, 'a'), engineB = client(remote, b, 'b');
  assert.equal((await normalA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  b.change(items => items.splice(0, 1));
  let intercepted = false;
  const racingA = client(remote, a, 'a', { fetch: async (url, options) => {
    if (!intercepted && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      intercepted = true;
      assert.equal((await engineB.sync()).status, 'synced');
    }
    return fetch(url, options);
  } });
  const result = await racingA.sync();
  assert.equal(result.status, 'synced');
  assert.equal(result.attempts, 2);
  assert.equal(intercepted, true);
  b.change(items => items.push(memory('after', '删除之后')));
  assert.equal((await engineB.sync()).status, 'synced');
  assert.equal((await normalA.sync()).status, 'synced');
  for (const local of [a, b]) {
    assert.deepEqual(local.state().memories.map(item => item.id), ['after']);
    assert.equal(local.state().pending, null);
  }
  assert.deepEqual((await snapshot(remote)).snapshot.memories.map(item => item.id), ['after']);
});

test('a deletion racing an edit retries the ETag and reports edit-delete without advancing the baseline', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  const baseline = a.state().baseline;
  let remoteAfterEdit;
  const racing = client(remote, a, 'a', { fetch: async (url, options) => {
    if (!remoteAfterEdit && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      edit(b, 'same', '另一端的编辑');
      assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
      remoteAfterEdit = await snapshot(remote);
    }
    return fetch(url, options);
  } });
  const result = await racing.sync();
  assert.equal(result.status, 'conflict');
  assert.equal(result.attempts, 2);
  assert.equal(result.conflicts[0].kind, 'edit-delete');
  assert.equal(result.conflicts[0].deletedBy, 'local');
  assert.equal(result.conflicts[0].remote.text, '另一端的编辑');
  assert.equal(a.state().memories.length, 0);
  assert.deepEqual(a.state().baseline, baseline);
  assert.equal(a.state().pending, null);
  assert.deepEqual(await snapshot(remote), remoteAfterEdit);
});

for (const deletedBy of ['local', 'remote']) {
  test(`a ${deletedBy} deletion versus the other client's edit preserves both sides`, async t => {
    const remote = await server(t), a = store([memory('same', '原文', [medium('image', [1, 2, 3])])]), b = store();
    const engineA = client(remote, a, 'a'), engineB = client(remote, b, 'b');
    assert.equal((await engineA.sync()).status, 'synced');
    assert.equal((await engineB.sync()).status, 'synced');
    if (deletedBy === 'local') {
      a.change(items => items.splice(0, 1));
      edit(b, 'same', '乙的编辑');
      assert.equal((await engineB.sync()).status, 'synced');
    } else {
      edit(a, 'same', '甲的编辑');
      b.change(items => items.splice(0, 1));
      assert.equal((await engineB.sync()).status, 'synced');
    }
    const localBefore = a.state(), remoteBefore = await snapshot(remote);
    const result = await engineA.sync();
    assert.equal(result.status, 'conflict');
    assert.equal(result.conflicts.length, 1);
    const conflict = result.conflicts[0];
    assert.equal(conflict.kind, 'edit-delete');
    assert.equal(conflict.deletedBy, deletedBy);
    assert.equal(conflict.base.text, '原文');
    assert.equal(conflict.local?.text ?? null, deletedBy === 'local' ? null : '甲的编辑');
    assert.equal(conflict.remote?.text ?? null, deletedBy === 'remote' ? null : '乙的编辑');
    assert.deepEqual(a.state(), localBefore);
    assert.deepEqual(await snapshot(remote), remoteBefore);
    assert.equal(a.state().pending, null);
  });
}

test('deletion conflicts detect changes to every record and media field', async t => {
  const ids = ['date', 'text', 'createdAt', 'updatedAt', 'media-id', 'media-name', 'media-type', 'media-order', 'media-bytes', 'media-count'];
  const initial = ids.map(id => memory(id, '原文', [medium('first', [1, 2]), medium('second', [3, 4])]));
  const remote = await server(t), a = store(initial), b = store();
  const engineA = client(remote, a, 'a'), engineB = client(remote, b, 'b');
  assert.equal((await engineA.sync()).status, 'synced');
  assert.equal((await engineB.sync()).status, 'synced');
  a.change(items => items.splice(0));
  b.change(items => {
    record({ memories: items }, 'date').date = '2025-01-16';
    record({ memories: items }, 'text').text = '仅文字变化';
    record({ memories: items }, 'createdAt').createdAt++;
    record({ memories: items }, 'updatedAt').updatedAt++;
    record({ memories: items }, 'media-id').media[0].id = 'renamed';
    record({ memories: items }, 'media-name').media[0].name = 'renamed.png';
    record({ memories: items }, 'media-type').media[0].type = 'image/jpeg';
    record({ memories: items }, 'media-order').media.reverse();
    record({ memories: items }, 'media-bytes').media[0].blob = new Blob([new Uint8Array([9, 9])], { type: 'image/png' });
    record({ memories: items }, 'media-count').media.pop();
  });
  assert.equal((await engineB.sync()).status, 'synced');
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const result = await engineA.sync();
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts.map(item => item.id), [...ids].sort());
  assert.ok(result.conflicts.every(item => item.kind === 'edit-delete' && item.deletedBy === 'local' && item.local === null));
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

test('a remote deletion versus a local edit is reported without removing the edit', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]);
  const engine = client(remote, a, 'a');
  await engine.sync();
  edit(a, 'same', '本地修改');
  const before = a.state(), current = await snapshot(remote);
  const changed = structuredClone(current.snapshot);
  changed.memories = [];
  changed.clock.push(['other', 1]);
  assert.equal((await replaceSnapshot(remote, current.etag, changed)).status, 200);
  const result = await engine.sync();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'edit-delete');
  assert.equal(result.conflicts[0].deletedBy, 'remote');
  assert.equal(result.conflicts[0].local.text, '本地修改');
  assert.deepEqual(a.state(), before);
});

test('simultaneous distinct creations with the same ID are reported as a conflict', async t => {
  const remote = await server(t), a = store([memory('same', '甲的新记录')]), b = store([memory('same', '乙的新记录')]);
  await client(remote, a, 'a').sync();
  const before = b.state(), result = await client(remote, b, 'b').sync();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'concurrent-add');
  assert.equal(result.conflicts[0].base, null);
  assert.equal(result.conflicts[0].local.text, '乙的新记录');
  assert.equal(result.conflicts[0].remote.text, '甲的新记录');
  assert.deepEqual(b.state(), before);
});

test('a real 412 rereads, merges, and retries with the new ETag', async t => {
  const remote = await server(t), a = store([memory('a', '甲')]), b = store([memory('b', '乙')]);
  const engineB = client(remote, b, 'b');
  let intercepted = false;
  const engineA = client(remote, a, 'a', { fetch: async (url, options) => {
    if (!intercepted && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      intercepted = true;
      assert.equal((await engineB.sync()).status, 'synced');
    }
    return fetch(url, options);
  } });
  const result = await engineA.sync();
  assert.equal(result.status, 'synced');
  assert.equal(result.attempts, 2);
  assert.deepEqual(a.state().memories.map(item => item.id), ['a', 'b']);
  assert.equal(a.state().pending, null);
  assert.equal((await engineB.sync()).status, 'synced');
  assert.deepEqual(b.state().memories.map(item => item.id), ['a', 'b']);
});

test('repeated real 412 responses stop at the configured bound without marking local data synced', async t => {
  const remote = await server(t), local = store([memory('a', '离线修改')]);
  let writes = 0;
  const engine = client(remote, local, 'a', { maxAttempts: 2, fetch: async (url, options) => {
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      writes++;
      const current = await snapshot(remote);
      const value = current.snapshot || { format: 'ours-web-sync', version: 1, spaceId: 'synthetic-space', clock: [], memories: [] };
      const clock = new Map(value.clock); clock.set('competitor', (clock.get('competitor') || 0) + 1);
      value.clock = [...clock];
      assert.equal((await replaceSnapshot(remote, current.etag, value)).status, 200);
    }
    return fetch(url, options);
  } });
  const result = await engine.sync();
  assert.deepEqual(result, { status: 'retry_exhausted', attempts: 2 });
  assert.equal(writes, 2);
  assert.equal(local.state().baseline, null);
  assert.equal(local.state().pending, null);
  assert.equal(record(local.state(), 'a').text, '离线修改');
});

test('offline on read keeps state intact and reconnects', async t => {
  const remote = await server(t), local = store([memory('a', '离线文字')]);
  let online = false;
  const engine = client(remote, local, 'a', { fetch: (...args) => {
    if (!online) throw new Error(remote.token);
    return fetch(...args);
  } });
  const before = local.state();
  await assert.rejects(engine.sync(), error => error.code === 'NETWORK' && !String(error).includes(remote.token));
  assert.deepEqual(local.state(), before);
  online = true;
  assert.equal((await engine.sync()).status, 'synced');
  assert.equal(record(local.state(), 'a').text, '离线文字');
});

test('an offline deletion survives a backend and client restart and merges an independent addition', async t => {
  const remote = await server(t), a = store([memory('old', '待删除')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  await remote.stop();
  b.change(items => items.splice(0, 1));
  const offline = b.state();
  await assert.rejects(client(remote, b, 'b').sync(), error => error.code === 'NETWORK');
  assert.deepEqual(b.state(), offline);
  await remote.start();
  a.change(items => items.push(memory('new', '离线期间新增')));
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  for (const local of [a, b]) {
    assert.deepEqual(local.state().memories.map(item => item.id), ['new']);
    assert.equal(local.state().pending, null);
  }
  assert.deepEqual((await snapshot(remote)).snapshot.memories.map(item => item.id), ['new']);
});

test('an offline deletion conflicts with an edit after backend and client restart', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  await remote.stop();
  b.change(items => items.splice(0, 1));
  await assert.rejects(client(remote, b, 'b').sync(), error => error.code === 'NETWORK');
  await remote.start();
  edit(a, 'same', '另一客户端的编辑');
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  const localBefore = b.state(), remoteBefore = await snapshot(remote);
  const result = await client(remote, b, 'b').sync();
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'edit-delete');
  assert.equal(result.conflicts[0].deletedBy, 'local');
  assert.equal(result.conflicts[0].remote.text, '另一客户端的编辑');
  assert.deepEqual(b.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

for (const committed of [false, true]) {
  test(`an uncertain deletion ${committed ? 'after' : 'before'} commit is recovered after restart`, async t => {
    const remote = await server(t), a = store([memory('same', '待删除')]), b = store();
    assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    a.change(items => items.splice(0, 1));
    const baseline = a.state().baseline;
    const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
      if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
        if (committed) await fetch(url, options);
        throw new Error('synthetic disconnect');
      }
      return fetch(url, options);
    } });
    await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown === true);
    assert.deepEqual(a.state().baseline, baseline);
    assert.ok(a.state().pending);
    assert.equal((await snapshot(remote)).snapshot.memories.length, committed ? 0 : 1);
    await remote.stop();
    await remote.start();
    assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    assert.equal(a.state().pending, null);
    assert.equal(a.state().memories.length, 0);
    assert.equal(b.state().memories.length, 0);
    assert.equal((await snapshot(remote)).snapshot.memories.length, 0);
  });
}

test('an uncertain deletion recovers after another client synchronizes the same records', async t => {
  const remote = await server(t), a = store([memory('same', '待删除')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('lost response after commit');
    return response;
  } });
  await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  const proposal = a.state().pending.proposed;
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  const intervening = await snapshot(remote);
  assert.deepEqual(intervening.snapshot.memories, proposal.memories);
  assert.notDeepEqual(intervening.snapshot.clock, proposal.clock);
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal(a.state().pending, null);
  assert.deepEqual(a.state().memories, []);
  assert.deepEqual(b.state().memories, []);
  const final = await snapshot(remote);
  assert.deepEqual(final.snapshot.memories, []);
  const finalClock = new Map(final.snapshot.clock);
  for (const [id, count] of intervening.snapshot.clock) assert.ok(finalClock.get(id) >= count);
});

test('pending deletion recovery retries a concurrent write and retains a new local edit', async t => {
  const remote = await server(t), a = store([memory('same', '待删除')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('lost response after commit');
    return response;
  } });
  await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  let puts = 0;
  const recovering = client(remote, a, 'a', { fetch: async (url, options) => {
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      puts++;
      if (puts === 1) {
        // Publish an intervening, valid remote clock advance to force a real 412.
        // An unchanged client check intentionally does not write anymore.
        const current = await snapshot(remote);
        const intervening = structuredClone(current.snapshot);
        const entry = intervening.clock.find(item => item[0] === 'b');
        assert.ok(entry);
        entry[1]++;
        assert.equal((await replaceSnapshot(remote, current.etag, intervening)).status, 200);
      }
      if (puts === 2) a.change(items => items.push(memory('new', '恢复期间新增')));
    }
    return fetch(url, options);
  } });
  const result = await recovering.sync();
  assert.equal(result.status, 'local_changed');
  assert.equal(result.remoteCommitted, true);
  assert.equal(result.attempts, 2);
  assert.equal(puts, 2);
  assert.deepEqual(a.state().memories.map(item => item.id), ['new']);
  assert.ok(a.state().pending);
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const pending = await client(remote, a, 'a').sync();
  assert.equal(pending.status, 'pending_local_changed');
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
  assert.deepEqual(remoteBefore.snapshot.memories, []);
  const clock = new Map(remoteBefore.snapshot.clock);
  assert.ok(clock.get('b') >= 3);
});

test('independent matching deletions join clocks and survive another uncertain response', async t => {
  const remote = await server(t), a = store([memory('same', '待删除')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  const offline = client(remote, a, 'a', { fetch: (url, options) => {
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('offline before transmission');
    return fetch(url, options);
  } });
  await assert.rejects(offline.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  b.change(items => items.splice(0, 1));
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  assert.deepEqual(localBefore.pending.proposed.memories, remoteBefore.snapshot.memories);
  const remoteClock = new Map(remoteBefore.snapshot.clock);
  const proposalClock = new Map(localBefore.pending.proposed.clock);
  assert.ok([...proposalClock].some(([id, count]) => (remoteClock.get(id) || 0) < count));
  const lostResponse = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('lost joined-clock response');
    return response;
  } });
  await assert.rejects(lostResponse.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  assert.deepEqual(a.state(), localBefore);
  const joined = await snapshot(remote), joinedClock = new Map(joined.snapshot.clock);
  for (const [id, count] of [...remoteClock, ...proposalClock]) assert.ok(joinedClock.get(id) >= count);
  assert.deepEqual(joined.snapshot.memories, []);
  await remote.stop();
  await remote.start();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  for (const local of [a, b]) {
    assert.deepEqual(local.state().memories, []);
    assert.equal(local.state().pending, null);
  }
  const final = await snapshot(remote), finalClock = new Map(final.snapshot.clock);
  for (const [id, count] of joinedClock) assert.ok(finalClock.get(id) >= count);
  assert.deepEqual(final.snapshot.memories, []);
});

test('a clock union above the limit fails without changing the pending journal or remote', async t => {
  const remote = await server(t);
  const empty = { format: 'ours-web-sync', version: 1, spaceId: 'synthetic-space', clock: [], memories: [] };
  const clock = prefix => Array.from({ length: 1024 }, (_, index) => [`${prefix}${index}`, 1]);
  const initial = await snapshot(remote);
  assert.equal((await replaceSnapshot(remote, initial.etag, { ...empty, clock: clock('remote') })).status, 200);
  const state = { revision: 'prepared', memories: [], baseline: null, pending: {
    format: 'ours-web-sync-pending', version: 1, server: remote.baseUrl, spaceId: 'synthetic-space',
    id: 'pending', revision: 'prepared', etag: initial.etag,
    local: empty, proposed: { ...empty, clock: clock('local') }
  } };
  let casCalls = 0;
  const local = { readLocal: async () => structuredClone(state),
    compareAndSwap: async () => { casCalls++; return null; }, withLock: async callback => callback() };
  const before = structuredClone(state), remoteBefore = await snapshot(remote);
  await assert.rejects(client(remote, local, 'device').sync(), error => error.code === 'INVALID_DATA');
  assert.equal(casCalls, 0);
  assert.deepEqual(state, before);
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

for (const deletedBy of ['local', 'remote']) {
  test(`an uncertain upload reports observable ${deletedBy} edit-delete divergence without clearing its journal`, async t => {
    const remote = await server(t), a = store([memory('same', '原文')]), b = store();
    assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    if (deletedBy === 'local') a.change(items => items.splice(0, 1));
    else edit(a, 'same', '甲的编辑');
    const unreliable = client(remote, a, 'a', { fetch: (url, options) => {
      if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('offline before transmission');
      return fetch(url, options);
    } });
    await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
    if (deletedBy === 'local') edit(b, 'same', '乙的编辑');
    else b.change(items => items.splice(0, 1));
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    const localBefore = a.state(), remoteBefore = await snapshot(remote);
    const result = await client(remote, a, 'a').sync();
    assert.equal(result.status, 'pending_conflict');
    assert.equal(result.conflictsMayBeIncomplete, true);
    const conflict = result.conflicts.find(item => item.kind === 'edit-delete' && item.against === 'remote');
    assert.ok(conflict);
    assert.equal(conflict.deletedBy, deletedBy);
    assert.equal(conflict.base.text, '原文');
    assert.equal(conflict.local?.text ?? null, deletedBy === 'local' ? null : '甲的编辑');
    assert.equal(conflict.remote?.text ?? null, deletedBy === 'remote' ? null : '乙的编辑');
    assert.deepEqual(a.state(), localBefore);
    assert.deepEqual(await snapshot(remote), remoteBefore);
    assert.ok(a.state().pending);
  });
}

test('an uncertain deletion superseded by the other client keeps the journal across restart', async t => {
  const remote = await server(t), a = store([memory('old', '待删除')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('lost response after commit');
    return response;
  } });
  await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  b.change(items => items.push(memory('new', '另一客户端的新记录')));
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  await remote.stop();
  await remote.start();
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const result = await client(remote, a, 'a').sync();
  assert.equal(result.status, 'pending_conflict');
  assert.ok(result.pending);
  assert.deepEqual(result.remote.memories.map(item => item.id), ['new']);
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
  assert.equal(a.state().memories.length, 0);
});

test('a lost response after commit leaves a journal and safely reconnects', async t => {
  const remote = await server(t), local = store([memory('a', '新记录')]);
  let loseResponse = true;
  const engine = client(remote, local, 'a', { fetch: async (url, options) => {
    const result = await fetch(url, options);
    if (loseResponse && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      loseResponse = false;
      throw new Error('synthetic disconnect after commit');
    }
    return result;
  } });
  await assert.rejects(engine.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown === true);
  assert.equal(local.state().baseline, null);
  assert.ok(local.state().pending);
  assert.equal((await engine.sync()).status, 'synced');
  assert.equal(local.state().pending, null);
  assert.equal(record(local.state(), 'a').text, '新记录');
});

test('an ambiguous pre-commit failure replays the exact pending write', async t => {
  const remote = await server(t), local = store([memory('a', '待提交')]);
  let disconnected = true;
  const engine = client(remote, local, 'a', { fetch: (url, options) => {
    if (disconnected && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      disconnected = false; throw new Error('synthetic offline');
    }
    return fetch(url, options);
  } });
  await assert.rejects(engine.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
  assert.ok(local.state().pending);
  assert.equal((await snapshot(remote)).snapshot, null);
  assert.equal((await engine.sync()).status, 'synced');
  assert.equal(local.state().pending, null);
  assert.equal((await snapshot(remote)).snapshot.memories[0].text, '待提交');
});

test('edits during snapshot PUT cannot be overwritten and remain available after reconnect', async t => {
  const remote = await server(t), local = store([memory('a', '原文')]);
  const normal = client(remote, local, 'a');
  await normal.sync();
  edit(local, 'a', '上传时的版本');
  let edited = false;
  const racing = client(remote, local, 'a', { fetch: async (url, options) => {
    const result = await fetch(url, options);
    if (!edited && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      edited = true; edit(local, 'a', '上传期间的新修改');
    }
    return result;
  } });
  const beforeBaseline = local.state().baseline;
  const result = await racing.sync();
  assert.equal(result.status, 'local_changed');
  assert.equal(result.remoteCommitted, true);
  assert.equal(record(local.state(), 'a').text, '上传期间的新修改');
  assert.deepEqual(local.state().baseline, beforeBaseline);
  assert.ok(local.state().pending);
  const pending = await normal.sync();
  assert.equal(pending.status, 'pending_local_changed');
  assert.equal(pending.local.memories[0].text, '上传期间的新修改');
  assert.equal(pending.pending.proposed.memories[0].text, '上传时的版本');
  assert.equal(record(local.state(), 'a').text, '上传期间的新修改');
  assert.equal((await snapshot(remote)).snapshot.memories[0].text, '上传时的版本');
});

test('editing a record while an incoming deletion is published preserves the edit and pending conflict', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  b.change(items => items.splice(0, 1));
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  const baseline = a.state().baseline;
  let edited = false;
  const racing = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (!edited && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      edited = true;
      edit(a, 'same', '上传期间的编辑');
    }
    return response;
  } });
  const result = await racing.sync();
  assert.equal(result.status, 'local_changed');
  assert.equal(result.remoteCommitted, true);
  assert.equal(record(a.state(), 'same').text, '上传期间的编辑');
  assert.deepEqual(a.state().baseline, baseline);
  assert.ok(a.state().pending);
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const recovered = await client(remote, a, 'a').sync();
  assert.equal(recovered.status, 'pending_local_changed');
  assert.equal(recovered.conflicts[0].kind, 'edit-delete');
  assert.equal(recovered.conflicts[0].deletedBy, 'remote');
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
  assert.equal(remoteBefore.snapshot.memories.length, 0);
});

for (const locallyChanged of [false, true]) {
  test(`a remote deletion after observing a pending edit ${locallyChanged ? 'conflicts with a later local edit' : 'does not conflict with that same edit'}`, async t => {
    const remote = await server(t), a = store([memory('same', '原文')]), b = store();
    assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    edit(a, 'same', '甲的待确认编辑');
    const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/v1/snapshot') && options.method === 'PUT') throw new Error('lost response after commit');
      return response;
    } });
    await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
    if (locallyChanged) edit(a, 'same', '甲后续的新编辑');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    assert.equal(record(b.state(), 'same').text, '甲的待确认编辑');
    b.change(items => items.splice(0, 1));
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    const localBefore = a.state(), remoteBefore = await snapshot(remote);
    const result = await client(remote, a, 'a').sync();
    assert.equal(result.status, locallyChanged ? 'pending_local_changed' : 'pending_conflict');
    const conflict = result.conflicts.find(item => item.kind === 'edit-delete' && item.against === 'remote');
    if (locallyChanged) {
      assert.ok(conflict);
      assert.equal(conflict.deletedBy, 'remote');
      assert.equal(conflict.local.text, '甲后续的新编辑');
    } else {
      assert.equal(conflict, undefined);
    }
    assert.deepEqual(a.state(), localBefore);
    assert.deepEqual(await snapshot(remote), remoteBefore);
    assert.ok(a.state().pending);
  });
}

for (const initial of ['new', 'reverted']) {
  test(`a remote deletion conflicts with a ${initial} local edit after the pending proposal`, async t => {
    const remote = await server(t), a = store(initial === 'new' ? [] : [memory('same', '原文')]), b = store();
    assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    if (initial === 'new') a.change(items => items.push(memory('same', '待确认版本')));
    else edit(a, 'same', '待确认版本');
    const unreliable = client(remote, a, 'a', { fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
        a.change(items => {
          items[0].text = initial === 'new' ? '本地新编辑' : '原文';
          items[0].updatedAt = 1;
        });
        throw new Error('lost response after commit');
      }
      return response;
    } });
    await assert.rejects(unreliable.sync(), error => error.code === 'NETWORK' && error.remoteCommitUnknown);
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    b.change(items => items.splice(0, 1));
    assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
    const localBefore = a.state(), remoteBefore = await snapshot(remote);
    const result = await client(remote, a, 'a').sync();
    assert.equal(result.status, 'pending_local_changed');
    const conflict = result.conflicts.find(item => item.kind === 'edit-delete' && item.against === 'remote');
    assert.ok(conflict);
    assert.equal(conflict.deletedBy, 'remote');
    assert.equal(conflict.base.text, '待确认版本');
    assert.equal(conflict.local.text, initial === 'new' ? '本地新编辑' : '原文');
    assert.equal(conflict.remote, null);
    assert.deepEqual(a.state(), localBefore);
    assert.deepEqual(await snapshot(remote), remoteBefore);
    assert.ok(a.state().pending);
  });
}

test('a later local deletion does not misattribute its own pending edit to the remote client', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  edit(a, 'same', '甲先前的编辑');
  let deleted = false;
  const racing = client(remote, a, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (!deleted && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      deleted = true;
      a.change(items => items.splice(0, 1));
    }
    return response;
  } });
  assert.equal((await racing.sync()).status, 'local_changed');
  b.change(items => items.push(memory('new', '乙独立新增')));
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const result = await client(remote, a, 'a').sync();
  assert.equal(result.status, 'pending_local_changed');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

test('a local addition during a rejected deletion keeps the journal and both clients data', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]), b = store();
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
  a.change(items => items.splice(0, 1));
  let intercepted = false;
  const racing = client(remote, a, 'a', { fetch: async (url, options) => {
    if (!intercepted && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      intercepted = true;
      edit(b, 'same', '乙的编辑');
      assert.equal((await client(remote, b, 'b').sync()).status, 'synced');
      a.change(items => items.push(memory('new', '上传期间新增')));
    }
    return fetch(url, options);
  } });
  const result = await racing.sync();
  assert.equal(result.status, 'local_changed');
  assert.equal(result.remoteCommitted, false);
  assert.equal(intercepted, true);
  assert.ok(a.state().pending);
  assert.deepEqual(a.state().memories.map(item => item.id), ['new']);
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const recovered = await client(remote, a, 'a').sync();
  assert.equal(recovered.status, 'pending_local_changed');
  const conflict = recovered.conflicts.find(item => item.kind === 'edit-delete' && item.against === 'remote');
  assert.ok(conflict);
  assert.equal(conflict.deletedBy, 'local');
  assert.equal(conflict.remote.text, '乙的编辑');
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
  assert.equal(remoteBefore.snapshot.memories[0].text, '乙的编辑');
});

test('deleting a newly created record during its first PUT never resurrects it', async t => {
  const remote = await server(t), local = store([memory('new', '上传期间删除')]);
  let deleted = false;
  const racing = client(remote, local, 'a', { fetch: async (url, options) => {
    const result = await fetch(url, options);
    if (!deleted && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      deleted = true; local.change(items => items.splice(0, 1));
    }
    return result;
  } });
  assert.equal((await racing.sync()).status, 'local_changed');
  const result = await client(remote, local, 'a').sync();
  assert.equal(result.status, 'pending_local_changed');
  assert.equal(result.local.memories.length, 0);
  assert.equal(result.pending.proposed.memories[0].text, '上传期间删除');
  assert.equal(local.state().memories.length, 0);
  assert.equal(local.state().baseline, null);
  assert.ok(local.state().pending);
});

test('a rejected unsent publication is not replayed after the user deletes the record', async t => {
  const remote = await server(t), local = store([memory('a', '待提交')]);
  let reject = true, puts = 0;
  const engine = client(remote, local, 'a', { fetch: (url, options) => {
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      puts++;
      if (reject) { reject = false; throw new Error('offline before transmission'); }
    }
    return fetch(url, options);
  } });
  await assert.rejects(engine.sync(), error => error.remoteCommitUnknown);
  local.change(items => items.splice(0, 1));
  const result = await engine.sync();
  assert.equal(result.status, 'pending_local_changed');
  assert.equal(result.local.memories.length, 0);
  assert.equal(result.pending.local.memories[0].text, '待提交');
  assert.equal(puts, 1);
  assert.equal((await snapshot(remote)).snapshot, null);
  assert.equal(local.state().memories.length, 0);
  assert.ok(local.state().pending);
});

test('an import followed by deletion during PUT cannot be mistaken for no local change', async t => {
  const remote = await server(t), other = store([memory('a', '远端记录')]), local = store();
  assert.equal((await client(remote, other, 'other').sync()).status, 'synced');
  let injected = false, puts = 0;
  const engine = client(remote, local, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      puts++;
      if (!injected) {
        injected = true;
        local.change(items => items.push(memory('a', '导入的记录')));
        local.change(items => items.splice(0, 1));
      }
    }
    return response;
  } });
  assert.equal((await engine.sync()).status, 'local_changed');
  assert.equal(local.state().memories.length, 0);
  const result = await engine.sync();
  assert.equal(result.status, 'pending_local_changed');
  assert.equal(result.local.memories.length, 0);
  assert.equal(result.pending.proposed.memories[0].text, '远端记录');
  assert.equal(puts, 1);
  assert.equal(local.state().baseline, null);
  assert.ok(local.state().pending);
});

test('local transaction failure after server confirmation retains the journal for recovery', async t => {
  const remote = await server(t), local = store([memory('a', '本地事务错误')]);
  let commits = 0;
  const engine = client(remote, local, 'a', { compareAndSwap: async change => {
    if (++commits === 2) throw new Error('synthetic local transaction failure');
    return local.compareAndSwap(change);
  } });
  await assert.rejects(engine.sync(), error => error.code === 'LOCAL_COMMIT' && error.remoteCommitted === true);
  assert.equal(local.state().baseline, null);
  assert.ok(local.state().pending);
  assert.equal((await engine.sync()).status, 'synced');
  assert.equal(local.state().pending, null);
  assert.equal(record(local.state(), 'a').text, '本地事务错误');
});

test('a server error after commit keeps the journal and marks the result unknown', async t => {
  const remote = await server(t), local = store([memory('a', '服务端错误')]);
  let inject = true;
  const engine = client(remote, local, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (inject && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      inject = false;
      return new Response('{}', { status: 500 });
    }
    return response;
  } });
  await assert.rejects(engine.sync(), error => error.code === 'HTTP_ERROR' && error.status === 500 && error.remoteCommitUnknown);
  assert.equal(local.state().baseline, null);
  assert.ok(local.state().pending);
  assert.equal((await engine.sync()).status, 'synced');
  assert.equal(local.state().pending, null);
});

test('a superseded uncertain write is surfaced without discarding the journal', async t => {
  const remote = await server(t), local = store([memory('a', '待确认')]);
  let disconnect = true;
  const engine = client(remote, local, 'a', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (disconnect && url.endsWith('/v1/snapshot') && options.method === 'PUT') {
      disconnect = false; throw new Error('lost response');
    }
    return response;
  } });
  await assert.rejects(engine.sync());
  const current = await snapshot(remote), changed = structuredClone(current.snapshot);
  changed.memories[0].text = '之后的服务端修改';
  changed.clock.push(['other', 1]);
  assert.equal((await replaceSnapshot(remote, current.etag, changed)).status, 200);
  const before = local.state();
  const result = await engine.sync();
  assert.equal(result.status, 'pending_conflict');
  assert.equal(result.pending.proposed.memories[0].text, '待确认');
  assert.equal(result.remote.memories[0].text, '之后的服务端修改');
  assert.deepEqual(local.state(), before);
});

test('a restored older server snapshot cannot overwrite a newer local baseline', async t => {
  const remote = await server(t), local = store([memory('a', '旧版本')]);
  const engine = client(remote, local, 'a');
  await engine.sync();
  const old = (await snapshot(remote)).snapshot;
  edit(local, 'a', '较新版本'); await engine.sync();
  const before = local.state(), current = await snapshot(remote);
  assert.equal((await replaceSnapshot(remote, current.etag, old)).status, 200);
  const result = await engine.sync();
  assert.equal(result.status, 'history_conflict');
  assert.equal(result.baseline.memories[0].text, '较新版本');
  assert.equal(result.remote.memories[0].text, '旧版本');
  assert.deepEqual(local.state(), before);
});

test('a deletion under an unchanged vector clock is rejected as a history conflict', async t => {
  const remote = await server(t), a = store([memory('same', '原文')]);
  const engine = client(remote, a, 'a');
  assert.equal((await engine.sync()).status, 'synced');
  const current = await snapshot(remote), changed = structuredClone(current.snapshot);
  changed.memories = [];
  assert.equal((await replaceSnapshot(remote, current.etag, changed)).status, 200);
  const localBefore = a.state(), remoteBefore = await snapshot(remote);
  const result = await engine.sync();
  assert.equal(result.status, 'history_conflict');
  assert.equal(result.baseline.memories[0].text, '原文');
  assert.equal(result.remote.memories.length, 0);
  assert.deepEqual(a.state(), localBefore);
  assert.deepEqual(await snapshot(remote), remoteBefore);
});

test('corrupt downloaded media is rejected before changing local state or snapshot', async t => {
  const remote = await server(t), a = store([memory('a', '含媒体', [medium('m', [1, 2, 3, 4])])]), b = store();
  await client(remote, a, 'a').sync();
  const before = b.state(), original = await snapshot(remote);
  const engine = client(remote, b, 'b', { fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.includes('/v1/media/') && options.method === 'GET' && response.status === 200) {
      return new Response(new Uint8Array([4, 3, 2, 1]), { status: 200, headers: { 'Content-Length': '4', ETag: response.headers.get('etag') } });
    }
    return response;
  } });
  await assert.rejects(engine.sync(), error => error.code === 'MEDIA_INTEGRITY');
  assert.deepEqual(b.state(), before);
  assert.deepEqual(await snapshot(remote), original);
});

test('size and space checks fail closed before snapshot publication', async t => {
  const remote = await server(t), owner = store([memory('a', '只属于这个空间')]);
  await client(remote, owner, 'a').sync();
  const wrongSpace = store();
  await assert.rejects(client(remote, wrongSpace, 'b', { spaceId: 'another-space' }).sync(), error => error.code === 'SPACE_MISMATCH');
  assert.equal(wrongSpace.state().baseline, null);
  const ordinary = store(Array.from({ length: 37 }, (_, i) => memory(`ordinary-${i}`, '琴'.repeat(10000))));
  const ordinaryRemote = await server(t);
  assert.equal((await client(ordinaryRemote, ordinary, 'ordinary-device').sync()).status, 'synced');
  const huge = store(Array.from({ length: 560 }, (_, i) => memory(`large-${i}`, '琴'.repeat(10000))));
  const isolated = await server(t);
  await assert.rejects(client(isolated, huge, 'large-device').sync(), error => error.code === 'SNAPSHOT_TOO_LARGE');
  assert.equal((await snapshot(isolated)).snapshot, null);
  assert.equal(huge.state().baseline, null);
  class OversizedBlob extends Blob { get size() { return MAX_MEDIA_BYTES + 1; } }
  const bad = store();
  bad.change(items => items.push(memory('too-large', 'x', [{ id: 'm', name: 'x', type: 'image/png', blob: new OversizedBlob() }])));
  // structuredClone strips subclass accessors; test the storage adapter's incoming Blob directly.
  const badEngine = client(isolated, bad, 'bad-device', { readLocal: async () => ({ revision: 'x', baseline: null, pending: null,
    memories: [memory('too-large', 'x', [{ id: 'm', name: 'x', type: 'image/png', blob: new OversizedBlob() }])] }) });
  await assert.rejects(badEngine.sync(), error => error.code === 'INVALID_DATA');
  assert.equal(MAX_RECORDS, 10000);
});

test('merged record counts above the backup limit cannot be published', async t => {
  const remote = await server(t);
  const a = store(Array.from({ length: 5000 }, (_, i) => memory(`a${i}`, '甲')));
  const b = store(Array.from({ length: 5001 }, (_, i) => memory(`b${i}`, '乙')));
  assert.equal((await client(remote, a, 'a').sync()).status, 'synced');
  const before = await snapshot(remote);
  await assert.rejects(client(remote, b, 'b').sync(), error => error.code === 'TOO_MANY_RECORDS');
  assert.equal(b.state().baseline, null);
  assert.deepEqual(await snapshot(remote), before);
});

test('an inconsistent revision and ETag cannot replace the remote snapshot', async t => {
  const remote = await server(t), other = store([memory('other', '不能丢失')]), local = store([memory('local', '本地')]);
  await client(remote, other, 'other').sync();
  const before = await snapshot(remote), localBefore = local.state();
  let puts = 0;
  const engine = client(remote, local, 'local', { fetch: async (url, options) => {
    if (url.endsWith('/v1/snapshot') && options.method === 'GET') {
      return new Response(JSON.stringify({ revision: '0', snapshot: null }), {
        status: 200, headers: { ETag: before.etag, 'Content-Type': 'application/json' }
      });
    }
    if (url.endsWith('/v1/snapshot') && options.method === 'PUT') puts++;
    return fetch(url, options);
  } });
  await assert.rejects(engine.sync(), error => error.code === 'INVALID_RESPONSE');
  assert.equal(puts, 0);
  assert.deepEqual(local.state(), localBefore);
  assert.deepEqual(await snapshot(remote), before);
});

test('transport configuration and errors never put a token into URLs or error messages', async () => {
  const token = randomBytes(32).toString('base64url'), local = store();
  const options = { token, spaceId: 'space', deviceId: 'device', ...local };
  assert.throws(() => createSyncEngine({ ...options, baseUrl: 'http://example.com' }), error => error.code === 'INVALID_URL');
  assert.throws(() => createSyncEngine({ ...options, baseUrl: 'http://127.0.0.1:1234' }), error => error.code === 'INVALID_URL');
  assert.throws(() => createSyncEngine({ ...options, baseUrl: `https://example.com/?secret=${token}` }), error => error.code === 'INVALID_URL' && !String(error).includes(token));
  let called = false;
  const engine = createSyncEngine({ ...options, baseUrl: 'https://example.com', fetch: (url, request) => {
    called = true;
    assert.equal(url, 'https://example.com/v1/snapshot');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.credentials, 'omit');
    throw new Error(token);
  } });
  await assert.rejects(engine.sync(), error => error.code === 'NETWORK' && !String(error).includes(token));
  assert.equal(called, true);
});
