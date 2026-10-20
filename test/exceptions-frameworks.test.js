// Integration: exceptions in real Express (4 and 5), Koa, Fastify and http apps reach a hub,
// linked to the requests they happened in, and the apps answer exactly as they would without
// PeekInside. The hub runs in this process, so no background process is started.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express4 from 'express';
import express5 from 'express5';
import Fastify from 'fastify';
import Koa from 'koa';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-exceptions-'));
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

function send(port, method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = body === undefined ? headers : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: allHeaders }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function listen(server) {
  return new Promise((resolve) => {
    if (server.listening) resolve(server.address().port);
    else server.once('listening', () => resolve(server.address().port));
  });
}

function attach(app, name, options = {}) {
  return PeekInside.attach(app, { project: name, local: true, ...options });
}

// What the hub stored for a project: requests and exceptions, oldest first, once `ready` holds.
async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 100; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      const requests = store.list(project.id, { limit: 1000 }).requests.reverse();
      const exceptions = store.listExceptions(project.id, { limit: 1000 }).exceptions.reverse();
      result = { project, requests, exceptions };
      if (ready(result)) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { requests: result.requests.length, exceptions: result.exceptions.map((item) => item.message) })}`);
}

function requestFor(result, url) {
  return result.requests.find((request) => request.url === url);
}

function exceptionFor(result, message) {
  return result.exceptions.find((exception) => exception.message === message);
}

// The request it happened in has its id, counts it and lists it (with its route, when the framework
// names it).
function assertLinked(result, exception, url, route = null) {
  const request = requestFor(result, url);
  assert.ok(request, `request ${url} is stored`);
  assert.equal(exception.requestId, request.id, `${exception.message} is linked to ${url}`);
  assert.deepEqual(exception.request, { method: 'GET', path: url.split('?')[0], ...(route ? { route } : {}) });
  assert.ok(request.exceptionCount >= 1);
  const detail = store.detail(result.project.id, request.id);
  assert.ok(detail.exceptions.some((link) => link.id === exception.id && link.name === exception.name && link.message === exception.message));
  const exceptionDetail = store.exceptionDetail(result.project.id, exception.id);
  assert.equal(exceptionDetail.request.id, request.id);
  assert.equal(exceptionDetail.request.url, url);
}

// The same Express app, with or without PeekInside.
function expressApp(express, version, peekName) {
  const app = express();
  app.set('env', 'test'); // Express logs errors to the console in any other environment
  const peekInside = peekName ? attach(app, peekName) : null;
  app.get('/sync', () => {
    throw new Error('sync failure');
  });
  app.get('/next', (req, res, next) => next(new Error('next failure')));
  if (version === 5) {
    app.get('/async', async () => {
      throw new Error('async failure');
    });
  }
  app.get('/handled', () => {
    throw new TypeError('handled failure');
  });
  app.get('/passed-on', (req, res, next) => next(new Error('logged, then passed on')));
  app.get('/not-found', (req, res, next) => next(Object.assign(new Error('Not Found'), { status: 404 })));
  app.get('/fine', (req, res) => res.json({ ok: true }));
  // Answers one route itself; passes the others on to Express's final handler.
  app.use((error, req, res, next) => {
    if (req.path === '/handled') return res.status(503).json({ error: error.message });
    next(error);
  });
  return { app, peekInside };
}

for (const [version, express] of [[4, express4], [5, express5]]) {
  test(`Express ${version}: errors handled by error middleware and errors left to Express`, async () => {
    const name = `express${version}-errors`;
    const { app, peekInside } = expressApp(express, version, name);
    const server = app.listen(0, '127.0.0.1');
    const plain = expressApp(express, version, null).app.listen(0, '127.0.0.1');
    try {
      const port = await listen(server);
      const plainPort = await listen(plain);
      const routes = ['/sync', '/next', ...(version === 5 ? ['/async'] : []), '/handled', '/passed-on', '/not-found', '/fine'];
      for (const route of routes) {
        const withPeek = await send(port, 'GET', route);
        const without = await send(plainPort, 'GET', route);
        // Error pages show the stack in development, and PeekInside's middleware is on it:
        // compare everything else.
        const page = (response) => ({ ...response, text: response.text.replace(/<pre>[\s\S]*<\/pre>/, '<pre></pre>') });
        assert.deepEqual(page(withPeek), page(without), `${route} answers the same`);
      }
      assert.equal((await send(port, 'GET', '/handled')).status, 503);

      const result = await stored(peekInside, name, (state) => state.requests.length >= routes.length + 1 && state.exceptions.length >= routes.length - 1);
      const sync = exceptionFor(result, 'sync failure');
      assert.equal(sync.mechanism, 'express');
      assert.equal(sync.handled, false);
      assert.equal(sync.fatal, false);
      assert.equal(sync.name, 'Error');
      assert.equal(sync.location.file, 'test/exceptions-frameworks.test.js');
      assertLinked(result, sync, '/sync');

      const next = exceptionFor(result, 'next failure');
      assert.equal(next.handled, false);
      assertLinked(result, next, '/next');

      if (version === 5) {
        const rejected = exceptionFor(result, 'async failure');
        assert.equal(rejected.handled, false);
        assert.equal(rejected.mechanism, 'express');
        assertLinked(result, rejected, '/async');
      }

      const handled = result.exceptions.filter((item) => item.message === 'handled failure');
      assert.equal(handled.length, 2, 'once per request');
      assert.ok(handled.every((item) => item.handled === true && item.name === 'TypeError'));
      assertLinked(result, handled[0], '/handled');

      const passedOn = result.exceptions.filter((item) => item.message === 'logged, then passed on');
      assert.equal(passedOn.length, 1, 'recorded once, though two handlers saw it');
      assert.equal(passedOn[0].handled, false, 'it reached the final handler after all');

      assert.equal(exceptionFor(result, 'Not Found'), undefined, '4xx errors are answers, not bugs');
      assert.equal(requestFor(result, '/not-found').exceptionCount, 0);
      assert.equal(requestFor(result, '/fine').exceptionCount, 0);
      assert.deepEqual(store.detail(result.project.id, requestFor(result, '/fine').id).exceptions, []);

      const detail = store.exceptionDetail(result.project.id, sync.id);
      assert.ok(detail.frames[0].inApp);
      assert.ok(detail.frames[0].context.lines.some((line) => line.includes("throw new Error('sync failure')")));
      assert.ok(detail.frames.some((frame) => frame.module === (version === 5 ? 'router' : 'express')));
    } finally {
      peekInside.stop();
      server.close();
      plain.close();
    }
  });
}

test('Express: report() during a request is linked through AsyncLocalStorage, and outside one is not', async () => {
  const name = 'express-report';
  const app = express4();
  const peekInside = attach(app, name);
  let outsideId = null;
  app.get('/later', (req, res) => {
    // A timer started during the request still knows the request.
    setTimeout(() => {
      const id = PeekInside.report(new Error('reported later'), { tags: { area: 'billing' }, extra: { orderId: 7 } });
      res.json({ id });
    }, 5);
  });
  app.get('/explicit', (req, res) => res.json({ id: peekInside.report('a plain string', { request: req, handled: false }) }));

  const server = app.listen(0, '127.0.0.1');
  try {
    const port = await listen(server);
    const later = JSON.parse((await send(port, 'GET', '/later?x=1')).text);
    const explicit = JSON.parse((await send(port, 'GET', '/explicit')).text);
    outsideId = PeekInside.report(new Error('outside any request'));
    assert.match(later.id, /^[0-9a-f-]{36}$/);
    assert.ok(outsideId);

    const result = await stored(peekInside, name, (state) => state.exceptions.length === 3 && state.requests.length === 2);
    const reported = result.exceptions.find((item) => item.id === later.id);
    assert.equal(reported.mechanism, 'report');
    assert.equal(reported.handled, true);
    assertLinked(result, reported, '/later?x=1');
    const detail = store.exceptionDetail(result.project.id, reported.id);
    assert.deepEqual(detail.tags, { area: 'billing' });
    assert.deepEqual(detail.extra, { orderId: 7 });
    assert.deepEqual(detail.request.query, { x: '1' });

    const plain = result.exceptions.find((item) => item.id === explicit.id);
    assert.equal(plain.name, 'ThrownValue');
    assert.equal(plain.message, 'a plain string');
    assert.equal(plain.handled, false);
    assertLinked(result, plain, '/explicit');

    const outside = result.exceptions.find((item) => item.id === outsideId);
    assert.equal(outside.requestId, null);
    assert.equal(outside.request, null);
    assert.equal(store.exceptionDetail(result.project.id, outsideId).request, null);
  } finally {
    peekInside.stop();
    server.close();
  }
  assert.equal(PeekInside.report(new Error('no instance records')), null, 'stopped instances record nothing');
});

test('Express: setUser() puts the user on the request and on its exceptions', async () => {
  const name = 'express-users';
  const app = express4();
  app.set('env', 'test'); // Express logs errors to the console in any other environment
  const peekInside = attach(app, name);
  const outside = PeekInside.setUser({ id: 'nobody' });
  app.use((req, res, next) => {
    if (req.headers['x-user']) PeekInside.setUser({ id: Number(req.headers['x-user']), email: `user${req.headers['x-user']}@example.test`, mobile: 919876543210, password: 'never kept' });
    next();
  });
  app.get('/checkout', () => {
    throw new Error('card declined');
  });
  app.get('/reported', (req, res) => res.json({ id: PeekInside.report(new Error('for someone else'), { user: 'user_7' }) }));

  const server = app.listen(0, '127.0.0.1');
  try {
    const port = await listen(server);
    await send(port, 'GET', '/checkout', { headers: { 'x-user': '42' } });
    await send(port, 'GET', '/checkout');
    await send(port, 'GET', '/reported', { headers: { 'x-user': '42' } });
    assert.equal(outside, false, 'no request to attach a user to');

    const result = await stored(peekInside, name, (state) => state.exceptions.length === 3 && state.requests.length === 3);
    const ada = { id: '42', email: 'user42@example.test', name: null, phone: '919876543210' };
    const [withUser, anonymous, reported] = result.requests;
    assert.deepEqual(withUser.user, ada);
    assert.equal(anonymous.user, null);
    assert.deepEqual(reported.user, ada);

    const declined = result.exceptions.filter((item) => item.message === 'card declined');
    assert.deepEqual(declined.map((item) => item.user), [ada, null]);
    assert.deepEqual(exceptionFor(result, 'for someone else').user, { id: 'user_7', email: null, name: null, phone: null }, 'report({ user }) wins');
  } finally {
    peekInside.stop();
    server.close();
  }
});

test('Koa: errors propagating out of the middleware, without changing the answer or the logging', async () => {
  const name = 'koa-errors';
  const build = (withPeek) => {
    const app = new Koa();
    app.silent = true; // Koa's default handler would log each error
    const peekInside = withPeek ? attach(app, name) : null;
    app.use(async (ctx) => {
      if (ctx.path === '/boom') throw new Error('koa failure');
      if (ctx.path === '/bad') ctx.throw(400, 'Bad input');
      if (ctx.path === '/report') ctx.body = { id: PeekInside.report(new Error('koa report')) };
      else ctx.body = { ok: true };
    });
    return { app, peekInside };
  };
  const { app, peekInside } = build(true);
  const server = app.listen(0, '127.0.0.1');
  const plain = build(false).app.listen(0, '127.0.0.1');
  try {
    const port = await listen(server);
    const plainPort = await listen(plain);
    for (const route of ['/boom', '/bad', '/ok']) {
      assert.deepEqual(await send(port, 'GET', route), await send(plainPort, 'GET', route), `${route} answers the same`);
    }
    const reported = JSON.parse((await send(port, 'GET', '/report')).text);
    assert.deepEqual(app.listeners('error'), [app.onerror], 'no error listener added: Koa still logs errors itself');

    const result = await stored(peekInside, name, (state) => state.requests.length === 4 && state.exceptions.length === 2);
    const boom = exceptionFor(result, 'koa failure');
    assert.equal(boom.mechanism, 'koa');
    assert.equal(boom.handled, false);
    assert.equal(boom.fatal, false);
    assertLinked(result, boom, '/boom');
    assert.equal(requestFor(result, '/boom').status, 500);
    assert.equal(exceptionFor(result, 'Bad input'), undefined, 'ctx.throw(400) is an answer');
    assertLinked(result, result.exceptions.find((item) => item.id === reported.id), '/report');
  } finally {
    peekInside.stop();
    server.close();
    plain.close();
  }
});

test('Fastify: errors from the onError hook, handled when the app has its own error handler', async () => {
  const build = (withPeek, name, customHandler) => {
    const fastify = Fastify();
    const peekInside = withPeek ? attach(fastify, name) : null;
    if (customHandler) {
      fastify.setErrorHandler((error, request, reply) => {
        reply.code(502).send({ handledBy: 'app', message: error.message });
      });
    }
    fastify.get('/boom', async () => {
      throw new Error('fastify failure');
    });
    fastify.post('/report', { schema: { body: { type: 'object', required: ['n'] } } }, async (request) => {
      // After Fastify parsed the body, the request is still known.
      return { id: PeekInside.report(new Error(`fastify report ${request.body.n}`)) };
    });
    return { fastify, peekInside };
  };

  for (const customHandler of [false, true]) {
    const name = customHandler ? 'fastify-handled' : 'fastify-errors';
    const { fastify, peekInside } = build(true, name, customHandler);
    const { fastify: plain } = build(false, name, customHandler);
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    await plain.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = fastify.server.address().port;
      const plainPort = plain.server.address().port;
      assert.deepEqual(await send(port, 'GET', '/boom'), await send(plainPort, 'GET', '/boom'), 'answers the same');
      assert.deepEqual(await send(port, 'POST', '/report', { body: '{}' }), await send(plainPort, 'POST', '/report', { body: '{}' }), 'validation errors too');
      const reported = JSON.parse((await send(port, 'POST', '/report', { body: '{"n":1}' })).text);

      const result = await stored(peekInside, name, (state) => state.requests.length === 3 && state.exceptions.length === 2);
      const boom = exceptionFor(result, 'fastify failure');
      assert.equal(boom.mechanism, 'fastify');
      assert.equal(boom.handled, customHandler);
      assertLinked(result, boom, '/boom', '/boom');
      assert.equal(requestFor(result, '/boom').route, '/boom', 'the route Fastify matched');
      assert.equal(result.exceptions.filter((item) => item.message.includes('body')).length, 0, 'a 400 validation error is not recorded');
      const report = result.exceptions.find((item) => item.id === reported.id);
      assert.equal(report.message, 'fastify report 1');
      assert.equal(report.requestId, result.requests[2].id);
      assert.equal(result.requests[2].route, '/report');
    } finally {
      peekInside.stop();
      await fastify.close();
      await plain.close();
    }
  }
});

test('http: report() from request event listeners is linked to the request', async () => {
  const name = 'http-report';
  let peekInside;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    // Listeners of the request's own events run outside the request listener.
    req.on('end', () => {
      const id = peekInside.report(new Error(`http report ${body}`));
      res.end(JSON.stringify({ id }));
    });
  });
  peekInside = attach(server, name);
  server.listen(0, '127.0.0.1');
  try {
    const port = await listen(server);
    const { id } = JSON.parse((await send(port, 'POST', '/upload', { body: '{"a":1}' })).text);
    const result = await stored(peekInside, name, (state) => state.requests.length === 1 && state.exceptions.length === 1);
    assert.equal(result.exceptions[0].id, id);
    assert.equal(result.exceptions[0].requestId, result.requests[0].id);
    assert.equal(store.exceptionDetail(result.project.id, id).request.body, '{"a":1}', 'with the body received so far');
  } finally {
    peekInside.stop();
    server.close();
  }
});

test('requests local mode refuses to record take their exceptions with them', async () => {
  const name = 'express-server-traffic';
  const app = express4();
  app.set('env', 'test');
  const peekInside = attach(app, name);
  app.get('/boom', () => {
    throw new Error('server failure');
  });
  app.get('/report', (req, res) => res.json({ id: PeekInside.report(new Error('server report')) }));
  const server = app.listen(0, '127.0.0.1');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const port = await listen(server);
    assert.equal((await send(port, 'GET', '/boom', { headers: { host: 'api.company.com' } })).status, 500);
    assert.deepEqual(JSON.parse((await send(port, 'GET', '/report', { headers: { host: 'api.company.com' } })).text), { id: null });
    await send(port, 'GET', '/boom');

    const result = await stored(peekInside, name, (state) => state.requests.length === 1 && state.exceptions.length === 1);
    assert.equal(result.project.blocked.total, 2);
    assert.deepEqual(result.exceptions.map((item) => item.message), ['server failure']);
    assertLinked(result, result.exceptions[0], '/boom');
  } finally {
    console.warn = warn;
    peekInside.stop();
    server.close();
  }
});

test('captureExceptions: false records only what the app reports; ignored paths record nothing', async () => {
  const name = 'express-manual';
  const app = express4();
  app.set('env', 'test');
  const peekInside = attach(app, name, { captureExceptions: false, ignorePaths: ['/health'] });
  app.get('/boom', () => {
    throw new Error('not captured');
  });
  app.get('/report', (req, res) => res.json({ id: peekInside.report(new Error('reported anyway')) }));
  app.get('/health', () => {
    throw new Error('ignored path');
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    const port = await listen(server);
    await send(port, 'GET', '/boom');
    await send(port, 'GET', '/health');
    await send(port, 'GET', '/report');
    const result = await stored(peekInside, name, (state) => state.requests.length === 2 && state.exceptions.length === 1);
    assert.deepEqual(result.exceptions.map((item) => item.message), ['reported anyway']);
    assert.equal(requestFor(result, '/boom').exceptionCount, 0);
  } finally {
    peekInside.stop();
    server.close();
  }
});

test('a hub too old to store exceptions is pointed out, once', async () => {
  // Answers like a hub from before exceptions: no acceptedExceptions.
  const oldHub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":0,"rejected":0}');
    });
  });
  await new Promise((resolve) => oldHub.listen(0, '127.0.0.1', resolve));
  const saved = process.env.PEEKINSIDE_HUB_PORT;
  process.env.PEEKINSIDE_HUB_PORT = String(oldHub.address().port);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let peekInside;
  try {
    peekInside = new PeekInside({ project: 'old-hub', local: true });
    process.env.PEEKINSIDE_HUB_PORT = saved;
    peekInside.report(new Error('first'));
    await peekInside.flush();
    peekInside.report(new Error('second'));
    await peekInside.flush();
  } finally {
    process.env.PEEKINSIDE_HUB_PORT = saved;
    console.warn = warn;
    if (peekInside) peekInside.stop();
    oldHub.close();
  }
  const outdated = warnings.filter((line) => line.includes('older version'));
  assert.equal(outdated.length, 1);
  assert.match(outdated[0], /npx peekinside stop/);
});
