/**
 * The emails of one PeekInside instance, for the local dashboard's Mail page: each sendMail() call
 * is recorded with the message as its transport got it (see MailReader), the app's line that sent
 * it, the request or job run running then, and how the transport answered. An email sent during a
 * request is listed on the request's record and placed on its timeline, from the call to the
 * answer.
 *
 * Emails are rate limited per process (20 a second, bursts of 100). Nothing here throws into the
 * app, and nothing about how the email is sent changes.
 */

import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { TokenBucket } from '../exceptions/rate-limiter.js';
import { ExceptionCapture } from '../exceptions/exception-capture.js';
import { RequestContext } from '../exceptions/request-context.js';
import { MailReader, MAIL_LIMITS } from './mail-reader.js';
import { MailRecord } from './mail-record.js';

const STACK_LIMIT = 25;
// PeekInside's own files are never the line that sent an email.
const SDK_DIR = fileURLToPath(new URL('../', import.meta.url));

/**
 * Records emails for one PeekInside instance.
 */
export class MailCapture {
  /**
   * @param {Object} options
   * @param {import('../exceptions/exception-capture.js').ExceptionCapture} options.capture - The
   *   instance's exceptions, whose stack frames (mapped to source files) find the app's line
   * @param {() => Object|null} options.sink - The instance's transport
   * @param {() => boolean} options.isEnabled - Whether the instance records right now
   * @param {TokenBucket} [options.limiter]
   */
  constructor({ capture, sink, isEnabled, limiter = new TokenBucket({ rate: 20, burst: 100 }) }) {
    this.capture = capture;
    this._sink = sink;
    this._isEnabled = isEnabled;
    this.limiter = limiter;
  }

  /**
   * The capture of the instance tracking the code running now (none when that instance doesn't
   * record emails), else the newest recording instance's.
   *
   * @returns {MailCapture|null}
   */
  static current() {
    const context = RequestContext.current();
    const owner = context && context.capture ? context.capture.owner : null;
    if (owner) return owner._mails || null;
    const latest = ExceptionCapture.latest();
    return latest && latest.owner ? latest.owner._mails || null : null;
  }

  /**
   * @type {boolean}
   */
  get recording() {
    const sink = this._sink();
    return Boolean(sink && !sink.disabled && this._isEnabled());
  }

  /**
   * Starts recording one sendMail() call. Never throws.
   *
   * @param {Object} data - The message as the app passed it
   * @param {Function} entry - The patched sendMail: the stack is read from its caller
   * @returns {MailSend|null} null when nothing is recorded
   */
  begin(data, entry) {
    try {
      if (!this.recording) return null;
      const context = RequestContext.current();
      // Requests local mode doesn't record (server traffic) take their emails with them.
      if (context && context.blocked) return null;
      if (!this.limiter.take()) return null;
      const own = context && context.capture === this.capture ? context : null;
      const id = randomUUID();
      const message = data && typeof data === 'object' ? data : {};
      const subject = typeof message.subject === 'string' ? message.subject.slice(0, MAIL_LIMITS.subject) : '';
      const to = MailReader.addresses(message).to.slice(0, MAIL_LIMITS.summaryTo).map((address) => address.address);
      const span = own ? own.noteMail({ id, subject, to }) : null;
      return new MailSend({ capture: this, id, own, span, location: this._callSite(entry) });
    } catch (error) {
      return null;
    }
  }

  // The app's line that called `entry`: the first frame of the app's own code, mapped through
  // source maps like an exception's frames (a mailer library may sit between).
  _callSite(entry) {
    const holder = {};
    const limit = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = STACK_LIMIT;
      Error.captureStackTrace(holder, entry);
    } finally {
      Error.stackTraceLimit = limit;
    }
    const frames = this.capture.builder.frames({ stack: String(holder.stack || ''), fullMessage: '', isError: true }, STACK_LIMIT);
    const frame = frames.find((item) => item.inApp && item.file && !item.file.startsWith(SDK_DIR));
    if (!frame) return null;
    return { file: frame.file, relativeFile: frame.relativeFile, line: frame.line, column: frame.column, function: frame.function };
  }
}

/**
 * One sendMail() call being recorded: the message once nodemailer has built it, then the answer.
 */
export class MailSend {
  constructor({ capture, id, own, span, location }) {
    this.capture = capture;
    this.id = id;
    this.own = own;
    this.span = span;
    this.location = location;
    this.occurredAt = Date.now();
    this.startedAt = performance.now();
    this.read = null;
    this.done = false;
  }

  /**
   * The message as the transport gets it (after the app's plugins).
   *
   * @param {Object} mail - nodemailer's MailMessage
   * @returns {void}
   */
  message(mail) {
    try {
      this.read = MailReader.read(mail);
    } catch (error) {
      this.read = null;
    }
  }

  /**
   * Records the email with how the transport answered. Runs once.
   *
   * @param {*} error - What sendMail() failed with
   * @param {*} info - What it resolved with
   * @param {Object} data - The message as the app passed it, for one that failed before it was built
   * @param {Object} [transporter] - nodemailer's transport: name, version
   * @returns {void}
   */
  finish(error, info, data, transporter) {
    if (this.done) return;
    this.done = true;
    try {
      const duration = Math.round((performance.now() - this.startedAt) * 100) / 100;
      if (this.span) this.span.end({ error: error || undefined });
      const sink = this.capture._sink();
      if (!sink) return;
      const read = this.read || MailReader.read({ data });
      const outcome = MailReader.outcome(info, error);
      const own = this.own;
      sink.enqueueRecord(new MailRecord({
        id: this.id,
        occurredAt: this.occurredAt,
        environment: sink.environment,
        release: sink.release || null,
        requestId: own ? own.requestId : null,
        jobRunId: own ? own.jobRunId || null : null,
        location: this.location,
        summary: {
          ...read.summary,
          transport: transporter && typeof transporter.name === 'string' ? transporter.name.slice(0, 64) : null,
          status: outcome.status,
          duration,
          error: outcome.error ? { name: outcome.error.name, message: outcome.error.message.slice(0, 300) } : null
        },
        detail: {
          ...read.detail,
          messageId: outcome.messageId || read.detail.messageId,
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          response: outcome.response,
          error: outcome.error,
          transport: transporter ? { name: typeof transporter.name === 'string' ? transporter.name.slice(0, 64) : null, version: typeof transporter.version === 'string' ? transporter.version.slice(0, 32) : null } : null
        }
      }));
    } catch (failure) {
      // The email went out (or didn't) either way.
    }
  }
}
