// The timeline's building blocks: SQL normalization and masking, value rules, shapes, and the
// timeline itself (statements, N+1, duplicates, caps, budget, closing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RequestContext } from '../src/exceptions/request-context.js';
import { MongoInstrumentation } from '../src/instrumentation/mongodb.js';
import { ExecutionHash } from '../src/timeline/execution-hash.js';
import { Caller } from '../src/timeline/caller.js';
import { Masker } from '../src/timeline/masking.js';
import { Shape } from '../src/timeline/shape.js';
import { SqlText } from '../src/timeline/sql.js';
import { Timeline, TimelineSettings } from '../src/timeline/timeline.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const settings = (options = {}) => new TimelineSettings(options, ROOT);

test('normalizes statements: values, placeholders, lists, whitespace and case', () => {
  const normalize = (text, dialect) => SqlText.normalize(text, dialect);
  assert.equal(normalize("SELECT * FROM users WHERE email = 'ada@x.io' AND age > 42"), 'select * from users where email = ? and age > ?');
  assert.equal(normalize('select * from users where id = $1'), 'select * from users where id = ?');
  assert.equal(normalize('select * from users where id = ?', 'mysql'), 'select * from users where id = ?');
  assert.equal(normalize('SELECT  *\n  FROM users\tWHERE id IN ($1, $2, $3)'), 'select * from users where id in (?)');
  assert.equal(normalize('select * from t where id in (1,2,3)'), 'select * from t where id in (?)');
  assert.equal(normalize('insert into t (a, b) values ($1, $2), ($3, $4), ($5, $6)'), 'insert into t (a, b) values (?)');
  assert.equal(normalize('INSERT INTO t (a, b) VALUES (?, ?)', 'mysql'), 'insert into t (a, b) values (?)');
  // Quoted identifiers keep their case; words outside them are lowercased.
  assert.equal(normalize('SELECT "User"."emailAddress" FROM "User" WHERE "User"."id" = $1'), 'select "User"."emailAddress" from "User" where "User"."id" = ?');
  assert.equal(normalize('SELECT `User`.`Name` FROM `User`', 'mysql'), 'select `User`.`Name` from `User`');
  // Comments (sqlcommenter tags with trace ids) don't split statements.
  assert.equal(normalize("select 1 /* traceparent='00-abc-def-01' */"), 'select ?');
  assert.equal(normalize('select a -- the first column\nfrom t'), 'select a from t');
  // Identifiers with digits stay; PostgreSQL's dollar-quoted and E'' strings are values.
  assert.equal(normalize('select t1.c2 from t1 where x = $$it\'s$$ and y = E\'a\\\'b\''), 'select t1.c2 from t1 where x = ? and y = ?');
  // In PostgreSQL ? is the jsonb operator, not a placeholder.
  assert.equal(normalize("select * from t where data ? 'key'"), 'select * from t where data ? ?');

  const fingerprint = (text, dialect = 'postgresql') => new SqlText().analyze(text, dialect).fingerprint;
  assert.match(fingerprint('select 1'), /^[0-9a-f]{16}$/);
  assert.equal(fingerprint('select 1'), createHash('sha256').update('select ?').digest('hex').slice(0, 16));
  assert.equal(fingerprint("select * from users where id = 1"), fingerprint('SELECT * FROM users WHERE id = 2'));
  assert.notEqual(fingerprint('select * from users where id = 1'), fingerprint('select * from orders where id = 1'));
});

test('binds placeholders to the columns they are compared with or assigned to', () => {
  const sql = new SqlText();
  const columns = (text, dialect = 'postgresql') => Object.fromEntries(sql.analyze(text, dialect).columns);
  const sensitive = (text, dialect = 'postgresql') => [...sql.analyze(text, dialect).sensitive].sort();

  assert.deepEqual(columns('select * from users where email = $1 and password <> $2 and age >= $3'), { 0: 'email', 1: 'password', 2: 'age' });
  assert.deepEqual(columns('select * from users where name like $1 or name ilike $2 or name not like $3'), { 0: 'name', 1: 'name', 2: 'name' });
  assert.deepEqual(columns('select * from users where id in ($1, $2) and token not in ($3)'), { 0: 'id', 1: 'id', 2: 'token' });
  assert.deepEqual(columns('select * from users where id = any($1)'), { 0: 'id' });
  assert.deepEqual(columns('select * from users where $1 = api_key'), { 0: 'api_key' });
  // Quoted identifiers and table prefixes
  assert.deepEqual(sensitive('select * from "User" where "User"."password" = $1 and u.session_id = $2 and "email" = $3'), [0, 1]);
  assert.deepEqual(sensitive('select * from `users` where `users`.`password` = ? and `name` = ?', 'mysql'), [0]);
  assert.deepEqual(sensitive('select * from users where password::text = $1'), [0]);
  // insert column lists, also multi-row, and set lists
  assert.deepEqual(columns('insert into users (email, password, age) values ($1, $2, $3)'), { 0: 'email', 1: 'password', 2: 'age' });
  assert.deepEqual(sensitive('INSERT INTO users (email, password) VALUES (?, ?), (?, ?)', 'mysql'), [1, 3]);
  assert.deepEqual(sensitive('insert into "User" ("email","password") values ($1, lower($2))'), [1]);
  assert.deepEqual(sensitive('update users set password = $1, name = $2 where id = $3'), [0]);
  assert.deepEqual(sensitive('UPDATE users SET `refresh_token` = ?, name = ? WHERE id = ?', 'mysql'), [0]);
  // A parameter used twice is sensitive when either use is.
  assert.deepEqual(sensitive('select * from users where name = $1 or password = $1'), [0]);
  // Placeholders inside string literals or comments are not placeholders.
  assert.deepEqual(columns("select * from users where note = 'is ? or $1' and email = $1"), { 0: 'email' });
  assert.deepEqual(columns('select * from t where a = ? /* b = ? */ and password = ?', 'mysql'), { 0: 'a', 1: 'password' });
  assert.deepEqual(sensitive("select * from t where secret = 'x ?' and v = ?", 'mysql'), []);
});

test('masks sensitive literals in the statement text, never in what is sent', () => {
  const sql = new SqlText();
  const masked = (text, dialect = 'postgresql') => sql.analyze(text, dialect).maskedText;
  assert.equal(masked("select * from users where email = 'ada@x.io' and password = 'hunter2'"), "select * from users where email = 'ada@x.io' and password = '[masked]'");
  assert.equal(masked("insert into users (email, password) values ('a@x.io', 'p1'), ('b@x.io', 'p2')"), "insert into users (email, password) values ('a@x.io', '[masked]'), ('b@x.io', '[masked]')");
  assert.equal(masked('UPDATE users SET `password` = "s3cret" WHERE id = 1', 'mysql'), "UPDATE users SET `password` = '[masked]' WHERE id = 1");
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  assert.equal(masked(`select * from sessions where data = '${jwt}'`), "select * from sessions where data = '[masked]'");
  const text = "select * from users where name = 'Ada'";
  assert.equal(masked(text), text, 'nothing to mask: the same text');
});

test('masks values by name at any depth, and secret-looking strings whatever their name', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
  const bcrypt = '$2b$10$abcdefghijklmnopqrstuuJp8m4G2y3E9Ue0Qb6eWl3dQJYk1lZ7a';
  assert.deepEqual(Masker.fields({
    filter: { email: 'a@x.io', user: { password: 'x', profile: { apiKey: 'k', name: 'Ada' } } },
    update: { $set: { 'credentials.token': 't', note: jwt } },
    Authorization: 'Bearer abc',
    hash: bcrypt,
    argon: '$argon2id$v=19$m=65536,t=3,p=4$abcdefgh$abcdefghijklmnop',
    cardNumber: '4242424242424242'
  }), {
    filter: { email: 'a@x.io', user: { password: '[masked]', profile: { apiKey: '[masked]', name: 'Ada' } } },
    update: { $set: { 'credentials.token': '[masked]', note: '[masked]' } },
    Authorization: '[masked]',
    hash: '[masked]',
    argon: '[masked]',
    cardNumber: '[masked]'
  });
  assert.deepEqual(Masker.sqlParams(['a@x.io', 'hunter2', jwt, 42], new Set([1])), ['a@x.io', '[masked]', '[masked]', 42]);
  assert.equal(Masker.sqlParams(Array.from({ length: 80 }, (_, i) => i), new Set()).length, 50, 'at most 50 values');
  for (const name of ['password', 'passwd', 'client_secret', 'refreshToken', 'api-key', 'api_key', 'session', 'cookie', 'credential', 'private_key', 'cvv', 'ssn', 'card_number']) {
    assert.ok(Masker.isSensitiveName(name), name);
  }
  assert.ok(!Masker.isSensitiveName('email'));
});

test('value rules: short, JSON-safe, binary and large values described', () => {
  const value = Masker.value;
  assert.equal(value('x'.repeat(300)), `${'x'.repeat(256)}…`);
  assert.equal(value(Buffer.alloc(32)), '<binary 32 bytes>');
  assert.equal(value(new Uint8Array(5)), '<binary 5 bytes>');
  assert.equal(value(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(value(12345678901234567890n), '12345678901234567890');
  assert.equal(value(() => 1), '<function>');
  assert.equal(value(Symbol('s')), '<symbol>');
  assert.equal(value(undefined), null);
  assert.equal(value(NaN), 'NaN');
  assert.deepEqual(value({ a: 1, b: [1, 2], c: { d: true } }), { a: 1, b: [1, 2], c: { d: true } });
  assert.equal(value({ blob: 'y'.repeat(250), more: Array.from({ length: 10 }, () => 'z'.repeat(200)) }), '<json 2.2 KB>');
  assert.match(value(Array.from({ length: 5000 }, (_, i) => ({ i }))), /^<json \d+\.\d KB>$/);
  // Driver values serialize as what they mean.
  assert.equal(value({ toJSON: () => 'ObjectId(1)' }), 'ObjectId(1)');
  const circular = { a: 1 };
  circular.self = circular;
  assert.deepEqual(value(circular), { a: 1, self: '…' });
});

test('masks outgoing URLs: credentials and sensitive query values', () => {
  assert.equal(Masker.url('https://user:pw@api.example.com/v1/charges?token=abc&limit=10&api_key=k#x'), 'https://api.example.com/v1/charges?token=[masked]&limit=10&api_key=[masked]#x');
  assert.equal(Masker.url('http://h/p?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'), 'http://h/p?jwt=[masked]');
  assert.equal(Masker.url(`http://h/${'a'.repeat(3000)}`).length, 2048);
});

test('shapes of MongoDB commands and Prisma arguments carry no values', () => {
  assert.equal(Shape.of({ customerId: 42, status: { $in: ['paid', 'open'] } }), '{ customerId: ?, status: { $in: ? } }');
  assert.equal(Shape.of([{ $match: { status: 'paid' } }, { $group: { _id: '$customerId', total: { $sum: '$total' } } }]), '[{ $match: { status: ? } }, { $group: { _id: ?, total: { $sum: ? } } }]');
  assert.equal(Shape.of({ where: { id: 1 }, include: { posts: true } }), '{ where: { id: ? }, include: { posts: ? } }');
  assert.equal(Shape.of({ $or: [{ a: 1 }, { b: 2 }], 'address.city': 'x' }), '{ $or: [{ a: ? }, { b: ? }], "address.city": ? }');
  assert.equal(Shape.of({ when: new Date(), id: Buffer.from('x') }), '{ when: ?, id: ? }');
  assert.equal(Shape.of({}), '{}');
});

// A request context with a timeline, for the code under test to run in.
function withTimeline(options, fn) {
  const context = new RequestContext({ capture: null, req: { method: 'GET', headers: {} }, target: { url: '/t', pathname: '/t', search: '' } });
  context.timeline = new Timeline(settings(options));
  return { context, result: context.run(() => fn(context.timeline)) };
}

test('statements, N+1, duplicates, slow queries and stats', () => {
  const { context } = withTimeline({ slowQueryMs: 0.0001, nPlusOneThreshold: 5 }, (timeline) => {
    assert.equal(Timeline.current(), timeline);
    for (let i = 0; i < 7; i++) {
      timeline.query({ system: 'postgresql', client: 'pg', text: 'select * from users where id = $1', params: [i % 3] }).end({ rows: 1 });
    }
    timeline.query({ system: 'postgresql', client: 'pg', text: "select * from users where email = 'a@x.io'" }).end({ rows: 1 });
    timeline.query({ system: 'postgresql', client: 'pg', text: "select * from users where email = 'b@x.io'" }).end({ error: Object.assign(new Error('boom'), { code: '57014' }) });
    timeline.http({ client: 'fetch', method: 'post', url: 'https://API.example.com/x?token=1', host: 'API.example.com' }).end({ status: 201 });
    timeline.log('info', 'hello');
  });
  const { stats, timeline } = context.timeline.close();
  assert.deepEqual(Object.keys(stats), ['queries', 'queryTime', 'slowQueries', 'nPlusOne', 'duplicates', 'http', 'httpTime', 'logs', 'loopBlock']);
  assert.equal(stats.queries, 9);
  assert.equal(stats.slowQueries, 9);
  assert.equal(stats.nPlusOne, 1);
  assert.equal(stats.duplicates, 4, '7 executions with 3 distinct params');
  assert.equal(stats.http, 1);
  assert.equal(stats.logs, 1);

  assert.deepEqual(Object.keys(timeline), ['version', 'spans', 'statements', 'dropped', 'slowQueryMs', 'nPlusOneThreshold']);
  const [byId, byEmail] = timeline.statements;
  assert.deepEqual(Object.keys(byId), ['system', 'client', 'text', 'fingerprint', 'count', 'time', 'maxTime', 'slow', 'nPlusOne', 'duplicates', 'caller']);
  assert.equal(byId.count, 7);
  assert.equal(byId.nPlusOne, true);
  assert.equal(byId.duplicates, 4);
  assert.equal(byId.caller.relativeFile, 'test/timeline.test.js');
  assert.equal(byEmail.count, 2, 'inline literals: one statement');
  assert.equal(byEmail.text, "select * from users where email = 'a@x.io'");

  const queries = timeline.spans.filter((span) => span.type === 'query');
  assert.deepEqual(queries[0].params, [0]);
  assert.equal(queries[7].text, undefined, 'same text as its statement');
  assert.equal(queries[8].text, "select * from users where email = 'b@x.io'");
  assert.equal(queries[8].error, '57014: boom');
  const http = timeline.spans.find((span) => span.type === 'http');
  assert.deepEqual({ ...http, start: 0, duration: 0 }, { type: 'http', start: 0, duration: 0, client: 'fetch', method: 'POST', url: 'https://API.example.com/x?token=[masked]', host: 'api.example.com', status: 201 });
  assert.deepEqual(Object.keys(timeline.spans.find((span) => span.type === 'log')), ['type', 'start', 'level', 'message', 'source']);
});

test('caps: spans, statements and parameters', () => {
  const { context } = withTimeline({}, (timeline) => {
    for (let i = 0; i < 520; i++) timeline.query({ system: 'mysql', client: 'mysql2', text: 'select ?', params: [i] }).end();
    for (let i = 0; i < 210; i++) timeline.query({ system: 'mysql', client: 'mysql2', text: `select * from t${i}` }).end();
    for (let i = 0; i < 230; i++) timeline.log('debug', `line ${i}`);
    for (let i = 0; i < 120; i++) timeline.http({ client: 'http', method: 'GET', url: `http://h/${i}`, host: 'h' }).end({ status: 200 });
    for (let i = 0; i < 110; i++) timeline.measure(`m${i}`).end();
    for (let i = 0; i < 12; i++) timeline.exception({ id: `e${i}`, summary: { name: 'Error', message: 'x'.repeat(600) } });
  });
  const { stats, timeline } = context.timeline.close();
  assert.equal(stats.queries, 730, 'counted past the caps');
  assert.equal(stats.logs, 230);
  assert.equal(stats.http, 120);
  const count = (type) => timeline.spans.filter((span) => span.type === type).length;
  assert.equal(count('query'), 500);
  assert.equal(count('log'), 200);
  assert.equal(count('http'), 100);
  assert.equal(count('measure'), 100);
  assert.equal(count('exception'), 10);
  assert.equal(timeline.spans.find((span) => span.type === 'exception').message.length, 500);
  assert.equal(timeline.statements.length, 200);
  assert.equal(timeline.dropped, 730 - 500 + 30 + 20 + 10 + 2);
  const first = timeline.statements[0];
  assert.equal(first.count, 520);
  assert.equal(timeline.spans.filter((span) => span.statement === 0 && span.params).length, 20, 'parameters for the first 20 executions');
});

test('the 512 KB budget drops parameters first, newest first', () => {
  const big = 'v'.repeat(250);
  const { context } = withTimeline({}, (timeline) => {
    for (let i = 0; i < 300; i++) {
      timeline.query({ system: 'postgresql', client: 'pg', text: `select x${i % 100} from t where a = $1`, params: Array.from({ length: 50 }, () => big) }).end();
    }
  });
  const { timeline } = context.timeline.close();
  const size = Buffer.byteLength(JSON.stringify(timeline));
  assert.ok(size <= 512 * 1024, `${size} bytes`);
  const queries = timeline.spans.filter((span) => span.type === 'query');
  assert.equal(queries.length, 300, 'no span had to go');
  assert.equal(timeline.dropped, 0);
  assert.ok(queries[0].params, 'the oldest keep their parameters');
  assert.equal(queries[299].params, undefined, 'the newest lost theirs');
  const kept = queries.findIndex((span) => !span.params);
  assert.ok(queries.slice(kept).every((span) => !span.params), 'a single cut: everything after it lost its parameters');
});

test('the 512 KB budget then drops the newest spans', () => {
  const { context } = withTimeline({}, (timeline) => {
    for (let i = 0; i < 200; i++) timeline.log('info', 'l'.repeat(2000));
    // Inline literals make every execution's text differ from its statement's: each span carries 4 KB.
    for (let i = 0; i < 300; i++) timeline.query({ system: 'postgresql', client: 'pg', text: `select '${String(i).repeat(1300)}'` }).end();
  });
  const { stats, timeline } = context.timeline.close();
  assert.ok(Buffer.byteLength(JSON.stringify(timeline)) <= 512 * 1024);
  assert.equal(stats.queries, 300, 'still counted');
  assert.equal(timeline.spans.filter((span) => span.type === 'log').length, 200, 'the oldest spans stay');
  const queries = timeline.spans.filter((span) => span.type === 'query');
  assert.ok(queries.length > 0 && queries.length < 300);
  assert.equal(timeline.dropped, 300 - queries.length);
});

test('closing: later spans are ignored, open spans keep a null duration', () => {
  const { context } = withTimeline({}, (timeline) => {
    const open = timeline.query({ system: 'postgresql', client: 'pg', text: 'select pg_sleep(10)' });
    const measured = timeline.measure('still running');
    const { stats, timeline: closed } = timeline.close();
    open.end({ rows: 1 });
    measured.end();
    assert.equal(timeline.query({ system: 'postgresql', client: 'pg', text: 'select 1' }), null);
    assert.equal(Timeline.current(), null, 'a closed timeline is no longer current');
    assert.equal(stats.queries, 1);
    assert.equal(closed.spans[0].duration, null);
    assert.equal(closed.spans[1].duration, null);
    assert.equal(timeline.close().timeline, closed, 'closing again changes nothing');
  });
  // A quiet request has stats but no timeline.
  const quiet = new Timeline(settings());
  assert.deepEqual(quiet.close(), { stats: { queries: 0, queryTime: 0, slowQueries: 0, nPlusOne: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0, loopBlock: 0 }, timeline: undefined });
  void context;
});

test('options turn parts off', () => {
  const { context } = withTimeline({ captureQueries: false, captureOutgoing: false, captureLogs: false, queryParams: true }, (timeline) => {
    assert.equal(timeline.query({ system: 'postgresql', client: 'pg', text: 'select 1' }), null);
    assert.equal(timeline.http({ client: 'fetch', method: 'GET', url: 'http://h/', host: 'h' }), null);
    timeline.log('info', 'x');
  });
  assert.equal(context.timeline.close().timeline, undefined);
  const { context: noParams } = withTimeline({ queryParams: false }, (timeline) => {
    timeline.query({ system: 'postgresql', client: 'pg', text: 'select $1', params: [1] }).end();
  });
  assert.equal(noParams.timeline.close().timeline.spans[0].params, undefined);
});

test('recording never throws into the app: what can\'t be read is left out', () => {
  const { proxy: unreadable, revoke } = Proxy.revocable({}, {});
  revoke();
  const { context } = withTimeline({}, (timeline) => {
    timeline.query({ system: 'postgresql', client: 'pg', text: 'select $1', params: [unreadable] }).end({ error: unreadable });
    assert.equal(timeline.http({ client: 'fetch', method: 'GET', url: unreadable, host: 'h' }), null);
    assert.equal(timeline.measure(unreadable), null);
    timeline.log('info', unreadable);
    timeline.query({ system: 'postgresql', client: 'pg', text: 'select 2' }).end(null);
    assert.equal(Timeline.sqlFingerprint('select 2', 'postgresql').length, 16);
  });
  const { stats, timeline } = context.timeline.close();
  assert.equal(stats.queries, 2);
  assert.equal(stats.http, 0, 'nothing counted for a call that couldn\'t be recorded');
  assert.equal(stats.logs, 0);
  assert.deepEqual(timeline.spans.map((span) => span.type), ['query', 'query']);
  assert.equal(timeline.spans[0].params, undefined, 'unreadable parameters are left out');
  assert.equal(timeline.spans[0].error, 'Error');
  assert.equal(typeof timeline.spans[1].duration, 'number');
  assert.equal(Masker.value(Object.setPrototypeOf(new Date(0), null)), '1970-01-01T00:00:00.000Z', 'a Date is a Date by what it holds');
});

test('the caller is the first frame of the app, outside PeekInside and node_modules', () => {
  const caller = new Caller(ROOT);
  const found = caller.capture();
  assert.equal(found.relativeFile, 'test/timeline.test.js');
  assert.equal(found.file, fileURLToPath(import.meta.url));
  assert.ok(found.line > 0);
  const stack = `Error\n    at Query.run (${ROOT}/node_modules/pg/lib/client.js:10:5)\n    at Timeline.query (${ROOT}/src/timeline/timeline.js:1:1)\n    at listUsers (${ROOT}/app/routes.js:42:7)`;
  assert.deepEqual(caller.fromStack(stack), { file: `${ROOT}/app/routes.js`, relativeFile: 'app/routes.js', line: 42, column: 7, function: 'listUsers' });
  assert.equal(caller.fromStack('no frames'), null);
});

test('bounds: long statements are analyzed without being cached, huge parameters never compared', () => {
  const sql = new SqlText();
  sql.analyze('select 1', 'postgresql');
  const bulk = `insert into t (a) values ${Array.from({ length: 2000 }, (_, i) => `(${i})`).join(', ')}`;
  const analysis = sql.analyze(bulk, 'postgresql');
  assert.equal(sql.cache.size, 1, 'one-off bulk statements don\'t push the others out');
  assert.ok(analysis.maskedText.length <= 4096);
  assert.equal(analysis.fingerprint, sql.analyze('insert into t (a) values (1)', 'postgresql').fingerprint);

  assert.equal(ExecutionHash.of('select $1', [1, 'a', null, new Date(0), Buffer.from('x')]), ExecutionHash.of('select $1', [1, 'a', null, new Date(0), Buffer.from('x')]));
  assert.notEqual(ExecutionHash.of('select $1', [1]), ExecutionHash.of('select $1', ['1']), 'types count');
  assert.notEqual(ExecutionHash.of('select $1', [1]), ExecutionHash.of('select $2', [1]), 'text counts');
  const documents = Array.from({ length: 3000 }, (_, i) => ({ i }));
  assert.notEqual(ExecutionHash.of('orders.insert', documents), ExecutionHash.of('orders.insert', documents), 'too large to compare: never a duplicate');
});

test('MongoDB commands: statement text and value-carrying fields', () => {
  const orders = { db: 'shop', collection: 'orders' };
  assert.deepEqual(MongoInstrumentation.describe(orders, { find: 'orders', filter: { customerId: 7 }, sort: { at: -1 }, limit: 10, lsid: { id: 'x' }, $db: 'shop' }), {
    text: 'orders.find({ customerId: ? })',
    params: { filter: { customerId: 7 }, sort: { at: -1 }, limit: 10 }
  });
  assert.deepEqual(MongoInstrumentation.describe(orders, { update: 'orders', updates: [{ q: { _id: 1 }, u: { $set: { paid: true } } }], ordered: true }), {
    text: 'orders.update({ q: { _id: ? }, u: { $set: { paid: ? } } })',
    params: { updates: [{ q: { _id: 1 }, u: { $set: { paid: true } } }] }
  });
  assert.equal(MongoInstrumentation.describe(orders, { delete: 'orders', deletes: [{ q: { status: 'old' }, limit: 0 }] }).text, 'orders.delete({ status: ? })');
  assert.equal(MongoInstrumentation.describe(orders, { findAndModify: 'orders', query: { _id: 1 }, update: { $inc: { n: 1 } } }).text, 'orders.findAndModify({ query: { _id: ? }, update: { $inc: { n: ? } } })');
  assert.equal(MongoInstrumentation.describe(orders, { getMore: 123n, collection: 'orders', batchSize: 100 }).text, 'orders.getMore()');
  assert.equal(MongoInstrumentation.describe({ db: 'shop', collection: '$cmd' }, { listCollections: 1, filter: {} }).text, 'shop.listCollections()');
  for (const internal of [{ hello: 1 }, { isMaster: 1 }, { saslStart: 1 }, { endSessions: [] }, { ping: 1 }]) {
    assert.equal(MongoInstrumentation.describe({ db: 'admin', collection: '$cmd' }, internal), null, Object.keys(internal)[0]);
  }
});
