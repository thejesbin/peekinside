import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { TrafficClassifier } from '../src/deployment.js';

const classifier = new TrafficClassifier();
const serverSignal = (req) => classifier.serverSignal(req);
const isLocalHostname = (hostname) => classifier.isLocalHostname(hostname);

function request(headers, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } };
}

test('local development is never treated as a server', () => {
  const local = [
    'localhost:3000',
    'LOCALHOST',
    '127.0.0.1:3000',
    '[::1]:3000',
    '0.0.0.0:8080',
    'api.localhost:8080',
    'shop.test',
    'my-laptop.local:3000',
    'api.internal',
    'backend:8080', // Docker Compose service
    '192.168.1.20:3000', // phone on the same Wi-Fi
    '10.0.2.2:3000', // Android emulator
    '172.17.0.1', // Docker bridge
    'abc123.ngrok-free.app', // webhook tunnel
    'quiet-river.trycloudflare.com'
  ];
  for (const host of local) {
    assert.equal(serverSignal(request({ host })), null, host);
  }
  assert.equal(serverSignal(request({})), null, 'no Host header');
  assert.equal(serverSignal(request({ host: 'localhost:3000' }, '::ffff:192.168.1.7')), null, 'IPv4-mapped LAN client');
});

test('requests to a public domain or IP are server traffic', () => {
  assert.deepEqual(serverSignal(request({ host: 'api.company.com' })), { kind: 'host', value: 'api.company.com' });
  assert.deepEqual(serverSignal(request({ host: 'API.Company.com:443' })), { kind: 'host', value: 'api.company.com' });
  assert.deepEqual(serverSignal(request({ host: '203.0.113.5:8080' })), { kind: 'host', value: '203.0.113.5' });
  assert.deepEqual(serverSignal(request({ host: 'shop.example.com' })), { kind: 'host', value: 'shop.example.com' });
  // The .dev top-level domain is public.
  assert.deepEqual(serverSignal(request({ host: 'myapp.dev' })), { kind: 'host', value: 'myapp.dev' });
});

test('proxies that rewrite Host are still caught', () => {
  // nginx forwards "Host: localhost:3000" by default, with the visitor in X-Forwarded-For.
  assert.deepEqual(
    serverSignal(request({ host: 'localhost:3000', 'x-forwarded-for': '8.8.8.8, 10.0.0.2' })),
    { kind: 'client', value: '8.8.8.8' }
  );
  assert.deepEqual(serverSignal(request({ host: 'localhost:3000', 'x-forwarded-host': 'shop.acme.io' })), { kind: 'host', value: 'shop.acme.io' });
  assert.deepEqual(serverSignal(request({ host: 'app:3000', 'x-real-ip': '198.51.100.20' })), { kind: 'client', value: '198.51.100.20' });
  assert.deepEqual(
    serverSignal(request({ host: 'localhost', forwarded: 'for=192.0.2.60;proto=https;host=api.acme.io' })),
    { kind: 'host', value: 'api.acme.io' }
  );
  assert.deepEqual(
    serverSignal(request({ host: 'localhost', forwarded: 'for="[2001:db8:cafe::17]:4711"' })),
    { kind: 'client', value: '2001:db8:cafe::17' }
  );
  // A server reached directly by its address
  assert.deepEqual(serverSignal(request({ host: 'localhost:3000' }, '::ffff:8.8.4.4')), { kind: 'client', value: '8.8.4.4' });
  // Private hops in X-Forwarded-For are fine
  assert.equal(serverSignal(request({ host: 'localhost:3000', 'x-forwarded-for': '10.0.0.5, 192.168.0.2' })), null);
});

test('tunnels bring webhooks to a laptop: not server traffic', () => {
  assert.equal(serverSignal(request({ host: 'abc.ngrok-free.app', 'x-forwarded-for': '54.187.174.169' })), null);
  assert.equal(serverSignal(request({ host: 'localhost:3000', 'x-forwarded-host': 'abc.ngrok.io', 'x-forwarded-for': '3.18.12.63' })), null);
});

test('addresses on the networks this machine is on count as local', () => {
  const own = Object.values(os.networkInterfaces()).flat().filter((iface) => iface && !iface.internal);
  for (const iface of own) {
    assert.equal(isLocalHostname(iface.address.split('%')[0]), true, iface.cidr);
  }
});
