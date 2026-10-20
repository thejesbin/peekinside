/**
 * Log lines for the Logs page: what the app writes with the console, pino, winston or NestJS's
 * Logger, inside a request, inside a job run, or anywhere else (startup, timers), each linked to
 * its request or job run when there is one.
 *
 * Lines are rate limited per process (100 a second, bursts of 500) and below the `logLevel` option
 * are left out, so an app that logs heavily costs a bounded amount. PeekInside's own lines are
 * never recorded.
 */

import { randomUUID } from 'crypto';
import { ExceptionCapture } from '../exceptions/exception-capture.js';
import { truncate } from '../exceptions/limits.js';
import { TokenBucket } from '../exceptions/rate-limiter.js';
import { RequestContext } from '../exceptions/request-context.js';
import { SafeJson } from '../exceptions/safe-json.js';
import { LOG_LEVELS, LogRecord } from './log-record.js';

const MAX_MESSAGE = 4000;
const MAX_FIELDS = 4096;
const RANK = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 });

/**
 * One PeekInside instance's log capture.
 */
export class LogCapture {
  /**
   * @param {Object} options
   * @param {'debug'|'info'|'warn'|'error'} [options.level='info'] - The lowest level recorded
   * @param {() => Object|null} options.sink - The instance's transport
   * @param {() => boolean} options.isEnabled - Whether the instance records right now
   * @param {TokenBucket} [options.limiter]
   */
  constructor({ level = 'info', sink, isEnabled, limiter = new TokenBucket({ rate: 100, burst: 500 }) }) {
    this.minRank = RANK[LogCapture.level(level)];
    this._sink = sink;
    this._isEnabled = isEnabled;
    this.limiter = limiter;
  }

  /**
   * A valid level name, or "info".
   *
   * @param {*} value
   * @returns {'debug'|'info'|'warn'|'error'}
   */
  static level(value) {
    return LOG_LEVELS.includes(value) ? value : 'info';
  }

  /**
   * Whether a line at this level would be recorded by anyone right now: lets the console skip
   * formatting lines nobody records.
   *
   * @param {string} level
   * @returns {boolean}
   */
  static wants(level) {
    const capture = LogCapture.current();
    return Boolean(capture && capture.recording && RANK[level] >= capture.minRank);
  }

  /**
   * Records a line with the capture of the request or job running now, else the most recently
   * created instance that records. Never throws.
   *
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} message - As written (formatted)
   * @param {Object} [options]
   * @param {'console'|'pino'|'winston'|'nest'} [options.source='console']
   * @param {*} [options.fields] - Structured data written with the line (pino, winston, nest)
   * @returns {string|null} The record's id, or null when nothing was recorded
   */
  static record(level, message, { source = 'console', fields } = {}) {
    try {
      const capture = LogCapture.current();
      return capture ? capture.record(level, message, { source, fields, context: RequestContext.current() }) : null;
    } catch (error) {
      return null;
    }
  }

  // The capture of the instance tracking the code running now, else the newest recording one.
  static current() {
    const context = RequestContext.current();
    const owner = context && context.capture ? context.capture.owner : null;
    if (owner && owner._logs) return owner._logs;
    const latest = ExceptionCapture.latest();
    return latest && latest.owner ? latest.owner._logs || null : null;
  }

  /**
   * @type {boolean}
   */
  get recording() {
    const sink = this._sink();
    return Boolean(sink && !sink.disabled && this._isEnabled());
  }

  /**
   * @param {string} level
   * @param {string} message
   * @param {Object} options
   * @param {string} options.source
   * @param {*} [options.fields]
   * @param {import('../exceptions/request-context.js').RequestContext|null} options.context
   * @returns {string|null}
   */
  record(level, message, { source, fields, context }) {
    if (!this.recording || !(RANK[level] >= this.minRank)) return null;
    // Requests local mode doesn't record (server traffic) take their lines with them.
    if (context && context.blocked) return null;
    if (!this.limiter.take()) return null;
    const sink = this._sink();
    const record = new LogRecord({
      id: randomUUID(),
      occurredAt: Date.now(),
      environment: sink.environment,
      release: sink.release || null,
      level,
      source,
      requestId: (context && context.requestId) || null,
      jobRunId: (context && context.jobRunId) || null,
      summary: { message: truncate(String(message), MAX_MESSAGE), ...structured(fields) }
    });
    sink.enqueueRecord(record);
    return record.id;
  }
}

// Structured data as JSON-safe values within MAX_FIELDS; a preview when larger.
function structured(fields) {
  if (fields === undefined || fields === null) return {};
  if (typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length === 0) return {};
  const { json, truncated } = SafeJson.stringify(fields, MAX_FIELDS);
  if (json === undefined) return {};
  if (truncated) return { fields: { truncated: true, preview: json } };
  try {
    return { fields: JSON.parse(json) };
  } catch (error) {
    return {};
  }
}
