// `npx peekinside mcp`: AI tools read what PeekInside recorded over the Model Context Protocol.
// The protocol itself; the tools on a real local hub and app (errors with their source lines,
// requests and their queries, resolving an issue, replaying a request); the hub's /mcp endpoint;
// the command on stdin and stdout; and PeekInside Cloud with an MCP key, where records arrive
// sealed and are opened here, with a key the server never sees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import PeekInside from '../index.js';
import { DecryptionError, McpKey, Opener, Sealer } from '../src/crypto.js';
import { ExceptionRecord } from '../src/exceptions/exception-record.js';
import { HubClient } from '../src/hub/client.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { McpServer, PROTOCOL_VERSIONS } from '../src/mcp/server.js';
import { bodyText, maskText } from '../src/mcp/format.js';
import { CloudSource, HubSource } from '../src/mcp/sources.js';
import { Toolbox, parseSince } from '../src/mcp/tools.js';
import { RequestRecord } from '../src/record.js';
import { Timeline } from '../src/timeline/timeline.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-mcp-'));
process.env.PEEKINSIDE_HOME = dataDir;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(dataDir).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir });
const hubHost = `127.0.0.1:${hubPort}`;

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

function send(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text, json: /json/.test(res.headers['content-type'] || '') && text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// What a browser-made MCP key holds, and what PeekInside Cloud stores for it: made by the
// dashboard's McpKeys (peekinside-cloud src/lib/e2ee.test.ts holds the same values).
const VECTOR = {
  publicKey: 'BH7DOfIViSZYQ95E7lJWkZ1nDRgaHXVDWiTpaje2qt2HTM6VUeVUdsQKldMzAXzTFPsfdpCevixX5PqxJ1x22No',
  secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  proof: 'qfbPTLyWPQsMv62NflKyj8H0NvDZD_ljxBYTJgWL-vo',
  wrapped: 'm1.AuB4yjLDP-xZgPmt.HuqnNTtrzjTJlSJcFNPNAfBwF-fAjMzOG2zPBgafk6iPUh3ZQ4qfGNZylnpRxqaVfjLr1eMLcPeaeGPkmbLPo_bKWPqXgvgVaIBawDFq8JubB7Zk151iG7eVyux22WNpSFRoTNaR5lA5BDZ26yCg3w42ajbt5hwkul2XOR5gCA1MFdZVRYYkReaeV1s9Dgcu5VCqJr0YUdlJzQ'
};
const KEY_TEXT = `pim1.p0123456789ab.m0123456789abcdef.${VECTOR.secret}`;

test('an MCP key: parsed, proven to the API without its secret, and unwrapping the project key the browser wrapped', async () => {
  const key = McpKey.parse(` "${KEY_TEXT}" `);
  assert.ok(key);
  assert.equal(key.projectId, 'p0123456789ab');
  assert.equal(key.keyId, 'm0123456789abcdef');
  assert.equal(key.bearer(), `pim1.m0123456789abcdef.${VECTOR.proof}`);
  assert.ok(!key.bearer().includes(VECTOR.secret));

  const { privateKey, publicKey } = await key.unwrap(VECTOR.wrapped);
  assert.equal(publicKey, VECTOR.publicKey, 'the public key is worked out from the private key, not taken from the server');
  const sealed = await (await Sealer.create(publicKey, 'event')).seal('{"path":"/orders"}', 'summary:r1');
  const opener = new Opener(privateKey, publicKey, 'event');
  assert.deepEqual(await opener.openJson(sealed, 'summary:r1'), { path: '/orders' });
  await assert.rejects(opener.open(sealed, 'summary:r2'), DecryptionError);

  // Bound to its project and key id, and to its secret.
  await assert.rejects(McpKey.parse(KEY_TEXT.replace('p0123456789ab', 'p0123456789ac')).unwrap(VECTOR.wrapped), DecryptionError);
  await assert.rejects(McpKey.parse(KEY_TEXT.replace('AAECAw', 'AAECAx')).unwrap(VECTOR.wrapped), DecryptionError);
  await assert.rejects(key.unwrap('m1.short.x'), DecryptionError);

  for (const bad of ['', 'pim1.p0123456789ab.m0123456789abcdef', `pim2${KEY_TEXT.slice(4)}`, `${KEY_TEXT}.extra`, 'pik1.p0123456789ab.x.y']) {
    assert.equal(McpKey.parse(bad), null, bad);
  }
  assert.match(McpKey.problem('pik1.p0123456789ab.abc.def'), /API key, which can only send data/);
  assert.match(McpKey.problem('hello'), /not a PeekInside MCP key/);
  assert.match(McpKey.problem('pim1.p0123'), /cut off/);
  assert.ok(!McpKey.problem(KEY_TEXT.slice(0, 40)).includes(KEY_TEXT.slice(20, 40)), 'never repeats the value');
});

test('since: durations, "all", dates', () => {
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(parseSince('30m', '1h', now), now - 30 * 60_000);
  assert.equal(parseSince(undefined, '7d', now), now - 7 * 86_400_000);
  assert.equal(parseSince('2h', '1h', now), now - 2 * 3_600_000);
  assert.equal(parseSince('all', '1h', now), 0);
  assert.equal(parseSince('2026-10-01', '1h', now), Date.UTC(2026, 9, 1));
  assert.throws(() => parseSince('soon', '1h', now), /must look like/);
});

test('credentials in free text are masked: cut-off JSON, forms, multipart, tokens', () => {
  assert.equal(maskText('{"user":"ada","password":"hunter2","note":"ok"'), '{"user":"ada","password":"[masked]","note":"ok"');
  assert.equal(maskText('{"token": "abc'), '{"token": "[masked]"');
  assert.equal(maskText('user=ada&password=hunter2&next=%2Fhome'), 'user=ada&password=[masked]&next=%2Fhome');
  assert.equal(maskText('theme=dark; session_id=xyz'), 'theme=dark; session_id=[masked]');
  assert.equal(
    maskText('--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--b\r\nContent-Disposition: form-data; name="email"\r\n\r\nada@x.io\r\n--b--'),
    '--b\r\nContent-Disposition: form-data; name="password"\r\n\r\n[masked]\r\n--b\r\nContent-Disposition: form-data; name="email"\r\n\r\nada@x.io\r\n--b--'
  );
  assert.equal(maskText('sent Authorization: Bearer abcdefghijkl12345 upstream'), 'sent Authorization: Bearer [masked] upstream');
  assert.equal(maskText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln here'), 'jwt [masked] here');
  assert.equal(maskText('GET /users?id=4 failed: 404'), 'GET /users?id=4 failed: 404', 'nothing else changes');
  // A JSON body PeekInside kept only the start of doesn't parse, and is masked as text.
  assert.match(bodyText('{"password":"hunter2","items":[1,2', 'utf8', 4096, true), /^\{"password":"\[masked\]","items":\[1,2\n\(PeekInside kept only the start/);
});

test('the protocol: initialize, ping, tools, notifications, and JSON-RPC errors', async () => {
  const calls = [];
  const toolbox = {
    definitions: async () => [{ name: 'list_errors', inputSchema: { type: 'object', properties: {} } }],
    has: (name) => name === 'list_errors',
    call: async (name, args) => {
      calls.push({ name, args });
      return { text: 'No errors.', isError: false };
    }
  };
  const server = new McpServer({ toolbox, version: '9.9.9' });

  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18', 'a version both know is kept');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(init.result.serverInfo, { name: 'peekinside', title: 'PeekInside', version: '9.9.9' });
  assert.match(init.result.instructions, /list_errors/);
  const newer = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(newer.result.protocolVersion, PROTOCOL_VERSIONS[0], 'an unknown one gets the newest this server knows');

  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools[0].name, 'list_errors');

  const call = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_errors', arguments: { since: '1h' } } });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: 'No errors.' }], isError: false });
  assert.deepEqual(calls, [{ name: 'list_errors', args: { since: '1h' } }]);

  assert.equal((await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'drop_tables' } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_errors', arguments: [1] } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 7, method: 'sampling/createMessage' })).error.code, -32601);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).result, { resources: [] });
  assert.equal((await server.handle({ id: 9, method: 'ping' })).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, -32600);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 10, result: {} }), null, "a client's answer needs none");

  const batch = await server.handle([{ jsonrpc: '2.0', id: 11, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]);
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 11, result: {} }]);
});

// An app on this machine with PeekInside, and what it records, read back through the tools.
async function localApp() {
  const name = 'mcp-shop';
  const app = express();
  // Express prints the errors it answers with a 500 unless it runs as a test.
  app.set('env', 'test');
  app.use(express.json());
  const peekInside = PeekInside.attach(app, { project: name, local: true });
  app.get('/orders', (req, res) => {
    const timeline = Timeline.current();
    for (let id = 1; id <= 6; id++) timeline.query({ system: 'postgresql', client: 'pg', text: 'select * from users where id = $1', params: [id] }).end({ rows: 1 });
    timeline.query({ system: 'postgresql', client: 'pg', text: 'select * from orders' }).end({ rows: 6 });
    res.json({ orders: 6 });
  });
  app.post('/checkout', (req, res) => {
    const cart = req.body.cart;
    res.status(201).json({ total: cart.items.length });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const call = (method, target, body) => send(port, {
    method,
    path: target,
    headers: { host: `localhost:${port}`, 'content-type': 'application/json', authorization: 'Bearer live-token', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
    body
  });
  return { name, peekInside, server, port, call };
}

async function recorded(peekInside, name, ready) {
  for (let i = 0; i < 200; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project && ready(project)) return project;
    await pause(25);
  }
  assert.fail(`timed out waiting for ${name}`);
}

test('local tools: errors with source lines and their request, queries, resolving, replaying', async () => {
  const shop = await localApp();
  try {
    assert.equal((await shop.call('GET', '/orders')).status, 200);
    assert.equal((await shop.call('POST', '/checkout?coupon=SPRING&token=tok_live_123', JSON.stringify({ cart: {}, password: 'hunter2' }))).status, 500);
    const project = await recorded(shop.peekInside, shop.name, (item) => item.requestCount === 2 && item.exceptionCount === 1 && item.online);

    const box = new Toolbox({ source: new HubSource(new HubClient(hubPort)), cwd: ROOT });
    const run = async (name, args = {}) => {
      const result = await box.call(name, args);
      assert.equal(result.isError, false, `${name}: ${result.text}`);
      return result.text;
    };

    const projects = await run('list_projects');
    assert.match(projects, new RegExp(`● ${shop.name} \\(id ${project.id}\\)`));
    assert.match(projects, /this folder's project, the default/);

    const errors = await run('list_errors');
    assert.match(errors, /1 unresolved issue in the last 7d/);
    assert.match(errors, /TypeError: Cannot read properties of undefined \(reading 'length'\)/);
    assert.match(errors, /POST \/checkout/);
    const issue = /issue ([0-9a-f]{16})/.exec(errors)[1];
    const exceptionId = /latest exception (\S+)/.exec(errors)[1];

    const error = await run('get_error', { id: issue });
    assert.match(error, /^# TypeError: Cannot read properties of undefined/);
    assert.match(error, new RegExp(`Issue ${issue}: unresolved, unhandled; 1 time`));
    assert.match(error, /▶ \S+ +test\/mcp\.test\.js:\d+:\d+/, "the app's own frame, marked");
    assert.match(error, /→ +\d+ │ +res\.status\(201\)\.json\(\{ total: cart\.items\.length \}\);/, 'with the line that threw');
    assert.match(error, /The request: POST \/checkout\?coupon=SPRING&token=\[masked\] → 500/);
    assert.match(error, /"password": "\[masked\]"/, 'the body, with credentials masked');
    assert.ok(!error.includes('hunter2'));
    assert.match(error, new RegExp(`/p/${project.id}/exceptions\\?exception=${exceptionId}`));
    assert.equal(await run('get_error', { id: exceptionId }), error, 'an exception id reads the same');

    const failed = await run('list_requests', { status: '5xx' });
    assert.match(failed, /^1 request in the last 1h \(status 5xx\), of 2 requests recorded/);
    const requestId = /\(id (\S+)\)/.exec(failed)[1];
    const request = await run('get_request', { id: requestId });
    assert.match(request, /^# POST \/checkout → 500 Internal Server Error/);
    assert.match(request, /authorization: \[masked\]/);
    assert.match(request, /URL: \/checkout\?coupon=SPRING&token=\[masked\]/);
    assert.ok(!request.includes('live-token') && !request.includes('tok_live_123') && !error.includes('tok_live_123'));
    assert.match(request, /Exceptions \(1\):\n {2}TypeError/);

    const slow = await run('list_requests', { has: 'n+1' });
    assert.match(slow, /GET \/orders → 200 .*7 queries \(N\+1\)/);
    const orders = await run('get_request', { id: /\(id (\S+)\)/.exec(slow)[1] });
    assert.match(orders, /Database: 7 queries in .* \(1 N\+1 pattern\)/);
    assert.match(orders, /1\. ×6, .* \[N\+1\] postgresql via pg\n {5}select \* from users where id = \$1/);
    assert.match(orders, /parameters, e\.g\.: \[1\]/);

    const queries = await run('list_queries');
    assert.match(queries, /1\. N\+1 in 1 request · ran 6 times in 1 request/);
    assert.match(queries, /routes: GET \/orders \(1\)/);

    assert.match(await run('resolve_error', { id: exceptionId }), new RegExp(`Issue ${issue} \\(TypeError: .*\\) is resolved`));
    assert.match(await run('list_errors'), /No unresolved errors in the last 7d \(1 issue in all\)/);
    assert.match(await run('list_errors', { status: 'resolved' }), new RegExp(`issue ${issue} · resolved`));
    assert.match(await run('resolve_error', { id: issue, reopen: true }), /unresolved again/);
    assert.match(await run('list_errors'), /1 unresolved issue/);

    const definitions = Object.fromEntries((await box.definitions()).map((tool) => [tool.name, tool.annotations]));
    assert.deepEqual(definitions.list_errors, { title: 'List errors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(definitions.replay_request.destructiveHint, true, 'replaying sends a POST again: AI tools should ask');
    assert.equal(definitions.replay_request.idempotentHint, false);
    assert.equal(definitions.resolve_error.readOnlyHint, false);

    const replay = await run('replay_request', { id: requestId });
    assert.match(replay, /the app answered 500 Internal Server Error/);
    assert.match(replay, /The replay is request \S+: 1 exception/);

    // Mistakes are answers, for the AI tool to correct.
    const wrong = await box.call('get_request', { id: 'nope/../x' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /isn't a request id/);
    assert.match((await box.call('list_requests', { status: 'teapot' })).text, /"status" must be/);
    assert.match((await box.call('list_errors', { project: 'elsewhere' })).text, /There's no project "elsewhere"/);
    assert.match((await box.call('drop_tables')).text, /no tool called drop_tables/);

    // The hub's own /mcp, for AI tools that connect by URL.
    const mcp = (body, headers = {}) => send(hubPort, { method: 'POST', path: `/mcp?project=${project.id}`, headers: { host: hubHost, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(listed.status, 200);
    assert.ok(listed.json.result.tools.some((tool) => tool.name === 'replay_request'));
    const called = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_errors', arguments: {} } });
    assert.match(called.json.result.content[0].text, /TypeError/);
    assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await mcp({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' })).status, 403, 'not for other sites');
    assert.equal((await send(hubPort, { method: 'GET', path: '/mcp', headers: { host: hubHost } })).status, 405);
    assert.equal((await send(hubPort, { method: 'POST', path: '/mcp', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await send(hubPort, { method: 'POST', path: '/mcp', headers: { host: hubHost, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  } finally {
    shop.peekInside.stop();
    shop.server.close();
  }
});

test("the command speaks MCP on stdin and stdout, and nothing else, whatever the folder's .env says", async () => {
  // A cloned repository's .env that would send the key elsewhere: the command reads none of it.
  const asked = [];
  const elsewhere = http.createServer((req, res) => {
    asked.push(req.url);
    res.end('{}');
  });
  const elsewherePort = await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', () => resolve(elsewhere.address().port)));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-mcp-repo-'));
  fs.writeFileSync(path.join(folder, '.env'), `PEEKINSIDE_MCP_KEY=${KEY_TEXT}\nPEEKINSIDE_URL=http://127.0.0.1:${elsewherePort}\n`);
  const env = { ...process.env };
  delete env.PEEKINSIDE_MCP_KEY;
  delete env.PEEKINSIDE_URL;
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'peekinside.js'), 'mcp'], { cwd: folder, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const lines = () => stdout.split('\n').filter(Boolean);
  const answered = async (count) => {
    for (let i = 0; i < 200 && lines().length < count; i++) await pause(25);
    return lines().map((line) => JSON.parse(line));
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write('this is not json\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })}\n`);
  const answers = await answered(3);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('exit', resolve));

  assert.equal(code, 0, 'it exits when the AI tool closes its input');
  assert.equal(answers.length, 3, stdout);
  assert.equal(answers.find((answer) => answer.id === 1).result.protocolVersion, '2025-03-26');
  assert.equal(answers.find((answer) => answer.id === null).error.code, -32700);
  assert.match(answers.find((answer) => answer.id === 2).result.content[0].text, /Projects in PeekInside Local/, 'the local dashboard: the .env named no key for it');
  assert.deepEqual(asked, [], 'nothing went to the address the .env named');
  elsewhere.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

test('records that arrived late (sent after an outage) are still read', async () => {
  const now = Date.UTC(2026, 9, 26, 12);
  const minutes = (count) => now - count * 60_000;
  // Newest by arrival first: the first page ends with a line written three hours ago and sent late.
  const pages = [
    [{ seq: 9, id: 'l9', occurredAt: minutes(1), level: 'error', message: 'payment failed' }, { seq: 8, id: 'l8', occurredAt: minutes(180), level: 'info', message: 'spooled, sent late' }],
    [{ seq: 7, id: 'l7', occurredAt: minutes(20), level: 'warn', message: 'retrying the charge' }, { seq: 6, id: 'l6', occurredAt: minutes(40), level: 'info', message: 'checkout started' }],
    [{ seq: 5, id: 'l5', occurredAt: minutes(300), level: 'info', message: 'boot' }]
  ];
  const asked = [];
  const source = {
    cloud: false,
    dashboardUrl: 'http://localhost:7335',
    projects: async () => [{ id: 'shop', name: 'shop', root: ROOT }],
    page: async (projectId, kind, { before }) => {
      asked.push(before);
      const index = before === undefined ? 0 : pages.findIndex((page) => page[0].seq < before);
      return { items: pages[index] ?? [], hasMore: index < pages.length - 1 };
    }
  };
  const box = new Toolbox({ source, cwd: ROOT, now: () => now });
  const logs = await box.call('list_logs', { since: '1h' });
  assert.equal(logs.isError, false, logs.text);
  assert.match(logs.text, /^3 log lines in the last 1h/);
  assert.match(logs.text, /retrying the charge/);
  assert.match(logs.text, /checkout started/);
  assert.ok(!logs.text.includes('Only the newest'), 'the window was read to its start');
  assert.deepEqual(asked, [undefined, 8, 6], 'and it stopped once a whole page was older');
});

// PeekInside Cloud as the CLI sees it: the API's routes, with records sealed to the project key.
async function cloudApi({ answerSession = true } = {}) {
  const projectId = 'p0123456789ab';
  const now = Date.now();
  const sealer = await Sealer.create(VECTOR.publicKey, 'event');
  const request = new RequestRecord({
    id: '11111111-1111-4111-8111-111111111111',
    occurredAt: now - 60_000,
    environment: 'production',
    method: 'POST',
    status: 500,
    duration: 87,
    requestSize: 20,
    responseSize: 30,
    aborted: false,
    exceptionCount: 1,
    stats: { queries: 1, queryTime: 3, slowQueries: 0, nPlusOne: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0, loopBlock: 0 },
    summary: { url: 'https://shop.example/pay?card=4242', path: '/pay', contentType: 'application/json', route: '/pay' },
    detail: { headers: { cookie: 'sid=1', 'content-type': 'application/json' }, body: '{"amount":5}', bodyEncoding: 'utf8', bodySize: 12, response: { statusMessage: 'Internal Server Error', headers: {} }, exceptions: [] }
  });
  const exception = new ExceptionRecord({
    id: '22222222-2222-4222-8222-222222222222',
    occurredAt: now - 60_000,
    environment: 'production',
    release: 'v42',
    handled: false,
    fatal: false,
    requestId: request.id,
    summary: { name: 'PaymentError', message: 'card declined', fingerprint: '0123456789abcdef', mechanism: 'express', location: { file: 'src/pay.js', line: 9, function: 'charge' }, request: { method: 'POST', path: '/pay' } },
    detail: { stack: 'PaymentError: card declined', frames: [{ function: 'charge', file: '/srv/src/pay.js', relativeFile: 'src/pay.js', line: 9, column: 5, inApp: true, context: { start: 8, lines: ['async function charge(card) {', "  throw new PaymentError('card declined');", '}'] } }], causes: [] }
  });
  const sealedRequest = await request.seal(sealer);
  const sealedException = await exception.seal(sealer);
  const state = { sealed: null, version: 0 };
  const seen = [];

  const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams, origin } = new URL(url);
    seen.push({ method: init.method, pathname, origin, authorization: init.headers.authorization, redirect: init.redirect });
    if (origin === 'https://cloud.example') return new Response(null, { status: 308, headers: { location: `https://www.cloud.example${pathname}${searchParams.size ? `?${searchParams}` : ''}` } });
    if (init.headers.authorization !== `Bearer pim1.m0123456789abcdef.${VECTOR.proof}`) return reply(401, { error: 'Sign in to continue' });
    const base = `/api/projects/${projectId}`;
    if (pathname === '/api/mcp/session') {
      if (!answerSession) return reply(401, { error: 'This MCP key was revoked, or never existed.' });
      return reply(200, { key: { id: 'm0123456789abcdef', name: 'Laptop' }, project: { id: projectId, name: 'Shop' }, organization: { id: 'oacme00000000', name: 'Acme', slug: 'acme' }, wrappedKey: VECTOR.wrapped, permissions: ['requests:read', 'exceptions:read', 'exceptions:resolve'], dashboardUrl: 'https://www.cloud.example/acme/projects/p0123456789ab' });
    }
    if (pathname === `${base}/events`) return reply(200, { events: [{ ...sealedRequest, seq: 7 }], hasMore: false });
    if (pathname === `${base}/events/${request.id}`) return reply(200, { id: request.id, detail: sealedRequest.detail });
    if (pathname === `${base}/records/request/${request.id}`) return reply(200, { record: { ...sealedRequest, seq: 7, detail: undefined } });
    if (pathname === `${base}/exceptions`) return reply(200, { exceptions: [{ ...sealedException, seq: 3, detail: undefined }], hasMore: false });
    if (pathname === `${base}/exceptions/${exception.id}`) return reply(200, { id: exception.id, detail: sealedException.detail });
    if (pathname === `${base}/exception-state` && init.method === 'GET') return reply(200, state);
    if (pathname === `${base}/exception-state` && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (body.version !== state.version) return reply(409, { error: 'Someone else changed this first.', ...state });
      state.sealed = body.sealed;
      state.version++;
      return reply(200, { version: state.version });
    }
    return reply(404, { error: 'Not found' });
  };
  return { fetch, seen, state, request, exception };
}

test('PeekInside Cloud: records arrive sealed and are opened here, with the key the browser wrapped', async () => {
  const api = await cloudApi();
  const source = new CloudSource({ key: McpKey.parse(KEY_TEXT), siteUrl: 'https://cloud.example', fetch: api.fetch });
  const box = new Toolbox({ source, cwd: ROOT });
  const run = async (name, args = {}) => {
    const result = await box.call(name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    return result.text;
  };

  // Only what the key's member may use: no replay, no dumps, nothing their role doesn't read.
  const tools = (await box.definitions()).map((tool) => tool.name);
  assert.deepEqual(tools, ['list_projects', 'list_errors', 'get_error', 'resolve_error', 'list_requests', 'get_request', 'list_queries']);
  assert.ok((await box.definitions()).every((tool) => !('project' in tool.inputSchema.properties)), 'the key names its project');

  assert.match(await run('list_projects'), /PeekInside Cloud project: Shop \(id p0123456789ab\), in Acme/);
  const errors = await run('list_errors');
  assert.match(errors, /PaymentError: card declined/);
  assert.match(errors, /issue 0123456789abcdef/);
  const error = await run('get_error', { id: '0123456789abcdef' });
  assert.match(error, /→ +9 │ {3}throw new PaymentError\('card declined'\);/);
  assert.match(error, /The request: POST https:\/\/shop\.example\/pay\?card=4242 → 500/);
  assert.match(error, /https:\/\/www\.cloud\.example\/acme\/projects\/p0123456789ab\/exceptions\?exception=22222222/);
  const request = await run('get_request', { id: api.request.id });
  assert.match(request, /cookie: \[masked\]/);
  assert.match(request, /"amount": 5/);

  // Resolving seals the state to the project key, as the dashboard does.
  assert.match(await run('resolve_error', { id: '0123456789abcdef' }), /is resolved/);
  const { privateKey, publicKey } = await McpKey.parse(KEY_TEXT).unwrap(VECTOR.wrapped);
  const resolved = await new Opener(privateKey, publicKey, 'event').openJson(api.state.sealed, 'exception-state:p0123456789ab');
  assert.ok(resolved.resolved['0123456789abcdef'] > 0);
  assert.match(await run('list_errors'), /No unresolved errors/);

  // Every request carries the proof, never the secret; the www twin it was sent to is kept.
  assert.ok(api.seen.every((call) => call.redirect === 'manual' && !String(call.authorization).includes(VECTOR.secret)));
  assert.equal(api.seen.filter((call) => call.origin === 'https://cloud.example').length, 1, 'redirected once, then remembered');
});

test('PeekInside Cloud: a key that no longer works says why, in every tool', async () => {
  const api = await cloudApi({ answerSession: false });
  const box = new Toolbox({ source: new CloudSource({ key: McpKey.parse(KEY_TEXT), siteUrl: 'https://www.cloud.example', fetch: api.fetch }) });
  const result = await box.call('list_errors');
  assert.equal(result.isError, true);
  assert.match(result.text, /doesn't accept this MCP key: it was revoked, or the member who made it left/);
  assert.equal((await box.definitions()).length, 11, "every Cloud tool is listed while the key can't be checked");

  const wrongSecret = McpKey.parse(`pim1.p0123456789ab.m0123456789abcdef.${'B'.repeat(43)}`);
  const other = await cloudApi();
  // The API checks the proof first; this one passes the stand-in, then fails to unwrap.
  const fetch = (url, init) => other.fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer pim1.m0123456789abcdef.${VECTOR.proof}` } });
  const locked = await new Toolbox({ source: new CloudSource({ key: wrongSecret, siteUrl: 'https://www.cloud.example', fetch }) }).call('list_projects');
  assert.match(locked.text, /no longer opens the project's records/);
});
