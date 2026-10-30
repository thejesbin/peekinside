// PeekInside Cloud: exceptions are sealed like requests, a crash is delivered before the process
// exits (posted from a child process the app waits for), and when that fails it is spooled and
// sent by the next run. A fake ingest server stands in for PeekInside Cloud.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import express from 'express';
import PeekInside from '../index.js';
import { Sealer, SyncSealer } from '../src/crypto.js';
import { RequestRecord } from '../src/record.js';
import { Spool } from '../src/spool.js';
import { CloudTransport } from '../src/transport/cloud.js';

const subtle = webcrypto.subtle;
const ENTRY = pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href;
// The dashboard's implementation, when the PeekInside Cloud repository sits next to this one.
const CLOUD_E2EE = process.env.PEEKINSIDE_CLOUD_E2EE || fileURLToPath(new URL('../../peekinside-cloud/src/lib/e2ee.ts', import.meta.url));

const PROJECT_ID = 'p0123456789ab';
const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const PUBLIC_KEY = Buffer.from(await subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const API_KEY = `pik1.${PROJECT_ID}.${'s'.repeat(43)}.${PUBLIC_KEY}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-cloud-home-'));
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-cloud-app-'));
process.env.PEEKINSIDE_HOME = home;
// Everything here is cloud mode; should anything fall back to the local dashboard, it finds
// neither a hub to report to nor the default port.
process.env.PEEKINSIDE_LOCAL = '0';
process.env.PEEKINSIDE_HUB_PORT = String(await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
}));

// The fake PeekInside Cloud: records every batch it is sent, or answers 503 while `down`. Like
// PeekInside Cloud, it checks the plan before the batch: while `paused` it answers 402 (keeping
// what it was sent in `refused`), and it refuses a batch with nothing in it.
const batches = [];
const refused = [];
let down = false;
let paused = false;
let answer = { accepted: true };
const LISTS = ['events', 'exceptions', 'jobs', 'logs', 'samples', 'heapWindows', 'blockWindows'];
const ingest = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (down || req.url !== '/api/ingest') {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":"down"}');
    }
    const parsed = JSON.parse(body);
    if (paused) {
      refused.push(parsed);
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'PeekInside Cloud is paused for this project\'s organization. Choose a plan to keep sending data.' }));
    }
    if (!LISTS.some((list) => Array.isArray(parsed[list]) && parsed[list].length)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":"Send at least one event, exception, job run, log line or sample"}');
    }
    batches.push({ headers: req.headers, body: parsed, bytes: Buffer.byteLength(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
});
let ingestUrl;
const children = new Set();

const APP = `import http from 'node:http';
const PeekInside = process.env.ATTACH === '1' ? (await import(process.env.ENTRY)).default : null;
const server = http.createServer((req, res) => {
  if (req.url === '/timer') {
    setTimeout(() => {
      throw new Error('cloud crash in a timer');
    }, 10);
    return;
  }
  res.end('ok');
});
if (PeekInside) PeekInside.attach(server);
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

before(async () => {
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  ingestUrl = `http://127.0.0.1:${ingest.address().port}`;
  process.env.PEEKINSIDE_URL = ingestUrl;
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'cloud-app', type: 'module' }));
  fs.writeFileSync(path.join(appDir, 'app.mjs'), APP);
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  ingest.close();
  ingest.closeAllConnections();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

// The dashboard's Opener, in Web Crypto, for when the cloud repository isn't available.
async function open(sealed, aad, purpose = 'event') {
  const [version, ephemeral, iv, ciphertext] = sealed.split('.');
  assert.equal(version, 'v1');
  const ephemeralRaw = Buffer.from(ephemeral, 'base64url');
  const ephemeralKey = await subtle.importKey('raw', ephemeralRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ephemeralKey }, keys.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: Buffer.concat([ephemeralRaw, Buffer.from(PUBLIC_KEY, 'base64url')]), info: Buffer.from(`peekinside/v1/${purpose}`) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: Buffer.from(aad) }, key, Buffer.from(ciphertext, 'base64url'));
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

async function openException(sealed) {
  return {
    ...sealed,
    summary: await open(sealed.summary, `exception:summary:${sealed.id}`),
    detail: await open(sealed.detail, `exception:detail:${sealed.id}`)
  };
}

async function openEvent(sealed) {
  return { ...sealed, summary: await open(sealed.summary, `summary:${sealed.id}`), detail: await open(sealed.detail, `detail:${sealed.id}`) };
}

// A block in the app's own code.
function reconcileLedger(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) total += Math.sqrt(total + 5);
  return total;
}

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    const found = check();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function runApp({ attach = true, route, env = {}, untilReady = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(appDir, 'app.mjs')], {
      cwd: appDir,
      env: { ...process.env, PEEKINSIDE_API_KEY: API_KEY, ATTACH: attach ? '1' : '0', ENTRY, NODE_OPTIONS: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let sent = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /PORT (\d+)/.exec(stdout);
      if (!match || sent) return;
      sent = true;
      if (untilReady) return resolve({ child, port: Number(match[1]) });
      http.get({ host: '127.0.0.1', port: Number(match[1]), path: route }).on('error', () => {});
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

test('SyncSealer output opens with the dashboard\'s Opener, like Sealer output', async () => {
  const sync = SyncSealer.create(PUBLIC_KEY, 'event');
  const sealed = sync.seal(JSON.stringify({ text: 'naïve ☃' }), 'exception:summary:abc');
  const [version, ephemeral, iv, ciphertext] = sealed.split('.');
  assert.equal(version, 'v1');
  assert.equal(Buffer.from(ephemeral, 'base64url').length, 65, 'uncompressed P-256 point');
  assert.equal(Buffer.from(iv, 'base64url').length, 12);
  assert.equal(Buffer.from(ciphertext, 'base64url').length, Buffer.byteLength('{"text":"naïve ☃"}') + 16, 'ciphertext then the GCM tag');
  assert.deepEqual(await open(sealed, 'exception:summary:abc'), { text: 'naïve ☃' });
  await assert.rejects(open(sealed, 'exception:detail:abc'), 'bound to its AAD');
  await assert.rejects(open(SyncSealer.create(PUBLIC_KEY, 'project-key').seal('{}', 'x'), 'x'), 'bound to its purpose');
  // One sealer, one ephemeral key, a fresh IV per message.
  const second = sync.seal('{}', 'a');
  assert.equal(second.split('.')[1], ephemeral);
  assert.notEqual(second.split('.')[2], iv);

  const asyncSealed = await (await Sealer.create(PUBLIC_KEY, 'event')).seal('{"from":"async"}', 'detail:1');
  assert.deepEqual(await open(asyncSealed, 'detail:1'), { from: 'async' }, 'both sealers produce the same format');
});

test('SyncSealer output opens with the PeekInside Cloud repository\'s Opener', {
  skip: !fs.existsSync(CLOUD_E2EE) ? 'the PeekInside Cloud repository is not next to this one' : !process.features.typescript && 'this Node.js version cannot run TypeScript'
}, async () => {
  const { Opener, KeyPairs } = await import(pathToFileURL(CLOUD_E2EE).href);
  const pair = await KeyPairs.generate();
  const publicKey = await KeyPairs.exportPublic(pair.publicKey);
  const opener = new Opener(pair.privateKey, publicKey, 'event');

  const sync = SyncSealer.create(publicKey, 'event');
  assert.equal(await opener.openText(sync.seal('{"crash":true}', 'exception:detail:e1'), 'exception:detail:e1'), '{"crash":true}');
  assert.equal(await opener.openText(sync.seal('second message', 'summary:r1'), 'summary:r1'), 'second message');
  await assert.rejects(opener.openText(sync.seal('x', 'exception:summary:e1'), 'exception:summary:e2'));
  const sealer = await Sealer.create(publicKey, 'event');
  assert.equal(await opener.openText(await sealer.seal('async path', 'detail:r1'), 'detail:r1'), 'async path');
});

test('cloud mode seals exceptions into the same batches as requests', async () => {
  batches.length = 0;
  const app = express();
  app.set('env', 'test');
  const log = console.log;
  console.log = () => {};
  const peekInside = PeekInside.attach(app, { apiKey: API_KEY, local: false });
  console.log = log;
  assert.ok(peekInside._cloud, 'cloud mode');
  app.get('/orders/:id', (req) => {
    console.warn('about to fail');
    throw new Error(`order ${req.params.id} failed`);
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/orders/42' }, (res) => res.resume().on('end', resolve)));
    const batch = await waitFor(() => {
      void peekInside.flush();
      return batches.find((item) => item.body.exceptions && item.body.events.length);
    }, 'a batch with the request and its exception');

    assert.equal(batch.headers.authorization, `Bearer ${'s'.repeat(43)}`);
    assert.equal(batch.headers['x-peekinside-project'], PROJECT_ID);
    const [event] = batch.body.events;
    const [sealedException] = batch.body.exceptions;
    assert.equal(event.exceptionCount, 1, 'a plain column, for lists');
    assert.deepEqual(Object.keys(sealedException), ['id', 'occurredAt', 'environment', 'release', 'handled', 'fatal', 'requestId', 'jobRunId', 'fingerprint', 'summary', 'detail']);
    assert.match(sealedException.fingerprint, /^[0-9a-f]{16}$/, 'the fingerprint, for alerts on new errors: a hash, not the error');
    assert.equal(sealedException.requestId, event.id);
    assert.equal(sealedException.environment, 'production');
    assert.match(sealedException.summary, /^v1\./);
    assert.ok(!JSON.stringify(batch.body).includes('order 42 failed'), 'nothing readable leaves the app');

    const exception = await openException(sealedException);
    assert.equal(exception.summary.message, 'order 42 failed');
    assert.equal(sealedException.fingerprint, exception.summary.fingerprint, 'the same one the dashboard groups by');
    assert.equal(exception.summary.mechanism, 'express');
    assert.deepEqual(exception.summary.request, { method: 'GET', path: '/orders/42' });
    assert.equal(exception.detail.request.id, event.id);
    const request = await openEvent(event);
    assert.deepEqual(request.detail.exceptions, [{ id: sealedException.id, name: 'Error', message: 'order 42 failed' }]);
    // Timeline counters stay readable for lists; the spans are sealed with the detail.
    assert.equal(event.stats.logs, 1);
    assert.equal(event.stats.queries, 0);
    assert.ok(!JSON.stringify(batch.body).includes('about to fail'));
    assert.deepEqual(request.detail.timeline.spans.map((span) => span.type), ['log', 'exception']);
    assert.equal(request.detail.timeline.spans[0].message, 'about to fail');
  } finally {
    peekInside.stop();
    server.close();
  }
});

test('heap and CPU profiles run once PeekInside Cloud says the plan includes them, and go out sealed', async () => {
  batches.length = 0;
  answer = { accepted: true, features: { heapProfiling: true, cpuProfiling: true } };
  const app = express();
  app.set('env', 'test');
  const log = console.log;
  console.log = () => {};
  const peekInside = PeekInside.attach(app, { apiKey: API_KEY, local: false });
  console.log = log;
  try {
    assert.equal(peekInside._heap.running, false, 'off until PeekInside Cloud answers');
    assert.equal(peekInside._blocks.running, true, 'the CPU profiler starts with the app (V8 only places code compiled after it starts)');
    peekInside._sampler.take();
    await waitFor(() => {
      void peekInside.flush();
      return peekInside._heap.running;
    }, 'the profiler to start');

    // Something held since sampling started (4 MB), for the profile to show.
    const held = [];
    for (let i = 0; i < 2000; i++) held.push(new Array(256).fill(i));
    const window = peekInside._heap.take();
    assert.ok(window.sites.length && held.length);
    const batch = await waitFor(() => {
      void peekInside.flush();
      return batches.find((item) => item.body.heapWindows);
    }, 'a batch with a heap profile');
    const [sealed] = batch.body.heapWindows;
    assert.deepEqual(Object.keys(sealed), ['id', 'at', 'reason', 'total', 'sites']);
    assert.deepEqual([sealed.at, sealed.reason, sealed.total], [window.at, 'interval', window.total], 'when and how much stay readable');
    assert.match(sealed.sites, /^v1\./);
    const raw = JSON.stringify(batch.body);
    for (const site of window.sites) {
      if (site.file) assert.ok(!raw.includes(site.file), 'code locations are sealed');
    }
    assert.deepEqual(await open(sealed.sites, `heap:${sealed.id}`), window.sites);
    await assert.rejects(open(sealed.sites, 'heap:another'), 'bound to its window');
    assert.equal(batch.body.instance.id, peekInside._cloud.instance.id, 'the process it came from');

    // A block, and the window that names what ran.
    reconcileLedger(220);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const blocks = peekInside._blocks.flush(true);
    assert.equal(blocks.sites[0].function, 'reconcileLedger', JSON.stringify(blocks.sites));
    const blockBatch = await waitFor(() => {
      void peekInside.flush();
      return batches.find((item) => item.body.blockWindows);
    }, 'a batch with a block window');
    const [sealedBlocks] = blockBatch.body.blockWindows;
    assert.deepEqual(Object.keys(sealedBlocks), ['id', 'at', 'count', 'total', 'worst', 'sites']);
    assert.deepEqual([sealedBlocks.at, sealedBlocks.count, sealedBlocks.total, sealedBlocks.worst], [blocks.at, blocks.count, blocks.total, blocks.worst], 'when, how many and how long stay readable');
    assert.ok(!JSON.stringify(blockBatch.body).includes('reconcileLedger'), 'the functions are sealed');
    assert.deepEqual(await open(sealedBlocks.sites, `blocks:${sealedBlocks.id}`), blocks.sites);

    // The plan changed: profiling stops.
    answer = { accepted: true, features: { heapProfiling: false, cpuProfiling: false } };
    peekInside._sampler.take();
    await waitFor(() => {
      void peekInside.flush();
      return !peekInside._heap.running && !peekInside._blocks.running;
    }, 'the profilers to stop');
  } finally {
    answer = { accepted: true };
    peekInside.stop();
  }
});

test('while PeekInside Cloud is paused for the organization, nothing is recorded; sending resumes on its own once it has a plan', async () => {
  batches.length = 0;
  refused.length = 0;
  paused = true;
  answer = { accepted: true, features: { heapProfiling: false, cpuProfiling: true } };
  const app = express();
  app.set('env', 'test');
  const { log, error } = console;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  const peekInside = PeekInside.attach(app, { apiKey: API_KEY, local: false });
  const transport = peekInside._cloud;
  transport.pauseCheckMs = 100;
  app.get('/orders/:id', (req, res) => res.json({ id: req.params.id }));
  const server = app.listen(0, '127.0.0.1');
  const get = (url) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: url }, (res) => res.resume().on('end', resolve)));
  const probes = () => refused.filter((body) => JSON.stringify(body) === '{"events":[]}').length;
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    assert.equal(peekInside._blocks.running, true);
    await get('/orders/1');
    await waitFor(() => {
      void peekInside.flush();
      return transport.paused;
    }, 'the pause');
    assert.equal(transport.disabled, true, 'nothing is recorded meanwhile');
    assert.equal(peekInside._blocks.running, false, 'and the profilers stop');
    await get('/orders/2');
    assert.equal(transport.queue.length, 0);

    // PeekInside Cloud is asked again, with no data, until the organization has a plan.
    await waitFor(() => probes() >= 2, 'checks while paused');
    assert.equal(transport.disabled, true);
    assert.equal(batches.length, 0);
    assert.equal(lines.filter((line) => line.includes('is paused')).length, 1, 'the pause is logged once');

    paused = false;
    await waitFor(() => !transport.disabled, 'recording to resume');
    await get('/orders/3');
    const batch = await waitFor(() => {
      void peekInside.flush();
      return batches.find((item) => item.body.events.length);
    }, 'a batch after the pause');
    const urls = await Promise.all(batch.body.events.map(async (event) => (await openEvent(event)).summary.url));
    assert.deepEqual(urls, ['/orders/3'], 'what happened while paused is not sent');
    assert.equal(transport.paused, false);
    assert.equal(lines.filter((line) => line.includes('sending resumed')).length, 1);
    assert.equal(peekInside._blocks.running, true, 'the plan\'s profilers start again');
  } finally {
    paused = false;
    answer = { accepted: true };
    console.log = log;
    console.error = error;
    peekInside.stop();
    server.close();
  }
});

test('a crash in cloud mode is posted before the process exits', async () => {
  batches.length = 0;
  const without = await runApp({ attach: false, route: '/timer' });
  const withPeek = await runApp({ route: '/timer' });
  assert.equal(withPeek.code, 1);
  assert.equal(withPeek.stderr, without.stderr, 'the crash looks the same');

  // Delivered synchronously: it is there as soon as the process has exited.
  const batch = batches.find((item) => item.body.exceptions && item.body.exceptions.some((sealed) => sealed.fatal));
  assert.ok(batch, 'the crash was posted');
  const exception = await openException(batch.body.exceptions.find((sealed) => sealed.fatal));
  assert.equal(exception.summary.message, 'cloud crash in a timer');
  assert.equal(exception.summary.mechanism, 'uncaught');
  assert.equal(exception.handled, false);
  const event = batch.body.events.find((item) => item.id === exception.requestId);
  assert.ok(event, 'with the request it happened in');
  assert.equal(event.aborted, true);
  assert.equal(event.exceptionCount, 1);
  assert.equal((await openEvent(event)).summary.url, '/timer');
  assert.deepEqual(Spool.cloud(home, PROJECT_ID).list(), [], 'nothing left to resend');
});

test('when PeekInside Cloud is down, a crash is spooled and sent by the next run', async () => {
  batches.length = 0;
  const closed = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  const crashed = await runApp({ route: '/timer', env: { PEEKINSIDE_URL: closed } });
  assert.equal(crashed.code, 1);

  const spool = Spool.cloud(home, PROJECT_ID);
  const files = spool.list();
  assert.equal(files.length, 1, 'spooled');
  const file = path.join(spool.dir, files[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(spool.dir).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('cloud crash in a timer'), 'spooled sealed, never in clear');

  // The next run sends it shortly after starting.
  const { child } = await runApp({ untilReady: true });
  try {
    const batch = await waitFor(() => batches.find((item) => item.body.exceptions && item.body.exceptions.some((sealed) => sealed.fatal)), 'the spooled crash');
    const exception = await openException(batch.body.exceptions.find((sealed) => sealed.fatal));
    assert.equal(exception.summary.message, 'cloud crash in a timer');
    await waitFor(() => spool.list().length === 0 && fs.readdirSync(spool.dir).length === 0, 'the spool file to be deleted');
  } finally {
    child.kill('SIGTERM');
  }
});

test('spooled batches: resent oldest first, kept while the cloud is down, dropped after a week', async () => {
  const transport = new CloudTransport({ apiKey: API_KEY, version: 'test' });
  transport.stop();
  const spool = Spool.cloud(home, PROJECT_ID);
  for (const name of spool.list()) spool.remove(name);
  const body = (n) => ({ events: [], exceptions: [{ id: `e${n}`, fatal: true }] });
  const old = spool.write({ createdAt: Date.now(), body: body(0) });
  const week = Date.now() / 1000 - 8 * 24 * 60 * 60;
  fs.utimesSync(path.join(spool.dir, old), week, week);
  spool.write({ createdAt: Date.now(), body: body(1) });

  down = true;
  batches.length = 0;
  try {
    await transport.resendSpooled();
  } finally {
    down = false;
  }
  assert.equal(spool.list().length, 1, 'kept while the cloud is down; the week-old one is gone');
  await transport.resendSpooled();
  assert.deepEqual(batches.map((item) => item.body.exceptions[0].id), ['e1']);
  assert.deepEqual(spool.list(), []);

  // A file claimed by a process that died is up for grabs again.
  const name = spool.write({ createdAt: Date.now(), body: body(2) });
  fs.renameSync(path.join(spool.dir, name), path.join(spool.dir, `${name}.999999.sending`));
  assert.deepEqual(spool.list(), [name]);
  const claimed = spool.claim(name);
  assert.equal(spool.claim(name), null, 'claimed once');
  spool.release(claimed);
  await transport.resendSpooled();
  assert.deepEqual(spool.list(), []);
});

test('cloud batches stay under 4 MB of sealed JSON; what doesn\'t fit goes next', async () => {
  batches.length = 0;
  const transport = new CloudTransport({ apiKey: API_KEY, version: 'test' });
  transport.stop();
  const record = (n, bodyBytes) => new RequestRecord({
    id: `big-${n}`,
    occurredAt: Date.now(),
    environment: 'production',
    method: 'POST',
    status: 200,
    duration: 1,
    requestSize: bodyBytes,
    responseSize: 0,
    aborted: false,
    exceptionCount: 0,
    stats: { queries: 0, queryTime: 0, slowQueries: 0, nPlusOne: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0 },
    summary: { url: `/upload/${n}`, path: `/upload/${n}`, contentType: 'application/json' },
    detail: { body: 'x'.repeat(bodyBytes) }
  });
  for (let i = 0; i < 40; i++) transport.enqueueRecord(record(i, 300 * 1024));
  // A single record over the budget still goes, alone.
  transport.enqueueRecord(record(40, 7 * 1024 * 1024));
  await transport.drain();
  assert.equal(transport.queue.length, 0, 'everything was sent');
  assert.ok(batches.length >= 3, `${batches.length} posts`);
  for (const batch of batches.slice(0, -1)) assert.ok(batch.bytes <= 4 * 1024 * 1024, `${batch.bytes} bytes`);
  assert.equal(batches[batches.length - 1].body.events.length, 1, 'the oversized record went alone');
  const ids = batches.flatMap((batch) => batch.body.events.map((event) => event.id));
  assert.deepEqual(ids, Array.from({ length: 41 }, (_, i) => `big-${i}`), 'in order, each once');
});
