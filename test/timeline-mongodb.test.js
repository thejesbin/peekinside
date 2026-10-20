// The MongoDB driver and Mongoose on the request timeline, against mongodb-memory-server (skipped
// when its binary can't be downloaded). The hub runs in this process.
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
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const require = createRequire(import.meta.url);
const SOURCE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
// The binary is downloaded once, next to the package's other caches.
process.env.MONGOMS_DOWNLOAD_DIR = process.env.MONGOMS_DOWNLOAD_DIR || fileURLToPath(new URL('../node_modules/.cache/mongodb-memory-server', import.meta.url));

const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-mongo-home-'));
const hubPort = await freePort();
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(home).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir: home });
let server = null;
let unavailable = false;

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  await new Promise((resolve) => hub.listen(resolve));
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server-core');
    server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', port: await freePort() } });
  } catch (error) {
    unavailable = `mongodb-memory-server could not start MongoDB (${error.message.split('\n')[0]})`;
  }
});

after(async () => {
  hub.close();
  if (server) await server.stop();
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

async function recorded(peekInside, name, url) {
  for (let i = 0; i < 100; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    const summary = project && store.list(project.id, { limit: 100 }).requests.find((request) => request.url === url);
    if (summary) return { summary, detail: store.detail(project.id, summary.id) };
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`timed out waiting for ${url}`);
}

test('MongoDB driver and Mongoose: commands as shapes, values masked, N+1 and write errors', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Mongoose depends on its own copy of the driver: both copies are patched from the project.
  const mongodb = require('mongodb');
  const mongoose = require('mongoose');
  const client = await new mongodb.MongoClient(server.getUri()).connect();
  const connection = await mongoose.createConnection(`${server.getUri()}orm`).asPromise();
  const User = connection.model('User', new mongoose.Schema({ email: String, password: String, age: Number }));

  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: 'mongo-app', local: true });
  app.get('/shop', async (req, res) => {
    const orders = client.db('shop').collection('orders');
    await orders.insertMany([{ customerId: 1, status: 'paid', total: 10 }, { customerId: 2, status: 'open', total: 5 }]);
    const found = await orders.find({ customerId: 1, status: { $in: ['paid', 'open'] } }).toArray();
    await orders.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$customerId', total: { $sum: '$total' } } }]).toArray();
    await orders.updateOne({ customerId: 2 }, { $set: { status: 'paid' } });
    await User.create({ email: 'a@x.io', password: 'hunter2', age: 30 });
    for (let i = 0; i < 6; i++) {
      await User.findOne({ email: 'a@x.io' }).lean();
    }
    const duplicate = await orders.insertOne({ _id: 'x' }).then(() => orders.insertOne({ _id: 'x' })).catch((error) => error.code);
    res.json({ found: found.length, duplicate });
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => http.once('listening', resolve));
  try {
    const answer = JSON.parse((await get(http.address().port, '/shop')).text);
    assert.deepEqual(answer, { found: 1, duplicate: 11000 });
    const { summary, detail } = await recorded(peekInside, 'mongo-app', '/shop');
    assert.equal(summary.stats.queries, 13);
    assert.equal(summary.stats.nPlusOne, 1);
    assert.equal(summary.stats.duplicates, 6, 'five repeated lookups, one repeated insert');

    const { statements, spans } = detail.timeline;
    assert.deepEqual(statements.map((statement) => statement.text), [
      'orders.insert({ customerId: ?, status: ?, total: ?, _id: ? })',
      'orders.find({ customerId: ?, status: { $in: ? } })',
      'orders.aggregate([{ $match: { status: ? } }, { $group: { _id: ?, total: { $sum: ? } } }])',
      'orders.update({ q: { customerId: ? }, u: { $set: { status: ? } } })',
      'users.insert({ email: ?, password: ?, age: ?, _id: ?, __v: ? })',
      'users.find({ email: ? })',
      'orders.insert({ _id: ? })'
    ]);
    assert.ok(statements.every((statement) => statement.system === 'mongodb' && statement.client === 'mongodb'));
    const lookup = statements[5];
    assert.equal(lookup.count, 6);
    assert.equal(lookup.nPlusOne, true);
    assert.equal(lookup.caller.relativeFile, 'test/timeline-mongodb.test.js');
    assert.match(SOURCE[lookup.caller.line - 1], /User\.findOne/);

    assert.deepEqual(spans[1].params, { filter: { customerId: 1, status: { $in: ['paid', 'open'] } } });
    assert.equal(spans[1].rows, 1);
    assert.deepEqual(spans[3].params, { updates: [{ q: { customerId: 2 }, u: { $set: { status: 'paid' } } }] });
    assert.equal(spans[4].params.documents[0].password, '[masked]');
    assert.equal(spans[4].params.documents[0].email, 'a@x.io');
    const failed = spans.filter((span) => span.statement === 6);
    assert.equal(failed[0].error, undefined);
    assert.match(failed[1].error, /^11000: E11000 duplicate key error/);
  } finally {
    peekInside.stop();
    http.close();
    await client.close();
    await connection.close();
  }
});
