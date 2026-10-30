// What blocked the event loop: V8's CPU profiler kept running by two profiles that take turns,
// the samples of a block summed by function (the app's own, with the package or Node.js function it
// was in), the functions on the timelines of the requests that waited, windows of blocks for the
// Runtime page, and how the hub keeps them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import express from 'express';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { IngestPayload } from '../src/hub/ingest-payload.js';
import { ExceptionBuilder } from '../src/exceptions/exception-builder.js';
import { BlockRecorder, CpuProfiler } from '../src/runtime/cpu-profiler.js';
import { LoopMonitor } from '../src/runtime/loop-monitor.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const THIS_FILE = fileURLToPath(import.meta.url);
const SOURCE = fs.readFileSync(THIS_FILE, 'utf8').split('\n');
const lineOf = (text) => SOURCE.findIndex((line) => line.includes(text)) + 1;
const HOUR = 60 * 60_000;

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-blocks-'));
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

function get(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (res) => res.resume().on('end', resolve)).on('error', reject);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What blocks look like: synchronous work in the app's own functions.
const invoice = Array.from({ length: 20000 }, (_, i) => ({ id: i, item: `item ${i}`, price: i * 1.5 }));
function renderInvoice(ms) {
  const end = performance.now() + ms;
  let size = 0;
  while (performance.now() < end) size += JSON.stringify(invoice).length;
  return size;
}

// Each test blocks in functions of its own: V8 can't place loops it optimized before a profiler
// started, and each test starts one.
function busyLoop(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) total += Math.sqrt(total + 1);
  return total;
}

function buildReport(ms) {
  return busyLoop(ms);
}

function computeTotals(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) total += Math.cbrt(total + 2);
  return total;
}

function formatRows(ms) {
  const end = performance.now() + ms;
  let rows = '';
  while (performance.now() < end) rows = `${rows.length % 997},${rows.slice(-20)}`;
  return rows;
}

function exportCsv(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) total += Math.log1p(total + 3);
  return total;
}

test('a sample is charged to the app\'s function, with the package or Node.js function it was in', () => {
  const app = { function: 'hashPassword', file: '/app/src/auth.js', relativeFile: 'src/auth.js', line: 14, column: 1, inApp: true, module: null };
  const node = (name, file) => ({ function: name, file, relativeFile: null, line: 63, column: 1, inApp: false, module: 'node' });
  const pkg = (name) => ({ function: name, file: '/app/node_modules/lodash/lodash.js', relativeFile: 'node_modules/lodash/lodash.js', line: 9, column: 1, inApp: false, module: 'lodash' });
  const native = (name) => ({ function: name, file: null, relativeFile: null, line: null, column: null, inApp: false, module: null });

  assert.deepEqual(pick(CpuProfiler.siteOf([app])), ['hashPassword', null, null], 'its own code');
  assert.deepEqual(pick(CpuProfiler.siteOf([native('run'), node('pbkdf2Sync', 'node:internal/crypto/pbkdf2'), app])), ['hashPassword', 'pbkdf2Sync', 'node'], 'in Node.js: the function it called');
  assert.deepEqual(pick(CpuProfiler.siteOf([pkg('baseClone'), pkg('cloneDeep'), app])), ['hashPassword', 'cloneDeep', 'lodash'], 'in a package: the entry point it called');
  assert.deepEqual(pick(CpuProfiler.siteOf([pkg('parseRow'), pkg('onData')])), ['parseRow', null, 'lodash'], 'no app code: the package\'s running function');
  assert.deepEqual(pick(CpuProfiler.siteOf([native('(garbage collector)')])), ['(garbage collector)', null, null]);
  assert.equal(CpuProfiler.siteOf([native('(idle)')]), null, 'waiting for work is no site');
  assert.equal(CpuProfiler.siteOf([app]).key, CpuProfiler.siteOf([pkg('cloneDeep'), app]).key, 'one function, whatever it called');
  assert.notEqual(CpuProfiler.siteOf([pkg('parseRow')]).key, CpuProfiler.siteOf([app]).key);

  function pick(site) {
    return [site.frame.function, site.calls, site.package];
  }
});

test('the profiler names the function that blocked, and keeps running across reads', () => {
  const profiler = CpuProfiler.acquire(new ExceptionBuilder({ root: ROOT }));
  try {
    assert.equal(profiler.running, true, profiler.failure);
    const start = performance.now();
    renderInvoice(300);
    const duration = performance.now() - start;
    const blamed = CpuProfiler.blame(start, duration);
    assert.ok(blamed.samples >= 10, `${blamed.samples} samples`);
    const [site] = blamed.sites;
    assert.equal(site.function, 'renderInvoice', JSON.stringify(blamed.sites));
    assert.equal(site.file, THIS_FILE);
    assert.equal(site.relativeFile, 'test/blocks.test.js');
    assert.equal(site.line, lineOf('function renderInvoice('));
    assert.equal(site.inApp, true);
    assert.match(site.id, /^[0-9a-f]{12}$/);
    assert.ok(site.ms > duration * 0.5 && site.ms <= duration + 1, `${site.ms} of ${duration} ms`);
    assert.equal(CpuProfiler.blame(start, duration + 40), blamed, 'asked again for the same block: the same answer');

    // Each read starts the other profile first: V8's profiler never stops, so a read stays cheap.
    const reads = [];
    for (let i = 0; i < 6; i++) {
      buildReport(20);
      const at = performance.now();
      profiler._switch();
      reads.push(performance.now() - at);
    }
    assert.ok(Math.max(...reads) < 30, `reads took ${reads.map((ms) => ms.toFixed(2)).join(', ')} ms`);
    const later = performance.now();
    buildReport(150);
    const after = CpuProfiler.blame(later, performance.now() - later);
    assert.equal(after.sites[0].function, 'busyLoop', 'after many reads: the app\'s function nearest the work');
  } finally {
    CpuProfiler.release();
  }
  assert.equal(CpuProfiler.shared, null);
  assert.equal(profiler.running, false);
  assert.equal(CpuProfiler.blame(0, 100), null, 'no profiler, no answer');
});

test('blocks are summed into windows: how many, how long, and the functions', async () => {
  LoopMonitor.acquire();
  const windows = [];
  // Hour-long windows, so the test doesn't straddle two.
  const recorder = new BlockRecorder({ builder: new ExceptionBuilder({ root: ROOT }), thresholdMs: 100, periodMs: HOUR, onWindow: (window) => windows.push(window) });
  try {
    recorder.start();
    assert.equal(recorder.running, true, recorder.failure);
    await pause(30);
    computeTotals(250);
    await pause(40);
    formatRows(160);
    await pause(40);
    computeTotals(60); // shorter than the threshold
    await pause(40);
    assert.equal(recorder.flush(), null, 'a window is handed over once its hour is over');
    const window = recorder.flush(true);
    assert.deepEqual(windows, [window]);
    assert.equal(window.count, 2);
    // Measured from when the monitor's timer was due: up to a tick (20 ms) short.
    assert.ok(window.worst >= 220 && window.total >= window.worst + 130, `worst ${window.worst}, total ${window.total}`);
    assert.equal(window.at % HOUR, 0, 'windows start on the hour');
    const byName = Object.fromEntries(window.sites.map((site) => [site.function, site]));
    assert.ok(byName.computeTotals && byName.formatRows, JSON.stringify(window.sites));
    assert.equal(window.sites[0].function, 'computeTotals', 'the most time first');
    assert.equal(byName.computeTotals.blocks, 1);
    assert.ok(byName.computeTotals.max >= 150 && byName.computeTotals.ms === byName.computeTotals.max);
  } finally {
    recorder.stop();
    LoopMonitor.release();
  }
  assert.equal(CpuProfiler.shared, null, 'the recorder let go of the profiler');
});

test('the hub validates block windows and keeps them by process for six hours', () => {
  const instance = { pid: 6161, port: 3000, framework: 'express', startedAt: 1_000 };
  const project = { id: 'blocks-hub-1a2b3c4d', name: 'blocks-hub', root: '/work/blocks-hub' };
  const site = (extra = {}) => ({ id: 'b1b2c3d4e5f6', function: 'renderInvoice', file: '/work/blocks-hub/src/invoice.js', relativeFile: 'src/invoice.js', line: 88, column: 1, package: 'node', inApp: true, calls: 'stringify', ms: 610, blocks: 3, max: 400, ...extra });
  const payload = IngestPayload.parse({
    project,
    instance,
    requests: [],
    blockWindows: [
      { at: 'soon', count: 1, total: 1, worst: 1, sites: [] },
      { at: 10 * HOUR, count: 0, total: 1, worst: 1, sites: [] },
      { at: 10 * HOUR, count: 3, total: 900, worst: 400, sites: [site(), site({ id: 'nope' }), site({ ms: -1 }), site({ id: '0123456789ab', calls: 12, blocks: 1.5 }), site({ id: 'aaaaaaaaaaaa', calls: 7, inApp: 'yes' })] }
    ]
  });
  assert.equal(payload.blockWindows.length, 1, 'malformed windows are skipped');
  const [window] = payload.blockWindows;
  assert.deepEqual(window.sites.map((item) => [item.id, item.calls, item.inApp]), [['b1b2c3d4e5f6', 'stringify', true], ['aaaaaaaaaaaa', null, false]], 'malformed functions are skipped, malformed fields cleared');

  const local = new Store(fs.mkdtempSync(path.join(dataDir, 'store-'))).load();
  local.touch(project, payload.instance, 10 * HOUR);
  local.addSamples(project.id, payload.instance, [{ at: 10 * HOUR, rss: 2, heapUsed: 1, heapTotal: 1, external: 0, cpu: null, loopP50: null, loopP99: null, loopMax: null }], 10 * HOUR);
  assert.equal(local.runtime(project.id, 10 * HOUR).processes[0].blocks, null, 'none yet');
  local.addBlockWindows(project.id, payload.instance, payload.blockWindows, 10 * HOUR);
  local.addBlockWindows(project.id, payload.instance, [...payload.blockWindows, { ...window, at: 11 * HOUR }], 11 * HOUR);
  assert.deepEqual(local.runtime(project.id, 11 * HOUR).processes[0].blocks.map((item) => item.at), [10 * HOUR, 11 * HOUR], 'windows already kept are not added twice');
  local.addBlockWindows(project.id, payload.instance, [{ ...window, at: 17 * HOUR }], 17 * HOUR);
  assert.deepEqual(local.runtime(project.id, 17 * HOUR).processes[0].blocks.map((item) => item.at), [11 * HOUR, 17 * HOUR], 'older than six hours: gone');
});

test('end to end: the request that waited names the function that blocked, and the Runtime page gets the window', async () => {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: 'blocking-app', local: true });
  app.get('/report', (req, res) => {
    exportCsv(260);
    res.json({ ok: true });
  });
  app.get('/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 500));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    assert.ok(peekInside._blocks && peekInside._blocks.running, peekInside._blocks && peekInside._blocks.failure);
    const port = server.address().port;
    const slow = get(port, '/slow');
    await pause(80);
    await get(port, '/report');
    await slow;
    await pause(40);
    peekInside._blocks.flush(true);

    let result = null;
    for (let i = 0; i < 100 && !result; i++) {
      await peekInside.flush();
      const project = store.listProjects().find((item) => item.name === 'blocking-app');
      const requests = project ? store.list(project.id, { limit: 10 }).requests : [];
      const runtime = project ? store.runtime(project.id) : null;
      if (requests.length === 2 && runtime && runtime.processes[0] && runtime.processes[0].blocks) result = { project, requests, runtime };
      else await pause(30);
    }
    assert.ok(result, 'the hub has both requests and the window');
    const byUrl = Object.fromEntries(result.requests.map((request) => [request.url, request]));
    for (const url of ['/slow', '/report']) {
      const detail = store.detail(result.project.id, byUrl[url].id);
      const span = detail.timeline.spans.find((item) => item.type === 'block');
      assert.ok(span, `${url} has the block`);
      assert.equal(span.sites[0].function, 'exportCsv', `${url}: ${JSON.stringify(span.sites)}`);
      assert.equal(span.sites[0].relativeFile, 'test/blocks.test.js');
      assert.ok(span.sites[0].ms >= 130, `${span.sites[0].ms} ms of ${span.duration}`);
    }
    const [window] = result.runtime.processes[0].blocks;
    assert.ok(window.count >= 1 && window.worst >= 200, JSON.stringify(window));
    assert.equal(window.sites[0].function, 'exportCsv');
  } finally {
    peekInside.stop();
    server.close();
  }
  assert.equal(CpuProfiler.shared, null, 'stop() stops the profiler');
});
