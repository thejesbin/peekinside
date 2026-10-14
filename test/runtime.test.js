// The event loop and the process: blocks recorded on the timelines of the requests that waited
// for them, process samples (memory, CPU, event-loop delay) and how the hub keeps them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { IngestPayload } from '../src/hub/ingest-payload.js';
import { LoopMonitor } from '../src/runtime/loop-monitor.js';
import { RuntimeSampler } from '../src/runtime/sampler.js';
import { Timeline, TimelineSettings } from '../src/timeline/timeline.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-runtime-'));
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

// Keeps the thread busy, as synchronous app code does.
function blockFor(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function get(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

test('a block is recorded on every timeline open at the time, at or above loopBlockMs', async () => {
  LoopMonitor.acquire();
  try {
    const waiting = new Timeline(new TimelineSettings({}, ROOT));
    const strict = new Timeline(new TimelineSettings({ loopBlockMs: 400 }, ROOT));
    const off = new Timeline(new TimelineSettings({ loopBlockMs: false }, ROOT));
    await pause(30);
    blockFor(180);
    await pause(40); // the monitor's timer fires late, and tells the timelines

    const { stats, timeline } = waiting.close();
    assert.ok(stats.loopBlock >= 120, `blocked ${stats.loopBlock} ms`);
    const blocks = timeline.spans.filter((span) => span.type === 'block');
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].start >= 0 && blocks[0].duration === stats.loopBlock);

    assert.equal(strict.close().stats.loopBlock, 0, 'shorter than this timeline\'s threshold');
    assert.equal(off.close().stats.loopBlock, 0, 'detection turned off');
  } finally {
    LoopMonitor.release();
  }
});

test('a request that blocks the loop and finishes before the timer fires still sees the block', () => {
  LoopMonitor.acquire();
  try {
    const timeline = new Timeline(new TimelineSettings({}, ROOT));
    blockFor(160);
    // Closed synchronously, like a response sent right after the blocking work.
    const { stats, timeline: closed } = timeline.close();
    assert.ok(stats.loopBlock >= 100, `blocked ${stats.loopBlock} ms`);
    assert.equal(closed.spans[0].type, 'block');
  } finally {
    LoopMonitor.release();
  }
});

test('samples: memory, CPU and the event-loop delay since the last sample', async () => {
  const monitor = LoopMonitor.acquire();
  try {
    const samples = [];
    const sampler = new RuntimeSampler({ intervalMs: 60_000, monitor, onSample: (sample) => samples.push(sample) });
    await pause(60);
    blockFor(70);
    await pause(30);
    const sample = sampler.take();
    assert.deepEqual(Object.keys(sample), ['at', 'rss', 'heapUsed', 'heapTotal', 'external', 'cpu', 'loopP50', 'loopP99', 'loopMax']);
    assert.equal(samples.length, 1);
    assert.ok(sample.heapUsed > 0 && sample.rss >= sample.heapUsed);
    assert.ok(sample.cpu > 0, 'busy time shows as CPU');
    assert.ok(sample.loopMax >= 40, `the block is the worst delay (${sample.loopMax} ms)`);
    assert.ok(sample.loopP50 <= sample.loopP99 && sample.loopP99 <= sample.loopMax);
  } finally {
    LoopMonitor.release();
  }
});

test('the hub validates samples and keeps each process\'s history', () => {
  const instance = { pid: 4242, port: 3000, framework: 'express', startedAt: 1_000 };
  const project = { id: 'runtime-hub-1a2b3c4d', name: 'runtime-hub', root: '/work/runtime-hub' };
  const sample = (at, heapUsed) => ({ at, rss: heapUsed * 2, heapUsed, heapTotal: heapUsed + 10, external: 5, cpu: 3.5, loopP50: 0.4, loopP99: 2.1, loopMax: 9 });
  const payload = IngestPayload.parse({
    project,
    instance,
    requests: [],
    samples: [sample(10, 100), { at: 'soon' }, { ...sample(20, 200), rss: -1 }, { ...sample(30, 300), loopP99: 'slow', cpu: null }]
  });
  assert.equal(payload.samples.length, 2, 'malformed samples are skipped');
  assert.equal(payload.samples[1].loopP99, null);

  const local = new Store(fs.mkdtempSync(path.join(dataDir, 'store-'))).load();
  local.touch(payload.project, payload.instance, 50);
  local.addSamples(project.id, payload.instance, payload.samples, 50);
  local.addSamples(project.id, payload.instance, [sample(30, 300), sample(40, 400)], 60);
  const [process] = local.runtime(project.id, 70).processes;
  assert.deepEqual(process.samples.map((item) => item.at), [10, 30, 40], 'samples already kept are not added twice');
  assert.equal(process.online, true);
  assert.equal(process.framework, 'express');

  // The same pid started again is another process.
  local.addSamples(project.id, { ...payload.instance, startedAt: 2_000 }, [sample(50, 500)], 80);
  assert.deepEqual(local.runtime(project.id, 90).processes.map((item) => item.samples.length), [1]);
  assert.equal(local.runtime('unknown-00000000', 90), null);
});

test('end to end: a request that blocks the loop, the one waiting beside it, and the samples', async () => {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: 'loop-blocker', local: true });
  app.get('/report', (req, res) => {
    blockFor(220);
    res.json({ ok: true });
  });
  app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 450));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const slow = get(port, '/slow');
    await pause(80);
    await get(port, '/report');
    await slow;
    peekInside._sampler.take();

    let result = null;
    for (let i = 0; i < 100 && !result; i++) {
      await peekInside.flush();
      const project = store.listProjects().find((item) => item.name === 'loop-blocker');
      const requests = project ? store.list(project.id, { limit: 10 }).requests : [];
      const runtime = project ? store.runtime(project.id) : null;
      if (requests.length === 2 && runtime && runtime.processes.length) result = { project, requests, runtime };
      else await pause(30);
    }
    assert.ok(result, 'the hub has both requests and a sample');
    const byUrl = Object.fromEntries(result.requests.map((request) => [request.url, request]));
    assert.ok(byUrl['/report'].stats.loopBlock >= 150, `the blocking request: ${byUrl['/report'].stats.loopBlock} ms`);
    assert.ok(byUrl['/slow'].stats.loopBlock >= 150, `the request that waited: ${byUrl['/slow'].stats.loopBlock} ms`);
    const detail = store.detail(result.project.id, byUrl['/slow'].id);
    assert.ok(detail.timeline.spans.some((span) => span.type === 'block'));

    const [process] = result.runtime.processes;
    assert.equal(process.pid, globalThis.process.pid);
    assert.ok(process.samples[0].heapUsed > 0);
  } finally {
    peekInside.stop();
    server.close();
  }
});
