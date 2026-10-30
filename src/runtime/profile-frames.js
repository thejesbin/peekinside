/**
 * The call frames of V8's profiles (heap and CPU) read the way the exception builder reads stack
 * frames: the app's own code or a package's, where it is, and, for the app's compiled code, where
 * it is in its sources (TypeScript).
 */

import { createHash } from 'crypto';
import { StackParser } from '../exceptions/stack-parser.js';

// Located frames kept: the same functions come back in every profile.
const MAX_FRAMES = 20000;

/**
 * @typedef {Object} ProfileFrame
 * @property {string|null} function
 * @property {string|null} file - Absolute path (or "node:..."), null for code without a file
 * @property {string|null} relativeFile - Relative to the project folder
 * @property {number|null} line - Where the function starts
 * @property {number|null} column
 * @property {boolean} inApp - Whether it is the app's own code
 * @property {string|null} module - The npm package (or "node") it belongs to
 */

/**
 * Locates profile call frames, cached.
 */
export class ProfileFrames {
  /**
   * @param {{ classifier: Object, sourceMaps: Object|null }} builder - The exception builder
   */
  constructor(builder) {
    this.builder = builder;
    this.cache = new Map();
  }

  /**
   * A profile's call frame (V8 counts lines and columns from 0) as a located frame.
   *
   * @param {{ functionName: string, url: string, lineNumber: number, columnNumber: number }} callFrame
   * @returns {ProfileFrame}
   */
  locate(callFrame) {
    const key = `${callFrame.url}\u0000${callFrame.lineNumber}\u0000${callFrame.columnNumber}\u0000${callFrame.functionName}`;
    let frame = this.cache.get(key);
    if (frame) return frame;
    const name = callFrame.functionName || null;
    if (!callFrame.url) {
      frame = { function: name, file: null, relativeFile: null, line: null, column: null, inApp: false, module: null };
    } else {
      const parsed = StackParser.parseLocation(`${callFrame.url}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1}`);
      const classified = this.builder.classifier.classify({ function: name, ...parsed, async: false });
      frame = { function: classified.function, file: classified.file || null, relativeFile: classified.relativeFile, line: classified.line, column: classified.column, inApp: classified.inApp, module: classified.module };
    }
    if (this.cache.size >= MAX_FRAMES) this.cache.clear();
    this.cache.set(key, frame);
    return frame;
  }

  /**
   * Maps the app's compiled functions among `sites` to their sources, in place: only the sites sent.
   *
   * @param {{ function: string|null, file: string|null, relativeFile: string|null, line: number|null, column: number|null, inApp: boolean }[]} sites
   * @returns {void}
   */
  mapSources(sites) {
    const sourceMaps = this.builder.sourceMaps;
    if (!sourceMaps) return;
    for (const site of sites) {
      if (!site.inApp || !site.file) continue;
      try {
        const [mapped] = sourceMaps.apply([{ function: site.function, file: site.file, relativeFile: site.relativeFile, line: site.line, column: site.column, inApp: true, module: null, native: false, async: false, context: null }]);
        if (mapped && mapped.file) {
          site.file = mapped.file;
          site.relativeFile = mapped.relativeFile;
          site.line = mapped.line;
          site.column = mapped.column;
          if (mapped.function) site.function = mapped.function;
        }
      } catch (error) {
        // The compiled location is kept.
      }
    }
  }

  /**
   * A site's id: the same key gets the same id in every profile and every process.
   *
   * @param {string} key
   * @returns {string}
   */
  static id(key) {
    return createHash('sha1').update(key).digest('hex').slice(0, 12);
  }
}
