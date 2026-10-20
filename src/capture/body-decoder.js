/**
 * Turns captured body bytes into what the dashboard shows: decompressed, and as text when the
 * body is text, or only its size when it is binary.
 *
 * Also turns a body that a framework parsed before PeekInside could see the bytes into text,
 * from the parsed value.
 */

import zlib from 'zlib';
import { BodyCapture } from './body-capture.js';
import { headerValue } from './http-message.js';

const TEXTUAL_TYPE = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|x-ndjson|csv|yaml|x-yaml|toml)\b)|\+(json|xml)\b|^image\/svg\+xml/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-gzip|x-tar|wasm|x-protobuf|protobuf|grpc|vnd\.ms-|vnd\.openxmlformats)/i;

/**
 * @typedef {Object} BodyContent
 * @property {string} text - The body as text; empty for binary or missing bodies
 * @property {number} size - Full body size in bytes, as sent
 * @property {boolean} truncated - Whether `text` holds only the start of the body
 * @property {'none'|'utf8'|'binary'|'unavailable'} encoding - "unavailable" when the body was
 *   never read by the app, so there was nothing to capture
 */

/**
 * The content of an absent body.
 *
 * @type {Readonly<BodyContent>}
 */
export const EMPTY_BODY = Object.freeze({ text: '', size: 0, truncated: false, encoding: 'none' });

/**
 * Decodes captured bodies, keeping at most `limit` bytes of text.
 */
export class BodyDecoder {
  /**
   * @param {number} limit - Most bytes of text kept per body, after decompression
   */
  constructor(limit) {
    this.limit = limit;
  }

  /**
   * Decodes captured bytes: decompressed per Content-Encoding, then kept as text unless they are
   * binary.
   *
   * @param {BodyCapture|null} capture - Captured body
   * @param {Object} headers - Headers of the same message, with lowercase names
   * @returns {BodyContent}
   */
  decode(capture, headers) {
    if (!capture || capture.size === 0) {
      return EMPTY_BODY;
    }

    let buffer = capture.buffer();
    let truncated = capture.truncated;
    let trustContentType = true;

    const contentEncoding = String(headerValue(headers, 'content-encoding') || '').trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      const decoded = this._decompress(buffer, contentEncoding);
      if (decoded) {
        buffer = decoded.buffer;
        truncated = truncated || decoded.truncated;
      } else {
        // Not decodable (or already decoded by middleware below us): judge by content
        trustContentType = false;
      }
    }

    const contentType = String(headerValue(headers, 'content-type') || '');
    if (!BodyDecoder.isTextual(contentType, buffer, trustContentType)) {
      return { text: '', size: capture.size, truncated, encoding: 'binary' };
    }
    return { text: buffer.toString('utf8'), size: capture.size, truncated, encoding: 'utf8' };
  }

  /**
   * Content of a body known only from the value a framework parsed it into, because the app read
   * the bytes before PeekInside was tracking the request.
   *
   * @param {*} value - Parsed body: an object, a string, a Buffer, or undefined when never read
   * @param {Object} headers - Request headers
   * @returns {BodyContent} Objects are shown as JSON; the size is Content-Length when known
   */
  decodeValue(value, headers) {
    const declared = Number(headers['content-length']) || 0;

    if (value === undefined || value === null) {
      // The application never read the body, so there was nothing to capture.
      return { text: '', size: declared, truncated: false, encoding: 'unavailable' };
    }
    if (Buffer.isBuffer(value)) {
      const capture = new BodyCapture(this.limit);
      capture.push(value);
      return this.decode(capture, headers);
    }

    let text;
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch (error) {
        text = String(value);
      }
    }

    const bytes = Buffer.byteLength(text);
    const truncated = bytes > this.limit;
    return {
      text: truncated ? Buffer.from(text).subarray(0, this.limit).toString('utf8') : text,
      size: declared || bytes,
      truncated,
      encoding: 'utf8'
    };
  }

  /**
   * Whether a body is text: by its Content-Type when that is trusted and conclusive, otherwise by
   * looking at the bytes.
   *
   * @param {string} contentType
   * @param {Buffer} buffer - The body, decompressed
   * @param {boolean} [trustContentType=true] - False when the bytes may not match the headers
   * @returns {boolean}
   */
  static isTextual(contentType, buffer, trustContentType = true) {
    if (trustContentType && contentType) {
      if (TEXTUAL_TYPE.test(contentType)) return true;
      if (BINARY_TYPE.test(contentType)) return false;
    }
    return BodyDecoder.looksLikeText(buffer);
  }

  /**
   * Heuristic for bodies without a conclusive Content-Type: text has no NUL bytes and few control
   * characters in its first 2 KB.
   *
   * @param {Buffer} buffer
   * @returns {boolean}
   */
  static looksLikeText(buffer) {
    const length = Math.min(buffer.length, 2048);
    let suspicious = 0;
    for (let i = 0; i < length; i++) {
      const byte = buffer[i];
      if (byte === 0) return false;
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
    }
    return suspicious <= length * 0.05;
  }

  // Decompresses gzip, deflate (zlib or raw) and brotli. Output is capped, so a small compressed
  // body can't expand into gigabytes in the app's memory (a "zip bomb"), and a body cut off at
  // the capture limit still yields the part that was captured (sync flush, not finish).
  // Returns null when the body can't be decoded.
  _decompress(buffer, encoding) {
    const limit = this.limit;
    const maxOutputLength = Math.max(limit * 16, 1024 * 1024);
    const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength };

    try {
      let output;
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        output = zlib.gunzipSync(buffer, options);
      } else if (encoding === 'deflate') {
        try {
          output = zlib.inflateSync(buffer, options);
        } catch (error) {
          output = zlib.inflateRawSync(buffer, options);
        }
      } else if (encoding === 'br') {
        output = zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH, maxOutputLength });
      } else {
        return null;
      }

      return output.length > limit
        ? { buffer: output.subarray(0, limit), truncated: true }
        : { buffer: output, truncated: false };
    } catch (error) {
      return null;
    }
  }
}
