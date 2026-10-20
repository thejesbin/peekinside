/**
 * Bounds how many exceptions are recorded per second.
 *
 * An app in trouble can throw thousands of errors a second (a failing database behind every
 * request, a loop that keeps throwing). Each record reads the stack and maybe source files, and
 * waits in memory until it is sent, so a storm must not turn into a memory or CPU problem of its
 * own: past the limit, exceptions are dropped until the bucket refills.
 */

/**
 * Token bucket: `burst` tokens to start with, refilled at `rate` tokens per second.
 */
export class TokenBucket {
  /**
   * @param {Object} [options]
   * @param {number} [options.rate=50] - Tokens added per second
   * @param {number} [options.burst=100] - Most tokens held
   * @param {() => number} [options.now] - Clock in ms (for tests)
   */
  constructor({ rate = 50, burst = 100, now = Date.now } = {}) {
    this.rate = rate;
    this.burst = burst;
    this._now = now;
    this._tokens = burst;
    this._updatedAt = now();
    /**
     * Exceptions dropped because the bucket was empty
     * @type {number}
     */
    this.dropped = 0;
  }

  /**
   * Takes one token.
   *
   * @returns {boolean} False when none is left (the caller drops the exception)
   */
  take() {
    const now = this._now();
    const elapsed = Math.max(0, now - this._updatedAt) / 1000;
    this._tokens = Math.min(this.burst, this._tokens + elapsed * this.rate);
    this._updatedAt = now;
    if (this._tokens < 1) {
      this.dropped++;
      return false;
    }
    this._tokens -= 1;
    return true;
  }
}
