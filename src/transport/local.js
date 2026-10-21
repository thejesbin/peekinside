/**
 * Sends captured exchanges and exceptions to the local hub, the free dashboard shared by every
 * app on this machine, and starts the hub when it isn't running.
 *
 * Records are batched and sent from timers, never on the request path. While the hub starts
 * (or restarts) they wait in a bounded queue. A heartbeat keeps the app listed as running.
 * A crashing process writes what it has to a spool file instead, which the hub picks up.
 */

import path from 'path';
import { LOG_PREFIX, VERSION, settings } from '../config.js';
import { RequestContext } from '../exceptions/request-context.js';
import { HubClient } from '../hub/client.js';
import { RequestRecord } from '../record.js';
import { Spool } from '../spool.js';
import { BatchTransport } from './batch.js';

const FLUSH_DELAY_MS = 50;
const BATCH_SIZE = 200;
const MAX_QUEUE = 2000;
const HEARTBEAT_MS = 10_000;
const SPAWN_INTERVAL_MS = 10_000;
const MAX_SPAWNS = 5;
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const MAX_SERVER_WARNINGS = 3;
const MAX_BLOCKED_HOSTS = 10;
// What one spool file holds at most: the hub's limits for one batch.
const MAX_SPOOLED_REQUESTS = 1000;
const MAX_SPOOLED_EXCEPTIONS = 500;
// Framework reported until an integration names one.
const DEFAULT_FRAMEWORK = 'node';

/**
 * Posts batches to the hub's /api/ingest, with this process's details: which project it runs,
 * its port and framework, and counts of server requests it didn't record.
 */
export class LocalTransport extends BatchTransport {
  /**
   * @param {Object} options
   * @param {import('../project.js').ProjectIdentity} options.project - The app's project
   * @param {string} [options.framework="node"] - Shown next to the app in the dashboard
   * @param {string} [options.environment] - Environment label (default "development")
   * @param {string|null} [options.release] - The running release (see release.js)
   */
  constructor({ project, framework = DEFAULT_FRAMEWORK, environment, release = null }) {
    super({
      environment: RequestRecord.normalizeEnvironment(environment, 'development'),
      release,
      batchSize: BATCH_SIZE,
      maxQueue: MAX_QUEUE,
      firstBackoffMs: FIRST_BACKOFF_MS,
      maxBackoffMs: MAX_BACKOFF_MS
    });

    this.hub = new HubClient(settings.hubPort(), { keepAlive: true });
    this.project = project;
    /**
     * This process, as the dashboard lists it
     * @type {{ pid: number, port: number|null, framework: string, node: string, sdk: string, environment: string, release: string|null, startedAt: number }}
     */
    this.instance = {
      pid: process.pid,
      port: null,
      framework,
      node: process.version,
      sdk: VERSION,
      environment: this.environment,
      release: this.release,
      startedAt: Date.now()
    };

    this.timer = null;
    this.heartbeat = null;
    this.started = false;
    this.announced = false;
    this.lastSpawn = 0;
    this.spawns = 0;
    this.blocked = new BlockedRequests();
    this.blockedWarnings = new Set();
    this.outdatedHubNoted = false;
    this.hubVersionChecked = false;
  }

  /**
   * Registers this process with the hub (starting the hub if needed) and keeps it registered.
   *
   * @param {number} [appPort] - Port the app listens on, shown in the dashboard
   * @returns {void}
   */
  start(appPort) {
    if (appPort) this.instance.port = appPort;
    if (this.disabled) return;
    // The heartbeat timer must not keep (and report into) the context of whatever started it.
    RequestContext.outside(() => this._start());
  }

  _start() {
    if (!this.started) {
      this.started = true;
      this.heartbeat = setInterval(() => this.flush(true), HEARTBEAT_MS);
      if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
      // Each time the event loop empties, what is queued is sent, so a script's last requests
      // reach the hub.
      process.on('beforeExit', this._onBeforeExit);
    }
    this.flush(true);
  }

  /**
   * Names the app's framework in the dashboard. The first integration used wins.
   *
   * @param {string} name - Such as "express"
   * @returns {void}
   */
  setFramework(name) {
    if (this.instance.framework === DEFAULT_FRAMEWORK) {
      this.instance.framework = name;
    }
  }

  /**
   * Counts a request that wasn't recorded because it reached a server; the dashboard shows that
   * servers need PeekInside Cloud. The console says so too, for the first few hosts.
   *
   * @param {import('../deployment.js').ServerSignal} signal - From TrafficClassifier#serverSignal()
   * @returns {void}
   */
  noteServerRequest(signal) {
    if (this.disabled) return;
    const key = this.blocked.count(signal);
    if (!this.blockedWarnings.has(key) && this.blockedWarnings.size < MAX_SERVER_WARNINGS) {
      this.blockedWarnings.add(key);
      const what = signal.kind === 'host' ? `requests to ${signal.value}` : `requests from the public address ${signal.value}`;
      console.warn(`${LOG_PREFIX} Not recording ${what}: the free local dashboard is for development on your machine. Servers need PeekInside Cloud: ${settings.siteUrl()}/#pricing`);
    }
    RequestContext.outside(() => this._wake());
  }

  /**
   * Stops sending and the heartbeat, and closes the connections to the hub.
   *
   * @returns {void}
   */
  stop() {
    this.disabled = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.timer);
    this.timer = null;
    super.stop();
    this.hub.close();
  }

  _hasPending() {
    return this.queue.length > 0 || this.blocked.size > 0 || this.samples.length > 0;
  }

  _onQueued() {
    this._wake();
  }

  _onBackingOff() {
    this._schedule();
  }

  _afterAttempt() {
    if (this._hasPending()) this._schedule();
  }

  /**
   * Writes the records to a spool file for the hub, synchronously: the process may exit right
   * after. The hub ingests spool files at startup and every second. When the process is exiting,
   * whatever is still queued (or was being sent) goes into the file too.
   *
   * @param {Object} batch - See BatchTransport#deliverNow()
   * @returns {void}
   */
  deliverNow({ exceptions, exchanges, fatal }) {
    if (this.disabled) return;
    try {
      // The hub skips records it already has, so a batch that was in flight may safely go again.
      const records = fatal ? [...this.sending, ...this.queue.splice(0)] : [];
      for (const exchange of exchanges) records.push(RequestRecord.fromExchange(exchange, this.environment, this.release));
      records.push(...exceptions);
      const { requests, exceptions: errors, jobs, logs, dumps, mails } = BatchTransport.split(records);
      Spool.local(settings.dataDir(), this.project.id).write({
        project: this.project,
        instance: this.instance,
        requests: requests.slice(-MAX_SPOOLED_REQUESTS),
        exceptions: errors.slice(-MAX_SPOOLED_EXCEPTIONS),
        jobs: jobs.slice(-MAX_SPOOLED_EXCEPTIONS),
        logs: logs.slice(-MAX_SPOOLED_REQUESTS),
        dumps: dumps.slice(-MAX_SPOOLED_EXCEPTIONS),
        mails: mails.slice(-MAX_SPOOLED_EXCEPTIONS)
      });
    } catch (error) {
      // A data folder that can't be written loses the records, never the app.
    }
  }

  // Sends the batch with the blocked-request counts gathered since the last batch. Records are
  // dropped only when the hub refuses them; when it isn't reachable, both are kept for later.
  async _deliver(batch) {
    // Once per process: a hub left running by an older PeekInside is replaced by this version's.
    if (!this.hubVersionChecked) {
      this.hubVersionChecked = true;
      const replaced = await this.hub.replaceIfOlder().catch(() => null);
      if (replaced) console.log(`${LOG_PREFIX} Restarted the local dashboard: it was PeekInside ${replaced}, and this app uses ${VERSION}.`);
    }
    const blocked = this.blocked.take();
    const samples = this.takeSamples();
    const { requests, exceptions, jobs, logs, dumps, mails } = BatchTransport.split(batch);
    try {
      const answer = await this.hub.request('POST', '/api/ingest', {
        body: { project: this.project, instance: this.instance, requests, exceptions, jobs, logs, dumps, mails, samples, blocked: blocked.map(([, entry]) => entry) }
      });
      if (exceptions.length && answer.acceptedExceptions === undefined) this._noteOutdatedHub();
      else if ((jobs.length || logs.length) && answer.acceptedJobs === undefined) this._noteOutdatedHub();
      else if (dumps.length && answer.acceptedDumps === undefined) this._noteOutdatedHub();
      else if (mails.length && answer.acceptedMails === undefined) this._noteOutdatedHub();
      return true;
    } catch (error) {
      if (error.code === 'NOT_HUB') {
        this._disable(`Port ${this.hub.port} is used by another program, so the local dashboard can't start. Set PEEKINSIDE_HUB_PORT to a free port.`);
        return false;
      }
      if (error.status === 400 || error.status === 413) {
        // Sending the same data again would fail again.
        this._warn(`The local dashboard rejected ${batch.length} records: ${error.message}`);
        return false;
      }
      if (error.status >= 401 && error.status < 500) {
        this._disable(`The local dashboard refused requests (${error.message}). Restart it with: npx peekinside stop`);
        return false;
      }

      // Not running, starting up, or restarting: keep everything and try again shortly.
      this.blocked.restore(blocked);
      this.restoreSamples(samples);
      throw error;
    }
  }

  // A hub started before this version keeps running until it is restarted, and ignores what it
  // doesn't know (exceptions, job runs, log lines, dumps, emails).
  _noteOutdatedHub() {
    if (this.outdatedHubNoted) return;
    this.outdatedHubNoted = true;
    console.warn(`${LOG_PREFIX} The local dashboard on port ${this.hub.port} is an older version that doesn't store everything this app sends. Restart it to see it all: npx peekinside stop`);
  }

  _onDelivered() {
    this.spawns = 0;
    if (!this.announced) {
      this.announced = true;
      console.log(`${LOG_PREFIX} Requests from ${this.project.name}: ${this.hub.url}/p/${this.project.id}`);
    }
  }

  _onRetry(error) {
    if (error.code === 'ECONNREFUSED') this._startHub();
  }

  // Sends soon if the transport is running, or starts it (the first request may come before the
  // app's port is known).
  _wake() {
    if (this.started) this._schedule();
    else this.start();
  }

  // Sends after a short delay, so requests arriving together go in one batch; after a failure,
  // waits for the backoff to end.
  _schedule() {
    if (this.timer || this.inflight || this.disabled) return;
    const wait = Math.max(FLUSH_DELAY_MS, this.nextAttempt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  // Nothing listens on the hub's port: start the hub, at most every SPAWN_INTERVAL_MS and
  // MAX_SPAWNS times in a row, so a hub that crashes on start isn't respawned forever.
  _startHub() {
    if (Date.now() - this.lastSpawn < SPAWN_INTERVAL_MS) return;
    if (this.spawns >= MAX_SPAWNS) {
      this._warn(`The local dashboard isn't starting; see ${path.join(settings.dataDir(), 'hub.log')}. Requests are kept until it runs (start it with: npx peekinside).`);
      return;
    }
    this.lastSpawn = Date.now();
    this.spawns++;
    try {
      this.hub.spawn();
    } catch (error) {
      this._warn(`Could not start the local dashboard: ${error.message}`);
    }
  }
}

/**
 * Requests that were not recorded because they reached a server, counted until the hub has
 * them: one entry per public host name, and one for public clients behind a proxy.
 *
 * Entries are bounded: past MAX_BLOCKED_HOSTS entries, further host names fold into "*", so an
 * app reachable under many names can't grow the batch without limit.
 */
class BlockedRequests {
  /**
   * Starts with no counts.
   */
  constructor() {
    // Key ("host <name>", "host *" or "client") -> { kind, value, count }, in first-seen order.
    this._entries = new Map();
  }

  /**
   * Number of entries.
   *
   * @type {number}
   */
  get size() {
    return this._entries.size;
  }

  /**
   * Counts one request.
   *
   * @param {import('../deployment.js').ServerSignal} signal
   * @returns {string} The entry it was counted in
   */
  count(signal) {
    let key = signal.kind === 'host' ? `host ${signal.value}` : 'client';
    if (signal.kind === 'host' && !this._entries.has(key) && this._entries.size >= MAX_BLOCKED_HOSTS) key = 'host *';
    this._add(key, { kind: signal.kind, value: key === 'host *' ? '*' : signal.value, count: 1 });
    return key;
  }

  /**
   * Removes all entries, to send them.
   *
   * @returns {Array<[string, { kind: string, value: string, count: number }]>}
   */
  take() {
    const taken = [...this._entries];
    this._entries.clear();
    return taken;
  }

  /**
   * Puts back entries that could not be sent, adding them to anything counted since.
   *
   * @param {Array<[string, { kind: string, value: string, count: number }]>} taken - From take()
   * @returns {void}
   */
  restore(taken) {
    for (const [key, entry] of taken) this._add(key, entry);
  }

  _add(key, entry) {
    const current = this._entries.get(key);
    // For proxied clients, the latest address is kept as an example.
    this._entries.set(key, current ? { ...current, value: entry.value, count: current.count + entry.count } : { ...entry });
  }
}
