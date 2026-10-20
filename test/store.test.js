import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/hub/store.js';

const PROJECT = { id: 'orders-api-1a2b3c4d', name: 'orders-api', root: '/work/orders-api' };
const INSTANCE = { pid: 4242, port: 3000, framework: 'express', node: 'v22.0.0', sdk: '1.0.0', environment: 'development', startedAt: 1 };

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-store-'));
  dirs.push(dir);
  return dir;
}

function records(from, count) {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      id: `req-${n}`,
      occurredAt: 1_000_000 + n,
      environment: 'development',
      method: 'GET',
      status: 200,
      duration: n,
      requestSize: 0,
      responseSize: 10,
      aborted: false,
      url: `/items/${n}?q=1`,
      path: `/items/${n}`,
      contentType: 'application/json',
      detail: { headers: { host: 'localhost' }, body: `body ${n}`, response: { body: `{"n":${n}}` } }
    };
  });
}

test('stores requests and reads summaries and details back', () => {
  const store = new Store(tempDir()).load();
  store.touch(PROJECT, INSTANCE);
  const added = store.append(PROJECT.id, records(1, 5));
  assert.equal(added.length, 5);
  assert.deepEqual(added.map((entry) => entry.seq), [1, 2, 3, 4, 5]);

  const newest = store.list(PROJECT.id, { limit: 2 });
  assert.deepEqual(newest.requests.map((entry) => entry.id), ['req-5', 'req-4']);
  assert.equal(newest.hasMore, true);
  assert.equal('off' in newest.requests[0], false, 'file offsets stay internal');

  const older = store.list(PROJECT.id, { before: 4, limit: 10 });
  assert.deepEqual(older.requests.map((entry) => entry.id), ['req-3', 'req-2', 'req-1']);
  assert.equal(older.hasMore, false);

  const fresh = store.list(PROJECT.id, { after: 3, limit: 10 });
  assert.deepEqual(fresh.requests.map((entry) => entry.id), ['req-4', 'req-5'], 'polling returns oldest first');

  assert.deepEqual(store.detail(PROJECT.id, 'req-3').response, { body: '{"n":3}' });
  assert.equal(store.detail(PROJECT.id, 'req-missing'), null);
  assert.equal(store.list('unknown-project', { limit: 5 }), null);
});

test('skips requests it already has, so retried batches are harmless', () => {
  const store = new Store(tempDir()).load();
  store.touch(PROJECT, INSTANCE);
  store.append(PROJECT.id, records(1, 3));
  const again = store.append(PROJECT.id, records(2, 3));
  assert.deepEqual(again.map((entry) => entry.id), ['req-4']);
  assert.equal(store.list(PROJECT.id, { limit: 100 }).requests.length, 4);
});

test('keeps the newest maxRequests and deletes older files', () => {
  const dir = tempDir();
  const store = new Store(dir, { maxRequests: 20 }).load();
  store.touch(PROJECT, INSTANCE);
  for (let i = 0; i < 11; i++) store.append(PROJECT.id, records(1 + i * 5, 5));

  const kept = store.list(PROJECT.id, { limit: 1000 }).requests;
  assert.ok(kept.length >= 20 && kept.length < 30, `kept ${kept.length}`);
  assert.equal(kept[0].id, 'req-55');
  assert.equal(store.detail(PROJECT.id, 'req-1'), null);
  assert.ok(store.detail(PROJECT.id, kept[kept.length - 1].id));

  const files = fs.readdirSync(path.join(dir, 'projects', PROJECT.id)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(files.length <= 3, `${files.length} segment files`);
});

test('reloads from disk and keeps numbering after a restart', () => {
  const dir = tempDir();
  const first = new Store(dir).load();
  first.touch(PROJECT, INSTANCE);
  first.append(PROJECT.id, records(1, 4));
  first.persist();

  // A crash can leave half a line at the end of an index file.
  const index = path.join(dir, 'projects', PROJECT.id, '00000001.idx');
  fs.appendFileSync(index, '{"seq":99,"id":"req-');

  const second = new Store(dir).load();
  const listed = second.list(PROJECT.id, { limit: 10 }).requests;
  assert.deepEqual(listed.map((entry) => entry.id), ['req-4', 'req-3', 'req-2', 'req-1']);
  assert.equal(second.detail(PROJECT.id, 'req-2').body, 'body 2');
  assert.equal(second.listProjects()[0].name, 'orders-api');
  assert.equal(second.listProjects()[0].online, false, 'no process has checked in since the restart');

  second.touch(PROJECT, INSTANCE);
  assert.equal(second.append(PROJECT.id, records(5, 1))[0].seq, 5);
});

test('clearing keeps sequence numbers increasing, across restarts too', () => {
  const dir = tempDir();
  const store = new Store(dir).load();
  store.touch(PROJECT, INSTANCE);
  store.append(PROJECT.id, records(1, 3));
  assert.equal(store.clear(PROJECT.id), true);
  assert.equal(store.list(PROJECT.id, { limit: 10 }).requests.length, 0);
  assert.equal(store.append(PROJECT.id, records(10, 1))[0].seq, 4);

  store.clear(PROJECT.id);
  const reloaded = new Store(dir).load();
  reloaded.touch(PROJECT, INSTANCE);
  assert.equal(reloaded.append(PROJECT.id, records(20, 1))[0].seq, 5);
});

test('lists running processes and forgets projects', () => {
  const dir = tempDir();
  const store = new Store(dir).load();
  const now = Date.now();
  store.touch(PROJECT, INSTANCE, now - 40_000);
  store.touch({ id: 'web-9f8e7d6c', name: 'web', root: '/work/web' }, { ...INSTANCE, pid: 7 }, now);

  const [web, orders] = store.listProjects(now);
  assert.equal(web.name, 'web');
  assert.equal(web.online, true);
  assert.equal(web.instances[0].port, 3000);
  assert.equal(orders.online, false);
  assert.equal(orders.instances.length, 0);

  assert.equal(store.remove(PROJECT.id), true);
  assert.equal(fs.existsSync(path.join(dir, 'projects', PROJECT.id)), false);
  assert.deepEqual(store.listProjects(now).map((project) => project.name), ['web']);
});

test('remembers server requests that were not recorded', () => {
  const dir = tempDir();
  const store = new Store(dir).load();
  const now = Date.now();
  store.touch(PROJECT, INSTANCE, now);
  store.noteBlocked(PROJECT.id, [{ kind: 'host', value: 'api.company.com', count: 3 }, { kind: 'client', value: '8.8.8.8', count: 1 }], now);
  store.noteBlocked(PROJECT.id, [{ kind: 'host', value: 'api.company.com', count: 2 }, { kind: 'client', value: '1.1.1.1', count: 4 }], now);

  const { blocked } = store.listProjects(now)[0];
  assert.equal(blocked.total, 10);
  assert.deepEqual(blocked.entries, [
    { kind: 'host', value: 'api.company.com', count: 5 },
    { kind: 'client', value: '1.1.1.1', count: 5 }
  ]);

  store.persist();
  const reloaded = new Store(dir).load();
  assert.equal(reloaded.listProjects(now)[0].blocked.total, 10, 'kept across restarts');
  assert.equal(reloaded.listProjects(now + 25 * 60 * 60 * 1000)[0].blocked, null, 'notice ends a day after the last one');
});
