/**
 * One email the app sent, as the local dashboard's Mail page lists it: when, from and to whom, its
 * subject, whether it went out, the line that sent it and the request or job run it belongs to.
 * The message itself (its HTML and text, headers and attachments' names) is the detail, loaded
 * when it is opened.
 *
 * Mail previews are for development and go to the local dashboard only, so a record is never sealed.
 */

/**
 * A recorded email.
 */
export class MailRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - UUID
   * @param {number} fields.occurredAt - When the app called sendMail() (ms since the epoch)
   * @param {string} fields.environment
   * @param {string|null} [fields.release=null]
   * @param {string|null} [fields.requestId=null] - The request it was sent during
   * @param {string|null} [fields.jobRunId=null] - The job run it was sent during
   * @param {Object|null} [fields.location=null] - The app's line that sent it: file (absolute),
   *   relativeFile, line, column, function
   * @param {Object} fields.summary - subject, from, to (the first few), recipients, attachments,
   *   html, transport, status ("sent" or "failed"), duration (ms), error
   * @param {Object} fields.detail - The message (see MailReader) and how the transport answered
   */
  constructor({ id, occurredAt, environment, release = null, requestId = null, jobRunId = null, location = null, summary, detail }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.requestId = requestId;
    this.jobRunId = jobRunId;
    this.location = location;
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
}
