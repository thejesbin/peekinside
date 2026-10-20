/**
 * Turns whatever was thrown into an ExceptionRecord: an Error, an error from another realm, or any
 * other value (`throw 'oops'`, `Promise.reject({ code: 1 })`).
 *
 * Thrown values come from the app and its dependencies, so nothing about them is trusted: a getter
 * on an error can throw, a proxy can throw on every access, a message can be megabytes long.
 * Every read is guarded and every field is bounded (see limits.js); building a record never
 * throws for a strange value.
 */

import { randomUUID } from 'crypto';
import os from 'os';
import { types } from 'util';
import { setOwn } from '../capture/http-message.js';
import { ExceptionRecord } from './exception-record.js';
import { Fingerprint } from './fingerprint.js';
import { FrameClassifier } from './frame-classifier.js';
import { LIMITS, truncate, truncateBytes, truncateStack } from './limits.js';
import { SafeJson } from './safe-json.js';
import { SourceContext } from './source-context.js';
import { SourceMaps } from './source-maps.js';
import { StackParser } from './stack-parser.js';

// The name of thrown values that aren't errors.
export const THROWN_VALUE = 'ThrownValue';

/**
 * @typedef {Object} BuildOptions
 * @property {'express'|'koa'|'fastify'|'http'|'uncaught'|'unhandledRejection'|'report'|'job'} mechanism
 * @property {boolean} handled
 * @property {boolean} fatal
 * @property {string} environment - Normalized environment label
 * @property {string|null} [release] - The running release
 * @property {string|null} [requestId]
 * @property {Object|null} [request] - Request snapshot (see RequestSnapshot)
 * @property {{ method: string, path: string }|null} [requestLine] - For the exception list
 * @property {import('../user.js').User|null} [user] - Who it happened to
 * @property {string|null} [jobRunId] - The job run it happened in
 * @property {{ name: string }|null} [job] - The job, for the exception list
 * @property {Object<string, string>} [tags]
 * @property {*} [extra]
 */

/**
 * Builds exception records for one project.
 */
export class ExceptionBuilder {
  /**
   * @param {Object} options
   * @param {string} options.root - The project folder: frames inside it are in-app
   * @param {boolean} [options.sourceContext=true] - Read source lines around in-app frames
   * @param {boolean} [options.sourceMaps=true] - Map frames of compiled code to their sources
   */
  constructor({ root, sourceContext = true, sourceMaps = true }) {
    this.classifier = new FrameClassifier(root);
    this.sources = sourceContext ? new SourceContext(root) : null;
    this.sourceMaps = sourceMaps ? new SourceMaps(this.classifier) : null;
  }

  /**
   * @param {*} value - What was thrown (or rejected, or reported)
   * @param {BuildOptions} options
   * @returns {ExceptionRecord}
   */
  build(value, { mechanism, handled, fatal, environment, release = null, requestId = null, request = null, requestLine = null, user = null, jobRunId = null, job = null, tags, extra }) {
    const thrown = ExceptionBuilder.describe(value);
    const frames = this.frames(thrown, LIMITS.frames);
    if (this.sources) this.sources.addTo(frames, LIMITS.contextFrames, this.sourceMaps && ((frame) => this.sourceMaps.linesOf(frame)));

    const summary = {
      name: thrown.name,
      message: thrown.message,
      code: thrown.code,
      fingerprint: Fingerprint.of({ name: thrown.name, code: thrown.code, message: thrown.message, frames }),
      mechanism,
      location: locate(frames),
      request: requestLine,
      ...(job ? { job } : {}),
      ...(user ? { user } : {})
    };
    const detail = {
      stack: truncateStack(thrown.stack, LIMITS.stack),
      frames,
      causes: this.causes(value),
      request,
      process: processInfo(),
      tags: cleanTags(tags),
      extra: cleanExtra(extra)
    };

    return new ExceptionRecord({
      id: randomUUID(),
      occurredAt: Date.now(),
      environment,
      release,
      handled: Boolean(handled),
      fatal: Boolean(fatal),
      requestId: requestId || null,
      jobRunId: jobRunId || null,
      summary,
      detail
    });
  }

  /**
   * Frames of a described value, top frame first, mapped to their sources, without source lines.
   *
   * @param {{ stack: string, fullMessage: string, isError: boolean }} thrown - From describe()
   * @param {number} limit
   * @returns {import('./frame-classifier.js').Frame[]}
   */
  frames(thrown, limit) {
    if (!thrown.isError) return [];
    const frames = StackParser.parse(thrown.stack, { message: thrown.fullMessage, limit }).map((frame) => this.classifier.classify(frame));
    return this.sourceMaps ? this.sourceMaps.apply(frames) : frames;
  }

  /**
   * The error.cause chain, then the errors of an AggregateError.
   *
   * @param {*} value
   * @returns {Object[]}
   */
  causes(value) {
    const causes = [];
    const seen = new Set([value]);

    let current = value;
    for (let depth = 0; depth < LIMITS.causeDepth && isObject(current); depth++) {
      const cause = safeGet(current, 'cause');
      if (cause === undefined || cause === null || seen.has(cause)) break;
      seen.add(cause);
      causes.push(this.cause(cause, 'cause'));
      current = cause;
    }

    const errors = isObject(value) ? safeGet(value, 'errors') : undefined;
    if (Array.isArray(errors)) {
      for (const error of errors.slice(0, LIMITS.aggregateErrors)) {
        causes.push(this.cause(error, 'aggregate'));
      }
    }
    return causes;
  }

  /**
   * One entry of `causes`: like the exception itself, with a shorter stack and no source lines.
   *
   * @param {*} value
   * @param {'cause'|'aggregate'} relation
   * @returns {Object}
   */
  cause(value, relation) {
    const thrown = ExceptionBuilder.describe(value);
    return {
      relation,
      name: thrown.name,
      message: thrown.message,
      code: thrown.code,
      stack: truncateStack(thrown.stack, LIMITS.causeStack),
      frames: this.frames(thrown, LIMITS.causeFrames)
    };
  }

  /**
   * The name, message, code and stack of a thrown value, bounded.
   *
   * Errors are recognized across realms (vm contexts, worker messages) and by shape, since
   * libraries sometimes throw error-like objects that don't inherit from Error.
   *
   * @param {*} value
   * @returns {{ name: string, message: string, fullMessage: string, code: string|null, stack: string,
   *   isError: boolean }} `fullMessage` is the message before it was cut, to find where the
   *   stack's frames start
   */
  static describe(value) {
    if (isErrorLike(value)) {
      const name = truncate(errorName(value), LIMITS.name);
      const rawMessage = safeGet(value, 'message');
      const fullMessage = typeof rawMessage === 'string' ? rawMessage : safeString(rawMessage);
      const message = truncate(fullMessage, LIMITS.message);
      const rawStack = safeGet(value, 'stack');
      const stack = typeof rawStack === 'string' && rawStack !== '' ? rawStack : (message ? `${name}: ${message}` : name);
      return { name, message, fullMessage, code: errorCode(safeGet(value, 'code')), stack, isError: true };
    }

    const message = preview(value);
    let stack;
    try {
      stack = String(value);
    } catch (error) {
      stack = message;
    }
    return { name: THROWN_VALUE, message, fullMessage: message, code: null, stack: truncateBytes(stack, LIMITS.stack), isError: false };
  }
}

/**
 * The process an exception happened in.
 *
 * @returns {Object} pid, node, platform, arch, hostname, uptime (seconds), memory (bytes)
 */
export function processInfo() {
  let memory = { rss: 0, heapUsed: 0, heapTotal: 0 };
  try {
    const usage = process.memoryUsage();
    memory = { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal };
  } catch (error) {
    // Some sandboxes refuse memory statistics; the rest still helps.
  }
  let hostname = '';
  try {
    hostname = os.hostname();
  } catch (error) {
    hostname = '';
  }
  return {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname,
    uptime: Math.round(process.uptime() * 10) / 10,
    memory
  };
}

// Top in-app frame, else the top frame that has a file; null without frames.
function locate(frames) {
  const frame = frames.find((item) => item.inApp) || frames.find((item) => item.file);
  if (!frame) return null;
  return { file: frame.relativeFile || frame.file, line: frame.line, column: frame.column, function: frame.function };
}

function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isErrorLike(value) {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (types.isNativeError(value) || value instanceof Error) return true;
    return typeof value.message === 'string' && typeof value.stack === 'string';
  } catch (error) {
    return false;
  }
}

// error.name, unless it is the generic "Error" inherited by a subclass that didn't set its own
// name (class ValidationError extends Error {}): the class name says more.
function errorName(error) {
  const name = safeGet(error, 'name');
  const constructorName = safeConstructorName(error);
  if (typeof name === 'string' && name !== '' && !(name === 'Error' && constructorName && constructorName !== 'Error' && constructorName !== 'Object')) {
    return name;
  }
  return constructorName && constructorName !== 'Object' ? constructorName : (typeof name === 'string' && name) || 'Error';
}

function safeConstructorName(value) {
  try {
    const name = value.constructor && value.constructor.name;
    return typeof name === 'string' ? name : '';
  } catch (error) {
    return '';
  }
}

function errorCode(code) {
  if (typeof code === 'string' && code !== '') return truncate(code, LIMITS.code);
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return null;
}

// A short, readable form of a thrown value that isn't an error.
function preview(value) {
  if (typeof value === 'string') return truncate(value, LIMITS.valuePreview);
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (value === null || typeof value !== 'object') return truncate(safeString(value), LIMITS.valuePreview);
  const { json } = SafeJson.stringify(value, LIMITS.valuePreview);
  return truncate(json === undefined ? safeString(value) : json, LIMITS.valuePreview);
}

function safeString(value) {
  try {
    return String(value);
  } catch (error) {
    try {
      return Object.prototype.toString.call(value);
    } catch (nested) {
      return '[unprintable value]';
    }
  }
}

function safeGet(target, key) {
  try {
    return target[key];
  } catch (error) {
    return undefined;
  }
}

// String tags only: at most 32, with bounded keys and values. Numbers and booleans are kept as
// text; objects are dropped (they belong in `extra`).
function cleanTags(tags) {
  const clean = {};
  if (!tags || typeof tags !== 'object') return clean;
  let keys;
  try {
    keys = Object.keys(tags);
  } catch (error) {
    return clean;
  }
  let count = 0;
  for (const key of keys) {
    if (count >= LIMITS.tags) break;
    const value = safeGet(tags, key);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'bigint') continue;
    setOwn(clean, truncate(key, LIMITS.tagKey), truncate(String(value), LIMITS.tagValue));
    count++;
  }
  return clean;
}

// JSON-safe `extra`; past 16 KB, only a preview of its JSON.
function cleanExtra(extra) {
  if (extra === undefined) return null;
  const { json, truncated } = SafeJson.stringify(extra, LIMITS.extra + 1);
  if (json === undefined) return null;
  if (truncated || Buffer.byteLength(json) > LIMITS.extra) {
    return { truncated: true, preview: truncateBytes(json, LIMITS.extraPreview) };
  }
  try {
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}
