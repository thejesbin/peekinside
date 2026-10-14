// The hub's exception API: ingest, lists, details, clearing, resolved state, retention and the
// spool files crashing apps leave behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../src/hub/server.js';
import { SpoolIngester } from '../src/hub/spool-ingester.js';
import { Store } from '../src/hub/store.js';
import { Spool } from '../src/spool.js';

const PROJECT = { id: 'orders-api-1a2b3c4d', name: 'orders-api', root: '/work/orders-api' };
const INSTANCE = { pid: 4242, port: 3000, framework: 'express', startedAt: Date.now() };
const SDK = { 'content-type': 'application/json', 'x-peekinside-sdk': 'test' };

let server;
let store;
let port;
let origin;
let dataDir;
const dirs = [];

before(async () => {
  port = await freePort();
  origin = `http://localhost:${port}`;
  dataDir = tempDir();
  store = new Store(dataDir).load();
  server = new HubServer({ store, port, siteUrl: 'https://peekinside.example', version: 'test', dataDir }).httpServer;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

after(() => {
  server.close();
  dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-hub-exceptions-'));
  dirs.push(dir);
  return dir;
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
}

function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { host: `localhost:${port}`, ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (error) {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function exception(n, overrides = {}) {
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    occurredAt: 1_700_000_000_000 + n,
    environment: 'development',
    handled: false,
    fatal: false,
    requestId: 'f2b1c0de-0000-4000-8000-000000000001',
    summary: {
      name: 'TypeError',
      message: `Cannot read properties of undefined (${n})`,
      code: null,
      fingerprint: '0123456789abcdef',
      mechanism: 'express',
      location: { file: 'src/orders.js', line: 12, column: 9, function: 'createOrder' },
      request: { method: 'POST', path: '/orders' }
    },
    detail: { stack: `TypeError: ${n}`, frames: [], causes: [], request: null, process: { pid: 1 }, tags: {}, extra: null },
    ...overrides
  };
}

const REQUEST = {
  id: 'f2b1c0de-0000-4000-8000-000000000001',
  occurredAt: 1_700_000_000_000,
  environment: 'development',
  method: 'POST',
  status: 500,
  duration: 3,
  requestSize: 2,
  responseSize: 10,
  aborted: false,
  exceptionCount: 1,
  summary: { url: '/orders', path: '/orders', contentType: 'application/json' },
  detail: { body: '{}', exceptions: [{ id: exception(1).id, name: 'TypeError', message: 'Cannot read properties of undefined (1)' }] }
};

test('ingest stores exceptions next to requests and rejects malformed ones', async () => {
  const response = await request('POST', '/api/ingest', {
    headers: SDK,
    body: {
      project: PROJECT,
      instance: INSTANCE,
      requests: [REQUEST],
      exceptions: [
        exception(1),
        exception(2, { handled: true }),
        exception(3, { summary: { ...exception(3).summary, fingerprint: 'nope' } }),
        exception(4, { summary: { ...exception(4).summary, mechanism: 'telepathy' } }),
        exception(5, { id: '../../etc/passwd' }),
        'junk'
      ]
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { accepted: 1, rejected: 0, acceptedExceptions: 2, rejectedExceptions: 4, acceptedJobs: 0, acceptedLogs: 0 });

  // Batches without an exception list (older SDKs) get the answer they know.
  const legacy = await request('POST', '/api/ingest', { headers: SDK, body: { project: PROJECT, instance: INSTANCE, requests: [] } });
  assert.deepEqual(legacy.json, { accepted: 0, rejected: 0, acceptedJobs: 0, acceptedLogs: 0 });

  const tooMany = Array.from({ length: 501 }, (_, i) => exception(100 + i));
  assert.equal((await request('POST', '/api/ingest', { headers: SDK, body: { project: PROJECT, instance: INSTANCE, requests: [], exceptions: tooMany } })).status, 400);
});

test('lists exceptions with their summary fields, newest first, paged like requests', async () => {
  const list = await request('GET', `/api/projects/${PROJECT.id}/exceptions`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(list.status, 200);
  assert.equal(list.headers['access-control-allow-origin'], undefined);
  assert.equal(list.json.hasMore, false);
  const [newest, oldest] = list.json.exceptions;
  assert.deepEqual(newest, {
    seq: 2,
    id: exception(2).id,
    occurredAt: exception(2).occurredAt,
    environment: 'development',
    release: null,
    handled: true,
    fatal: false,
    requestId: REQUEST.id,
    jobRunId: null,
    name: 'TypeError',
    message: 'Cannot read properties of undefined (2)',
    code: null,
    fingerprint: '0123456789abcdef',
    mechanism: 'express',
    location: { file: 'src/orders.js', line: 12, column: 9, function: 'createOrder' },
    request: { method: 'POST', path: '/orders' },
    job: null,
    user: null
  });
  assert.equal(oldest.seq, 1);

  const page = await request('GET', `/api/projects/${PROJECT.id}/exceptions?limit=1`);
  assert.deepEqual(page.json.exceptions.map((item) => item.seq), [2]);
  assert.equal(page.json.hasMore, true);
  assert.deepEqual((await request('GET', `/api/projects/${PROJECT.id}/exceptions?before=2`)).json.exceptions.map((item) => item.seq), [1]);
  assert.deepEqual((await request('GET', `/api/projects/${PROJECT.id}/exceptions?after=0`)).json.exceptions.map((item) => item.seq), [1, 2], 'oldest first when polling');

  const detail = await request('GET', `/api/projects/${PROJECT.id}/exceptions/${exception(1).id}`);
  assert.deepEqual(detail.json, { detail: exception(1).detail });
  const missing = await request('GET', `/api/projects/${PROJECT.id}/exceptions/e0000000-0000-4000-8000-999999999999`);
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.json.error, 'string');
  assert.equal((await request('GET', `/api/projects/${PROJECT.id}/exceptions/..%2F..`)).status, 404);
  assert.equal((await request('GET', '/api/projects/unknown-11111111/exceptions')).status, 404);
  assert.equal((await request('POST', `/api/projects/${PROJECT.id}/exceptions`, { headers: { origin } })).status, 405);
});

test('requests, projects and status describe exceptions too', async () => {
  const { requests } = (await request('GET', `/api/projects/${PROJECT.id}/requests`)).json;
  assert.equal(requests[0].exceptionCount, 1);
  const detail = (await request('GET', `/api/projects/${PROJECT.id}/requests/${REQUEST.id}`)).json.detail;
  assert.deepEqual(detail.exceptions, REQUEST.detail.exceptions);

  const project = (await request('GET', '/api/projects')).json.projects.find((item) => item.id === PROJECT.id);
  assert.equal(project.exceptionCount, 2);
  assert.equal(project.lastExceptionAt, exception(2).occurredAt);
  assert.equal((await request('GET', '/api/status')).json.maxExceptions, 500);

  // Request records written before exceptions existed count none.
  store.append(PROJECT.id, [{ ...REQUEST, id: 'old-request', exceptionCount: undefined, url: '/old', path: '/old', detail: {} }]);
  assert.equal(store.list(PROJECT.id, { limit: 1 }).requests[0].exceptionCount, 0);
});

test('the dashboard shell is served for the exceptions and queries pages', async () => {
  for (const pathname of [`/p/${PROJECT.id}/exceptions`, `/p/${PROJECT.id}/exceptions/`, `/p/${PROJECT.id}/queries`, `/p/${PROJECT.id}/queries/`]) {
    const page = await request('GET', pathname);
    assert.equal(page.status, 200, pathname);
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  }
  assert.equal((await request('GET', `/p/${PROJECT.id}/exceptions/123`)).status, 404);
  assert.equal((await request('GET', `/p/${PROJECT.id}/queries/123`)).status, 404);
  assert.equal((await request('GET', `/p/${PROJECT.id}/other`)).status, 404);
});

test('resolved issues are saved with versions; stale saves get the current state back', async () => {
  const statePath = `/api/projects/${PROJECT.id}/exception-state`;
  assert.deepEqual((await request('GET', statePath)).json, { state: { resolved: {} }, version: 0 });

  const body = { state: { resolved: { '0123456789abcdef': 1_700_000_000_500 } }, version: 0 };
  const json = { 'content-type': 'application/json' };
  // A state change: this origin only, and as JSON.
  assert.equal((await request('PUT', statePath, { headers: json, body })).status, 403, 'no Origin');
  assert.equal((await request('PUT', statePath, { headers: { ...json, origin: 'http://localhost:3000' }, body })).status, 403, 'another origin');
  assert.equal((await request('PUT', statePath, { headers: { ...json, origin, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
  assert.equal((await request('PUT', statePath, { headers: { origin, 'content-type': 'text/plain' }, body })).status, 415);

  const saved = await request('PUT', statePath, { headers: { ...json, origin }, body });
  assert.deepEqual(saved.json, { version: 1 });
  assert.deepEqual((await request('GET', statePath)).json, { state: body.state, version: 1 });

  const stale = await request('PUT', statePath, { headers: { ...json, origin }, body: { state: { resolved: {} }, version: 0 } });
  assert.equal(stale.status, 409);
  assert.deepEqual({ state: stale.json.state, version: stale.json.version }, { state: body.state, version: 1 });
  assert.equal(typeof stale.json.error, 'string');

  const invalid = [
    { state: { resolved: { NOT_A_FINGERPRINT: 1 } }, version: 1 },
    { state: { resolved: { '0123456789abcdef': 'yesterday' } }, version: 1 },
    { state: { resolved: [] }, version: 1 },
    { state: { resolved: {} }, version: 'one' },
    { state: { resolved: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [i.toString(16).padStart(16, '0'), 1])) }, version: 1 }
  ];
  for (const bad of invalid) {
    assert.equal((await request('PUT', statePath, { headers: { ...json, origin }, body: bad })).status, 400);
  }
  assert.equal((await request('PUT', statePath, { headers: { ...json, origin }, body: '{nope' })).status, 400);

  const second = await request('PUT', statePath, { headers: { ...json, origin }, body: { state: { resolved: {} }, version: 1 } });
  assert.deepEqual(second.json, { version: 2 });
  // Kept across restarts.
  assert.deepEqual(new Store(dataDir).load().exceptionState(PROJECT.id), { state: { resolved: {} }, version: 2 });
});

test('clearing exceptions needs this origin and keeps numbering going', async () => {
  const listPath = `/api/projects/${PROJECT.id}/exceptions`;
  assert.equal((await request('DELETE', listPath)).status, 403);
  const cleared = await request('DELETE', listPath, { headers: { origin, 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(cleared.json, { cleared: true });
  assert.deepEqual((await request('GET', listPath)).json, { exceptions: [], hasMore: false });
  assert.equal((await request('GET', '/api/projects')).json.projects.find((item) => item.id === PROJECT.id).lastExceptionAt, null);
  assert.equal((await request('GET', `/api/projects/${PROJECT.id}/requests`)).json.requests.length, 2, 'requests stay');

  await request('POST', '/api/ingest', { headers: SDK, body: { project: PROJECT, instance: INSTANCE, requests: [], exceptions: [exception(9)] } });
  assert.equal((await request('GET', listPath)).json.exceptions[0].seq, 3);
  // Across restarts too.
  const reloaded = new Store(dataDir).load();
  reloaded.clearExceptions(PROJECT.id);
  assert.equal(new Store(dataDir).load().appendExceptions(PROJECT.id, [flat(exception(10))])[0].seq, 4);
});

// What IngestPayload makes of an exception: its summary fields next to the record's.
function flat(record) {
  const { summary, ...rest } = record;
  return { ...rest, ...summary };
}

test('keeps the newest maxExceptions, in their own folder', () => {
  const dir = tempDir();
  const local = new Store(dir, { maxExceptions: 20 }).load();
  local.touch(PROJECT, INSTANCE);
  local.append(PROJECT.id, [{ ...flat(REQUEST), url: '/orders', path: '/orders', contentType: '' }]);
  for (let i = 0; i < 12; i++) {
    local.appendExceptions(PROJECT.id, Array.from({ length: 5 }, (_, j) => flat(exception(i * 5 + j + 1))));
  }
  const kept = local.listExceptions(PROJECT.id, { limit: 1000 }).exceptions;
  assert.ok(kept.length >= 20 && kept.length < 30, `kept ${kept.length}`);
  assert.equal(kept[0].id, exception(60).id);
  assert.equal(local.exceptionDetail(PROJECT.id, exception(1).id), null);

  // Request files stay where they always were; exceptions have their own folder.
  const folder = path.join(dir, 'projects', PROJECT.id);
  assert.deepEqual(fs.readdirSync(folder).filter((name) => name.endsWith('.jsonl')), ['00000001.jsonl']);
  assert.ok(fs.readdirSync(path.join(folder, 'exceptions')).filter((name) => name.endsWith('.jsonl')).length <= 3);
  assert.equal(new Store(dir, { maxExceptions: 20 }).load().listExceptions(PROJECT.id, { limit: 1000 }).exceptions.length, kept.length);
  assert.equal(local.listProjects()[0].requestCount, 1);
});

test('loads data folders written before exceptions existed', () => {
  const dir = tempDir();
  const folder = path.join(dir, 'projects', PROJECT.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ name: 'orders-api', root: '/work/orders-api', createdAt: 1, lastSeenAt: 2, seqBase: 5 }));
  fs.writeFileSync(path.join(folder, '00000001.jsonl'), '{"body":"old"}\n');
  fs.writeFileSync(path.join(folder, '00000001.idx'), `${JSON.stringify({ seq: 5, id: 'old-1', occurredAt: 3, method: 'GET', status: 200, url: '/', path: '/', off: 0, len: 14 })}\n`);

  const loaded = new Store(dir).load();
  assert.deepEqual(loaded.list(PROJECT.id, { limit: 10 }).requests.map((item) => [item.id, item.exceptionCount]), [['old-1', 0]]);
  assert.deepEqual(loaded.detail(PROJECT.id, 'old-1'), { body: 'old' });
  assert.deepEqual(loaded.listExceptions(PROJECT.id, { limit: 10 }), { exceptions: [], hasMore: false });
  assert.equal(loaded.listProjects()[0].exceptionCount, 0);
  assert.deepEqual(loaded.exceptionState(PROJECT.id), { state: { resolved: {} }, version: 0 });
});

test('ingests spool files and deletes them', () => {
  const dir = tempDir();
  const local = new Store(dir).load();
  const crashed = { id: 'crashed-app-9f8e7d6c', name: 'crashed-app', root: '/work/crashed' };
  const spool = Spool.local(dir, crashed.id);
  spool.write({ project: crashed, instance: { pid: 999999, startedAt: 1 }, requests: [{ ...REQUEST, aborted: true, status: null }], exceptions: [exception(1, { fatal: true, summary: { ...exception(1).summary, mechanism: 'uncaught' } })] });
  spool.write({ project: crashed, instance: { pid: 999999, startedAt: 1 }, requests: [], exceptions: [exception(1)] });
  fs.writeFileSync(path.join(spool.dir, 'broken.json'), '{not json');
  // Filed under another project's folder: refused.
  Spool.local(dir, 'other-app-12345678').write({ project: crashed, instance: { pid: 1 }, requests: [], exceptions: [exception(2)] });
  // Cloud batches are the SDK's business.
  const cloud = Spool.cloud(dir, 'p0123456789ab');
  cloud.write({ createdAt: Date.now(), body: { events: [], exceptions: [] } });
  // A writer that died mid-write leaves a temporary file, which is ignored.
  fs.writeFileSync(path.join(spool.dir, 'partial.json.123.tmp'), '{"proj');

  const logged = [];
  const ingester = new SpoolIngester({ store: local, dataDir: dir, log: (line) => logged.push(line) });
  assert.deepEqual(ingester.ingest(), { requests: 1, exceptions: 1 }, 'the same exception twice is stored once');

  const [project] = local.listProjects();
  assert.equal(project.name, 'crashed-app');
  assert.equal(project.online, false, 'a crashed process is not listed as running');
  assert.equal(project.exceptionCount, 1);
  const [stored] = local.listExceptions(crashed.id, { limit: 10 }).exceptions;
  assert.equal(stored.fatal, true);
  assert.equal(stored.mechanism, 'uncaught');
  assert.equal(local.list(crashed.id, { limit: 10 }).requests[0].aborted, true);
  assert.deepEqual(spool.list(), []);
  assert.deepEqual(fs.readdirSync(spool.dir), ['partial.json.123.tmp']);
  assert.deepEqual(Spool.local(dir, 'other-app-12345678').list(), []);
  assert.equal(local.has('other-app-12345678'), false);
  assert.equal(cloud.list().length, 1);
  assert.equal(logged.length, 2);
  assert.deepEqual(ingester.ingest(), { requests: 0, exceptions: 0 });
});
