/**
 * One log line, as the Logs page lists it (see the data contract): when, its level, where it came
 * from (console, pino, winston), the request or job run it belongs to, and the line itself.
 *
 * PeekInside Cloud receives the line sealed: only the time, level, source and links are readable.
 */

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

/**
 * A recorded log line.
 */
export class LogRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - UUID
   * @param {number} fields.occurredAt - ms since the epoch
   * @param {string} fields.environment
   * @param {string|null} [fields.release=null]
   * @param {'debug'|'info'|'warn'|'error'} fields.level
   * @param {'console'|'pino'|'winston'} fields.source
   * @param {string|null} [fields.requestId=null] - The request it was written during
   * @param {string|null} [fields.jobRunId=null] - The job run it was written during
   * @param {{ message: string, fields?: Object|null }} fields.summary - The line (sealed in Cloud)
   */
  constructor({ id, occurredAt, environment, release = null, level, source, requestId = null, jobRunId = null, summary }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.level = level;
    this.source = source;
    this.requestId = requestId;
    this.jobRunId = jobRunId;
    this.summary = summary;
  }

  /**
   * The plain form, as the local hub stores it.
   *
   * @returns {Object}
   */
  toJSON() {
    return { ...this };
  }

  /**
   * The sealed form, for PeekInside Cloud.
   *
   * @param {import('../crypto.js').Sealer} sealer
   * @returns {Promise<Object>}
   */
  async seal(sealer) {
    const { summary, ...meta } = this.toJSON();
    return { ...meta, summary: await sealer.seal(JSON.stringify(summary), LogRecord.summaryAad(this.id)) };
  }

  /**
   * @param {import('../crypto.js').SyncSealer} sealer
   * @returns {Object}
   */
  sealSync(sealer) {
    const { summary, ...meta } = this.toJSON();
    return { ...meta, summary: sealer.seal(JSON.stringify(summary), LogRecord.summaryAad(this.id)) };
  }

  /**
   * @param {string} id
   * @returns {string} Additional authenticated data of a sealed line
   */
  static summaryAad(id) {
    return `log:summary:${id}`;
  }
}
