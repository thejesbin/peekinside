/**
 * A small least-recently-used cache, for work that repeats with the same input: analyzing the
 * same SQL statement on every execution, mostly.
 */

/**
 * Map with a size bound: past `max` entries, the least recently used one goes.
 */
export class LruCache {
  /**
   * @param {number} max - Entries kept
   */
  constructor(max) {
    this.max = max;
    this._map = new Map();
  }

  /**
   * @param {*} key
   * @returns {*} The value, or undefined; a hit makes the entry the most recently used
   */
  get(key) {
    const value = this._map.get(key);
    if (value !== undefined) {
      this._map.delete(key);
      this._map.set(key, value);
    }
    return value;
  }

  /**
   * @param {*} key
   * @param {*} value - Not undefined
   * @returns {void}
   */
  set(key, value) {
    this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this.max) this._map.delete(this._map.keys().next().value);
  }

  /**
   * Number of entries.
   *
   * @type {number}
   */
  get size() {
    return this._map.size;
  }
}
