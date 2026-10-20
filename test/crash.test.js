// Crashes, in child processes: an app with PeekInside crashes exactly as it would without it, and
// the crash still reaches the local hub (written to a spool file the hub ingests), linked to the
// request it happened in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HubClient } from '../src/hub/client.js';

const ENTRY = pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-crash-home-'));
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-crash-app-'));
const hubPort = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
// The hub started below reads these, like an app would.
process.env.PEEKINSIDE_HOME = home;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const hub = new HubClient(hubPort);
const children = new Set();

// One app for every case: a plain http server whose routes fail in different ways. PeekInside is
// attached when ATTACH=1; everything else, line numbers included, is identical.
const APP = `import http from 'node:http';
const PeekInside = process.env.ATTACH === '1' ? (await import(process.env.ENTRY)).default : null;
const handlesRejections = process.env.APP_HANDLES_REJECTIONS === '1';
const handlesExceptions = process.env.APP_HANDLES_EXCEPTIONS === '1';
if (handlesRejections) {
  process.on('unhandledRejection', (reason) => console.error('app saw: ' + reason.message));
}
if (handlesExceptions) {
  process.on('uncaughtException', (error) => console.error('app kept running after: ' + error.message));
}
const server = http.createServer((req, res) => {
  if (req.url === '/timer') {
    setTimeout(() => {
      throw new Error(handlesExceptions ? 'timer error the app survives' : 'crash in a timer');
    }, 10);
    if (handlesExceptions) setTimeout(() => res.end('still here'), 30);
    return;
  }
  if (req.url === '/handler') {
    throw new Error('crash in the handler');
  }
  if (req.url === '/reject') {
    (async () => {
      await null;
      throw new Error(handlesRejections ? 'rejection the app survives' : 'rejected during a request');
    })();
    if (handlesRejections) setTimeout(() => res.end('still here'), 20);
    return;
  }
  res.end('ok');
});
if (PeekInside) PeekInside.attach(server, { local: true });
server.listen(0, '127.0.0.1', () => {
  console.log('PORT ' + server.address().port);
  if (process.env.CRASH_AT_START === '1') {
    setTimeout(() => {
      throw new TypeError('crash outside any request');
    }, 50);
  }
});
`;

before(async () => {
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'crash-app', type: 'module' }));
  fs.writeFileSync(path.join(appDir, 'app.mjs'), APP);
  hub.spawn();
  assert.ok(await hub.waitUntilReady(8000), 'the hub starts');
});

after(async () => {
  for (const child of children) child.kill('SIGKILL');
  const status = await hub.status().catch(() => null);
  if (status) {
    process.kill(status.pid, 'SIGTERM');
    for (let i = 0; i < 50 && (await hub.status().catch(() => null)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

// Starts the app, sends `route` once it listens, and resolves when it exits (or, for an app that
// keeps running, when `keepRunning` says so).
function runApp({ attach, route, env = {}, keepRunning = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(appDir, 'app.mjs')], {
      cwd: appDir,
      env: { ...process.env, ...env, ATTACH: attach ? '1' : '0', ENTRY, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let port = null;
    child.stdout.on('data', async (chunk) => {
      stdout += chunk;
      const match = /PORT (\d+)/.exec(stdout);
      if (!match || port) return;
      port = Number(match[1]);
      if (!route) return;
      const first = await get(port, route).catch(() => null);
      if (keepRunning) {
        try {
          resolve(await keepRunning({ port, first, child, output: () => ({ stdout, stderr }) }));
        } catch (error) {
          reject(error);
        } finally {
          child.kill('SIGTERM');
        }
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (!keepRunning) resolve({ code, signal, stdout, stderr });
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

// What the hub has for the app, once an exception matching `message` is there.
async function fromHub(message) {
  for (let i = 0; i < 100; i++) {
    const { projects } = await hub.request('GET', '/api/projects');
    const project = projects.find((item) => item.name === 'crash-app');
    if (project) {
      const { exceptions } = await hub.request('GET', `/api/projects/${project.id}/exceptions`);
      const exception = exceptions.find((item) => item.message === message);
      if (exception) {
        const { requests } = await hub.request('GET', `/api/projects/${project.id}/requests`);
        return { project, exception, requests };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`the hub never got "${message}"`);
}

function spoolFiles() {
  const root = path.join(home, 'spool');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((folder) => fs.readdirSync(path.join(root, folder)).map((name) => path.join(folder, name)));
}

async function assertLinkedCrash(message, route, mechanism) {
  const { project, exception, requests } = await fromHub(message);
  assert.equal(exception.mechanism, mechanism);
  assert.equal(exception.fatal, true);
  assert.equal(exception.handled, false);
  const request = requests.find((item) => item.id === exception.requestId);
  assert.ok(request, 'linked to a stored request');
  assert.equal(request.url, route);
  assert.equal(request.aborted, true, 'recorded as aborted: the process died before answering');
  assert.equal(request.status, null);
  assert.equal(request.exceptionCount, 1);
  const { detail } = await hub.request('GET', `/api/projects/${project.id}/requests/${request.id}`);
  assert.deepEqual(detail.exceptions, [{ id: exception.id, name: 'Error', message }]);
  const exceptionDetail = (await hub.request('GET', `/api/projects/${project.id}/exceptions/${exception.id}`)).detail;
  assert.equal(exceptionDetail.request.id, request.id);
  assert.ok(exceptionDetail.frames[0].inApp, 'the app\'s own frame comes first');
  assert.equal(exceptionDetail.frames[0].relativeFile, 'app.mjs');
  assert.ok(exceptionDetail.frames[0].context.lines.some((line) => line.includes(message)));
  return { exception, exceptionDetail };
}

test('an uncaught exception crashes the same way, and the hub gets it', async () => {
  const without = await runApp({ attach: false, route: '/timer' });
  const withPeek = await runApp({ attach: true, route: '/timer' });
  assert.equal(without.code, 1);
  assert.equal(withPeek.code, 1);
  assert.equal(withPeek.stderr, without.stderr, 'same output');
  assert.match(withPeek.stderr, /Error: crash in a timer/);

  const { exceptionDetail } = await assertLinkedCrash('crash in a timer', '/timer', 'uncaught');
  assert.equal(exceptionDetail.process.platform, process.platform);
  for (let i = 0; i < 30 && spoolFiles().length; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(spoolFiles(), [], 'the hub deletes spool files it ingested');
});

test('an error thrown by a request listener is linked to its request', async () => {
  const without = await runApp({ attach: false, route: '/handler' });
  const withPeek = await runApp({ attach: true, route: '/handler' });
  assert.equal(without.code, 1);
  assert.equal(withPeek.code, 1);
  // The listener runs inside PeekInside's wrapper, so its frames are on the stack; the rest of
  // the output, including the line Node.js points at, is the same.
  const head = (stderr) => stderr.split('\n    at ')[0];
  assert.equal(head(withPeek.stderr), head(without.stderr));
  assert.match(head(withPeek.stderr), /app\.mjs:\d+\n {4}throw new Error\('crash in the handler'\);\n {4}\^/);
  await assertLinkedCrash('crash in the handler', '/handler', 'http');
});

test('an unhandled rejection still crashes the same way, and the hub gets it', async () => {
  const without = await runApp({ attach: false, route: '/reject' });
  const withPeek = await runApp({ attach: true, route: '/reject' });
  assert.equal(without.code, 1);
  assert.equal(withPeek.code, 1);
  assert.equal(withPeek.stderr, without.stderr, 'same output');
  await assertLinkedCrash('rejected during a request', '/reject', 'unhandledRejection');
});

// The request an exception is linked to, once the hub has it.
async function linkedRequest(project, exception) {
  for (let i = 0; i < 50; i++) {
    const { requests } = await hub.request('GET', `/api/projects/${project.id}/requests`);
    const request = requests.find((item) => item.id === exception.requestId);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the request never arrived');
}

test('an app with its own unhandledRejection listener keeps running, and the rejection is recorded', async () => {
  const result = await runApp({
    attach: true,
    route: '/reject',
    env: { APP_HANDLES_REJECTIONS: '1' },
    keepRunning: async ({ port, first, output }) => {
      assert.equal(first.text, 'still here', 'the request was answered after the rejection');
      assert.equal((await get(port, '/ok')).text, 'ok', 'the app keeps running');
      // Its request is recorded once answered: the app's last batches reach the hub.
      const { project, exception } = await fromHub('rejection the app survives');
      return { ...output(), project, exception, request: await linkedRequest(project, exception) };
    }
  });
  assert.match(result.stderr, /app saw: rejection the app survives/, 'the app\'s listener ran');
  assert.equal(result.exception.mechanism, 'unhandledRejection');
  assert.equal(result.exception.fatal, false);
  assert.equal(result.exception.handled, true);
  assert.equal(result.request.url, '/reject');
  assert.equal(result.request.status, 200);
  assert.equal(result.request.exceptionCount, 1);
});

test('an app that handles uncaught exceptions itself is not counted as crashed', async () => {
  const result = await runApp({
    attach: true,
    route: '/timer',
    env: { APP_HANDLES_EXCEPTIONS: '1' },
    keepRunning: async ({ port, first, output }) => {
      assert.equal(first.text, 'still here');
      assert.equal((await get(port, '/ok')).text, 'ok');
      const { project, exception } = await fromHub('timer error the app survives');
      return { ...output(), exception, request: await linkedRequest(project, exception) };
    }
  });
  assert.match(result.stderr, /app kept running after: timer error the app survives/);
  assert.equal(result.exception.mechanism, 'uncaught');
  assert.equal(result.exception.fatal, false);
  assert.equal(result.exception.handled, false);
  assert.equal(result.request.status, 200);
  assert.equal(result.request.exceptionCount, 1);
});

test('a crash outside any request is recorded without one', async () => {
  const without = await runApp({ attach: false, env: { CRASH_AT_START: '1' } });
  const withPeek = await runApp({ attach: true, env: { CRASH_AT_START: '1' } });
  assert.equal(withPeek.code, 1);
  assert.equal(withPeek.stderr, without.stderr);
  const { exception } = await fromHub('crash outside any request');
  assert.equal(exception.name, 'TypeError');
  assert.equal(exception.fatal, true);
  assert.equal(exception.requestId, null);
  assert.equal(exception.request, null);
});
