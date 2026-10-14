/**
 * The stored form of an exception, shared by the local hub and PeekInside Cloud (see the data
 * contract): a few plain fields for lists and filters, a summary for the exception list, and the
 * detail (stack, frames, causes, request, process), loaded when someone opens the exception.
 */

import { LIMITS, truncate } from './limits.js';

/**
 * One recorded exception.
 *
 * The local hub receives the plain form (toJSON()). PeekInside Cloud receives the sealed form:
 * the summary and the detail are encrypted to the project's public key, bound to the exception
 * id, like the summary and detail of requests.
 */
export class ExceptionRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - UUID
   * @param {number} fields.occurredAt - When it was recorded (ms since the epoch)
   * @param {string} fields.environment - Normalized environment label
   * @param {string|null} [fields.release=null] - The running release (see release.js)
   * @param {boolean} fields.handled - Whether the app caught it (an error middleware, report())
   * @param {boolean} fields.fatal - Whether it crashed the process
   * @param {string|null} fields.requestId - The request it happened in
   * @param {string|null} [fields.jobRunId=null] - The job run it happened in
   * @param {Object} fields.summary - name, message, code, fingerprint, mechanism, location, request
   * @param {Object} fields.detail - stack, frames, causes, request, process, tags, extra
   */
  constructor({ id, occurredAt, environment, release = null, handled, fatal, requestId, jobRunId = null, summary, detail }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.handled = handled;
    this.fatal = fatal;
    this.requestId = requestId;
    this.jobRunId = jobRunId;
    this.summary = summary;
    this.detail = detail;
  }

  /**
   * The plain form, as the local hub stores it. Also used by JSON.stringify().
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      occurredAt: this.occurredAt,
      environment: this.environment,
      release: this.release,
      handled: this.handled,
      fatal: this.fatal,
      requestId: this.requestId,
      jobRunId: this.jobRunId,
      summary: this.summary,
      detail: this.detail
    };
  }

  /**
   * The sealed form, for PeekInside Cloud: the summary and the detail are encrypted, bound to this
   * exception's id so they can't be swapped with another record's.
   *
   * @param {import('../crypto.js').Sealer} sealer - Sealer of the batch
   * @returns {Promise<Object>}
   */
  async seal(sealer) {
    const { summary, detail, ...meta } = this.toJSON();
    return {
      ...meta,
      summary: await sealer.seal(JSON.stringify(summary), ExceptionRecord.summaryAad(this.id)),
      detail: await sealer.seal(JSON.stringify(detail), ExceptionRecord.detailAad(this.id))
    };
  }

  /**
   * seal() for a process that is crashing, where nothing asynchronous runs anymore.
   *
   * @param {import('../crypto.js').SyncSealer} sealer
   * @returns {Object}
   */
  sealSync(sealer) {
    const { summary, detail, ...meta } = this.toJSON();
    return {
      ...meta,
      summary: sealer.seal(JSON.stringify(summary), ExceptionRecord.summaryAad(this.id)),
      detail: sealer.seal(JSON.stringify(detail), ExceptionRecord.detailAad(this.id))
    };
  }

  /**
   * How the record of the request it happened in lists it, so the request inspector can link to it.
   *
   * @returns {{ id: string, name: string, message: string }}
   */
  link() {
    return { id: this.id, name: this.summary.name, message: truncate(this.summary.message, LIMITS.linkMessage) };
  }

  /**
   * @param {string} id
   * @returns {string} Additional authenticated data of a sealed summary
   */
  static summaryAad(id) {
    return `exception:summary:${id}`;
  }

  /**
   * @param {string} id
   * @returns {string} Additional authenticated data of a sealed detail
   */
  static detailAad(id) {
    return `exception:detail:${id}`;
  }
}
