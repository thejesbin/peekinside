// Dumps: PeekInside.dump() reads a value into a tree without running the app's code, and the
// local dashboard gets it with the line that dumped it, linked to its request or job run (listed on
// the request's record and placed on its timeline). PeekInside Cloud never gets dumps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import express from 'express';
import PeekInside from '../index.js';
import { DumpRecord } from '../src/dumps/dump-record.js';
import { DumpValue, DUMP_LIMITS } from '../src/dumps/dump-value.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-dumps-'));
process.env.PEEKINSIDE_HOME = dataDir;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(dataDir).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir });

before(() => new Promise((resolve) => hub.listen(resolve)));
after(() => {
  hub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tree = (value) => DumpValue.capture(value).tree;
const prop = (node, name) => node.props.find(([key]) => key === name)?.[1];

function get(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }));
    }).on('error', reject);
  });
}

async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = {
        project,
        dumps: store.listDumps(project.id, { limit: 1000 }).dumps.reverse(),
        requests: store.list(project.id, { limit: 1000 }).requests.reverse(),
        jobs: store.listJobs(project.id, { limit: 1000 }).jobs.reverse()
      };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { dumps: result.dumps.length, requests: result.requests.length })}`);
}

test('values keep their types: primitives, dates, maps, sets, class instances, errors', () => {
  assert.deepEqual(tree('hi'), { t: 'str', v: 'hi' });
  assert.deepEqual(tree(-0), { t: 'num', v: '-0' });
  assert.deepEqual(tree(NaN), { t: 'num', v: 'NaN' });
  assert.deepEqual(tree(10n), { t: 'big', v: '10' });
  assert.deepEqual(tree(undefined), { t: 'undef' });
  assert.deepEqual(tree(null), { t: 'null' });
  assert.deepEqual(tree(new Date(0)), { t: 'date', v: '1970-01-01T00:00:00.000Z' });
  assert.deepEqual(tree(/a+/gi), { t: 're', v: '/a+/gi' });
  assert.deepEqual(tree(Symbol('id')), { t: 'sym', v: 'Symbol(id)' });
  assert.deepEqual(tree(async function load() {}), { t: 'fn', name: 'load', kind: 'async' });
  assert.deepEqual(tree(class Cart {}), { t: 'fn', name: 'Cart', kind: 'class' });
  assert.deepEqual(tree(new Map([['a', 1]])), { t: 'map', len: 1, entries: [[{ t: 'str', v: 'a' }, { t: 'num', v: '1' }]] });
  assert.deepEqual(tree(new Set([1, 2])), { t: 'set', len: 2, items: [{ t: 'num', v: '1' }, { t: 'num', v: '2' }] });
  assert.deepEqual(tree([1, , 3]), { t: 'arr', len: 3, items: [{ t: 'num', v: '1' }, { t: 'hole' }, { t: 'num', v: '3' }] });
  assert.deepEqual(tree(new Uint8Array([7])), { t: 'arr', cls: 'Uint8Array', len: 1, items: [{ t: 'num', v: '7' }] });
  assert.deepEqual(tree(Buffer.from('hi')), { t: 'buf', cls: 'Buffer', len: 2, hex: '6869' });

  class Order {
    constructor() {
      this.id = 7;
    }
  }
  assert.deepEqual(tree(new Order()), { t: 'obj', cls: 'Order', len: 1, props: [['id', { t: 'num', v: '7' }]] });
  assert.equal(tree({ a: 1 }).cls, null, 'a plain object has no class');

  const error = Object.assign(new TypeError('bad card', { cause: new Error('declined') }), { code: 'E_CARD' });
  const node = tree(error);
  assert.equal(node.t, 'err');
  assert.equal(node.cls, 'TypeError');
  assert.equal(node.msg, 'bad card');
  assert.match(node.stack, /^TypeError: bad card\n\s+at /);
  assert.deepEqual(prop(node, 'code'), { t: 'str', v: 'E_CARD' });
  assert.equal(prop(node, 'cause').msg, 'declined');
});

test("reading runs none of the app's code: getters, proxies; cycles point back", () => {
  let called = 0;
  const value = { id: 1 };
  Object.defineProperty(value, 'total', { enumerable: true, get: () => called++ });
  value.self = value;
  value.trap = new Proxy({}, { ownKeys: () => (called++, []), get: () => called++ });
  const node = tree(value);
  assert.equal(called, 0);
  assert.deepEqual(prop(node, 'total'), { t: 'get' });
  assert.deepEqual(prop(node, 'self'), { t: 'ref', path: '$' });
  assert.deepEqual(prop(node, 'trap'), { t: 'proxy' });

  const shared = { n: 1 };
  const twice = tree({ a: shared, b: shared });
  assert.deepEqual(prop(twice, 'b'), { t: 'obj', cls: null, len: 1, props: [['n', { t: 'num', v: '1' }]] }, 'a value seen twice, not in a cycle, is shown twice');
});

test('trees are bounded: long strings, many items, deep nesting', () => {
  const long = DumpValue.capture('x'.repeat(DUMP_LIMITS.string + 10));
  assert.equal(long.tree.v.length, DUMP_LIMITS.string);
  assert.equal(long.tree.len, DUMP_LIMITS.string + 10);
  assert.equal(long.truncated, true);

  const many = DumpValue.capture(Array.from({ length: 250 }, (_, index) => index));
  assert.equal(many.tree.len, 250);
  assert.equal(many.tree.items.length, DUMP_LIMITS.items);
  assert.equal(many.preview, '[0, 1, 2, 3, …]');

  let deep = { level: 0 };
  const root = deep;
  for (let level = 1; level < 30; level++) deep = deep.next = { level };
  let node = DumpValue.capture(root).tree;
  let depth = 0;
  while (node.t === 'obj') {
    node = prop(node, 'next');
    depth++;
  }
  assert.equal(node.t, 'cut');
  assert.equal(depth, DUMP_LIMITS.depth);
});

test('previews read like the console', () => {
  class User {
    constructor() {
      this.id = 1;
      this.name = 'Ada';
      this.roles = ['admin'];
    }
  }
  assert.equal(DumpValue.capture(new User()).preview, 'User { id: 1, name: "Ada", roles: ["admin"] }');
  assert.equal(DumpValue.capture(new Map([['k', { a: 1 }]])).preview, 'Map(1) { "k" => { a: 1 } }');
  assert.equal(DumpValue.capture(new RangeError('too far')).preview, 'RangeError: too far');
  assert.equal(DumpValue.capture(new User()).type, 'User');
  assert.equal(DumpValue.capture([1]).type, 'array');
});

test('dumps reach the local dashboard: with their line, linked to the request or job run', async () => {
  const name = 'dumps-api';
  const app = express();
  app.use(express.json());
  const peekInside = PeekInside.attach(app, { project: name, local: true });
  let returned = null;
  app.post('/checkout', (req, res) => {
    const cart = { items: req.body.items, total: 42 };
    returned = PeekInside.dump(cart, 'cart');
    res.json({ same: returned === cart });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const answer = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ items: ['sku-1', 'sku-2'] });
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/checkout', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.deepEqual(answer, { same: true }, 'dump() returns the value itself');

    await PeekInside.job('nightly-report', () => peekInside.dump(['row 1', 'row 2'], 'rows'));
    PeekInside.dump(new Map([['ready', true]]));

    const result = await stored(peekInside, name, (r) => r.dumps.length >= 3 && r.requests.length >= 1 && r.jobs.length >= 1);
    const [cart, rows, outside] = result.dumps;
    const request = result.requests[0];

    assert.equal(cart.label, 'cart');
    assert.equal(cart.type, 'object');
    assert.equal(cart.preview, '{ items: ["sku-1", "sku-2"], total: 42 }');
    assert.equal(cart.requestId, request.id);
    assert.equal(cart.jobRunId, null);
    assert.equal(cart.location.relativeFile, 'test/dumps.test.js');
    assert.equal(cart.location.function, null);
    assert.ok(cart.location.line > 0);
    assert.ok(path.isAbsolute(cart.location.file), 'the absolute file, for editor links');
    const detail = store.dumpDetail(result.project.id, cart.id);
    assert.deepEqual(prop(detail.value, 'items'), { t: 'arr', len: 2, items: [{ t: 'str', v: 'sku-1' }, { t: 'str', v: 'sku-2' }] });

    const requestDetail = store.detail(result.project.id, request.id);
    assert.deepEqual(requestDetail.dumps, [{ id: cart.id, label: 'cart', type: 'object', preview: cart.preview }]);
    const span = requestDetail.timeline.spans.find((item) => item.type === 'dump');
    assert.equal(span.id, cart.id);
    assert.equal(span.label, 'cart');

    assert.equal(rows.jobRunId, result.jobs[0].id, 'linked to the job run');
    assert.equal(rows.requestId, null);
    assert.equal(outside.requestId, null);
    assert.equal(outside.label, null);
    assert.equal(outside.preview, 'Map(1) { "ready" => true }');

    const project = result.project;
    assert.equal(project.dumpCount, 3);
    const listed = await get(hubPort, `/api/projects/${project.id}/dumps`, { host: `127.0.0.1:${hubPort}` });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.dumps.map((item) => item.id), [outside.id, rows.id, cart.id], 'newest first');
    const one = await get(hubPort, `/api/projects/${project.id}/dumps/${cart.id}`, { host: `127.0.0.1:${hubPort}` });
    assert.deepEqual(one.json.detail, detail);
    assert.equal((await get(hubPort, `/p/${project.id}/dumps`, { host: `127.0.0.1:${hubPort}` })).status, 200, 'the Dumps page');
  } finally {
    server.close();
    peekInside.stop();
  }
});

test('with PeekInside Cloud, or nothing recording, dump() only returns the value', async () => {
  const value = { a: 1 };
  const off = new PeekInside({ local: false });
  assert.equal(off.dump(value), value);
  assert.equal(off._dumps, null);
  off.stop();

  // A well-formed key for a cloud that isn't there: nothing is queued, so nothing is sent.
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
  const apiKey = `pik1.p0123456789ab.${'s'.repeat(43)}.${publicKey}`;
  const cloud = new PeekInside({ apiKey, runtime: false });
  try {
    assert.ok(cloud._cloud, 'cloud mode');
    assert.equal(cloud.dump(value, 'x'), value);
    assert.equal(cloud._dumps, null, 'dumps are for the local dashboard');
    cloud._cloud.enqueueRecord(new DumpRecord({ id: 'd1', occurredAt: Date.now(), environment: 'production', summary: { type: 'number', preview: '1', truncated: false }, detail: { value: { t: 'num', v: '1' } } }));
    assert.equal(cloud._cloud.queue.length, 0, 'the cloud transport drops a dump it is handed');
  } finally {
    cloud.stop();
  }
});
