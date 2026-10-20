/**
 * Sends captured exchanges and exceptions to PeekInside Cloud, encrypted with the project's public key.
 *
 * Records are queued in memory and sent in batches from a background timer, never on the request
 * path. Network failures are retried with backoff; when the queue is full the oldest records are
 * dropped. An invalid key or an inactive plan stops sending (logged once).
 *
 * A crashing process can't wait for the timer: the crash is sealed synchronously and posted from
 * a short-lived child process the app waits for (spawnSync). If that fails, the sealed batch is
 * spooled to disk and sent when the app starts again. Spooled data is ciphertext only.
 */

import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { settings } from '../config.js';
import { ApiKey, Sealer, SyncSealer } from '../crypto.js';
import { RequestContext } from '../exceptions/request-context.js';
import { ExceptionRecord } from '../exceptions/exception-record.js';
import { DumpRecord } from '../dumps/dump-record.js';
import { JobRunRecord } from '../jobs/job-run-record.js';
import { LogRecord } from '../logs/log-record.js';
import { RequestRecord } from '../record.js';
import { Spool } from '../spool.js';
import { RuleMatcher } from '../alerts/rule-matcher.js';
import { BatchTransport } from './batch.js';

const FLUSH_INTERVAL_MS = 1000;
const BATCH_SIZE = 100;
const MAX_QUEUE = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
// When the event loop empties (a script ending), the last batch waits at most this long; what
// doesn't go is spooled for the next run instead.
const EXIT_TIMEOUT_MS = 2500;
// Sealed JSON per POST: records that don't fit wait for the next POST. PeekInside Cloud refuses
// bodies over 8 MB, and serverless hosts such as Vercel stop requests at 4.5 MB before they reach it.
const MAX_POST_BYTES = 4 * 1024 * 1024;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
// A crash waits this long for its batch to be sent before spooling it.
const CRASH_SEND_TIMEOUT_MS = 3000;
// Queued records sent along with a crash, at most (sealed JSON); the crash itself always goes.
const CRASH_QUEUE_BUDGET = 1024 * 1024;
// Spooled batches are resent shortly after start, and given up after a week.
const SPOOL_RESEND_DELAY_MS = 1000;
const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Exit codes of the sender: 0 delivered, 3 refused for good (sending it again would fail again),
// anything else failed (spool and retry later).
const SENT = 0;
const REFUSED = 3;

// Posts one batch, read as JSON from stdin, and exits. It runs with an empty environment, so the
// app's NODE_OPTIONS (--require hooks, loaders, --inspect) don't load into it.
const SENDER = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let job;
  try { job = JSON.parse(input); } catch (error) { process.exit(1); }
  const signal = AbortSignal.timeout(${CRASH_SEND_TIMEOUT_MS - 500});
  const post = (url) => fetch(url, { method: 'POST', headers: job.headers, body: job.body, redirect: 'manual', signal });
  post(job.url)
    .then((response) => {
      const location = response.headers.get('location');
      if ((response.status !== 307 && response.status !== 308) || !location) return response;
      const target = new URL(location, job.url);
      const ok = job.follow.hosts.includes(target.hostname) && job.follow.protocols.includes(target.protocol) && target.pathname === job.follow.path && (target.port === '' || target.port === job.follow.port);
      return ok ? post(target.href) : response;
    })
    .then((response) => process.exit(response.ok ? ${SENT} : response.status === 400 || response.status === 413 ? ${REFUSED} : 2))
    .catch(() => process.exit(1));
});
`;

/**
 * Seals records to the project's public key and posts them to `<site>/api/ingest`.
 */
export class CloudTransport extends BatchTransport {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Project API key from the PeekInside dashboard
   * @param {string} [options.environment] - Label such as "production" or "staging"
   * @param {string|null} [options.release] - The running release (see release.js)
   * @param {string} [options.version] - SDK version, sent as the user agent
   * @throws {Error} When the API key is not a valid PeekInside API key
   */
  constructor({ apiKey, environment, release = null, version }) {
    const key = ApiKey.parse(apiKey);
    if (!key) {
      throw new Error(ApiKey.problem(apiKey));
    }
    super({
      environment: RequestRecord.normalizeEnvironment(environment, 'production'),
      release,
      batchSize: BATCH_SIZE,
      maxQueue: MAX_QUEUE,
      firstBackoffMs: FIRST_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS
    });

    this.apiKey = key;
    this.endpoint = `${settings.siteUrl()}/api/ingest`;
    this.userAgent = `peekinside-node/${version || 'dev'}`;
    /**
     * This process, as its samples are grouped: a random id, its pid and Node.js version (no host
     * name, which stays sealed with exceptions)
     * @type {{ id: string, pid: number, node: string, startedAt: number }}
     */
    this.instance = { id: randomUUID(), pid: process.pid, node: process.version, startedAt: Date.now() };

    // Never keeps the process alive on its own, and never runs as part of a request.
    this.timer = RequestContext.outside(() => setInterval(() => this.flush(), FLUSH_INTERVAL_MS));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // One more batch when the event loop empties, for scripts that end without calling flush():
    // briefly, so a slow or unreachable PeekInside Cloud never holds the script up for long.
    this.exiting = false;
    this._onBeforeExit = () => {
      this.exiting = true;
      return this.flush();
    };
    process.once('beforeExit', this._onBeforeExit);

    this._resendTimer = null;
    this._resending = null;
    // Alert rules on sealed fields, checked here before records are sealed (started with the first batch).
    this.rules = new RuleMatcher({ fetchRules: () => this._fetchRules() });
    // Set when records that didn't fit in the last POST wait for the next one.
    this._more = false;
    // Batches spooled by an earlier run that crashed.
    this._scheduleResend(SPOOL_RESEND_DELAY_MS);
  }

  /**
   * Queues a record for sending. Dumps are for the local dashboard: PeekInside Cloud never gets them.
   *
   * @param {Object} record
   * @returns {void}
   */
  enqueueRecord(record) {
    if (record instanceof DumpRecord) return;
    super.enqueueRecord(record);
  }

  /**
   * Stops the background timer and the flush at exit. Sending itself stays possible: drain()
   * still sends what is queued.
   *
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    clearTimeout(this._resendTimer);
    this._resendTimer = null;
    this.rules.stop();
    super.stop();
  }

  /**
   * Seals the records synchronously and sends them before returning. For a crash, they are posted
   * from a child process the app waits for (up to 3 s), along with the newest queued records; when
   * that fails, or the process keeps running, the sealed batch is spooled to disk and sent by the
   * next run (or shortly, by this one).
   *
   * @param {Object} batch - See BatchTransport#deliverNow()
   * @returns {void}
   */
  deliverNow({ exceptions, exchanges, fatal }) {
    if (this.disabled) return;
    try {
      const sealer = SyncSealer.create(this.apiKey.publicKey, 'event');
      const sealed = [];
      for (const record of [...exceptions, ...exchanges.map((exchange) => RequestRecord.fromExchange(exchange, this.environment, this.release))]) {
        sealed.push({ record, payload: record.sealSync(sealer) });
      }
      if (fatal) sealed.push(...this._takeNewest(sealer, BATCH_SIZE - sealed.length));

      const body = { events: [], exceptions: [] };
      for (const { record, payload } of sealed) {
        const list = listFor(record);
        (body[list] ??= []).push(payload);
      }

      if (fatal && this._sendNow(JSON.stringify(body)) !== 'failed') return;
      Spool.cloud(settings.dataDir(), this.apiKey.projectId).write({ createdAt: Date.now(), body });
      if (!fatal) this._scheduleResend(SPOOL_RESEND_DELAY_MS);
    } catch (error) {
      // A crash that can't be delivered is lost; the app's own crash is unaffected.
    }
  }

  // Full batches go out right away instead of waiting for the timer.
  _onQueued() {
    if (this.queue.length >= this.batchSize) this.flush();
  }

  _afterAttempt() {
    if (this.queue.length >= this.batchSize || this._more) {
      this._more = false;
      this.flush();
    }
  }

  // Seals records in order until the POST would pass MAX_POST_BYTES; a single record always goes,
  // even a large one, or it would block the queue.
  async _pack(batch, sealer) {
    const lists = { events: [], exceptions: [], jobs: [], logs: [] };
    const alerts = [];
    let size = 32;
    let count = 0;
    for (const record of batch) {
      const sealed = await record.seal(sealer);
      const length = Buffer.byteLength(JSON.stringify(sealed)) + 1;
      if (count > 0 && size + length > MAX_POST_BYTES) break;
      size += length;
      count++;
      lists[listFor(record)].push(sealed);
      // Which alert rules it met on what only this server can read: ids, never the content.
      alerts.push(...this.rules.matches(record));
    }
    return { ...lists, alerts, rest: batch.slice(count) };
  }

  // Records that didn't fit go back to the front of the queue, in order, and go out right away.
  _requeue(rest) {
    if (!rest.length) return;
    this.queue.unshift(...rest);
    this._trimQueue();
    this._more = true;
  }

  async _deliver(batch) {
    // A fresh ephemeral key per batch: one key agreement, a new IV per message.
    const sealer = await Sealer.create(this.apiKey.publicKey, 'event');
    const { events, exceptions, jobs, logs, alerts, rest } = await this._pack(batch, sealer);
    const body = { events };
    if (exceptions.length) body.exceptions = exceptions;
    if (jobs.length) body.jobs = jobs;
    if (logs.length) body.logs = logs;
    if (alerts.length) body.alerts = alerts;
    const samples = this.takeSamples();
    if (samples.length) {
      body.instance = { ...this.instance, environment: this.environment, release: this.release };
      body.samples = samples;
    }
    let response;
    try {
      response = await this._post(JSON.stringify(body));
    } catch (error) {
      this.restoreSamples(samples);
      throw error;
    }
    if (response.status >= 500) this.restoreSamples(samples);
    const sent = batch.length - rest.length;

    if (response.ok) {
      // PeekInside Cloud answers: from now on, the alert rules it holds are checked here too.
      this.rules.start();
      this._requeue(rest);
      return true;
    }

    const reason = await response.json().then((answer) => answer.error, () => '') || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      this._disable(`${reason} Requests are no longer sent to PeekInside Cloud until the app restarts.`);
      return false;
    }
    if (response.status === 400 || response.status === 413) {
      // Retrying the same data would fail again; what didn't fit in this POST goes next.
      this._warn(`PeekInside Cloud rejected a batch of ${sent} records: ${reason}`);
      this._requeue(rest);
      return false;
    }
    // Server errors are retried like network errors.
    throw new Error(reason);
  }

  // Ending while waiting to retry after a failure: what's queued is spooled rather than lost.
  _onBackingOff() {
    if (this.exiting) this._spoolQueue();
  }

  _onRetry(error) {
    if (this.exiting) {
      // The script is ending: what's queued waits on disk for the next run.
      this._spoolQueue();
      return;
    }
    this._warn(`Could not reach PeekInside Cloud (${error && error.message}). Retrying in ${Math.round(this.backoff / 1000)} s.`);
  }

  // Seals the newest queued records (within the crash budget) and spools them, synchronously.
  _spoolQueue() {
    try {
      const taken = this._takeNewest(SyncSealer.create(this.apiKey.publicKey, 'event'), MAX_QUEUE);
      if (!taken.length) return;
      const body = { events: [], exceptions: [] };
      for (const { record, payload } of taken) (body[listFor(record)] ??= []).push(payload);
      Spool.cloud(settings.dataDir(), this.apiKey.projectId).write({ createdAt: Date.now(), body });
      // Sent by the next run; or by this one, should it keep running after all.
      this._scheduleResend(SPOOL_RESEND_DELAY_MS);
    } catch (error) {
      // A data folder that can't be written loses the records, never the app.
    }
  }

  // An invalid key or an inactive plan loses every request from now on: an error, not a warning.
  _logDisabled(line) {
    console.error(line);
  }

  // The project's alert rules on sealed fields, from beside the ingest endpoint.
  async _fetchRules() {
    if (this.exiting) throw new Error('exiting');
    // Never after a redirect: the API key goes only where batches go (see _post).
    const response = await fetch(`${this.endpoint}/alert-rules`, { headers: this._headers(), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  _headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey.secret}`,
      'x-peekinside-project': this.apiKey.projectId,
      'user-agent': this.userAgent
    };
  }

  // Posts to the endpoint. A redirect to the site's twin (see redirectTarget) is followed here,
  // with the API key, and remembered; fetch() would follow it but drop the key.
  async _post(body) {
    const post = (url) => fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.exiting ? EXIT_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
    });
    const response = await post(this.endpoint);
    const moved = redirectTarget(response, this.endpoint);
    if (!moved) return response;
    this.endpoint = moved;
    return post(moved);
  }

  // The newest queued records, sealed, within the crash budget; they leave the queue.
  _takeNewest(sealer, count) {
    const taken = [];
    let size = 0;
    while (taken.length < count && this.queue.length > 0) {
      const record = this.queue[this.queue.length - 1];
      const payload = record.sealSync(sealer);
      size += JSON.stringify(payload).length;
      if (size > CRASH_QUEUE_BUDGET) break;
      this.queue.pop();
      taken.unshift({ record, payload });
    }
    return taken;
  }

  // Posts from a child process and waits for it: the only way to send over the network
  // synchronously. The secret travels on stdin, never on the command line.
  _sendNow(body) {
    const input = JSON.stringify({ url: this.endpoint, headers: this._headers(), body, follow: followRule(this.endpoint) });
    const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const result = spawnSync(process.execPath, ['-e', SENDER], {
      input,
      env,
      timeout: CRASH_SEND_TIMEOUT_MS,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    });
    if (result.status === SENT) return 'sent';
    if (result.status === REFUSED) return 'refused';
    return 'failed';
  }

  _scheduleResend(delay) {
    if (this._resendTimer || this.disabled) return;
    this._resendTimer = RequestContext.outside(() => setTimeout(() => {
      this._resendTimer = null;
      this.resendSpooled();
    }, delay));
    if (typeof this._resendTimer.unref === 'function') this._resendTimer.unref();
  }

  /**
   * Sends batches spooled by crashes, oldest first, and deletes them once delivered (or refused
   * for good). Batches older than a week are deleted unsent. Stops at the first failure: the rest
   * waits for the next start.
   *
   * @returns {Promise<void>} Never rejects
   */
  resendSpooled() {
    if (!this._resending) {
      this._resending = this._resendSpooled().finally(() => {
        this._resending = null;
      });
    }
    return this._resending;
  }

  async _resendSpooled() {
    try {
      const spool = Spool.cloud(settings.dataDir(), this.apiKey.projectId);
      for (const name of spool.list({ maxAgeMs: SPOOL_MAX_AGE_MS })) {
        if (this.disabled) return;
        // Cluster workers start together: only one of them sends each file.
        const claimed = spool.claim(name);
        if (!claimed) continue;
        const entry = spool.read(claimed);
        if (!entry || !entry.body || typeof entry.body !== 'object') {
          spool.remove(claimed);
          continue;
        }

        let response;
        try {
          response = await this._post(JSON.stringify(entry.body));
        } catch (error) {
          spool.release(claimed);
          return;
        }
        if (response.body) response.body.cancel().catch(() => {});
        if (response.ok || response.status === 400 || response.status === 413) {
          spool.remove(claimed);
        } else {
          spool.release(claimed);
          return;
        }
      }
    } catch (error) {
      // Spooled batches wait for the next start.
    }
  }
}

// The list of the request body a record goes in.
function listFor(record) {
  if (record instanceof ExceptionRecord) return 'exceptions';
  if (record instanceof JobRunRecord) return 'jobs';
  if (record instanceof LogRecord) return 'logs';
  return 'events';
}

/**
 * Where a 307 or 308 answer from PeekInside Cloud moves its endpoint, when the API key may follow
 * it there, or null. Hosting often sends a site's bare domain to its www name, or back (Vercel
 * does by default), and fetch() drops the Authorization header on such a redirect, so it is
 * followed by hand, and only to the same path on the same host or its www twin, never downgrading
 * https. Anywhere else, the answer stands (and the batch is retried later).
 *
 * @param {Response} response
 * @param {string} from - The URL that answered
 * @returns {string|null}
 */
export function redirectTarget(response, from) {
  if (response.status !== 307 && response.status !== 308) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  let target;
  try {
    target = new URL(location, from);
  } catch (error) {
    return null;
  }
  const rule = followRule(from);
  const ok = rule.hosts.includes(target.hostname) && rule.protocols.includes(target.protocol) && target.pathname === rule.path && (target.port === '' || target.port === rule.port);
  return ok ? target.href : null;
}

// What redirectTarget accepts, as data, so the crash sender's child process applies the same rule.
function followRule(from) {
  const url = new URL(from);
  const host = url.hostname;
  const named = host.includes('.') && !host.startsWith('[') && !/^[\d.]+$/.test(host) && host !== 'localhost' && !host.endsWith('.localhost');
  const hosts = [host];
  if (named) hosts.push(host.startsWith('www.') ? host.slice(4) : `www.${host}`);
  return { hosts, protocols: url.protocol === 'http:' ? ['http:', 'https:'] : [url.protocol], path: url.pathname, port: url.port };
}
