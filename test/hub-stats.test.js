// The hub keeps each request's timeline counters (stats) next to its summary, validated key by key,
// and returns the timeline in the detail untouched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IngestPayload } from '../src/hub/ingest-payload.js';
import { Store } from '../src/hub/store.js';

const PROJECT = { id: 'orders-api-1a2b3c4d', name: 'orders-api', root: '/work/orders-api' };
const INSTANCE = { pid: 4242, startedAt: 1 };
const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const STATS = { queries: 31, queryTime: 125.76, slowQueries: 1, nPlusOne: 1, duplicates: 4, http: 2, httpTime: 8.36, logs: 1 };
const TIMELINE = {
  version: 1,
  spans: [{ type: 'query', start: 1.25, duration: 0.5, statement: 0, params: [1], rows: 1 }],
  statements: [{ system: 'postgresql', client: 'pg', text: 'select * from users where id = $1', fingerprint: '94237023eee8e902', count: 1, time: 0.5, maxTime: 0.5, slow: 0, nPlusOne: false, duplicates: 0, caller: null }],
  dropped: 0,
  slowQueryMs: 100,
  nPlusOneThreshold: 5
};

function request(id, fields) {
  return {
    id,
    occurredAt: 1_700_000_000_000,
    environment: 'development',
    method: 'GET',
    status: 200,
    duration: 3,
    requestSize: 0,
    responseSize: 2,
    aborted: false,
    exceptionCount: 0,
    summary: { url: `/${id}`, path: `/${id}`, contentType: 'text/plain' },
    detail: { body: '' },
    ...fields
  };
}

test('stats are validated key by key: unknown keys and invalid values go, the record stays', () => {
  const payload = IngestPayload.parse({
    project: PROJECT,
    instance: INSTANCE,
    requests: [
      request('full', { stats: STATS, detail: { timeline: TIMELINE } }),
      request('partly', { stats: { queries: 2, queryTime: -1, slowQueries: 1.5, nPlusOne: 'x', duplicates: 2e9, http: 0, httpTime: Infinity, logs: 3, futureCounter: 9 } }),
      request('old'),
      request('broken', { stats: 'nope' })
    ]
  });
  assert.equal(payload.rejected, 0, 'stats never cost a record');
  const [full, partly, old, broken] = payload.records;
  assert.deepEqual(full.stats, STATS);
  assert.deepEqual(Object.keys(full.stats), ['queries', 'queryTime', 'slowQueries', 'nPlusOne', 'duplicates', 'http', 'httpTime', 'logs']);
  assert.deepEqual(partly.stats, { queries: 2, http: 0, logs: 3 });
  assert.equal(old.stats, null);
  assert.equal(broken.stats, null);
});

test('summaries carry the stats; details keep the timeline as sent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-hub-stats-'));
  dirs.push(dir);
  const store = new Store(dir).load();
  store.touch(PROJECT, INSTANCE);
  const payload = IngestPayload.parse({ project: PROJECT, instance: INSTANCE, requests: [request('one', { stats: STATS, detail: { timeline: TIMELINE } }), request('two')] });
  store.append(PROJECT.id, payload.records);
  const listed = store.list(PROJECT.id, { limit: 10 }).requests;
  assert.deepEqual(listed.map((item) => [item.id, item.stats]), [['two', null], ['one', STATS]]);
  assert.deepEqual(store.detail(PROJECT.id, 'one').timeline, TIMELINE);
  // Kept across restarts (the index holds them).
  assert.deepEqual(new Store(dir).load().list(PROJECT.id, { limit: 10 }).requests[1].stats, STATS);
});
