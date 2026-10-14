import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const PROJECT = { id: 'orders-api-1a2b3c4d', name: 'orders-api', root: '/work/orders-api' };
const INSTANCE = { pid: 4242, port: 3000, framework: 'express', startedAt: Date.now() };
const RECORD = {
  id: 'f2b1c0de-0000-4000-8000-000000000001',
  occurredAt: Date.now(),
  environment: 'development',
  method: 'POST',
  status: 201,
  duration: 12.5,
  requestSize: 17,
  responseSize: 30,
  aborted: false,
  summary: { url: '/api/users?x=1', path: '/api/users', contentType: 'application/json' },
  detail: { body: '{"name":"Ada"}', response: { body: '{"id":1}' } }
};

let server;
let port;
let origin;
let dataDir;

before(async () => {
  port = await freePort();
  origin = `http://localhost:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-hub-'));
  const store = new Store(dataDir).load();
  server = new HubServer({ store, port, siteUrl: 'https://peekinside.example', version: 'test', dataDir }).httpServer;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
}

// Raw requests, so Host, Origin and Sec-Fetch-* can be set like a browser (or an attacker) would.
function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { host: `localhost:${port}`, ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (error) {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const SDK = { 'content-type': 'application/json', 'x-peekinside-sdk': 'test' };

test('ingest accepts SDK batches and skips malformed records', async () => {
  const response = await request('POST', '/api/ingest', {
    headers: SDK,
    body: { project: PROJECT, instance: INSTANCE, requests: [RECORD, { ...RECORD, id: '../../etc', method: 'GET' }, { ...RECORD, id: 'x2', status: 999 }] }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { accepted: 1, rejected: 2, acceptedJobs: 0, acceptedLogs: 0 });

  const projects = await request('GET', '/api/projects');
  assert.equal(projects.json.projects[0].name, 'orders-api');
  assert.equal(projects.json.projects[0].online, true);
  assert.equal(projects.json.projects[0].requestCount, 1);
});

test('ingest records counts of server requests the SDK skipped', async () => {
  const response = await request('POST', '/api/ingest', {
    headers: SDK,
    body: {
      project: PROJECT,
      instance: INSTANCE,
      requests: [],
      blocked: [{ kind: 'host', value: 'api.company.com', count: 7 }, { kind: 'nope', value: 'x', count: 1 }, { kind: 'client', value: '', count: 2 }, 'junk']
    }
  });
  assert.equal(response.status, 200, 'malformed entries are ignored, not fatal');
  const project = (await request('GET', '/api/projects')).json.projects.find((item) => item.id === PROJECT.id);
  assert.deepEqual(project.blocked.entries, [{ kind: 'host', value: 'api.company.com', count: 7 }]);
  assert.equal(project.blocked.total, 7);
});

test('ingest refuses browsers and bad input', async () => {
  const body = { project: PROJECT, instance: INSTANCE, requests: [] };
  assert.equal((await request('POST', '/api/ingest', { headers: { ...SDK, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request('POST', '/api/ingest', { headers: { ...SDK, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
  assert.equal((await request('POST', '/api/ingest', { headers: { ...SDK, 'content-type': 'text/plain' }, body })).status, 415);
  assert.equal((await request('POST', '/api/ingest', { headers: { 'content-type': 'application/json' }, body })).status, 400);
  assert.equal((await request('POST', '/api/ingest', { headers: SDK, body: '{not json' })).status, 400);
  assert.equal((await request('POST', '/api/ingest', { headers: SDK, body: { ...body, project: { ...PROJECT, id: '../x' } } })).status, 400);
  assert.equal((await request('GET', '/api/ingest')).status, 405);
});

test('reads requests and details from the same origin', async () => {
  const list = await request('GET', `/api/projects/${PROJECT.id}/requests?limit=10`, {
    headers: { 'sec-fetch-site': 'same-origin' }
  });
  assert.equal(list.status, 200);
  assert.equal(list.json.requests[0].url, '/api/users?x=1');
  assert.equal(list.headers['access-control-allow-origin'], undefined, 'never sends CORS headers');

  const detail = await request('GET', `/api/projects/${PROJECT.id}/requests/${RECORD.id}`);
  assert.equal(detail.json.detail.body, '{"name":"Ada"}');
  assert.equal((await request('GET', `/api/projects/${PROJECT.id}/requests/nope`)).status, 404);
  assert.equal((await request('GET', '/api/projects/unknown-11111111/requests')).status, 404);
  assert.equal((await request('GET', '/api/projects/..%2F..%2Fetc/requests')).status, 404);
});

test('refuses other sites, other localhost ports and foreign Host headers', async () => {
  const listPath = `/api/projects/${PROJECT.id}/requests`;
  assert.equal((await request('GET', listPath, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  // Other ports on localhost are the same "site", but not the same origin.
  assert.equal((await request('GET', listPath, { headers: { 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' } })).status, 403);
  assert.equal((await request('GET', listPath, { headers: { origin: 'http://localhost:3000' } })).status, 403);
  // DNS rebinding: an attacker's domain pointed at 127.0.0.1
  assert.equal((await request('GET', listPath, { headers: { host: `attacker.example:${port}` } })).status, 403);
  assert.equal((await request('GET', '/', { headers: { host: `attacker.example:${port}` } })).status, 403);
});

test('deleting needs this origin', async () => {
  const listPath = `/api/projects/${PROJECT.id}/requests`;
  assert.equal((await request('DELETE', listPath)).status, 403);
  assert.equal((await request('DELETE', listPath, { headers: { origin: 'http://localhost:3000' } })).status, 403);
  const cleared = await request('DELETE', listPath, { headers: { origin, 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(cleared.json, { cleared: true });
  assert.equal((await request('GET', listPath)).json.requests.length, 0);
});

test('serves the dashboard shell with a strict policy', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+' https:\/\/peekinside\.example/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(page.text, /<script src="https:\/\/peekinside\.example\/local\/v1\/app\.js" defer><\/script>/);
  assert.equal(page.headers['cache-control'], 'no-store');

  assert.equal((await request('GET', `/p/${PROJECT.id}`)).status, 200);
  // The approved Span Core mark, one file for each browser theme, served as it is.
  assert.match(page.text, /<link rel="icon" href="\/brand\/peekinside-span-core-mark-light\.svg" type="image\/svg\+xml" media="\(prefers-color-scheme: light\)">/);
  assert.match(page.text, /<link rel="icon" href="\/brand\/peekinside-span-core-mark-dark\.svg" type="image\/svg\+xml" media="\(prefers-color-scheme: dark\)">/);
  for (const file of ['peekinside-span-core-mark-light.svg', 'peekinside-span-core-mark-dark.svg']) {
    const icon = await request('GET', `/brand/${file}`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.equal(icon.text, fs.readFileSync(new URL(`../src/hub/brand/${file}`, import.meta.url), 'utf8'));
  }
  assert.equal((await request('GET', '/favicon.svg')).headers['content-type'], 'image/svg+xml');
  assert.equal((await request('GET', '/brand/other.svg')).status, 404);
  assert.equal((await request('GET', '/secret.txt')).status, 404);
  assert.equal((await request('POST', '/')).status, 405);
});

test('status identifies the hub', async () => {
  const status = await request('GET', '/api/status');
  assert.equal(status.json.app, 'peekinside-hub');
  assert.equal(status.json.apiVersion, 1);
});

test('forgets a project', async () => {
  const removed = await request('DELETE', `/api/projects/${PROJECT.id}`, { headers: { origin } });
  assert.deepEqual(removed.json, { removed: true });
  assert.equal((await request('GET', '/api/projects')).json.projects.length, 0);
});
