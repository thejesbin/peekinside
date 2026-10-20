// The exception model: stack parsing, in-app frames, source context, fingerprints, limits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { SyncSealer } from '../src/crypto.js';
import { ExceptionBuilder } from '../src/exceptions/exception-builder.js';
import { ExceptionCapture } from '../src/exceptions/exception-capture.js';
import { ExceptionRecord } from '../src/exceptions/exception-record.js';
import { Fingerprint } from '../src/exceptions/fingerprint.js';
import { FrameClassifier } from '../src/exceptions/frame-classifier.js';
import { TokenBucket } from '../src/exceptions/rate-limiter.js';
import { RequestContext } from '../src/exceptions/request-context.js';
import { SourceContext } from '../src/exceptions/source-context.js';
import { StackParser } from '../src/exceptions/stack-parser.js';

const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-exceptions-')));
  dirs.push(dir);
  return dir;
}

const BUILD = { mechanism: 'report', handled: true, fatal: false, environment: 'development' };

// An error-like value with a stack of our choosing.
function fakeError(name, message, frames, extra = {}) {
  return { name, message, stack: `${name}: ${message}\n${frames.map((frame) => `    at ${frame}`).join('\n')}`, ...extra };
}

test('parses every V8 frame form', () => {
  const cases = {
    'createOrder (/app/src/orders.js:12:9)': { function: 'createOrder', file: '/app/src/orders.js', line: 12, column: 9, native: false, async: false },
    '/app/src/orders.js:12:9': { function: null, file: '/app/src/orders.js', line: 12, column: 9, native: false, async: false },
    'async createOrder (/app/src/orders.js:12:9)': { function: 'createOrder', file: '/app/src/orders.js', line: 12, column: 9, native: false, async: true },
    'async /app/src/orders.js:3:1': { function: null, file: '/app/src/orders.js', line: 3, column: 1, native: false, async: true },
    'new Order (/app/src/order.js:3:11)': { function: 'new Order', file: '/app/src/order.js', line: 3, column: 11, native: false, async: false },
    'Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)': {
      function: 'Layer.handle [as handle_request]', file: '/app/node_modules/express/lib/router/layer.js', line: 95, column: 5, native: false, async: false
    },
    'file:///app/src/my%20dir/orders.mjs:12:9': { function: null, file: '/app/src/my dir/orders.mjs', line: 12, column: 9, native: false, async: false },
    'Module._compile (node:internal/modules/cjs/loader:1554:14)': {
      function: 'Module._compile', file: 'node:internal/modules/cjs/loader', line: 1554, column: 14, native: false, async: false
    },
    'JSON.parse (<anonymous>)': { function: 'JSON.parse', file: null, line: null, column: null, native: true, async: false },
    'Array.forEach (native)': { function: 'Array.forEach', file: null, line: null, column: null, native: true, async: false },
    'async Promise.all (index 0)': { function: 'Promise.all', file: null, line: null, column: null, native: true, async: true },
    'new Promise (<anonymous>)': { function: 'new Promise', file: null, line: null, column: null, native: true, async: false },
    // Code run by eval() is located where eval() was called, through nested evals too.
    'eval (eval at run (/app/src/x.js:3:5), <anonymous>:1:7)': { function: 'eval', file: '/app/src/x.js', line: 3, column: 5, native: false, async: false },
    'eval (eval at a (eval at b (/app/src/y.js:1:2), <anonymous>:3:4), <anonymous>:5:6)': { function: 'eval', file: '/app/src/y.js', line: 1, column: 2, native: false, async: false },
    'Object.<anonymous> (/Users/me/My App (old)/index.js:1:2)': {
      function: 'Object.<anonymous>', file: '/Users/me/My App (old)/index.js', line: 1, column: 2, native: false, async: false
    },
    'handler (C:\\proj\\src\\a.js:10:5)': { function: 'handler', file: 'C:\\proj\\src\\a.js', line: 10, column: 5, native: false, async: false }
  };
  for (const [line, expected] of Object.entries(cases)) {
    assert.deepEqual(StackParser.parseFrame(line), expected, line);
  }
});

test('reads frames after the message only, top frame first', () => {
  const stack = 'Error: quoted trace\n    at fake (/elsewhere.js:1:1)\n    at real (/app/a.js:2:3)\n    at /app/b.js:4:5';
  const frames = StackParser.parse(stack, { message: 'quoted trace\n    at fake (/elsewhere.js:1:1)' });
  assert.deepEqual(frames.map((frame) => frame.file), ['/app/a.js', '/app/b.js']);
  assert.equal(StackParser.parse(stack, { limit: 2 }).length, 2);
  assert.deepEqual(StackParser.parse('no frames here'), []);
  assert.deepEqual(StackParser.parse(undefined), []);

  // A real stack, from a real file URL (this test is an ES module).
  const real = StackParser.parse(new Error('here').stack);
  assert.equal(real[0].file, new URL(import.meta.url).pathname);
});

test('tells in-app frames from dependencies and Node.js', () => {
  const classifier = new FrameClassifier('/app');
  const classify = (file) => classifier.classify({ function: 'f', file, line: 1, column: 1, native: false, async: false });

  assert.deepEqual(
    (({ relativeFile, inApp, module }) => ({ relativeFile, inApp, module }))(classify('/app/src/orders.js')),
    { relativeFile: 'src/orders.js', inApp: true, module: null }
  );
  const dependency = classify('/app/node_modules/express/lib/router/index.js');
  assert.equal(dependency.inApp, false);
  assert.equal(dependency.module, 'express');
  assert.equal(dependency.relativeFile, 'node_modules/express/lib/router/index.js');
  assert.equal(classify('/app/node_modules/@scope/pkg/dist/x.js').module, '@scope/pkg');
  assert.equal(classify('/app/node_modules/.pnpm/express@4.18.2/node_modules/express/index.js').module, 'express');
  assert.equal(classify('/app/packages/web/node_modules/koa/lib/a.js').inApp, false);
  assert.deepEqual(
    (({ relativeFile, inApp, module }) => ({ relativeFile, inApp, module }))(classify('node:internal/process/task_queues')),
    { relativeFile: null, inApp: false, module: 'node' }
  );
  assert.equal(classify('/elsewhere/lib.js').inApp, false);
  assert.equal(classify('/application/x.js').inApp, false, 'a sibling folder with the same prefix is outside');
  assert.equal(classify('webpack:///./src/x.js').inApp, false);
  assert.equal(classifier.classify({ function: null, file: null, line: null, column: null, native: true, async: false }).inApp, false);
});

test('source context: only the app\'s own files, within limits', () => {
  const root = tempDir();
  const outside = tempDir();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}${i === 9 ? ` ${'x'.repeat(300)}` : ''}`);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), lines.join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'notes.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'big.js'), 'x'.repeat(1024 * 1024 + 1));
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), lines.join('\n'));
  fs.writeFileSync(path.join(outside, 'secret.js'), 'const secret = 1;\n');
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'src', 'link.js'));

  const source = new SourceContext(root);
  const context = source.around(path.join(root, 'src', 'app.js'), 12);
  assert.equal(context.start, 7);
  assert.equal(context.lines.length, 11, '5 lines on each side');
  assert.equal(context.lines[5], 'line 12');
  assert.equal(context.lines[3].length, 240, 'long lines are cut');
  assert.deepEqual(source.around(path.join(root, 'src', 'app.js'), 2).lines.slice(0, 2), ['line 1', 'line 2'], 'clipped at the start');
  assert.equal(source.around(path.join(root, 'src', 'app.js'), 29).lines.length, 7, 'clipped at the end');
  assert.equal(source.around(path.join(root, 'src', 'app.js'), 31), null, 'past the end');
  assert.equal(source.around(path.join(root, 'src', 'notes.txt'), 3), null, 'not a source file');
  assert.equal(source.around(path.join(root, 'src', 'big.js'), 1), null, 'larger than 1 MB');
  assert.equal(source.around(path.join(root, 'node_modules', 'dep', 'index.js'), 3), null, 'a dependency');
  assert.equal(source.around(path.join(outside, 'secret.js'), 1), null, 'outside the project');
  assert.equal(source.around(path.join(root, 'src', 'link.js'), 1), null, 'a symlink out of the project');
  assert.equal(source.around(path.join(root, 'src', 'missing.js'), 1), null);

  // Edits show up; the cache doesn't serve stale lines.
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'changed\nlines here\n');
  assert.deepEqual(source.around(path.join(root, 'src', 'app.js'), 1).lines, ['changed', 'lines here', '']);

  // Only the first five in-app frames get lines.
  const builder = new ExceptionBuilder({ root });
  const file = path.join(root, 'src', 'app.js');
  const frames = Array.from({ length: 8 }, (_, i) => `f${i} (${file}:1:1)`);
  const record = builder.build(fakeError('Error', 'deep', [`dep (${path.join(root, 'node_modules', 'dep', 'index.js')}:1:1)`, ...frames]), BUILD);
  assert.equal(record.detail.frames[0].context, null);
  assert.equal(record.detail.frames.filter((frame) => frame.context).length, 5);
  assert.equal(new ExceptionBuilder({ root, sourceContext: false }).build(fakeError('Error', 'x', frames), BUILD).detail.frames[0].context, null);
});

test('fingerprints ignore line numbers but not functions', () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  const at = (line) => [`createOrder (/app/src/orders.js:${line}:9)`, `handle (/app/src/routes.js:${line + 40}:3)`, 'process (node:internal/x:1:1)'];
  const first = builder.build(fakeError('TypeError', 'Cannot read properties of undefined', at(12)), BUILD);
  const moved = builder.build(fakeError('TypeError', 'Cannot read properties of undefined (reading \'id\')', at(15)), BUILD);
  assert.match(first.summary.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(moved.summary.fingerprint, first.summary.fingerprint, 'same functions, other lines and message');

  const elsewhere = builder.build(fakeError('TypeError', 'Cannot read properties of undefined', ['cancelOrder (/app/src/orders.js:12:9)', ...at(12).slice(1)]), BUILD);
  assert.notEqual(elsewhere.summary.fingerprint, first.summary.fingerprint, 'another function');
  const otherName = builder.build(fakeError('RangeError', 'Cannot read properties of undefined', at(12)), BUILD);
  assert.notEqual(otherName.summary.fingerprint, first.summary.fingerprint, 'another name');

  // The contract's formula, computed independently.
  const basis = 'TypeError\nsrc/orders.js:createOrder\nsrc/routes.js:handle';
  assert.equal(first.summary.fingerprint, createHash('sha256').update(basis).digest('hex').slice(0, 16));

  // Without in-app frames: name, code and the normalized message.
  const external = (message) => builder.build(fakeError('Error', message, ['x (/elsewhere/lib.js:1:1)'], { code: 'E_LOOKUP' }), BUILD).summary.fingerprint;
  assert.equal(external('User 42 not found'), external('User 7 not found'));
  assert.notEqual(external('User 42 not found'), external('Order 42 not found'));
  const noCode = builder.build(fakeError('Error', 'User 42 not found', ['x (/elsewhere/lib.js:1:1)']), BUILD).summary.fingerprint;
  assert.notEqual(noCode, external('User 42 not found'), 'the code is part of it');
});

test('normalizes the variable parts of messages', () => {
  const normalize = Fingerprint.normalizeMessage;
  assert.equal(normalize('User 42 not found'), 'User <num> not found');
  assert.equal(normalize('Order 3f2c9a1e-8b7d-4c6e-9f00-1234567890ab is locked'), 'Order <uuid> is locked');
  assert.equal(normalize('Object 5f1e2d3c4b5a69788796 missing'), 'Object <hex> missing');
  assert.equal(normalize('Unknown column "emial" in \'users\''), 'Unknown column <str> in <str>');
  assert.equal(normalize('Can\'t parse `{x}` at 1.5s'), 'Can\'t parse <str> at <num>s');
  assert.equal(normalize('timeout of 30000ms exceeded'), 'timeout of <num>ms exceeded');
  assert.equal(normalize(undefined), '');
});

test('thrown values that are not errors', () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  const string = builder.build('plain string', BUILD);
  assert.equal(string.summary.name, 'ThrownValue');
  assert.equal(string.summary.message, 'plain string');
  assert.equal(string.detail.stack, 'plain string');
  assert.deepEqual(string.detail.frames, []);
  assert.equal(string.summary.location, null);

  assert.equal(builder.build({ code: 42, nested: { ok: true } }, BUILD).summary.message, '{"code":42,"nested":{"ok":true}}');
  assert.equal(builder.build(null, BUILD).summary.message, 'null');
  assert.equal(builder.build(undefined, BUILD).summary.message, 'undefined');
  assert.equal(builder.build(12n, BUILD).summary.message, '12');
  assert.equal(builder.build(Symbol('s'), BUILD).summary.message, 'Symbol(s)');
  assert.equal(builder.build(function named() {}, BUILD).summary.message, '[Function: named]');

  const circular = { a: 1 };
  circular.self = circular;
  assert.equal(builder.build(circular, BUILD).summary.message, '{"a":1,"self":"[Circular]"}');
  assert.equal(builder.build('y'.repeat(600), BUILD).summary.message.length, 500);

  // Hostile values never make recording throw.
  const hostile = new Proxy({}, { get() { throw new Error('no'); }, ownKeys() { throw new Error('no'); }, getPrototypeOf() { throw new Error('no'); } });
  assert.equal(builder.build(hostile, BUILD).summary.name, 'ThrownValue');
  const trap = new Error('getter');
  Object.defineProperty(trap, 'code', { get() { throw new Error('no'); } });
  assert.equal(builder.build(trap, BUILD).summary.code, null);
  const bare = Object.create(null);
  assert.equal(typeof builder.build(bare, BUILD).summary.message, 'string');
});

test('names, codes and errors from other realms', async () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  class ValidationError extends Error {}
  assert.equal(builder.build(new ValidationError('bad'), BUILD).summary.name, 'ValidationError', 'the class when name is the generic one');
  class NamedError extends Error {
    constructor(message) {
      super(message);
      this.name = 'Custom';
    }
  }
  assert.equal(builder.build(new NamedError('x'), BUILD).summary.name, 'Custom');
  assert.equal(builder.build(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), BUILD).summary.code, 'ECONNREFUSED');
  assert.equal(builder.build(Object.assign(new Error('x'), { code: 404 }), BUILD).summary.code, '404');
  assert.equal(builder.build(Object.assign(new Error('x'), { code: { nope: 1 } }), BUILD).summary.code, null);

  const vm = await import('node:vm');
  const foreign = vm.runInNewContext('new TypeError("from another realm")');
  const record = builder.build(foreign, BUILD);
  assert.equal(record.summary.name, 'TypeError');
  assert.equal(record.summary.message, 'from another realm');
});

test('cause chains and AggregateError', () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  let error = new Error('level 0');
  for (let i = 1; i <= 7; i++) error = new Error(`level ${i}`, { cause: error });
  const chained = builder.build(error, BUILD);
  assert.deepEqual(chained.detail.causes.map((cause) => cause.message), ['level 6', 'level 5', 'level 4', 'level 3', 'level 2'], 'depth 5');
  assert.ok(chained.detail.causes.every((cause) => cause.relation === 'cause'));
  assert.ok(chained.detail.causes[0].frames.length > 0);
  assert.ok(chained.detail.causes[0].frames.every((frame) => frame.context === null));

  const loop = new Error('loop');
  loop.cause = loop;
  assert.equal(builder.build(loop, BUILD).detail.causes.length, 0, 'a cause cycle ends');
  assert.deepEqual(builder.build(new Error('x', { cause: 'just text' }), BUILD).detail.causes[0], {
    relation: 'cause', name: 'ThrownValue', message: 'just text', code: null, stack: 'just text', frames: []
  });

  const aggregate = new AggregateError(Array.from({ length: 12 }, (_, i) => new RangeError(`part ${i}`)), 'all failed', { cause: new Error('root') });
  const record = builder.build(aggregate, BUILD);
  assert.equal(record.summary.name, 'AggregateError');
  assert.deepEqual(record.detail.causes.map((cause) => cause.relation), ['cause', ...Array(10).fill('aggregate')]);
  assert.equal(record.detail.causes[1].name, 'RangeError');
  assert.equal(record.detail.causes[10].message, 'part 9');
});

test('size limits', () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  const big = fakeError('N'.repeat(300), 'm'.repeat(5000), Array.from({ length: 150 }, (_, i) => `f${i} (/app/src/f${i}.js:1:1)`), { code: 'C'.repeat(100) });
  big.stack += `\n${'s'.repeat(40 * 1024)}`;
  const record = builder.build(big, {
    ...BUILD,
    tags: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}${'K'.repeat(80)}`, 'v'.repeat(300)])),
    extra: { blob: 'e'.repeat(20 * 1024) }
  });
  assert.equal(record.summary.name.length, 200);
  assert.equal(record.summary.message.length, 2000);
  assert.equal(record.summary.code.length, 64);
  assert.ok(Buffer.byteLength(record.detail.stack) <= 32 * 1024);
  assert.equal(record.detail.frames.length, 100);
  const tags = Object.entries(record.detail.tags);
  assert.equal(tags.length, 32);
  assert.ok(tags.every(([key, value]) => key.length <= 64 && value.length === 256));
  assert.equal(record.detail.extra.truncated, true);
  assert.ok(Buffer.byteLength(record.detail.extra.preview) <= 2048);
  assert.match(record.detail.extra.preview, /^\{"blob":"eee/);

  // A message of megabytes leaves the frames in the stack and in the frame list.
  const quoting = new Error(`Upstream answered: ${'<html>'.repeat(200_000)}`);
  const quoted = builder.build(quoting, BUILD);
  assert.ok(Buffer.byteLength(quoted.detail.stack) <= 32 * 1024);
  assert.match(quoted.detail.stack, /^Error: Upstream answered: <html>/);
  assert.match(quoted.detail.stack, /\[\.\.\.\]\n[\s\S]*\n {4}at /, 'the end of the stack, with frames, is kept');
  assert.ok(quoted.detail.frames.length > 0);
  assert.equal(quoted.detail.frames[0].file, new URL(import.meta.url).pathname);

  // Long causes: 8 KB of stack, 20 frames.
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  let deep;
  try {
    const recurse = (n) => (n === 0 ? new Error('x'.repeat(9000)) : recurse(n - 1));
    deep = recurse(50);
  } finally {
    Error.stackTraceLimit = saved;
  }
  const cause = builder.build(new Error('outer', { cause: deep }), BUILD).detail.causes[0];
  assert.ok(Buffer.byteLength(cause.stack) <= 8 * 1024);
  assert.equal(cause.frames.length, 20);

  // Small values stay as they are; tags keep only text-like values.
  const small = builder.build(new Error('ok'), { ...BUILD, tags: { plan: 'pro', attempt: 3, ok: true, nested: { no: 1 } }, extra: { orderId: 7, items: [1, 2] } });
  assert.deepEqual(small.detail.tags, { plan: 'pro', attempt: '3', ok: 'true' });
  assert.deepEqual(small.detail.extra, { orderId: 7, items: [1, 2] });
  assert.equal(builder.build(new Error('ok'), BUILD).detail.extra, null);
});

test('the record: plain form, process details and sealed form', async () => {
  const builder = new ExceptionBuilder({ root: '/app' });
  const record = builder.build(new Error('boom'), { ...BUILD, requestId: 'req-1', requestLine: { method: 'GET', path: '/x' } });
  const plain = JSON.parse(JSON.stringify(record));
  assert.deepEqual(Object.keys(plain), ['id', 'occurredAt', 'environment', 'release', 'handled', 'fatal', 'requestId', 'jobRunId', 'summary', 'detail']);
  assert.deepEqual(Object.keys(plain.summary), ['name', 'message', 'code', 'fingerprint', 'mechanism', 'location', 'request']);
  assert.deepEqual(Object.keys(plain.detail), ['stack', 'frames', 'causes', 'request', 'process', 'tags', 'extra']);
  assert.match(plain.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(plain.detail.process.pid, process.pid);
  assert.equal(plain.detail.process.node, process.version);
  assert.equal(typeof plain.detail.process.memory.heapUsed, 'number');
  assert.equal(plain.detail.process.uptime, Math.round(plain.detail.process.uptime * 10) / 10);
  assert.deepEqual(record.link(), { id: record.id, name: 'Error', message: 'boom' });

  // Sealed with the AADs of the contract.
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', publicKey)).toString('base64url');
  const sealed = record.sealSync(SyncSealer.create(raw, 'event'));
  assert.equal(sealed.requestId, 'req-1');
  assert.match(sealed.summary, /^v1\./);
  const summary = JSON.parse(await open(privateKey, raw, sealed.summary, `exception:summary:${record.id}`));
  assert.equal(summary.message, 'boom');
  const detail = JSON.parse(await open(privateKey, raw, sealed.detail, `exception:detail:${record.id}`));
  assert.equal(detail.stack, record.detail.stack);
  await assert.rejects(open(privateKey, raw, sealed.summary, `summary:${record.id}`), 'a request AAD does not open it');
  assert.equal(ExceptionRecord.summaryAad('x'), 'exception:summary:x');
});

// The dashboard's Opener, in a few lines of Web Crypto.
async function open(privateKey, recipient, sealed, aad) {
  const subtle = webcrypto.subtle;
  const [, ephemeral, iv, ciphertext] = sealed.split('.');
  const ephemeralRaw = Buffer.from(ephemeral, 'base64url');
  const ephemeralKey = await subtle.importKey('raw', ephemeralRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ephemeralKey }, privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: Buffer.concat([ephemeralRaw, Buffer.from(recipient, 'base64url')]), info: Buffer.from('peekinside/v1/event') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: Buffer.from(aad) }, key, Buffer.from(ciphertext, 'base64url'));
  return Buffer.from(plaintext).toString('utf8');
}

test('the token bucket allows bursts, then the steady rate', () => {
  let now = 0;
  const bucket = new TokenBucket({ rate: 50, burst: 100, now: () => now });
  let taken = 0;
  while (bucket.take()) taken++;
  assert.equal(taken, 100);
  assert.equal(bucket.dropped, 1);
  now += 100; // 0.1 s: 5 tokens
  taken = 0;
  while (bucket.take()) taken++;
  assert.equal(taken, 5);
  now += 60_000;
  taken = 0;
  while (bucket.take()) taken++;
  assert.equal(taken, 100, 'never more than the burst');
});

test('report() is rate limited and deduplicated per request', () => {
  const queued = [];
  let now = 0;
  const sink = { environment: 'test', disabled: false, enqueueRecord: (record) => queued.push(record), deliverNow() {} };
  const capture = new ExceptionCapture({ root: '/app', isEnabled: () => true, sink: () => sink, limiter: new TokenBucket({ rate: 50, burst: 100, now: () => now }) });

  const ids = Array.from({ length: 150 }, (_, i) => capture.report(new Error(`storm ${i}`)));
  assert.equal(ids.filter(Boolean).length, 100, 'an exception storm is capped');
  assert.equal(queued.length, 100);
  now += 1000;
  assert.ok(capture.report(new Error('after a second')));

  // One error object, reported twice during the same request, is one exception.
  const context = new RequestContext({ capture, req: { method: 'GET', headers: {} }, target: { url: '/a?b=1', pathname: '/a', search: '?b=1' } });
  const error = new Error('twice');
  const first = context.run(() => capture.report(error));
  const second = context.run(() => capture.report(error));
  assert.equal(first, second);
  assert.equal(context.exceptionCount, 1);
  const record = queued[queued.length - 1];
  assert.deepEqual(record.summary.request, { method: 'GET', path: '/a' });
  assert.deepEqual(record.detail.request.query, { b: '1' });

  // Paused: nothing is recorded.
  const paused = new ExceptionCapture({ root: '/app', isEnabled: () => false, sink: () => sink });
  assert.equal(paused.report(new Error('x')), null);
});
