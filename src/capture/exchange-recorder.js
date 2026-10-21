/**
 * Records one request/response exchange: starts the clock, taps both bodies, and once the
 * response has been sent (or the connection closed first) builds the exchange object that a
 * transport turns into a stored record.
 *
 * Exceptions recorded during the request use the recorder too: its id (known from the start) and
 * a snapshot of the request as received so far.
 */

import { randomUUID } from 'crypto';
import http from 'http';
import { performance } from 'perf_hooks';
import { BodyDecoder, EMPTY_BODY } from './body-decoder.js';
import { hasBody, parseQuery, stringParams } from './http-message.js';
import { withoutReplayHeaders } from './replay.js';
import { RequestBodyTap } from './request-body-tap.js';
import { ResponseTap } from './response-tap.js';

const kBodySource = Symbol('peekInside.bodySource');

/**
 * @typedef {Object} Exchange
 * @property {string} id - Random UUID
 * @property {string} method
 * @property {string} url - Request target as received (originalUrl in Express)
 * @property {string} path - Pathname of `url`
 * @property {Object<string, string|string[]>} query
 * @property {Object<string, string>} params - Route parameters set by the framework, if any
 * @property {Object<string, string|string[]>} headers - Request headers
 * @property {string} body - Request body as text (see bodyEncoding)
 * @property {number} bodySize
 * @property {boolean} bodyTruncated
 * @property {'none'|'utf8'|'binary'|'unavailable'} bodyEncoding
 * @property {string} ip
 * @property {string} userAgent
 * @property {'http'|'https'} protocol
 * @property {string} httpVersion
 * @property {number} timestamp - When the request started (ms since the epoch)
 * @property {Object} response - statusCode (null when nothing was sent), statusMessage, headers,
 *   body, size, bodyTruncated, bodyEncoding, responseTime (ms) and aborted
 * @property {number} [exceptionCount] - Exceptions recorded during the request, added by PeekInside
 * @property {Array<{ id: string, name: string, message: string }>} [exceptions] - The first of them
 * @property {Object} [stats] - Timeline counters (queries, outgoing calls, logs), added by PeekInside
 * @property {Object} [timeline] - The request's timeline, when something was recorded on it
 * @property {string} [route] - The route pattern it matched ("/users/:id"), when the framework says
 * @property {string} [handler] - The code that handled it ("UsersController.findOne"), when known
 * @property {Array<{ id: string, label: string|null, type: string, preview: string }>} [dumps] - The
 *   dumps made during it (local dashboard only)
 * @property {string} [replayOf] - The request it sends again, when the local dashboard replayed one
 * @property {Array<{ id: string, subject: string, to: string[] }>} [mails] - The emails sent during
 *   it (local dashboard only)
 */

/**
 * Records a single exchange. Create one per request, then call start() before the app reads the
 * request body.
 */
export class ExchangeRecorder {
  /**
   * Tells the recorder where a framework keeps a request's parsed body. It is used when the app
   * read the body before tracking started (a body parser registered before PeekInside), so the
   * bytes themselves were never seen.
   *
   * @param {import('http').IncomingMessage} req
   * @param {() => *} getter - Returns the parsed body, such as Koa's ctx.request.body
   * @returns {void}
   */
  static setBodySource(req, getter) {
    req[kBodySource] = getter;
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {{ url: string, pathname: string, search: string }} target - The request target, split
   * @param {Object} options
   * @param {() => number} options.maxBodySize - Returns the current maxBodySize; it is read when
   *   the bodies are tapped and again when they are decoded, so later option changes apply
   * @param {(exchange: Exchange) => void} options.onExchange - Receives the finished exchange
   * @param {{ id: string, of: string }|null} [options.replay=null] - A replay from the local
   *   dashboard: the id its record takes, and the request it sends again (see replay.js)
   */
  constructor(req, res, { url, pathname, search }, { maxBodySize, onExchange, replay = null }) {
    this.req = req;
    this.res = res;
    this.url = url;
    this.pathname = pathname;
    this.search = search;
    this._maxBodySize = maxBodySize;
    this._onExchange = onExchange;
    this._recorded = false;

    /**
     * Id of the request record. Created now rather than when the exchange is built, so that
     * exceptions recorded during the request can refer to it.
     * @type {string}
     */
    this.id = replay ? replay.id : randomUUID();

    /**
     * The request this one sends again, when it is a replay.
     * @type {string|null}
     */
    this.replayOf = replay ? replay.of : null;
  }

  /**
   * Whether the exchange has been built (the response finished, or the connection closed).
   *
   * @type {boolean}
   */
  get recorded() {
    return this._recorded;
  }

  /**
   * Starts the clock, taps both bodies and waits for the response to finish.
   *
   * @returns {ExchangeRecorder} This recorder
   */
  start() {
    const res = this.res;
    this.startedAt = Date.now();
    // The timeline's clock: span offsets count from the same instant as occurredAt.
    this.perfStart = performance.now();
    this._start = process.hrtime.bigint();
    this._requestTap = new RequestBodyTap(this.req, this._maxBodySize());
    this._responseTap = new ResponseTap(res, this._maxBodySize());

    this._onFinish = () => this._finish(false);
    // 'close' without 'finish' means the client went away before the response was sent.
    this._onClose = () => this._finish(!res.writableFinished);
    res.on('finish', this._onFinish);
    res.on('close', this._onClose);
    return this;
  }

  /**
   * Builds the exchange as it stands now.
   *
   * @param {boolean} aborted - Whether the connection closed before the response was sent
   * @returns {Exchange}
   */
  buildExchange(aborted) {
    const { req, res } = this;
    const duration = Number(process.hrtime.bigint() - this._start) / 1e6;
    const decoder = new BodyDecoder(this._maxBodySize());
    const requestHeaders = withoutReplayHeaders({ ...req.headers });
    const responseHeaders = this._responseTap.headers();
    const requestContent = this._requestContent(decoder, requestHeaders);
    // HEAD responses never have a body, whatever the app wrote.
    const responseContent = req.method === 'HEAD'
      ? EMPTY_BODY
      : decoder.decode(this._responseTap.body, responseHeaders);
    const statusCode = aborted && !res.headersSent ? null : res.statusCode;

    return {
      id: this.id,
      method: req.method,
      url: this.url,
      path: this.pathname,
      query: parseQuery(this.search),
      params: req.params && typeof req.params === 'object' ? { ...req.params } : {},
      headers: requestHeaders,
      body: requestContent.text,
      bodySize: requestContent.size,
      bodyTruncated: requestContent.truncated,
      bodyEncoding: requestContent.encoding,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || '',
      userAgent: requestHeaders['user-agent'] || '',
      protocol: req.socket && req.socket.encrypted ? 'https' : 'http',
      httpVersion: req.httpVersion || '1.1',
      timestamp: this.startedAt,
      response: {
        statusCode,
        statusMessage: statusCode === null ? '' : (res.statusMessage || http.STATUS_CODES[statusCode] || ''),
        headers: responseHeaders,
        body: responseContent.text,
        size: responseContent.size,
        bodyTruncated: responseContent.truncated,
        bodyEncoding: responseContent.encoding,
        responseTime: Math.round(duration * 100) / 100,
        aborted: Boolean(aborted)
      },
      ...(this.replayOf ? { replayOf: this.replayOf } : {})
    };
  }

  /**
   * The request as an exception record shows it: what has been received so far, with a shorter
   * body than the request record keeps.
   *
   * @param {number} bodyLimit - Most bytes of body text
   * @returns {{ method: string, url: string, headers: Object, query: Object, params: Object,
   *   body: string, bodyTruncated: boolean, ip: string, userAgent: string }}
   */
  snapshot(bodyLimit) {
    const req = this.req;
    const headers = withoutReplayHeaders({ ...req.headers });
    const content = this._requestContent(new BodyDecoder(bodyLimit), headers);
    return {
      method: String(req.method || ''),
      url: this.url,
      headers,
      query: parseQuery(this.search),
      params: stringParams(req.params),
      body: content.encoding === 'utf8' ? content.text : '',
      bodyTruncated: content.encoding === 'utf8' && content.truncated,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || '',
      userAgent: headers['user-agent'] || ''
    };
  }

  /**
   * Builds the exchange right away, for a process that is about to exit: a response still in
   * progress is recorded as aborted. Afterwards the recorder records nothing more.
   *
   * @returns {Exchange|null} null when the exchange was already recorded
   */
  takeExchange() {
    if (this._recorded) {
      return null;
    }
    this._recorded = true;
    this.res.removeListener('finish', this._onFinish);
    this.res.removeListener('close', this._onClose);
    return this.buildExchange(!this.res.writableFinished);
  }

  // Runs once, on 'finish' or 'close', whichever comes first.
  _finish(aborted) {
    if (this._recorded) {
      return;
    }
    this._recorded = true;
    this.res.removeListener('finish', this._onFinish);
    this.res.removeListener('close', this._onClose);

    try {
      this._onExchange(this.buildExchange(aborted));
    } catch (error) {
      // Ignore: a malformed exchange must not affect the application.
    }
  }

  // The request body as the app read it, or, when the app read it before tracking started,
  // what the framework parsed it into.
  _requestContent(decoder, headers) {
    const req = this.req;
    const tapped = this._requestTap.body;
    if (tapped.size > 0) {
      return decoder.decode(tapped, headers);
    }
    if (!hasBody(headers)) {
      return EMPTY_BODY;
    }

    let parsed;
    try {
      parsed = typeof req[kBodySource] === 'function' ? req[kBodySource]() : undefined;
    } catch (error) {
      parsed = undefined;
    }
    if (parsed === undefined) {
      parsed = req.body !== undefined ? req.body : req.rawBody;
    }
    return decoder.decodeValue(parsed, headers);
  }
}
