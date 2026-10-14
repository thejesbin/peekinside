/**
 * Groups exceptions into issues: exceptions with the same fingerprint are the same problem.
 *
 * The rule is part of the data contract with PeekInside Cloud, so both dashboards group the same
 * way:
 *
 *   with in-app frames:  name + "\n" + the top three in-app frames as "relativeFile:function"
 *   without:             name + "\n" + code + "\n" + the normalized message
 *
 * hashed with SHA-256 and cut to 16 hex characters. Line numbers are left out on purpose, so an
 * edit above the throwing line keeps the issue together, and the message is normalized so that
 * "User 42 not found" and "User 43 not found" are one issue.
 */

import { createHash } from 'crypto';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RUN = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;
// Double-quoted and backtick strings anywhere; single-quoted strings only where a quote opens a
// string (start or after a non-word character), so the apostrophe in "can't" opens nothing.
const QUOTED = /"[^"\n]*"|`[^`\n]*`|(^|[^\w])'[^'\n]*'/g;

/**
 * Computes fingerprints.
 */
export class Fingerprint {
  /**
   * @param {Object} exception
   * @param {string} exception.name - Summary name
   * @param {string|null} exception.code
   * @param {string} exception.message - Summary message
   * @param {import('./frame-classifier.js').Frame[]} exception.frames - Top frame first
   * @returns {string} 16 lowercase hex characters
   */
  static of({ name, code, message, frames }) {
    const inApp = frames.filter((frame) => frame.inApp).slice(0, 3);
    const basis = inApp.length > 0
      ? `${name}\n${inApp.map((frame) => `${frame.relativeFile}:${frame.function ?? '?'}`).join('\n')}`
      : `${name}\n${code ?? ''}\n${Fingerprint.normalizeMessage(message)}`;
    return createHash('sha256').update(basis).digest('hex').slice(0, 16);
  }

  /**
   * Replaces the parts of a message that change from one occurrence to the next: quoted strings,
   * UUIDs, runs of 8+ hex digits and numbers.
   *
   * @param {string} message
   * @returns {string}
   * @example
   * Fingerprint.normalizeMessage('User 42 not found in "eu-west"') // 'User <num> not found in <str>'
   */
  static normalizeMessage(message) {
    return String(message ?? '')
      .replace(QUOTED, (match, before) => `${before ?? ''}<str>`)
      .replace(UUID, '<uuid>')
      .replace(HEX_RUN, '<hex>')
      .replace(NUMBER, '<num>');
  }
}
