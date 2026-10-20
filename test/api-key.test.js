import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ApiKey } from '../src/crypto.js';
import { CloudTransport } from '../src/transport/cloud.js';

const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const PUBLIC_KEY = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
const KEY = `pik1.p0123456789ab.${'s'.repeat(43)}.${PUBLIC_KEY}`;

test('an API key is read with spaces or quotes around it, as some env files keep them', () => {
  for (const value of [KEY, ` ${KEY}\n`, `"${KEY}"`, `'${KEY}'`]) {
    assert.equal(ApiKey.parse(value)?.projectId, 'p0123456789ab', JSON.stringify(value.slice(0, 3)));
  }
  assert.equal(ApiKey.parse(`"${KEY}'`), null, 'quotes that don\'t match');
});

test('a value that isn\'t an API key says what it is instead, without repeating it', () => {
  assert.match(ApiKey.problem(PUBLIC_KEY), /holds your project's public key, not an API key/);
  assert.match(ApiKey.problem(`"${PUBLIC_KEY}"`), /public key/);
  assert.match(ApiKey.problem('sk_live_51Habc'), /not a PeekInside API key \(those start with "pik1\."\)/);
  assert.match(ApiKey.problem(KEY.slice(0, 70)), /cut off or changed/);
  for (const value of [PUBLIC_KEY, 'sk_live_51Habc', KEY.slice(0, 70)]) {
    assert.ok(!ApiKey.problem(value).includes(value.slice(2, 14)), 'the value never appears in the log');
  }
});

test('the app\'s log names the problem when PEEKINSIDE_API_KEY holds the public key', () => {
  assert.throws(() => new CloudTransport({ apiKey: PUBLIC_KEY }), /public key, not an API key/);
});
