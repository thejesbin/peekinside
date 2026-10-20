// Integration: real Express, Koa and Fastify apps with PeekInside attached report to a hub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import PeekInside from '../index.js';
import { HubClient } from '../src/hub/client.js';

const hubPort = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
process.env.PEEKINSIDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-frameworks-'));
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const hub = new HubClient(hubPort);

// Spaces make the raw body differ from its parsed value serialized again, so each test shows
// which of the two was recorded.
const RAW_BODY = '{ "name": "Ada" }';

after(async () => {
  const status = await hub.status().catch(() => null);
  if (status) {
    process.kill(status.pid, 'SIGTERM');
    for (let i = 0; i < 50 && (await hub.status().catch(() => null)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fs.rmSync(process.env.PEEKINSIDE_HOME, { recursive: true, force: true });
});

function send(port, method, target, body) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Sends the same three requests to an app and returns what the hub stored for them, oldest first.
async function exercise(name, peekInside, port) {
  const created = await send(port, 'POST', '/api/users?source=test', RAW_BODY);
  assert.equal(created.status, 201, `${name} handled the POST`);
  await send(port, 'GET', '/api/users/42');
  await send(port, 'GET', '/missing');
  await peekInside.flush();

  let project;
  for (let i = 0; i < 80 && !(project && project.requestCount === 3); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await peekInside.flush();
    const listed = await hub.request('GET', '/api/projects').catch(() => null);
    project = listed && listed.projects.find((item) => item.name === name);
  }
  assert.ok(project, `${name} is registered in the hub`);
  assert.equal(project.requestCount, 3);

  const { requests } = await hub.request('GET', `/api/projects/${project.id}/requests`);
  const stored = [];
  for (const summary of requests.reverse()) {
    const { detail } = await hub.request('GET', `/api/projects/${project.id}/requests/${summary.id}`);
    stored.push({ summary, detail });
  }
  return { project, stored };
}

// Runs one app with console output captured, and always cleans up.
async function withApp(name, run) {
  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  let peekInside;
  try {
    return await run((app) => (peekInside = PeekInside.attach(app, { project: name, local: true })), lines);
  } finally {
    console.log = log;
    if (peekInside) peekInside.stop();
  }
}

function listen(server) {
  return new Promise((resolve) => server.once('listening', () => resolve(server.address().port)));
}

test('Express: body parsed by express.json() registered before PeekInside', async () => {
  await withApp('express-json-first', async (attach, lines) => {
    const app = express();
    app.use(express.json());
    const peekInside = attach(app);
    app.post('/api/users', (req, res) => res.status(201).json({ id: 1, ...req.body }));
    app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));

    const server = app.listen(0, '127.0.0.1');
    try {
      const port = await listen(server);
      const { project, stored } = await exercise('express-json-first', peekInside, port);
      assert.equal(project.instances[0].framework, 'express');
      assert.equal(project.instances[0].port, port);
      assert.ok(lines.some((line) => line.includes(`/p/${project.id}`)), 'prints the dashboard link');

      assert.deepEqual(stored.map(({ summary }) => `${summary.method} ${summary.url} ${summary.status}`), [
        'POST /api/users?source=test 201',
        'GET /api/users/42 200',
        'GET /missing 404'
      ]);
      const [post, get] = stored;
      // The parser read the body first, so the parsed value is recorded.
      assert.equal(post.detail.body, '{"name":"Ada"}');
      assert.equal(post.detail.bodySize, Buffer.byteLength(RAW_BODY));
      assert.equal(post.detail.bodyEncoding, 'utf8');
      assert.deepEqual(post.detail.query, { source: 'test' });
      assert.equal(post.detail.response.body, '{"id":1,"name":"Ada"}');
      assert.equal(post.summary.contentType, 'application/json; charset=utf-8');
      assert.deepEqual(get.detail.params, { id: '42' });
      assert.equal(get.detail.response.body, '{"id":"42"}');
    } finally {
      server.close();
    }
  });
});

test('Express: body parsed by express.json() registered after PeekInside', async () => {
  await withApp('express-json-after', async (attach) => {
    const app = express();
    const peekInside = attach(app);
    app.use(express.json());
    app.post('/api/users', (req, res) => res.status(201).json({ id: 1, ...req.body }));
    app.get('/api/users/:id', (req, res) => res.json({ id: req.params.id }));

    const server = app.listen(0, '127.0.0.1');
    try {
      const port = await listen(server);
      const { project, stored } = await exercise('express-json-after', peekInside, port);
      assert.equal(project.instances[0].framework, 'express');
      assert.deepEqual(stored.map(({ summary }) => `${summary.method} ${summary.url} ${summary.status}`), [
        'POST /api/users?source=test 201',
        'GET /api/users/42 200',
        'GET /missing 404'
      ]);
      // The body is captured as the parser reads it: the raw bytes.
      assert.equal(stored[0].detail.body, RAW_BODY);
      assert.equal(stored[0].detail.bodyTruncated, false);
      assert.equal(stored[0].detail.response.body, '{"id":1,"name":"Ada"}');
    } finally {
      server.close();
    }
  });
});

test('Koa: raw body read by the app, and the parsed body when a parser ran first', async () => {
  // A minimal body parser, as koa-bodyparser would do it: reads the stream into ctx.request.body.
  const parseJson = async (ctx, next) => {
    if (ctx.method === 'POST') {
      let raw = '';
      for await (const chunk of ctx.req) raw += chunk;
      ctx.request.body = JSON.parse(raw);
    }
    await next();
  };
  const routes = async (ctx) => {
    if (ctx.method === 'POST' && ctx.path === '/api/users') {
      if (ctx.request.body === undefined) {
        let raw = '';
        for await (const chunk of ctx.req) raw += chunk;
        ctx.request.body = JSON.parse(raw);
      }
      ctx.status = 201;
      ctx.body = { id: 1, ...ctx.request.body };
    } else if (ctx.path === '/api/users/42') {
      ctx.body = { id: '42' };
    }
  };

  for (const parserFirst of [false, true]) {
    const name = parserFirst ? 'koa-parser-first' : 'koa-app';
    await withApp(name, async (attach) => {
      const app = new Koa();
      if (parserFirst) app.use(parseJson);
      const peekInside = attach(app);
      app.use(routes);

      const server = app.listen(0, '127.0.0.1');
      try {
        const port = await listen(server);
        const { project, stored } = await exercise(name, peekInside, port);
        assert.equal(project.instances[0].framework, 'koa');
        assert.deepEqual(stored.map(({ summary }) => `${summary.method} ${summary.url} ${summary.status}`), [
          'POST /api/users?source=test 201',
          'GET /api/users/42 200',
          'GET /missing 404'
        ]);
        assert.equal(stored[0].detail.body, parserFirst ? '{"name":"Ada"}' : RAW_BODY, name);
        assert.equal(stored[0].detail.response.body, '{"id":1,"name":"Ada"}');
        assert.equal(stored[2].detail.response.body, 'Not Found');
      } finally {
        server.close();
      }
    });
  }
});

test('Fastify: requests and bodies parsed by Fastify', async () => {
  await withApp('fastify-app', async (attach) => {
    const fastify = Fastify();
    const peekInside = attach(fastify);
    fastify.post('/api/users', async (request, reply) => {
      reply.code(201);
      return { id: 1, ...request.body };
    });
    fastify.get('/api/users/:id', async (request) => ({ id: request.params.id }));

    await fastify.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = fastify.server.address().port;
      const { project, stored } = await exercise('fastify-app', peekInside, port);
      assert.equal(project.instances[0].framework, 'fastify');
      assert.equal(project.instances[0].port, port);
      assert.deepEqual(stored.map(({ summary }) => `${summary.method} ${summary.url} ${summary.status}`), [
        'POST /api/users?source=test 201',
        'GET /api/users/42 200',
        'GET /missing 404'
      ]);
      assert.equal(stored[0].detail.body, RAW_BODY);
      assert.equal(stored[0].detail.response.body, '{"id":1,"name":"Ada"}');
      assert.equal(stored[1].detail.response.body, '{"id":"42"}');
      assert.match(stored[2].detail.response.body, /not found/i);
    } finally {
      await fastify.close();
    }
  });
});
