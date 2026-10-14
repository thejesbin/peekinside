import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Release } from '../src/release.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER = '0123456789abcdef0123456789abcdef01234567';
const CLI = fileURLToPath(new URL('../bin/peekinside.js', import.meta.url));

let scratch;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-release-'));
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function folder(name, files = {}) {
  const dir = path.join(scratch, name);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('normalize keeps labels the dashboard can store', () => {
  assert.equal(Release.normalize('  v2.4.0  '), 'v2.4.0');
  assert.equal(Release.normalize('feature/login fix!'), 'feature/login-fix');
  assert.equal(Release.normalize('x'.repeat(80)).length, 64);
  assert.equal(Release.normalize('!!!'), null);
  assert.equal(Release.normalize(''), null);
  assert.equal(Release.normalize(42), null);
});

test('detect prefers the option, then PEEKINSIDE_RELEASE, then the platform, then git', () => {
  const repo = folder('detect', { '.git/HEAD': `${COMMIT}\n` });
  assert.equal(Release.detect({ explicit: 'v3', env: { PEEKINSIDE_RELEASE: 'v2', VERCEL_GIT_COMMIT_SHA: OTHER }, root: repo }), 'v3');
  assert.equal(Release.detect({ env: { PEEKINSIDE_RELEASE: 'v2', VERCEL_GIT_COMMIT_SHA: OTHER }, root: repo }), 'v2');
  assert.equal(Release.detect({ env: { RENDER_GIT_COMMIT: OTHER, GITHUB_SHA: COMMIT }, root: repo }), OTHER, 'the host before CI');
  assert.equal(Release.detect({ env: {}, root: repo }), COMMIT);
  assert.equal(Release.detect({ env: { PEEKINSIDE_RELEASE: '   ' } }), null);
});

test('gitCommit reads branches, packed refs, detached heads and worktrees', () => {
  const branch = folder('branch', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${COMMIT}\n` });
  assert.equal(Release.gitCommit(branch), COMMIT);

  const nested = folder('branch/packages/api', { 'package.json': '{}' });
  assert.equal(Release.gitCommit(nested), COMMIT, 'found from a folder inside the repository');

  const packed = folder('packed', {
    '.git/HEAD': 'ref: refs/heads/release/2.4\n',
    '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/main\n${COMMIT} refs/heads/release/2.4\n`
  });
  assert.equal(Release.gitCommit(packed), COMMIT);

  const detached = folder('detached', { '.git/HEAD': `${OTHER}\n` });
  assert.equal(Release.gitCommit(detached), OTHER);

  const main = folder('main-repo', { '.git/refs/heads/feature': `${OTHER}\n`, '.git/worktrees/wt/HEAD': 'ref: refs/heads/feature\n', '.git/worktrees/wt/commondir': '../..\n' });
  const worktree = folder('worktree', { '.git': `gitdir: ${path.join(main, '.git/worktrees/wt')}\n` });
  assert.equal(Release.gitCommit(worktree), OTHER);

  assert.equal(Release.gitCommit(folder('not-a-repo')), null);
  assert.equal(Release.gitCommit(folder('unborn', { '.git/HEAD': 'ref: refs/heads/main\n' })), null, 'a branch without commits');
});

test('short shows commits by their first seven characters', () => {
  assert.equal(Release.short(COMMIT), 'a1b2c3d');
  assert.equal(Release.short('v2.4.0'), 'v2.4.0');
  assert.equal(Release.short(null), '');
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The child gets a clean environment: no API key, no CI commit, its own data folder and hub port.
function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PEEKINSIDE_|NODE_ENV$|CI$)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

test('npx peekinside test sends a test error from the project folder to the local dashboard', async () => {
  const port = await freePort();
  const dataDir = folder('hub-data');
  const store = new Store(dataDir).load();
  const server = new HubServer({ store, port, siteUrl: 'https://peekinside.example', version: 'test', dataDir }).httpServer;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const project = folder('orders-api', {
      'package.json': JSON.stringify({ name: 'orders-api' }),
      '.env.local': 'PEEKINSIDE_RELEASE=v9.9.9\nDATABASE_URL=postgres://not-read\n',
      '.git/HEAD': `${COMMIT}\n`
    });
    const output = await new Promise((resolve, reject) => {
      execFile(process.execPath, [CLI, 'test'], {
        cwd: project,
        env: cleanEnv({ PEEKINSIDE_HUB_PORT: String(port), PEEKINSIDE_HOME: folder('cli-home') }),
        timeout: 30_000
      }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
    });

    const [stored] = store.listProjects();
    assert.equal(stored.name, 'orders-api');
    assert.match(output, new RegExp(`Sent a test error to PeekInside Local: .*/p/${stored.id}/exceptions`));
    assert.match(output, /Release: v9\.9\.9/, 'PEEKINSIDE_ variables are read from .env.local');

    const { exceptions } = store.listExceptions(stored.id, { limit: 10 });
    assert.equal(exceptions.length, 1);
    const [exception] = exceptions;
    assert.equal(exception.name, 'PeekInsideTestError');
    assert.equal(exception.release, 'v9.9.9');
    assert.equal(exception.handled, true);
    assert.equal(exception.request.path, '/peekinside/test');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
