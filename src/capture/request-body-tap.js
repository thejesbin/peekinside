/**
 * Captures a request body as the app reads it.
 *
 * Reading stays the app's business: adding a 'data' listener would switch the stream into
 * flowing mode, so data could flow before the app's body parser is ready for it. Wrapping
 * emit() instead shows PeekInside every chunk the app receives, whichever middleware reads it
 * and whenever, so middleware order does not matter.
 */

import { BodyCapture } from './body-capture.js';

/**
 * Observes the 'data' events of one request.
 */
export class RequestBodyTap {
  /**
   * Starts observing `req`.
   *
   * @param {import('http').IncomingMessage} req
   * @param {number} limit - Most bytes kept
   */
  constructor(req, limit) {
    /**
     * Bytes the app has read so far
     * @type {BodyCapture}
     */
    this.body = new BodyCapture(limit);

    if (typeof req.emit === 'function') {
      const body = this.body;
      const originalEmit = req.emit;
      req.emit = function (event, chunk) {
        if (event === 'data') {
          body.push(chunk);
        }
        return originalEmit.apply(this, arguments);
      };
    }
  }
}
