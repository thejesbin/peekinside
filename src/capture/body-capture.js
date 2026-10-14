/**
 * Bounded collection of body bytes.
 *
 * Bodies can be arbitrarily large (uploads, downloads, streams), so only the first `limit` bytes
 * are kept, while the full size is still counted: the dashboard marks a body as truncated when
 * the two differ.
 */

/**
 * Collects the bytes of one request or response body, up to a limit.
 */
export class BodyCapture {
  /**
   * @param {number} limit - Most bytes kept (maxBodySize)
   */
  constructor(limit) {
    this.limit = limit;
    this._chunks = [];
    this._captured = 0;
    this._size = 0;
  }

  /**
   * Adds a chunk as the app read or wrote it. Anything that is not body data, such as a missing
   * chunk or a callback passed in its place, is ignored.
   *
   * @param {Buffer|Uint8Array|string|*} chunk
   * @param {string} [encoding] - Encoding of a string chunk (utf8 when missing or unknown)
   * @returns {void}
   */
  push(chunk, encoding) {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') {
      return;
    }
    let buffer;
    try {
      buffer = toBuffer(chunk, encoding);
    } catch (error) {
      return;
    }
    this._size += buffer.length;
    if (this._captured >= this.limit) {
      return;
    }
    const take = Math.min(buffer.length, this.limit - this._captured);
    // A copy: the app may reuse its buffer once written, and a slice would keep all of it alive.
    this._chunks.push(Buffer.from(buffer.subarray(0, take)));
    this._captured += take;
  }

  /**
   * Full body size in bytes, including bytes beyond the limit.
   *
   * @type {number}
   */
  get size() {
    return this._size;
  }

  /**
   * Whether bytes beyond the limit were left out.
   *
   * @type {boolean}
   */
  get truncated() {
    return this._size > this._captured;
  }

  /**
   * @returns {Buffer} The bytes kept
   */
  buffer() {
    return Buffer.concat(this._chunks, this._captured);
  }
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  const charset = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
  return Buffer.from(String(chunk), charset);
}
