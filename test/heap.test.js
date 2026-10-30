// Where the heap is held: V8's sampling heap profiler summed by function (the app's own code, else
// the package that allocated), one sampler shared by every instance and never started over another
// tool's, how the hub keeps the windows, and a leak found end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Session } from 'node:inspector';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { IngestPayload } from '../src/hub/ingest-payload.js';
import { ExceptionBuilder } from '../src/exceptions/exception-builder.js';
import { HeapProfiler } from '../src/runtime/heap-profiler.js';

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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-heap-'));
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

// Whether V8's sampler runs, asked through a session of its own.
function sampling() {
  const session = new Session();
  session.connect();
  let running = false;
  session.post('HeapProfiler.getSamplingProfile', {}, (error) => (running = !error));
  session.disconnect();
  return running;
}

// What a leak looks like: objects added to a list that is never emptied (2 KB each: a constant
// string would be folded into one).
const held = [];
function leaky(count) {
  for (let i = 0; i < count; i++) held.push({ index: i, values: new Array(256).fill(i) });
}

test('a profile is summed by the app\'s function, the package it called, or the package alone', () => {
  const node = (functionName, url, lineNumber, children = [], selfSize = 0) => ({ callFrame: { functionName, scriptId: '1', url, lineNumber, columnNumber: 4 }, selfSize, children });
  const profile = {
    head: node('(root)', '', -1, [
      node('handle', 'file:///app/src/routes.js', 9, [
        // A built-in allocates for the app: charged to the app's function.
        node('repeat', '', -1, [], 1000),
        // A package called by the app: the app's function, through the package.
        node('cloneDeep', 'file:///app/node_modules/lodash/index.js', 99, [node('', '', -1, [], 600)], 100)
      ], 200),
      // No app code on the stack: the package's own function.
      node('read', 'file:///app/node_modules/body-parser/lib/read.js', 4, [node('', '', -1, [], 300)]),
      // Neither: the allocating function itself.
      node('(V8 API)', '', -1, [], 50)
    ])
  };
  const locate = (callFrame) => ({
    function: callFrame.functionName || null,
    file: callFrame.url ? callFrame.url.slice('file://'.length) : null,
    relativeFile: callFrame.url ? callFrame.url.slice('file:///app/'.length) : null,
    line: callFrame.url ? callFrame.lineNumber + 1 : null,
    column: callFrame.url ? callFrame.columnNumber + 1 : null,
    inApp: callFrame.url.startsWith('file:///app/src/'),
    module: callFrame.url.includes('/node_modules/') ? callFrame.url.split('/node_modules/')[1].split('/')[0] : null
  });

  const { total, sites } = HeapProfiler.summarize(profile, locate, 10);
  assert.equal(total, 2250);
  assert.deepEqual(sites.map((site) => [site.function, site.relativeFile, site.line, site.package, site.inApp, site.bytes]), [
    ['handle', 'src/routes.js', 10, null, true, 1200],
    ['handle', 'src/routes.js', 10, 'lodash', true, 700],
    ['read', 'node_modules/body-parser/lib/read.js', 5, 'body-parser', false, 300],
    ['(V8 API)', null, null, null, false, 50]
  ]);
  for (const site of sites) assert.match(site.id, /^[0-9a-f]{12}$/);
  assert.equal(new Set(sites.map((site) => site.id)).size, 4, 'one id per function and package');
  assert.deepEqual(HeapProfiler.summarize(profile, locate, 10).sites.map((site) => site.id), sites.map((site) => site.id), 'the same function gets the same id in every window');

  const top = HeapProfiler.summarize(profile, locate, 2);
  assert.equal(top.total, 2250, 'the total counts every site');
  assert.equal(top.sites.length, 2);
  assert.deepEqual(HeapProfiler.summarize({}, locate, 10), { total: 0, sites: [] });
});

test('the profiler names the function in this file that holds a growing list', () => {
  const windows = [];
  const profiler = new HeapProfiler({ builder: new ExceptionBuilder({ root: ROOT }), intervalMs: HOUR, onWindow: (window) => windows.push(window), samplingInterval: 32 * 1024 });
  try {
    profiler.start();
    assert.equal(profiler.running, true, profiler.failure);
    leaky(2000);
    const first = profiler.take();
    leaky(4000);
    const second = profiler.take();
    assert.deepEqual(windows, [first, second], 'each window is handed over');
    assert.equal(second.reason, 'interval');

    const site = (window) => window.sites.find((item) => item.function === 'leaky');
    assert.ok(site(second), `leaky() is named: ${JSON.stringify(second.sites.slice(0, 3))}`);
    assert.equal(second.sites[0].id, site(second).id, 'and holds the most');
    assert.equal(site(second).file, THIS_FILE);
    assert.equal(site(second).relativeFile, 'test/heap.test.js');
    assert.equal(site(second).line, lineOf('function leaky('), 'the line where the function starts');
    assert.equal(site(second).inApp, true);
    assert.equal(site(second).package, null);
    assert.equal(site(first).id, site(second).id);
    assert.ok(site(second).bytes > site(first).bytes * 2, `it grew: ${site(first).bytes} then ${site(second).bytes}`);
    assert.ok(site(second).bytes > 8_000_000 && site(second).bytes < 30_000_000, `about the 12.5 MB held: ${site(second).bytes}`);
    assert.ok(second.total >= site(second).bytes);

    // Near the heap's limit, at most one extra window a minute.
    assert.equal(profiler.take('pressure').reason, 'pressure');
    assert.equal(profiler.take('pressure'), null);
    assert.ok(profiler.take('interval'));
  } finally {
    profiler.stop();
  }
  assert.equal(profiler.take(), null, 'a stopped profiler reads nothing');
  assert.equal(sampling(), false, 'and V8 stopped sampling');
});

test('instances share V8\'s sampler, and leave another tool\'s alone', () => {
  const builder = new ExceptionBuilder({ root: ROOT });
  const first = new HeapProfiler({ builder, intervalMs: HOUR, onWindow: () => {} }).start();
  const second = new HeapProfiler({ builder, intervalMs: HOUR, onWindow: () => {} }).start();
  assert.ok(first.running && second.running);
  first.stop();
  assert.ok(second.take(), 'one stopping leaves the other sampling');
  second.stop();
  assert.equal(sampling(), false, 'the last to stop stops V8\'s sampler');

  // Another tool samples already: starting over it would share its profile, stopping would stop it.
  const other = new Session();
  other.connect();
  other.post('HeapProfiler.startSampling', { samplingInterval: 65536 }, () => {});
  try {
    const profiler = new HeapProfiler({ builder, intervalMs: HOUR, onWindow: () => {} }).start();
    assert.equal(profiler.running, false);
    assert.match(profiler.failure, /Another heap profiler/);
    profiler.stop();
    assert.equal(sampling(), true, 'the other tool keeps sampling');
  } finally {
    other.post('HeapProfiler.stopSampling', {}, () => {});
    other.disconnect();
  }
});

test('the hub validates heap windows and keeps them by process, thinned after an hour', () => {
  const instance = { pid: 5151, port: 3000, framework: 'express', startedAt: 1_000 };
  const project = { id: 'heap-hub-1a2b3c4d', name: 'heap-hub', root: '/work/heap-hub' };
  const site = (id, bytes, extra = {}) => ({ id, function: 'remember', file: '/work/heap-hub/src/cache.js', relativeFile: 'src/cache.js', line: 12, column: 18, package: null, inApp: true, bytes, ...extra });
  const payload = IngestPayload.parse({
    project,
    instance,
    requests: [],
    heapWindows: [
      { at: 'soon', total: 1, sites: [] },
      { at: 10 * HOUR, total: -5, sites: [] },
      { at: 10 * HOUR, reason: 'shrug', total: 3000, sites: [site('a1b2c3d4e5f6', 2000), site('not-an-id', 10), site('0123456789ab', -1), site('0123456789ab', 1000, { function: 7, package: 'lru-cache', inApp: 'yes' })] }
    ]
  });
  assert.equal(payload.heapWindows.length, 1, 'malformed windows are skipped');
  const [window] = payload.heapWindows;
  assert.equal(window.reason, 'interval');
  assert.deepEqual(window.sites.map((item) => [item.id, item.function, item.package, item.inApp, item.bytes]), [
    ['a1b2c3d4e5f6', 'remember', null, true, 2000],
    ['0123456789ab', null, 'lru-cache', false, 1000]
  ], 'malformed sites are skipped, malformed fields cleared');

  const local = new Store(fs.mkdtempSync(path.join(dataDir, 'store-'))).load();
  local.touch(project, payload.instance, 10 * HOUR);
  local.addSamples(project.id, payload.instance, [{ at: 10 * HOUR, rss: 2, heapUsed: 1, heapTotal: 1, external: 0, cpu: null, loopP50: null, loopP99: null, loopMax: null }], 10 * HOUR);
  assert.equal(local.runtime(project.id, 10 * HOUR).processes[0].heap, null, 'no profile yet');

  local.addHeapWindows(project.id, payload.instance, payload.heapWindows, 10 * HOUR);
  // Two more hours, a window a minute; one read as the heap neared its limit.
  const later = [];
  for (let minute = 1; minute <= 120; minute++) {
    later.push({ at: 10 * HOUR + minute * 60_000, reason: minute === 32 ? 'pressure' : 'interval', total: 3000 + minute, sites: [site('a1b2c3d4e5f6', 2000 + minute * 10)] });
  }
  local.addHeapWindows(project.id, payload.instance, later.slice(0, 60), 11 * HOUR);
  local.addHeapWindows(project.id, payload.instance, [...later.slice(55, 60), ...later.slice(60)], 12 * HOUR);

  const [process] = local.runtime(project.id, 12 * HOUR).processes;
  assert.deepEqual(Object.keys(process.heap.sites).sort(), ['0123456789ab', 'a1b2c3d4e5f6']);
  assert.equal(process.heap.sites.a1b2c3d4e5f6.relativeFile, 'src/cache.js');
  assert.equal(process.heap.sites.a1b2c3d4e5f6.bytes, undefined, 'a site\'s bytes are kept by window');
  const { windows } = process.heap;
  assert.deepEqual(windows[0], { at: 10 * HOUR, reason: 'interval', total: 3000, bytes: { a1b2c3d4e5f6: 2000, '0123456789ab': 1000 } });
  assert.equal(new Set(windows.map((item) => item.at)).size, windows.length, 'windows already kept are not added twice');
  const recent = windows.filter((item) => item.at > 11 * HOUR);
  assert.equal(recent.length, 60, 'the last hour: every window');
  const older = windows.filter((item) => item.at < 11 * HOUR);
  assert.ok(older.some((item) => item.reason === 'pressure'), 'a window read near the heap\'s limit is kept');
  const spaced = older.filter((item) => item.reason !== 'pressure');
  for (let i = 1; i < spaced.length; i++) assert.ok(spaced[i].at - spaced[i - 1].at >= 5 * 60_000, 'older ones: one every five minutes');
  assert.ok(older.length >= 12 && older.length <= 14, `${older.length} windows in the hour before`);

  // A site no window names any more is forgotten.
  local.addHeapWindows(project.id, payload.instance, [{ at: 20 * HOUR, reason: 'interval', total: 1, sites: [site('a1b2c3d4e5f6', 1)] }], 20 * HOUR);
  const [after] = local.runtime(project.id, 20 * HOUR).processes;
  assert.ok(!after.heap.sites['0123456789ab']);
});

test('end to end: a route that leaks, named on the Runtime page\'s data', async () => {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: 'leaky-app', local: true });
  const cache = [];
  app.get('/remember', function remember(req, res) {
    for (let i = 0; i < 500; i++) cache.push({ id: `${req.query.user}:${i}`, scores: new Array(512).fill(i) });
    res.json({ cached: cache.length });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    assert.ok(peekInside._heap && peekInside._heap.running, peekInside._heap && peekInside._heap.failure);
    const port = server.address().port;
    for (let i = 0; i < 12; i++) await get(port, `/remember?user=${i}`);
    peekInside._sampler.take();
    peekInside._heap.take();

    let heap = null;
    for (let i = 0; i < 100 && !heap; i++) {
      await peekInside.flush();
      const project = store.listProjects().find((item) => item.name === 'leaky-app');
      const runtime = project ? store.runtime(project.id) : null;
      heap = runtime && runtime.processes.length ? runtime.processes[0].heap : null;
      if (!heap) await pause(30);
    }
    assert.ok(heap, 'the hub has the profile');
    const [window] = heap.windows;
    const [topId] = Object.entries(window.bytes).sort((a, b) => b[1] - a[1])[0];
    const top = heap.sites[topId];
    assert.equal(top.function, 'remember', `the route's handler holds the most: ${JSON.stringify(top)}`);
    assert.equal(top.relativeFile, 'test/heap.test.js');
    assert.equal(top.line, lineOf("function remember(req, res)"));
    assert.ok(window.bytes[topId] > 15_000_000, `about the 24 MB it keeps: ${window.bytes[topId]}`);
  } finally {
    peekInside.stop();
    server.close();
  }
  assert.equal(sampling(), false, 'stop() stops the sampler');
});
