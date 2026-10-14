/**
 * Lines written with pino and winston, like console lines: on the timeline of the request (or job
 * run) they belong to, and on the Logs page. Only lines the logger actually writes are recorded
 * (a level it has turned off is skipped), and what the logger writes is untouched.
 *
 * Both are patched on a prototype every logger shares, so loggers created before PeekInside, child
 * loggers and loggers imported as ES modules are all covered.
 */

import { LogCapture } from '../logs/log-capture.js';
import { Timeline } from '../timeline/timeline.js';

const kPatched = Symbol('peekInside.logger');
const WINSTON_LEVEL = Symbol.for('level');
const PINO_LEVELS = { trace: 'debug', debug: 'debug', info: 'info', warn: 'warn', error: 'error', fatal: 'error' };
const WINSTON_LEVELS = { error: 'error', warn: 'warn', info: 'info', http: 'info', verbose: 'debug', debug: 'debug', silly: 'debug' };
// Keys of a winston `info` that aren't the line's own data.
const WINSTON_OWN = new Set(['level', 'message', 'timestamp', 'splat']);

/**
 * Patches logging libraries.
 */
export class LoggerInstrumentation {
  /**
   * Patches pino: every logger writes through one prototype method.
   *
   * @param {*} pino - The pino module (its factory)
   * @returns {boolean} Whether it is (now) patched
   */
  static pino(pino) {
    const factory = typeof pino === 'function' ? pino : pino && typeof pino.default === 'function' ? pino.default : null;
    const writeSym = factory && factory.symbols && factory.symbols.writeSym;
    if (!writeSym) return false;
    // Each logger sits on an object of its own, over the prototype that holds the write method.
    let proto;
    try {
      proto = Object.getPrototypeOf(factory({ enabled: false }));
      while (proto && !Object.prototype.hasOwnProperty.call(proto, writeSym)) proto = Object.getPrototypeOf(proto);
    } catch (error) {
      return false;
    }
    if (!proto || typeof proto[writeSym] !== 'function') return false;
    if (proto[kPatched]) return true;
    const original = proto[writeSym];
    proto[writeSym] = function (obj, msg, num) {
      try {
        const label = this.levels && this.levels.labels ? this.levels.labels[num] : undefined;
        capture(PINO_LEVELS[label] || (num >= 50 ? 'error' : num >= 40 ? 'warn' : num >= 30 ? 'info' : 'debug'), pinoLine(obj, msg), pinoFields(obj), 'pino');
      } catch (error) {
        // The line is written all the same.
      }
      return original.call(this, obj, msg, num);
    };
    Object.defineProperty(proto, kPatched, { value: true });
    return true;
  }

  /**
   * Patches winston: every logger is a Logger stream whose _transform receives each line.
   *
   * @param {*} winston - The winston module
   * @returns {boolean} Whether it is (now) patched
   */
  static winston(winston) {
    if (!winston || typeof winston.createLogger !== 'function') return false;
    let proto;
    try {
      const probe = winston.createLogger({ silent: true });
      proto = Object.getPrototypeOf(Object.getPrototypeOf(probe));
      probe.close();
    } catch (error) {
      return false;
    }
    if (!proto || typeof proto._transform !== 'function') return false;
    if (proto[kPatched]) return true;
    const original = proto._transform;
    proto._transform = function (info, encoding, callback) {
      try {
        const level = info && (info[WINSTON_LEVEL] || info.level);
        if (!this.silent && typeof level === 'string' && this.isLevelEnabled(level)) {
          capture(WINSTON_LEVELS[level] || 'info', winstonLine(info), winstonFields(info), 'winston');
        }
      } catch (error) {
        // The line is written all the same.
      }
      return original.call(this, info, encoding, callback);
    };
    Object.defineProperty(proto, kPatched, { value: true });
    return true;
  }
}

function capture(level, message, fields, source) {
  const timeline = Timeline.current();
  if (timeline && timeline.settings.captureLogs) timeline.log(level, message, source);
  LogCapture.record(level, message, { source, fields });
}

function pinoLine(obj, msg) {
  if (typeof msg === 'string') return msg;
  if (obj instanceof Error) return obj.message;
  if (obj && typeof obj === 'object' && typeof obj.msg === 'string') return obj.msg;
  return msg === undefined ? '' : String(msg);
}

function pinoFields(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj instanceof Error) return { err: errorFields(obj) };
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'msg') continue;
    fields[key] = value instanceof Error ? errorFields(value) : value;
  }
  return fields;
}

function winstonLine(info) {
  const message = info.message;
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  return message === undefined ? '' : String(message);
}

function winstonFields(info) {
  const fields = {};
  for (const [key, value] of Object.entries(info)) {
    if (WINSTON_OWN.has(key)) continue;
    fields[key] = value instanceof Error ? errorFields(value) : value;
  }
  return fields;
}

function errorFields(error) {
  return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}) };
}
