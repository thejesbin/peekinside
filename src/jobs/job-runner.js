/**
 * Runs a background job as a recorded job run: its own context (so its queries, calls, log lines
 * and exceptions link to it), a timeline, and a record of how it went (see JobRunRecord). The
 * job's function runs exactly as it would without PeekInside: same arguments, same result, same
 * error thrown.
 */

import { performance } from 'perf_hooks';
import { ExceptionCapture } from '../exceptions/exception-capture.js';
import { truncate, truncateBytes } from '../exceptions/limits.js';
import { SafeJson } from '../exceptions/safe-json.js';
import { isNativePromise } from '../instrumentation/patch.js';
import { Timeline } from '../timeline/timeline.js';
import { JobContext } from './job-context.js';
import { JobRunRecord } from './job-run-record.js';

const MAX_NAME = 128;
const MAX_SCHEDULE = 128;
const MAX_DATA = 8 * 1024;
const MAX_ERROR_MESSAGE = 1000;

/**
 * @typedef {Object} JobOptions
 * @property {string} [schedule] - Its cron expression, when it runs on one (monitors it)
 * @property {string} [timezone] - The schedule's time zone
 * @property {string} [queue] - The queue it came from
 * @property {number} [attempt=1]
 * @property {*} [data] - The job's input, shown with the run (first 8 KB)
 * @property {'cron'|'queue'|'manual'} [trigger]
 */

/**
 * Runs jobs for one PeekInside instance.
 */
export class JobRunner {
  /**
   * Runs `fn` as a job run of the instance tracking the code running now, else the most recently
   * created instance that records. Without one, just runs `fn`.
   *
   * @param {string} name
   * @param {Function} fn
   * @param {JobOptions} [options]
   * @returns {*} What fn returns
   */
  static run(name, fn, options = {}) {
    const capture = ExceptionCapture.latest();
    const owner = capture ? capture.owner : null;
    const runner = owner && owner._jobs;
    return runner ? runner.run(name, fn, options) : fn();
  }

  /**
   * @param {Object} options
   * @param {import('../exceptions/exception-capture.js').ExceptionCapture} options.capture
   * @param {() => Object|null} options.sink - The instance's transport
   * @param {() => import('../timeline/timeline.js').TimelineSettings|null} options.timeline
   * @param {() => boolean} options.isEnabled
   */
  constructor({ capture, sink, timeline, isEnabled }) {
    this.capture = capture;
    this._sink = sink;
    this._timeline = timeline;
    this._isEnabled = isEnabled;
  }

  /**
   * @param {string} name
   * @param {Function} fn
   * @param {JobOptions} [options]
   * @returns {*} What fn returns (for an async fn, a promise of the same outcome)
   */
  run(name, fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('PeekInside.job() needs a function to run');
    const sink = this._sink();
    if (!sink || sink.disabled || !this._isEnabled()) return fn();

    const context = new JobContext({ capture: this.capture, name: jobName(name) });
    const settings = this._timeline();
    if (settings) context.timeline = new Timeline(settings);
    const run = { context, options: options || {}, occurredAt: Date.now(), started: performance.now() };

    let result;
    try {
      result = context.run(fn);
    } catch (error) {
      this._finish(run, error, true);
      throw error;
    }
    if (isNativePromise(result) || (result && typeof result.then === 'function')) {
      return Promise.resolve(result).then(
        (value) => {
          this._finish(run, null, false);
          return value;
        },
        (error) => {
          this._finish(run, error, true);
          throw error;
        }
      );
    }
    this._finish(run, null, false);
    return result;
  }

  // Records the run; never throws into the job.
  _finish({ context, options, occurredAt, started }, error, failed) {
    try {
      if (failed) this.capture.jobError(context, error);
      const sink = this._sink();
      if (!sink || sink.disabled) return;
      const closed = context.timeline ? context.timeline.close() : null;
      const schedule = typeof options.schedule === 'string' && options.schedule.trim() ? truncate(options.schedule.trim(), MAX_SCHEDULE) : null;
      const queue = typeof options.queue === 'string' && options.queue ? truncate(options.queue, MAX_NAME) : null;
      const record = new JobRunRecord({
        id: context.jobRunId,
        occurredAt,
        environment: sink.environment,
        release: sink.release || null,
        name: context.jobName,
        queue,
        schedule,
        timezone: typeof options.timezone === 'string' && options.timezone ? truncate(options.timezone, 64) : null,
        trigger: ['cron', 'queue', 'manual'].includes(options.trigger) ? options.trigger : schedule ? 'cron' : queue ? 'queue' : 'manual',
        status: failed ? 'failed' : 'ok',
        duration: Math.round((performance.now() - started) * 100) / 100,
        attempt: Number.isInteger(options.attempt) && options.attempt > 0 ? options.attempt : 1,
        exceptionCount: context.exceptionCount,
        stats: closed ? closed.stats : undefined,
        summary: { error: failed ? describe(error) : null, ...(context.user ? { user: context.user } : {}) },
        detail: {
          data: preview(options.data),
          exceptions: context.links.slice(),
          ...(closed && closed.timeline ? { timeline: closed.timeline } : {})
        }
      });
      context.release();
      sink.enqueueRecord(record);
    } catch (failure) {
      // The job's own outcome is unaffected.
    }
  }
}

function jobName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  return truncate(text || 'job', MAX_NAME);
}

function describe(error) {
  if (error instanceof Error || (error && typeof error === 'object' && typeof error.message === 'string')) {
    let name = 'Error';
    try {
      name = String(error.name || (error.constructor && error.constructor.name) || 'Error');
    } catch (failure) {
      name = 'Error';
    }
    return { name: truncate(name, 200), message: truncate(String(error.message), MAX_ERROR_MESSAGE) };
  }
  return { name: 'ThrownValue', message: truncate(String(error), MAX_ERROR_MESSAGE) };
}

// The job's input as JSON-safe data, or a preview of its JSON past 8 KB.
function preview(data) {
  if (data === undefined) return null;
  const { json, truncated } = SafeJson.stringify(data, MAX_DATA + 1);
  if (json === undefined) return null;
  if (truncated || Buffer.byteLength(json) > MAX_DATA) return { truncated: true, preview: truncateBytes(json, 2048) };
  try {
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}
