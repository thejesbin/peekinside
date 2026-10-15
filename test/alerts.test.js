// Alert rules on sealed fields: the SDK checks them before sealing and reports only which record
// met which rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleMatcher } from '../src/alerts/rule-matcher.js';
import { RequestRecord } from '../src/record.js';
import { ExceptionRecord } from '../src/exceptions/exception-record.js';
import { LogRecord } from '../src/logs/log-record.js';

const request = (path, user, body) =>
  new RequestRecord({
    id: '6f1c2b9a-3d4e-4f50-8a6b-7c8d9e0f1a2b',
    occurredAt: Date.now(),
    environment: 'production',
    method: 'POST',
    status: 402,
    duration: 120,
    requestSize: 0,
    responseSize: 40,
    aborted: false,
    summary: { url: path, path, contentType: 'application/json', ...(user ? { user } : {}) },
    detail: { response: { body } }
  });

async function matcher(rules) {
  const found = new RuleMatcher({ fetchRules: async () => ({ rules }) });
  await found.refresh();
  return found;
}

test('a request meets a rule on its path, user and response', async () => {
  const rules = await matcher([
    { id: 'rlcheckout0000', source: 'requests', conditions: [{ field: 'path', op: 'matches', value: '/api/checkout*' }, { field: 'response', op: 'contains', value: 'insufficient_funds' }] },
    { id: 'rlvip000000000', source: 'requests', conditions: [{ field: 'user', op: 'is', value: 'ADA@example.com' }] },
    { id: 'rlelsewhere000', source: 'requests', conditions: [{ field: 'path', op: 'is', value: '/health' }] }
  ]);
  const record = request('/api/checkout/pay', { id: 'u_42', email: 'ada@example.com' }, '{"error":"insufficient_funds"}');
  assert.deepEqual(rules.matches(record), [
    { rule: 'rlcheckout0000', id: record.id },
    { rule: 'rlvip000000000', id: record.id }
  ]);
  assert.deepEqual(rules.matches(request('/api/checkout/pay', null, '{"ok":true}')), [], 'another response, another user');
});

test('exceptions and log lines meet rules on their messages', async () => {
  const rules = await matcher([
    { id: 'rlrefused00000', source: 'exceptions', conditions: [{ field: 'message', op: 'contains', value: 'econnrefused' }] },
    { id: 'rlpayments0000', source: 'logs', conditions: [{ field: 'message', op: 'contains', value: 'payment failed' }] }
  ]);
  const exception = new ExceptionRecord({
    id: '0a1b2c3d-0000-4000-8000-000000000001',
    occurredAt: Date.now(),
    environment: 'production',
    handled: false,
    fatal: false,
    requestId: null,
    summary: { name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
    detail: {}
  });
  assert.deepEqual(rules.matches(exception), [{ rule: 'rlrefused00000', id: exception.id }]);
  const line = new LogRecord({ id: '0a1b2c3d-0000-4000-8000-000000000002', occurredAt: Date.now(), environment: 'production', level: 'error', source: 'console', summary: { message: 'Payment failed for order 42' } });
  assert.deepEqual(rules.matches(line), [{ rule: 'rlpayments0000', id: line.id }]);
});

test('without rules, or with malformed ones, nothing is reported; a failed fetch keeps the last rules', async () => {
  const rules = await matcher([{ id: 'not-a-rule', source: 'requests', conditions: [{ field: 'path', op: 'is', value: '/' }] }, { id: 'rlempty0000000', source: 'requests', conditions: [] }]);
  assert.equal(rules.rules.length, 0);
  let calls = 0;
  const flaky = new RuleMatcher({
    fetchRules: async () => {
      calls++;
      if (calls > 1) throw new Error('down');
      return { rules: [{ id: 'rlkeep00000000', source: 'requests', conditions: [{ field: 'path', op: 'is', value: '/a' }] }] };
    }
  });
  await flaky.refresh();
  await flaky.refresh();
  assert.equal(flaky.rules.length, 1);
});
