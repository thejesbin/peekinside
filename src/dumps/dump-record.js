/**
 * One dump, as the local dashboard's Dumps page lists it: when, the label it was given, the line
 * that dumped it, the request or job run it belongs to, and the value. The list shows the value's
 * type and a one-line preview; the tree itself is the dump's detail, loaded when it is opened.
 *
 * Dumps are for development and go to the local dashboard only, so a record is never sealed.
 */

/**
 * A recorded dump.
 */
export class DumpRecord {
  /**
   * @param {Object} fields
   * @param {string} fields.id - UUID
   * @param {number} fields.occurredAt - ms since the epoch
   * @param {string} fields.environment
   * @param {string|null} [fields.release=null]
   * @param {string|null} [fields.requestId=null] - The request it was dumped during
   * @param {string|null} [fields.jobRunId=null] - The job run it was dumped during
   * @param {string|null} [fields.label=null] - What the app called it
   * @param {Object|null} [fields.location=null] - The line that dumped it: file (absolute),
   *   relativeFile, line, column, function
   * @param {{ type: string, preview: string, truncated: boolean }} fields.summary
   * @param {{ value: Object }} fields.detail - The value's tree (see DumpValue)
   */
  constructor({ id, occurredAt, environment, release = null, requestId = null, jobRunId = null, label = null, location = null, summary, detail }) {
    this.id = id;
    this.occurredAt = occurredAt;
    this.environment = environment;
    this.release = release;
    this.requestId = requestId;
    this.jobRunId = jobRunId;
    this.label = label;
    this.location = location;
    this.summary = summary;
    this.detail = detail;
  }

  /**
   * What a request's record lists of the dumps made while it was handled.
   *
   * @returns {{ id: string, label: string|null, type: string, preview: string }}
   */
  link() {
    return { id: this.id, label: this.label, type: this.summary.type, preview: this.summary.preview };
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
