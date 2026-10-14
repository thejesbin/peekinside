/**
 * Validation of the batches apps post to the hub's /api/ingest, and of the spool files crashing
 * apps leave for it.
 *
 * A batch comes from another process, so nothing in it is trusted: the project id becomes a
 * folder name, strings are capped, numbers are checked. A malformed batch is refused as a whole,
 * while a malformed record or count is only skipped, so one bad request never loses the rest.
 */

import { PROJECT_ID } from './store.js';

// Requests per batch; the SDK sends at most 200.
export const MAX_BATCH = 1000;
// Exceptions per batch.
export const MAX_EXCEPTIONS_BATCH = 500;
// Job runs and log lines per batch.
export const MAX_JOBS_BATCH = 1000;
export const MAX_LOGS_BATCH = 2000;
// Request ids are UUIDs in practice. They appear in URLs and index files, so only safe
// characters are accepted.
export const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD = /^[A-Z]{1,16}$/;
const MAX_BLOCKED_ENTRIES = 20;
const FINGERPRINT = /^[0-9a-f]{16}$/;
// Timeline counters a request may carry, in the contract's order: counts are integers, times are
// milliseconds.
const STAT_KEYS = ['queries', 'queryTime', 'slowQueries', 'nPlusOne', 'duplicates', 'http', 'httpTime', 'logs', 'loopBlock'];
const STAT_TIMES = new Set(['queryTime', 'httpTime', 'loopBlock']);
const MAX_STAT = 1e9;
const MECHANISMS = new Set(['express', 'koa', 'fastify', 'http', 'uncaught', 'unhandledRejection', 'report', 'job']);
const JOB_STATUSES = new Set(['ok', 'failed']);
const JOB_TRIGGERS = new Set(['cron', 'queue', 'manual']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_SOURCES = new Set(['console', 'pino', 'winston']);
// What the index keeps of a log line; the line in full is its detail.
const LOG_PREVIEW = 500;
// What release.js produces.
const RELEASE = /^[A-Za-z0-9._:@/+-]{1,64}$/;
// Process samples per batch (the SDK sends one every 10 seconds, more after the hub was down).
const MAX_SAMPLES = 120;
const SAMPLE_BYTES = ['rss', 'heapUsed', 'heapTotal', 'external'];
const SAMPLE_DELAYS = ['loopP50', 'loopP99', 'loopMax'];

/**
 * A validated ingest batch: `{ project, instance, requests, exceptions, samples, blocked }`.
 */
export class IngestPayload {
  /**
   * Validates a parsed request body.
   *
   * @param {*} body - Parsed JSON
   * @returns {IngestPayload|null} null when the project, the process details or the request list
   *   is missing or malformed, or the batch is too large. `exceptions` is optional.
   */
  static parse(body) {
    const project = readProject(body && body.project);
    const instance = readInstance(body && body.instance);
    const requests = body && Array.isArray(body.requests) ? body.requests : null;
    const exceptions = body && body.exceptions != null ? body.exceptions : [];
    if (!project || !instance || !requests || requests.length > MAX_BATCH) {
      return null;
    }
    if (!Array.isArray(exceptions) || exceptions.length > MAX_EXCEPTIONS_BATCH) {
      return null;
    }
    const jobs = body.jobs != null ? body.jobs : [];
    const logs = body.logs != null ? body.logs : [];
    if (!Array.isArray(jobs) || jobs.length > MAX_JOBS_BATCH || !Array.isArray(logs) || logs.length > MAX_LOGS_BATCH) {
      return null;
    }
    return new IngestPayload({ project, instance, requests, exceptions, jobs, logs, samples: body.samples, blocked: body.blocked, hasExceptions: Array.isArray(body.exceptions) });
  }

  /**
   * Use IngestPayload.parse().
   *
   * @param {Object} parts
   * @param {{ id: string, name: string, root: string }} parts.project - Validated project
   * @param {Object} parts.instance - Validated process details
   * @param {Array} parts.requests - Records as sent
   * @param {Array} [parts.exceptions] - Exception records as sent
   * @param {Array} [parts.jobs] - Job runs as sent
   * @param {Array} [parts.logs] - Log lines as sent
   * @param {*} [parts.samples] - Process samples (memory, CPU, event-loop delay), as sent
   * @param {*} parts.blocked - Counts of unrecorded server requests, as sent
   * @param {boolean} [parts.hasExceptions=false] - Whether the batch had an exception list (SDKs
   *   from before exceptions don't send one)
   */
  constructor({ project, instance, requests, exceptions = [], jobs = [], logs = [], samples, blocked, hasExceptions = false }) {
    this.project = project;
    this.instance = instance;
    /**
     * The valid records, flattened into what the store keeps
     * @type {Object[]}
     */
    this.records = requests.map(readRecord).filter(Boolean);
    /**
     * Number of malformed records left out
     * @type {number}
     */
    this.rejected = requests.length - this.records.length;
    /**
     * The valid exceptions, flattened into what the store keeps
     * @type {Object[]}
     */
    this.exceptions = exceptions.map(readException).filter(Boolean);
    /**
     * Number of malformed exceptions left out
     * @type {number}
     */
    this.rejectedExceptions = exceptions.length - this.exceptions.length;
    /**
     * Whether the batch had an exception list
     * @type {boolean}
     */
    this.hasExceptions = hasExceptions;
    /**
     * The valid process samples, oldest first
     * @type {Object[]}
     */
    this.samples = readSamples(samples);
    /**
     * The valid job runs and log lines, flattened into what the store keeps
     * @type {Object[]}
     */
    this.jobs = jobs.map(readJob).filter(Boolean);
    this.logs = logs.map(readLog).filter(Boolean);
    this.rejectedJobs = jobs.length - this.jobs.length;
    this.rejectedLogs = logs.length - this.logs.length;
    /**
     * The valid counts of server requests the SDK didn't record
     * @type {{ kind: 'host'|'client', value: string, count: number }[]}
     */
    this.blocked = readBlocked(blocked);
  }
}

function readProject(value) {
  if (!value || typeof value !== 'object') return null;
  const { id, name, root } = value;
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) return null;
  if (typeof name !== 'string' || !name.trim() || name.length > 120) return null;
  if (typeof root !== 'string' || root.length > 4096) return null;
  return { id, name: name.trim(), root };
}

function readInstance(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  return {
    pid: value.pid,
    port: Number.isInteger(value.port) && value.port > 0 && value.port < 65536 ? value.port : null,
    framework: text(value.framework, 24),
    node: text(value.node, 24),
    sdk: text(value.sdk, 24),
    environment: text(value.environment, 32),
    release: release(value.release),
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : Date.now()
  };
}

// Flattens one SDK record into what the store keeps; null when it is malformed.
function readRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !REQUEST_ID.test(value.id)) return null;
  if (!Number.isFinite(value.occurredAt) || typeof value.method !== 'string' || !METHOD.test(value.method)) return null;
  const status = value.status;
  if (status !== null && !(Number.isInteger(status) && status >= 100 && status <= 599)) return null;
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
  const detail = value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail) ? value.detail : {};

  return {
    id: value.id,
    occurredAt: value.occurredAt,
    environment: text(value.environment, 32) || 'development',
    release: release(value.release),
    method: value.method,
    status,
    duration: Number.isFinite(value.duration) && value.duration >= 0 ? value.duration : null,
    requestSize: byteCount(value.requestSize),
    responseSize: byteCount(value.responseSize),
    aborted: value.aborted === true,
    exceptionCount: byteCount(value.exceptionCount),
    stats: readStats(value.stats),
    url: text(summary.url, 16384),
    path: text(summary.path, 16384),
    contentType: text(summary.contentType, 256),
    user: readUser(summary.user),
    detail
  };
}

// The timeline counters, keeping only the known keys and dropping values that aren't valid
// rather than the record: a newer SDK may send more, an older one sends none (null).
function readStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stats = {};
  for (const key of STAT_KEYS) {
    const number = value[key];
    const valid = STAT_TIMES.has(key) ? Number.isFinite(number) : Number.isInteger(number);
    if (valid && number >= 0 && number <= MAX_STAT) stats[key] = number;
  }
  return stats;
}

// Flattens one SDK exception into what the store keeps: its summary's fields next to the record's;
// null when it is malformed. The fingerprint and mechanism must be valid, since the dashboard
// groups and labels by them.
function readException(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !REQUEST_ID.test(value.id) || !Number.isFinite(value.occurredAt)) return null;
  if (value.requestId !== null && value.requestId !== undefined && (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId))) return null;
  if (!optionalId(value.jobRunId)) return null;
  const summary = value.summary;
  if (!summary || typeof summary !== 'object') return null;
  if (typeof summary.fingerprint !== 'string' || !FINGERPRINT.test(summary.fingerprint) || !MECHANISMS.has(summary.mechanism)) return null;
  const detail = value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail) ? value.detail : {};

  return {
    id: value.id,
    occurredAt: value.occurredAt,
    environment: text(value.environment, 32) || 'development',
    release: release(value.release),
    handled: value.handled === true,
    fatal: value.fatal === true,
    requestId: value.requestId || null,
    jobRunId: value.jobRunId || null,
    name: text(summary.name, 200) || 'Error',
    message: text(summary.message, 2000),
    code: typeof summary.code === 'string' ? summary.code.slice(0, 64) : null,
    fingerprint: summary.fingerprint,
    mechanism: summary.mechanism,
    location: readLocation(summary.location),
    request: readRequestLine(summary.request),
    job: summary.job && typeof summary.job === 'object' && typeof summary.job.name === 'string' ? { name: summary.job.name.slice(0, 128) } : null,
    user: readUser(summary.user),
    detail
  };
}

// A job run: its readable fields next to its summary's (the error it failed with, the user).
function readJob(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !REQUEST_ID.test(value.id) || !Number.isFinite(value.occurredAt)) return null;
  if (typeof value.name !== 'string' || !value.name.trim() || !JOB_STATUSES.has(value.status)) return null;
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
  const detail = value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail) ? value.detail : {};
  const error = summary.error && typeof summary.error === 'object' ? { name: text(summary.error.name, 200) || 'Error', message: text(summary.error.message, 1000) } : null;
  return {
    id: value.id,
    occurredAt: value.occurredAt,
    environment: text(value.environment, 32) || 'development',
    release: release(value.release),
    name: value.name.trim().slice(0, 128),
    queue: typeof value.queue === 'string' ? value.queue.slice(0, 128) : null,
    schedule: typeof value.schedule === 'string' ? value.schedule.slice(0, 128) : null,
    timezone: typeof value.timezone === 'string' ? value.timezone.slice(0, 64) : null,
    trigger: JOB_TRIGGERS.has(value.trigger) ? value.trigger : 'manual',
    status: value.status,
    duration: Number.isFinite(value.duration) && value.duration >= 0 ? value.duration : null,
    attempt: Number.isInteger(value.attempt) && value.attempt > 0 ? Math.min(value.attempt, 1e6) : 1,
    exceptionCount: byteCount(value.exceptionCount),
    stats: readStats(value.stats),
    error,
    user: readUser(summary.user),
    detail
  };
}

// A log line: its fields, the start of the line for the list, and the whole line as its detail.
function readLog(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !REQUEST_ID.test(value.id) || !Number.isFinite(value.occurredAt)) return null;
  if (!LOG_LEVELS.has(value.level) || !optionalId(value.requestId) || !optionalId(value.jobRunId)) return null;
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
  const message = text(summary.message, 4000);
  return {
    id: value.id,
    occurredAt: value.occurredAt,
    environment: text(value.environment, 32) || 'development',
    release: release(value.release),
    level: value.level,
    source: LOG_SOURCES.has(value.source) ? value.source : 'console',
    requestId: value.requestId || null,
    jobRunId: value.jobRunId || null,
    message: message.slice(0, LOG_PREVIEW),
    detail: { message, ...(summary.fields !== undefined ? { fields: summary.fields } : {}) }
  };
}

function optionalId(value) {
  return value === null || value === undefined || (typeof value === 'string' && REQUEST_ID.test(value));
}

// Numbers only: a malformed sample is skipped, a missing delay (no ticks yet) is null.
function readSamples(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_SAMPLES).flatMap((sample) => {
    if (!sample || typeof sample !== 'object' || !Number.isFinite(sample.at)) return [];
    const clean = { at: sample.at };
    for (const key of SAMPLE_BYTES) {
      const number = sample[key];
      if (!Number.isFinite(number) || number < 0 || number > 1e13) return [];
      clean[key] = Math.round(number);
    }
    clean.cpu = Number.isFinite(sample.cpu) && sample.cpu >= 0 && sample.cpu <= 10_000 ? sample.cpu : null;
    for (const key of SAMPLE_DELAYS) {
      const number = sample[key];
      clean[key] = Number.isFinite(number) && number >= 0 && number <= 1e7 ? number : null;
    }
    return [clean];
  });
}

function readLocation(value) {
  if (!value || typeof value !== 'object' || typeof value.file !== 'string') return null;
  return {
    file: value.file.slice(0, 4096),
    line: positiveInt(value.line),
    column: positiveInt(value.column),
    function: typeof value.function === 'string' ? value.function.slice(0, 1024) : null
  };
}

// Who a request or exception was for: short strings only, null when it names nobody.
function readUser(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const user = { id: text(value.id, 128) || null, email: text(value.email, 254) || null, name: text(value.name, 128) || null };
  return user.id || user.email || user.name ? user : null;
}

function readRequestLine(value) {
  if (!value || typeof value !== 'object' || typeof value.method !== 'string' || typeof value.path !== 'string') return null;
  return { method: value.method.slice(0, 16), path: value.path.slice(0, 16384) };
}

function positiveInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Counts of requests the SDK didn't record because they reached a server. Malformed entries are
// ignored rather than failing the batch.
function readBlocked(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BLOCKED_ENTRIES).flatMap((entry) => {
    if (!entry || (entry.kind !== 'host' && entry.kind !== 'client')) return [];
    if (!Number.isInteger(entry.count) || entry.count < 1 || typeof entry.value !== 'string' || !entry.value) return [];
    return [{ kind: entry.kind, value: entry.value.slice(0, 255), count: Math.min(entry.count, 1e9) }];
  });
}

// A release label, or null when absent or malformed (it never fails the record).
function release(value) {
  return typeof value === 'string' && RELEASE.test(value) ? value : null;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function byteCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
