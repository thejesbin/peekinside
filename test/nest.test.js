// Integration: real NestJS apps, on Express and on Fastify, reach a hub: their requests with the
// route and the controller method, the errors Nest answers (handled by the app's filters or not),
// the lines of Nest's Logger and the runs of @nestjs/schedule jobs. The apps answer exactly as they
// would without PeekInside. The hub runs in this process, so no background process is started.
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Body, Catch, ConsoleLogger, Controller, Get, Inject, Injectable, Logger, Module, NotFoundException, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { BaseExceptionFilter, NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Cron, Interval, ScheduleModule, Timeout } from '@nestjs/schedule';
import PeekInside from '../index.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-nest-'));
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

function send(port, method, target, { body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// What the hub stored for a project, oldest first, once `ready` holds.
async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = {
        project,
        requests: store.list(project.id, { limit: 1000 }).requests.reverse(),
        exceptions: store.listExceptions(project.id, { limit: 1000 }).exceptions.reverse(),
        logs: store.listLogs(project.id, { limit: 1000 }).logs.reverse(),
        jobs: store.listJobs(project.id, { limit: 1000 }).jobs.reverse()
      };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { requests: result.requests.map((item) => item.url), exceptions: result.exceptions.map((item) => item.message), jobs: result.jobs.map((item) => item.name) })}`);
}

// Decorators as TypeScript compiles them (this file is plain JavaScript).
function decorate(target, decorators) {
  Reflect.decorate(decorators, target);
}

function decorateMethod(Class, name, decorators, params = []) {
  const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, name);
  const changed = Reflect.decorate(decorators, Class.prototype, name, descriptor);
  if (changed) Object.defineProperty(Class.prototype, name, changed);
  params.forEach((decorator, index) => decorator(Class.prototype, name, index));
}

// Nest's console logger with its output dropped: lines still go through printMessages().
class QuietLogger extends ConsoleLogger {
  formatMessage() {
    return '';
  }

  printStackTrace() {}
}

class PaymentError extends Error {}

class OrdersService {
  logger = new Logger(OrdersService.name);

  find(id) {
    this.logger.log(`Looking up order ${id}`);
    if (id === '0') throw new NotFoundException(`No order ${id}`);
    if (id === '13') throw new Error('order 13 is cursed');
    return { id };
  }
}
decorate(OrdersService, [Injectable()]);

// Answers payment errors itself.
class PaymentFilter {
  catch(error, host) {
    const response = host.switchToHttp().getResponse();
    const body = { error: 'payment_failed', message: error.message };
    if (typeof response.json === 'function') response.status(402).json(body);
    else response.code(402).send(body);
  }
}
decorate(PaymentFilter, [Catch(PaymentError)]);

// Notes the error, then leaves the answer to Nest.
class ReportingFilter extends BaseExceptionFilter {
  catch(exception, host) {
    return super.catch(exception, host);
  }
}
decorate(ReportingFilter, [Catch()]);

class BrokenGuard {
  canActivate() {
    return undefined.allowed;
  }
}
decorate(BrokenGuard, [Injectable()]);

class OrdersController {
  constructor(orders) {
    this.orders = orders;
  }

  find(id) {
    return this.orders.find(id);
  }

  create(body) {
    return { created: body };
  }

  charge() {
    throw new PaymentError('card declined');
  }

  audit() {
    throw new Error('audit log offline');
  }

  admin() {
    return { ok: true };
  }
}
decorate(OrdersController, [Controller('orders')]);
Inject(OrdersService)(OrdersController, undefined, 0);
decorateMethod(OrdersController, 'find', [Get(':id')], [Param('id')]);
decorateMethod(OrdersController, 'create', [Post()], [Body()]);
decorateMethod(OrdersController, 'charge', [Post(':id/charge'), UseFilters(PaymentFilter)]);
decorateMethod(OrdersController, 'audit', [Get(':id/audit'), UseFilters(ReportingFilter)]);
decorateMethod(OrdersController, 'admin', [Get('admin/panel'), UseGuards(BrokenGuard)]);

class OrdersModule {}
decorate(OrdersModule, [Module({ controllers: [OrdersController], providers: [OrdersService] })]);

// The same app on either platform, with or without PeekInside; listening on a free port.
async function nestApp(platform, peekName) {
  const adapter = platform === 'fastify' ? new FastifyAdapter() : new ExpressAdapter();
  const app = await NestFactory.create(OrdersModule, adapter, { logger: new QuietLogger() });
  const peekInside = peekName ? PeekInside.attach(app, { project: peekName, local: true }) : null;
  await app.listen(0, '127.0.0.1');
  return { app, peekInside, port: app.getHttpServer().address().port };
}

async function exercise(port) {
  return {
    found: await send(port, 'GET', '/orders/7'),
    missing: await send(port, 'GET', '/orders/0'),
    cursed: await send(port, 'GET', '/orders/13'),
    created: await send(port, 'POST', '/orders', { body: JSON.stringify({ sku: 'A-1', qty: 2 }) }),
    charged: await send(port, 'POST', '/orders/7/charge'),
    audited: await send(port, 'GET', '/orders/7/audit'),
    admin: await send(port, 'GET', '/orders/admin/panel'),
    unknown: await send(port, 'GET', '/nowhere')
  };
}

for (const platform of ['express', 'fastify']) {
  test(`NestJS on ${platform}: routes, handlers, errors and logs, with the app's answers unchanged`, async () => {
    const plain = await nestApp(platform);
    const expected = await exercise(plain.port);
    await plain.app.close();

    const name = `nest-${platform}`;
    const { app, peekInside, port } = await nestApp(platform, name);
    try {
      const answers = await exercise(port);
      assert.deepEqual(answers, expected, 'every answer is the same with PeekInside');
      assert.equal(answers.cursed.status, 500);
      assert.equal(answers.charged.status, 402);

      const result = await stored(peekInside, name, (r) => r.requests.length >= 8 && r.exceptions.length >= 4 && r.logs.some((line) => line.level === 'error'));
      assert.equal(result.project.instances[0].framework, 'nest');
      const byUrl = Object.fromEntries(result.requests.map((request) => [`${request.method} ${request.url}`, request]));

      const found = byUrl['GET /orders/7'];
      assert.equal(found.route, '/orders/:id');
      assert.equal(found.handler, 'OrdersController.find');
      assert.deepEqual(store.detail(result.project.id, found.id).params, { id: '7' });
      assert.equal(byUrl['POST /orders'].route, '/orders');
      assert.equal(byUrl['POST /orders'].handler, 'OrdersController.create');
      assert.equal(store.detail(result.project.id, byUrl['POST /orders'].id).body, '{"sku":"A-1","qty":2}', 'the body is captured as it arrives');
      assert.equal(byUrl['GET /orders/admin/panel'].handler, 'OrdersController.admin', 'known before the guard runs');
      assert.equal(byUrl['GET /nowhere'].route, null, 'no route matched');
      assert.equal(byUrl['GET /nowhere'].handler, null);

      const byMessage = Object.fromEntries(result.exceptions.map((exception) => [exception.message, exception]));
      assert.equal(byMessage['No order 0'], undefined, '4xx answers are not exceptions');
      const cursed = byMessage['order 13 is cursed'];
      assert.equal(cursed.mechanism, 'nest');
      assert.equal(cursed.handled, false, "Nest's default answer");
      assert.equal(cursed.requestId, byUrl['GET /orders/13'].id);
      assert.deepEqual(cursed.request, { method: 'GET', path: '/orders/13', route: '/orders/:id', handler: 'OrdersController.find' });
      assert.equal(byMessage['card declined'].handled, true, "the app's filter answers it");
      assert.equal(byMessage['card declined'].requestId, byUrl['POST /orders/7/charge'].id);
      assert.equal(byMessage['audit log offline'].handled, false, 'a filter that hands it to super.catch()');
      const guard = result.exceptions.find((exception) => exception.name === 'TypeError');
      assert.ok(guard, 'an error in a guard');
      assert.equal(guard.handled, false);
      assert.equal(guard.request.handler, 'OrdersController.admin');
      assert.equal(guard.requestId, byUrl['GET /orders/admin/panel'].id);
      assert.equal(byUrl['GET /orders/13'].exceptionCount, 1);

      const lookup = result.logs.find((line) => line.message === '[OrdersService] Looking up order 7');
      assert.ok(lookup, "Nest's Logger lines are recorded");
      assert.equal(lookup.source, 'nest');
      assert.equal(lookup.level, 'info');
      assert.equal(lookup.requestId, found.id);
      assert.deepEqual(store.logDetail(result.project.id, lookup.id).fields, { context: 'OrdersService' });
      const failure = result.logs.find((line) => line.level === 'error' && line.message.includes('order 13 is cursed'));
      assert.ok(failure, "Nest's own error line");
      assert.equal(failure.message, '[ExceptionsHandler] Error: order 13 is cursed');
      assert.equal(failure.requestId, byUrl['GET /orders/13'].id);
      assert.ok(!result.logs.some((line) => /\[(RoutesResolver|RouterExplorer|InstanceLoader|NestApplication)\]/.test(line.message)), "Nest's startup lines are left out");
    } finally {
      await app.close();
      peekInside.stop();
    }
  });
}

test('@nestjs/schedule: @Cron, @Interval and @Timeout methods are job runs, failures included', async () => {
  class TasksService {
    sweeps = 0;

    sweep() {
      this.sweeps++;
      if (this.sweeps === 1) throw new Error('sweep failed');
    }

    async report() {
      await pause(5);
    }

    warmUp() {}
  }
  decorate(TasksService, [Injectable()]);
  decorateMethod(TasksService, 'sweep', [Interval(25)]);
  decorateMethod(TasksService, 'report', [Cron('* * * * * *', { name: 'hourly-report', timeZone: 'Asia/Kolkata' })]);
  decorateMethod(TasksService, 'warmUp', [Timeout(10)]);

  class TasksModule {}
  decorate(TasksModule, [Module({ imports: [ScheduleModule.forRoot()], providers: [TasksService] })]);

  // A worker: an application context, without an HTTP server, initialized as it is created.
  // PeekInside is created first.
  const peekInside = new PeekInside({ project: 'nest-tasks', local: true });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const app = await NestFactory.createApplicationContext(TasksModule, { logger: new QuietLogger() });
  peekInside.attachTo(app);
  console.warn = warn;
  try {
    assert.deepEqual(warnings, [], 'the jobs were set up after PeekInside');
    const result = await stored(peekInside, 'nest-tasks', (r) => r.jobs.filter((run) => run.name === 'TasksService.sweep').length >= 2 && r.jobs.some((run) => run.name === 'hourly-report') && r.jobs.some((run) => run.name === 'TasksService.warmUp'));
    const sweeps = result.jobs.filter((run) => run.name === 'TasksService.sweep');
    assert.equal(sweeps[0].status, 'failed', 'the scheduler swallows the error, the run records it');
    assert.deepEqual(sweeps[0].error, { name: 'Error', message: 'sweep failed' });
    assert.equal(sweeps[0].schedule, '@every 25ms');
    assert.equal(sweeps[0].trigger, 'cron');
    assert.equal(sweeps[1].status, 'ok');
    const failed = result.exceptions.find((exception) => exception.message === 'sweep failed');
    assert.equal(failed.mechanism, 'job');
    assert.equal(failed.jobRunId, sweeps[0].id);

    const report = result.jobs.find((run) => run.name === 'hourly-report');
    assert.equal(report.schedule, '* * * * * *');
    assert.equal(report.timezone, 'Asia/Kolkata');
    assert.equal(report.status, 'ok');
    const warmUp = result.jobs.find((run) => run.name === 'TasksService.warmUp');
    assert.equal(warmUp.schedule, null, 'a timeout runs once');
    assert.ok(!result.jobs.some((run) => run.name.startsWith('cron ')), 'cron fires them, and they are recorded once');
    assert.ok(result.logs.some((line) => line.source === 'nest' && line.level === 'error' && line.message.includes('sweep failed')), "the scheduler's own error line");
  } finally {
    await app.close();
    peekInside.stop();
  }
});

test('a worker set up before PeekInside existed: the app is told its jobs are not all recorded', async () => {
  // Its own process: the scheduler of this one is patched already.
  const script = `
    import 'reflect-metadata';
    import { Injectable, Module } from '@nestjs/common';
    import { NestFactory } from '@nestjs/core';
    import { Interval, ScheduleModule } from '@nestjs/schedule';
    import PeekInside from './index.js';
    class Tasks { tick() {} }
    Reflect.decorate([Injectable()], Tasks);
    Reflect.decorate([Interval(60000)], Tasks.prototype, 'tick', Object.getOwnPropertyDescriptor(Tasks.prototype, 'tick'));
    class Worker {}
    Reflect.decorate([Module({ imports: [ScheduleModule.forRoot()], providers: [Tasks] })], Worker);
    const app = await NestFactory.createApplicationContext(Worker, { logger: false });
    const peekInside = PeekInside.attach(app, { project: 'nest-late', local: true });
    await app.close();
    peekInside.stop();
  `;
  const { code, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ code: exitCode, stderr: output }));
  });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /set up its scheduled jobs before PeekInside existed/);
});
