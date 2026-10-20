/**
 * Captures a response as the app sends it: the body passed to write() and end(), and the headers
 * passed directly to writeHead(), which res.getHeaders() does not report.
 */

import { BodyCapture } from './body-capture.js';
import { mergeHeaders, normalizeHeaders } from './http-message.js';

/**
 * Wraps the write methods of one response.
 *
 * The originals are always called with the same arguments and their results returned, so the
 * response behaves exactly as without PeekInside.
 */
export class ResponseTap {
  /**
   * Starts observing `res`.
   *
   * @param {import('http').ServerResponse} res
   * @param {number} limit - Most body bytes kept
   */
  constructor(res, limit) {
    /**
     * Bytes the app has written so far
     * @type {BodyCapture}
     */
    this.body = new BodyCapture(limit);
    this._res = res;
    this._explicitHeaders = null;

    this._tapBody(res);
    this._tapWriteHead(res);
  }

  /**
   * Response headers: those set with setHeader(), plus those passed to writeHead().
   *
   * @returns {Object<string, string|string[]|number>} Lowercase names
   */
  headers() {
    const res = this._res;
    const current = typeof res.getHeaders === 'function' ? res.getHeaders() : {};
    return mergeHeaders(current, this._explicitHeaders);
  }

  // Writes after end(), including a second end(), send nothing, so they are not part of the body.
  _tapBody(res) {
    const body = this.body;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function (chunk, encoding) {
      if (!res.writableEnded) {
        body.push(chunk, encoding);
      }
      return originalWrite.apply(this, arguments);
    };

    res.end = function (chunk, encoding) {
      if (!res.writableEnded) {
        body.push(chunk, encoding);
      }
      return originalEnd.apply(this, arguments);
    };
  }

  // writeHead(status, [reason], [headers]): headers may be an object or a flat or nested array.
  _tapWriteHead(res) {
    const tap = this;
    const originalWriteHead = res.writeHead;
    if (typeof originalWriteHead !== 'function') {
      return;
    }

    res.writeHead = function (statusCode, reason, headers) {
      const provided = reason !== null && typeof reason === 'object' ? reason : headers;
      if (provided) {
        tap._explicitHeaders = mergeHeaders(tap._explicitHeaders, normalizeHeaders(provided));
      }
      return originalWriteHead.apply(this, arguments);
    };
  }
}
