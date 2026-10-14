/**
 * Disk storage for the local hub: one folder per project under <data dir>/projects, each held
 * by a ProjectLog (see project-log.js for the file format).
 *
 * The store is the registry: it loads projects at startup, creates them when an app first
 * checks in, and routes every operation to the right project.
 */

import fs from 'fs';
import path from 'path';
import { ProjectLog } from './project-log.js';

// Project ids become folder names, so they can never contain separators or dots.
export const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const DEFAULT_MAX_REQUESTS = 1000;
export const DEFAULT_MAX_EXCEPTIONS = 500;
export const DEFAULT_MAX_JOBS = 2000;
export const DEFAULT_MAX_LOGS = 10000;

/**
 * All projects on this machine.
 */
export class Store {
  /**
   * @param {string} dataDir - PeekInside data folder
   * @param {{ maxRequests?: number, maxExceptions?: number }} [options] - Requests and exceptions
   *   kept per project (at least 10 each)
   */
  constructor(dataDir, { maxRequests = DEFAULT_MAX_REQUESTS, maxExceptions = DEFAULT_MAX_EXCEPTIONS } = {}) {
    this.dir = path.join(dataDir, 'projects');
    this.maxRequests = Math.max(10, Math.floor(maxRequests) || DEFAULT_MAX_REQUESTS);
    this.maxExceptions = Math.max(10, Math.floor(maxExceptions) || DEFAULT_MAX_EXCEPTIONS);
    // Four segments per log: retention deletes a quarter of the records at a time.
    this.segmentSize = Math.max(10, Math.ceil(this.maxRequests / 4));
    this.exceptionSegmentSize = Math.max(10, Math.ceil(this.maxExceptions / 4));
    /** @type {Map<string, ProjectLog>} */
    this.projects = new Map();
  }

  /**
   * Loads the projects on disk. A project that can't be read is skipped (and logged), so one
   * damaged folder never stops the hub.
   *
   * @returns {Store} This store
   */
  load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const id of fs.readdirSync(this.dir)) {
      if (!PROJECT_ID.test(id)) continue;
      try {
        const project = ProjectLog.load(path.join(this.dir, id), id, this._limits());
        this.projects.set(id, project);
        // After registering: a segment that can't be deleted never hides the project.
        project.enforceRetention();
      } catch (error) {
        console.error(`Skipping project ${id}: ${error.message}`);
      }
    }
    return this;
  }

  /**
   * Number of projects.
   *
   * @type {number}
   */
  get size() {
    return this.projects.size;
  }

  /**
   * @param {string} projectId
   * @returns {boolean} Whether the project exists
   */
  has(projectId) {
    return this.projects.has(projectId);
  }

  /**
   * Creates or refreshes a project and records that one of its processes checked in.
   *
   * @param {{ id: string, name: string, root: string }} info
   * @param {Object} instance - Process details: pid, port, framework, node, sdk, environment, startedAt
   * @param {number} [now=Date.now()]
   * @returns {ProjectLog}
   */
  touch(info, instance, now = Date.now()) {
    const project = this.ensure(info, now);
    project.checkIn(info, instance, now);
    return project;
  }

  /**
   * Creates a project if it doesn't exist yet, without counting a check-in: for records spooled
   * by a process that has exited since.
   *
   * @param {{ id: string, name: string, root: string }} info
   * @param {number} [now=Date.now()]
   * @returns {ProjectLog}
   */
  ensure(info, now = Date.now()) {
    let project = this.projects.get(info.id);
    if (!project) {
      project = ProjectLog.create(path.join(this.dir, info.id), info, now, this._limits());
      this.projects.set(info.id, project);
    } else {
      project.rename(info);
    }
    return project;
  }

  /**
   * Adds counts of requests that were not recorded because they reached a server (local mode
   * is for development; servers need PeekInside Cloud).
   *
   * @param {string} projectId
   * @param {{ kind: 'host' | 'client', value: string, count: number }[]} entries
   * @param {number} [now=Date.now()]
   * @returns {void}
   */
  noteBlocked(projectId, entries, now = Date.now()) {
    const project = this.projects.get(projectId);
    if (!project || !entries.length) return;
    project.noteBlocked(entries, now);
  }

  /**
   * Stores new job runs; ones already stored are skipped.
   *
   * @param {string} projectId
   * @param {Object[]} records
   * @returns {Object[]}
   */
  appendJobs(projectId, records) {
    const project = this.projects.get(projectId);
    return project && records.length ? project.appendJobs(records) : [];
  }

  /**
   * @param {string} projectId
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ jobs: Object[], hasMore: boolean }|null}
   */
  listJobs(projectId, query) {
    const project = this.projects.get(projectId);
    return project ? project.listJobs(query) : null;
  }

  /**
   * @param {string} projectId
   * @param {string} jobRunId
   * @returns {Object|null}
   */
  jobDetail(projectId, jobRunId) {
    const project = this.projects.get(projectId);
    return project ? project.jobDetail(jobRunId) : null;
  }

  /**
   * @param {string} projectId
   * @returns {void}
   */
  clearJobs(projectId) {
    const project = this.projects.get(projectId);
    if (project) project.clearJobs();
  }

  /**
   * Stores new log lines; ones already stored are skipped.
   *
   * @param {string} projectId
   * @param {Object[]} records
   * @returns {Object[]}
   */
  appendLogs(projectId, records) {
    const project = this.projects.get(projectId);
    return project && records.length ? project.appendLogs(records) : [];
  }

  /**
   * @param {string} projectId
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ logs: Object[], hasMore: boolean }|null}
   */
  listLogs(projectId, query) {
    const project = this.projects.get(projectId);
    return project ? project.listLogs(query) : null;
  }

  /**
   * @param {string} projectId
   * @param {string} logId
   * @returns {Object|null}
   */
  logDetail(projectId, logId) {
    const project = this.projects.get(projectId);
    return project ? project.logDetail(logId) : null;
  }

  /**
   * @param {string} projectId
   * @returns {void}
   */
  clearLogs(projectId) {
    const project = this.projects.get(projectId);
    if (project) project.clearLogs();
  }

  /**
   * Adds process samples of a project's process (kept in memory, for the Runtime page).
   *
   * @param {string} projectId
   * @param {Object} instance - Validated process details
   * @param {Object[]} samples - Validated samples
   * @param {number} [now=Date.now()]
   * @returns {void}
   */
  addSamples(projectId, instance, samples, now = Date.now()) {
    const project = this.projects.get(projectId);
    if (project) project.addSamples(instance, samples, now);
  }

  /**
   * A project's recent processes with their samples.
   *
   * @param {string} projectId
   * @param {number} [now=Date.now()]
   * @returns {{ processes: Object[] }|null} null for an unknown project
   */
  runtime(projectId, now = Date.now()) {
    const project = this.projects.get(projectId);
    return project ? project.runtimeHistory(now) : null;
  }

  /**
   * Stores new requests. Requests already stored (same id) are skipped, so retried batches are harmless.
   *
   * @param {string} projectId
   * @param {Object[]} records - Validated records
   * @returns {Object[]} Summaries of the stored requests
   */
  append(projectId, records) {
    const project = this.projects.get(projectId);
    return project ? project.append(records) : [];
  }

  /**
   * Summaries, newest first; oldest first when `after` is given (for polling new requests).
   *
   * @param {string} projectId
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ requests: Object[], hasMore: boolean } | null} null for an unknown project
   */
  list(projectId, query) {
    const project = this.projects.get(projectId);
    return project ? project.list(query) : null;
  }

  /**
   * The full detail of one request.
   *
   * @param {string} projectId
   * @param {string} requestId
   * @returns {Object|null} null when it is no longer stored
   */
  detail(projectId, requestId) {
    const project = this.projects.get(projectId);
    return project ? project.detail(requestId) : null;
  }

  /**
   * Deletes a project's requests.
   *
   * @param {string} projectId
   * @returns {boolean} False for an unknown project
   */
  clear(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return false;
    project.clear();
    return true;
  }

  /**
   * Stores new exceptions; ones already stored (same id) are skipped.
   *
   * @param {string} projectId
   * @param {Object[]} records - Validated exceptions
   * @returns {Object[]} Summaries of the stored exceptions
   */
  appendExceptions(projectId, records) {
    const project = this.projects.get(projectId);
    return project && records.length ? project.appendExceptions(records) : [];
  }

  /**
   * Exception summaries, newest first; oldest first when `after` is given.
   *
   * @param {string} projectId
   * @param {{ after?: number, before?: number, limit: number }} query
   * @returns {{ exceptions: Object[], hasMore: boolean } | null} null for an unknown project
   */
  listExceptions(projectId, query) {
    const project = this.projects.get(projectId);
    return project ? project.listExceptions(query) : null;
  }

  /**
   * The full detail of one exception.
   *
   * @param {string} projectId
   * @param {string} exceptionId
   * @returns {Object|null} null when it is no longer stored
   */
  exceptionDetail(projectId, exceptionId) {
    const project = this.projects.get(projectId);
    return project ? project.exceptionDetail(exceptionId) : null;
  }

  /**
   * Deletes a project's exceptions.
   *
   * @param {string} projectId
   * @returns {boolean} False for an unknown project
   */
  clearExceptions(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return false;
    project.clearExceptions();
    return true;
  }

  /**
   * The project's exception state (resolved fingerprints) and its version.
   *
   * @param {string} projectId
   * @returns {{ state: Object, version: number } | null} null for an unknown project
   */
  exceptionState(projectId) {
    const project = this.projects.get(projectId);
    return project ? project.exceptionState.read() : null;
  }

  /**
   * Saves the project's exception state if `version` is the current one.
   *
   * @param {string} projectId
   * @param {Object} state - Validated state (see ExceptionState.validate())
   * @param {number} version - The version the dashboard read
   * @returns {{ saved: boolean, state: Object, version: number } | null} null for an unknown project
   */
  saveExceptionState(projectId, state, version) {
    const project = this.projects.get(projectId);
    return project ? project.exceptionState.write(state, version) : null;
  }

  /**
   * Forgets a project and deletes its folder.
   *
   * @param {string} projectId
   * @returns {boolean} False for an unknown project
   */
  remove(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return false;
    project.remove();
    this.projects.delete(projectId);
    return true;
  }

  /**
   * Projects with their request counts and running processes, most recently active first.
   *
   * @param {number} [now=Date.now()]
   * @returns {Object[]}
   */
  listProjects(now = Date.now()) {
    const result = [];
    for (const project of this.projects.values()) {
      result.push(project.describe(now));
    }
    return result.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Writes changed project metadata (last-seen times) to disk.
   *
   * @returns {void}
   */
  persist() {
    for (const project of this.projects.values()) project.persist();
  }

  _limits() {
    return {
      maxRequests: this.maxRequests,
      segmentSize: this.segmentSize,
      maxExceptions: this.maxExceptions,
      exceptionSegmentSize: this.exceptionSegmentSize,
      maxJobs: DEFAULT_MAX_JOBS,
      maxLogs: DEFAULT_MAX_LOGS
    };
  }
}
