// Integration: real Hono apps served by @hono/node-server reach a hub: their requests with the route
// that answered them, and the errors Hono answers (by the app's own error handlers or Hono's). The
// apps answer exactly as they would without PeekInside. The hub runs in this process, so no
// background process is started.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

// The transport announces the dashboard link after its first delivery, and Hono's own error
// handler prints the errors these apps throw; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};
const logError = console.error;
console.error = (...args) => {
  if (!(args[0] instanceof Error && /cursed|failure|broke/.test(args[0].message))) logError(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-hono-'));
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

function send(port, method, target, { body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, servedBy: res.headers['x-served-by'] || null, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// What the hub stored for a project, oldest first, once `ready` holds.
async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = {
        project,
        requests: store.list(project.id, { limit: 1000 }).requests.reverse(),
        exceptions: store.listExceptions(project.id, { limit: 1000 }).exceptions.reverse()
      };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { requests: result.requests.map((item) => item.url), exceptions: result.exceptions.map((item) => item.message) })}`);
}

function listen(app) {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve({ server, port: info.port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// The same app, with or without PeekInside. Middleware and most routes come before PeekInside,
// some after: the route recorded is the one that answered either way.
function honoApp(peekName) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header('x-served-by', 'hono');
  });
  app.get('/users/:id', (c) => {
    const id = c.req.param('id');
    if (id === '13') throw new Error('user 13 is cursed');
    if (id === '0') throw new HTTPException(404, { message: 'No user 0' });
    return c.json({ id });
  });
  app.post('/users', async (c) => c.json({ created: await c.req.json() }, 201));
  app.get('/slow', async () => {
    await pause(5);
    throw new Error('slow failure');
  });

  // A sub-app that answers its own errors.
  const status = new Hono();
  status.onError((error, c) => c.json({ error: error.message }, 503));
  status.get('/:service', (c) => {
    throw new Error(`${c.req.param('service')} broke`);
  });
  app.route('/status', status);

  const peekInside = peekName ? PeekInside.attach(app, { project: peekName, local: true }) : null;
  app.get('/late/:id', (c) => c.text(`late ${c.req.param('id')}`));
  return { app, peekInside };
}

async function exercise(port) {
  return {
    found: await send(port, 'GET', '/users/7'),
    cursed: await send(port, 'GET', '/users/13'),
    missing: await send(port, 'GET', '/users/0'),
    created: await send(port, 'POST', '/users', { body: JSON.stringify({ name: 'Ada' }) }),
    slow: await send(port, 'GET', '/slow'),
    status: await send(port, 'GET', '/status/db'),
    late: await send(port, 'GET', '/late/5'),
    unknown: await send(port, 'GET', '/nowhere')
  };
}

test("Hono: routes, params, bodies and errors, with the app's answers unchanged", async () => {
  const plain = honoApp();
  const plainServer = await listen(plain.app);
  const expected = await exercise(plainServer.port);
  await close(plainServer.server);

  const { app, peekInside } = honoApp('hono-api');
  const { server, port } = await listen(app);
  try {
    const answers = await exercise(port);
    assert.deepEqual(answers, expected, 'every answer is the same with PeekInside');
    assert.equal(answers.cursed.status, 500);
    assert.equal(answers.status.status, 503);

    const result = await stored(peekInside, 'hono-api', (r) => r.requests.length >= 8 && r.exceptions.length >= 3);
    assert.equal(result.project.instances[0].framework, 'hono');
    assert.equal(result.project.instances[0].port, port, 'the port is learned from the first request');
    const byUrl = Object.fromEntries(result.requests.map((request) => [`${request.method} ${request.url}`, request]));

    const found = byUrl['GET /users/7'];
    assert.equal(found.route, '/users/:id', 'the route that answered, not the middleware before it');
    assert.equal(found.handler, null);
    assert.deepEqual(store.detail(result.project.id, found.id).params, { id: '7' });
    assert.equal(byUrl['POST /users'].route, '/users');
    assert.equal(store.detail(result.project.id, byUrl['POST /users'].id).body, '{"name":"Ada"}');
    assert.equal(byUrl['GET /status/db'].route, '/status/:service', "a sub-app's route, mounted");
    assert.equal(byUrl['GET /late/5'].route, '/late/:id', 'a route added after PeekInside');
    assert.equal(byUrl['GET /nowhere'].route, null, 'only middleware ran');
    assert.equal(byUrl['GET /nowhere'].status, 404);

    const byMessage = Object.fromEntries(result.exceptions.map((exception) => [exception.message, exception]));
    assert.equal(byMessage['No user 0'], undefined, '4xx answers are not exceptions');
    const cursed = byMessage['user 13 is cursed'];
    assert.equal(cursed.mechanism, 'hono');
    assert.equal(cursed.handled, false, "Hono's own error handler");
    assert.equal(cursed.requestId, byUrl['GET /users/13'].id);
    assert.deepEqual(cursed.request, { method: 'GET', path: '/users/13', route: '/users/:id' });
    assert.equal(byMessage['slow failure'].handled, false, 'a rejected promise');
    assert.equal(byMessage['slow failure'].requestId, byUrl['GET /slow'].id);
    const broke = byMessage['db broke'];
    assert.equal(broke.handled, true, "the sub-app's error handler answers it");
    assert.equal(broke.requestId, byUrl['GET /status/db'].id);
    assert.equal(byUrl['GET /users/13'].exceptionCount, 1);
  } finally {
    await close(server);
    peekInside.stop();
  }
});

test('Hono: an error handler set after PeekInside is the app handling its errors', async () => {
  const app = new Hono();
  const peekInside = PeekInside.attach(app, { project: 'hono-handled', local: true });
  app.get('/charge', () => {
    throw new Error('card failure');
  });
  app.get('/rethrow', () => {
    throw new Error('rethrown failure');
  });
  app.onError((error, c) => {
    if (error.message === 'rethrown failure') throw error;
    return c.json({ error: 'payment_failed' }, 402);
  });
  const { server, port } = await listen(app);
  try {
    assert.equal((await send(port, 'GET', '/charge')).status, 402);
    assert.equal((await send(port, 'GET', '/rethrow')).status, 500, 'node-server answers what escapes');
    const result = await stored(peekInside, 'hono-handled', (r) => r.exceptions.length >= 2 && r.requests.length >= 2);
    const byMessage = Object.fromEntries(result.exceptions.map((exception) => [exception.message, exception]));
    assert.equal(byMessage['card failure'].handled, true);
    assert.equal(byMessage['card failure'].mechanism, 'hono');
    assert.equal(byMessage['rethrown failure'].handled, false, 'the handler threw it on');
  } finally {
    await close(server);
    peekInside.stop();
  }
});

test('Hono: app.request() and other runtimes are left alone', async () => {
  const app = new Hono();
  const peekInside = PeekInside.attach(app, { project: 'hono-request', local: true });
  app.get('/ping', (c) => c.text('pong'));
  try {
    const response = await app.request('/ping');
    assert.equal(await response.text(), 'pong');
  } finally {
    peekInside.stop();
  }
});
