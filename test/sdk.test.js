// End to end: an app with PeekInside attached starts the hub by itself and its requests arrive.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import PeekInside from '../index.js';
import { HubClient } from '../src/hub/client.js';

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
process.env.PEEKINSIDE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-sdk-'));
process.env.PEEKINSIDE_HUB_PORT = String(port);
const hub = new HubClient(port);

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

function withNodeEnv(value, fn) {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

test('local mode is for development only unless turned on', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(withNodeEnv('production', () => new PeekInside().isEnabled), false);
    assert.equal(withNodeEnv('test', () => new PeekInside().isEnabled), false);
    assert.equal(withNodeEnv('production', () => new PeekInside({ local: true }).isEnabled), true);
    assert.equal(withNodeEnv('development', () => new PeekInside({ local: false }).isEnabled), false);
  } finally {
    console.warn = quiet;
  }
});

test('an attached app starts the hub and its requests arrive', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/gzip') {
        const payload = zlib.gzipSync(JSON.stringify({ items: ['a', 'b'] }));
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(payload);
      }
      res.writeHead(req.method === 'POST' ? 201 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: body || null }));
    });
  });

  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  const peekInside = PeekInside.attach(server, { project: 'sdk-test', local: true });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const appPort = server.address().port;

    const send = (method, target, body) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: appPort, method, path: target, headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(body);
    });
    await send('POST', '/api/users?source=test', JSON.stringify({ name: 'Ada' }));
    await send('GET', '/missing');
    await send('GET', '/gzip');
    await peekInside.flush();

    let project;
    for (let i = 0; i < 80 && !(project && project.requestCount === 3); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await peekInside.flush();
      const listed = await hub.request('GET', '/api/projects').catch(() => null);
      project = listed && listed.projects.find((item) => item.name === 'sdk-test');
    }

    assert.ok(project, 'the project is registered');
    assert.equal(project.requestCount, 3);
    assert.equal(project.online, true);
    assert.equal(project.instances[0].port, appPort);
    assert.equal(project.instances[0].framework, 'http');
    assert.ok(lines.some((line) => line.includes(`http://localhost:${port}/p/${project.id}`)), 'prints the dashboard link');

    const { requests } = await hub.request('GET', `/api/projects/${project.id}/requests`);
    assert.deepEqual(requests.map((item) => `${item.method} ${item.url} ${item.status}`), [
      'GET /gzip 200',
      'GET /missing 404',
      'POST /api/users?source=test 201'
    ]);

    const post = requests[2];
    const { detail } = await hub.request('GET', `/api/projects/${project.id}/requests/${post.id}`);
    assert.equal(detail.body, '{"name":"Ada"}');
    assert.deepEqual(detail.query, { source: 'test' });

    const gzip = await hub.request('GET', `/api/projects/${project.id}/requests/${requests[0].id}`);
    assert.equal(gzip.detail.response.body, '{"items":["a","b"]}', 'compressed responses are stored decoded');

    // Requests that reached the app as a server are not recorded on the free plan.
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const sendAs = (headers) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: appPort, method: 'GET', path: '/missing', headers }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end();
      });
      await sendAs({ host: 'api.company.com' });
      await sendAs({ host: 'api.company.com' });
      await sendAs({ host: 'localhost:3000', 'x-forwarded-for': '8.8.8.8' });
      await sendAs({ host: 'shop.test' });
      await peekInside.flush();
    } finally {
      console.warn = warn;
    }

    let after;
    for (let i = 0; i < 50 && !(after && after.blocked && after.blocked.total === 3 && after.requestCount === 4); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await peekInside.flush();
      after = (await hub.request('GET', '/api/projects')).projects.find((item) => item.id === project.id);
    }
    assert.equal(after.requestCount, 4, 'only the local request (shop.test) was added');
    assert.deepEqual(after.blocked.entries, [
      { kind: 'host', value: 'api.company.com', count: 2 },
      { kind: 'client', value: '8.8.8.8', count: 1 }
    ]);
    assert.ok(warnings.some((line) => line.includes('Not recording requests to api.company.com')), 'warns in the console');
    assert.equal(warnings.filter((line) => line.includes('api.company.com')).length, 1, 'once per host');
  } finally {
    console.log = log;
    peekInside.stop();
    server.close();
  }
});
