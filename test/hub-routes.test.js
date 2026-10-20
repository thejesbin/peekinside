// The hub keeps the route pattern and the handler a framework named for a request (and for the
// request line of its exceptions), and accepts what the NestJS and Hono integrations send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IngestPayload } from '../src/hub/ingest-payload.js';
import { Store } from '../src/hub/store.js';

const PROJECT = { id: 'orders-api-1a2b3c4d', name: 'orders-api', root: '/work/orders-api' };
const INSTANCE = { pid: 4242, startedAt: 1, framework: 'nest' };
const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function request(id, summary) {
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
    summary: { url: `/orders/${id}`, path: `/orders/${id}`, contentType: 'application/json', ...summary },
    detail: {}
  };
}

function exception(id, mechanism, requestLine) {
  return {
    id,
    occurredAt: 1_700_000_000_001,
    environment: 'development',
    handled: false,
    fatal: false,
    requestId: 'r1',
    summary: { name: 'Error', message: 'order 13 is cursed', fingerprint: '0123456789abcdef', mechanism, request: requestLine },
    detail: {}
  };
}

function log(id, source) {
  return { id, occurredAt: 1_700_000_000_002, environment: 'development', level: 'info', source, requestId: 'r1', summary: { message: '[OrdersService] Looking up order 13' } };
}

test('routes and handlers are kept as strings, capped; anything else is dropped', () => {
  const payload = IngestPayload.parse({
    project: PROJECT,
    instance: INSTANCE,
    requests: [
      request('r1', { route: '/orders/:id', handler: 'OrdersController.find' }),
      request('r2', { route: 42, handler: { name: 'x' } }),
      request('r3', { route: `/${'a'.repeat(600)}`, handler: 'H'.repeat(300) }),
      request('r4')
    ]
  });
  const [named, odd, long, none] = payload.records;
  assert.equal(named.route, '/orders/:id');
  assert.equal(named.handler, 'OrdersController.find');
  assert.equal(odd.route, null);
  assert.equal(odd.handler, null);
  assert.equal(long.route.length, 512);
  assert.equal(long.handler.length, 256);
  assert.equal(none.route, null, 'frameworks that name no route');
  assert.equal(payload.instance.framework, 'nest');
});

test("NestJS and Hono exceptions, their request lines, and Nest's log lines are accepted", () => {
  const payload = IngestPayload.parse({
    project: PROJECT,
    instance: INSTANCE,
    requests: [],
    exceptions: [
      exception('e1', 'nest', { method: 'GET', path: '/orders/13', route: '/orders/:id', handler: 'OrdersController.find' }),
      exception('e2', 'hono', { method: 'GET', path: '/orders/13', route: 7 }),
      exception('e3', 'restify', { method: 'GET', path: '/orders/13' })
    ],
    logs: [log('l1', 'nest'), log('l2', 'bunyan')]
  });
  assert.deepEqual(payload.exceptions.map((item) => item.mechanism), ['nest', 'hono'], 'an unknown mechanism is refused');
  assert.deepEqual(payload.exceptions[0].request, { method: 'GET', path: '/orders/13', route: '/orders/:id', handler: 'OrdersController.find' });
  assert.deepEqual(payload.exceptions[1].request, { method: 'GET', path: '/orders/13' });
  assert.deepEqual(payload.logs.map((line) => line.source), ['nest', 'console'], 'an unknown source is a console line');
});

test('the store lists routes and handlers, and null for requests stored before them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-hub-routes-'));
  dirs.push(dir);
  const store = new Store(dir).load();
  const payload = IngestPayload.parse({ project: PROJECT, instance: INSTANCE, requests: [request('r1', { route: '/orders/:id', handler: 'OrdersController.find' })] });
  store.ensure(PROJECT);
  store.append(PROJECT.id, payload.records);
  const { route, handler, ...unnamed } = payload.records[0];
  store.append(PROJECT.id, [{ ...unnamed, id: 'r0' }]);
  const [legacy, named] = store.list(PROJECT.id, { limit: 10 }).requests;
  assert.equal(named.route, '/orders/:id');
  assert.equal(named.handler, 'OrdersController.find');
  assert.equal(legacy.route, null);
  assert.equal(legacy.handler, null);
});
