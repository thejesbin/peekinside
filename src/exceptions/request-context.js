/**
 * Which request a piece of code runs for, so an exception can be linked to it.
 *
 * Each tracked request runs the rest of its handling inside an AsyncLocalStorage context (the
 * integrations wrap next(), done() or the server's emit()), and the context follows timers,
 * promises and the request's own events. One place loses it: an exception thrown synchronously
 * out of the handler unwinds the context before the process-level hooks see it. For that case the
 * request an exception last escaped from is remembered until the current job ends; the uncaught
 * exception hook, which runs right after the throw, picks it up.
 *
 * The escape is noticed in a `finally` block, never by catching and rethrowing: a rethrown error
 * would make Node.js print the rethrowing line instead of the app's line when the process crashes.
 *
 * The context also keeps the request's exception bookkeeping: which errors were already recorded
 * (each error object is recorded once per request), the records whose outcome is still open (see
 * ExceptionCapture), and the count and links that go into the request's record.
 *
 * Integrations that know what the framework matched the request to note it here (noteRoute()):
 * the route pattern, the code that handles it and the route parameters. The request's record and
 * its exceptions carry them.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { BodyDecoder } from '../capture/body-decoder.js';
import { parseQuery, splitUrl, stringParams } from '../capture/http-message.js';
import { LIMITS, truncate } from './limits.js';

const storage = new AsyncLocalStorage();
const kContext = Symbol('peekInside.context');
// What a route pattern and a handler name may take up.
const MAX_ROUTE = 512;
const MAX_HANDLER = 256;
// Dumps and emails listed in a request's record (the Dumps and Mail pages have them all).
const MAX_DUMP_LINKS = 20;
const MAX_MAIL_LINKS = 20;
// The request an exception last escaped from, until the current job ends.
let escaped = null;

/**
 * One request, as exception capture sees it.
 */
export class RequestContext {
  /**
   * The context of the code running now.
   *
   * @returns {RequestContext|null}
   */
  static current() {
    return storage.getStore() || null;
  }

  /**
   * Runs `fn` outside any request, along with everything asynchronous it starts: PeekInside's own
   * work (posting batches to the hub or the cloud, starting the hub) runs from inside requests at
   * times, and must never show up on a request's timeline.
   *
   * @param {Function} fn
   * @returns {*} What fn returns
   */
  static outside(fn) {
    return storage.exit(fn);
  }

  /**
   * The context of a request object.
   *
   * @param {import('http').IncomingMessage} req
   * @returns {RequestContext|null}
   */
  static of(req) {
    if (!req || (typeof req !== 'object' && typeof req !== 'function')) return null;
    return req[kContext] || null;
  }

  /**
   * The request an exception escaped from synchronously during the current job, if one did: the
   * request of the exception the uncaught exception hook is looking at.
   *
   * @returns {RequestContext|null}
   */
  static escaped() {
    return escaped;
  }

  /**
   * @param {Object} fields
   * @param {import('./exception-capture.js').ExceptionCapture|null} fields.capture - Records the
   *   request's exceptions (the PeekInside instance tracking it)
   * @param {import('http').IncomingMessage} fields.req
   * @param {import('../capture/exchange-recorder.js').ExchangeRecorder|null} [fields.recorder] -
   *   Records the request itself; null when it isn't recorded
   * @param {{ url: string, pathname: string, search: string }} fields.target - The request target
   * @param {boolean} [fields.blocked=false] - The request reached a server in local mode: neither
   *   it nor its exceptions are recorded
   * @param {string} [fields.integration='custom'] - Where tracking started: "express", "koa",
   *   "fastify", "nest", "hono", "http" (a server's emit()) or "custom" (intercept())
   */
  constructor({ capture, req, recorder = null, target, blocked = false, integration = 'custom' }) {
    this.capture = capture;
    this.recorder = recorder;
    this.blocked = blocked;
    this.integration = integration;
    /**
     * Id of the request's record, or null when it isn't recorded
     * @type {string|null}
     */
    this.requestId = recorder ? recorder.id : null;
    this.method = String((req && req.method) || '');
    this.url = target.url;
    this.path = target.pathname;
    this.search = target.search;

    /** Exceptions recorded during the request, for its record. */
    this.exceptionCount = 0;
    this.links = [];
    // Error (or thrown value) -> its record, so each is recorded once per request.
    this.seen = new Map();
    // Records whose outcome is still open: handled unless the error reaches the final handler.
    this.pending = new Map();
    // Set once the request's record is built.
    this.finished = false;
    /**
     * The request's timeline (see src/timeline), when the instance records one
     * @type {import('../timeline/timeline.js').Timeline|null}
     */
    this.timeline = null;
    /**
     * Who the request is for, once the app said so (PeekInside.setUser())
     * @type {import('../user.js').User|null}
     */
    this.user = null;
    /**
     * The route pattern the framework matched ("/users/:id"), once an integration noted it
     * @type {string|null}
     */
    this.route = null;
    /**
     * The code that handles the request ("UsersController.findOne"), once an integration noted it
     * @type {string|null}
     */
    this.handler = null;
    /**
     * Dumps made during the request (PeekInside.dump()), for its record
     * @type {{ id: string, label: string|null, type: string, preview: string }[]}
     */
    this.dumps = [];
    /**
     * Emails sent during the request (nodemailer), for its record
     * @type {{ id: string, subject: string, to: string[] }[]}
     */
    this.mails = [];

    this._req = req;
    // Route parameters an integration noted (or a function returning them), for frameworks that
    // don't put them on the Node.js request.
    this._params = undefined;
    // What remains for exceptions after the request finished (see release()).
    this._after = null;

    if (req && typeof req === 'object') {
      Object.defineProperty(req, kContext, { value: this, configurable: true, writable: true });
    }
  }

  /**
   * Runs `fn` inside this context. When an exception escapes it, this request is remembered as the
   * one it escaped from (see RequestContext.escaped()); the exception itself passes through
   * untouched.
   *
   * @param {Function} fn
   * @returns {*} What `fn` returns
   */
  run(fn) {
    // Code is running again, so an earlier escape was caught by someone: it is not the one a crash
    // hook may see next.
    escaped = null;
    let returned = false;
    try {
      const result = storage.run(this, fn);
      returned = true;
      return result;
    } finally {
      if (!returned) noteEscape(this);
    }
  }

  /**
   * Makes an emitter's listeners run inside this context. The request's and response's events
   * ('data', 'end', 'finish'...) come from the socket, outside any request, so listeners the app
   * adds to them would otherwise lose the request.
   *
   * @param {import('events').EventEmitter} emitter
   * @returns {void}
   */
  bind(emitter) {
    if (!emitter || typeof emitter.emit !== 'function') return;
    const context = this;
    const originalEmit = emitter.emit;
    emitter.emit = function () {
      return context.run(() => originalEmit.apply(this, arguments));
    };
  }

  /**
   * Notes what the framework matched the request to, as an integration learns it. Each part that is
   * given replaces the one noted before; null forgets it, and parts left out stay as they are.
   *
   * @param {Object} match
   * @param {string|null} [match.route] - The route pattern, such as "/users/:id"
   * @param {string|null} [match.handler] - The code that handles it, such as "UsersController.findOne"
   * @param {Object|(() => Object)|null} [match.params] - The route parameters, or a function that
   *   returns them when they are needed, for frameworks that keep them off the Node.js request
   * @returns {void}
   */
  noteRoute({ route, handler, params } = {}) {
    if (route !== undefined) this.route = typeof route === 'string' && route ? truncate(route, MAX_ROUTE) : null;
    if (handler !== undefined) this.handler = typeof handler === 'string' && handler ? truncate(handler, MAX_HANDLER) : null;
    if (params !== undefined) this._params = params;
  }

  /**
   * The route parameters an integration noted, as strings.
   *
   * @returns {Object<string, string>|null} null when none were noted
   */
  routeParams() {
    let params = this._params;
    if (typeof params === 'function') {
      try {
        params = params();
      } catch (error) {
        params = null;
      }
    }
    return params && typeof params === 'object' ? stringParams(params) : null;
  }

  /**
   * For the exception list: the request's method and path, and its route and handler when known.
   *
   * @returns {{ method: string, path: string, route?: string, handler?: string }}
   */
  requestLine() {
    return {
      method: this.method,
      path: this.path,
      ...(this.route ? { route: this.route } : {}),
      ...(this.handler ? { handler: this.handler } : {})
    };
  }

  /**
   * Counts a dump made during the request: listed on its record, and placed on its timeline.
   *
   * @param {import('../dumps/dump-record.js').DumpRecord} record
   * @returns {void}
   */
  noteDump(record) {
    if (this.dumps.length < MAX_DUMP_LINKS) this.dumps.push(record.link());
    if (this.timeline) this.timeline.dump(record);
  }

  /**
   * Counts an email the request starts sending: listed on its record right away (it may finish after
   * the response), and placed on its timeline until the transport answers.
   *
   * @param {{ id: string, subject: string, to: string[] }} link - What the record lists
   * @returns {import('../timeline/timeline.js').SpanHandle|null} The span to end once it's sent
   */
  noteMail(link) {
    if (this.mails.length < MAX_MAIL_LINKS) this.mails.push(link);
    return this.timeline ? this.timeline.mail(link) : null;
  }

  /**
   * Adds what the request's record shows of the request beyond the exchange itself: who it was for,
   * its route and handler, the dumps made and emails sent during it, and route parameters the
   * Node.js request didn't carry.
   *
   * @param {import('../capture/exchange-recorder.js').Exchange} exchange - Changed in place
   * @returns {void}
   */
  describe(exchange) {
    if (this.user) exchange.user = this.user;
    if (this.route) exchange.route = this.route;
    if (this.handler) exchange.handler = this.handler;
    if (this.dumps.length) exchange.dumps = this.dumps.slice();
    if (this.mails.length) exchange.mails = this.mails.slice();
    if (this._params !== undefined && (!exchange.params || !Object.keys(exchange.params).length)) {
      const params = this.routeParams();
      if (params) exchange.params = params;
    }
  }

  /**
   * The request as an exception's detail shows it. After the response, the body is no longer
   * kept (the request's own record has it).
   *
   * @returns {Object} A RequestSnapshot
   */
  snapshot() {
    if (this.recorder && !this.recorder.recorded) {
      const snapshot = { id: this.requestId, ...this.recorder.snapshot(LIMITS.requestBody) };
      if (this._params !== undefined && !Object.keys(snapshot.params).length) snapshot.params = this.routeParams() || {};
      return snapshot;
    }
    const after = this._after || this._parts();
    return {
      id: this.requestId,
      method: this.method,
      url: this.url,
      headers: { ...after.headers },
      query: parseQuery(this.search),
      params: { ...after.params },
      body: '',
      bodyTruncated: false,
      ip: after.ip,
      userAgent: after.userAgent
    };
  }

  /**
   * Counts a recorded exception for the request's record.
   *
   * @param {import('./exception-record.js').ExceptionRecord} record
   * @returns {void}
   */
  noteRecorded(record) {
    this.exceptionCount++;
    if (this.links.length < LIMITS.requestLinks) this.links.push(record.link());
  }

  /**
   * Completes the exchange being turned into the request's record: its exceptions (settling the
   * ones still open) and its timeline. Then lets go of the request (see release()).
   *
   * @param {import('../capture/exchange-recorder.js').Exchange} exchange - Changed in place
   * @returns {void}
   */
  complete(exchange) {
    if (this.capture) this.capture.finish(this, exchange);
    this.completeTimeline(exchange);
    this.describe(exchange);
    this.release();
  }

  /**
   * Closes the request's timeline and adds its counters (and its spans, if any) to the exchange.
   *
   * @param {import('../capture/exchange-recorder.js').Exchange} exchange - Changed in place
   * @returns {void}
   */
  completeTimeline(exchange) {
    if (!this.timeline) return;
    try {
      const { stats, timeline } = this.timeline.close();
      exchange.stats = stats;
      if (timeline) exchange.timeline = timeline;
    } catch (error) {
      // The request is still recorded, without its timeline.
    }
  }

  /**
   * Lets go of the request and response objects once the request's record is built: code that
   * keeps running for the request (a timer, a pool created during it) may hold the context for
   * long, and must not hold the request's bodies (or its timeline) with it.
   *
   * @returns {void}
   */
  release() {
    this.finished = true;
    this._after = this._parts();
    // A function returning the parameters may hold the framework's request.
    if (typeof this._params === 'function') this._params = this.routeParams();
    this._req = null;
    this.recorder = null;
    this.timeline = null;
  }

  // The small parts of the request a snapshot keeps, with the parameters an integration noted when
  // the request has none of its own.
  _parts() {
    const parts = RequestSnapshot.partsOf(this._req);
    if (this._params !== undefined && !Object.keys(parts.params).length) parts.params = this.routeParams() || {};
    return parts;
  }
}

/**
 * Snapshots of requests that are not tracked, for report(error, { request }).
 */
export class RequestSnapshot {
  /**
   * @param {import('http').IncomingMessage} req
   * @returns {Object} A RequestSnapshot without an id; the body is what a body parser left on
   *   req.body, if anything
   */
  static fromRequest(req) {
    const url = String(req.originalUrl || req.url || '/');
    const { search } = splitUrl(url);
    const parts = RequestSnapshot.partsOf(req);
    let body = '';
    let bodyTruncated = false;
    try {
      if (req.body !== undefined) {
        const content = new BodyDecoder(LIMITS.requestBody).decodeValue(req.body, parts.headers);
        if (content.encoding === 'utf8') {
          body = content.text;
          bodyTruncated = content.truncated;
        }
      }
    } catch (error) {
      body = '';
    }
    return {
      id: null,
      method: String(req.method || ''),
      url,
      headers: { ...parts.headers },
      query: parseQuery(search),
      params: { ...parts.params },
      body,
      bodyTruncated,
      ip: parts.ip,
      userAgent: parts.userAgent
    };
  }

  /**
   * The small parts of a request that a snapshot keeps.
   *
   * @param {import('http').IncomingMessage|null} req
   * @returns {{ headers: Object, params: Object, ip: string, userAgent: string }}
   */
  static partsOf(req) {
    if (!req) return { headers: {}, params: {}, ip: '', userAgent: '' };
    const headers = req.headers && typeof req.headers === 'object' ? req.headers : {};
    const params = {};
    if (req.params && typeof req.params === 'object') {
      for (const key of Object.keys(req.params)) {
        const value = req.params[key];
        if (value !== undefined && value !== null && typeof value !== 'object') params[key] = String(value);
      }
    }
    return {
      headers,
      params,
      ip: String(req.ip || (req.socket && req.socket.remoteAddress) || ''),
      userAgent: String(headers['user-agent'] || '')
    };
  }
}

// The innermost context wins: the exception escaped from it first. Once the job ends, the
// exception was either caught by someone else or has been handled by the uncaught exception
// hook, so the note is cleared.
function noteEscape(context) {
  if (escaped) return;
  escaped = context;
  queueMicrotask(() => {
    escaped = null;
  });
}
