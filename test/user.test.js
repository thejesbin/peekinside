import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserInfo } from '../src/user.js';

test('a user can be named by phone, under the names apps give it', () => {
  for (const user of [{ phone: '+91 98765 43210' }, { phoneNumber: '+91 98765 43210' }, { phone_number: '+91 98765 43210' }, { mobile: ' +91 98765 43210 ' }]) {
    assert.deepEqual(UserInfo.normalize(user), { id: null, email: null, name: null, phone: '+91 98765 43210' }, JSON.stringify(user));
  }
  assert.equal(UserInfo.normalize({ phone: 919876543210 }).phone, '919876543210', 'numbers as their digits');
  assert.equal(UserInfo.normalize({ phone: 919876543210n }).phone, '919876543210', 'and bigints (database ids often are)');
  assert.equal(UserInfo.normalize({ phone: { country: '+91' } }), null, 'anything else is no phone');
  assert.equal(UserInfo.normalize({ phone: '9'.repeat(40) }).phone.length, 32, 'kept short');
});

test('users are told apart by id, then email, then phone, then name', () => {
  assert.equal(UserInfo.key({ id: null, email: null, name: 'Ada', phone: '+91 98765 43210' }), '+91 98765 43210');
  assert.equal(UserInfo.key({ id: '42', email: 'ada@example.test', name: 'Ada', phone: '+91 98765 43210' }), '42');
  assert.equal(UserInfo.key({ id: null, email: null, name: 'Ada', phone: null }), 'Ada');
});
