/**
 * A job run's context: what a request's context is to a request, for a background job. Code the
 * job runs (queries, outgoing calls, log lines, exceptions) finds the run through it and links
 * to it, with the same AsyncLocalStorage the requests use.
 */

import { randomUUID } from 'crypto';
import { RequestContext } from '../exceptions/request-context.js';

const NO_TARGET = Object.freeze({ url: '', pathname: '', search: '' });

/**
 * One job run.
 */
export class JobContext extends RequestContext {
  /**
   * @param {Object} fields
   * @param {import('../exceptions/exception-capture.js').ExceptionCapture} fields.capture
   * @param {string} fields.name - The job's name
   */
  constructor({ capture, name }) {
    super({ capture, req: null, recorder: null, target: NO_TARGET, integration: 'job' });
    /**
     * The id of the run's record
     * @type {string}
     */
    this.jobRunId = randomUUID();
    this.jobName = name;
  }

  /** A job has no request to show with its exceptions. */
  snapshot() {
    return null;
  }

  /** @returns {null} */
  requestLine() {
    return null;
  }
}
