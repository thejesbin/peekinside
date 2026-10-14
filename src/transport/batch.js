/**
 * The delivery loop shared by the transports. Captured exchanges and exceptions become records in
 * one bounded in-memory queue and are sent in batches, never on the request path.
 *
 * One batch is in flight at a time, and concurrent flushes share it. A batch that fails is put
 * back at the front of the queue and sending backs off exponentially. When the queue is full the
 * oldest records are dropped, so memory stays flat while the destination is down.
 *
 * A process that is crashing can't wait for the next batch: deliverNow() hands records over
 * synchronously instead (each transport decides how).
 */

import { LOG_PREFIX } from '../config.js';
import { ExceptionRecord } from '../exceptions/exception-record.js';
import { RequestContext } from '../exceptions/request-context.js';
import { JobRunRecord } from '../jobs/job-run-record.js';
import { LogRecord } from '../logs/log-record.js';
import { RequestRecord } from '../record.js';

// A destination that stays down must not flood the app's logs.
const WARNING_INTERVAL_MS = 60_000;
// While the destination is down, the queue is bounded by size as well as by number: a backlog of
// heavy requests (large bodies, long timelines) never holds more memory than this.
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
// Sizes are measured only once this many records wait (the most that can pass 32 MB unmeasured is
// this many of the largest records), so normal sending rarely measures anything.
const MEASURE_FROM = 50;
// A record whose size can't be measured counts as this much.
const UNKNOWN_SIZE = 16 * 1024;
const sizes = new WeakMap();
// Process samples kept while the destination is down: the newest win.
const MAX_SAMPLES = 60;

/**
 * Abstract base of CloudTransport and LocalTransport.
 *
 * Subclasses implement _deliver(), which sends one batch, and decide when to flush through the
 * scheduling hooks (_onQueued, _onBackingOff, _afterAttempt). The other hooks let them react to
 * deliveries and failures.
 */
export class BatchTransport {
  /**
   * @param {Object} options
   * @param {string} options.environment - Normalized environment label, stored with every record
   * @param {string|null} [options.release=null] - The running release, stored with every record
   * @param {number} options.batchSize - Most records sent at once
   * @param {number} options.maxQueue - Most records kept while waiting to be sent
   * @param {number} options.firstBackoffMs - Wait after a first failure; it doubles with each
   *   further failure
   * @param {number} options.maxBackoffMs - Longest wait between attempts
   */
  constructor({ environment, release = null, batchSize, maxQueue, firstBackoffMs, maxBackoffMs }) {
    /**
     * Environment label stored with every record
     * @type {string}
     */
    this.environment = environment;
    /**
     * Release stored with every record (see release.js)
     * @type {string|null}
     */
    this.release = release;
    this.batchSize = batchSize;
    this.maxQueue = maxQueue;
    this.firstBackoffMs = firstBackoffMs;
    this.maxBackoffMs = maxBackoffMs;

    this.queue = [];
    // The attempt in progress, shared by concurrent flush() calls, and the records it sends.
    this.inflight = null;
    this.sending = [];
    // Set once the destination refused this process for good.
    this.disabled = false;
    // Current wait after consecutive failures, and the earliest time of the next attempt (ms).
    this.backoff = 0;
    this.nextAttempt = 0;
    this.lastWarning = 0;
    // Records dropped because the queue was full.
    this.dropped = 0;
    /**
     * Process samples waiting to be sent (see RuntimeSampler), sent along with the next batch
     * @type {import('../runtime/sampler.js').RuntimeSample[]}
     */
    this.samples = [];
    // Registered by subclasses, each with its own policy; removed by stop().
    this._onBeforeExit = () => this.flush();
  }

  /**
   * Queues an exchange for sending. Never blocks and never throws for network reasons.
   *
   * @param {import('../capture/exchange-recorder.js').Exchange} exchange
   * @returns {void}
   */
  enqueue(exchange) {
    if (this.disabled) return;
    this.enqueueRecord(RequestRecord.fromExchange(exchange, this.environment, this.release));
  }

  /**
   * Queues a record that is already built, such as an exception. Requests and exceptions share
   * the queue, its bound and its backoff.
   *
   * @param {RequestRecord|ExceptionRecord} record
   * @returns {void}
   */
  enqueueRecord(record) {
    if (this.disabled) return;
    this.queue.push(record);
    this._trimQueue();
    // Timers and posts started from here must not belong to the request being recorded.
    RequestContext.outside(() => this._onQueued());
  }

  /**
   * Queues a process sample; it goes with the next batch.
   *
   * @param {import('../runtime/sampler.js').RuntimeSample} sample
   * @returns {void}
   */
  addSample(sample) {
    if (this.disabled) return;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    RequestContext.outside(() => this._onQueued());
  }

  /**
   * Takes the samples to send with a batch.
   *
   * @returns {import('../runtime/sampler.js').RuntimeSample[]}
   */
  takeSamples() {
    return this.samples.splice(0);
  }

  /**
   * Puts samples back after a batch failed, ahead of newer ones.
   *
   * @param {import('../runtime/sampler.js').RuntimeSample[]} samples
   * @returns {void}
   */
  restoreSamples(samples) {
    if (!samples.length || this.disabled) return;
    this.samples.unshift(...samples);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  /**
   * Delivers records synchronously, for a process that may exit as soon as this returns (a crash,
   * or an app whose own error handler exits). Never throws. Abstract: the base class drops them.
   *
   * @param {Object} batch
   * @param {ExceptionRecord[]} batch.exceptions - The exceptions to deliver
   * @param {import('../capture/exchange-recorder.js').Exchange[]} batch.exchanges - Requests that
   *   were in progress, recorded as they stand
   * @param {boolean} batch.fatal - The process is exiting: what is still queued goes too
   * @returns {void}
   */
  deliverNow({ exceptions, exchanges, fatal }) {}

  /**
   * Splits records into the lists payloads have: requests, exceptions, job runs and log lines.
   *
   * @param {Array<RequestRecord|ExceptionRecord|JobRunRecord|LogRecord>} records
   * @returns {{ requests: RequestRecord[], exceptions: ExceptionRecord[], jobs: JobRunRecord[], logs: LogRecord[] }}
   */
  static split(records) {
    const requests = [];
    const exceptions = [];
    const jobs = [];
    const logs = [];
    for (const record of records) {
      if (record instanceof ExceptionRecord) exceptions.push(record);
      else if (record instanceof JobRunRecord) jobs.push(record);
      else if (record instanceof LogRecord) logs.push(record);
      else requests.push(record);
    }
    return { requests, exceptions, jobs, logs };
  }

  /**
   * Sends one batch now, unless sending is backing off after a failure. Concurrent callers share
   * the batch already in flight.
   *
   * @param {boolean} [force=false] - Send even when nothing is pending (a heartbeat)
   * @returns {Promise<void>} Settles when the attempt is over; never rejects
   */
  flush(force = false) {
    if (this.inflight) return this.inflight;
    if (this.disabled || (!force && !this._hasPending())) return Promise.resolve();
    if (Date.now() < this.nextAttempt) {
      this._onBackingOff();
      return Promise.resolve();
    }
    // Sending is PeekInside's own traffic, even when the app calls flush() during a request.
    this.inflight = RequestContext.outside(() => this._sendBatch().finally(() => {
      this.inflight = null;
      this._afterAttempt();
    }));
    return this.inflight;
  }

  /**
   * Sends everything queued, stopping early if sending fails.
   *
   * @returns {Promise<void>}
   */
  async drain() {
    await this.inflight;
    // A batch in flight took its records off the queue: wait for it too (a transport that sends
    // in several parts starts the next one as soon as the last is done).
    while ((this.queue.length || this.inflight) && !this.disabled) {
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length >= before && !this.inflight) break; // backing off after a failure
    }
  }

  /**
   * Stops listening for the process exit. Subclasses also stop their timers.
   *
   * @returns {void}
   */
  stop() {
    process.removeListener('beforeExit', this._onBeforeExit);
  }

  /**
   * Sends one batch. Abstract.
   *
   * @param {Array<RequestRecord|ExceptionRecord>} batch
   * @returns {Promise<boolean>} True once delivered; false when the destination refused the batch
   *   for good (the subclass has reported it, and the batch is dropped). Rejects when the batch
   *   should be retried later.
   */
  async _deliver(batch) {
    throw new Error(`${this.constructor.name} does not implement _deliver()`);
  }

  /**
   * @returns {boolean} Whether anything is waiting to be sent
   */
  _hasPending() {
    return this.queue.length > 0 || this.samples.length > 0;
  }

  /** Scheduling hook: a record was queued. */
  _onQueued() {}

  /** Scheduling hook: flush() was called while backing off, so nothing was sent. */
  _onBackingOff() {}

  /** Scheduling hook: an attempt is over, delivered or not. */
  _afterAttempt() {}

  /** Called after a batch was delivered. */
  _onDelivered() {}

  /**
   * Called after a failed batch was put back and the next attempt postponed (see `backoff`).
   *
   * @param {Error} error - Why the attempt failed
   */
  _onRetry(error) {}

  /**
   * Stops sending for good: the destination won't accept anything from this process.
   *
   * @param {string} message - Why, for the app's log
   * @returns {void}
   */
  _disable(message) {
    this.disabled = true;
    this.queue = [];
    this._logDisabled(`${LOG_PREFIX} ${message}`);
  }

  /**
   * Logs why sending stopped.
   *
   * @param {string} line
   */
  _logDisabled(line) {
    console.warn(line);
  }

  /**
   * Logs a warning, at most once a minute.
   *
   * @param {string} message
   * @returns {void}
   */
  _warn(message) {
    if (Date.now() - this.lastWarning < WARNING_INTERVAL_MS) return;
    this.lastWarning = Date.now();
    console.warn(`${LOG_PREFIX} ${message}`);
  }

  // Sends the oldest records. A failed batch goes back to the front of the queue, so records
  // keep their order, and the next attempt waits twice as long as the last one.
  async _sendBatch() {
    const batch = this.queue.splice(0, this.batchSize);
    this.sending = batch;
    try {
      if (await this._deliver(batch)) {
        this.backoff = 0;
        this.nextAttempt = 0;
        this._onDelivered();
      }
    } catch (error) {
      this.queue.unshift(...batch);
      this._trimQueue();
      this.backoff = Math.min(this.maxBackoffMs, this.backoff ? this.backoff * 2 : this.firstBackoffMs);
      this.nextAttempt = Date.now() + this.backoff;
      this._onRetry(error);
    } finally {
      this.sending = [];
    }
  }

  // Drops the oldest records beyond maxQueue, and beyond MAX_QUEUE_BYTES once a backlog builds.
  _trimQueue() {
    if (this.queue.length > this.maxQueue) {
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    if (this.queue.length <= MEASURE_FROM) return;
    let total = 0;
    for (const record of this.queue) total += sizeOf(record);
    let drop = 0;
    while (total > MAX_QUEUE_BYTES && drop < this.queue.length - 1) total -= sizeOf(this.queue[drop++]);
    if (drop) {
      this.dropped += drop;
      this.queue.splice(0, drop);
    }
  }
}

// About how much memory a queued record holds: its JSON size, measured once.
function sizeOf(record) {
  let size = sizes.get(record);
  if (size === undefined) {
    try {
      size = Buffer.byteLength(JSON.stringify(record));
    } catch (error) {
      size = UNKNOWN_SIZE;
    }
    sizes.set(record, size);
  }
  return size;
}
