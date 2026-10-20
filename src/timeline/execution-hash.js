/**
 * Recognizes repeated executions: the same statement with the same parameters, run again in the
 * same request (the result was already there, the app asked again).
 *
 * The parameters are compared through a hash of the unmasked values, so two executions that differ
 * only in a masked value still differ, and the values themselves are never kept.
 */

import { createHash } from 'crypto';
import { types } from 'util';

const MAX_DEPTH = 10;
// Values larger than this (an insertMany of thousands of documents) aren't compared: hashing them
// would cost more than the duplicate it might reveal is worth.
const MAX_NODES = 2000;
const TOO_LARGE = new Error('too large to compare');

/**
 * Hashes executions.
 */
export class ExecutionHash {
  /**
   * @param {string} text - The statement as sent
   * @param {*} params - Its parameters, as the app passed them
   * @returns {string} A short hash: equal for equal text and parameters
   */
  static of(text, params) {
    const hash = createHash('sha1');
    hash.update(String(text));
    hash.update('\u0000');
    try {
      feed(hash, params, 0, [], { nodes: 0 });
    } catch (error) {
      // Too large, or a value that can't be read (a proxy, a throwing getter): this execution is
      // its own.
      hash.update(`\u0001${Math.random()}`);
    }
    return hash.digest('base64').slice(0, 16);
  }
}

// Writes a value into the hash with type tags, so 1 and "1" differ, and Buffers go in as bytes.
function feed(hash, value, depth, ancestors, budget) {
  if (++budget.nodes > MAX_NODES) throw TOO_LARGE;
  if (value === null || value === undefined) {
    hash.update(value === null ? 'n;' : 'u;');
    return;
  }
  switch (typeof value) {
    case 'string':
      hash.update(`s${value.length}:`);
      hash.update(value);
      return;
    case 'number':
    case 'boolean':
    case 'bigint':
      hash.update(`${typeof value}:${String(value)};`);
      return;
    case 'function':
    case 'symbol':
      hash.update(`${typeof value};`);
      return;
    default:
      break;
  }
  if (ArrayBuffer.isView(value)) {
    hash.update(`b${value.byteLength}:`);
    hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  if (types.isAnyArrayBuffer(value)) {
    hash.update(`b${value.byteLength}:`);
    hash.update(new Uint8Array(value));
    return;
  }
  if (types.isDate(value)) {
    hash.update(`d${Date.prototype.getTime.call(value)};`);
    return;
  }
  if (depth >= MAX_DEPTH || ancestors.includes(value)) {
    hash.update('…;');
    return;
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      hash.update(`a${value.length}[`);
      for (const item of value) feed(hash, item, depth + 1, ancestors, budget);
      hash.update(']');
      return;
    }
    // Driver values (ObjectId, Decimal) compare by what they serialize to.
    if (typeof value.toJSON === 'function' && Object.getPrototypeOf(value) !== Object.prototype) {
      const json = value.toJSON();
      if (json !== value) {
        hash.update('j');
        feed(hash, json, depth + 1, ancestors, budget);
        return;
      }
    }
    hash.update('o{');
    for (const key of Object.keys(value)) {
      hash.update(`${key.length}:${key}=`);
      feed(hash, value[key], depth + 1, ancestors, budget);
    }
    hash.update('}');
  } finally {
    ancestors.pop();
  }
}
