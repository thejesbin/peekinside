/**
 * The dumps of one PeekInside instance (PeekInside.dump()): each value is read into a tree (see
 * DumpValue), with the line of the app that dumped it and the request or job run running then,
 * and goes to the local dashboard. A dump during a request is listed on the request's record and
 * placed on its timeline.
 *
 * Dumps are rate limited per process (50 a second, bursts of 200), like log lines. Nothing here
 * throws into the app: dump() always hands the value back.
 */

import { randomUUID } from 'crypto';
import { truncate } from '../exceptions/limits.js';
import { TokenBucket } from '../exceptions/rate-limiter.js';
import { RequestContext } from '../exceptions/request-context.js';
import { DumpRecord } from './dump-record.js';
import { DumpValue } from './dump-value.js';

const MAX_LABEL = 120;

/**
 * Records dumps for one PeekInside instance.
 */
export class DumpCapture {
  /**
   * @param {Object} options
   * @param {import('../exceptions/exception-capture.js').ExceptionCapture} options.capture - The
   *   instance's exceptions, whose stack frames (mapped to source files) locate a dump
   * @param {() => Object|null} options.sink - The instance's transport
   * @param {() => boolean} options.isEnabled - Whether the instance records right now
   * @param {TokenBucket} [options.limiter]
   */
  constructor({ capture, sink, isEnabled, limiter = new TokenBucket({ rate: 50, burst: 200 }) }) {
    this.capture = capture;
    this._sink = sink;
    this._isEnabled = isEnabled;
    this.limiter = limiter;
  }

  /**
   * @type {boolean}
   */
  get recording() {
    const sink = this._sink();
    return Boolean(sink && !sink.disabled && this._isEnabled());
  }

  /**
   * Records a dump. Never throws.
   *
   * @param {*} value
   * @param {*} label - A string names the dump; anything else is ignored
   * @param {Function} entry - The function the app called (PeekInside.dump): the stack is read
   *   from its caller
   * @returns {string|null} The dump's id, or null when nothing was recorded
   */
  record(value, label, entry) {
    try {
      if (!this.recording) return null;
      const context = RequestContext.current();
      // Requests local mode doesn't record (server traffic) take their dumps with them.
      if (context && context.blocked) return null;
      if (!this.limiter.take()) return null;
      const own = context && context.capture === this.capture ? context : null;
      const { tree, type, preview, truncated } = DumpValue.capture(value);
      const sink = this._sink();
      const record = new DumpRecord({
        id: randomUUID(),
        occurredAt: Date.now(),
        environment: sink.environment,
        release: sink.release || null,
        requestId: own ? own.requestId : null,
        jobRunId: own ? own.jobRunId || null : null,
        label: typeof label === 'string' && label.trim() ? truncate(label.trim(), MAX_LABEL) : null,
        location: this._callSite(entry),
        summary: { type, preview, truncated },
        detail: { value: tree }
      });
      if (own) own.noteDump(record);
      sink.enqueueRecord(record);
      return record.id;
    } catch (error) {
      return null;
    }
  }

  // The app's line that called `entry`, mapped through source maps like an exception's frames.
  _callSite(entry) {
    const holder = {};
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 1;
      Error.captureStackTrace(holder, entry);
    } finally {
      Error.stackTraceLimit = limit;
    }
    const [frame] = this.capture.builder.frames({ stack: String(holder.stack || ''), fullMessage: '', isError: true }, 1);
    if (!frame || !frame.file) return null;
    return { file: frame.file, relativeFile: frame.relativeFile, line: frame.line, column: frame.column, function: frame.function };
  }
}
