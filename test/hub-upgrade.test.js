import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_API_VERSION } from '../src/config.js';
import { HubClient, compareVersions } from '../src/hub/client.js';

test('versions compare by major, minor and patch', () => {
  assert.ok(compareVersions('1.2.0', '1.2.1') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.2.1', '1.2.1'), 0);
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0, 'prereleases are not guessed at');
  assert.equal(compareVersions(undefined, '1.2.1'), 0, 'an unreadable version replaces nothing');
});

test('only an older hub with the same API, data folder and hub.json pid is replaced', () => {
  const self = { version: '1.2.1', dataDir: '/home/ada/.peekinside', infoPid: 4242 };
  const old = { app: 'peekinside-hub', apiVersion: HUB_API_VERSION, version: '1.2.0', pid: 4242, dataDir: '/home/ada/.peekinside' };
  assert.equal(HubClient.shouldReplace(old, self), true);
  assert.equal(HubClient.shouldReplace(null, self), false, 'nothing running');
  assert.equal(HubClient.shouldReplace({ ...old, version: '1.2.1' }, self), false, 'the same version');
  assert.equal(HubClient.shouldReplace({ ...old, version: '1.3.0' }, self), false, 'a newer hub stays');
  assert.equal(HubClient.shouldReplace({ ...old, apiVersion: HUB_API_VERSION + 1 }, self), false, 'another API');
  assert.equal(HubClient.shouldReplace({ ...old, dataDir: '/tmp/elsewhere' }, self), false, 'another data folder');
  assert.equal(HubClient.shouldReplace(old, { ...self, infoPid: 999 }), false, 'a process hub.json does not name');
  assert.equal(HubClient.shouldReplace(old, { ...self, infoPid: null }), false, 'no hub.json');
  assert.equal(HubClient.shouldReplace({ ...old, pid: process.pid }, { ...self, infoPid: process.pid }), false, 'never this process');
});
