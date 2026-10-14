/**
 * Talking to the local hub from apps and the CLI: health checks, starting it in the background
 * and sending JSON. Connects to 127.0.0.1 directly, so "localhost" resolving to IPv6 first
 * never matters.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { HUB_API_VERSION, HUB_APP_ID, VERSION, settings } from '../config.js';

const HUB_ENTRY = fileURLToPath(new URL('./entry.js', import.meta.url));

/**
 * A failed hub request.
 *
 * `code` tells failures apart: a Node network code such as ECONNREFUSED (nothing listens),
 * HUB_ERROR (the hub answered with an error) or NOT_HUB (another program answered).
 */
export class HubError extends Error {
  /**
   * @param {string} message
   * @param {Object} [details]
   * @param {number} [details.status=0] - HTTP status, when there was an answer
   * @param {string} [details.code=''] - Failure code
   */
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Client of the hub on one port.
 */
export class HubClient {
  /**
   * @param {number} [port] - Hub port (default: PEEKINSIDE_HUB_PORT or 7335)
   * @param {Object} [options]
   * @param {boolean} [options.keepAlive=false] - Reuse connections, for apps that send batches
   *   all day long. Call close() when done.
   */
  constructor(port = settings.hubPort(), { keepAlive = false } = {}) {
    this.port = port;
    // Batches are sent one at a time, so two sockets are plenty.
    this.agent = keepAlive ? new http.Agent({ keepAlive: true, maxSockets: 2 }) : undefined;
  }

  /**
   * Address of the hub's dashboard, as shown to people.
   *
   * @type {string}
   */
  get url() {
    return settings.hubUrl(this.port);
  }

  /**
   * Sends a JSON request to the hub.
   *
   * @param {string} method
   * @param {string} pathname
   * @param {Object} [options]
   * @param {*} [options.body] - Sent as JSON
   * @param {number} [options.timeout=5000] - Milliseconds without activity before giving up
   * @returns {Promise<Object>} Parsed response body; rejects with HubError for non-2xx answers,
   *   answers that are not JSON (code NOT_HUB) and network errors
   */
  request(method, pathname, { body, timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      // The hub accepts ingest only with this header, which browsers can't send cross-site
      // without a preflight the hub never answers.
      const headers = { 'x-peekinside-sdk': VERSION || 'dev', accept: 'application/json' };
      if (payload !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }

      const req = http.request({ host: '127.0.0.1', port: this.port, method, path: pathname, headers, agent: this.agent, timeout }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            parsed = null;
          }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed) return resolve(parsed);
          const message = (parsed && parsed.error) || `HTTP ${res.statusCode}`;
          reject(new HubError(message, { status: res.statusCode, code: parsed ? 'HUB_ERROR' : 'NOT_HUB' }));
        });
        res.on('error', (error) => reject(new HubError(error.message, { code: error.code })));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', (error) => reject(new HubError(error.message, { code: error.code })));
      req.end(payload === null ? undefined : payload);
    });
  }

  /**
   * Checks whether the hub runs.
   *
   * @param {number} [timeout=2000]
   * @returns {Promise<Object|null>} The hub's status, or null when nothing listens on the port.
   *   Rejects with code NOT_HUB when another program uses the port.
   */
  async status(timeout = 2000) {
    try {
      const status = await this.request('GET', '/api/status', { timeout });
      if (status.app !== HUB_APP_ID) throw new HubError('Another program uses this port', { code: 'NOT_HUB' });
      return status;
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return null;
      if (error.code === 'HUB_ERROR' || error.code === 'NOT_HUB') {
        throw new HubError(`Port ${this.port} is used by another program`, { code: 'NOT_HUB' });
      }
      throw error;
    }
  }

  /**
   * Starts the hub as a background process that outlives this one. Its output goes to hub.log
   * in the data folder.
   *
   * @returns {void}
   */
  spawn() {
    const dir = settings.dataDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(dir, 'hub.log'), 'a', 0o600);

    // NODE_OPTIONS may hold loaders or --inspect flags meant for the app, not for the hub.
    const env = { ...process.env, PEEKINSIDE_HUB_PORT: String(this.port) };
    delete env.NODE_OPTIONS;

    try {
      const child = spawn(process.execPath, [HUB_ENTRY], {
        detached: true,
        stdio: ['ignore', log, log],
        env,
        windowsHide: true
      });
      child.on('error', () => {});
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }

  /**
   * Replaces a running hub from an older PeekInside with this version's. Hubs outlive the apps
   * that start them, so after an upgrade the old one would keep serving, its dashboard page
   * included. Only a hub with the same API and data folder is replaced, so its data stays, and
   * only the process hub.json names, so nothing else listening on the port is ever stopped.
   *
   * @returns {Promise<string|null>} The version that was replaced, or null when none was
   */
  async replaceIfOlder() {
    const running = await this.status().catch(() => null);
    const dataDir = settings.dataDir();
    if (!HubClient.shouldReplace(running, { version: VERSION, dataDir, infoPid: readInfoPid(dataDir) })) return null;
    try {
      process.kill(running.pid, 'SIGTERM');
    } catch (error) {
      return null;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!(await this.status().catch(() => null))) {
        this.spawn();
        await this.waitUntilReady(8000).catch(() => null);
        return running.version;
      }
    }
    return null;
  }

  /**
   * Whether a running hub is an older version than this one that may be replaced: same API, same
   * data folder, and the process its hub.json names.
   *
   * @param {Object|null} running - Its GET /api/status
   * @param {{ version: string, dataDir: string, infoPid: number|null }} self - This version, its
   *   data folder, and the pid in that folder's hub.json
   * @returns {boolean}
   */
  static shouldReplace(running, { version, dataDir, infoPid }) {
    if (!running || running.apiVersion !== HUB_API_VERSION) return false;
    if (!Number.isInteger(running.pid) || running.pid !== infoPid || running.pid === process.pid) return false;
    if (typeof running.dataDir !== 'string' || path.resolve(running.dataDir) !== path.resolve(dataDir)) return false;
    return compareVersions(running.version, version) < 0;
  }

  /**
   * Waits until the hub answers.
   *
   * @param {number} [timeout=5000] - Milliseconds to wait
   * @returns {Promise<Object|null>} The hub's status, or null when it did not answer in time.
   *   Rejects with code NOT_HUB when another program uses the port.
   */
  async waitUntilReady(timeout = 5000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const status = await this.status().catch((error) => {
        if (error.code === 'NOT_HUB') throw error;
        return null;
      });
      if (status) return status;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Closes kept-alive connections.
   *
   * @returns {void}
   */
  close() {
    if (this.agent) this.agent.destroy();
  }
}

// The pid in the data folder's hub.json (written by the hub that runs), or null.
function readInfoPid(dataDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'hub.json'), 'utf8'));
    return Number.isInteger(info.pid) ? info.pid : null;
  } catch (error) {
    return null;
  }
}

/**
 * Compares two versions by major, minor and patch ("1.10.0" is after "1.9.3"). Anything after the
 * patch number (a prerelease) is ignored, and versions that can't be read compare as equal, so
 * nothing is replaced on a guess.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is older, positive when newer, 0 otherwise
 */
export function compareVersions(a, b) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference;
  }
  return 0;
}
