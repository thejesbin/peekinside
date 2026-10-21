/**
 * Replays a stored request: sends it to its app again, as it was received (method, target,
 * headers and body), with the headers that make the SDK record it as a replay of the original
 * (see capture/replay.js). The dashboard then opens the new record next to the original.
 *
 * Only to this machine: the port comes from the app's running process (or from the request's
 * Host, when that names this machine), and the connection goes to the loopback address, never to
 * the host the request names. A request whose body PeekInside didn't keep in full isn't sent:
 * replaying part of a body would test something else.
 */

import http from 'http';
import https from 'https';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { REPLAY_ID_HEADER, REPLAY_OF_HEADER } from '../capture/replay.js';

export const DEFAULT_REPLAY_TIMEOUT_MS = 60_000;

// They describe the connection or the bytes as they were sent: Node writes its own for the new
// request, and the body goes out as it was stored, decompressed.
const DROPPED_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'expect', 'content-length', 'content-encoding', 'http2-settings'
]);
const METHOD = /^[A-Z]{1,16}$/;
const ABSOLUTE_TARGET = /^[a-z][a-z\d+.-]*:\/\//i;
const LOOPBACK_HOST = /^(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const IP_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
const FORM = /^application\/x-www-form-urlencoded\b/i;

/** Why a request wasn't replayed, with the status the hub answers with. */
export class ReplayError extends Error {
  /**
   * @param {string} message - Shown in the dashboard
   * @param {number} status - 409: it can't be replayed; 502 and 504: the app didn't answer
   */
  constructor(message, status) {
    super(message);
    this.name = 'ReplayError';
    this.status = status;
  }
}

export class Replay {
  /**
   * Sends a stored request to its app again.
   *
   * @param {{ name: string, summary: Object, detail: Object, instances: Object[] }} source - From
   *   Store#replaySource()
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ id: string, status: number, statusMessage: string, duration: number }>} The
   *   id the replay's record takes, and the app's answer
   * @throws {ReplayError}
   */
  static async run(source, { timeoutMs = DEFAULT_REPLAY_TIMEOUT_MS } = {}) {
    const request = Replay.build(source);
    const port = Replay.port(source.instances, request.headers.host, request.protocol);
    if (!port) throw new ReplayError(`${source.name} isn't running: start it, then replay the request.`, 409);

    const id = randomUUID();
    request.headers[REPLAY_OF_HEADER] = source.summary.id;
    request.headers[REPLAY_ID_HEADER] = id;
    try {
      return { id, ...(await Replay.send(request, port, timeoutMs)) };
    } catch (error) {
      if (error.code === 'ETIMEDOUT') {
        throw new ReplayError(`${source.name} didn't answer within ${Math.round(timeoutMs / 1000)} seconds, so the replay was stopped.`, 504);
      }
      if (error.code === 'ECONNREFUSED') {
        throw new ReplayError(`Nothing answers on port ${port}: start ${source.name}, then replay the request.`, 502);
      }
      throw new ReplayError(`The replay couldn't reach ${source.name} on port ${port}: ${error.message}`, 502);
    }
  }

  /**
   * The request to send again, as it was received.
   *
   * @param {{ summary: Object, detail: Object }} stored
   * @returns {{ method: string, path: string, headers: Object, body: string|null, protocol: 'http'|'https' }}
   * @throws {ReplayError} 409 when it can't be sent as it was received
   */
  static build({ summary, detail }) {
    const method = summary.method;
    if (typeof method !== 'string' || !METHOD.test(method) || method === 'OTHER') {
      throw new ReplayError("This request's method isn't one PeekInside can send again.", 409);
    }
    if (detail.bodyEncoding === 'binary') {
      throw new ReplayError("This request's body is binary, and PeekInside keeps only text bodies, so it can't be sent again.", 409);
    }
    if (detail.bodyTruncated) {
      throw new ReplayError("This request's body was larger than what PeekInside keeps (maxBodySize), so it can't be sent again in full.", 409);
    }

    const source = detail.headers && typeof detail.headers === 'object' ? detail.headers : {};
    const headers = {};
    for (const name of Object.keys(source)) {
      const lower = name.toLowerCase();
      const value = source[name];
      if (lower.startsWith(':') || DROPPED_HEADERS.has(lower) || lower.startsWith('x-peekinside-')) continue;
      if (typeof value === 'string' || typeof value === 'number') headers[lower] = String(value);
      else if (Array.isArray(value)) headers[lower] = value.map(String);
    }
    // HTTP/2 names the host in :authority.
    if (headers.host === undefined && typeof source[':authority'] === 'string') headers.host = source[':authority'];

    // A body the app never read ("unavailable") wasn't kept, and the app didn't need it.
    const text = detail.bodyEncoding === 'utf8' && typeof detail.body === 'string' && detail.body !== '' ? detail.body : null;
    const body = text === null ? null : Replay.bodyText(text, headers['content-type']);
    if (body !== null) headers['content-length'] = String(Buffer.byteLength(body));

    return {
      method,
      path: Replay.target(String(summary.url || summary.path || '/')),
      headers,
      body,
      protocol: detail.protocol === 'https' ? 'https' : 'http'
    };
  }

  /**
   * The request target to send: as received, or its path and query when a client sent the
   * absolute form (as to proxies).
   *
   * @param {string} url
   * @returns {string}
   */
  static target(url) {
    if (ABSOLUTE_TARGET.test(url)) {
      try {
        const parsed = new URL(url);
        return parsed.pathname + parsed.search;
      } catch (error) {
        return '/';
      }
    }
    return url === '*' || url.startsWith('/') ? url : `/${url}`;
  }

  /**
   * The body to send. A form known only from what a framework parsed it into was stored as JSON
   * (see BodyDecoder#decodeValue): it goes out as the form it was.
   *
   * @param {string} text - The stored body
   * @param {string|string[]|undefined} contentType
   * @returns {string}
   */
  static bodyText(text, contentType) {
    if (!FORM.test(String(contentType || '')) || !text.startsWith('{')) return text;
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return text;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
    const form = new URLSearchParams();
    for (const [key, item] of Object.entries(value)) {
      for (const one of Array.isArray(item) ? item : [item]) {
        form.append(key, one !== null && typeof one === 'object' ? JSON.stringify(one) : String(one));
      }
    }
    return form.toString();
  }

  /**
   * The port the app listens on: its running process's (when several run, the one the request's
   * Host names, else the newest), or, with none known, the Host's own when it names this machine.
   *
   * @param {Object[]} instances - The project's running processes, newest first
   * @param {string|string[]|undefined} host - The request's Host header
   * @param {'http'|'https'} protocol
   * @returns {number|null} null when there's nowhere to send it
   */
  static port(instances, host, protocol) {
    const named = parseHost(host);
    const ports = (instances || []).map((instance) => instance.port).filter((port) => Number.isInteger(port) && port > 0);
    if (ports.length) return named && ports.includes(named.port) ? named.port : ports[0];
    if (named && LOOPBACK_HOST.test(named.hostname)) return named.port ?? (protocol === 'https' ? 443 : 80);
    return null;
  }

  /**
   * Sends the request to the app on this machine: to 127.0.0.1, then ::1 for an app that listens
   * on the IPv6 address only.
   *
   * @param {ReturnType<typeof Replay.build>} request
   * @param {number} port
   * @param {number} timeoutMs - Longest wait for the app to answer
   * @returns {Promise<{ status: number, statusMessage: string, duration: number }>}
   */
  static async send(request, port, timeoutMs) {
    try {
      return await attempt(request, '127.0.0.1', port, timeoutMs);
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return attempt(request, '::1', port, timeoutMs);
      throw error;
    }
  }
}

function attempt(request, address, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const options = { host: address, port, method: request.method, path: request.path, headers: request.headers, agent: false, timeout: timeoutMs };
    if (request.protocol === 'https') {
      // Development certificates are self-signed, and the connection never leaves this machine.
      options.rejectUnauthorized = false;
      const named = parseHost(request.headers.host);
      if (named && !IP_ADDRESS.test(named.hostname)) options.servername = named.hostname;
    }
    let req;
    try {
      req = (request.protocol === 'https' ? https : http).request(options, (res) => {
        // The SDK records the answer; the hub only needs its status.
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage || '', duration: Math.round((performance.now() - started) * 100) / 100 }));
        res.on('error', reject);
      });
    } catch (error) {
      // A header or target Node refuses to send.
      reject(error);
      return;
    }
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(request.body === null ? undefined : request.body);
  });
}

// "localhost:3000" as { hostname: "localhost", port: 3000 }; the port is null when the Host has none.
function parseHost(host) {
  const value = Array.isArray(host) ? host[0] : host;
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(`http://${value}`);
    return { hostname: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : null };
  } catch (error) {
    return null;
  }
}
