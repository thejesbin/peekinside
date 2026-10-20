/**
 * JSON for values the app hands over without knowing their size or shape: report()'s `extra`, and
 * thrown values that aren't errors.
 *
 * JSON.stringify would throw on cycles and BigInts, run getters that throw, and serialize a huge
 * object in full before anything could be cut. This writer stops once it has produced enough
 * text, marks cycles, and skips what can't be read, so it never throws and never does more work
 * than the limit allows.
 */

const MAX_DEPTH = 20;

/**
 * Bounded, never-throwing JSON serialization.
 */
export class SafeJson {
  /**
   * Serializes a value, stopping after `maxLength` characters.
   *
   * @param {*} value
   * @param {number} maxLength - Characters produced at most (the result can be cut mid-value)
   * @returns {{ json: string|undefined, truncated: boolean }} `json` is undefined for values JSON
   *   has no form for (undefined, functions, symbols); when `truncated`, it is the cut text, not
   *   valid JSON
   */
  static stringify(value, maxLength) {
    try {
      const writer = new Writer(maxLength);
      const written = writer.value(value, []);
      if (!written) return { json: undefined, truncated: false };
      return { json: writer.text(), truncated: writer.full };
    } catch (error) {
      // Every read is guarded already; this is the last line of defense.
      return { json: '"[unserializable]"', truncated: false };
    }
  }
}

/**
 * Writes JSON text into a bounded buffer. Once full, everything else is skipped, so the work
 * stops where the output does.
 */
class Writer {
  /**
   * @param {number} maxLength - Characters kept at most
   */
  constructor(maxLength) {
    this.maxLength = maxLength;
    this.parts = [];
    this.length = 0;
    this.full = false;
  }

  text() {
    return this.parts.join('').slice(0, this.maxLength);
  }

  push(text) {
    if (this.full) return;
    this.parts.push(text);
    this.length += text.length;
    if (this.length > this.maxLength) this.full = true;
  }

  // Writes one value; returns false when it has no JSON form (and nothing was written).
  value(value, ancestors) {
    if (this.full) return true;
    let current = value;

    if (current !== null && typeof current === 'object' && typeof safeGet(current, 'toJSON') === 'function') {
      try {
        current = current.toJSON();
      } catch (error) {
        current = String(safeGet(current, 'message') ?? '[unserializable]');
      }
    }

    switch (typeof current) {
      case 'string':
        this.push(JSON.stringify(current));
        return true;
      case 'number':
        this.push(Number.isFinite(current) ? String(current) : 'null');
        return true;
      case 'boolean':
        this.push(current ? 'true' : 'false');
        return true;
      case 'bigint':
        this.push(JSON.stringify(current.toString()));
        return true;
      case 'undefined':
      case 'function':
      case 'symbol':
        return false;
      default:
        break;
    }

    if (current === null) {
      this.push('null');
      return true;
    }
    if (ancestors.includes(current)) {
      this.push('"[Circular]"');
      return true;
    }
    if (ancestors.length >= MAX_DEPTH) {
      this.push('"[Too deep]"');
      return true;
    }

    ancestors.push(current);
    try {
      if (Array.isArray(current)) this.array(current, ancestors);
      else this.object(current, ancestors);
    } finally {
      ancestors.pop();
    }
    return true;
  }

  array(items, ancestors) {
    this.push('[');
    for (let i = 0; i < items.length && !this.full; i++) {
      if (i > 0) this.push(',');
      let item;
      try {
        item = items[i];
      } catch (error) {
        item = undefined;
      }
      if (!this.value(item, ancestors)) this.push('null');
    }
    this.push(']');
  }

  object(source, ancestors) {
    // Errors keep their name, message and stack, which JSON.stringify would drop (they aren't
    // enumerable).
    const isError = isNativeError(source);
    let keys;
    try {
      keys = Object.keys(source);
    } catch (error) {
      keys = [];
    }
    if (isError) keys = ['name', 'message', 'stack', ...keys.filter((key) => key !== 'name' && key !== 'message' && key !== 'stack')];

    this.push('{');
    let first = true;
    for (const key of keys) {
      if (this.full) break;
      const item = safeGet(source, key);
      const mark = this.parts.length;
      const length = this.length;
      this.push(`${first ? '' : ','}${JSON.stringify(key)}:`);
      if (this.value(item, ancestors)) {
        first = false;
      } else {
        // No JSON form: drop the key again, as JSON.stringify does.
        this.parts.length = mark;
        this.length = length;
        this.full = this.length > this.maxLength;
      }
    }
    this.push('}');
  }
}

// instanceof runs the getPrototypeOf trap of a proxy, which may throw.
function isNativeError(value) {
  try {
    return value instanceof Error;
  } catch (error) {
    return false;
  }
}

// Reads a property, treating getters that throw (and revoked proxies) as missing.
function safeGet(target, key) {
  try {
    return target[key];
  } catch (error) {
    return undefined;
  }
}
