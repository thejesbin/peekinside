// Replay: the local dashboard sends a recorded request to the app again, through the hub, as it was
// received. The SDK records it under the id the hub gave it, linked to the original, so the
// dashboard can put the two side by side. Only this machine, only from the dashboard's page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import PeekInside from '../index.js';
import { REPLAY_ID_HEADER, REPLAY_OF_HEADER, readReplay, withoutReplayHeaders } from '../src/capture/replay.js';
import { Replay, ReplayError } from '../src/hub/replay.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-replay-'));
process.env.PEEKINSIDE_HOME = dataDir;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(dataDir).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir });
const hubHost = `127.0.0.1:${hubPort}`;

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function send(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, json: /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Asks the hub to replay a request, as the dashboard's page does.
function replay(projectId, requestId, headers = {}) {
  const body = JSON.stringify({ requestId });
  return send(hubPort, {
    method: 'POST',
    path: `/api/projects/${projectId}/replays`,
    headers: { host: hubHost, origin: `http://${hubHost}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    body
  });
}

async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = { project, requests: store.list(project.id, { limit: 1000 }).requests.reverse() };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { requests: result.requests.length, online: result.project.online })}`);
}

test('a replay is the request again, recorded under its own id next to the original', async () => {
  const name = 'replay-api';
  const app = express();
  app.use(express.json());
  const peekInside = PeekInside.attach(app, { project: name, local: true });
  const received = [];
  app.post('/orders/:id', (req, res) => {
    received.push({ url: req.originalUrl, headers: { ...req.headers }, body: req.body });
    res.status(201).json({ id: req.params.id, call: received.length });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const body = JSON.stringify({ items: ['sku-1'], note: 'gift' });
    const first = await send(port, {
      method: 'POST',
      path: '/orders/42?expand=items',
      headers: {
        host: `localhost:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: 'Bearer secret-token',
        cookie: 'session=abc',
        'x-trace': 'one'
      },
      body
    });
    assert.equal(first.status, 201);

    const before = await stored(peekInside, name, (r) => r.requests.length === 1 && r.project.instances.some((instance) => instance.port === port));
    const original = before.requests[0];
    assert.equal(original.replayOf, null);

    const answer = await replay(before.project.id, original.id);
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.match(answer.json.replay.id, UUID);
    assert.equal(answer.json.replay.status, 201);
    assert.equal(answer.json.replay.statusMessage, 'Created');
    assert.ok(answer.json.replay.duration >= 0);

    // The app got the same request: target, credentials, the Host it was sent to, the body.
    assert.equal(received.length, 2);
    const [sent, again] = received;
    assert.equal(again.url, sent.url);
    assert.deepEqual(again.body, sent.body);
    for (const header of ['host', 'authorization', 'cookie', 'x-trace', 'content-type', 'content-length']) {
      assert.equal(again.headers[header], sent.headers[header], header);
    }
    assert.equal(again.headers[REPLAY_OF_HEADER], original.id);

    const after = await stored(peekInside, name, (r) => r.requests.length === 2);
    const copy = after.requests[1];
    assert.equal(copy.id, answer.json.replay.id, "the record takes the hub's id, so the dashboard can open it");
    assert.equal(copy.replayOf, original.id);
    assert.equal(copy.status, 201);
    assert.equal(copy.url, original.url);
    const detail = store.detail(after.project.id, copy.id);
    assert.equal(detail.body, store.detail(after.project.id, original.id).body);
    assert.equal(detail.headers[REPLAY_OF_HEADER], undefined, "the replay's headers aren't recorded");
    assert.equal(detail.headers[REPLAY_ID_HEADER], undefined);

    const listed = await send(hubPort, { path: `/api/projects/${after.project.id}/requests`, headers: { host: hubHost } });
    assert.deepEqual(listed.json.requests.map((item) => item.replayOf), [original.id, null], 'newest first');
    const status = await send(hubPort, { path: '/api/status', headers: { host: hubHost } });
    assert.equal(status.json.replay, true, 'tells the dashboard this hub replays');
  } finally {
    server.close();
    peekInside.stop();
  }
});

test('only the dashboard page can replay', async () => {
  const name = 'replay-guard';
  const app = express();
  const peekInside = PeekInside.attach(app, { project: name, local: true });
  let calls = 0;
  app.get('/ping', (req, res) => res.json({ calls: ++calls }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await send(server.address().port, { path: '/ping' });
    const { project, requests } = await stored(peekInside, name, (r) => r.requests.length === 1);

    assert.equal((await replay(project.id, requests[0].id, { origin: 'https://evil.example' })).status, 403, 'another site');
    assert.equal((await replay(project.id, requests[0].id, { 'sec-fetch-site': 'same-site' })).status, 403, 'another port on localhost');
    const noOrigin = await send(hubPort, {
      method: 'POST',
      path: `/api/projects/${project.id}/replays`,
      headers: { host: hubHost, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requests[0].id })
    });
    assert.equal(noOrigin.status, 403, 'no Origin');
    assert.equal((await replay(project.id, requests[0].id, { host: `evil.example:${hubPort}` })).status, 403, 'a foreign Host (DNS rebinding)');
    assert.equal(calls, 1, 'nothing was replayed');

    assert.equal((await send(hubPort, { path: `/api/projects/${project.id}/replays`, headers: { host: hubHost } })).status, 405);
    assert.equal((await replay(project.id, '00000000-0000-4000-8000-000000000000')).status, 404, 'no longer stored');
    assert.equal((await replay(project.id, '../../etc')).status, 400);
    assert.equal((await replay(project.id, requests[0].id)).status, 200);
    assert.equal(calls, 2);
  } finally {
    server.close();
    peekInside.stop();
  }
});

test('a request is sent as it was received; one that can\'t be is refused with the reason', () => {
  const summary = { id: 'a1', method: 'POST', url: '/forms?x=1' };
  const built = Replay.build({
    summary,
    detail: {
      headers: {
        host: 'localhost:3000',
        connection: 'keep-alive',
        'content-length': '999',
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
        expect: '100-continue',
        'content-type': 'application/json',
        accept: ['application/json', 'text/plain'],
        'x-peekinside-replay-of': 'old'
      },
      body: '{"a":1}',
      bodyEncoding: 'utf8',
      protocol: 'http'
    }
  });
  assert.deepEqual(built, {
    method: 'POST',
    path: '/forms?x=1',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: ['application/json', 'text/plain'], 'content-length': '7' },
    body: '{"a":1}',
    protocol: 'http'
  });

  // A form known only from what a framework parsed it into goes out as a form again.
  const form = Replay.build({ summary, detail: { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '{"name":"Ada Lovelace","tags":["a","b"]}', bodyEncoding: 'utf8' } });
  assert.equal(form.body, 'name=Ada+Lovelace&tags=a&tags=b');
  // HTTP/2's :authority is the Host; a proxy's absolute target becomes a path.
  const h2 = Replay.build({ summary: { id: 'a2', method: 'GET', url: 'http://api.test/items?page=2' }, detail: { headers: { ':authority': 'localhost:8443', ':path': '/items' }, bodyEncoding: 'none', protocol: 'https' } });
  assert.deepEqual([h2.path, h2.headers, h2.body, h2.protocol], ['/items?page=2', { host: 'localhost:8443' }, null, 'https']);
  // A body the app never read wasn't kept: none is sent.
  assert.equal(Replay.build({ summary, detail: { headers: {}, bodyEncoding: 'unavailable', body: '' } }).body, null);

  const refused = (detail, method = 'POST') => {
    try {
      Replay.build({ summary: { ...summary, method }, detail });
    } catch (error) {
      assert.ok(error instanceof ReplayError);
      assert.equal(error.status, 409);
      return error.message;
    }
    return assert.fail('expected a refusal');
  };
  assert.match(refused({ bodyEncoding: 'binary', body: '' }), /binary/);
  assert.match(refused({ bodyEncoding: 'utf8', body: '{"a":', bodyTruncated: true }), /larger than what PeekInside keeps/);
  assert.match(refused({ bodyEncoding: 'none' }, 'OTHER'), /method/);
});

test("the app's port: its running process's, else a Host on this machine", () => {
  const instances = [{ pid: 2, port: 4000 }, { pid: 1, port: 3000 }];
  assert.equal(Replay.port(instances, 'localhost:3000', 'http'), 3000, 'the process the Host names');
  assert.equal(Replay.port(instances, 'shop.test', 'http'), 4000, 'else the newest');
  assert.equal(Replay.port([{ pid: 3, port: null }], 'localhost:5173', 'http'), 5173, 'a Host on this machine');
  assert.equal(Replay.port([], 'app.localhost', 'https'), 443);
  assert.equal(Replay.port([], '[::1]:8080', 'http'), 8080);
  assert.equal(Replay.port([], 'api.example.com:3000', 'http'), null, 'never another machine');
  assert.equal(Replay.port([], undefined, 'http'), null);
});

test("an app that isn't running, or doesn't answer, is said so", async () => {
  const source = (instances, host = 'localhost') => ({
    name: 'orders-api',
    summary: { id: 'r1', method: 'GET', url: '/slow' },
    detail: { headers: { host }, bodyEncoding: 'none' },
    instances
  });
  const failure = async (run) => {
    try {
      await run;
    } catch (error) {
      assert.ok(error instanceof ReplayError, String(error));
      return error;
    }
    return assert.fail('expected the replay to fail');
  };

  const notRunning = await failure(Replay.run(source([], 'api.example.com')));
  assert.equal(notRunning.status, 409);
  assert.match(notRunning.message, /orders-api isn't running/);

  const closed = await failure(Replay.run(source([{ port: await freePort() }])));
  assert.equal(closed.status, 502);
  assert.match(closed.message, /Nothing answers on port/);

  let aborted = false;
  const silent = http.createServer((req) => req.on('close', () => (aborted = true)));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    const late = await failure(Replay.run(source([{ port: silent.address().port }]), { timeoutMs: 200 }));
    assert.equal(late.status, 504);
    assert.match(late.message, /orders-api didn't answer within/);
    await pause(50);
    assert.ok(aborted, 'the replay is stopped, not left waiting');
  } finally {
    silent.close();
  }
});

test('replay headers: both ids, valid and different, and never recorded', () => {
  const id = '6f1c2a54-7c1e-4d3b-9a77-2b8f0f4f3c21';
  const of = '0b7e1c55-3f7a-4c1d-8e2f-9a6b5c4d3e21';
  assert.deepEqual(readReplay({ [REPLAY_ID_HEADER]: id, [REPLAY_OF_HEADER]: of }), { id, of });
  assert.equal(readReplay({ [REPLAY_ID_HEADER]: id }), null);
  assert.equal(readReplay({ [REPLAY_ID_HEADER]: id, [REPLAY_OF_HEADER]: id }), null);
  assert.equal(readReplay({ [REPLAY_ID_HEADER]: '../x', [REPLAY_OF_HEADER]: of }), null);
  assert.equal(readReplay({ [REPLAY_ID_HEADER]: [id, id], [REPLAY_OF_HEADER]: of }), null);
  assert.deepEqual(withoutReplayHeaders({ a: '1', [REPLAY_ID_HEADER]: id, [REPLAY_OF_HEADER]: of }), { a: '1' });
});
