// mysql2 (callback, promise, streaming, pools) on the request timeline. MySQL isn't needed:
// mysql2's own server implementation answers on a local port. The hub runs in this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mysql from 'mysql2';
import mysqlPromise from 'mysql2/promise';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const require = createRequire(import.meta.url);
// Packet builders the fake server needs (mysql2's exports don't list them).
const mysqlDir = path.dirname(require.resolve('mysql2'));
const Packet = require(path.join(mysqlDir, 'lib', 'packets', 'packet.js'));
const ColumnDefinition = require(path.join(mysqlDir, 'lib', 'packets', 'column_definition.js'));
const SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');

const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-mysql-home-'));
const hubPort = await freePort();
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(home).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir: home });
const database = fakeMysql();
let config;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const column = (name) => ({ catalog: 'def', schema: 'shop', table: 'users', orgTable: 'users', name, orgName: name, characterSet: 33, columnLength: 255, columnType: 253, flags: 0, decimals: 0 });

// Answers SELECTs with two rows, other statements with OK (one affected row), and anything
// mentioning missing_table with ER_NO_SUCH_TABLE; prepared statements too.
function fakeMysql() {
  return mysql.createServer((conn) => {
    // mysql2's server side doesn't restart sequence ids for each command, as the client does.
    const handlePacket = conn.handlePacket;
    conn.handlePacket = function (packet) {
      if (packet && packet.sequenceId === 0) this.sequenceId = 0;
      return handlePacket.apply(this, arguments);
    };
    conn.on('error', () => {});
    conn.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.0-fake', connectionId: 1, statusFlags: 2, characterSet: 33, capabilityFlags: 0xffffff });
    const statements = new Map();
    let nextId = 1;
    const answer = (sql, binary) => {
      if (/missing_table/.test(sql)) return conn.writeError({ code: 1146, message: "Table 'shop.missing_table' doesn't exist" });
      if (/^\s*select/i.test(sql)) return conn.writeTextResult([{ id: '1', email: 'a@x.io' }, { id: '2', email: 'b@x.io' }], [column('id'), column('email')], binary);
      return conn.writeOk({ affectedRows: 1, insertId: 7 });
    };
    conn.on('query', (sql) => answer(sql, false));
    conn.on('stmt_prepare', (sql) => {
      const id = nextId++;
      const params = (sql.match(/\?/g) || []).length;
      statements.set(id, sql);
      const packet = new Packet(0, Buffer.alloc(16), 0, 16);
      packet.offset = 4;
      packet.writeInt8(0);
      packet.writeInt32(id);
      packet.writeInt16(0);
      packet.writeInt16(params);
      packet.writeInt8(0);
      packet.writeInt16(0);
      conn.writePacket(packet);
      if (params) {
        for (let i = 0; i < params; i++) conn.writePacket(ColumnDefinition.toPacket(column('?'), 0));
        conn.writeEof();
      }
    });
    conn.on('stmt_execute', (id) => answer(statements.get(id) || '', true));
  });
}

before(async () => {
  await new Promise((resolve) => hub.listen(resolve));
  const port = await freePort();
  await new Promise((resolve) => database.listen(port, '127.0.0.1', resolve));
  config = { host: '127.0.0.1', port, user: 'app', password: 'app', database: 'shop' };
});

after(() => {
  hub.close();
  database.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function get(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

async function recorded(peekInside, name, urls) {
  for (let i = 0; i < 100; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      const requests = store.list(project.id, { limit: 100 }).requests;
      const found = urls.map((url) => requests.find((request) => request.url === url));
      if (found.every(Boolean)) return found.map((summary) => ({ summary, detail: store.detail(project.id, summary.id) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`timed out waiting for ${urls.join(', ')}`);
}

async function withApp(name, routes, run) {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: name, local: true });
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

function end(connection) {
  return new Promise((resolve) => connection.end(() => resolve()));
}

test('mysql2: callbacks, promises, prepared statements and streams, masked and flagged', async () => {
  const conn = mysql.createConnection(config);
  conn.on('error', () => {});
  const pool = mysqlPromise.createPool({ ...config, connectionLimit: 2 });
  try {
    await withApp('mysql-app', (app) => {
      app.get('/orders', async (req, res) => {
        const results = {};
        results.cmd = await new Promise((resolve, reject) => {
          const returned = conn.query('select * from users where email = ?', ['a@x.io'], (err, rows) => (err ? reject(err) : resolve({ rows: rows.length, command: typeof returned.on })));
        });
        for (let i = 0; i < 6; i++) {
          await pool.query('select * from users where id = ?', [i % 2]);
        }
        await pool.execute('insert into users (email, password) values (?, ?)', ['c@x.io', 'hunter2']);
        results.streamed = await new Promise((resolve) => {
          let rows = 0;
          conn.query("update users set password = 'p4ss' where id = 1").on('result', () => rows++).on('end', () => resolve(rows));
        });
        results.error = await pool.query('select * from missing_table').catch((error) => error.code);
        res.json(results);
      });
    }, async (port, peekInside) => {
      const results = JSON.parse((await get(port, '/orders')).text);
      assert.deepEqual(results, { cmd: { rows: 2, command: 'function' }, streamed: 1, error: 'ER_NO_SUCH_TABLE' });
      const [{ summary, detail }] = await recorded(peekInside, 'mysql-app', ['/orders']);
      assert.equal(summary.stats.queries, 10);
      assert.equal(summary.stats.nPlusOne, 1);
      assert.equal(summary.stats.duplicates, 4);

      const { statements, spans } = detail.timeline;
      assert.deepEqual(statements.map((statement) => [statement.system, statement.client, statement.text, statement.count]), [
        ['mysql', 'mysql2', 'select * from users where email = ?', 1],
        ['mysql', 'mysql2', 'select * from users where id = ?', 6],
        ['mysql', 'mysql2', 'insert into users (email, password) values (?, ?)', 1],
        ['mysql', 'mysql2', "update users set password = '[masked]' where id = 1", 1],
        ['mysql', 'mysql2', 'select * from missing_table', 1]
      ]);
      const loop = statements[1];
      assert.equal(loop.nPlusOne, true);
      assert.equal(loop.caller.relativeFile, 'test/timeline-mysql.test.js');
      assert.match(SOURCE[loop.caller.line - 1], /pool\.query\('select \* from users where id = \?'/);
      assert.deepEqual(spans[0].params, ['a@x.io']);
      assert.equal(spans[0].rows, 2);
      assert.deepEqual(spans.find((span) => span.statement === 2).params, ['c@x.io', '[masked]']);
      assert.equal(spans.find((span) => span.statement === 2).rows, 1);
      assert.equal(spans.find((span) => span.statement === 4).error, "ER_NO_SUCH_TABLE: Table 'shop.missing_table' doesn't exist");
      assert.ok(spans.every((span) => span.duration !== null));
    });
  } finally {
    await end(conn);
    await pool.end();
  }
});

test('mysql2: a pool of one connection shared by two requests keeps each query on its request', async () => {
  const pool = mysql.createPool({ ...config, connectionLimit: 1 });
  try {
    await withApp('mysql-pool', (app) => {
      app.get('/who/:name', async (req, res) => {
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve, reject) => pool.query('select ? as name', [req.params.name], (err) => (err ? reject(err) : resolve())));
          await new Promise((resolve, reject) => pool.execute('select ? as again', [req.params.name], (err) => (err ? reject(err) : resolve())));
        }
        res.send(req.params.name);
      });
    }, async (port, peekInside) => {
      await Promise.all([get(port, '/who/alice'), get(port, '/who/bob')]);
      const [alice, bob] = await recorded(peekInside, 'mysql-pool', ['/who/alice', '/who/bob']);
      for (const [record, name] of [[alice, 'alice'], [bob, 'bob']]) {
        const params = record.detail.timeline.spans.map((span) => span.params[0]);
        assert.equal(params.length, 10, `${name} ran 10 queries`);
        assert.ok(params.every((value) => value === name), `${name}'s timeline holds only its own queries: ${params}`);
      }
    });
  } finally {
    await new Promise((resolve) => pool.end(resolve));
  }
});
