/**
 * Records the exceptions of one PeekInside instance: from the framework integrations, from
 * report(), and from the process-level hooks (see ProcessMonitor).
 *
 * Every path ends here, so the rules live in one place:
 *
 * - Nothing is recorded while the instance doesn't record (paused, stopped, no destination), and
 *   nothing for requests that local mode refused to record because they reached a server.
 * - An error object is recorded once per request, however many hooks see it.
 * - At most 50 exceptions a second (bursts of 100) are recorded; crashes always are.
 * - Framework errors with a 4xx status (`createError(404)`, `ctx.throw(400)`) are how apps answer
 *   bad requests, not bugs, and aren't recorded automatically.
 * - Whether an Express error was handled is only known later: an error middleware that receives
 *   it may still pass it on to Express's final handler. Such records stay open on the request and
 *   are settled when the error reaches the final handler (unhandled) or the request's record is
 *   built (handled).
 *
 * Nothing here ever throws into the app: a failure to record is a lost exception, never a new one.
 */

import { ExceptionBuilder } from './exception-builder.js';
import { TokenBucket } from './rate-limiter.js';
import { RequestContext, RequestSnapshot } from './request-context.js';
import { splitUrl } from '../capture/http-message.js';
import { UserInfo } from '../user.js';

// Open records of a request that already finished wait this long for Express's final handler.
const LATE_SETTLE_MS = 50;

// Every capture, oldest first. Weak, so an app that drops its PeekInside instance doesn't leak it.
const registry = [];

/**
 * @typedef {Object} DeliverySink
 * @property {(record: import('./exception-record.js').ExceptionRecord) => void} enqueueRecord -
 *   Queues a record for the next batch
 * @property {(batch: { exceptions: Object[], exchanges: Object[], fatal: boolean }) => void} deliverNow -
 *   Delivers synchronously, for a process that may exit right away
 * @property {string} environment
 * @property {string|null} release
 * @property {boolean} disabled
 */

/**
 * Exception recording for one PeekInside instance.
 */
export class ExceptionCapture {
  /**
   * Adds a capture to the instances PeekInside.report() and the process hooks choose from.
   *
   * @param {ExceptionCapture} capture
   * @returns {void}
   */
  static register(capture) {
    registry.push(new WeakRef(capture));
  }

  /**
   * @param {ExceptionCapture} capture
   * @returns {void}
   */
  static unregister(capture) {
    for (let i = registry.length - 1; i >= 0; i--) {
      const current = registry[i].deref();
      if (!current || current === capture) registry.splice(i, 1);
    }
  }

  /**
   * The most recently created capture that is recording.
   *
   * @param {Object} [options]
   * @param {boolean} [options.automatic=false] - Only captures that record exceptions automatically
   *   (captureExceptions)
   * @returns {ExceptionCapture|null}
   */
  static latest({ automatic = false } = {}) {
    for (let i = registry.length - 1; i >= 0; i--) {
      const capture = registry[i].deref();
      if (!capture) {
        registry.splice(i, 1);
        continue;
      }
      if (capture.recording && (!automatic || capture.automatic)) return capture;
    }
    return null;
  }

  /**
   * Whether any registered capture records exceptions automatically, recording or not right now.
   *
   * @returns {boolean}
   */
  static anyAutomatic() {
    return registry.some((ref) => {
      const capture = ref.deref();
      return Boolean(capture && capture.automatic);
    });
  }

  /**
   * @param {Object} options
   * @param {string} options.root - The project folder: frames inside it are in-app
   * @param {boolean} [options.automatic=true] - Record exceptions automatically (captureExceptions);
   *   report() works either way
   * @param {boolean} [options.sourceContext=true] - Read source lines around in-app frames
   * @param {boolean} [options.sourceMaps=true] - Map frames of compiled code to their sources
   * @param {() => boolean} options.isEnabled - Whether the instance records right now
   * @param {() => DeliverySink|null} options.sink - Where records go (the instance's transport)
   * @param {TokenBucket} [options.limiter] - Rate limit (default: 50 a second, bursts of 100)
   * @param {Object} [options.owner] - The PeekInside instance it records for
   */
  constructor({ root, automatic = true, sourceContext = true, sourceMaps = true, isEnabled, sink, limiter = new TokenBucket(), owner = null }) {
    /**
     * The PeekInside instance it records for
     * @type {Object|null}
     */
    this.owner = owner;
    this.automatic = automatic;
    this.builder = new ExceptionBuilder({ root, sourceContext, sourceMaps });
    this.limiter = limiter;
    this._isEnabled = isEnabled;
    this._sink = sink;
  }

  /**
   * Whether exceptions are recorded right now.
   *
   * @type {boolean}
   */
  get recording() {
    const sink = this._sink();
    return Boolean(sink && !sink.disabled && this._isEnabled());
  }

  /**
   * An error reached a framework during a request: Express, Koa or Fastify.
   *
   * @param {RequestContext|null} context - The request's context
   * @param {*} error
   * @param {Object} options
   * @param {'express'|'koa'|'fastify'} options.mechanism
   * @param {boolean} options.handled - Whether the app handled it
   * @param {boolean} [options.open=false] - The outcome isn't final yet (see the module comment)
   * @returns {string|null} The exception's id, or null when nothing was recorded
   */
  frameworkError(context, error, { mechanism, handled, open = false }) {
    try {
      if (!this.automatic || !context || context.capture !== this || context.blocked) return null;
      if (!this.recording || isClientError(error)) return null;

      const existing = context.seen.get(error);
      if (existing) {
        // Handled on the way, but it still reached the final handler: unhandled after all.
        if (!handled && context.pending.has(error)) {
          context.pending.delete(error);
          existing.handled = false;
          this._emit(existing, context);
        }
        return existing.id;
      }
      if (!this.limiter.take()) return null;

      const record = this._build(error, { mechanism, handled, fatal: false, context });
      context.seen.set(error, record);
      noteSpan(context, record);
      if (open) {
        context.pending.set(error, record);
        if (context.finished) this._settleLater(context);
      } else {
        this._emit(record, context);
      }
      return record.id;
    } catch (failure) {
      return null;
    }
  }

  /**
   * Records an error the app reports (PeekInside#report()).
   *
   * @param {*} error
   * @param {Object} [options]
   * @param {import('http').IncomingMessage} [options.request] - The request it relates to (a
   *   Fastify request or a Koa context work too); otherwise the request running now, if any
   * @param {Object<string, string>} [options.tags]
   * @param {*} [options.extra]
   * @param {boolean} [options.handled=true]
   * @param {*} [options.user] - Who it happened to (see UserInfo); by default, the request's user
   * @returns {string|null} The exception's id, or null when nothing was recorded
   */
  report(error, { request, tags, extra, handled = true, user } = {}) {
    try {
      if (!this.recording) return null;
      const explicit = nodeRequest(request);
      let context = explicit ? RequestContext.of(explicit) : RequestContext.current();
      if (context && context.capture !== this) context = null;
      if (context && context.blocked) return null;

      const dedupe = context && error !== null && typeof error === 'object';
      if (dedupe && context.seen.has(error)) return context.seen.get(error).id;
      if (!this.limiter.take()) return null;

      const record = this._build(error, {
        mechanism: 'report',
        handled: handled !== false,
        fatal: false,
        context,
        request: context ? null : explicit,
        tags,
        extra,
        user: user === undefined ? undefined : UserInfo.normalize(user)
      });
      if (dedupe) context.seen.set(error, record);
      noteSpan(context, record);
      this._emit(record, context);
      return record.id;
    } catch (failure) {
      return null;
    }
  }

  /**
   * Records the error a job run failed with (PeekInside.job(), a scheduled task, a queue worker's
   * job): an exception like the others, with mechanism "job", linked to the run.
   *
   * @param {import('../jobs/job-context.js').JobContext} context
   * @param {*} error
   * @returns {string|null} The exception's id, or null when nothing was recorded
   */
  jobError(context, error) {
    try {
      if (!this.recording || !context) return null;
      const dedupe = error !== null && typeof error === 'object';
      if (dedupe && context.seen.has(error)) return context.seen.get(error).id;
      if (!this.limiter.take()) return null;
      const record = this._build(error, { mechanism: 'job', handled: false, fatal: false, context });
      if (dedupe) context.seen.set(error, record);
      noteSpan(context, record);
      this._emit(record, context);
      return record.id;
    } catch (failure) {
      return null;
    }
  }

  /**
   * Records an exception seen by the process-level hooks, and delivers it synchronously: the
   * process may exit as soon as the hook returns. For a crash, the request it happened in is
   * delivered too, as aborted, with the exceptions still open on it.
   *
   * @param {*} error
   * @param {Object} options
   * @param {'uncaught'|'unhandledRejection'|'http'} options.mechanism
   * @param {boolean} options.fatal - The process is about to exit
   * @param {boolean} options.handled
   * @param {RequestContext|null} options.context - The request it happened in, if known
   * @returns {string|null} The exception's id, or null when nothing was recorded
   */
  processError(error, { mechanism, fatal, handled, context }) {
    try {
      if (!this.recording || (context && context.blocked)) return null;
      // A crash is recorded whatever the rate: it happens once.
      if (!fatal && !this.limiter.take()) return null;

      const own = context && context.capture === this ? context : null;
      if (own) own.pending.delete(error);
      const record = this._build(error, { mechanism, handled, fatal, context: own });

      const exceptions = [];
      const exchanges = [];
      if (own && fatal) {
        // The request's open records are settled as they stand: the process won't get further.
        for (const open of own.pending.values()) {
          own.noteRecorded(open);
          exceptions.push(open);
        }
        own.pending.clear();
      }
      if (own) {
        own.seen.set(error, record);
        own.noteRecorded(record);
        noteSpan(own, record);
      }
      exceptions.push(record);

      if (own && fatal && own.recorder) {
        const exchange = own.recorder.takeExchange();
        if (exchange) {
          exchange.exceptionCount = own.exceptionCount;
          exchange.exceptions = own.links.slice();
          own.completeTimeline(exchange);
          if (own.user) exchange.user = own.user;
          exchanges.push(exchange);
        }
      }

      const sink = this._sink();
      if (sink) sink.deliverNow({ exceptions, exchanges, fatal });
      return record.id;
    } catch (failure) {
      return null;
    }
  }

  /**
   * Called when a request's record is built: settles its open records, and adds the exception
   * count and links to the exchange.
   *
   * @param {RequestContext} context
   * @param {import('../capture/exchange-recorder.js').Exchange} exchange - Changed in place
   * @returns {void}
   */
  finish(context, exchange) {
    try {
      this.settle(context);
      exchange.exceptionCount = context.exceptionCount;
      exchange.exceptions = context.links.slice();
    } catch (failure) {
      // The request is still recorded, without its exceptions.
    }
  }

  /**
   * Queues a request's open records as handled: the error never reached the final handler.
   *
   * @param {RequestContext} context
   * @returns {void}
   */
  settle(context) {
    if (!context.pending.size) return;
    const records = [...context.pending.values()];
    context.pending.clear();
    for (const record of records) this._emit(record, context);
  }

  // An error middleware received an error after the request's record was built (it answered,
  // then passed an error on): settle shortly, unless the final handler gets the error first.
  _settleLater(context) {
    const timer = setTimeout(() => this.settle(context), LATE_SETTLE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  _build(error, { mechanism, handled, fatal, context, request = null, tags, extra, user }) {
    const sink = this._sink();
    let snapshot = null;
    let requestLine = null;
    if (context) {
      snapshot = context.snapshot();
      requestLine = context.requestLine();
    } else if (request) {
      snapshot = RequestSnapshot.fromRequest(request);
      requestLine = { method: snapshot.method, path: splitUrl(snapshot.url).pathname };
    }
    return this.builder.build(error, {
      mechanism,
      handled,
      fatal,
      environment: sink ? sink.environment : 'development',
      release: sink ? sink.release || null : null,
      requestId: context ? context.requestId : null,
      request: snapshot,
      requestLine,
      user: user !== undefined ? user : context ? context.user : null,
      jobRunId: context ? context.jobRunId || null : null,
      job: context && context.jobName ? { name: context.jobName } : null,
      tags,
      extra
    });
  }

  _emit(record, context) {
    if (context) context.noteRecorded(record);
    const sink = this._sink();
    if (sink) sink.enqueueRecord(record);
  }
}

// An exception recorded during a request is a span on its timeline too.
function noteSpan(context, record) {
  if (context && context.timeline) context.timeline.exception(record);
}

// The Node.js request behind what report() was given: the request itself (Express, http), a
// Fastify request (`raw`) or a Koa context or request (`req`).
function nodeRequest(request) {
  if (!request || typeof request !== 'object') return null;
  for (const candidate of [request, request.raw, request.req]) {
    if (candidate && typeof candidate === 'object' && RequestContext.of(candidate)) return candidate;
  }
  for (const candidate of [request.raw, request.req]) {
    if (candidate && typeof candidate === 'object' && candidate.headers && typeof candidate.method === 'string') return candidate;
  }
  return request;
}

// Status 4xx on the error: the app's answer to a bad request.
function isClientError(error) {
  if (error === null || typeof error !== 'object') return false;
  let status;
  try {
    status = error.status !== undefined ? error.status : error.statusCode;
  } catch (failure) {
    return false;
  }
  return Number.isInteger(status) && status >= 400 && status < 500;
}
