// PeekInside Cloud behind a redirect: hosting often sends the bare domain to www (or back), and
// fetch() drops the API key when it follows such a redirect itself. The SDK follows it by hand,
// with the key, to the site's twin only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestRecord } from '../src/record.js';
import { CloudTransport, redirectTarget } from '../src/transport/cloud.js';

const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const PUBLIC_KEY = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const SECRET = 's'.repeat(43);
const API_KEY = `pik1.p0123456789ab.${SECRET}.${PUBLIC_KEY}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-redirect-'));
const realFetch = globalThis.fetch;
let answer;
let calls;

before(() => {
  process.env.PEEKINSIDE_HOME = home;
  process.env.PEEKINSIDE_LOCAL = '0';
  process.env.PEEKINSIDE_URL = 'https://peekinside.example';
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect });
    return answer(String(url));
  };
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(home, { recursive: true, force: true });
});

function record(n) {
  return new RequestRecord({
    id: `r-${n}`,
    occurredAt: Date.now(),
    environment: 'production',
    method: 'GET',
    status: 200,
    duration: 1,
    requestSize: 0,
    responseSize: 0,
    aborted: false,
    exceptionCount: 0,
    stats: { queries: 0, queryTime: 0, slowQueries: 0, nPlusOne: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0 },
    summary: { url: `/orders/${n}`, path: `/orders/${n}` },
    detail: {}
  });
}

const moved = (location) => new Response(null, { status: 308, headers: { location } });
const accepted = () => new Response('{"accepted":true}', { status: 200, headers: { 'content-type': 'application/json' } });

test('a redirect to the site\'s www name keeps the API key, and the next batches go there directly', async () => {
  calls = [];
  answer = (url) => (url.startsWith('https://peekinside.example/') ? moved('https://www.peekinside.example/api/ingest') : accepted());
  const transport = new CloudTransport({ apiKey: API_KEY, version: 'test' });
  transport.stop();

  transport.enqueueRecord(record(1));
  await transport.drain();
  assert.deepEqual(calls.map((call) => [call.url, call.authorization, call.redirect]), [
    ['https://peekinside.example/api/ingest', `Bearer ${SECRET}`, 'manual'],
    ['https://www.peekinside.example/api/ingest', `Bearer ${SECRET}`, 'manual'],
  ]);
  assert.equal(transport.queue.length, 0, 'the batch was delivered');

  calls = [];
  transport.enqueueRecord(record(2));
  await transport.drain();
  assert.deepEqual(calls.map((call) => call.url), ['https://www.peekinside.example/api/ingest']);
});

test('the API key never follows a redirect to another domain', async () => {
  calls = [];
  answer = () => moved('https://collector.attacker.example/api/ingest');
  const transport = new CloudTransport({ apiKey: API_KEY, version: 'test' });
  transport.stop();
  transport.enqueueRecord(record(3));
  await transport.drain();
  assert.deepEqual(calls.map((call) => call.url), ['https://peekinside.example/api/ingest'], 'nothing went to the other domain');
  assert.equal(transport.disabled, false, 'it retries later rather than giving up');
  assert.equal(transport.queue.length, 1, 'the record waits for the next attempt');
});

test('redirects are followed to the same path on the same host or its www twin, never downgrading https', () => {
  const from = 'https://peekinside.dev/api/ingest';
  const target = (status, location, origin = from) => redirectTarget(new Response(null, { status, headers: { location } }), origin);
  assert.equal(target(308, 'https://www.peekinside.dev/api/ingest'), 'https://www.peekinside.dev/api/ingest');
  assert.equal(target(307, 'https://www.peekinside.dev/api/ingest'), 'https://www.peekinside.dev/api/ingest');
  assert.equal(target(308, 'https://peekinside.dev/api/ingest', 'https://www.peekinside.dev/api/ingest'), 'https://peekinside.dev/api/ingest');
  assert.equal(target(308, 'https://peekinside.dev/api/ingest', 'http://peekinside.dev/api/ingest'), 'https://peekinside.dev/api/ingest', 'an upgrade to https');
  for (const location of [
    'https://elsewhere.example/api/ingest',
    'https://peekinside.dev.attacker.example/api/ingest',
    'https://www.peekinside.dev/other',
    'http://www.peekinside.dev/api/ingest',
  ]) {
    assert.equal(target(308, location), null, location);
  }
  assert.equal(target(301, 'https://www.peekinside.dev/api/ingest'), null, 'a 301 would turn the POST into a GET');
  assert.equal(target(200, 'https://www.peekinside.dev/api/ingest'), null);
});
