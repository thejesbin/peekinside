// CommonJS apps load the package with require(), which Node.js supports for ES modules from
// 20.19 and 22.12 on. TypeScript's CommonJS output finds the default export through __esModule.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const unsupported = !process.features.require_module && 'require() of ES modules needs Node.js 20.19+ or 22.12+';

test('CommonJS apps can require() the package', { skip: unsupported }, () => {
  const peekinside = require('peekinside');
  assert.equal(peekinside.__esModule, true);
  assert.equal(typeof peekinside.default, 'function');
  assert.equal(peekinside.default.name, 'PeekInside');
  assert.equal(typeof peekinside.default.attach, 'function');
});
