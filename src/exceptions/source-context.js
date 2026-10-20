/**
 * The source lines around in-app frames, read from disk when an exception is recorded.
 *
 * Reads are synchronous: exceptions are also recorded while the process is crashing, when nothing
 * asynchronous runs anymore. They stay cheap and safe: only source files of the app itself (inside
 * the project folder, outside node_modules, after resolving symlinks), at most 1 MB each, and a
 * few recently read files are kept in memory.
 */

import fs from 'fs';
import path from 'path';
import { LIMITS, truncate } from './limits.js';
import { contextFrom } from './source-maps.js';

const SOURCE_FILE = /\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i;
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_CACHED_FILES = 20;

/**
 * Reads source lines of the app's files, with a small LRU cache.
 */
export class SourceContext {
  /**
   * @param {string} root - The project folder; nothing outside it is read
   * @param {Object} [options]
   * @param {number} [options.maxFiles=20] - Files kept in memory
   * @param {number} [options.maxFileSize=1048576] - Larger files are never read
   */
  constructor(root, { maxFiles = MAX_CACHED_FILES, maxFileSize = MAX_FILE_SIZE } = {}) {
    this.root = path.resolve(root || process.cwd());
    this.maxFiles = maxFiles;
    this.maxFileSize = maxFileSize;
    // file -> { mtimeMs, size, lines (null when the file can't be shown) }, least recent first.
    this._cache = new Map();
    this._realRoot = null;
  }

  /**
   * Adds source lines to the first in-app frames.
   *
   * @param {import('./frame-classifier.js').Frame[]} frames - Changed in place
   * @param {number} [count=5] - In-app frames that get lines
   * @param {(frame: Object) => string[]|null} [linesOf] - A frame's lines when they are already
   *   known (a source map that carries its sources); others are read from disk
   * @returns {void}
   */
  addTo(frames, count = LIMITS.contextFrames, linesOf = null) {
    let remaining = count;
    for (const frame of frames) {
      if (remaining === 0) break;
      if (!frame.inApp) continue;
      remaining--;
      try {
        const known = linesOf ? linesOf(frame) : null;
        frame.context = known ? contextFrom(known, frame.line) : this.around(frame.file, frame.line);
      } catch (error) {
        frame.context = null;
      }
    }
  }

  /**
   * The lines around one line of a file.
   *
   * @param {string|null} file - Absolute path
   * @param {number|null} line - 1-based
   * @param {number} [radius=5] - Lines on each side
   * @returns {{ start: number, lines: string[] }|null} `start` is the number of the first line;
   *   null when the file can't be shown
   */
  around(file, line, radius = LIMITS.contextLines) {
    if (!file || !Number.isInteger(line) || line < 1 || !SOURCE_FILE.test(file)) return null;
    const lines = this._lines(file);
    if (!lines || line > lines.length) return null;

    const start = Math.max(1, line - radius);
    const end = Math.min(lines.length, line + radius);
    return {
      start,
      lines: lines.slice(start - 1, end).map((text) => truncate(text, LIMITS.contextLineLength))
    };
  }

  // The file's lines, from the cache while the file is unchanged. Checked on every call, so an
  // edited file (a dev server that doesn't restart) shows its current lines.
  _lines(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      return null;
    }

    const cached = this._cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this._cache.delete(file);
      this._cache.set(file, cached);
      return cached.lines;
    }

    let lines = null;
    if (stat.isFile() && stat.size <= this.maxFileSize && this._isAppFile(file)) {
      try {
        lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      } catch (error) {
        lines = null;
      }
    }

    this._cache.delete(file);
    this._cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
    while (this._cache.size > this.maxFiles) {
      this._cache.delete(this._cache.keys().next().value);
    }
    return lines;
  }

  // Inside the project folder and not under node_modules, once symlinks are resolved: a link in
  // the project must not expose a file elsewhere on the machine.
  _isAppFile(file) {
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (error) {
      return false;
    }
    const relative = path.relative(this._root(), real);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    return !relative.split(path.sep).includes('node_modules');
  }

  _root() {
    if (this._realRoot === null) {
      try {
        this._realRoot = fs.realpathSync(this.root);
      } catch (error) {
        this._realRoot = this.root;
      }
    }
    return this._realRoot;
  }
}
