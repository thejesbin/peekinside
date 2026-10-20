/**
 * The stored form of a captured exchange, shared by the local hub and PeekInside Cloud:
 * a few plain numbers for lists, charts and filters, a small summary for the request list,
 * and the full detail, which the dashboard only loads when someone opens the request.
 */

const METHOD = /^[A-Z]{1,16}$/;
// Exceptions listed in a request's detail, so the inspector can link to them.
const MAX_EXCEPTION_LINKS = 10;

/**
 * One captured exchange, in the shape both destinations store.
 *
 * The local hub receives the plain form (toJSON()). PeekInside Cloud receives the sealed form
 * (seal()): the numbers stay readable for charts and filters, while the summary and the detail
 * are encrypted so that only the project's browsers can read them.
 */
export class RequestRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - Request id
   * @param {number} fields.occurredAt - When the request started (ms since the epoch)
   * @param {string} fields.environment - Normalized environment label
   * @param {string|null} [fields.release=null] - The running release (see release.js)
   * @param {string} fields.method - HTTP method, or "OTHER" when it isn't a plain token
   * @param {number|null} fields.status - Status code, or null when no response was sent
   * @param {number|null} fields.duration - Response time in ms
   * @param {number} fields.requestSize - Request body size in bytes
   * @param {number} fields.responseSize - Response body size in bytes
   * @param {boolean} fields.aborted - Whether the connection closed before the response was sent
   * @param {number} [fields.exceptionCount=0] - Exceptions recorded during the request (detail.exceptions
   *   lists the first of them)
   * @param {Object} [fields.stats] - Timeline counters: queries, queryTime, slowQueries, nPlusOne,
   *   duplicates, http, httpTime, logs (detail.timeline holds the spans); absent when the timeline is off
   * @param {{ url: string, path: string, contentType: string, route?: string, handler?: string, user?: Object }} fields.summary -
   *   Shown in the request list: with the route pattern and the handler when the framework says
   *   (NestJS, Hono, Fastify), and the user when the app set one
   * @param {Object} fields.detail - Everything else: headers, bodies, query, client details
   */
  constructor({ id, occurredAt, environment, release = null, method, status, duration, requestSize, responseSize, aborted, exceptionCount = 0, stats, summary, detail }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.method = method;
    this.status = status;
    this.duration = duration;
    this.requestSize = requestSize;
    this.responseSize = responseSize;
    this.aborted = aborted;
    this.exceptionCount = exceptionCount;
    if (stats) this.stats = stats;
    this.summary = summary;
    this.detail = detail;
  }

  /**
   * Builds the record of an exchange. Values that would break lists or charts (a method that
   * isn't a token, a status outside 100-599, negative sizes) are replaced rather than stored.
   *
   * @param {import('./capture/exchange-recorder.js').Exchange} exchange - Exchange built by PeekInside
   * @param {string} environment - Normalized environment label
   * @param {string|null} [release=null] - The running release
   * @returns {RequestRecord}
   */
  static fromExchange(exchange, environment, release = null) {
    const response = exchange.response || {};
    const status = response.statusCode;

    return new RequestRecord({
      id: exchange.id,
      occurredAt: exchange.timestamp,
      environment,
      release,
      method: METHOD.test(exchange.method) ? exchange.method : 'OTHER',
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      duration: typeof response.responseTime === 'number' && response.responseTime >= 0 ? response.responseTime : null,
      requestSize: size(exchange.bodySize),
      responseSize: size(response.size),
      aborted: Boolean(response.aborted),
      exceptionCount: size(exchange.exceptionCount),
      stats: exchange.stats && typeof exchange.stats === 'object' ? exchange.stats : undefined,
      summary: {
        url: exchange.url,
        path: exchange.path,
        contentType: headerValue(response.headers, 'content-type'),
        ...(exchange.route ? { route: exchange.route } : {}),
        ...(exchange.handler ? { handler: exchange.handler } : {}),
        ...(exchange.user ? { user: exchange.user } : {})
      },
      detail: {
        query: exchange.query,
        params: exchange.params,
        headers: exchange.headers,
        body: exchange.body,
        bodySize: exchange.bodySize,
        bodyTruncated: exchange.bodyTruncated,
        bodyEncoding: exchange.bodyEncoding,
        ip: exchange.ip,
        userAgent: exchange.userAgent,
        protocol: exchange.protocol,
        httpVersion: exchange.httpVersion,
        response: {
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: response.body,
          size: response.size,
          bodyTruncated: response.bodyTruncated,
          bodyEncoding: response.bodyEncoding
        },
        exceptions: Array.isArray(exchange.exceptions) ? exchange.exceptions.slice(0, MAX_EXCEPTION_LINKS) : [],
        ...(Array.isArray(exchange.dumps) && exchange.dumps.length ? { dumps: exchange.dumps } : {}),
        ...(exchange.timeline ? { timeline: exchange.timeline } : {})
      }
    });
  }

  /**
   * Turns an environment label into the form records store: lowercase letters, digits, "-" and
   * "_", at most 32 characters. Dashboards group and filter by it, so "Staging " and "staging"
   * must be the same label.
   *
   * @param {*} value - Label chosen by the app
   * @param {string} fallback - Label used when nothing usable remains
   * @returns {string}
   */
  static normalizeEnvironment(value, fallback) {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 32);
    return normalized || fallback;
  }

  /**
   * The plain form, as the local hub stores it. Also used by JSON.stringify().
   *
   * @returns {Object}
   */
  toJSON() {
    return { ...this };
  }

  /**
   * The sealed form, as PeekInside Cloud stores it: the numbers stay readable for charts and
   * filters, while the summary and the detail are encrypted to the project's public key. Each is
   * bound to the request id, so they can't be swapped between requests.
   *
   * @param {import('./crypto.js').Sealer} sealer - Sealer for the batch this record is sent in
   * @returns {Promise<Object>} The record, with `summary` and `detail` as sealed strings
   */
  async seal(sealer) {
    const { summary, detail, ...meta } = this;
    return {
      ...meta,
      summary: await sealer.seal(JSON.stringify(summary), `summary:${meta.id}`),
      detail: await sealer.seal(JSON.stringify(detail), `detail:${meta.id}`)
    };
  }

  /**
   * seal() for a process that is crashing, where nothing asynchronous runs anymore.
   *
   * @param {import('./crypto.js').SyncSealer} sealer
   * @returns {Object}
   */
  sealSync(sealer) {
    const { summary, detail, ...meta } = this;
    return {
      ...meta,
      summary: sealer.seal(JSON.stringify(summary), `summary:${meta.id}`),
      detail: sealer.seal(JSON.stringify(detail), `detail:${meta.id}`)
    };
  }
}

function headerValue(headers, name) {
  const value = headers && headers[name];
  return Array.isArray(value) ? String(value[0]) : value === undefined ? '' : String(value);
}

function size(value) {
  return Number.isInteger(value) && value >= 0 && value < 2 ** 31 ? value : 0;
}
