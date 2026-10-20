/**
 * Maps the stack frames of compiled code (TypeScript output, bundles) back to the files people
 * edit, with the source maps their build wrote: a `.map` file named by a sourceMappingURL comment,
 * a map inlined in that comment, or `<file>.js.map` next to the file ("hidden" source maps).
 *
 * Like SourceContext, reads are synchronous (crashes are recorded too) and bounded: only the app's
 * own compiled files are mapped (inside the project folder, outside node_modules), maps are read
 * from the project folder only, at most 16 MB each, and a few are kept in memory. Node's own
 * parser (module.SourceMap) reads them. Apps that run with --enable-source-maps, tsx or ts-node
 * already have mapped stacks: their frames point at .ts files and are left alone.
 */

import fs from 'fs';
import { SourceMap } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { LIMITS, truncate } from './limits.js';

const GENERATED_FILE = /\.(?:js|mjs|cjs)$/i;
// The end of a compiled file holds its sourceMappingURL comment; an inline map can be large.
const MAX_TAIL = 8 * 1024 * 1024;
const MAX_MAP_SIZE = 16 * 1024 * 1024;
const MAX_CACHED_FILES = 8;
const COMMENT = /\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*$/;
const DATA_URL = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/i;
// Bundler URLs for sources: webpack://app/./src/x.ts, turbopack:///[project]/src/x.ts
const BUNDLER_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(?:\[project\]\/)?/i;

/**
 * @typedef {Object} LoadedMap
 * @property {SourceMap} map
 * @property {string} dir - Where relative sources are resolved from
 * @property {string} sourceRoot
 * @property {Map<string, number>} indexOf - Source as written in the map -> its index
 * @property {Array<string|null>} contents - sourcesContent
 * @property {Map<number, string[]>} lines - Split contents, by source index
 */

/**
 * Applies source maps to frames, with a small LRU cache of parsed maps.
 */
export class SourceMaps {
  /**
   * @param {import('./frame-classifier.js').FrameClassifier} classifier - Classifies mapped frames
   * @param {Object} [options]
   * @param {number} [options.maxFiles=8] - Compiled files whose maps are kept in memory
   * @param {number} [options.maxMapSize=16777216] - Larger maps are never read
   */
  constructor(classifier, { maxFiles = MAX_CACHED_FILES, maxMapSize = MAX_MAP_SIZE } = {}) {
    this.classifier = classifier;
    this.maxFiles = maxFiles;
    this.maxMapSize = maxMapSize;
    // compiled file -> { mtimeMs, size, loaded (null without a usable map) }, least recent first
    this._cache = new Map();
    // Mapped frame -> the lines of its original file, when the map carries them (sourcesContent)
    this._sourceLines = new WeakMap();
    this._realRoot = null;
  }

  /**
   * Maps frames of the app's compiled files to their sources, in place. A mapped frame keeps
   * where it ran in `generated` and is classified again (a bundle can hold node_modules code).
   *
   * @param {import('./frame-classifier.js').Frame[]} frames
   * @returns {import('./frame-classifier.js').Frame[]} The same array
   */
  apply(frames) {
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (!frame.inApp || !frame.file || !GENERATED_FILE.test(frame.file) || !Number.isInteger(frame.line)) continue;
      let mapped = null;
      try {
        mapped = this._map(frame);
      } catch (error) {
        mapped = null;
      }
      if (mapped) frames[index] = mapped;
    }
    return frames;
  }

  /**
   * The lines of a mapped frame's original file, when its map carried them.
   *
   * @param {import('./frame-classifier.js').Frame} frame
   * @returns {string[]|null}
   */
  linesOf(frame) {
    return this._sourceLines.get(frame) || null;
  }

  _map(frame) {
    const loaded = this._load(frame.file);
    if (!loaded) return null;
    const line = frame.line - 1;
    const column = Math.max(0, (frame.column || 1) - 1);
    let entry = loaded.map.findEntry(line, column);
    // A column before the line's first mapping finds an earlier line: take the line's own.
    if (entry && entry.generatedLine !== line) entry = loaded.map.findEntry(line, Number.MAX_SAFE_INTEGER);
    if (!entry || entry.generatedLine !== line || typeof entry.originalSource !== 'string' || !Number.isInteger(entry.originalLine)) {
      return null;
    }

    const file = resolveSource(entry.originalSource, loaded, this.classifier.root);
    if (!file) return null;
    const mapped = this.classifier.classify({
      function: frame.function,
      file,
      line: entry.originalLine + 1,
      column: Number.isInteger(entry.originalColumn) ? entry.originalColumn + 1 : null,
      native: false,
      async: frame.async
    });
    // Sources outside the project folder (absolute paths of the build machine) are still the
    // app's own code, unless they come from node_modules.
    if (!mapped.relativeFile && !mapped.module && !file.startsWith('node:')) {
      mapped.inApp = true;
      mapped.relativeFile = looseRelative(entry.originalSource);
    }
    mapped.generated = { file: frame.relativeFile || frame.file, line: frame.line, column: frame.column };

    const index = loaded.indexOf.get(entry.originalSource);
    const content = index === undefined ? null : loaded.contents[index];
    if (typeof content === 'string') {
      let lines = loaded.lines.get(index);
      if (!lines) {
        lines = content.split(/\r?\n/);
        loaded.lines.set(index, lines);
      }
      this._sourceLines.set(mapped, lines);
    }
    return mapped;
  }

  // The map of a compiled file, from the cache while the file is unchanged.
  _load(file) {
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
      return cached.loaded;
    }

    let loaded = null;
    try {
      loaded = stat.isFile() && this._inProject(file) ? this._read(file, stat.size) : null;
    } catch (error) {
      loaded = null;
    }
    this._cache.delete(file);
    this._cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, loaded });
    while (this._cache.size > this.maxFiles) this._cache.delete(this._cache.keys().next().value);
    return loaded;
  }

  _read(file, size) {
    const url = SourceMaps.mappingUrl(readTail(file, size, MAX_TAIL));
    let text = null;
    let dir = path.dirname(file);
    if (url && DATA_URL.test(url)) {
      const [, base64, data] = DATA_URL.exec(url);
      if (data.length > this.maxMapSize * 1.4) return null;
      text = base64 ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
    } else {
      const mapFile = url ? mapPath(url, dir) : `${file}.map`;
      if (!mapFile || !this._inProject(mapFile)) return null;
      text = readSmallFile(mapFile, this.maxMapSize);
      dir = path.dirname(mapFile);
    }
    if (!text) return null;

    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || (!Array.isArray(payload.sources) && !Array.isArray(payload.sections))) return null;
    const map = new SourceMap(payload);
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const indexOf = new Map();
    sources.forEach((source, index) => {
      if (typeof source === 'string' && !indexOf.has(source)) indexOf.set(source, index);
    });
    return {
      map,
      dir,
      sourceRoot: typeof payload.sourceRoot === 'string' ? payload.sourceRoot : '',
      indexOf,
      contents: Array.isArray(payload.sourcesContent) ? payload.sourcesContent : [],
      lines: new Map()
    };
  }

  /**
   * The URL in a compiled file's last sourceMappingURL comment.
   *
   * @param {string} text - The end of the file
   * @returns {string|null}
   */
  static mappingUrl(text) {
    if (!text) return null;
    const at = text.lastIndexOf('sourceMappingURL=');
    if (at === -1) return null;
    const lineStart = text.lastIndexOf('\n', at) + 1;
    let lineEnd = text.indexOf('\n', at);
    if (lineEnd === -1) lineEnd = text.length;
    const match = COMMENT.exec(text.slice(lineStart, lineEnd).replace(/\r$/, '').trim());
    return match ? match[1] : null;
  }

  // Inside the project folder and outside node_modules, once symlinks are resolved.
  _inProject(file) {
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (error) {
      return false;
    }
    if (this._realRoot === null) {
      try {
        this._realRoot = fs.realpathSync(this.classifier.root);
      } catch (error) {
        this._realRoot = this.classifier.root;
      }
    }
    const relative = path.relative(this._realRoot, real);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    return !relative.split(path.sep).includes('node_modules');
  }
}

/**
 * Source lines around a line, as SourceContext reads them from disk.
 *
 * @param {string[]} lines
 * @param {number|null} line - 1-based
 * @returns {{ start: number, lines: string[] }|null}
 */
export function contextFrom(lines, line) {
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const start = Math.max(1, line - LIMITS.contextLines);
  const end = Math.min(lines.length, line + LIMITS.contextLines);
  return { start, lines: lines.slice(start - 1, end).map((text) => truncate(text, LIMITS.contextLineLength)) };
}

// Where a source named in a map is: bundler URLs from the project folder, file URLs and absolute
// paths as they are, the rest next to the map (after its sourceRoot).
function resolveSource(source, loaded, root) {
  if (!source) return null;
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch (error) {
      return null;
    }
  }
  if (source.startsWith('node:')) return source;
  if (BUNDLER_URL.test(source)) return path.resolve(root, source.replace(BUNDLER_URL, ''));
  if (path.isAbsolute(source)) return path.normalize(source);
  const sourceRoot = loaded.sourceRoot;
  if (sourceRoot.startsWith('file://')) {
    try {
      return path.resolve(fileURLToPath(sourceRoot), source);
    } catch (error) {
      return null;
    }
  }
  if (BUNDLER_URL.test(sourceRoot)) return path.resolve(root, sourceRoot.replace(BUNDLER_URL, ''), source);
  return path.resolve(loaded.dir, sourceRoot, source);
}

// A stable name for a source outside the project folder: its path without leading "../" or "/".
function looseRelative(source) {
  return source
    .replace(BUNDLER_URL, '')
    .replace(/^file:\/\//, '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/') || null;
}

function mapPath(url, dir) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('file:')) return null; // http:, data: of other types
  try {
    return url.startsWith('file:') ? fileURLToPath(url) : path.resolve(dir, decodeURIComponent(url));
  } catch (error) {
    return null;
  }
}

function readTail(file, size, max) {
  const length = Math.min(size, max);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readSmallFile(file, max) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return null;
  }
}
