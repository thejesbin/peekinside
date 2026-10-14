// Job runs and log lines: PeekInside.job(), the job libraries (node-cron, cron, BullMQ), and lines
// from the console, pino and winston, linked to their request or job run, reaching a hub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import winston from 'winston';
import nodeCron from 'node-cron';
import { CronJob } from 'cron';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';
import { JobInstrumentation } from '../src/instrumentation/jobs.js';
import { LoggerInstrumentation } from '../src/instrumentation/loggers.js';

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-jobs-'));
process.env.PEEKINSIDE_HOME = dataDir;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(dataDir).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir });

before(() => new Promise((resolve) => hub.listen(resolve)));
after(() => {
  hub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A logger's output, kept out of the test's own output.
const sink = () => new Writable({ write(chunk, encoding, done) { done(); } });

// What the hub stored for a project once `ready` holds.
async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = {
        project,
        jobs: store.listJobs(project.id, { limit: 1000 }).jobs.reverse(),
        logs: store.listLogs(project.id, { limit: 1000 }).logs.reverse(),
        exceptions: store.listExceptions(project.id, { limit: 1000 }).exceptions.reverse(),
        requests: store.list(project.id, { limit: 1000 }).requests.reverse()
      };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { jobs: result.jobs.length, logs: result.logs.map((line) => line.message) })}`);
}

test('PeekInside.job(): runs, failures as exceptions, and what ran inside linked to the run', async () => {
  const peekInside = new PeekInside({ project: 'jobs-api', local: true });
  try {
    const value = await PeekInside.job('send-invoices', async () => {
      console.log('sending 3 invoices');
      await pause(20);
      return 3;
    }, { schedule: '0 * * * *', data: { batch: 7 } });
    assert.equal(value, 3, 'the job returns what it returns');

    const failure = new Error('SMTP connection refused');
    await assert.rejects(peekInside.job('send-invoices', async () => {
      throw failure;
    }, { schedule: '0 * * * *', attempt: 2 }), failure, 'and throws what it throws');
    assert.equal(peekInside.job('sync', () => 'done'), 'done', 'sync jobs too');

    const result = await stored(peekInside, 'jobs-api', (state) => state.jobs.length === 3 && state.exceptions.length === 1);
    const [ok, failed, sync] = result.jobs;
    assert.equal(ok.name, 'send-invoices');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.schedule, '0 * * * *');
    assert.equal(ok.trigger, 'cron');
    assert.ok(ok.duration >= 15);
    assert.equal(ok.stats.logs, 1, 'its console line is on its timeline');
    assert.deepEqual(store.jobDetail(result.project.id, ok.id).data, { batch: 7 });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempt, 2);
    assert.deepEqual(failed.error, { name: 'Error', message: 'SMTP connection refused' });
    assert.equal(failed.exceptionCount, 1);
    assert.equal(sync.trigger, 'manual');

    const [exception] = result.exceptions;
    assert.equal(exception.mechanism, 'job');
    assert.equal(exception.handled, false);
    assert.equal(exception.jobRunId, failed.id);
    assert.deepEqual(exception.job, { name: 'send-invoices' });
    assert.equal(exception.requestId, null);

    const line = result.logs.find((item) => item.message === 'sending 3 invoices');
    assert.ok(line, 'the line reached the Logs page');
    assert.equal(line.jobRunId, ok.id);
    assert.equal(line.source, 'console');
  } finally {
    peekInside.stop();
  }
});

test('log lines: outside and inside requests, at or above logLevel, never PeekInside\'s own', async () => {
  const app = express();
  app.set('env', 'test');
  const peekInside = PeekInside.attach(app, { project: 'logs-api', local: true, logLevel: 'info' });
  app.get('/orders', (req, res) => {
    console.warn('stock is low for SKU-1042');
    res.json([]);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    console.info('listening on a test port');
    console.debug('cache primed');
    console.log('[peekinside] never recorded');
    await new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/orders' }, (res) => res.resume().on('end', resolve)));

    const result = await stored(peekInside, 'logs-api', (state) => state.logs.length >= 2 && state.requests.length === 1);
    const messages = result.logs.map((line) => line.message);
    assert.ok(messages.includes('listening on a test port'));
    assert.ok(!messages.includes('cache primed'), 'debug is below logLevel');
    assert.ok(!messages.some((message) => message.startsWith('[peekinside]')));
    const warning = result.logs.find((line) => line.message === 'stock is low for SKU-1042');
    assert.equal(warning.level, 'warn');
    assert.equal(warning.requestId, result.requests[0].id);
    const outside = result.logs.find((line) => line.message === 'listening on a test port');
    assert.equal(outside.requestId, null);
    assert.deepEqual(store.logDetail(result.project.id, outside.id), { message: 'listening on a test port' });
  } finally {
    peekInside.stop();
    server.close();
  }
});

test('pino and winston lines, with their level and data; levels a logger turned off are skipped', async () => {
  assert.equal(LoggerInstrumentation.pino(pino), true);
  assert.equal(LoggerInstrumentation.winston(winston), true);
  const peekInside = new PeekInside({ project: 'loggers-api', local: true });
  try {
    const logger = pino({ level: 'info' }, sink());
    logger.info({ orderId: 42 }, 'order %s paid', 'A-17');
    logger.debug('not written');
    logger.child({ worker: 3 }).error(new Error('queue stalled'));
    const wlogger = winston.createLogger({ level: 'warn', transports: [new winston.transports.Stream({ stream: sink() })] });
    wlogger.warn('disk 91% full', { volume: '/data' });
    wlogger.info('not written either');

    const result = await stored(peekInside, 'loggers-api', (state) => state.logs.length >= 3);
    const byMessage = Object.fromEntries(result.logs.map((line) => [line.message, line]));
    assert.equal(byMessage['order A-17 paid'].source, 'pino');
    assert.equal(byMessage['order A-17 paid'].level, 'info');
    assert.deepEqual(store.logDetail(result.project.id, byMessage['order A-17 paid'].id).fields, { orderId: 42 });
    assert.equal(byMessage['queue stalled'].level, 'error');
    assert.equal(byMessage['disk 91% full'].source, 'winston');
    assert.equal(byMessage['disk 91% full'].level, 'warn');
    assert.deepEqual(store.logDetail(result.project.id, byMessage['disk 91% full'].id).fields, { volume: '/data' });
    assert.ok(!byMessage['not written'] && !byMessage['not written either']);
  } finally {
    peekInside.stop();
  }
});

test('node-cron and cron tasks run as job runs with their schedule', async () => {
  assert.equal(JobInstrumentation.nodeCron(nodeCron), true);
  assert.equal(JobInstrumentation.cron({ CronJob }), true);
  const peekInside = new PeekInside({ project: 'cron-api', local: true });
  const task = nodeCron.schedule('* * * * * *', () => {}, { name: 'heartbeat' });
  const job = CronJob.from({ cronTime: '* * * * * *', onTick: () => {}, start: true, name: 'cleanup' });
  try {
    const result = await stored(peekInside, 'cron-api', (state) => ['heartbeat', 'cleanup'].every((name) => state.jobs.some((run) => run.name === name)));
    const heartbeat = result.jobs.find((run) => run.name === 'heartbeat');
    assert.equal(heartbeat.schedule, '* * * * * *');
    assert.equal(heartbeat.trigger, 'cron');
    assert.equal(heartbeat.status, 'ok');
    assert.equal(result.jobs.find((run) => run.name === 'cleanup').schedule, '* * * * * *');
  } finally {
    task.destroy();
    job.stop();
    peekInside.stop();
  }
});

test('BullMQ workers: each job a run, with its queue, attempt, data and repeat schedule', async () => {
  const { Worker } = await import('bullmq');
  assert.equal(typeof Worker.prototype.callProcessJob, 'function', 'the method PeekInside wraps exists');

  class FakeWorker {
    constructor(name, processFn) {
      this.name = name;
      this.processFn = processFn;
    }

    callProcessJob(job, token) {
      return this.processFn(job, token);
    }
  }
  assert.equal(JobInstrumentation.bullmq({ Worker: FakeWorker }), true);
  const peekInside = new PeekInside({ project: 'queue-api', local: true });
  try {
    const worker = new FakeWorker('emails', async (job) => `sent ${job.data.to}`);
    assert.equal(await worker.callProcessJob({ name: 'welcome', data: { to: 'ada@example.test' }, attemptsMade: 1, opts: {} }, 'token'), 'sent ada@example.test');
    await worker.callProcessJob({ name: 'digest', data: {}, attemptsMade: 0, opts: { repeat: { pattern: '0 8 * * 1', tz: 'Europe/Paris' } } });

    const result = await stored(peekInside, 'queue-api', (state) => state.jobs.length === 2);
    const [welcome, digest] = result.jobs;
    assert.equal(welcome.name, 'welcome');
    assert.equal(welcome.queue, 'emails');
    assert.equal(welcome.attempt, 2);
    assert.equal(welcome.trigger, 'queue');
    assert.deepEqual(store.jobDetail(result.project.id, welcome.id).data, { to: 'ada@example.test' });
    assert.equal(digest.schedule, '0 8 * * 1');
    assert.equal(digest.timezone, 'Europe/Paris');
    assert.equal(digest.trigger, 'cron');
  } finally {
    peekInside.stop();
  }
});
