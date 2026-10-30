// Mail previews: every email the app sends with nodemailer reaches the local dashboard's Mail page
// as its transport got it (templates rendered), with how the transport answered, the app's line
// that sent it, and the request or job run it belongs to (listed on the request and placed on its
// timeline). Both of nodemailer's builds are covered. PeekInside Cloud never gets emails, and
// nothing about how an email is sent changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import nodemailer from 'nodemailer';
import PeekInside from '../index.js';
import { Instrumentation } from '../src/instrumentation/index.js';
import { MailReader, MAIL_LIMITS } from '../src/mail/mail-reader.js';
import { MailRecord } from '../src/mail/mail-record.js';
import { HubServer } from '../src/hub/server.js';
import { Store } from '../src/hub/store.js';

const nodemailerCjs = createRequire(import.meta.url)('nodemailer');

// The transport announces the dashboard link after its first delivery; keep test output clean.
const log = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith('[peekinside]')) log(...args);
};

const hubPort = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peekinside-mail-'));
process.env.PEEKINSIDE_HOME = dataDir;
process.env.PEEKINSIDE_HUB_PORT = String(hubPort);
const store = new Store(dataDir).load();
const hub = new HubServer({ store, port: hubPort, siteUrl: 'https://peekinside.example', version: 'test', dataDir });
const hubHost = `127.0.0.1:${hubPort}`;

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

function get(target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: hubPort, path: target, headers: { host: hubHost } }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }));
    }).on('error', reject);
  });
}

async function stored(peekInside, name, ready) {
  let result = null;
  for (let i = 0; i < 150; i++) {
    await peekInside.flush();
    const project = store.listProjects().find((item) => item.name === name);
    if (project) {
      result = {
        project,
        mails: store.listMails(project.id, { limit: 1000 }).mails.reverse(),
        requests: store.list(project.id, { limit: 1000 }).requests.reverse(),
        jobs: store.listJobs(project.id, { limit: 1000 }).jobs.reverse()
      };
      if (ready(result)) return result;
    }
    await pause(30);
  }
  assert.fail(`timed out waiting for ${name}: ${JSON.stringify(result && { mails: result.mails.length, requests: result.requests.length })}`);
}

// A transporter that fails the way an unreachable SMTP server does.
const broken = {
  name: 'Broken',
  version: '1.0.0',
  send(mail, done) {
    const error = new Error('Greeting never received');
    error.code = 'ETIMEDOUT';
    error.command = 'CONN';
    setImmediate(() => done(error));
  }
};

test('an email sent during a request: the message as sent, linked to its request and on its timeline', async () => {
  const name = 'mail-api';
  // Made before PeekInside starts, as apps do at load time.
  const transporter = nodemailer.createTransport({ jsonTransport: true }, { from: '"Acme" <hello@acme.test>' });
  // A template plugin, as @nestjs-modules/mailer and nodemailer-express-handlebars work.
  transporter.use('compile', (mail, done) => {
    if (mail.data.template === 'welcome') mail.data.html = `<h1>Welcome, ${mail.data.context.name}</h1><img src="cid:logo@acme">`;
    done();
  });
  const app = express();
  app.use(express.json());
  const peekInside = PeekInside.attach(app, { project: name, local: true });
  app.post('/signup', async (req, res) => {
    const info = await transporter.sendMail({
      to: [`Ada Lovelace <${req.body.email}>`, 'bob@example.test'],
      cc: { name: 'Grace', address: 'grace@example.test' },
      bcc: 'audit@acme.test',
      subject: 'Welcome to Acme, Ada',
      text: 'Hi Ada',
      template: 'welcome',
      context: { name: 'Ada' },
      headers: { 'X-Campaign': 'onboarding', 'X-Tags': ['a', 'b'] },
      attachments: [
        { filename: 'terms.pdf', content: Buffer.alloc(1024), contentType: 'application/pdf' },
        { filename: 'logo.png', content: 'iVBORw0KGgo=', encoding: 'base64', cid: 'logo@acme' }
      ]
    });
    res.json({ messageId: info.messageId });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const answer = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ email: 'ada@example.test' });
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/signup', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.match(answer.messageId, /@acme\.test>$/, "the app gets nodemailer's answer");

    const { project, mails, requests } = await stored(peekInside, name, (r) => r.mails.length === 1 && r.requests.length === 1);
    const [mail] = mails;
    const request = requests[0];
    assert.equal(mail.subject, 'Welcome to Acme, Ada');
    assert.equal(mail.from, 'Acme <hello@acme.test>', 'the transporter default');
    assert.deepEqual(mail.to, ['Ada Lovelace <ada@example.test>', 'bob@example.test', 'Grace <grace@example.test>']);
    assert.equal(mail.recipients, 4, 'to, cc and bcc');
    assert.equal(mail.attachments, 2);
    assert.equal(mail.html, true);
    assert.equal(mail.transport, 'JSONTransport');
    assert.equal(mail.status, 'sent');
    assert.ok(mail.duration >= 0);
    assert.equal(mail.error, null);
    assert.equal(mail.requestId, request.id);
    assert.equal(mail.location.relativeFile, 'test/mail.test.js', "the app's line, not nodemailer's");

    const detail = store.mailDetail(project.id, mail.id);
    assert.equal(detail.html, '<h1>Welcome, Ada</h1><img src="cid:logo@acme">', 'as the template plugin rendered it');
    assert.equal(detail.text, 'Hi Ada');
    assert.deepEqual(detail.bcc, [{ name: '', address: 'audit@acme.test' }]);
    assert.deepEqual(detail.headers, [['X-Campaign', 'onboarding'], ['X-Tags', 'a'], ['X-Tags', 'b']]);
    assert.deepEqual(detail.attachments, [
      { filename: 'terms.pdf', contentType: 'application/pdf', size: 1024, cid: null, inline: false, source: 'content' },
      { filename: 'logo.png', contentType: null, size: 8, cid: 'logo@acme', inline: true, source: 'content' }
    ]);
    assert.equal(detail.messageId, answer.messageId);
    assert.deepEqual(detail.envelope, { from: 'hello@acme.test', to: ['ada@example.test', 'bob@example.test', 'grace@example.test', 'audit@acme.test'] });
    assert.equal(detail.transport.name, 'JSONTransport');

    const requestDetail = store.detail(project.id, request.id);
    assert.deepEqual(requestDetail.mails, [{ id: mail.id, subject: 'Welcome to Acme, Ada', to: ['ada@example.test', 'bob@example.test'] }]);
    const span = requestDetail.timeline.spans.find((item) => item.type === 'mail');
    assert.equal(span.id, mail.id);
    assert.equal(span.subject, 'Welcome to Acme, Ada');
    assert.ok(span.duration >= 0, 'from the call to the answer');

    const listed = await get(`/api/projects/${project.id}/mails`);
    assert.deepEqual(listed.json.mails.map((item) => item.id), [mail.id]);
    assert.deepEqual((await get(`/api/projects/${project.id}/mails/${mail.id}`)).json.detail, detail);
    assert.equal((await get(`/p/${project.id}/mail`)).status, 200, 'the Mail page');

    const preview = await get(`/api/projects/${project.id}/mails/${mail.id}/html`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers['content-type'], /^text\/html/);
    assert.match(preview.headers['content-security-policy'], /sandbox allow-popups/);
    assert.match(preview.headers['content-security-policy'], /img-src data:;/, 'no remote images unless asked');
    assert.match(preview.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.equal(preview.headers['x-frame-options'], 'SAMEORIGIN');
    assert.ok(preview.text.includes('<h1>Welcome, Ada</h1>') && preview.text.includes('<base target="_blank">'));
    const withImages = await get(`/api/projects/${project.id}/mails/${mail.id}/html?images=1`);
    assert.match(withImages.headers['content-security-policy'], /img-src data: https: http:/);
    assert.equal((await get(`/api/projects/${project.id}/mails/00000000-0000-4000-8000-000000000000/html`)).status, 404);
    const status = await get('/api/status');
    assert.ok(status.json.maxMails > 0, 'tells the dashboard this hub keeps emails');
  } finally {
    server.close();
    peekInside.stop();
  }
});

test("a failed send is recorded with its error; the app gets nodemailer's own answer", async () => {
  const name = 'mail-failures';
  const peekInside = new PeekInside({ project: name, local: true, runtime: false });
  const transporter = nodemailer.createTransport(broken);
  const callbackTransporter = nodemailerCjs.createTransport(broken);
  try {
    await assert.rejects(transporter.sendMail({ from: 'a@acme.test', to: 'b@example.test', subject: 'Promise', text: 'x' }), { message: 'Greeting never received', code: 'ETIMEDOUT' });
    const [error, info] = await new Promise((resolve) => callbackTransporter.sendMail({ from: 'a@acme.test', to: 'c@example.test', subject: 'Callback', text: 'x' }, (...args) => resolve(args)));
    assert.equal(error.message, 'Greeting never received');
    assert.equal(info, undefined);

    const { project, mails } = await stored(peekInside, name, (r) => r.mails.length === 2);
    for (const mail of mails) {
      assert.equal(mail.status, 'failed');
      assert.deepEqual(mail.error, { name: 'Error', message: 'Greeting never received' });
      assert.equal(mail.transport, 'Broken');
      assert.equal(mail.requestId, null, 'sent outside a request');
    }
    assert.deepEqual(mails.map((mail) => mail.subject), ['Promise', 'Callback'], 'both builds: the ES module one and the CommonJS one');
    const detail = store.mailDetail(project.id, mails[0].id);
    assert.deepEqual(detail.error, { name: 'Error', message: 'Greeting never received', code: 'ETIMEDOUT', command: 'CONN' });
    assert.deepEqual(detail.accepted, []);
  } finally {
    peekInside.stop();
  }
});

test('an email sent by a job run is linked to the run', async () => {
  const name = 'mail-jobs';
  const peekInside = new PeekInside({ project: name, local: true, runtime: false });
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  try {
    await PeekInside.job('weekly-digest', () => transporter.sendMail({ from: 'digest@acme.test', to: 'ada@example.test', subject: 'Your week', html: '<p>3 new orders</p>' }));
    const { mails, jobs } = await stored(peekInside, name, (r) => r.mails.length === 1 && r.jobs.length === 1);
    assert.equal(mails[0].jobRunId, jobs[0].id);
    assert.equal(mails[0].transport, 'StreamTransport');
  } finally {
    peekInside.stop();
  }
});

test('PeekInside Cloud never gets emails, and captureMail: false records none', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url');
  const cloud = new PeekInside({ apiKey: `pik1.p0123456789ab.${'s'.repeat(43)}.${publicKey}`, runtime: false });
  try {
    assert.ok(cloud._cloud, 'cloud mode');
    assert.equal(cloud._mails, null, 'emails are for the local dashboard');
    cloud._cloud.enqueueRecord(new MailRecord({ id: 'm1', occurredAt: Date.now(), environment: 'production', summary: {}, detail: {} }));
    assert.equal(cloud._cloud.queue.length, 0, 'the cloud transport drops an email it is handed');
  } finally {
    cloud.stop();
  }

  const name = 'mail-off';
  const app = express();
  const peekInside = PeekInside.attach(app, { project: name, local: true, captureMail: false });
  const transporter = nodemailer.createTransport({ jsonTransport: true });
  app.get('/notify', async (req, res) => res.json(await transporter.sendMail({ from: 'a@acme.test', to: 'b@example.test', subject: 'Off', text: 'x' })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/notify' }, (res) => res.resume().on('end', resolve)).on('error', reject));
    const { project } = await stored(peekInside, name, (r) => r.requests.length === 1);
    assert.equal(peekInside._mails, null);
    assert.equal(store.listMails(project.id, { limit: 10 }).mails.length, 0);
  } finally {
    server.close();
    peekInside.stop();
  }
});

test('the message is read, never changed: bodies kept up to a limit, files and streams only named', () => {
  const html = 'x'.repeat(MAIL_LIMITS.html + 10);
  const read = MailReader.read({
    data: {
      from: 'plain@acme.test',
      to: [{ name: 'Ada', address: 'ada@example.test' }, 'bob@example.test'],
      replyTo: 'support@acme.test',
      subject: 'Report',
      html,
      text: { path: '/tmp/report.txt' },
      headers: [{ key: 'X-Priority', value: '1' }],
      attachments: [
        { path: '/var/reports/q3.csv' },
        { filename: 'live.csv', content: Readable.from(['a,b']) },
        { href: 'https://cdn.acme.test/terms.pdf', filename: 'terms.pdf' }
      ]
    }
  });
  assert.equal(read.detail.html.length, MAIL_LIMITS.html);
  assert.equal(read.detail.htmlTruncated, true);
  assert.equal(read.detail.text, null);
  assert.equal(read.detail.textSource, 'file', 'named, not read');
  assert.deepEqual(read.detail.to, [{ name: 'Ada', address: 'ada@example.test' }, { name: '', address: 'bob@example.test' }]);
  assert.deepEqual(read.detail.replyTo, [{ name: '', address: 'support@acme.test' }]);
  assert.deepEqual(read.detail.headers, [['X-Priority', '1']]);
  assert.deepEqual(read.detail.attachments.map((item) => [item.filename, item.source, item.size]), [['q3.csv', 'file', null], ['live.csv', 'stream', null], ['terms.pdf', 'url', null]]);
  assert.deepEqual(read.summary.to, ['Ada <ada@example.test>', 'bob@example.test']);

  assert.deepEqual(MailReader.outcome({ messageId: '<1@acme.test>', accepted: ['a@example.test'], rejected: ['b@example.test'], response: '250 OK' }, null), {
    status: 'sent', accepted: ['a@example.test'], rejected: ['b@example.test'], response: '250 OK', messageId: '<1@acme.test>', error: null
  });
});

test('nodemailer given to PeekInside.instrument() is recognized', () => {
  assert.equal(Instrumentation.instrument([nodemailerCjs]), 1);
  assert.equal(Instrumentation.instrument([{ createTransport: () => null }]), 0, 'only nodemailer');
});
