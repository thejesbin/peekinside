/**
 * What the dashboard remembers about a project's issues: which exception fingerprints were marked
 * resolved, and when. Stored in the project's folder as exception-state.json.
 *
 * Several dashboards (tabs) may edit it at once, so every save names the version it started from;
 * a save based on an older version is refused, and the dashboard merges and tries again.
 */

import fs from 'fs';
import path from 'path';

const FINGERPRINT = /^[0-9a-f]{16}$/;
export const MAX_RESOLVED = 5000;

/**
 * @typedef {Object} ExceptionStateValue
 * @property {Object<string, number>} resolved - Fingerprint -> when it was marked resolved (ms)
 */

/**
 * The exception state file of one project.
 */
export class ExceptionState {
  /**
   * @param {string} dir - The project's folder
   */
  constructor(dir) {
    this.file = path.join(dir, 'exception-state.json');
    this._current = null;
  }

  /**
   * Checks a state sent by a dashboard.
   *
   * @param {*} value
   * @returns {ExceptionStateValue|null} The state with only known fields, or null when it is
   *   malformed or holds more than 5000 fingerprints
   */
  static validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resolved = value.resolved;
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return null;
    const keys = Object.keys(resolved);
    if (keys.length > MAX_RESOLVED) return null;

    const clean = {};
    for (const key of keys) {
      const at = resolved[key];
      if (!FINGERPRINT.test(key) || !Number.isFinite(at) || at < 0) return null;
      clean[key] = at;
    }
    return { resolved: clean };
  }

  /**
   * The saved state; version 0 and nothing resolved when it was never saved.
   *
   * @returns {{ state: ExceptionStateValue, version: number }}
   */
  read() {
    if (!this._current) {
      this._current = { state: { resolved: {} }, version: 0 };
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const state = ExceptionState.validate(saved && saved.state);
        if (state && Number.isInteger(saved.version) && saved.version > 0) {
          this._current = { state, version: saved.version };
        }
      } catch (error) {
        // Missing or unreadable: start from scratch rather than fail the dashboard.
      }
    }
    return this._current;
  }

  /**
   * Saves a new state if `version` is the current one.
   *
   * @param {ExceptionStateValue} state - Validated state
   * @param {number} version - The version the dashboard read
   * @returns {{ saved: boolean, state: ExceptionStateValue, version: number }} The new version when
   *   saved; otherwise the current state and version, for the dashboard to merge with
   */
  write(state, version) {
    const current = this.read();
    if (version !== current.version) {
      return { saved: false, ...current };
    }
    const next = { state, version: current.version + 1 };
    // Written to a temporary file first, so a crash never leaves half a file.
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this._current = next;
    return { saved: true, ...next };
  }
}
