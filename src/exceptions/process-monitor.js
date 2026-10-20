/**
 * Records crashes: uncaught exceptions, and unhandled promise rejections.
 *
 * Observing must not change what Node.js does with them:
 *
 * - 'uncaughtExceptionMonitor' sees an uncaught exception (and a rejection that Node.js raises as
 *   one, origin "unhandledRejection") before the process exits, without handling it: the error is
 *   still printed the same way and the process still exits with code 1. The process exits as soon
 *   as the listener returns, so the record is built and delivered synchronously.
 * - No 'unhandledRejection' listener is added by default: having one is what tells Node.js that
 *   the app handles rejections itself, and the process would no longer crash. Only when the app
 *   adds its own listener (the decision is then already made) does PeekInside add one too, to
 *   record the rejections the app now keeps running after. It is removed with the app's last one.
 *
 * One monitor serves every PeekInside instance in the process: a crash goes to the instance that
 * tracks the request it happened in, otherwise to the most recently created recording instance.
 */

import { ExceptionCapture } from './exception-capture.js';
import { RequestContext } from './request-context.js';

// What Node.js raises for a rejection whose reason isn't an error: the reason only survives as
// text in the message.
const UNHANDLED_REJECTION_MESSAGE = /The promise rejected with the reason "([\s\S]*)"\.$/;

// In --unhandled-rejections=strict mode one rejection reaches both the monitor and the
// 'unhandledRejection' listeners, right after each other: the second sighting is skipped.
const SAME_EVENT_MS = 100;

let installed = false;
let observingRejections = false;
let lastSeen = null;

/**
 * The process-level hooks, installed once per process while an instance records exceptions
 * automatically.
 */
export class ProcessMonitor {
  /**
   * Installs the hooks when some PeekInside instance records exceptions automatically, and removes
   * them when none does anymore.
   *
   * @returns {void}
   */
  static update() {
    try {
      if (ExceptionCapture.anyAutomatic()) install();
      else uninstall();
    } catch (error) {
      // Monitoring must never break the host application.
    }
  }

  /**
   * Whether an uncaught exception now ends the process: neither an 'uncaughtException' listener
   * nor a capture callback (domains, the REPL) takes it.
   *
   * @returns {boolean}
   */
  static isFatal() {
    const captured = typeof process.hasUncaughtExceptionCaptureCallback === 'function' && process.hasUncaughtExceptionCaptureCallback();
    return !captured && process.listenerCount('uncaughtException') === 0;
  }

  /**
   * Whether PeekInside observes unhandled rejections with its own listener right now (only while
   * the app has one).
   *
   * @type {boolean}
   */
  static get observingRejections() {
    return observingRejections;
  }
}

function install() {
  if (installed) return;
  installed = true;
  process.on('uncaughtExceptionMonitor', onUncaught);
  process.on('newListener', onNewListener);
  process.on('removeListener', onRemoveListener);
  if (process.listenerCount('unhandledRejection') > 0) observeRejections();
}

function uninstall() {
  if (!installed) return;
  installed = false;
  process.removeListener('uncaughtExceptionMonitor', onUncaught);
  process.removeListener('newListener', onNewListener);
  process.removeListener('removeListener', onRemoveListener);
  stopObservingRejections();
}

function observeRejections() {
  if (observingRejections) return;
  observingRejections = true;
  process.on('unhandledRejection', onRejection);
}

function stopObservingRejections() {
  if (!observingRejections) return;
  observingRejections = false;
  process.removeListener('unhandledRejection', onRejection);
}

// The app adds an 'unhandledRejection' listener: it now keeps running after rejections. Ours is
// added in front of it, so a listener that exits the process can't cut the recording short.
function onNewListener(event, listener) {
  if (event !== 'unhandledRejection' || listener === onRejection) return;
  try {
    observeRejections();
  } catch (error) {
    // Ignore: recording rejections is optional.
  }
}

// The app's last listener is gone: ours must go too, or rejections would no longer crash.
function onRemoveListener(event, listener) {
  if (event !== 'unhandledRejection') return;
  if (listener === onRejection) {
    observingRejections = false; // removed by the app (removeAllListeners)
    return;
  }
  try {
    if (observingRejections && process.listeners('unhandledRejection').every((item) => item === onRejection)) {
      stopObservingRejections();
    }
  } catch (error) {
    // Ignore.
  }
}

function onUncaught(error, origin) {
  try {
    const value = unwrapRejection(error, origin);
    if (alreadyRecorded(value)) return;
    const escaped = RequestContext.escaped();
    const context = escaped || RequestContext.current();
    const capture = captureFor(context);
    if (!capture) return;
    const mechanism = origin === 'unhandledRejection'
      ? 'unhandledRejection'
      : escaped && escaped.integration === 'http' ? 'http' : 'uncaught';
    capture.processError(value, {
      mechanism,
      fatal: ProcessMonitor.isFatal(),
      handled: false,
      context
    });
  } catch (failure) {
    // Never interfere with the crash itself.
  }
}

function onRejection(reason) {
  try {
    if (alreadyRecorded(reason)) return;
    const context = RequestContext.current();
    const capture = captureFor(context);
    if (!capture) return;
    capture.processError(reason, { mechanism: 'unhandledRejection', fatal: false, handled: true, context });
  } catch (failure) {
    // Ignore.
  }
}

// The instance tracking the request, when it records exceptions; otherwise the newest one that does.
function captureFor(context) {
  const own = context && context.capture;
  if (own && own.automatic && own.recording) return own;
  return ExceptionCapture.latest({ automatic: true });
}

function alreadyRecorded(value) {
  const now = Date.now();
  if (lastSeen && Object.is(lastSeen.value, value) && now - lastSeen.at < SAME_EVENT_MS) return true;
  lastSeen = { value, at: now };
  return false;
}

// Node.js wraps a non-error rejection reason (`Promise.reject('timeout')`) in an error of its own
// whose stack is only Node.js internals. The reason itself says more.
function unwrapRejection(error, origin) {
  if (origin !== 'unhandledRejection' || error === null || typeof error !== 'object') return error;
  try {
    if (error.code !== 'ERR_UNHANDLED_REJECTION') return error;
    const match = UNHANDLED_REJECTION_MESSAGE.exec(String(error.message));
    return match ? match[1] : error;
  } catch (failure) {
    return error;
  }
}
