/**
 * One project's requests and exceptions on disk, in its folder under <data dir>/projects:
 *
 *   project.json             name, folder, timestamps
 *   00000001.jsonl           request details, one JSON object per line
 *   00000001.idx             one request summary per line, with the offset and length of its detail
 *   exceptions/00000001.*    exceptions, in the same format
 *   exception-state.json     fingerprints the dashboard marked resolved
 *   jobs/00000001.*          job runs, in the same format
 *   logs/00000001.*          log lines: the index keeps the start of each line, the details the rest
 *   dumps/00000001.*         dumps: the index keeps a preview of each value, the details its tree
 *   mails/00000001.*         emails: the index keeps who to and the subject, the details the message
 *
 * Process samples (memory, CPU, event-loop delay) are kept in memory only, for the Runtime page:
 * the last six hours of each of the project's recent processes.
 *
 * Both logs are SegmentLogs (see segment-log.js): summaries in memory, details read on demand,
 * retention by deleting whole segment files. The project keeps its newest `maxRequests` requests
 * and `maxExceptions` exceptions.
 */

import fs from 'fs';
import path from 'path';
import { ExceptionState } from './exception-state.js';
import { SegmentLog } from './segment-log.js';

// A project is online while one of its processes has checked in recently.
const ONLINE_MS = 25_000;
// Processes that stopped checking in are forgotten after this long.
const INSTANCE_TTL_MS = 60_000;
// How long the dashboard keeps saying that server requests were not recorded.
const BLOCKED_NOTICE_MS = 24 * 60 * 60 * 1000;
const MAX_BLOCKED_ENTRIES = 10;
// Samples kept per process (six hours at one every 10 seconds), and processes kept per project.
const MAX_RUNTIME_SAMPLES = 2160;
const MAX_RUNTIME_PROCESSES = 8;
// Fields a summary may contain, in the order they are written.
const SUMMARY_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'method', 'status', 'duration', 'requestSize', 'responseSize', 'aborted', 'exceptionCount', 'stats', 'url', 'path', 'contentType', 'route', 'handler', 'user', 'replayOf'];
const EXCEPTION_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'handled', 'fatal', 'requestId', 'jobRunId', 'name', 'message', 'code', 'fingerprint', 'mechanism', 'location', 'request', 'job', 'user'];
const JOB_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'name', 'queue', 'schedule', 'timezone', 'trigger', 'status', 'duration', 'attempt', 'exceptionCount', 'stats', 'error', 'user'];
const LOG_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'level', 'source', 'requestId', 'jobRunId', 'message'];
const DUMP_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'requestId', 'jobRunId', 'label', 'location', 'type', 'preview', 'truncated'];
const MAIL_FIELDS = ['seq', 'id', 'occurredAt', 'environment', 'release', 'requestId', 'jobRunId', 'location', 'subject', 'from', 'to', 'recipients', 'attachments', 'html', 'transport', 'status', 'duration', 'error'];
const EXCEPTIONS_FOLDER = 'exceptions';
const JOBS_FOLDER = 'jobs';
const LOGS_FOLDER = 'logs';
const DUMPS_FOLDER = 'dumps';
const MAILS_FOLDER = 'mails';

/**
 * @typedef {Object} ProjectInfo
 * @property {string} id
 * @property {string} name
 * @property {string} root - The project's folder on this machine
 * @property {number} createdAt
 * @property {number} lastSeenAt - When one of its processes last checked in
 * @property {number} seqBase - Lowest sequence number the next request may get, kept so
 *   numbering continues after the requests are cleared
 * @property {number} exceptionSeqBase - The same, for exceptions
 * @property {{ total: number, firstAt: number, lastAt: number, entries: Object[] }} [blocked] -
 *   Server requests that were not recorded
 */

/**
 * The requests, exceptions, metadata and running processes of one project.
 */
export class ProjectLog {
  /**
   * Use ProjectLog.create() or ProjectLog.load().
   *
   * @param {string} dir - The project's folder
   * @param {ProjectInfo} info
   * @param {Object} limits
   * @param {number} limits.maxRequests - Requests kept
   * @param {number} limits.segmentSize - Requests per segment file
   * @param {number} limits.maxExceptions - Exceptions kept
   * @param {number} limits.exceptionSegmentSize - Exceptions per segment file
   * @param {number} limits.maxJobs - Job runs kept
   * @param {number} limits.maxLogs - Log lines kept
   * @param {number} limits.maxDumps - Dumps kept
   * @param {number} limits.maxMails - Emails kept
   * @param {{ requests?: SegmentLog, exceptions?: SegmentLog, jobs?: SegmentLog, logs?: SegmentLog, dumps?: SegmentLog, mails?: SegmentLog }} [logs] - Logs
   *   read from disk
   */
  constructor(dir, info, limits, logs = {}) {
    this.dir = dir;
    this.info = info;
    this.maxRequests = limits.maxRequests;
    this.requests = logs.requests || new SegmentLog(dir, ProjectLog._requestOptions(info, limits));
    this.exceptions = logs.exceptions || new SegmentLog(path.join(dir, EXCEPTIONS_FOLDER), ProjectLog._exceptionOptions(info, limits));
    this.jobs = logs.jobs || new SegmentLog(path.join(dir, JOBS_FOLDER), ProjectLog._jobOptions(info, limits));
    this.logs = logs.logs || new SegmentLog(path.join(dir, LOGS_FOLDER), ProjectLog._logOptions(info, limits));
    this.dumps = logs.dumps || new SegmentLog(path.join(dir, DUMPS_FOLDER), ProjectLog._dumpOptions(info, limits));
    this.mails = logs.mails || new SegmentLog(path.join(dir, MAILS_FOLDER), ProjectLog._mailOptions(info, limits));
    this.exceptionState = new ExceptionState(dir);
    // Processes running the project, by pid. In memory only: they check in again after a restart.
    this.instances = new Map();
    // Recent processes and their samples, by pid, least recently seen first. In memory only.
    this.runtime = new Map();
    // Whether info changed since it was saved.
    this.dirty = false;
  }

  /**
   * Creates a project's folder and metadata.
   *
   * @param {string} dir - The project's folder
   * @param {{ id: string, name: string, root: string }} info
   * @param {number} now
   * @param {Object} limits - See the constructor
   * @returns {ProjectLog}
   */
  static create(dir, info, now, limits) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const project = new ProjectLog(dir, {
      id: info.id,
      name: info.name,
      root: info.root,
      createdAt: now,
      lastSeenAt: now,
      seqBase: 1,
      exceptionSeqBase: 1,
      jobSeqBase: 1,
      logSeqBase: 1,
      dumpSeqBase: 1,
      mailSeqBase: 1
    }, limits);
    project.save();
    return project;
  }

  /**
   * Reads a project from its folder. Index lines cut short by a crash are skipped.
   *
   * @param {string} dir - The project's folder
   * @param {string} id - Project id (the folder name)
   * @param {Object} limits - See the constructor
   * @returns {ProjectLog}
   * @throws {Error} When project.json is missing or unreadable
   */
  static load(dir, id, limits) {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    const info = {
      id,
      name: typeof saved.name === 'string' ? saved.name : id,
      root: typeof saved.root === 'string' ? saved.root : '',
      createdAt: Number(saved.createdAt) || Date.now(),
      lastSeenAt: Number(saved.lastSeenAt) || Number(saved.createdAt) || Date.now(),
      seqBase: Number(saved.seqBase) || 1,
      exceptionSeqBase: Number(saved.exceptionSeqBase) || 1,
      jobSeqBase: Number(saved.jobSeqBase) || 1,
      logSeqBase: Number(saved.logSeqBase) || 1,
      dumpSeqBase: Number(saved.dumpSeqBase) || 1,
      mailSeqBase: Number(saved.mailSeqBase) || 1,
      ...(isBlockedInfo(saved.blocked) ? { blocked: saved.blocked } : {})
    };
    return new ProjectLog(dir, info, limits, {
      requests: SegmentLog.load(dir, ProjectLog._requestOptions(info, limits)),
      exceptions: SegmentLog.load(path.join(dir, EXCEPTIONS_FOLDER), ProjectLog._exceptionOptions(info, limits)),
      jobs: SegmentLog.load(path.join(dir, JOBS_FOLDER), ProjectLog._jobOptions(info, limits)),
      logs: SegmentLog.load(path.join(dir, LOGS_FOLDER), ProjectLog._logOptions(info, limits)),
      dumps: SegmentLog.load(path.join(dir, DUMPS_FOLDER), ProjectLog._dumpOptions(info, limits)),
      mails: SegmentLog.load(path.join(dir, MAILS_FOLDER), ProjectLog._mailOptions(info, limits))
    });
  }

  /**
   * Records that one of the project's processes checked in, and keeps the name and folder it
   * reports. Those rarely change, so they are saved right away; the check-in time is saved
   * later by persist().
   *
   * @param {{ name: string, root: string }} info
   * @param {Object} instance - Process details: pid, port, framework, node, sdk, environment, startedAt
   * @param {number} now
   * @returns {void}
   */
  checkIn(info, instance, now) {
    this.rename(info);
    this.info.lastSeenAt = now;
    this.dirty = true;
    this.instances.set(instance.pid, { ...instance, lastSeenAt: now });
  }

  /**
   * Adds samples of one of the project's processes (memory, CPU, event-loop delay).
   *
   * @param {Object} instance - Process details, as checked in
   * @param {Object[]} samples - Validated samples, oldest first
   * @param {number} now
   * @returns {void}
   */
  addSamples(instance, samples, now) {
    if (!samples.length) return;
    let entry = this.runtime.get(instance.pid);
    // A restarted process can reuse a pid: it starts its own history.
    if (entry && entry.instance.startedAt !== instance.startedAt) entry = null;
    if (!entry) entry = { instance: { ...instance }, samples: [] };
    this.runtime.delete(instance.pid);
    this.runtime.set(instance.pid, entry);
    entry.instance = { ...instance };
    entry.lastSeenAt = now;
    const last = entry.samples.length ? entry.samples[entry.samples.length - 1].at : -Infinity;
    for (const sample of samples) {
      if (sample.at > last) entry.samples.push(sample);
    }
    if (entry.samples.length > MAX_RUNTIME_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_RUNTIME_SAMPLES);
    while (this.runtime.size > MAX_RUNTIME_PROCESSES) this.runtime.delete(this.runtime.keys().next().value);
  }

  /**
   * The project's recent processes with their samples, the most recently seen first.
   *
   * @param {number} now
   * @returns {{ processes: Object[] }}
   */
  runtimeHistory(now) {
    const processes = [...this.runtime.values()].reverse().map((entry) => ({
      ...entry.instance,
      lastSeenAt: entry.lastSeenAt,
      online: now - entry.lastSeenAt <= ONLINE_MS,
      samples: entry.samples
    }));
    return { processes };
  }

  /**
   * Keeps the name and folder a process reports, without counting it as a check-in (records
   * spooled by a process that has exited).
   *
   * @param {{ name: string, root: string }} info
   * @returns {void}
   */
  rename(info) {
    if (this.info.name !== info.name || this.info.root !== info.root) {
      this.info.name = info.name;
      this.info.root = info.root;
      this.save();
    }
  }

  /**
   * Adds counts of server requests that were not recorded. Proxied clients share one entry,
   * holding the latest address as an example; only the largest entries are kept.
   *
   * @param {{ kind: 'host'|'client', value: string, count: number }[]} entries
   * @param {number} now
   * @returns {void}
   */
  noteBlocked(entries, now) {
    const blocked = this.info.blocked || { total: 0, firstAt: now, lastAt: now, entries: [] };
    for (const entry of entries) {
      blocked.total += entry.count;
      const existing = blocked.entries.find((item) => item.kind === entry.kind && (entry.kind === 'client' || item.value === entry.value));
      if (existing) {
        existing.count += entry.count;
        existing.value = entry.value;
      } else {
        blocked.entries.push({ ...entry });
      }
    }
    blocked.entries.sort((a, b) => b.count - a.count).splice(MAX_BLOCKED_ENTRIES);
    blocked.lastAt = now;
    this.info.blocked = blocked;
    this.dirty = true;
  }

  /**
   * Stores new requests. Requests already stored (same id) are skipped, so retried batches are
   * harmless.
   *
   * @param {Object[]} records - Validated records, with their detail
   * @returns {Object[]} Summaries of the stored requests
   */
  append(records) {
    return this.requests.append(records);
  }

  /**
   * Request summaries, newest first; oldest first when `after` is given (for polling new requests).
   *
   * @param {{ after?: number, before?: number, limit: number }} query - Sequence numbers to page by
   * @returns {{ requests: Object[], hasMore: boolean }}
   */
  list(query) {
    const { entries, hasMore } = this.requests.list(query);
    return { requests: entries, hasMore };
  }

  /**
   * The full detail of one request, read from disk.
   *
   * @param {string} requestId
   * @returns {Object|null} null when it is no longer stored
   */
  detail(requestId) {
    return this.requests.detail(requestId);
  }

  /**
   * One request's summary, as the request list shows it.
   *
   * @param {string} requestId
   * @returns {Object|null} null when it is no longer stored
   */
  summary(requestId) {
    return this.requests.summary(requestId);
  }

  /**
   * Deletes all requests, keeping the project.
   *
   * @returns {void}
   */
  clear() {
    this.requests.clear();
    // Sequence numbers keep increasing, so open dashboards keep polling from the right place.
    this.info.seqBase = this.requests.seqBase;
    this.save();
  }

  /**
   * Stores new exceptions; ones already stored (same id) are skipped.
   *
   * @param {Object[]} records - Validated exceptions, with their detail
   * @returns {Object[]} Summaries of the stored exceptions
   */
  appendExceptions(records) {
    return this.exceptions.append(records);
  }

  /**
   * Exception summaries, newest first; oldest first when `after` is given.
   *
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ exceptions: Object[], hasMore: boolean }}
   */
  listExceptions(query) {
    const { entries, hasMore } = this.exceptions.list(query);
    return { exceptions: entries, hasMore };
  }

  /**
   * The full detail of one exception, read from disk.
   *
   * @param {string} exceptionId
   * @returns {Object|null} null when it is no longer stored
   */
  exceptionDetail(exceptionId) {
    return this.exceptions.detail(exceptionId);
  }

  /**
   * Deletes all exceptions, keeping the project (and which issues are resolved).
   *
   * @returns {void}
   */
  clearExceptions() {
    this.exceptions.clear();
    this.info.exceptionSeqBase = this.exceptions.seqBase;
    this.save();
  }

  /**
   * Stores new job runs; ones already stored (same id) are skipped.
   *
   * @param {Object[]} records - Validated job runs, with their detail
   * @returns {Object[]} Summaries of the stored runs
   */
  appendJobs(records) {
    return this.jobs.append(records);
  }

  /**
   * Job run summaries, newest first; oldest first when `after` is given.
   *
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ jobs: Object[], hasMore: boolean }}
   */
  listJobs(query) {
    const { entries, hasMore } = this.jobs.list(query);
    return { jobs: entries, hasMore };
  }

  /**
   * @param {string} jobRunId
   * @returns {Object|null}
   */
  jobDetail(jobRunId) {
    return this.jobs.detail(jobRunId);
  }

  /**
   * Deletes all job runs.
   *
   * @returns {void}
   */
  clearJobs() {
    this.jobs.clear();
    this.info.jobSeqBase = this.jobs.seqBase;
    this.save();
  }

  /**
   * Stores new log lines; ones already stored (same id) are skipped.
   *
   * @param {Object[]} records - Validated lines, with their detail (the whole line)
   * @returns {Object[]}
   */
  appendLogs(records) {
    return this.logs.append(records);
  }

  /**
   * Log line summaries, newest first; oldest first when `after` is given.
   *
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ logs: Object[], hasMore: boolean }}
   */
  listLogs(query) {
    const { entries, hasMore } = this.logs.list(query);
    return { logs: entries, hasMore };
  }

  /**
   * The whole of one log line (its message in full and its fields).
   *
   * @param {string} logId
   * @returns {Object|null}
   */
  logDetail(logId) {
    return this.logs.detail(logId);
  }

  /**
   * Deletes all log lines.
   *
   * @returns {void}
   */
  clearLogs() {
    this.logs.clear();
    this.info.logSeqBase = this.logs.seqBase;
    this.save();
  }

  /**
   * Stores new dumps; ones already stored (same id) are skipped.
   *
   * @param {Object[]} records - Validated dumps, with their detail (the value's tree)
   * @returns {Object[]}
   */
  appendDumps(records) {
    return this.dumps.append(records);
  }

  /**
   * Dump summaries, newest first; oldest first when `after` is given.
   *
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ dumps: Object[], hasMore: boolean }}
   */
  listDumps(query) {
    const { entries, hasMore } = this.dumps.list(query);
    return { dumps: entries, hasMore };
  }

  /**
   * One dump's value (its tree).
   *
   * @param {string} dumpId
   * @returns {Object|null}
   */
  dumpDetail(dumpId) {
    return this.dumps.detail(dumpId);
  }

  /**
   * Deletes all dumps.
   *
   * @returns {void}
   */
  clearDumps() {
    this.dumps.clear();
    this.info.dumpSeqBase = this.dumps.seqBase;
    this.save();
  }

  /**
   * Stores new emails; ones already stored (same id) are skipped.
   *
   * @param {Object[]} records - Validated emails, with their detail (the message)
   * @returns {Object[]}
   */
  appendMails(records) {
    return this.mails.append(records);
  }

  /**
   * Email summaries, newest first; oldest first when `after` is given.
   *
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ mails: Object[], hasMore: boolean }}
   */
  listMails(query) {
    const { entries, hasMore } = this.mails.list(query);
    return { mails: entries, hasMore };
  }

  /**
   * One email's message.
   *
   * @param {string} mailId
   * @returns {Object|null}
   */
  mailDetail(mailId) {
    return this.mails.detail(mailId);
  }

  /**
   * Deletes all emails.
   *
   * @returns {void}
   */
  clearMails() {
    this.mails.clear();
    this.info.mailSeqBase = this.mails.seqBase;
    this.save();
  }

  /**
   * Deletes the project's folder.
   *
   * @returns {void}
   */
  remove() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * The project as the dashboard lists it. Processes that stopped checking in long ago are
   * forgotten on the way.
   *
   * @param {number} now
   * @returns {Object} id, name, root, timestamps, request and exception counts, whether it is
   *   online, its running processes, and the notice about server requests (null once it is older
   *   than a day)
   */
  describe(now) {
    for (const [pid, instance] of this.instances) {
      if (now - instance.lastSeenAt > INSTANCE_TTL_MS) this.instances.delete(pid);
    }
    const instances = [...this.instances.values()]
      .filter((instance) => now - instance.lastSeenAt <= ONLINE_MS)
      .sort((a, b) => b.startedAt - a.startedAt);
    const newest = this.requests.newest;
    const newestException = this.exceptions.newest;
    const newestJob = this.jobs.newest;
    const newestDump = this.dumps.newest;
    const newestMail = this.mails.newest;
    return {
      id: this.info.id,
      name: this.info.name,
      root: this.info.root,
      createdAt: this.info.createdAt,
      lastSeenAt: this.info.lastSeenAt,
      lastRequestAt: newest ? newest.occurredAt : null,
      requestCount: this.requests.size,
      exceptionCount: this.exceptions.size,
      lastExceptionAt: newestException ? newestException.occurredAt : null,
      jobCount: this.jobs.size,
      lastJobAt: newestJob ? newestJob.occurredAt : null,
      logCount: this.logs.size,
      dumpCount: this.dumps.size,
      lastDumpAt: newestDump ? newestDump.occurredAt : null,
      mailCount: this.mails.size,
      lastMailAt: newestMail ? newestMail.occurredAt : null,
      online: instances.length > 0,
      instances,
      blocked: this.info.blocked && now - this.info.blocked.lastAt < BLOCKED_NOTICE_MS ? this.info.blocked : null
    };
  }

  /**
   * Saves the metadata if it changed since the last save.
   *
   * @returns {void}
   */
  persist() {
    if (this.dirty) this.save();
  }

  /**
   * Saves the metadata. Written to a temporary file first, so a crash never leaves half a file.
   *
   * @returns {void}
   */
  save() {
    const file = path.join(this.dir, 'project.json');
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.info, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    this.dirty = false;
  }

  /**
   * Deletes the oldest segments of both logs while the newer ones still hold what is kept.
   *
   * @returns {void}
   */
  enforceRetention() {
    this.requests.enforceRetention();
    this.exceptions.enforceRetention();
    this.jobs.enforceRetention();
    this.logs.enforceRetention();
    this.dumps.enforceRetention();
    this.mails.enforceRetention();
  }

  static _requestOptions(info, limits) {
    return { maxEntries: limits.maxRequests, segmentSize: limits.segmentSize, seqBase: info.seqBase, pick: pickSummary };
  }

  static _jobOptions(info, limits) {
    return { maxEntries: limits.maxJobs, segmentSize: Math.max(10, Math.ceil(limits.maxJobs / 4)), seqBase: info.jobSeqBase || 1, pick: pickJob };
  }

  static _logOptions(info, limits) {
    return { maxEntries: limits.maxLogs, segmentSize: Math.max(10, Math.ceil(limits.maxLogs / 4)), seqBase: info.logSeqBase || 1, pick: pickLog };
  }

  static _dumpOptions(info, limits) {
    return { maxEntries: limits.maxDumps, segmentSize: Math.max(10, Math.ceil(limits.maxDumps / 4)), seqBase: info.dumpSeqBase || 1, pick: pickDump };
  }

  static _mailOptions(info, limits) {
    return { maxEntries: limits.maxMails, segmentSize: Math.max(10, Math.ceil(limits.maxMails / 4)), seqBase: info.mailSeqBase || 1, pick: pickMail };
  }

  static _exceptionOptions(info, limits) {
    return {
      maxEntries: limits.maxExceptions,
      segmentSize: limits.exceptionSegmentSize,
      seqBase: info.exceptionSeqBase,
      pick: pickException
    };
  }
}

function isBlockedInfo(value) {
  return Boolean(value) && Number.isFinite(value.total) && Number.isFinite(value.lastAt) && Array.isArray(value.entries);
}

// Only known fields, in a fixed order: index lines and API answers never carry anything else.
// Requests stored before exceptions existed count none; before timelines, they have no stats.
function pickSummary(source) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) summary[field] = source[field];
  if (summary.exceptionCount === undefined) summary.exceptionCount = 0;
  if (summary.stats === undefined) summary.stats = null;
  // Stored before releases (or users) were recorded.
  if (summary.release === undefined) summary.release = null;
  if (summary.user === undefined) summary.user = null;
  // Stored before route patterns were recorded, or from a framework that doesn't name them.
  if (summary.route === undefined) summary.route = null;
  if (summary.handler === undefined) summary.handler = null;
  // Stored before replays, or not a replay.
  if (summary.replayOf === undefined) summary.replayOf = null;
  return summary;
}

function pickException(source) {
  const summary = {};
  for (const field of EXCEPTION_FIELDS) summary[field] = source[field];
  if (summary.release === undefined) summary.release = null;
  if (summary.user === undefined) summary.user = null;
  if (summary.jobRunId === undefined) summary.jobRunId = null;
  if (summary.job === undefined) summary.job = null;
  return summary;
}

function pickJob(source) {
  const summary = {};
  for (const field of JOB_FIELDS) summary[field] = source[field] === undefined ? null : source[field];
  return summary;
}

function pickMail(source) {
  const summary = {};
  for (const field of MAIL_FIELDS) summary[field] = source[field] === undefined ? null : source[field];
  return summary;
}

function pickDump(source) {
  const summary = {};
  for (const field of DUMP_FIELDS) summary[field] = source[field] === undefined ? null : source[field];
  return summary;
}

function pickLog(source) {
  const summary = {};
  for (const field of LOG_FIELDS) summary[field] = source[field] === undefined ? null : source[field];
  return summary;
}
