// node-postgres on the request timeline, against a throwaway PostgreSQL cluster (skipped when the
// PostgreSQL binaries aren't installed). The hub runs in this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const PG_BIN = process.env.PEEKINSIDE_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const missing = !fs.existsSync(path.join(PG_BIN, 'initdb')) && `PostgreSQL binaries not found in ${PG_BIN} (set PEEKINSIDE_PG_BIN)`;
const SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');

const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-pg-home-'));
const hubPort = await freePort();
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(home).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir: home });
let postgres = null;
let config = null;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A cluster in a temporary folder, on TCP only (socket paths under long temp folders fail).
async function startPostgres() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pg-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  execFileSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
  execFileSync(path.join(PG_BIN, 'pg_ctl'), ['-D', data, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, '-l', path.join(dir, 'log'), '-w', 'start'], { stdio: 'ignore' });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      execFileSync(path.join(PG_BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // Never leave a cluster behind, even when the tests crash.
  process.once('exit', stop);
  return { port, stop };
}

before(async () => {
  await new Promise((resolve) => hub.listen(resolve));
  if (missing) return;
  postgres = await startPostgres();
  config = { host: '127.0.0.1', port: postgres.port, user: 'postgres', database: 'postgres' };
  const client = new pg.Client(config);
  await client.connect();
  await client.query('create table users (id serial primary key, email text not null, password text not null)');
  await client.query("insert into users (email, password) select 'user' || n || '@x.io', 'pw' || n from generate_series(1, 30) as n");
  await client.end();
});

after(() => {
  hub.close();
  if (postgres) postgres.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

function get(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

// The stored record (summary, detail) of each url, once the hub has them all.
async function recorded(peekInside, name, urls) {
  for (let i = 0; i < 100; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      const requests = store.list(project.id, { limit: 100 }).requests;
      const found = urls.map((url) => requests.find((request) => request.url === url));
      if (found.every(Boolean)) return found.map((summary) => ({ summary, detail: store.detail(project.id, summary.id), project }));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`timed out waiting for ${urls.join(', ')}`);
}

async function withApp(name, options, routes, run) {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: name, local: true, ...options });
  routes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(server.address().port, peekInside);
  } finally {
    peekInside.stop();
    server.close();
  }
}

test('an N+1 loop, a slow query and a failing one, with callers, flags and masked values', { skip: missing }, async () => {
  const pool = new pg.Pool({ ...config, max: 4 });
  try {
    await withApp('pg-n-plus-one', { slowQueryMs: 100 }, (app) => {
      app.get('/users', async (req, res) => {
        const { rows } = await pool.query('select id from users order by id limit 30');
        for (const row of rows) {
          await pool.query('select * from users where id = $1', [row.id]);
        }
        await pool.query('select pg_sleep(0.12)');
        await pool.query('insert into users (email, password) values ($1, $2)', ['new@x.io', 'hunter2']);
        await pool.query("select * from users where password = 'pw1'");
        const failure = await pool.query('select * from missing_table').catch((error) => error.code);
        res.json({ rows: rows.length, failure, requestId: PeekInside.requestId() });
      });
    }, async (port, peekInside) => {
      const answer = JSON.parse((await get(port, '/users')).text);
      assert.equal(answer.failure, '42P01', 'the app sees the error it would see');
      const [{ summary, detail }] = await recorded(peekInside, 'pg-n-plus-one', ['/users']);
      assert.equal(answer.requestId, summary.id, 'PeekInside.requestId() is the record\'s id');

      assert.deepEqual(summary.stats, {
        queries: 35,
        queryTime: summary.stats.queryTime,
        slowQueries: 1,
        nPlusOne: 1,
        duplicates: 0,
        http: 0,
        httpTime: 0,
        logs: 0,
        loopBlock: 0
      });
      assert.ok(summary.stats.queryTime >= 120);

      const { timeline } = detail;
      assert.equal(timeline.version, 1);
      assert.equal(timeline.slowQueryMs, 100);
      assert.equal(timeline.nPlusOneThreshold, 5);
      const loop = timeline.statements.find((statement) => statement.text === 'select * from users where id = $1');
      assert.equal(loop.count, 30);
      assert.equal(loop.nPlusOne, true);
      assert.equal(loop.system, 'postgresql');
      assert.equal(loop.client, 'pg');
      assert.equal(loop.caller.relativeFile, 'test/timeline-pg.test.js');
      assert.match(SOURCE[loop.caller.line - 1], /pool\.query\('select \* from users where id = \$1'/, 'the caller is the loop\'s line');
      assert.equal(loop.caller.file, fileURLToPath(import.meta.url));

      const slow = timeline.statements.find((statement) => statement.text === 'select pg_sleep(0.12)');
      assert.equal(slow.slow, 1);
      assert.ok(slow.maxTime >= 120);

      const queries = timeline.spans.filter((span) => span.type === 'query');
      assert.equal(queries.length, 35);
      assert.deepEqual(queries[1].params, [1]);
      assert.equal(queries[1].rows, 1);
      assert.equal(queries[0].rows, 30);
      const insert = timeline.statements.findIndex((statement) => statement.text.startsWith('insert into users'));
      assert.deepEqual(queries.find((span) => span.statement === insert).params, ['new@x.io', '[masked]']);
      assert.ok(timeline.statements.some((statement) => statement.text === "select * from users where password = '[masked]'"));
      const failed = queries.find((span) => span.error);
      assert.equal(failed.error, '42P01: relation "missing_table" does not exist');
      assert.equal(detail.exceptions.length, 0);
    });
  } finally {
    await pool.end();
  }
});

test('every pg calling form returns what pg returns, and is recorded', { skip: missing }, async () => {
  const client = new pg.Client(config);
  await client.connect();
  try {
    await withApp('pg-forms', {}, (app) => {
      app.get('/forms', async (req, res) => {
        const results = {};
        const promise = client.query('select 1 as one');
        results.promise = promise instanceof Promise;
        results.text = (await promise).rows[0].one;
        results.config = (await client.query({ text: 'select $1::int as n', values: [2], rowMode: 'array' })).rows[0][0];
        results.named = (await client.query({ name: 'by-id', text: 'select email from users where id = $1', values: [3] })).rows[0].email;
        results.callback = await new Promise((resolve) => {
          const returned = client.query('select $1::text as v', ['cb'], function (err, result) {
            resolve({ returned, value: result.rows[0].v, args: arguments.length });
          });
        });
        const submittable = new pg.Query('select id from users where id <= $1', [3]);
        results.same = client.query(submittable) === submittable;
        results.rows = await new Promise((resolve) => {
          let rows = 0;
          submittable.on('row', () => rows++);
          submittable.on('end', () => resolve(rows));
        });
        results.error = await new Promise((resolve) => client.query('select nope', (err) => resolve(err.code)));
        res.json(results);
      });
    }, async (port, peekInside) => {
      const results = JSON.parse((await get(port, '/forms')).text);
      assert.deepEqual(results, {
        promise: true,
        text: 1,
        config: 2,
        named: 'user3@x.io',
        callback: { value: 'cb', args: 2 },
        same: true,
        rows: 3,
        error: '42703'
      });
      const [{ detail }] = await recorded(peekInside, 'pg-forms', ['/forms']);
      const texts = detail.timeline.statements.map((statement) => statement.text);
      assert.deepEqual(texts, [
        'select 1 as one',
        'select $1::int as n',
        'select email from users where id = $1',
        'select $1::text as v',
        'select id from users where id <= $1',
        'select nope'
      ]);
      const spans = detail.timeline.spans;
      assert.ok(spans.every((span) => span.duration !== null), 'every form ended');
      assert.equal(spans[4].rows, 3);
      assert.match(spans[5].error, /^42703: column "nope" does not exist/);
    });
  } finally {
    await client.end();
  }
});

test('a pool of one connection shared by two requests: each query on its own request', { skip: missing }, async () => {
  const pool = new pg.Pool({ ...config, max: 1 });
  try {
    await withApp('pg-pool', {}, (app) => {
      app.get('/who/:name', async (req, res) => {
        for (let i = 0; i < 5; i++) {
          // Callback style: pg-pool hands the client over from inside the other request.
          await new Promise((resolve, reject) => pool.query('select $1::text as name, pg_sleep(0.005)', [req.params.name], (err) => (err ? reject(err) : resolve())));
          await pool.query('select $1::text as again', [req.params.name]);
        }
        res.send(req.params.name);
      });
    }, async (port, peekInside) => {
      await Promise.all([get(port, '/who/alice'), get(port, '/who/bob')]);
      const [alice, bob] = await recorded(peekInside, 'pg-pool', ['/who/alice', '/who/bob']);
      for (const [record, name] of [[alice, 'alice'], [bob, 'bob']]) {
        const params = record.detail.timeline.spans.map((span) => span.params[0]);
        assert.equal(params.length, 10, `${name} ran 10 queries`);
        assert.ok(params.every((value) => value === name), `${name}'s timeline holds only its own queries: ${params}`);
        assert.equal(record.summary.stats.queries, 10);
      }
    });
  } finally {
    await pool.end();
  }
});

test('timeline: false records no stats and no timeline; queryParams: false keeps no values', { skip: missing }, async () => {
  const pool = new pg.Pool({ ...config, max: 1 });
  try {
    await withApp('pg-off', { timeline: false }, (app) => {
      app.get('/off', async (req, res) => res.json((await pool.query('select 1 as one')).rows));
    }, async (port, peekInside) => {
      await get(port, '/off');
      const [{ summary, detail }] = await recorded(peekInside, 'pg-off', ['/off']);
      assert.equal(summary.stats, null);
      assert.equal(detail.timeline, undefined);
    });
    await withApp('pg-no-params', { queryParams: false }, (app) => {
      app.get('/plain', async (req, res) => res.json((await pool.query('select $1::int as n', [5])).rows));
    }, async (port, peekInside) => {
      await get(port, '/plain');
      const [{ summary, detail }] = await recorded(peekInside, 'pg-no-params', ['/plain']);
      assert.equal(summary.stats.queries, 1);
      assert.equal(detail.timeline.spans[0].params, undefined);
      assert.equal(detail.timeline.spans[0].rows, 1);
    });
  } finally {
    await pool.end();
  }
});

test('the hub lists stats with each request and returns the timeline untouched', { skip: missing }, async () => {
  const pool = new pg.Pool({ ...config, max: 1 });
  try {
    await withApp('pg-hub', {}, (app) => {
      app.get('/one', async (req, res) => res.json((await pool.query('select 1 as one')).rows));
      app.get('/quiet', (req, res) => res.send('nothing'));
    }, async (port, peekInside) => {
      await get(port, '/one');
      await get(port, '/quiet');
      const [one, quiet] = await recorded(peekInside, 'pg-hub', ['/one', '/quiet']);
      const answer = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: hubPort, path: `/api/projects/${one.project.id}/requests`, headers: { host: `localhost:${hubPort}` } }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(JSON.parse(text)));
        }).on('error', reject);
      });
      const listed = Object.fromEntries(answer.requests.map((request) => [request.url, request.stats]));
      assert.equal(listed['/one'].queries, 1);
      assert.deepEqual(listed['/quiet'], { queries: 0, queryTime: 0, slowQueries: 0, nPlusOne: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0, loopBlock: 0 });
      assert.equal(quiet.detail.timeline, undefined, 'a quiet request has stats but no timeline');
      assert.equal(one.detail.timeline.statements[0].text, 'select 1 as one');
    });
  } finally {
    await pool.end();
  }
});
