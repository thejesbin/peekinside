/**
 * Where the app ran a query: the first frame of the app's own code on the stack.
 *
 * Read once per statement and request, at its first execution, so an N+1 loop of a thousand
 * queries reads the stack once. The stack is read with a higher Error.stackTraceLimit for that
 * moment only: drivers sit several frames deep between the app and the point where they are
 * hooked.
 *
 * Some calls reach the hooked method after the app's frame is gone: a pool runs the query from a
 * callback on a later tick. For those, the integration reads the caller where the app called the
 * pool and hands it down as a hint (AsyncLocalStorage), checked against the statement it was taken
 * for.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { fileURLToPath } from 'url';
import { FrameClassifier } from '../exceptions/frame-classifier.js';
import { StackParser } from '../exceptions/stack-parser.js';

const STACK_LIMIT = 25;
// PeekInside's own files are never the caller, even when they are inside the project (PeekInside's
// own tests, a checkout used through npm link).
const SDK_DIR = fileURLToPath(new URL('../', import.meta.url));
const hints = new AsyncLocalStorage();

/**
 * @typedef {Object} CallerInfo
 * @property {string} file - Absolute path
 * @property {string|null} relativeFile - Relative to the project folder, forward slashes
 * @property {number|null} line
 * @property {number|null} column
 * @property {string|null} function
 */

/**
 * Finds the app's frame for statements.
 */
export class Caller {
  /**
   * @param {string} root - The project folder
   */
  constructor(root) {
    this.classifier = new FrameClassifier(root);
  }

  /**
   * The app's frame on the current stack.
   *
   * @returns {CallerInfo|null}
   */
  capture() {
    const saved = Error.stackTraceLimit;
    const holder = {};
    try {
      Error.stackTraceLimit = STACK_LIMIT;
      Error.captureStackTrace(holder, Caller.prototype.capture);
    } catch (error) {
      return null;
    } finally {
      Error.stackTraceLimit = saved;
    }
    try {
      return this.fromStack(holder.stack);
    } catch (error) {
      return null;
    }
  }

  /**
   * The app's frame in a stack captured elsewhere (by Prisma, for one).
   *
   * @param {string} stack
   * @returns {CallerInfo|null}
   */
  fromStack(stack) {
    if (typeof stack !== 'string') return null;
    for (const parsed of StackParser.parse(stack, { limit: STACK_LIMIT })) {
      if (!parsed.file || parsed.file.startsWith(SDK_DIR)) continue;
      const frame = this.classifier.classify(parsed);
      if (frame.inApp) return Caller.fromFrame(frame);
    }
    return null;
  }

  /**
   * A caller from a file position (Prisma's own call site format).
   *
   * @param {{ fileName: string, lineNumber?: number, columnNumber?: number }} location
   * @returns {CallerInfo|null}
   */
  fromLocation(location) {
    if (!location || typeof location.fileName !== 'string') return null;
    const parsed = StackParser.parseLocation(`${location.fileName}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`);
    if (!parsed.file || parsed.file.startsWith(SDK_DIR)) return null;
    const frame = this.classifier.classify({ function: null, ...parsed, async: false });
    return frame.inApp ? Caller.fromFrame(frame) : null;
  }

  /**
   * @param {import('../exceptions/frame-classifier.js').Frame} frame
   * @returns {CallerInfo}
   */
  static fromFrame(frame) {
    return { file: frame.file, relativeFile: frame.relativeFile, line: frame.line, column: frame.column, function: frame.function };
  }

  /**
   * Runs `fn` with a caller hint for the statement `key`: code that runs the statement later (from
   * a pool's callback) finds it with Caller.hinted().
   *
   * @param {{ key: string, caller: CallerInfo|null }} hint
   * @param {Function} fn
   * @returns {*} What fn returns
   */
  static withHint(hint, fn) {
    return hints.run(hint, fn);
  }

  /**
   * The hint for statement `key`, if one was given.
   *
   * @param {string} key
   * @returns {{ caller: CallerInfo|null }|null}
   */
  static hinted(key) {
    const hint = hints.getStore();
    return hint && hint.key === key ? hint : null;
  }
}
