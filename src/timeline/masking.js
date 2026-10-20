/**
 * Masking of the values the timeline records: query parameters, MongoDB and Prisma arguments,
 * outgoing URLs. Masking happens when the value is captured, so a masked value never leaves the
 * process, not even encrypted.
 *
 * Two rules decide what is masked:
 * - names: a value under a sensitive name (a password column, an `apiKey` field, a `token` query
 *   parameter) whatever it holds;
 * - shapes: a string that looks like a secret whatever its name: a JWT, a password hash.
 *
 * Then every value is made small and JSON-safe: long strings are cut, binary data and large
 * objects are described rather than kept.
 */

import { types } from 'util';

// The same family of names the dashboard masks in headers.
const SENSITIVE_NAME = /passw|secret|token|api[-_]?key|session|authorization|cookie|credential|private[-_]?key|cvv|ssn|card[-_]?number/i;
// header.payload.signature (the signature is empty for unsigned tokens)
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
// bcrypt ($2a$, $2b$, $2y$), argon2 ($argon2id$...), scrypt
const PASSWORD_HASH = /^\$(?:2[aby]\$|argon2|scrypt\$)/;

export const MASKED = '[masked]';
const MAX_STRING = 256;
const MAX_JSON = 1024;
const MAX_URL = 2048;
const MAX_DEPTH = 8;
// Objects with more nodes than this are only measured, not copied.
const MAX_NODES = 1000;
const TOO_BIG = Symbol('tooBig');

/**
 * Masking and size rules for captured values.
 */
export class Masker {
  /**
   * @param {string} name - A column, field, key or query parameter name
   * @returns {boolean} Whether values under this name are masked
   */
  static isSensitiveName(name) {
    return typeof name === 'string' && SENSITIVE_NAME.test(name);
  }

  /**
   * @param {*} value
   * @returns {boolean} Whether the value is a string that looks like a secret (a JWT, a password
   *   hash)
   */
  static isSecretString(value) {
    return typeof value === 'string' && value.length >= 10 && (JWT.test(value) || PASSWORD_HASH.test(value));
  }

  /**
   * SQL parameters, masked: values bound to sensitive columns, and secret-looking strings.
   *
   * @param {Array} values - As the app passed them
   * @param {Set<number>} sensitive - Indexes bound to sensitive columns (see SqlText)
   * @param {number} [max=50] - Values kept
   * @returns {Array}
   */
  static sqlParams(values, sensitive, max = 50) {
    const out = [];
    const count = Math.min(values.length, max);
    for (let i = 0; i < count; i++) {
      out.push(sensitive.has(i) ? MASKED : Masker.value(values[i]));
    }
    return out;
  }

  /**
   * The fields of an object (MongoDB command fields, Prisma arguments, named SQL parameters),
   * masked by name at any depth. Each field follows the value rules on its own, so one large field
   * doesn't hide the others.
   *
   * @param {Object} fields
   * @param {number} [max=50] - Fields kept
   * @returns {Object}
   */
  static fields(fields, max = 50) {
    const out = {};
    let count = 0;
    for (const key of safeKeys(fields)) {
      if (count++ >= max) break;
      define(out, key, SENSITIVE_NAME.test(key) ? MASKED : Masker.value(safeGet(fields, key)));
    }
    return out;
  }

  /**
   * One value, after the rules: strings over 256 characters are cut, secret-looking strings are
   * masked, binary data becomes "<binary N bytes>", Dates ISO strings, bigints strings, functions
   * and symbols "<function>"/"<symbol>", undefined null; objects and arrays (with sensitive keys
   * masked at any depth) are kept when their JSON is 1 KB or less, else "<json 3.2 KB>".
   *
   * @param {*} value
   * @returns {*} JSON-safe
   */
  static value(value) {
    if (value === null || typeof value !== 'object' || isBinary(value) || types.isDate(value)) {
      return leaf(value);
    }
    const state = { nodes: 0 };
    const masked = deep(value, 0, state, []);
    if (masked === TOO_BIG) return describeJson(jsonSize(value));
    if (masked !== null && typeof masked === 'object') {
      const size = Buffer.byteLength(JSON.stringify(masked));
      if (size > MAX_JSON) return describeJson(size);
    }
    return masked;
  }

  /**
   * An outgoing URL, safe to keep: without credentials, with the values of sensitive query
   * parameters (and secret-looking values) masked, at most 2048 characters.
   *
   * @param {string} url
   * @returns {string}
   */
  static url(url) {
    let text = String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
    const query = text.indexOf('?');
    if (query !== -1) {
      const hash = text.indexOf('#', query);
      const end = hash === -1 ? text.length : hash;
      const masked = text.slice(query + 1, end).split('&').map((part) => {
        const equals = part.indexOf('=');
        if (equals === -1) return part;
        const key = part.slice(0, equals);
        const value = part.slice(equals + 1);
        return SENSITIVE_NAME.test(decode(key)) || Masker.isSecretString(decode(value)) ? `${key}=${MASKED}` : part;
      }).join('&');
      text = `${text.slice(0, query + 1)}${masked}${text.slice(end)}`;
    }
    return text.length > MAX_URL ? text.slice(0, MAX_URL) : text;
  }
}

function leaf(value) {
  switch (typeof value) {
    case 'string':
      if (Masker.isSecretString(value)) return MASKED;
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
      return '<function>';
    case 'symbol':
      return '<symbol>';
    case 'undefined':
      return null;
    default:
      break;
  }
  if (value === null) return null;
  if (isBinary(value)) return `<binary ${byteLength(value)} bytes>`;
  if (types.isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    return Number.isNaN(time) ? null : Date.prototype.toISOString.call(value);
  }
  return value;
}

// Copies an object or array with sensitive keys masked and every leaf after the rules. Returns
// TOO_BIG past MAX_NODES nodes: such a value ends up described by its size anyway.
function deep(value, depth, state, ancestors) {
  if (value === null || typeof value !== 'object' || isBinary(value) || types.isDate(value)) return leaf(value);
  if (++state.nodes > MAX_NODES) return TOO_BIG;
  if (depth >= MAX_DEPTH || ancestors.includes(value)) return '…';

  // Driver types (ObjectId, Decimal128, Prisma's Decimal) say what they are through toJSON(), as
  // JSON.stringify would ask them.
  if (!Array.isArray(value)) {
    const toJSON = safeGet(value, 'toJSON');
    if (typeof toJSON === 'function') {
      let json;
      try {
        json = toJSON.call(value);
      } catch (error) {
        return '<object>';
      }
      if (json !== value) return deep(json, depth, state, ancestors);
    }
  }

  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const item = deep(safeGet(value, i), depth + 1, state, ancestors);
        if (item === TOO_BIG) return TOO_BIG;
        out.push(item);
      }
      return out;
    }
    const out = {};
    for (const key of safeKeys(value)) {
      if (SENSITIVE_NAME.test(key)) {
        define(out, key, MASKED);
        continue;
      }
      const item = deep(safeGet(value, key), depth + 1, state, ancestors);
      if (item === TOO_BIG) return TOO_BIG;
      define(out, key, item);
    }
    return out;
  } finally {
    ancestors.pop();
  }
}

function describeJson(bytes) {
  return `<json ${(bytes / 1024).toFixed(1)} KB>`;
}

// The JSON size of a value too large to copy. Values JSON can't serialize count as large.
function jsonSize(value) {
  try {
    const json = JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? item.toString() : item));
    return json === undefined ? 0 : Buffer.byteLength(json);
  } catch (error) {
    return MAX_JSON + 1;
  }
}

function isBinary(value) {
  return value !== null && typeof value === 'object' && (types.isAnyArrayBuffer(value) || ArrayBuffer.isView(value));
}

function byteLength(value) {
  return typeof value.byteLength === 'number' ? value.byteLength : 0;
}

function safeKeys(value) {
  try {
    return Object.keys(value);
  } catch (error) {
    return [];
  }
}

function safeGet(target, key) {
  try {
    return target[key];
  } catch (error) {
    return undefined;
  }
}

// Keys from the app's data (and from the network) may be "__proto__".
function define(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch (error) {
    return text;
  }
}
