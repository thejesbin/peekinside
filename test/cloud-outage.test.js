// PeekInside Cloud breaking must never break the app: its requests aren't slowed, it never waits
// long to exit or crash, and PeekInside's memory and disk use stay bounded however long the outage.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Spool } from '../src/spool.js';
import { BatchTransport } from '../src/transport/batch.js';

const ENTRY = pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href;
const PROJECT_ID = 'p0123456789ab';
const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const PUBLIC_KEY = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const API_KEY = `pik1.${PROJECT_ID}.${'s'.repeat(43)}.${PUBLIC_KEY}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-outage-home-'));
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-outage-app-'));
const spoolDir = path.join(home, 'spool', 'cloud', PROJECT_ID);
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_LOCAL = '0';
process.env.PEEKINSIDE_HUB_PORT = String(await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
}));

// A PeekInside Cloud that takes requests and never answers, and one that answers every one with 500.
const hanging = http.createServer((req) => req.resume());
const failing = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"broken"}');
  });
});
const urls = {};
const children = new Set();

const APP = `import http from 'node:http';
const PeekInside = (await import(process.env.ENTRY)).default;
const server = http.createServer((req, res) => {
  if (req.url === '/crash') setTimeout(() => { throw new Error('a crash while the cloud is down'); }, 10);
  res.end('ok');
});
PeekInside.attach(server);
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

// A script: it reports an error and ends, so its event loop empties with a batch to send.
const SCRIPT = `import http from 'node:http';
const PeekInside = (await import(process.env.ENTRY)).default;
PeekInside.attach(http.createServer());
PeekInside.report(new Error('a script error'));
`;

before(async () => {
  for (const [name, server] of Object.entries({ hanging, failing })) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    urls[name] = `http://127.0.0.1:${server.address().port}`;
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'outage-app', type: 'module' }));
  fs.writeFileSync(path.join(appDir, 'app.mjs'), APP);
  fs.writeFileSync(path.join(appDir, 'script.mjs'), SCRIPT);
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of [hanging, failing]) {
    server.closeAllConnections();
    server.close();
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function start(file, cloud) {
  const child = spawn(process.execPath, [path.join(appDir, file)], {
    cwd: appDir,
    env: { ...process.env, PEEKINSIDE_API_KEY: API_KEY, PEEKINSIDE_URL: cloud, ENTRY, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => (output.stdout += chunk));
  child.stderr.on('data', (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => {
    children.delete(child);
    resolve(code);
  }));
  return { child, output, exited };
}

async function portOf(output) {
  for (let i = 0; i < 200; i++) {
    const match = /PORT (\d+)/.exec(output.stdout);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('the app did not start');
}

function get(port, pathname, agent = false) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    http.get({ host: '127.0.0.1', port, path: pathname, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - started }));
    }).on('error', reject);
  });
}

function spooled() {
  try {
    return fs.readdirSync(spoolDir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    return [];
  }
}

// Requests keep their speed while PeekInside's own POST to the cloud hangs, or fails.
for (const cloud of ['hanging', 'failing']) {
  test(`when PeekInside Cloud is ${cloud === 'hanging' ? 'unresponsive' : 'failing'}, the app's requests are as fast as ever`, async () => {
    const app = start('app.mjs', urls[cloud]);
    const port = await portOf(app.output);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const times = [];
    // Steady traffic past the first flushes (every second), so batches are out to the broken
    // cloud meanwhile.
    for (const until = Date.now() + 2500; Date.now() < until;) {
      const answer = await get(port, '/', agent);
      assert.equal(answer.status, 200);
      times.push(answer.ms);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    agent.destroy();
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    assert.ok(median < 25, `median ${median.toFixed(1)} ms over ${times.length} requests`);
    assert.ok(times.at(-1) < 250, `slowest ${times.at(-1).toFixed(1)} ms`);
    assert.equal(app.child.exitCode, null, 'the app keeps running');
    // Warnings are rate-limited: a broken cloud can't flood the app's logs.
    assert.ok((app.output.stderr.match(/\[peekinside\]/g) || []).length <= 1, app.output.stderr);
    app.child.kill('SIGTERM');
    await app.exited;
  });
}

test('a script ending while PeekInside Cloud is unresponsive waits at most 2.5 s, and keeps its records for the next run', async () => {
  fs.rmSync(spoolDir, { recursive: true, force: true });
  const started = Date.now();
  const script = start('script.mjs', urls.hanging);
  assert.equal(await script.exited, 0);
  const took = Date.now() - started;
  assert.ok(took < 4500, `exited after ${took} ms`);
  assert.equal(spooled().length, 1, 'its batch waits on disk, sealed');
});

test('a crash while PeekInside Cloud is unresponsive still exits within seconds, and the crash is spooled', async () => {
  fs.rmSync(spoolDir, { recursive: true, force: true });
  const app = start('app.mjs', urls.hanging);
  const port = await portOf(app.output);
  const crashedAt = Date.now();
  await get(port, '/crash');
  assert.equal(await app.exited, 1, 'it crashes as it would without PeekInside');
  const took = Date.now() - crashedAt;
  // It tried PeekInside Cloud (which never answers) for at most 3 s, then spooled.
  assert.ok(took >= 2000 && took < 5000, `exited ${took} ms after the crash`);
  assert.match(app.output.stderr, /a crash while the cloud is down/, 'the error is printed as usual');
  assert.ok(spooled().length >= 1, 'the crash waits on disk for the next run');
});

test('a long outage keeps memory flat: the queue holds at most 32 MB of records, the newest', () => {
  class Unreachable extends BatchTransport {
    constructor() {
      super({ environment: 'production', batchSize: 100, maxQueue: 2000, firstBackoffMs: 60_000, maxBackoffMs: 60_000 });
    }
  }
  const transport = new Unreachable();
  const body = 'x'.repeat(256 * 1024);
  for (let id = 0; id < 400; id++) transport.enqueueRecord({ id, body });
  const bytes = transport.queue.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
  assert.ok(bytes <= 32 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB queued`);
  assert.ok(transport.queue.length >= 120 && transport.queue.length < 400, `${transport.queue.length} records`);
  assert.equal(transport.queue.at(-1).id, 399, 'the newest records stay');
  assert.equal(transport.dropped, 400 - transport.queue.length);

  // Small records are kept by number, as before.
  const small = new Unreachable();
  for (let id = 0; id < 2500; id++) small.enqueueRecord({ id });
  assert.equal(small.queue.length, 2000);
});

test('the spool keeps at most 100 files, the newest: an app crashing in a loop can\'t fill the disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-spool-'));
  try {
    const hourAgo = Date.now() / 1000 - 3600;
    for (let i = 0; i < 120; i++) {
      const file = path.join(dir, `${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, hourAgo + i, hourAgo + i);
    }
    const spool = new Spool(dir);
    const latest = spool.write({ latest: true });
    const left = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.equal(left.length, 100);
    assert.ok(left.includes(latest), 'the file just written stays');
    assert.ok(!left.includes('020.json') && left.includes('021.json'), 'the oldest went first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
