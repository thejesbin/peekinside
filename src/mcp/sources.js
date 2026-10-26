/**
 * Where `npx peekinside mcp` reads what PeekInside recorded: the local hub, or PeekInside Cloud with
 * an MCP key. Both hand records over in the same shape, the one the local hub stores (a list entry
 * with its summary fields at the top level, and the detail on its own), so the tools read either
 * the same way.
 *
 * Kinds: "requests", "exceptions", "jobs", "logs", and on the local hub "dumps" and "mails".
 */

import { VERSION } from '../config.js';
import { DecryptionError, McpKey, Opener, Sealer } from '../crypto.js';
import { redirectTarget } from '../transport/cloud.js';

// Records per page: the most either API answers with.
export const PAGE_SIZE = 1000;
const CLOUD_TIMEOUT_MS = 20_000;

/**
 * A failure a tool reports to the AI tool as its result, in words a person can act on.
 */
export class SourceError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=0] - HTTP status, when there was an answer
   */
  constructor(message, status = 0) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
  }
}

/**
 * The local hub, through its HTTP API on 127.0.0.1.
 */
export class HubSource {
  /**
   * @param {import('../hub/client.js').HubClient} client
   * @param {Object} [options]
   * @param {() => Promise<boolean>} [options.start] - Starts the hub when it isn't running (it
   *   stops after an hour unused, and AI tools stay open for days); whether it did
   */
  constructor(client, { start = null } = {}) {
    this.client = client;
    this.start = start;
    this.cloud = false;
    this.dashboardUrl = client.url;
  }

  /**
   * @returns {Promise<Object[]>} The hub's projects, those running first
   */
  async projects() {
    const { projects } = await this._get('/api/projects');
    return projects;
  }

  /**
   * One page of records, newest first.
   *
   * @param {string} projectId
   * @param {string} kind
   * @param {{ before?: number, limit?: number }} [page]
   * @returns {Promise<{ items: Object[], hasMore: boolean }>}
   */
  async page(projectId, kind, { before, limit = PAGE_SIZE } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set('before', String(before));
    const body = await this._get(`${projectPath(projectId)}/${kind}?${query}`);
    return { items: Array.isArray(body[kind]) ? body[kind] : [], hasMore: Boolean(body.hasMore) };
  }

  /**
   * One record as its list shows it. The hub keeps few enough records to look through them.
   *
   * @param {string} projectId
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async summary(projectId, kind, id) {
    let before;
    for (;;) {
      const page = await this.page(projectId, kind, { before });
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
      if (!page.hasMore || !page.items.length) return null;
      before = page.items[page.items.length - 1].seq;
    }
  }

  /**
   * @param {string} projectId
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<Object|null>} The record's detail, or null when it is no longer stored
   */
  async detail(projectId, kind, id) {
    try {
      const { detail } = await this._get(`${projectPath(projectId)}/${kind}/${encodeURIComponent(id)}`);
      return detail ?? null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * The project's recent processes, with their samples (one every 10 seconds) and profiles.
   *
   * @param {string} projectId
   * @returns {Promise<{ processes: Object[] }>}
   */
  async runtime(projectId) {
    const body = await this._get(`${projectPath(projectId)}/runtime`);
    return { processes: (body && body.processes || []).map((process) => ({ ...process, id: String(process.pid), points: process.samples || [] })) };
  }

  /**
   * @param {string} projectId
   * @returns {Promise<{ state: { resolved: Object<string, number> }, version: number }>}
   */
  async exceptionState(projectId) {
    const body = await this._get(`${projectPath(projectId)}/exception-state`);
    return { state: { resolved: { ...(body.state && body.state.resolved) } }, version: body.version || 0 };
  }

  /**
   * Saves the resolved issues, unless someone saved since `version` was read.
   *
   * @param {string} projectId
   * @param {{ resolved: Object<string, number> }} state
   * @param {number} version
   * @returns {Promise<{ saved: boolean, state?: Object, version: number }>} The current state and
   *   version when it wasn't saved
   */
  async saveExceptionState(projectId, state, version) {
    try {
      const body = await this._send('PUT', `${projectPath(projectId)}/exception-state`, { body: { state, version } });
      return { saved: true, version: body.version };
    } catch (error) {
      if (error.status === 409 && error.body) return { saved: false, state: error.body.state, version: error.body.version };
      throw hubError(error);
    }
  }

  /**
   * Sends a stored request to its app again (see hub/replay.js).
   *
   * @param {string} projectId
   * @param {string} requestId
   * @returns {Promise<{ id: string, status: number, statusMessage: string, duration: number }>}
   */
  async replay(projectId, requestId) {
    try {
      const { replay } = await this._send('POST', `${projectPath(projectId)}/replays`, { body: { requestId }, timeout: 65_000 });
      return replay;
    } catch (error) {
      throw hubError(error);
    }
  }

  async _get(pathname) {
    try {
      return await this._send('GET', pathname, { timeout: 15_000 });
    } catch (error) {
      throw hubError(error);
    }
  }

  // A request to the hub; when nothing listens, the hub is started and asked again. Changes carry
  // the Origin the hub expects of its own page (it refuses changes without one).
  async _send(method, pathname, options) {
    if (method !== 'GET') options = { ...options, headers: { origin: `http://127.0.0.1:${this.client.port}` } };
    try {
      return await this.client.request(method, pathname, options);
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' || !this.start || !(await this.start().catch(() => false))) throw error;
      return this.client.request(method, pathname, options);
    }
  }
}

/**
 * The local hub's own store, for the hub's /mcp endpoint: the same records as HubSource, without
 * going through HTTP.
 */
export class StoreSource {
  /**
   * @param {import('../hub/store.js').Store} store
   * @param {Object} options
   * @param {string} options.dashboardUrl - Such as "http://localhost:7335"
   * @param {(source: Object) => Promise<Object>} options.replay - Replays a stored request (see
   *   hub/replay.js)
   */
  constructor(store, { dashboardUrl, replay }) {
    this.store = store;
    this.cloud = false;
    this.dashboardUrl = dashboardUrl;
    this._replay = replay;
  }

  async projects() {
    return this.store.listProjects();
  }

  async page(projectId, kind, { before, limit = PAGE_SIZE } = {}) {
    const lists = {
      requests: () => this.store.list(projectId, { before, limit }),
      exceptions: () => this.store.listExceptions(projectId, { before, limit }),
      jobs: () => this.store.listJobs(projectId, { before, limit }),
      logs: () => this.store.listLogs(projectId, { before, limit }),
      dumps: () => this.store.listDumps(projectId, { before, limit }),
      mails: () => this.store.listMails(projectId, { before, limit })
    };
    if (!lists[kind]) throw new SourceError(`Unknown kind: ${kind}`);
    const body = lists[kind]();
    if (!body) throw new SourceError(`There's no project "${projectId}".`, 404);
    return { items: body[kind] || [], hasMore: Boolean(body.hasMore) };
  }

  async summary(projectId, kind, id) {
    let before;
    for (;;) {
      const page = await this.page(projectId, kind, { before });
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
      if (!page.hasMore || !page.items.length) return null;
      before = page.items[page.items.length - 1].seq;
    }
  }

  async detail(projectId, kind, id) {
    const details = {
      requests: () => this.store.detail(projectId, id),
      exceptions: () => this.store.exceptionDetail(projectId, id),
      jobs: () => this.store.jobDetail(projectId, id),
      logs: () => this.store.logDetail(projectId, id),
      dumps: () => this.store.dumpDetail(projectId, id),
      mails: () => this.store.mailDetail(projectId, id)
    };
    if (!details[kind]) throw new SourceError(`Unknown kind: ${kind}`);
    return details[kind]() || null;
  }

  async runtime(projectId) {
    const body = this.store.runtime(projectId);
    return { processes: (body && body.processes || []).map((process) => ({ ...process, id: String(process.pid), points: process.samples || [] })) };
  }

  async exceptionState(projectId) {
    const body = this.store.exceptionState(projectId);
    if (!body) throw new SourceError(`There's no project "${projectId}".`, 404);
    return { state: { resolved: { ...(body.state && body.state.resolved) } }, version: body.version || 0 };
  }

  async saveExceptionState(projectId, state, version) {
    const result = this.store.saveExceptionState(projectId, state, version);
    if (!result) throw new SourceError(`There's no project "${projectId}".`, 404);
    return result.saved ? { saved: true, version: result.version } : { saved: false, state: result.state, version: result.version };
  }

  async replay(projectId, requestId) {
    const source = this.store.replaySource(projectId, requestId);
    if (!source) throw new SourceError('This request is no longer stored.', 404);
    try {
      return await this._replay(source);
    } catch (error) {
      throw new SourceError(error && error.message ? error.message : 'The replay failed.', error && error.status);
    }
  }
}

/**
 * PeekInside Cloud, read with an MCP key: lists and details arrive sealed, and are opened here with
 * the project's private key, which the key unwraps (see McpKey). Nothing decrypted leaves this
 * process except to the AI tool that started it.
 */
export class CloudSource {
  /**
   * @param {Object} options
   * @param {McpKey} options.key
   * @param {string} options.siteUrl - PeekInside's address, such as "https://peekinside.dev"
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ key, siteUrl, fetch: fetchImpl = globalThis.fetch }) {
    this.key = key;
    this.cloud = true;
    this._origin = new URL(siteUrl).origin;
    this._fetch = fetchImpl;
    this._bearer = key.bearer();
    this._session = null;
  }

  /**
   * Checks the key with PeekInside Cloud and opens the project's key; once.
   *
   * @returns {Promise<{ project: { id: string, name: string }, organization: Object, permissions: string[], dashboardUrl: string, keyName: string }>}
   * @throws {SourceError}
   */
  connect() {
    if (!this._session) {
      this._session = this._connect();
      this._session.catch(() => {
        this._session = null;
      });
    }
    return this._session;
  }

  async _connect() {
    const body = await this._request('GET', '/api/mcp/session');
    if (!body || !body.project || body.project.id !== this.key.projectId) {
      throw new SourceError("PeekInside Cloud answered for a different project than this MCP key's.");
    }
    let opened;
    try {
      opened = await this.key.unwrap(body.wrappedKey);
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      throw new SourceError("This MCP key no longer opens the project's records: the project's encryption keys changed since it was made. Make a new MCP key in the project's settings.");
    }
    this.publicKey = opened.publicKey;
    this.opener = new Opener(opened.privateKey, opened.publicKey, 'event');
    this.dashboardUrl = typeof body.dashboardUrl === 'string' ? body.dashboardUrl : `${this._origin}`;
    return {
      project: { id: body.project.id, name: String(body.project.name || body.project.id) },
      organization: body.organization || null,
      permissions: Array.isArray(body.permissions) ? body.permissions : [],
      dashboardUrl: this.dashboardUrl,
      keyName: body.key && body.key.name ? String(body.key.name) : ''
    };
  }

  /**
   * @returns {Promise<Object[]>} The key's project, as the hub lists projects
   */
  async projects() {
    const session = await this.connect();
    return [{ id: session.project.id, name: session.project.name, organization: session.organization, cloud: true }];
  }

  /**
   * One page of records, newest first, with their summaries opened. A summary that doesn't open
   * (sealed to keys the project no longer has) leaves its record marked `locked`.
   *
   * @param {string} projectId
   * @param {string} kind
   * @param {{ before?: number, limit?: number }} [page]
   * @returns {Promise<{ items: Object[], hasMore: boolean }>}
   */
  async page(projectId, kind, { before, limit = PAGE_SIZE } = {}) {
    const route = cloudRoute(kind);
    await this.connect();
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set('before', String(before));
    const body = await this._request('GET', `${projectPath(projectId)}/${route.path}?${query}`);
    const rows = Array.isArray(body[route.list]) ? body[route.list] : [];
    return { items: await Promise.all(rows.map((row) => this._openRow(route, row))), hasMore: Boolean(body.hasMore) };
  }

  /**
   * @param {string} projectId
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async summary(projectId, kind, id) {
    const route = cloudRoute(kind);
    await this.connect();
    try {
      const { record } = await this._request('GET', `${projectPath(projectId)}/records/${route.record}/${encodeURIComponent(id)}`);
      return record ? this._openRow(route, record) : null;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * @param {string} projectId
   * @param {string} kind
   * @param {string} id
   * @returns {Promise<Object|null>} The opened detail, or null when it is no longer stored
   * @throws {SourceError} When it doesn't open
   */
  async detail(projectId, kind, id) {
    const route = cloudRoute(kind);
    await this.connect();
    if (!route.detail) {
      const row = await this.summary(projectId, kind, id);
      return row && !row.locked ? row : null;
    }
    let body;
    try {
      body = await this._request('GET', `${projectPath(projectId)}/${route.path}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    try {
      return await this.opener.openJson(body.detail, `${route.aad}detail:${id}`);
    } catch (error) {
      throw new SourceError(`This ${route.name} couldn't be decrypted with the project's current keys.`);
    }
  }

  /**
   * The project's processes over a window, averaged into buckets, with the heap profiles and
   * event-loop blocks of the processes that sent some (their functions opened here).
   *
   * @param {string} projectId
   * @param {string} [range='1h'] - "15m", "1h", "6h", "24h", "7d" or "30d"
   * @returns {Promise<{ processes: Object[], profiling: boolean }>}
   */
  async runtime(projectId, range = '1h') {
    await this.connect();
    const history = await this._request('GET', `${projectPath(projectId)}/runtime?range=${encodeURIComponent(range)}`);
    const processes = Array.isArray(history.processes) ? history.processes : [];
    const from = history.from;
    const to = history.to;
    // Profiles of the processes shown first (online, then the latest): each is a request or two.
    const ranked = [...processes].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt);
    const withProfiles = new Set(ranked.slice(0, 4).map((process) => process.id));
    const opened = await Promise.all(processes.map(async (process) => {
      if (!withProfiles.has(process.id) || !Number.isFinite(from) || !Number.isFinite(to)) return process;
      const window = new URLSearchParams({ process: process.id, from: String(Math.floor(from)), to: String(Math.ceil(to)) });
      const [heap, blocks] = await Promise.all([
        process.heapProfiles ? this._heap(projectId, window).catch(() => null) : null,
        process.blockWindows ? this._blocks(projectId, window).catch(() => null) : null
      ]);
      return { ...process, heap, blocks };
    }));
    return { processes: opened, profiling: history.profiling !== false };
  }

  /**
   * @param {string} projectId
   * @returns {Promise<{ state: { resolved: Object<string, number> }, version: number }>}
   */
  async exceptionState(projectId) {
    await this.connect();
    const body = await this._request('GET', `${projectPath(projectId)}/exception-state`);
    return { state: await this._openState(projectId, body.sealed), version: body.version || 0 };
  }

  /**
   * Seals the resolved issues to the project's public key (as the dashboard does) and saves them,
   * unless someone saved since `version` was read.
   *
   * @param {string} projectId
   * @param {{ resolved: Object<string, number> }} state
   * @param {number} version
   * @returns {Promise<{ saved: boolean, state?: Object, version: number }>}
   */
  async saveExceptionState(projectId, state, version) {
    await this.connect();
    const sealer = await Sealer.create(this.publicKey, 'event');
    const sealed = await sealer.seal(JSON.stringify(state), stateAad(projectId));
    try {
      const body = await this._request('PUT', `${projectPath(projectId)}/exception-state`, { sealed, version });
      return { saved: true, version: body.version };
    } catch (error) {
      if (error.status !== 409 || !error.body) throw error;
      return { saved: false, state: await this._openState(projectId, error.body.sealed), version: error.body.version || 0 };
    }
  }

  async _openState(projectId, sealed) {
    if (!sealed) return { resolved: {} };
    const state = await this.opener.openJson(sealed, stateAad(projectId)).catch(() => null);
    const resolved = {};
    if (state && state.resolved && typeof state.resolved === 'object') {
      for (const [fingerprint, at] of Object.entries(state.resolved)) {
        if (/^[0-9a-f]{16}$/.test(fingerprint) && Number.isFinite(at)) resolved[fingerprint] = at;
      }
    }
    return { resolved };
  }

  async _openRow(route, row) {
    const { summary, ...meta } = row;
    try {
      const opened = await this.opener.openJson(summary, `${route.aad}summary:${row.id}`);
      return { ...meta, ...(opened && typeof opened === 'object' ? opened : {}) };
    } catch (error) {
      return { ...meta, locked: true };
    }
  }

  async _heap(projectId, window) {
    const { windows } = await this._request('GET', `${projectPath(projectId)}/runtime/heap?${window}`);
    const sites = {};
    const opened = [];
    for (const item of windows || []) {
      const list = await this.opener.openJson(item.sites, `heap:${item.id}`).catch(() => null);
      if (!Array.isArray(list)) continue;
      const bytes = {};
      for (const site of list) {
        if (!site || typeof site.id !== 'string' || !Number.isFinite(site.bytes)) continue;
        const { bytes: held, ...location } = site;
        sites[site.id] = location;
        bytes[site.id] = held;
      }
      opened.push({ at: item.at, reason: item.reason, total: item.total, bytes });
    }
    return opened.length ? { sites, windows: opened } : null;
  }

  async _blocks(projectId, window) {
    const { windows } = await this._request('GET', `${projectPath(projectId)}/runtime/blocks?${window}`);
    const opened = [];
    for (const item of windows || []) {
      const list = await this.opener.openJson(item.sites, `blocks:${item.id}`).catch(() => null);
      if (!Array.isArray(list)) continue;
      opened.push({ at: item.at, count: item.count, total: item.total, worst: item.worst, sites: list.filter((site) => site && typeof site.id === 'string') });
    }
    return opened.length ? opened : null;
  }

  // One API request with the key. A redirect to the site's www twin (or back) is followed by hand,
  // since fetch() would drop the Authorization header, and remembered.
  async _request(method, pathname, body) {
    for (let attempt = 0; ; attempt++) {
      const url = `${this._origin}${pathname}`;
      let response;
      try {
        response = await this._fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this._bearer}`,
            accept: 'application/json',
            'x-peekinside-sdk': VERSION || 'dev',
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS)
        });
      } catch (error) {
        throw new SourceError(`PeekInside Cloud can't be reached at ${this._origin} (${error && error.cause && error.cause.code ? error.cause.code : error.message}).`);
      }
      const moved = attempt === 0 ? redirectTarget(response, url) : null;
      if (moved) {
        this._origin = new URL(moved).origin;
        continue;
      }
      let parsed = null;
      try {
        parsed = await response.json();
      } catch (error) {
        parsed = null;
      }
      if (response.ok && parsed) return parsed;
      throw cloudError(response.status, parsed);
    }
  }
}

// Each kind in PeekInside Cloud's API: its list route and field, its kind for /records, and the
// prefix of the additional authenticated data its summary and detail are sealed with.
const CLOUD_ROUTES = {
  requests: { path: 'events', list: 'events', record: 'request', aad: '', detail: true, name: 'request' },
  exceptions: { path: 'exceptions', list: 'exceptions', record: 'exception', aad: 'exception:', detail: true, name: 'exception' },
  jobs: { path: 'jobs', list: 'jobs', record: 'job-run', aad: 'job:', detail: true, name: 'job run' },
  logs: { path: 'logs', list: 'logs', record: 'log', aad: 'log:', detail: false, name: 'log line' }
};

function cloudRoute(kind) {
  const route = CLOUD_ROUTES[kind];
  if (!route) throw new SourceError(`PeekInside Cloud doesn't keep ${kind}: they stay in the local dashboard.`);
  return route;
}

function projectPath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function stateAad(projectId) {
  return `exception-state:${projectId}`;
}

function hubError(error) {
  if (error instanceof SourceError) return error;
  if (error && (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
    return new SourceError('The local dashboard is not running. Start it with `npx peekinside`, or start an app that uses PeekInside.');
  }
  return new SourceError(error && error.message ? error.message : 'The local dashboard failed to answer.', error && error.status);
}

function cloudError(status, body) {
  const message = body && typeof body.error === 'string' ? body.error : '';
  let error;
  if (status === 401) {
    error = new SourceError("PeekInside Cloud doesn't accept this MCP key: it was revoked, or the member who made it left the organization. Make a new one in the project's settings.", status);
  } else if (status === 403) {
    error = new SourceError(message || "This MCP key's member can't read this.", status);
  } else if (status === 404) {
    error = new SourceError(message || 'Not found.', status);
  } else if (status === 429) {
    error = new SourceError('PeekInside Cloud is limiting how fast this key reads: try again in a minute.', status);
  } else {
    error = new SourceError(message || `PeekInside Cloud answered with HTTP ${status}.`, status);
  }
  error.body = body;
  return error;
}
