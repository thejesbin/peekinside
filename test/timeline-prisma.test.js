// Prisma's integration, with a stand-in client shaped like Prisma Client's internals (_request,
// _engineConfig, _activeProvider, the call site it captures). Real Prisma 6 and 7 clients were
// checked against PostgreSQL outside this suite; Prisma isn't a dependency of this package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContext } from '../src/exceptions/request-context.js';
import { Operation } from '../src/instrumentation/operation.js';
import { PrismaInstrumentation } from '../src/instrumentation/prisma.js';
import { Timeline, TimelineSettings } from '../src/timeline/timeline.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// What Prisma does with a call: runs it later (its promise is lazy), with the call site it captured
// when the app made the call.
class FakePrismaClient {
  constructor({ adapter = null, provider = 'postgresql', driver = null } = {}) {
    this._engineConfig = { adapter };
    this._activeProvider = provider;
    this._driver = driver;
  }

  async _request(params) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // With an adapter, the driver runs the SQL (and the pg integration records it).
    if (this._driver) this._driver();
    if (params.action === 'create' && params.args.data.email === 'taken@x.io') {
      throw Object.assign(new Error('\nInvalid `prisma.user.create()` invocation:\n\n\nUnique constraint failed'), { code: 'P2002' });
    }
    if (params.action === 'findMany') return [{ id: 1 }, { id: 2 }];
    if (params.action === 'queryRaw') return [{ id: 7 }];
    return { id: 1 };
  }

  // prisma.user.findMany(args): the call site is captured here, in the app's frame.
  user(action, args) {
    const callsite = { _error: new Error() };
    return this._request({ model: 'User', action, args, clientMethod: `user.${action}`, callsite });
  }
}
PrismaInstrumentation.patch(FakePrismaClient);

async function inRequest(fn) {
  const context = new RequestContext({ capture: null, req: { method: 'GET', headers: {} }, target: { url: '/p', pathname: '/p', search: '' } });
  context.timeline = new Timeline(new TimelineSettings({}, ROOT));
  await context.run(fn);
  return context.timeline.close();
}

test('Prisma with the query engine: one span per operation, its arguments masked, its caller', async () => {
  const prisma = new FakePrismaClient();
  const { stats, timeline } = await inRequest(async () => {
    await prisma.user('findMany', { where: { email: { contains: '@' } }, include: { posts: true } });
    await prisma.user('create', { data: { email: 'new@x.io', password: 'hunter2' } });
    await prisma.user('create', { data: { email: 'taken@x.io', password: 'x' } }).catch(() => {});
    await prisma._request({ action: 'queryRaw', clientMethod: '$queryRaw', args: { text: 'SELECT id FROM "User" WHERE id = $1', sql: 'SELECT id FROM "User" WHERE id = ?', values: [7] } });
  });
  assert.equal(stats.queries, 4);
  assert.deepEqual(timeline.statements.map((statement) => [statement.system, statement.client, statement.text, statement.count]), [
    ['postgresql', 'prisma', 'User.findMany({ where: { email: { contains: ? } }, include: { posts: ? } })', 1],
    ['postgresql', 'prisma', 'User.create({ data: { email: ?, password: ? } })', 2],
    ['postgresql', 'prisma', 'SELECT id FROM "User" WHERE id = $1', 1]
  ]);
  assert.equal(timeline.statements[0].caller.relativeFile, 'test/timeline-prisma.test.js', 'from the call site Prisma captured');
  assert.equal(timeline.statements[2].caller, null, 'raw queries capture their call site too late');
  const [findMany, created, failed, raw] = timeline.spans;
  assert.deepEqual(findMany.params, { where: { email: { contains: '@' } }, include: { posts: true } });
  assert.equal(findMany.rows, 2);
  assert.deepEqual(created.params, { data: { email: 'new@x.io', password: '[masked]' } });
  assert.equal(created.rows, 1);
  assert.equal(failed.error, 'P2002: Invalid `prisma.user.create()` invocation:\nUnique constraint failed');
  assert.deepEqual(raw.params, [7]);
});

test('Prisma with a driver adapter: the driver\'s queries carry the operation; none is counted twice', async () => {
  // As the pg integration does inside an operation.
  const driver = () => {
    const timeline = Timeline.current();
    timeline.query({ system: 'postgresql', client: 'pg', text: 'SELECT "id" FROM "User" OFFSET $1', params: [0], operation: Operation.noteQuery() }).end({ rows: 2 });
  };
  const prisma = new FakePrismaClient({ adapter: {}, driver });
  const { stats, timeline } = await inRequest(() => prisma.user('findMany', { take: 2 }));
  assert.equal(stats.queries, 1);
  assert.equal(timeline.statements[0].client, 'pg');
  assert.equal(timeline.spans[0].operation, 'User.findMany');
  assert.match(timeline.statements[0].caller.function, /\buser$/, 'where the app made the Prisma call, not where the driver ran');
});

test('Prisma 6 with a driver adapter runs it out of the request\'s reach: the operation is recorded instead', async () => {
  // The WASM engine calls the adapter from its own context: no query is seen for the operation.
  const prisma = new FakePrismaClient({ adapter: {} });
  const { stats, timeline } = await inRequest(async () => {
    const pending = prisma.user('findMany', { where: { id: 1 } });
    Timeline.current().log('info', 'logged while the operation runs');
    await pending;
  });
  assert.equal(stats.queries, 1);
  assert.equal(timeline.statements[0].text, 'User.findMany({ where: { id: ? } })');
  assert.equal(timeline.statements[0].client, 'prisma');
  assert.deepEqual(timeline.spans.map((span) => span.type), ['query', 'log'], 'ordered by start, though recorded last');
  assert.ok(timeline.spans[0].duration >= 4);
});

test('Prisma arguments that can\'t be read: the call runs unrecorded', async () => {
  const { proxy: unreadable, revoke } = Proxy.revocable({}, {});
  revoke();
  const prisma = new FakePrismaClient();
  let value;
  const { stats } = await inRequest(async () => {
    value = await prisma.user('findMany', unreadable);
  });
  assert.deepEqual(value, [{ id: 1 }, { id: 2 }]);
  assert.equal(stats.queries, 0);
});
