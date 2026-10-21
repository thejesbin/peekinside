/**
 * The timeline of one request: everything that happened while it was handled, as spans (database
 * queries, outgoing HTTP calls, console lines, exceptions, custom measures, event-loop blocks),
 * plus counters for lists and filters (see the timeline data contract).
 *
 * Instrumentations find the timeline of the code running now with Timeline.current() and record
 * through it. The timeline closes when the request's record is built: what starts later (work
 * the app keeps doing after the response) is ignored, and spans still open at that moment are kept
 * without a duration.
 *
 * Queries are grouped into statements by fingerprint (the statement without its values), which is
 * what N+1 detection, duplicate detection and the per-statement numbers are built on. Every
 * collection is capped, and the serialized timeline stays within 512 KB, so a request that runs
 * ten thousand queries costs a bounded amount of memory and bandwidth; the counters still count
 * everything.
 */

import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { RequestContext } from '../exceptions/request-context.js';
import { Operation } from '../instrumentation/operation.js';
import { LoopMonitor } from '../runtime/loop-monitor.js';
import { Caller } from './caller.js';
import { ExecutionHash } from './execution-hash.js';
import { LruCache } from './lru.js';
import { Masker } from './masking.js';
import { SqlText } from './sql.js';

export const TIMELINE_DEFAULTS = Object.freeze({
  captureQueries: true,
  captureOutgoing: true,
  captureLogs: true,
  queryParams: true,
  slowQueryMs: 100,
  nPlusOneThreshold: 5,
  loopBlockMs: 100
});

// Spans listed per request, by type.
const SPAN_CAPS = Object.freeze({ query: 500, http: 100, log: 200, measure: 100, exception: 10, block: 20, dump: 50, mail: 20 });
const MAX_STATEMENTS = 200;
// Executions per statement whose parameters are kept.
const PARAMS_PER_STATEMENT = 20;
const MAX_PARAMS = 50;
const BUDGET_BYTES = 512 * 1024;
const MAX_TEXT = 4096;
const MAX_ERROR = 500;
const MAX_LOG = 2000;
const MAX_NAME = 200;
const MAX_EXCEPTION_MESSAGE = 500;
// Distinct executions remembered per statement for duplicate detection.
const MAX_SEEN = 1000;

// Shared by every timeline: statements repeat across requests.
const sqlText = new SqlText();
const shapeFingerprints = new LruCache(500);

/**
 * What one PeekInside instance records on its timelines.
 */
export class TimelineSettings {
  /**
   * @param {Object} options - PeekInside options (see TIMELINE_DEFAULTS)
   * @param {string} root - The project folder, where callers are looked for
   */
  constructor(options, root) {
    this.captureQueries = options.captureQueries !== false;
    this.captureOutgoing = options.captureOutgoing !== false;
    this.captureLogs = options.captureLogs !== false;
    this.queryParams = options.queryParams !== false;
    this.slowQueryMs = Number.isFinite(options.slowQueryMs) && options.slowQueryMs >= 0 ? options.slowQueryMs : TIMELINE_DEFAULTS.slowQueryMs;
    this.nPlusOneThreshold = Number.isInteger(options.nPlusOneThreshold) && options.nPlusOneThreshold >= 2
      ? options.nPlusOneThreshold
      : TIMELINE_DEFAULTS.nPlusOneThreshold;
    // 0 turns block detection off (loopBlockMs: false).
    this.loopBlockMs = options.loopBlockMs === false || options.loopBlockMs === 0
      ? 0
      : Number.isFinite(options.loopBlockMs) && options.loopBlockMs >= 50 ? options.loopBlockMs : TIMELINE_DEFAULTS.loopBlockMs;
    this.caller = new Caller(root);
  }
}

/**
 * One request's timeline.
 */
export class Timeline {
  /**
   * The open timeline of the request the calling code runs for.
   *
   * @returns {Timeline|null}
   */
  static current() {
    const context = RequestContext.current();
    const timeline = context && context.timeline;
    return timeline && !timeline.closed ? timeline : null;
  }

  /**
   * The fingerprint a SQL statement gets, for code that needs it before running the statement
   * (caller hints).
   *
   * @param {string} text
   * @param {string} system
   * @returns {string|null} null when the text can't be analyzed
   */
  static sqlFingerprint(text, system) {
    try {
      return sqlText.analyze(text, system).fingerprint;
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {TimelineSettings} settings
   * @param {number} [origin=performance.now()] - performance.now() at the instant the request's
   *   occurredAt was taken: span starts are offsets from it
   */
  constructor(settings, origin = performance.now()) {
    this.settings = settings;
    this.origin = origin;
    this.closed = false;
    this.spans = [];
    this.listed = { query: 0, http: 0, log: 0, measure: 0, exception: 0, block: 0, dump: 0, mail: 0 };
    this.dropped = 0;
    this.statements = [];
    this.byFingerprint = new Map();
    // Statements past the cap: counted, not listed.
    this.overflow = new Map();
    this.stats = { queries: 0, queryTime: 0, slowQueries: 0, duplicates: 0, http: 0, httpTime: 0, logs: 0, loopBlock: 0 };
    this._result = null;
    if (settings.loopBlockMs > 0) LoopMonitor.track(this);
  }

  /**
   * Whether statements need a caller hint: true when `fingerprint` hasn't run in this request yet.
   *
   * @param {string} fingerprint
   * @returns {boolean}
   */
  needsCaller(fingerprint) {
    return typeof fingerprint === 'string' && !this.byFingerprint.has(fingerprint) && this.statements.length < MAX_STATEMENTS;
  }

  /**
   * Starts a query span.
   *
   * @param {Object} query
   * @param {'postgresql'|'mysql'|'mongodb'|'sqlite'|'sqlserver'|'other'} query.system
   * @param {'pg'|'mysql2'|'mongodb'|'prisma'} query.client
   * @param {string} query.text - SQL as sent; for MongoDB and Prisma, the value-free shape
   * @param {boolean} [query.sql=true] - Whether `text` is SQL (analyzed and masked) or a shape
   * @param {Array|Object} [query.params] - The values sent, unmasked (they are masked here)
   * @param {string} [query.operation] - The ORM call that ran it, such as "User.findMany"
   * @param {() => (import('./caller.js').CallerInfo|null)} [query.caller] - Finds the caller when
   *   the stack can't (Prisma)
   * @param {number} [query.startedAt] - performance.now() when the query started, for a query
   *   recorded once it is over; now by default
   * @returns {SpanHandle|null} null when queries aren't recorded, or this one couldn't be (the
   *   app's query runs all the same)
   */
  query(query) {
    try {
      return this._query(query);
    } catch (error) {
      return null;
    }
  }

  _query({ system, client, text, sql = true, params, operation, caller, startedAt = performance.now() }) {
    if (this.closed || !this.settings.captureQueries) return null;
    const analysis = sql ? sqlText.analyze(text, system) : shapeAnalysis(text);
    this.stats.queries++;

    let statement = this.byFingerprint.get(analysis.fingerprint);
    if (!statement && this.statements.length < MAX_STATEMENTS) {
      statement = new Statement({
        index: this.statements.length,
        system,
        client,
        text: cut(analysis.maskedText, MAX_TEXT),
        fingerprint: analysis.fingerprint,
        caller: this._caller(analysis.fingerprint, caller)
      });
      this.statements.push(statement);
      this.byFingerprint.set(analysis.fingerprint, statement);
    }
    const tracked = statement || this._overflow(analysis.fingerprint);
    tracked.count++;
    const execution = ExecutionHash.of(text, params);
    if (tracked.seen.has(execution)) {
      tracked.duplicates++;
      this.stats.duplicates++;
    } else if (tracked.seen.size < MAX_SEEN) {
      tracked.seen.add(execution);
    }

    let span = null;
    if (statement && this.listed.query < SPAN_CAPS.query) {
      this.listed.query++;
      span = { type: 'query', start: this._offset(startedAt), duration: null, statement: statement.index };
      const shown = cut(analysis.maskedText, MAX_TEXT);
      if (shown !== statement.text) span.text = shown;
      if (this.settings.queryParams && params != null && statement.paramsKept < PARAMS_PER_STATEMENT) {
        const masked = maskParams(params, analysis.sensitive);
        if (masked !== undefined) {
          statement.paramsKept++;
          span.params = masked;
        }
      }
      if (operation) span.operation = String(operation).slice(0, MAX_NAME);
      this.spans.push(span);
    } else {
      this.dropped++;
    }
    return new SpanHandle(this, 'query', span, startedAt, tracked);
  }

  /**
   * Starts an outgoing HTTP call span.
   *
   * @param {Object} call
   * @param {'http'|'fetch'} call.client
   * @param {string} call.method
   * @param {string} call.url - Masked here (credentials, sensitive query values)
   * @param {string} call.host
   * @returns {SpanHandle|null} null when outgoing calls aren't recorded, or this one couldn't be
   */
  http(call) {
    try {
      return this._http(call);
    } catch (error) {
      return null;
    }
  }

  _http({ client, method, url, host }) {
    if (this.closed || !this.settings.captureOutgoing) return null;
    const startedAt = performance.now();
    let span = null;
    if (this.listed.http < SPAN_CAPS.http) {
      span = {
        type: 'http',
        start: this._offset(startedAt),
        duration: null,
        client,
        method: String(method || 'GET').toUpperCase().slice(0, 16),
        url: Masker.url(url),
        host: String(host || '').toLowerCase().slice(0, 255),
        status: null
      };
      this.listed.http++;
      this.spans.push(span);
    } else {
      this.dropped++;
    }
    this.stats.http++;
    return new SpanHandle(this, 'http', span, startedAt, null);
  }

  /**
   * Records a log line.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} message - Formatted as it was written
   * @param {'console'|'pino'|'winston'|'nest'} [source='console']
   * @returns {void}
   */
  log(level, message, source = 'console') {
    if (this.closed || !this.settings.captureLogs) return;
    try {
      const span = { type: 'log', start: this._offset(performance.now()), level, message: cut(String(message), MAX_LOG), source };
      this.stats.logs++;
      if (this.listed.log < SPAN_CAPS.log) {
        this.listed.log++;
        this.spans.push(span);
      } else {
        this.dropped++;
      }
    } catch (error) {
      // A message that can't be read as text isn't recorded.
    }
  }

  /**
   * Records a dump made during the request (local dashboard only): its label and a preview of the
   * value; the Dumps page has the value itself.
   *
   * @param {{ id: string, label: string|null, summary: { preview: string } }} record - A DumpRecord
   * @returns {void}
   */
  dump(record) {
    if (this.closed) return;
    try {
      if (this.listed.dump < SPAN_CAPS.dump) {
        this.listed.dump++;
        this.spans.push({ type: 'dump', start: this._offset(performance.now()), id: record.id, label: record.label, preview: cut(record.summary.preview, MAX_LOG) });
      } else {
        this.dropped++;
      }
    } catch (error) {
      // The dump is still on the Dumps page.
    }
  }

  /**
   * Starts the span of an email the request sends (local dashboard only): from the sendMail() call
   * to the transport's answer. The Mail page has the message.
   *
   * @param {{ id: string, subject: string, to: string[] }} mail
   * @returns {SpanHandle|null} null once the request's timeline is closed
   */
  mail(mail) {
    if (this.closed) return null;
    try {
      const startedAt = performance.now();
      let span = null;
      if (this.listed.mail < SPAN_CAPS.mail) {
        this.listed.mail++;
        span = { type: 'mail', start: this._offset(startedAt), duration: null, id: mail.id, subject: cut(mail.subject, MAX_LOG), to: mail.to.slice(0, 3) };
        this.spans.push(span);
      } else {
        this.dropped++;
      }
      return new SpanHandle(this, 'mail', span, startedAt, null);
    } catch (error) {
      return null;
    }
  }

  /**
   * Records an exception recorded during the request.
   *
   * @param {{ id: string, summary: { name: string, message: string } }} record - An ExceptionRecord
   * @returns {void}
   */
  exception(record) {
    if (this.closed) return;
    try {
      if (this.listed.exception < SPAN_CAPS.exception) {
        this.spans.push({
          type: 'exception',
          start: this._offset(performance.now()),
          id: record.id,
          name: record.summary.name,
          message: cut(record.summary.message, MAX_EXCEPTION_MESSAGE)
        });
        this.listed.exception++;
      } else {
        this.dropped++;
      }
    } catch (error) {
      // Not recorded on the timeline; the exception itself is.
    }
  }

  /**
   * Records that the event loop was blocked while the request was in flight (see LoopMonitor):
   * the request waited, whichever code blocked it. Blocks shorter than the settings' loopBlockMs
   * are left out.
   *
   * @param {number} start - performance.now() when the block began
   * @param {number} duration - ms
   * @returns {void}
   */
  block(start, duration) {
    if (this.closed || !this.settings.loopBlockMs) return;
    // A block that began before the request counts from the request's start.
    const from = Math.max(start, this.origin);
    const length = start + duration - from;
    if (length < this.settings.loopBlockMs) return;
    if (length > this.stats.loopBlock) this.stats.loopBlock = length;
    if (this.listed.block < SPAN_CAPS.block) {
      this.listed.block++;
      this.spans.push({ type: 'block', start: this._offset(from), duration: round(length) });
    } else {
      this.dropped++;
    }
  }

  /**
   * Starts a measure span (PeekInside#measure()).
   *
   * @param {string} name
   * @returns {SpanHandle|null} null once the timeline is closed, or for a name that can't be read
   *   as text
   */
  measure(name) {
    if (this.closed) return null;
    const startedAt = performance.now();
    let span = null;
    try {
      if (this.listed.measure < SPAN_CAPS.measure) {
        span = { type: 'measure', start: this._offset(startedAt), duration: null, name: cut(String(name), MAX_NAME) };
        this.listed.measure++;
        this.spans.push(span);
      } else {
        this.dropped++;
      }
    } catch (error) {
      return null;
    }
    return new SpanHandle(this, 'measure', span, startedAt, null);
  }

  /**
   * Closes the timeline, for the request's record. Later spans are ignored; spans still open keep
   * a null duration. Calling it again returns the same result.
   *
   * @returns {{ stats: Object, timeline: Object|undefined }} `timeline` only when something was
   *   recorded
   */
  close() {
    if (this._result) return this._result;
    // The request may have blocked the loop itself and finished before the monitor could tell.
    const pending = this.settings.loopBlockMs ? LoopMonitor.pending() : null;
    if (pending) this.block(pending.start, pending.duration);
    LoopMonitor.untrack(this);
    this.closed = true;
    const threshold = this.settings.nPlusOneThreshold;
    let nPlusOne = 0;
    for (const statement of this.statements) if (statement.count >= threshold) nPlusOne++;
    for (const statement of this.overflow.values()) if (statement.count >= threshold) nPlusOne++;

    const stats = {
      queries: this.stats.queries,
      queryTime: round(this.stats.queryTime),
      slowQueries: this.stats.slowQueries,
      nPlusOne,
      duplicates: this.stats.duplicates,
      http: this.stats.http,
      httpTime: round(this.stats.httpTime),
      logs: this.stats.logs,
      loopBlock: round(this.stats.loopBlock)
    };

    // By start, then in the order they were created (a stable sort): spans recorded once they were
    // over (a Prisma operation) start before spans created in the meantime.
    const spans = this.spans.filter((span) => !span.cancelled).sort((a, b) => a.start - b.start);
    let timeline;
    if (spans.length > 0 || this.dropped > 0) {
      timeline = fitBudget({
        version: 1,
        spans,
        statements: this.statements.map((statement) => statement.toJSON(threshold)),
        dropped: this.dropped,
        slowQueryMs: this.settings.slowQueryMs,
        nPlusOneThreshold: threshold
      });
    }
    this._result = { stats, timeline };
    return this._result;
  }

  // Milliseconds since the request started, 2 decimals.
  _offset(at) {
    return round(at - this.origin);
  }

  _caller(fingerprint, find) {
    try {
      if (typeof find === 'function') return find();
      // A query an ORM call runs: the line that made the call, when the ORM captured it.
      const found = Operation.caller();
      if (found) return found;
      const hint = Caller.hinted(fingerprint);
      return hint ? hint.caller : this.settings.caller.capture();
    } catch (error) {
      return null;
    }
  }

  _overflow(fingerprint) {
    let entry = this.overflow.get(fingerprint);
    if (!entry) {
      entry = { count: 0, duplicates: 0, time: 0, maxTime: 0, slow: 0, seen: new Set() };
      this.overflow.set(fingerprint, entry);
    }
    return entry;
  }
}

/**
 * A span in progress. Ending it twice, or after the timeline closed, does nothing.
 */
export class SpanHandle {
  /**
   * @param {Timeline} timeline
   * @param {'query'|'http'|'measure'} type
   * @param {Object|null} span - The listed span, or null when a cap left it out
   * @param {number} startedAt - performance.now() at the start
   * @param {Object|null} statement - For queries: the statement it counts towards
   */
  constructor(timeline, type, span, startedAt, statement) {
    this.timeline = timeline;
    this.type = type;
    this.span = span;
    this.startedAt = startedAt;
    this.statement = statement;
    this.done = false;
  }

  /**
   * Ends the span.
   *
   * @param {Object} [result]
   * @param {number|null} [result.rows] - Queries: rows returned or affected
   * @param {number|null} [result.status] - HTTP: the response status
   * @param {*} [result.error] - What made it fail (an Error, or a message)
   * @returns {void}
   */
  end(result) {
    if (this.done) return;
    this.done = true;
    try {
      this._end(result || {});
    } catch (error) {
      // Called from the driver's own completion path: whatever happens here stays here.
    }
  }

  _end({ rows, status, error }) {
    const timeline = this.timeline;
    if (timeline.closed) return;
    const duration = performance.now() - this.startedAt;
    const span = this.span;
    const failure = error === undefined || error === null ? null : errorText(error);

    if (this.type === 'query') {
      const statement = this.statement;
      timeline.stats.queryTime += duration;
      statement.time += duration;
      statement.maxTime = Math.max(statement.maxTime, duration);
      if (duration >= timeline.settings.slowQueryMs) {
        statement.slow++;
        timeline.stats.slowQueries++;
      }
      if (span && Number.isInteger(rows) && rows >= 0) span.rows = rows;
    } else if (this.type === 'http') {
      timeline.stats.httpTime += duration;
      if (span && Number.isInteger(status)) span.status = status;
    }
    if (span) {
      span.duration = round(duration);
      if (failure) span.error = failure;
    }
  }

  /**
   * Takes the span back: the operation never ran (its call threw synchronously).
   *
   * @returns {void}
   */
  cancel() {
    if (this.done) return;
    this.done = true;
    const timeline = this.timeline;
    if (timeline.closed) return;
    if (this.type === 'query') {
      timeline.stats.queries--;
      this.statement.count--;
    } else if (this.type === 'http') {
      timeline.stats.http--;
    }
    if (this.span) this.span.cancelled = true;
  }
}

/**
 * One distinct statement of a request.
 */
class Statement {
  /**
   * @param {Object} fields - index, system, client, text, fingerprint, caller
   */
  constructor({ index, system, client, text, fingerprint, caller }) {
    this.index = index;
    this.system = system;
    this.client = client;
    this.text = text;
    this.fingerprint = fingerprint;
    this.caller = caller || null;
    this.count = 0;
    this.time = 0;
    this.maxTime = 0;
    this.slow = 0;
    this.duplicates = 0;
    this.paramsKept = 0;
    this.seen = new Set();
  }

  /**
   * @param {number} threshold - nPlusOneThreshold
   * @returns {Object} The statement as the contract lists it
   */
  toJSON(threshold) {
    return {
      system: this.system,
      client: this.client,
      text: this.text,
      fingerprint: this.fingerprint,
      count: this.count,
      time: round(this.time),
      maxTime: round(this.maxTime),
      slow: this.slow,
      nPlusOne: this.count >= threshold,
      duplicates: this.duplicates,
      caller: this.caller
    };
  }
}

// Shapes are value-free already: the fingerprint is the hash of the text itself.
function shapeAnalysis(text) {
  const shape = String(text);
  let fingerprint = shapeFingerprints.get(shape);
  if (!fingerprint) {
    fingerprint = createHash('sha256').update(shape).digest('hex').slice(0, 16);
    shapeFingerprints.set(shape, fingerprint);
  }
  return { fingerprint, maskedText: shape, sensitive: new Set() };
}

// A query span's parameters, masked; undefined when they can't be read (the span goes without).
function maskParams(params, sensitive) {
  try {
    if (Array.isArray(params)) return Masker.sqlParams(params, sensitive, MAX_PARAMS);
    return typeof params === 'object' ? Masker.fields(params, MAX_PARAMS) : null;
  } catch (error) {
    return undefined;
  }
}

// Keeps the serialized timeline within the budget: first the parameters of the newest query spans
// go, then the newest spans themselves (counted in `dropped`), and as a last resort the statements'
// texts are shortened.
function fitBudget(timeline) {
  let size = Buffer.byteLength(JSON.stringify(timeline));
  if (size <= BUDGET_BYTES) return timeline;

  const spans = timeline.spans.map((span) => ({ ...span }));
  const lengths = spans.map((span) => Buffer.byteLength(JSON.stringify(span)) + 1);
  for (let i = spans.length - 1; i >= 0 && size > BUDGET_BYTES; i--) {
    if (spans[i].type !== 'query' || spans[i].params === undefined) continue;
    delete spans[i].params;
    const length = Buffer.byteLength(JSON.stringify(spans[i])) + 1;
    size -= lengths[i] - length;
    lengths[i] = length;
  }
  let dropped = timeline.dropped;
  while (size > BUDGET_BYTES && spans.length > 0) {
    size -= lengths.pop();
    spans.pop();
    dropped++;
  }
  let result = { ...timeline, spans, dropped };
  for (const max of [1024, 256, 64]) {
    if (Buffer.byteLength(JSON.stringify(result)) <= BUDGET_BYTES) break;
    result = { ...result, statements: result.statements.map((statement) => ({ ...statement, text: cut(statement.text, max) })) };
  }
  return result;
}

// "<code>: <message>" or "<message>", at most 500 characters.
function errorText(error) {
  if (typeof error === 'string') return cut(error, MAX_ERROR);
  let message;
  let code;
  try {
    message = typeof error.message === 'string' ? error.message : String(error);
    code = error.code;
  } catch (failure) {
    message = 'Error';
  }
  // Some libraries (Prisma) format messages over several lines with blank lines between.
  const tidy = String(message).trim().replace(/\n\s*\n+/g, '\n');
  const text = (typeof code === 'string' || typeof code === 'number') && code !== '' ? `${code}: ${tidy}` : tidy;
  return cut(text, MAX_ERROR);
}

function cut(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
