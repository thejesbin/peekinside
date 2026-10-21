/**
 * The local hub's HTTP server, on 127.0.0.1 only.
 *
 *   GET    /                                   Dashboard page (also /p/<project id>, and its
 *                                              /exceptions, /routes, /queries, /logs, /jobs, /dumps, /mail and /runtime)
 *   POST   /api/ingest                         Requests and exceptions from the SDK in each app, and
 *                                              counts of server requests it didn't record (free plan)
 *   GET    /api/status                         Hub version and settings
 *   GET    /api/projects                       Projects, with their running processes
 *   GET    /api/projects/:id/requests          Summaries. Query: limit, before or after (sequence numbers)
 *   GET    /api/projects/:id/requests/:rid     One request's full detail
 *   DELETE /api/projects/:id/requests          Delete a project's requests
 *   POST   /api/projects/:id/replays           Send a stored request to its app again ({ requestId })
 *   GET    /api/projects/:id/exceptions        Exception summaries, paged like requests
 *   GET    /api/projects/:id/exceptions/:eid   One exception's full detail
 *   DELETE /api/projects/:id/exceptions        Delete a project's exceptions
 *   GET    /api/projects/:id/runtime           Recent processes with their memory, CPU and event-loop samples
 *   GET    /api/projects/:id/jobs              Job run summaries, paged like requests
 *   GET    /api/projects/:id/jobs/:jid         One job run's detail
 *   DELETE /api/projects/:id/jobs              Delete a project's job runs
 *   GET    /api/projects/:id/logs              Log lines (their start), paged like requests
 *   GET    /api/projects/:id/logs/:lid         One log line in full
 *   DELETE /api/projects/:id/logs              Delete a project's log lines
 *   GET    /api/projects/:id/dumps             Dumps (a preview of each value), paged like requests
 *   GET    /api/projects/:id/dumps/:did        One dump's value
 *   DELETE /api/projects/:id/dumps             Delete a project's dumps
 *   GET    /api/projects/:id/mails             Emails the app sent (who to, the subject), paged like requests
 *   GET    /api/projects/:id/mails/:mid        One email's message
 *   GET    /api/projects/:id/mails/:mid/html   Its HTML, for the Mail page's preview frame (?images=1
 *                                              loads remote images)
 *   DELETE /api/projects/:id/mails             Delete a project's emails
 *   GET    /api/projects/:id/exception-state   Resolved issues, with a version
 *   PUT    /api/projects/:id/exception-state   Save them, if the version is still the current one
 *   DELETE /api/projects/:id                   Forget a project
 *   GET    /brand/<file>                       The PeekInside mark, for the page's icon (also
 *                                              /favicon.svg and /favicon.ico)
 *
 * The page is a small shell that loads the dashboard interface from the PeekInside site; all
 * request data comes from this server. The API answers only this origin: requests with a
 * foreign Host header (DNS rebinding) or from other sites are refused, and no CORS headers
 * are ever sent. Ingest only accepts requests that don't come from a browser.
 */

import http from 'http';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { HUB_API_VERSION, HUB_APP_ID } from '../config.js';
import { ExceptionState } from './exception-state.js';
import { IngestPayload, REQUEST_ID } from './ingest-payload.js';
import { DEFAULT_REPLAY_TIMEOUT_MS, Replay, ReplayError } from './replay.js';
import { DEFAULT_MAX_DUMPS, DEFAULT_MAX_MAILS, PROJECT_ID } from './store.js';

const MAX_INGEST_BYTES = 32 * 1024 * 1024;
// 5000 fingerprints with their timestamps take about 200 KB.
const MAX_STATE_BYTES = 1024 * 1024;
// A replay names one request.
const MAX_REPLAY_BYTES = 4096;
const DEFAULT_PAGE = 500;
const MAX_PAGE = 1000;
// /api/projects/:id, then optionally a collection and an item.
const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)(?:\/(requests|exceptions|exception-state|runtime|jobs|logs|dumps|mails|replays)(?:\/([^/]+))?)?$/;
// An email's HTML, for the preview frame.
const MAIL_HTML_ROUTE = /^\/api\/projects\/([^/]+)\/mails\/([^/]+)\/html$/;
// The dashboard page: the project list, a project's requests, its exceptions and its queries.
const SHELL_ROUTE = /^\/p\/[a-z0-9-]{1,64}(?:\/(?:exceptions|routes|queries|runtime|logs|jobs|dumps|mail))?\/?$/;

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

// If the interface doesn't arrive (blocked, offline, or still missing after 20 seconds), says so
// instead of "Loading" forever. The app replaces the loading message when it starts, so the timer
// finds nothing to replace then.
const BOOT_WATCH = '(function(){var shown=false;function show(){if(shown)return;var loading=document.querySelector(".boot-loading"),failed=document.querySelector(".boot-failed");if(!loading||!failed)return;shown=true;loading.hidden=true;failed.hidden=false}function broken(){if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",show);else show()}document.addEventListener("securitypolicyviolation",function(e){if(/^(script|style)-src/.test(e.effectiveDirective||e.violatedDirective||""))broken()});window.addEventListener("error",function(e){var t=e.target;if(t&&t.tagName==="SCRIPT"&&/\\/app\\.js$/.test(t.src||""))broken()},true);setTimeout(function(){if(document.querySelector(".boot-loading"))broken()},20000)})()';

// Applies the saved theme before first paint (same as the PeekInside site).
const THEME_SCRIPT = '(function(){try{var t=localStorage.getItem("peekinside:theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","dark")}})()';

// The PeekInside mark (Span Core): the approved files, unchanged. "-dark" is drawn for dark
// backgrounds and "-light" for light ones; the page links each for the matching browser theme.
const BRAND_FILES = new Map(
  ['peekinside-span-core-mark-dark.svg', 'peekinside-span-core-mark-light.svg'].map((name) => [
    name,
    readFileSync(new URL(`./brand/${name}`, import.meta.url))
  ])
);
const BRAND_ROUTE = /^\/brand\/([a-z0-9-]+\.svg)$/;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * The hub's HTTP API and dashboard page. Owns the http.Server; each route is a method.
 */
export class HubServer {
  /**
   * @param {Object} options
   * @param {import('./store.js').Store} options.store
   * @param {number} options.port - Port the server will listen on (checked against the Host header)
   * @param {string} options.siteUrl - Origin the dashboard interface is loaded from
   * @param {string} options.version - Package version
   * @param {string} options.dataDir - Data folder, shown in the dashboard
   * @param {Function} [options.onActivity] - Called for every API request and ingest, to tell
   *   whether the hub is still in use
   * @param {number} [options.replayTimeoutMs] - Longest wait for an app to answer a replay
   */
  constructor({ store, port, siteUrl, version, dataDir, onActivity = () => {}, replayTimeoutMs = DEFAULT_REPLAY_TIMEOUT_MS }) {
    this.store = store;
    this.port = port;
    this.siteUrl = siteUrl;
    this.version = version;
    this.dataDir = dataDir;
    this.onActivity = onActivity;
    this.replayTimeoutMs = replayTimeoutMs;
    // The names this server is reached by. Any other Host means DNS rebinding: a foreign site
    // whose domain resolves to 127.0.0.1.
    this._hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
    this._assets = `${siteUrl}/local/v${HUB_API_VERSION}`;
    this.startedAt = Date.now();

    /** @type {http.Server} */
    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error(`Request failed: ${error && error.stack ? error.stack : error}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
        else res.destroy();
      });
    });
  }

  /**
   * Starts listening on 127.0.0.1, never on other interfaces: the data is only for this machine.
   *
   * @param {Function} [callback] - Called once listening
   * @returns {HubServer} This server
   */
  listen(callback) {
    this.httpServer.listen(this.port, '127.0.0.1', callback);
    return this;
  }

  /**
   * Stops listening and closes open connections, including dashboards polling it.
   *
   * @returns {void}
   */
  close() {
    this.httpServer.close();
    this.httpServer.closeAllConnections?.();
  }

  /**
   * What GET /api/status returns. `app` lets clients tell the hub apart from other programs.
   *
   * @returns {Object}
   */
  status() {
    return {
      app: HUB_APP_ID,
      apiVersion: HUB_API_VERSION,
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      dataDir: this.dataDir,
      siteUrl: this.siteUrl,
      maxRequests: this.store.maxRequests,
      maxExceptions: this.store.maxExceptions,
      // Also tells the dashboard this hub keeps dumps, and emails (older ones don't).
      maxDumps: DEFAULT_MAX_DUMPS,
      maxMails: DEFAULT_MAX_MAILS,
      // Tells the dashboard this hub replays requests (older ones don't).
      replay: true
    };
  }

  /**
   * Answers one request.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<void>}
   */
  async handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!this._hosts.has(host)) {
      return sendText(res, 403, 'Forbidden: open this dashboard at http://localhost:' + this.port);
    }

    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch (error) {
      return sendText(res, 400, 'Bad Request');
    }
    const { pathname, searchParams } = url;

    if (pathname === '/api/ingest') {
      this.onActivity();
      return this._ingest(req, res);
    }
    if (pathname.startsWith('/api/')) {
      if (!isSameOrigin(req, host)) {
        return sendJson(res, 403, { error: 'Only the dashboard on this port can use this API.' });
      }
      this.onActivity();
      return this._api(req, res, pathname, searchParams);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendText(res, 405, 'Method Not Allowed');
    }
    if (pathname === '/' || SHELL_ROUTE.test(pathname)) {
      return this._shell(req, res);
    }
    const brandFile = pathname === '/favicon.svg' || pathname === '/favicon.ico'
      ? 'peekinside-span-core-mark-dark.svg'
      : BRAND_ROUTE.exec(pathname)?.[1];
    if (brandFile && BRAND_FILES.has(brandFile)) {
      return send(res, 200, BRAND_FILES.get(brandFile), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' }, req.method === 'HEAD');
    }
    return sendText(res, 404, 'Not Found');
  }

  // POST /api/ingest: a batch from an app's SDK.
  async _ingest(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    // Browsers always send Origin or Sec-Fetch-Site on cross-origin POSTs; the SDK sends neither.
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      return sendJson(res, 403, { error: 'Browsers cannot send requests to the hub.' });
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, 415, { error: 'Expected application/json' });
    }
    if (!req.headers['x-peekinside-sdk']) {
      return sendJson(res, 400, { error: 'Missing x-peekinside-sdk header' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_INGEST_BYTES));
    } catch (error) {
      if (error && error.status === 413) {
        res.setHeader('Connection', 'close');
        return sendJson(res, 413, { error: 'Batch too large' });
      }
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const payload = IngestPayload.parse(body);
    if (!payload) {
      return sendJson(res, 400, { error: 'Expected { project, instance, requests }' });
    }

    this.store.touch(payload.project, payload.instance);
    const added = this.store.append(payload.project.id, payload.records);
    const addedExceptions = this.store.appendExceptions(payload.project.id, payload.exceptions);
    this.store.noteBlocked(payload.project.id, payload.blocked);
    this.store.addSamples(payload.project.id, payload.instance, payload.samples);
    const addedJobs = this.store.appendJobs(payload.project.id, payload.jobs);
    const addedLogs = this.store.appendLogs(payload.project.id, payload.logs);
    const addedDumps = this.store.appendDumps(payload.project.id, payload.dumps);
    const addedMails = this.store.appendMails(payload.project.id, payload.mails);
    // SDKs from before exceptions get the answer they know.
    return sendJson(res, 200, payload.hasExceptions
      ? {
        accepted: added.length,
        rejected: payload.rejected,
        acceptedExceptions: addedExceptions.length,
        rejectedExceptions: payload.rejectedExceptions,
        acceptedJobs: addedJobs.length,
        acceptedLogs: addedLogs.length,
        acceptedDumps: addedDumps.length,
        acceptedMails: addedMails.length
      }
      : { accepted: added.length, rejected: payload.rejected, acceptedJobs: addedJobs.length, acceptedLogs: addedLogs.length, acceptedDumps: addedDumps.length, acceptedMails: addedMails.length });
  }

  // Every /api/ route except ingest; the caller has checked the origin.
  _api(req, res, pathname, query) {
    const read = isRead(req);

    if (pathname === '/api/status') {
      return read ? sendJson(res, 200, this.status()) : methodNotAllowed(res, 'GET, HEAD');
    }
    if (pathname === '/api/projects') {
      return read ? sendJson(res, 200, { projects: this.store.listProjects() }) : methodNotAllowed(res, 'GET, HEAD');
    }

    const html = MAIL_HTML_ROUTE.exec(pathname);
    if (html) {
      return this._mailHtml(req, res, decode(html[1]), decode(html[2]), query);
    }

    const match = PROJECT_ROUTE.exec(pathname);
    const projectId = match && decode(match[1]);
    if (!match || !PROJECT_ID.test(projectId)) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (!this.store.has(projectId)) {
      return sendJson(res, 404, { error: 'This project is not on this machine.' });
    }

    // State changes must come from this page: browsers always send Origin with these.
    if (!read && req.headers.origin === undefined) {
      return sendJson(res, 403, { error: 'Missing Origin header' });
    }

    const [, , collection, item] = match;
    if (!collection) {
      return this._project(req, res, projectId);
    }
    if (collection === 'requests') {
      return item === undefined ? this._requests(req, res, projectId, query) : this._requestDetail(req, res, projectId, item);
    }
    if (collection === 'exceptions') {
      return item === undefined ? this._exceptions(req, res, projectId, query) : this._exceptionDetail(req, res, projectId, item);
    }
    if (collection === 'jobs') {
      if (item !== undefined) return this._item(req, res, decode(item), (id) => this.store.jobDetail(projectId, id), 'This job run is no longer stored.');
      return this._collection(req, res, query, () => this.store.listJobs(projectId, pageOf(query)), () => this.store.clearJobs(projectId));
    }
    if (collection === 'logs') {
      if (item !== undefined) return this._item(req, res, decode(item), (id) => this.store.logDetail(projectId, id), 'This log line is no longer stored.');
      return this._collection(req, res, query, () => this.store.listLogs(projectId, pageOf(query)), () => this.store.clearLogs(projectId));
    }
    if (collection === 'dumps') {
      if (item !== undefined) return this._item(req, res, decode(item), (id) => this.store.dumpDetail(projectId, id), 'This dump is no longer stored.');
      return this._collection(req, res, query, () => this.store.listDumps(projectId, pageOf(query)), () => this.store.clearDumps(projectId));
    }
    if (collection === 'mails') {
      if (item !== undefined) return this._item(req, res, decode(item), (id) => this.store.mailDetail(projectId, id), 'This email is no longer stored.');
      return this._collection(req, res, query, () => this.store.listMails(projectId, pageOf(query)), () => this.store.clearMails(projectId));
    }
    if (collection === 'runtime') {
      if (item !== undefined) return sendJson(res, 404, { error: 'Not found' });
      return read ? sendJson(res, 200, this.store.runtime(projectId)) : methodNotAllowed(res, 'GET, HEAD');
    }
    if (collection === 'replays') {
      return item === undefined ? this._replay(req, res, projectId) : sendJson(res, 404, { error: 'Not found' });
    }
    return item === undefined ? this._exceptionState(req, res, projectId) : sendJson(res, 404, { error: 'Not found' });
  }

  // A paged list (GET), or all of it deleted (DELETE).
  _collection(req, res, query, list, clear) {
    if (isRead(req)) return sendJson(res, 200, list());
    if (req.method === 'DELETE') {
      clear();
      return sendJson(res, 200, { cleared: true });
    }
    return methodNotAllowed(res, 'GET, HEAD, DELETE');
  }

  // One stored item's detail.
  _item(req, res, id, detailOf, missing) {
    if (!isRead(req)) return methodNotAllowed(res, 'GET, HEAD');
    const detail = REQUEST_ID.test(id) ? detailOf(id) : null;
    return detail ? sendJson(res, 200, { detail }) : sendJson(res, 404, { error: missing });
  }

  // /api/projects/:id
  _project(req, res, projectId) {
    if (req.method === 'DELETE') {
      this.store.remove(projectId);
      return sendJson(res, 200, { removed: true });
    }
    return methodNotAllowed(res, 'DELETE');
  }

  // /api/projects/:id/requests
  _requests(req, res, projectId, query) {
    if (isRead(req)) {
      return sendJson(res, 200, this.store.list(projectId, pageOf(query)));
    }
    if (req.method === 'DELETE') {
      this.store.clear(projectId);
      return sendJson(res, 200, { cleared: true });
    }
    return methodNotAllowed(res, 'GET, HEAD, DELETE');
  }

  // /api/projects/:id/requests/:rid
  _requestDetail(req, res, projectId, encodedId) {
    if (!isRead(req)) return methodNotAllowed(res, 'GET, HEAD');
    const requestId = decode(encodedId);
    const detail = REQUEST_ID.test(requestId) ? this.store.detail(projectId, requestId) : null;
    return detail
      ? sendJson(res, 200, { detail })
      : sendJson(res, 404, { error: 'This request is no longer stored.' });
  }

  // GET /api/projects/:id/mails/:mid/html: an email's HTML, for the Mail page's preview frame. Its
  // own policy keeps it inert: a sandbox (no scripts, no access to this page), nothing loaded from
  // elsewhere unless the dashboard asks for remote images (?images=1: a tracking pixel would count
  // an open), and only this page may frame it. Links open in a new tab.
  _mailHtml(req, res, projectId, mailId, query) {
    if (!isRead(req)) return methodNotAllowed(res, 'GET, HEAD');
    const detail = PROJECT_ID.test(projectId) && REQUEST_ID.test(mailId) ? this.store.mailDetail(projectId, mailId) : null;
    if (!detail || typeof detail.html !== 'string') {
      return sendText(res, 404, 'This email has no HTML stored.');
    }
    const remote = query.get('images') === '1' ? ' https: http:' : '';
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src data:${remote}`,
      `font-src data:${remote}`,
      'sandbox allow-popups allow-popups-to-escape-sandbox',
      "form-action 'none'",
      "frame-ancestors 'self'"
    ].join('; ');
    send(res, 200, previewDocument(detail.html), {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'SAMEORIGIN'
    }, req.method === 'HEAD');
  }

  // POST /api/projects/:id/replays { requestId }: sends a stored request to its app again, and
  // answers with the id the replay's record takes and the app's status (see replay.js). Like
  // every change, only this page may ask: the Origin check above stops other sites.
  async _replay(req, res, projectId) {
    if (req.method !== 'POST') {
      return methodNotAllowed(res, 'POST');
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, 415, { error: 'Expected application/json' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_REPLAY_BYTES));
    } catch (error) {
      if (error && error.status === 413) {
        res.setHeader('Connection', 'close');
        return sendJson(res, 413, { error: 'Too large' });
      }
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const requestId = body && body.requestId;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return sendJson(res, 400, { error: 'Expected { requestId }' });
    }
    const source = this.store.replaySource(projectId, requestId);
    if (!source) {
      return sendJson(res, 404, { error: 'This request is no longer stored.' });
    }
    try {
      return sendJson(res, 200, { replay: await Replay.run(source, { timeoutMs: this.replayTimeoutMs }) });
    } catch (error) {
      if (error instanceof ReplayError) return sendJson(res, error.status, { error: error.message });
      throw error;
    }
  }

  // /api/projects/:id/exceptions
  _exceptions(req, res, projectId, query) {
    if (isRead(req)) {
      return sendJson(res, 200, this.store.listExceptions(projectId, pageOf(query)));
    }
    if (req.method === 'DELETE') {
      this.store.clearExceptions(projectId);
      return sendJson(res, 200, { cleared: true });
    }
    return methodNotAllowed(res, 'GET, HEAD, DELETE');
  }

  // /api/projects/:id/exceptions/:eid
  _exceptionDetail(req, res, projectId, encodedId) {
    if (!isRead(req)) return methodNotAllowed(res, 'GET, HEAD');
    const exceptionId = decode(encodedId);
    const detail = REQUEST_ID.test(exceptionId) ? this.store.exceptionDetail(projectId, exceptionId) : null;
    return detail
      ? sendJson(res, 200, { detail })
      : sendJson(res, 404, { error: 'This exception is no longer stored.' });
  }

  // /api/projects/:id/exception-state: resolved issues. A save names the version it was based
  // on; when another dashboard saved in between, it gets the current state back to merge with.
  async _exceptionState(req, res, projectId) {
    if (isRead(req)) {
      return sendJson(res, 200, this.store.exceptionState(projectId));
    }
    if (req.method !== 'PUT') {
      return methodNotAllowed(res, 'GET, HEAD, PUT');
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return sendJson(res, 415, { error: 'Expected application/json' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_STATE_BYTES));
    } catch (error) {
      if (error && error.status === 413) {
        res.setHeader('Connection', 'close');
        return sendJson(res, 413, { error: 'State too large' });
      }
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }

    const version = body && body.version;
    const state = body ? ExceptionState.validate(body.state) : null;
    if (!Number.isInteger(version) || version < 0 || !state) {
      return sendJson(res, 400, { error: 'Expected { state: { resolved }, version }, with at most 5000 fingerprints' });
    }
    const result = this.store.saveExceptionState(projectId, state, version);
    if (!result.saved) {
      return sendJson(res, 409, { error: 'The exception state changed since it was read.', state: result.state, version: result.version });
    }
    return sendJson(res, 200, { version: result.version });
  }

  // The dashboard page: a shell that loads the interface from the PeekInside site. The Content
  // Security Policy allows scripts only from that site (and the inline scripts, by nonce), and
  // lets the page fetch data only from this server.
  _shell(req, res) {
    const assets = this._assets;
    const siteUrl = this.siteUrl;
    const host = new URL(siteUrl).host;
    const nonce = randomBytes(16).toString('base64');
    const assetOrigins = siteOrigins(assets);
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${assetOrigins}`,
      `style-src ${assetOrigins} 'unsafe-inline'`,
      "img-src 'self' data:",
      `font-src ${assetOrigins}`,
      "connect-src 'self'",
      // The Mail page's preview: an email's HTML, served by this hub with its own sandbox.
      "frame-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ');

    const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>PeekInside Local</title>
<link rel="icon" href="/brand/peekinside-span-core-mark-light.svg" type="image/svg+xml" media="(prefers-color-scheme: light)">
<link rel="icon" href="/brand/peekinside-span-core-mark-dark.svg" type="image/svg+xml" media="(prefers-color-scheme: dark)">
<script nonce="${nonce}">${BOOT_WATCH}</script>
<link rel="stylesheet" href="${escapeHtml(assets)}/app.css">
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<style>.boot{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:440px;margin:18vh auto 0;padding:0 16px;opacity:.75}.boot a{color:inherit}.boot[hidden]{display:none}.boot-failed{opacity:.9}</style>
</head>
<body>
<div id="root"><div class="boot boot-loading"><p><strong>Loading PeekInside…</strong></p><p>The dashboard interface loads from <a href="${escapeHtml(siteUrl)}">${escapeHtml(host)}</a>. Your requests stay on this machine.</p></div><div class="boot boot-failed" hidden><p><strong>The dashboard didn’t load</strong></p><p>Its interface comes from <a href="${escapeHtml(siteUrl)}">${escapeHtml(host)}</a>, and this browser couldn’t load it. Check that this computer can reach ${escapeHtml(host)}: a firewall, VPN, proxy or ad blocker can block it. Then <a href="">reload this page</a>.</p><p>Your app keeps recording meanwhile, so nothing is lost.</p></div></div>
<script src="${escapeHtml(assets)}/app.js" defer></script>
</body>
</html>
`;
    send(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp
    }, req.method === 'HEAD');
  }
}

// The site's origin and its www twin: hosting often redirects one to the other (Vercel sends the
// bare domain to www by default), and a Content Security Policy also checks where a redirect
// lands. Local addresses (localhost, IPs) have no twin.
function siteOrigins(siteUrl) {
  const url = new URL(siteUrl);
  const host = url.hostname;
  const origins = [url.origin];
  const named = host.includes('.') && !host.startsWith('[') && !/^[\d.]+$/.test(host) && host !== 'localhost' && !host.endsWith('.localhost');
  if (named) {
    const twin = new URL(url.origin);
    twin.hostname = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
    origins.push(twin.origin);
  }
  return origins.join(' ');
}

// The email's HTML as the preview frame shows it: links open in a new tab, and the page is white
// where the email doesn't paint, as in a mail client (the dashboard behind it may be dark).
function previewDocument(html) {
  const extra = '<base target="_blank"><style>:root{color-scheme:light;background:#fff}</style>';
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return extra + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + extra + html.slice(at);
}

function isRead(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

// Same-origin fetches send Sec-Fetch-Site "same-origin" (or "none" when typed in the address bar).
// "same-site" is refused too: other ports on localhost count as the same site.
function isSameOrigin(req, host) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${host}`;
}

// limit, and before or after (sequence numbers), from a list's query string.
function pageOf(query) {
  const limit = Math.min(MAX_PAGE, toInt(query.get('limit'), DEFAULT_PAGE, 1));
  const after = query.has('after') ? toInt(query.get('after'), 0, 0) : undefined;
  const before = query.has('before') ? toInt(query.get('before'), 0, 0) : undefined;
  return { after, before, limit };
}

function toInt(value, fallback, min) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return '';
  }
}

// Stops collecting at `limit` bytes; the 413 response then closes the connection.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function send(res, status, body, headers, headOnly = false) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(headOnly ? undefined : body);
}

function sendText(res, status, body) {
  send(res, status, body, { 'Content-Type': 'text/plain; charset=utf-8' });
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'Method not allowed' });
}
