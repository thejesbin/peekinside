/**
 * Console lines: console.log/info/warn/error/debug, and console.trace. A line written while a
 * request (or a job run) is handled goes on its timeline; every line goes to the Logs page (see
 * LogCapture). What the console prints is untouched: the original method runs with the same
 * arguments.
 *
 * console.trace is not wrapped: the stack it prints would include the wrapper. It writes through
 * console.error, so it is recognized there instead (a single "Trace: ..." string, written by
 * console.trace itself) and recorded at debug level, as the contract maps it.
 *
 * PeekInside's own lines ("[peekinside] ...") are never recorded.
 */

import { format } from 'util';
import { LOG_PREFIX } from '../config.js';
import { LogCapture } from '../logs/log-capture.js';
import { Timeline } from '../timeline/timeline.js';

const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
const TRACE = /^Trace(?:: |\n|$)/;
let installed = false;

/**
 * Wraps the global console's methods, once per process.
 */
export class ConsoleInstrumentation {
  /**
   * @returns {void}
   */
  static install() {
    if (installed) return;
    installed = true;
    for (const [method, level] of Object.entries(LEVELS)) {
      const original = console[method];
      if (typeof original !== 'function') continue;
      const wrapper = {
        [method](...args) {
          record(level, args, wrapper);
          return original.apply(this, arguments);
        }
      }[method];
      console[method] = wrapper;
    }
  }
}

function record(level, args, wrapper) {
  try {
    if (typeof args[0] === 'string' && args[0].startsWith(LOG_PREFIX)) return;
    const timeline = Timeline.current();
    const onTimeline = Boolean(timeline && timeline.settings.captureLogs);
    let line = null;
    if (level === 'error' && args.length === 1 && typeof args[0] === 'string' && TRACE.test(args[0]) && calledByTrace(wrapper)) {
      const text = args[0];
      const frames = text.indexOf('\n    at ');
      const head = frames === -1 ? text : text.slice(0, frames);
      line = { level: 'debug', message: head.startsWith('Trace: ') ? head.slice(7) : '' };
    }
    const lineLevel = line ? line.level : level;
    const toLogs = LogCapture.wants(lineLevel);
    if (!onTimeline && !toLogs) return;
    if (!line) line = { level, message: format(...args) };
    if (onTimeline) timeline.log(line.level, line.message);
    if (toLogs) LogCapture.record(line.level, line.message, { source: 'console' });
  } catch (error) {
    // A value whose formatting throws is printed (or not) by the console itself.
  }
}

// Whether console.error was called by console.trace: its frame is right below the wrapper's.
function calledByTrace(wrapper) {
  const saved = Error.stackTraceLimit;
  const holder = {};
  try {
    Error.stackTraceLimit = 2;
    Error.captureStackTrace(holder, wrapper);
    return /\bat (?:console\.|Console\.)?trace\b/.test(String(holder.stack));
  } catch (error) {
    return false;
  } finally {
    Error.stackTraceLimit = saved;
  }
}
