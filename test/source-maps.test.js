import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExceptionBuilder } from '../src/exceptions/exception-builder.js';
import { SourceMaps } from '../src/exceptions/source-maps.js';

// What tsc writes for src/orders.ts: the types are gone, so line numbers shift.
const ORIGINAL = `type Order = { id: number };

export function createOrder(order: Order) {
  throw new Error(\`Order \${order.id} failed\`);
}
`;
const COMPILED = `export function createOrder(order) {
    throw new Error(\`Order \${order.id} failed\`);
}
`;
// Generated line -> [generated column, source, original line, original column], all 0-based.
const SEGMENTS = [[[0, 0, 2, 0]], [[4, 0, 3, 2]], [[0, 0, 4, 0]]];

let scratch;
let count = 0;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-maps-'));
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
}

function mappings(lines) {
  let source = 0;
  let line = 0;
  let column = 0;
  return lines
    .map((segments) => {
      let generated = 0;
      return segments
        .map(([g, s, l, c]) => {
          const out = vlq(g - generated) + vlq(s - source) + vlq(l - line) + vlq(c - column);
          [generated, source, line, column] = [g, s, l, c];
          return out;
        })
        .join(',');
    })
    .join(';');
}

// A project folder with a package.json and the given files.
function project(files) {
  const root = path.join(scratch, `app-${++count}`);
  for (const [file, text] of Object.entries({ 'package.json': '{"name":"orders-api","type":"module"}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function map(overrides = {}) {
  return { version: 3, file: 'orders.js', sources: ['../src/orders.ts'], names: [], mappings: mappings(SEGMENTS), ...overrides };
}

async function thrownBy(file) {
  const { createOrder } = await import(pathToFileURL(file).href);
  try {
    createOrder({ id: 42 });
  } catch (error) {
    return error;
  }
  throw new Error('createOrder did not throw');
}

function build(root, error, options = {}) {
  return new ExceptionBuilder({ root, ...options }).build(error, { mechanism: 'report', handled: true, fatal: false, environment: 'test' });
}

test('frames of compiled files point at the source, with its lines from sourcesContent', async () => {
  const root = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map({ sourcesContent: [ORIGINAL] }))
  });
  const record = build(root, await thrownBy(path.join(root, 'dist/orders.js')));
  const [top] = record.detail.frames;

  assert.equal(top.relativeFile, 'src/orders.ts');
  assert.equal(top.line, 4);
  assert.equal(top.column, 3);
  assert.equal(top.function, 'createOrder');
  assert.equal(top.inApp, true);
  assert.deepEqual({ file: top.generated.file, line: top.generated.line }, { file: 'dist/orders.js', line: 2 });
  assert.deepEqual(top.context, { start: 1, lines: ORIGINAL.split('\n').slice(0, 9) });
  assert.deepEqual(record.summary.location, { file: 'src/orders.ts', line: 4, column: 3, function: 'createOrder' });
});

test('the fingerprint follows the source, so a rebuild that moves compiled lines keeps the issue', async () => {
  const first = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map())
  });
  // Same source, compiled with two more lines above it.
  const second = project({
    'dist/orders.js': `"use strict";\n\n${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map({ mappings: mappings([[], [], ...SEGMENTS]) }))
  });
  const a = build(first, await thrownBy(path.join(first, 'dist/orders.js')));
  const b = build(second, await thrownBy(path.join(second, 'dist/orders.js')));
  assert.equal(a.detail.frames[0].line, 4);
  assert.equal(b.detail.frames[0].line, 4);
  assert.equal(a.summary.fingerprint, b.summary.fingerprint);
});

test('without sourcesContent, the source file is read from disk', async () => {
  const root = project({
    'src/orders.ts': ORIGINAL,
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map())
  });
  const [top] = build(root, await thrownBy(path.join(root, 'dist/orders.js'))).detail.frames;
  assert.equal(top.relativeFile, 'src/orders.ts');
  assert.equal(top.context.lines[3], '  throw new Error(`Order ${order.id} failed`);');
});

test('inline maps and hidden maps (no comment, a .map next to the file) are read too', async () => {
  const inline = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map())).toString('base64')}\n`
  });
  const hidden = project({ 'dist/orders.js': COMPILED, 'dist/orders.js.map': JSON.stringify(map()) });
  for (const root of [inline, hidden]) {
    const [top] = build(root, await thrownBy(path.join(root, 'dist/orders.js'))).detail.frames;
    assert.equal(top.relativeFile, 'src/orders.ts');
    assert.equal(top.line, 4);
  }
});

test('bundler URLs resolve from the project folder, and bundled dependencies stay out of the app', async () => {
  const root = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map({ sources: ['webpack://orders-api/./src/orders.ts'] }))
  });
  const [top] = build(root, await thrownBy(path.join(root, 'dist/orders.js'))).detail.frames;
  assert.equal(top.relativeFile, 'src/orders.ts');

  const bundled = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map({ sources: ['../node_modules/order-lib/index.js'] }))
  });
  const [dependency] = build(bundled, await thrownBy(path.join(bundled, 'dist/orders.js'))).detail.frames;
  assert.equal(dependency.inApp, false);
  assert.equal(dependency.module, 'order-lib');
});

test('maps outside the project folder are never read, and sourceMaps: false turns mapping off', async () => {
  // The same map works inside the project, and is refused outside it.
  const root = project({ 'shared/orders.js.map': JSON.stringify(map({ sources: ['../src/orders.ts'] })) });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/orders.js'), `${COMPILED}//# sourceMappingURL=../shared/orders.js.map\n`);
  const [inside] = build(root, await thrownBy(path.join(root, 'dist/orders.js'))).detail.frames;
  assert.equal(inside.relativeFile, 'src/orders.ts');

  const outside = path.join(scratch, 'elsewhere.js.map');
  fs.writeFileSync(outside, JSON.stringify(map()));
  const other = project({});
  fs.mkdirSync(path.join(other, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(other, 'dist/orders.js'), `${COMPILED}//# sourceMappingURL=${path.relative(path.join(other, 'dist'), outside)}\n`);
  const [top] = build(other, await thrownBy(path.join(other, 'dist/orders.js'))).detail.frames;
  assert.equal(top.relativeFile, 'dist/orders.js');
  assert.equal(top.generated, undefined);

  const mapped = project({
    'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`,
    'dist/orders.js.map': JSON.stringify(map())
  });
  const [unmapped] = build(mapped, await thrownBy(path.join(mapped, 'dist/orders.js')), { sourceMaps: false }).detail.frames;
  assert.equal(unmapped.relativeFile, 'dist/orders.js');
  assert.equal(unmapped.line, 2);
});

test('a broken map leaves the frame as it ran', async () => {
  const root = project({ 'dist/orders.js': `${COMPILED}//# sourceMappingURL=orders.js.map\n`, 'dist/orders.js.map': '{ not json' });
  const [top] = build(root, await thrownBy(path.join(root, 'dist/orders.js'))).detail.frames;
  assert.equal(top.relativeFile, 'dist/orders.js');
  assert.equal(top.line, 2);
});

test('mappingUrl reads the last sourceMappingURL comment only', () => {
  assert.equal(SourceMaps.mappingUrl('x();\n//# sourceMappingURL=app.js.map\n'), 'app.js.map');
  assert.equal(SourceMaps.mappingUrl('x();\n//@ sourceMappingURL=old.js.map'), 'old.js.map');
  assert.equal(SourceMaps.mappingUrl('const re = /sourceMappingURL=(.*)/; run(re);\n'), null);
  assert.equal(SourceMaps.mappingUrl(''), null);
});
