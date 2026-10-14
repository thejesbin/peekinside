/**
 * One run of a background job (a scheduled task, a queue worker's job, or code wrapped in
 * PeekInside.job()), as the Jobs page lists it (see the data contract).
 *
 * Readable in PeekInside Cloud, like a request's method and status: the job's name, its queue and
 * schedule, when it ran, for how long, how it ended, its attempt and counters. Sealed: the error it
 * failed with, the user, the job's data and its timeline.
 */

/**
 * A recorded job run.
 */
export class JobRunRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - UUID
   * @param {number} fields.occurredAt - When the run started (ms since the epoch)
   * @param {string} fields.environment
   * @param {string|null} [fields.release=null]
   * @param {string} fields.name - Such as "send-invoices"
   * @param {string|null} [fields.queue=null] - The queue it came from (BullMQ)
   * @param {string|null} [fields.schedule=null] - Its cron expression, when it runs on one
   * @param {string|null} [fields.timezone=null] - The schedule's time zone
   * @param {'cron'|'queue'|'manual'} fields.trigger
   * @param {'ok'|'failed'} fields.status
   * @param {number|null} fields.duration - ms
   * @param {number} [fields.attempt=1]
   * @param {number} [fields.exceptionCount=0]
   * @param {Object} [fields.stats] - Timeline counters, as requests have them
   * @param {Object} fields.summary - `{ error: { name, message } | null, user }` (sealed in Cloud)
   * @param {Object} fields.detail - `{ data, timeline, exceptions }` (sealed in Cloud)
   */
  constructor({ id, occurredAt, environment, release = null, name, queue = null, schedule = null, timezone = null, trigger, status, duration, attempt = 1, exceptionCount = 0, stats, summary, detail }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.name = name;
    this.queue = queue;
    this.schedule = schedule;
    this.timezone = timezone;
    this.trigger = trigger;
    this.status = status;
    this.duration = duration;
    this.attempt = attempt;
    this.exceptionCount = exceptionCount;
    if (stats) this.stats = stats;
    this.summary = summary;
    this.detail = detail;
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
    const { summary, detail, ...meta } = this.toJSON();
    return {
      ...meta,
      summary: await sealer.seal(JSON.stringify(summary), JobRunRecord.summaryAad(this.id)),
      detail: await sealer.seal(JSON.stringify(detail), JobRunRecord.detailAad(this.id))
    };
  }

  /**
   * @param {import('../crypto.js').SyncSealer} sealer
   * @returns {Object}
   */
  sealSync(sealer) {
    const { summary, detail, ...meta } = this.toJSON();
    return {
      ...meta,
      summary: sealer.seal(JSON.stringify(summary), JobRunRecord.summaryAad(this.id)),
      detail: sealer.seal(JSON.stringify(detail), JobRunRecord.detailAad(this.id))
    };
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  static summaryAad(id) {
    return `job:summary:${id}`;
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  static detailAad(id) {
    return `job:detail:${id}`;
  }
}
