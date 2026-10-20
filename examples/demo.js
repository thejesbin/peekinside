/**
 * PeekInside demo
 *
 * A small JSON API on Express with PeekInside attached, plus a traffic generator so the
 * dashboard has something to show: requests, and the exceptions that happen along the way.
 *
 *   npm run demo                    then open the dashboard link it prints
 *   PORT=4000 npm run demo          use another port
 *   DEMO_TRAFFIC=0 npm run demo     no generated traffic; send your own requests
 *
 * Each request gets a timeline: checkout logs a line and measures the card charge, and the
 * recommendations route calls another service with fetch (here, a route of this same app).
 *
 * Requests carry the user they are for (PeekInside.setUser()), and the report export renders its
 * report synchronously, blocking the event loop: the Runtime page and the requests in flight
 * show it.
 *
 * Two background jobs fill the Jobs and Logs pages: "sync-inventory" runs on a schedule (every
 * 20 seconds) and fails now and then; creating a user queues "send-welcome-email".
 *
 * Three routes fail on purpose, each in a way PeekInside records:
 *
 *   GET  /api/invoices/:id          a bug: the route throws and Express answers 500 (unhandled)
 *   POST /api/checkout              the payment provider fails; the error middleware answers 502
 *                                   (handled)
 *   GET  /api/recommendations       a flaky service; the route reports the error with
 *                                   PeekInside.report() and answers with a fallback
 *
 * Run it twice with different ports and PEEKINSIDE_PROJECT names to see several projects
 * side by side in the local dashboard.
 */

import http from 'http';
import zlib from 'zlib';
import { randomBytes } from 'crypto';
import express from 'express';
import PeekInside from '../index.js';

const PORT = Number(process.env.PORT) || 3000;
const GENERATE_TRAFFIC = process.env.DEMO_TRAFFIC !== '0';
const MAX_USERS = 50;

const users = new Map([
  [1, { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin', active: true }],
  [2, { id: 2, name: 'Alan Turing', email: 'alan@example.com', role: 'member', active: true }],
  [3, { id: 3, name: 'Grace Hopper', email: 'grace@example.com', role: 'member', active: false }]
]);
let nextUserId = 4;

// 1x1 transparent PNG, to show how binary responses are handled
const AVATAR = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const invoices = new Map([
  [1001, { id: 1001, customer: 'Ada Lovelace', lines: [{ item: 'Desk lamp', amount: 39 }, { item: 'Notebook', amount: 12.5 }] }],
  [1002, { id: 1002, customer: 'Alan Turing', lines: [{ item: 'Monitor arm', amount: 89 }] }]
]);

/** The payment provider's errors carry its own code. */
class PaymentProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
  }
}

// The customers the generated traffic acts for.
const CUSTOMERS = [
  { id: 'cus_1042', email: 'ada@example.com' },
  { id: 'cus_1043', email: 'alan@example.com' },
  { id: 'cus_1044', email: 'grace@example.com' },
  { id: 'cus_1045', email: 'katherine@example.com' },
  { id: 'cus_1046', email: 'margaret@example.com' }
];

const app = express();
PeekInside.attach(app);

// Who each request is for. The demo's traffic names the customer in a header; a real app reads
// it from its session, in its authentication middleware.
app.use((req, res, next) => {
  const customer = CUSTOMERS.find((item) => item.id === req.headers['x-demo-customer']);
  if (customer) PeekInside.setUser(customer);
  next();
});

// Renders the report on the event loop: while it runs, nothing else does, and every request in
// flight waits. PeekInside records the block on each of them.
app.get('/api/reports/export', async (req, res) => {
  await sleep(150 + Math.random() * 400);
  renderReportSync(110 + random(260));
  if (Math.random() < 0.3) {
    return json(res, 500, { error: 'internal_error', message: 'Report worker timed out after 30s.', requestId: randomBytes(6).toString('hex') });
  }
  json(res, 202, { status: 'ready', jobId: randomBytes(6).toString('hex'), format: req.query.format || 'csv' });
});

// A bug PeekInside catches: invoices that don't exist have no lines. Express answers 500.
app.get('/api/invoices/:id', (req, res) => {
  const invoice = invoices.get(Number(req.params.id));
  const total = invoice.lines.reduce((sum, line) => sum + line.amount, 0);
  res.json({ id: invoice.id, customer: invoice.customer, total });
});

// The provider sometimes times out; the error middleware below answers for it.
app.post('/api/checkout', express.json(), async (req, res, next) => {
  try {
    const last4 = (req.body && req.body.payment && req.body.payment.last4) || '0000';
    console.log(`Charging card ending ${last4}`);
    // A span of its own on the request's timeline.
    await PeekInside.measure('charge card', async () => {
      await sleep(80 + Math.random() * 200);
      if (Math.random() < 0.5) {
        throw new PaymentProviderError('Payment provider did not answer within 5000 ms', 'PROVIDER_TIMEOUT');
      }
    });
    res.status(201).json({ orderId: randomBytes(5).toString('hex'), status: 'paid' });
  } catch (error) {
    next(error);
  }
});

// A failure the route recovers from: reported, then answered with a fallback.
app.get('/api/recommendations', async (req, res) => {
  const userId = Number(req.query.user) || 1;
  try {
    res.json({ userId, items: await fetchRecommendations(userId) });
  } catch (error) {
    PeekInside.report(error, { tags: { service: 'recommendations' }, extra: { userId } });
    res.json({ userId, items: ['Desk lamp', 'Notebook'], fallback: true });
  }
});

// The "recommendation service" the route above calls; it times out now and then.
app.get('/internal/recommendations', async (req, res) => {
  await sleep(30 + Math.random() * 120);
  if (Math.random() < 0.4) return res.status(504).json({ error: 'timeout' });
  const userId = Number(req.query.user) || 1;
  res.json({ items: ['Monitor arm', 'USB-C hub', 'Desk lamp'].slice(0, 1 + (userId % 3)) });
});

// Everything else: the same handlers as always, after the body has been read.
app.use(async (req, res, next) => {
  try {
    const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
    const body = await readBody(req);
    await sleep(latencyFor(url.pathname));
    handle(req, res, url, body);
  } catch (error) {
    next(error);
  }
});

// Error middleware: payment failures get an answer of their own; the rest goes on to Express.
app.use((error, req, res, next) => {
  if (error instanceof PaymentProviderError) {
    return res.status(502).json({ error: 'payment_unavailable', message: 'The payment provider is not answering. Try again.' });
  }
  next(error);
});

// A scheduled job: every 20 seconds (a cron expression with seconds), failing now and then.
setInterval(() => {
  PeekInside.job('sync-inventory', async () => {
    console.log('Syncing inventory from the warehouse API');
    await sleep(60 + Math.random() * 400);
    if (Math.random() < 0.25) throw new Error('Warehouse API timed out after 30s');
    console.info(`Inventory synced: ${1 + random(40)} SKUs changed`);
  }, { schedule: '*/20 * * * * *' }).catch(() => {});
}, 20_000).unref();

app.listen(PORT, () => {
  console.log(`Demo API:  http://localhost:${PORT}`);
  if (GENERATE_TRAFFIC) {
    console.log('Generating sample traffic. Set DEMO_TRAFFIC=0 to turn it off.');
    setTimeout(generateTraffic, 500);
  }
});

function handle(req, res, url, body) {
  const { pathname, searchParams } = url;
  const method = req.method;
  let match;

  if (pathname === '/' && method === 'GET') {
    return text(res, 200, 'PeekInside demo API. Requests show up in the dashboard link printed at startup.');
  }
  if (pathname === '/health') {
    return text(res, 200, 'ok');
  }

  if (pathname === '/api/users' && method === 'GET') {
    const page = Number(searchParams.get('page')) || 1;
    return json(res, 200, { page, perPage: 20, total: users.size, data: Array.from(users.values()) });
  }

  if (pathname === '/api/users' && method === 'POST') {
    const input = parseJson(body);
    if (!input || !input.name) {
      return json(res, 422, { error: 'validation_failed', message: 'The given data was invalid.', fields: { name: ['The name field is required.'] } });
    }
    const user = { id: nextUserId++, name: input.name, email: input.email || null, role: 'member', active: true };
    users.set(user.id, user);
    // A background job, as a queue would run it: after the response, with the user as its data.
    setTimeout(() => {
      PeekInside.job('send-welcome-email', async () => {
        await sleep(30 + Math.random() * 120);
        console.log(`Welcome email sent to ${user.email || user.name}`);
      }, { queue: 'emails', data: { userId: user.id, email: user.email } }).catch(() => {});
    }, 50);
    if (users.size > MAX_USERS) users.delete(users.keys().next().value);
    res.setHeader('Location', `/api/users/${user.id}`);
    return json(res, 201, user);
  }

  if ((match = /^\/api\/users\/(\d+)$/.exec(pathname))) {
    const id = Number(match[1]);
    const user = users.get(id);
    if (method === 'DELETE') {
      users.delete(id);
      res.writeHead(204);
      return res.end();
    }
    if (!user) {
      return json(res, 404, { error: 'not_found', message: `User ${id} does not exist.` });
    }
    if (method === 'PATCH') {
      Object.assign(user, parseJson(body) || {});
    }
    return json(res, 200, user);
  }

  if (pathname === '/api/session' && method === 'POST') {
    const input = parseJson(body) || {};
    if (input.password !== 'correct-horse') {
      return json(res, 401, { error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }
    res.setHeader('Set-Cookie', `session=${randomBytes(12).toString('hex')}; Path=/; HttpOnly; SameSite=Lax`);
    return json(res, 200, { token: `eyJhbGciOiJIUzI1NiJ9.${randomBytes(18).toString('base64url')}`, expiresIn: 3600 });
  }

  if (pathname === '/api/search') {
    const query = (searchParams.get('q') || '').toLowerCase();
    const results = Array.from(users.values()).filter(user => user.name.toLowerCase().includes(query));
    return json(res, 200, { query, count: results.length, results });
  }

  if (pathname === '/api/catalog') {
    // Gzip-compressed JSON: the dashboard shows it decoded
    const products = Array.from({ length: 12 }, (_, i) => ({
      sku: `SKU-${1040 + i}`,
      name: ['Desk lamp', 'Notebook', 'Monitor arm', 'USB-C hub'][i % 4],
      price: Math.round((14.5 + i * 7.25) * 100) / 100,
      inStock: i % 5 !== 0,
      tags: i % 2 ? ['office', 'sale'] : ['office']
    }));
    const payload = zlib.gzipSync(JSON.stringify({ updatedAt: new Date().toISOString(), products }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': payload.length });
    return res.end(payload);
  }

  if (pathname === '/api/contact' && method === 'POST') {
    return json(res, 202, { received: Object.fromEntries(new URLSearchParams(body)) });
  }

  if (pathname === '/api/avatar.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': AVATAR.length, 'Cache-Control': 'max-age=3600' });
    return res.end(AVATAR);
  }

  if (pathname === '/docs') {
    res.writeHead(301, { Location: '/api/users' });
    return res.end();
  }

  return json(res, 404, { error: 'not_found', message: `No route for ${method} ${pathname}` });
}

// The recommendation service, called over HTTP: an outgoing call on the request's timeline.
async function fetchRecommendations(userId) {
  const response = await fetch(`http://127.0.0.1:${PORT}/internal/recommendations?user=${userId}`);
  if (!response.ok) {
    const error = new Error(`Recommendation service answered ${response.status} for user ${userId}`);
    error.code = 'UPSTREAM_ERROR';
    throw error;
  }
  return (await response.json()).items;
}

function latencyFor(pathname) {
  if (pathname === '/api/search') return 40 + Math.random() * 180;
  // Occasional slow outlier, like a cold cache
  if (Math.random() < 0.05) return 400 + Math.random() * 600;
  return 2 + Math.random() * 45;
}

const AGENTS = [
  'curl/8.7.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'node-fetch/3.3.2',
  'PostmanRuntime/7.39.0'
];

const SCENARIOS = [
  { weight: 6, method: 'GET', path: () => `/api/users?page=${1 + random(3)}&sort=name` },
  { weight: 4, method: 'GET', path: () => `/api/users/${1 + random(5)}` },
  {
    weight: 2,
    method: 'POST',
    path: () => '/api/users',
    headers: { 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.k3nX9vQe' },
    body: () => JSON.stringify(pick([
      { name: 'Katherine Johnson', email: 'katherine@example.com' },
      { name: 'Margaret Hamilton', email: 'margaret@example.com', preferences: { theme: 'dark', notifications: ['email', 'push'] } },
      { email: 'missing-name@example.com' }
    ]))
  },
  { weight: 1, method: 'PATCH', path: () => `/api/users/${1 + random(3)}`, headers: { 'content-type': 'application/json' }, body: () => JSON.stringify({ active: Math.random() < 0.5 }) },
  { weight: 1, method: 'DELETE', path: () => `/api/users/${4 + random(30)}`, headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Qm9vZm9v' } },
  {
    weight: 2,
    method: 'POST',
    path: () => '/api/session',
    headers: { 'content-type': 'application/json' },
    body: () => JSON.stringify({ email: 'ada@example.com', password: Math.random() < 0.65 ? 'correct-horse' : 'tr0ub4dor' })
  },
  { weight: 3, method: 'GET', path: () => `/api/search?q=${pick(['ada', 'tur', 'grace', 'hop', 'zz'])}&limit=10`, headers: { cookie: 'session=4b1d9e0c7a; theme=dark' } },
  { weight: 2, method: 'GET', path: () => '/api/catalog', headers: { 'accept-encoding': 'gzip' } },
  { weight: 1, method: 'GET', path: () => `/api/reports/export?format=${pick(['csv', 'xlsx'])}` },
  { weight: 1, method: 'POST', path: () => '/api/contact', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: () => 'name=Ada+Lovelace&topic=billing&message=Invoice+%23482+looks+off' },
  { weight: 1, method: 'GET', path: () => '/docs' },
  { weight: 1, method: 'GET', path: () => '/api/avatar.png' },
  { weight: 1, method: 'GET', path: () => '/health' },
  { weight: 1, method: 'GET', path: () => '/api/orders/9921' },
  // Exceptions: an invoice that doesn't exist, a flaky checkout, a flaky dependency
  { weight: 1, method: 'GET', path: () => `/api/invoices/${pick([1001, 1002, 1003, 1077])}` },
  {
    weight: 1,
    method: 'POST',
    path: () => '/api/checkout',
    headers: { 'content-type': 'application/json' },
    body: () => JSON.stringify({ cart: [{ sku: 'SKU-1042', qty: 1 + random(3) }], payment: { method: 'card', last4: '4242' } })
  },
  { weight: 1, method: 'GET', path: () => `/api/recommendations?user=${1 + random(5)}` }
];

function generateTraffic() {
  send(weightedPick(SCENARIOS));
  setTimeout(generateTraffic, 350 + random(1300));
}

function send(scenario) {
  const body = scenario.body ? scenario.body() : null;
  const headers = { 'user-agent': pick(AGENTS), accept: 'application/json', 'x-demo-customer': pick(CUSTOMERS).id, ...(scenario.headers || {}) };
  if (body) headers['content-length'] = Buffer.byteLength(body);

  const req = http.request({ host: '127.0.0.1', port: PORT, method: scenario.method, path: scenario.path(), headers }, (res) => res.resume());
  req.on('error', () => {});
  req.end(body || undefined);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

// Synchronous work standing in for a report renderer: it holds the event loop for `ms`.
function renderReportSync(ms) {
  const end = Date.now() + ms;
  let checksum = 0;
  while (Date.now() < end) checksum = (checksum * 31 + 7) % 1000003;
  return checksum;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function random(n) {
  return Math.floor(Math.random() * n);
}

function pick(items) {
  return items[random(items.length)];
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}
