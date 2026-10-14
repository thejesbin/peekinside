// Outgoing HTTP calls, console lines, measures and exceptions on the request timeline, and
// PeekInside's own traffic kept off it. The hub runs in this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import express from 'express';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-http-home-'));
const hubPort = await freePort();
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(home).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir: home });

// The service the app calls: slow on /slow, 503 on /down.
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/slow')) return setTimeout(() => res.end('slow'), 40);
  if (req.url.startsWith('/down')) {
    res.statusCode = 503;
    return res.end('down');
  }
  res.end('ok');
});

before(async () => {
  await new Promise((resolve) => hub.listen(resolve));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
});

after(() => {
  hub.close();
  upstream.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

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

async function withApp(name, options, routes, run) {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: name, local: true, ...options });
  routes(app, peekInside);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await run(server.address().port, peekInside);
  } finally {
    peekInside.stop();
    server.close();
  }
}

test('outgoing calls with node:http and fetch: status, errors, timing, masked URLs', async () => {
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const closed = await freePort();
  await withApp('http-out', {}, (app) => {
    app.get('/calls', async (req, res) => {
      await new Promise((resolve) => http.get(`${base}/slow?token=secret&page=2`, (r) => {
        r.resume();
        r.on('end', resolve);
      }));
      await new Promise((resolve) => {
        const request = http.get(`http://127.0.0.1:${closed}/nobody`);
        request.on('error', () => resolve());
      });
      const fetched = await fetch(`${base}/down?api_key=k`, { method: 'POST', body: 'x' });
      await fetched.text();
      const failure = await fetch(`http://127.0.0.1:${closed}/nobody`).catch((error) => error.cause && error.cause.code);
      res.json({ status: fetched.status, failure });
    });
  }, async (port, peekInside) => {
    const answer = JSON.parse((await get(port, '/calls')).text);
    assert.deepEqual(answer, { status: 503, failure: 'ECONNREFUSED' });
    const { summary, detail } = await recorded(peekInside, 'http-out', '/calls');
    assert.equal(summary.stats.http, 4);
    assert.ok(summary.stats.httpTime >= 40);

    const calls = detail.timeline.spans.filter((span) => span.type === 'http');
    assert.equal(calls.length, 4, 'PeekInside\'s own posts to the hub are not among them');
    const [slow, refused, down, fetchRefused] = calls;
    assert.deepEqual({ ...slow, start: 0, duration: 0 }, {
      type: 'http', start: 0, duration: 0, client: 'http', method: 'GET', url: `${base}/slow?token=[masked]&page=2`, host: '127.0.0.1', status: 200
    });
    assert.ok(slow.duration >= 40, 'until the body was read');
    assert.equal(refused.status, null);
    assert.match(refused.error, /^ECONNREFUSED: connect ECONNREFUSED/);
    assert.equal(down.client, 'fetch');
    assert.equal(down.method, 'POST');
    assert.equal(down.url, `${base}/down?api_key=[masked]`);
    assert.equal(down.status, 503);
    assert.equal(down.error, undefined);
    assert.equal(fetchRefused.status, null);
    assert.match(fetchRefused.error, /ECONNREFUSED/);
  });
});

test('console lines during a request, the output untouched; not outside requests, not PeekInside\'s', async () => {
  const written = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  await withApp('http-console', {}, (app) => {
    app.get('/logs', (req, res) => {
      process.stdout.write = function (chunk) {
        written.push(String(chunk));
        return true;
      };
      process.stderr.write = process.stdout.write;
      try {
        console.log('loaded %d users', 3, { plan: 'pro' });
        console.info('info line');
        console.warn('careful');
        console.error(new Error('printed error'));
        console.debug('debug line');
        console.trace('where am I');
        console.info('[peekinside] PeekInside\'s own line');
      } finally {
        process.stdout.write = stdout;
        process.stderr.write = stderr;
      }
      res.send('logged');
    });
  }, async (port, peekInside) => {
    await get(port, '/logs');
    const { summary, detail } = await recorded(peekInside, 'http-console', '/logs');
    assert.equal(summary.stats.logs, 6);
    const lines = detail.timeline.spans.filter((span) => span.type === 'log');
    assert.deepEqual(lines.map((line) => [line.level, line.source]), [
      ['info', 'console'], ['info', 'console'], ['warn', 'console'], ['error', 'console'], ['debug', 'console'], ['debug', 'console']
    ]);
    assert.equal(lines[0].message, "loaded 3 users { plan: 'pro' }");
    assert.match(lines[3].message, /^Error: printed error\n {4}at /);
    assert.equal(lines[5].message, 'where am I', 'console.trace, recorded as debug');
    // What the console printed is what it prints without PeekInside. In a terminal, Node colors
    // the values it inspects (the test runner sets FORCE_COLOR there): that's Node's doing, not ours.
    const printed = written.map((chunk) => stripVTControlCharacters(chunk));
    assert.equal(printed[0], "loaded 3 users { plan: 'pro' }\n");
    assert.match(printed.find((chunk) => chunk.startsWith('Trace: where am I')), /^Trace: where am I\n {4}at /);
    assert.ok(!printed.find((chunk) => chunk.startsWith('Trace')).includes('instrumentation'), 'the trace shows no PeekInside frame');
    assert.ok(printed.some((chunk) => chunk.startsWith('[peekinside]')), 'PeekInside\'s line printed, not recorded');
  });
});

test('measure(), requestId(), exception spans, and nothing after the response', async () => {
  const outcomes = {};
  await withApp('http-measure', {}, (app, peekInside) => {
    app.get('/work', async (req, res) => {
      outcomes.sync = peekInside.measure('sum', () => 1 + 1);
      outcomes.async = await PeekInside.measure('wait', () => new Promise((resolve) => setTimeout(() => resolve('done'), 20)));
      const thrown = new Error('sync failure');
      try {
        peekInside.measure('throws', () => {
          throw thrown;
        });
      } catch (error) {
        outcomes.sameThrown = error === thrown;
      }
      const rejected = new Error('async failure');
      outcomes.sameRejected = await peekInside.measure('rejects', async () => {
        throw rejected;
      }).catch((error) => error === rejected);
      outcomes.requestId = PeekInside.requestId();
      outcomes.reported = PeekInside.report(new Error('reported'));
      res.send('ok');
      // After the response: fire-and-forget work isn't part of the request's record.
      setTimeout(() => {
        peekInside.measure('late', () => 1);
        fetch(`http://127.0.0.1:${upstream.address().port}/late`).then((r) => r.text(), () => {});
      }, 20);
    });
  }, async (port, peekInside) => {
    await get(port, '/work');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { summary, detail } = await recorded(peekInside, 'http-measure', '/work');
    assert.deepEqual({ ...outcomes, requestId: outcomes.requestId === summary.id, reported: typeof outcomes.reported }, {
      sync: 2, async: 'done', sameThrown: true, sameRejected: true, requestId: true, reported: 'string'
    });
    const spans = detail.timeline.spans;
    assert.deepEqual(spans.filter((span) => span.type === 'measure').map((span) => [span.name, span.error ?? null]), [
      ['sum', null], ['wait', null], ['throws', 'sync failure'], ['rejects', 'async failure']
    ]);
    assert.ok(spans.find((span) => span.name === 'wait').duration >= 15);
    const exception = spans.find((span) => span.type === 'exception');
    assert.deepEqual(exception, { type: 'exception', start: exception.start, id: outcomes.reported, name: 'Error', message: 'reported' });
    assert.equal(summary.stats.http, 0, 'the late fetch is not counted');
    assert.ok(!spans.some((span) => span.name === 'late'));
  });
  assert.equal(PeekInside.requestId(), null, 'outside any request');
  assert.equal(PeekInside.measure('outside', () => 'ran'), 'ran');
});

test('PeekInside\'s own work during a request stays off its timeline', async () => {
  await withApp('http-own', {}, (app, peekInside) => {
    app.get('/busy', async (req, res) => {
      // Reporting queues a batch for the hub; flushing posts it, here, inside the request.
      peekInside.report(new Error('queued'));
      await peekInside.flush();
      await fetch(`http://127.0.0.1:${upstream.address().port}/mine`).then((r) => r.text());
      res.send('ok');
    });
  }, async (port, peekInside) => {
    await get(port, '/busy');
    const { summary, detail } = await recorded(peekInside, 'http-own', '/busy');
    assert.equal(summary.stats.http, 1);
    const calls = detail.timeline.spans.filter((span) => span.type === 'http');
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/mine']);
  });
});

test('instrument() takes known modules, ignores the rest, and chains', () => {
  const peekInside = new PeekInside({ local: false });
  assert.equal(peekInside.instrument(42, null, 'pg', {}, () => {}), peekInside);
  assert.equal(peekInside.measure('no timeline', () => 7), 7);
});
