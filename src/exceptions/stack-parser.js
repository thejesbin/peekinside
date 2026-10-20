/**
 * Reads V8 stack traces, the `error.stack` strings of Node.js, into frames.
 *
 * Every form V8 prints is understood:
 *
 *   at createOrder (/app/src/orders.js:12:9)          named function
 *   at /app/src/orders.js:12:9                         anonymous function
 *   at async createOrder (/app/src/orders.js:12:9)     async continuation
 *   at new Order (/app/src/order.js:3:11)              constructor
 *   at Layer.handle [as handle_request] (...)          method called under another name
 *   at file:///app/src/orders.mjs:12:9                 ES module (file URL)
 *   at Module._compile (node:internal/modules/...)     Node.js internals
 *   at JSON.parse (<anonymous>)                        built-in, no source
 *   at Array.forEach (native)                          built-in (older V8)
 *   at async Promise.all (index 0)                     Promise combinator
 *   at eval (eval at run (/app/src/x.js:3:5), <anonymous>:1:7)   code run by eval()
 *
 * Parsing is purely textual: nothing here touches the file system.
 */

import { fileURLToPath } from 'url';

// Frames are indented: a line of the message that happens to start with "at " is not a frame.
const FRAME_LINE = /^\s+at (.+)$/;
// "file:line:column" or "file:line". The file part is matched lazily, so the line and column are
// the last two numbers even when the path itself contains colons (C:\..., node:internal/...).
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;
const PROMISE_INDEX = /^index \d+$/;
// The header holds the error's name and message; frames start after it.
const MAX_HEADER_SEARCH = 1024;

/**
 * @typedef {Object} ParsedFrame
 * @property {string|null} function - Such as "createOrder" or "Layer.handle [as handle_request]";
 *   null for anonymous functions
 * @property {string|null} file - Path, "node:..." for internals, null when there is no source
 * @property {number|null} line
 * @property {number|null} column
 * @property {boolean} native - A built-in without source ("native", "<anonymous>")
 * @property {boolean} async - An "at async" frame
 */

/**
 * Turns stack strings and their lines into frames.
 */
export class StackParser {
  /**
   * Parses a stack trace, top (throwing) frame first.
   *
   * @param {string} stack - error.stack
   * @param {Object} [options]
   * @param {string} [options.message] - The error's message. Frames are read after it, so a
   *   message that quotes another stack trace isn't mistaken for frames.
   * @param {number} [options.limit=100] - Most frames returned
   * @returns {ParsedFrame[]}
   */
  static parse(stack, { message = '', limit = 100 } = {}) {
    if (typeof stack !== 'string' || stack === '') return [];

    let text = stack;
    if (typeof message === 'string' && message !== '') {
      const at = stack.indexOf(message);
      if (at !== -1 && at <= MAX_HEADER_SEARCH) text = stack.slice(at + message.length);
    }

    const frames = [];
    for (const line of text.split('\n')) {
      if (frames.length >= limit) break;
      const match = FRAME_LINE.exec(line);
      if (match) frames.push(StackParser.parseFrame(match[1]));
    }
    return frames;
  }

  /**
   * Parses what follows "at " on one frame line.
   *
   * @param {string} body - Such as "async createOrder (/app/src/orders.js:12:9)"
   * @returns {ParsedFrame}
   */
  static parseFrame(body) {
    let rest = String(body).trim();
    let isAsync = false;
    if (rest.startsWith('async ')) {
      isAsync = true;
      rest = rest.slice(6).trimStart();
    }

    let fn = null;
    let location = rest;
    // "name (location)": the location is the last parenthesized group, which may itself contain
    // parentheses (eval frames, folder names such as "My App (old)").
    if (rest.endsWith(')')) {
      const open = matchingOpen(rest, rest.length - 1);
      if (open > 0 && rest[open - 1] === ' ') {
        fn = rest.slice(0, open - 1).trim() || null;
        location = rest.slice(open + 1, -1);
      }
    }

    return { function: fn, ...StackParser.parseLocation(location), async: isAsync };
  }

  /**
   * Parses a frame's location.
   *
   * @param {string} location - Such as "/app/src/orders.js:12:9", "native" or "eval at ..."
   * @returns {{ file: string|null, line: number|null, column: number|null, native: boolean }}
   */
  static parseLocation(location) {
    const text = String(location).trim();
    if (text === 'native' || text === '<anonymous>' || text === 'unknown location' || PROMISE_INDEX.test(text)) {
      return { file: null, line: null, column: null, native: true };
    }

    // Code run by eval() or new Function() has no file of its own: the place that called eval()
    // is what tells people where it came from.
    if (text.startsWith('eval at ')) {
      const origin = evalOrigin(text);
      return origin ? { ...StackParser.parseLocation(origin), native: false } : { file: null, line: null, column: null, native: false };
    }

    const match = LOCATION.exec(text);
    if (match) {
      const line = Number(match[2]);
      const column = match[3] === undefined ? null : Number(match[3]);
      // Generated code without a name ("<anonymous>:3:9") has positions but no file.
      if (match[1] === '<anonymous>') return { file: null, line, column, native: true };
      return { file: toPath(match[1]), line, column, native: false };
    }
    return { file: text ? toPath(text) : null, line: null, column: null, native: false };
  }
}

// The index of the "(" that the ")" at `close` closes, or -1.
function matchingOpen(text, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(' && --depth === 0) return i;
  }
  return -1;
}

// The index of the ")" that closes the "(" at `open`, or -1.
function matchingClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// "eval at run (/app/x.js:3:5), <anonymous>:1:7" -> "/app/x.js:3:5". Nested evals
// ("eval at a (eval at b (/app/x.js:1:2), <anonymous>:3:4), ...") lead to the outermost caller.
function evalOrigin(text) {
  let current = text;
  for (let depth = 0; depth < 10 && current.startsWith('eval at '); depth++) {
    const open = current.indexOf('(');
    if (open === -1) return null;
    const close = matchingClose(current, open);
    if (close === -1) return null;
    current = current.slice(open + 1, close).trim();
  }
  return current.startsWith('eval at ') ? null : current;
}

// ES modules report file URLs; everything else keeps its form ("node:fs", "webpack://...").
function toPath(file) {
  if (!file.startsWith('file://')) return file;
  try {
    return fileURLToPath(file);
  } catch (error) {
    return file;
  }
}
