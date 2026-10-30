// Where requests go: the site (the dashboard interface) and PeekInside Cloud's API (ingest, alert
// rules, the MCP server), by default and from the environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Settings } from '../src/config.js';

test('by default, the site on www and the API on its own host, not through the site', () => {
  const settings = new Settings({});
  assert.equal(settings.siteUrl(), 'https://www.peekinside.dev');
  assert.equal(settings.apiUrl(), 'https://api.peekinside.dev');
});

test('with only PEEKINSIDE_URL set, the API is reached through that site', () => {
  const settings = new Settings({ PEEKINSIDE_URL: 'http://localhost:4000/anything' });
  assert.equal(settings.siteUrl(), 'http://localhost:4000');
  assert.equal(settings.apiUrl(), 'http://localhost:4000');
});

test('PEEKINSIDE_API_URL sets the API, whatever the site', () => {
  const settings = new Settings({ PEEKINSIDE_URL: 'http://localhost:4000', PEEKINSIDE_API_URL: 'http://localhost:4200/' });
  assert.equal(settings.siteUrl(), 'http://localhost:4000');
  assert.equal(settings.apiUrl(), 'http://localhost:4200');
});

test("an invalid URL is reported and ignored, so a typo can't send data elsewhere", (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(new Settings({ PEEKINSIDE_API_URL: 'ftp://example.com' }).apiUrl(), 'https://api.peekinside.dev');
  assert.equal(new Settings({ PEEKINSIDE_URL: 'not a url' }).apiUrl(), 'https://api.peekinside.dev');
  assert.equal(new Settings({ PEEKINSIDE_URL: 'not a url' }).siteUrl(), 'https://www.peekinside.dev');
  assert.equal(warn.mock.callCount(), 3);
  assert.match(String(warn.mock.calls[0].arguments[0]), /Ignoring PEEKINSIDE_API_URL/);
});
