/**
 * The parts of a project's alert rules that only the app's server can check: conditions on a
 * request's path, user and response, and on an exception's or a log line's message, which reach
 * PeekInside Cloud sealed. The matcher fetches them now and then, checks each record before it is
 * sealed, and the transport sends which records met which rule with the batch: never what they
 * hold. Everything else about a rule (a status, a duration, an environment) is checked by
 * PeekInside Cloud itself.
 */

import { RequestContext } from '../exceptions/request-context.js';

// Fetched again this often, the first time this long after the transport first delivered.
const REFRESH_MS = 60_000;
const FIRST_FETCH_MS = 1000;
// The most of a response body checked for a "contains" condition.
const MAX_BODY = 64 * 1024;
const RULE_ID = /^rl[0-9a-z]{12}$/;

/**
 * @typedef {Object} SealedRule
 * @property {string} id - The rule's id
 * @property {'requests'|'exceptions'|'logs'} source
 * @property {{ field: string, op: 'is'|'is-not'|'contains'|'matches', value: string }[]} conditions
 */

export class RuleMatcher {
  /**
   * @param {Object} options
   * @param {() => Promise<{ rules: SealedRule[] }>} options.fetchRules - Asks PeekInside Cloud for them
   * @param {number} [options.refreshMs]
   */
  constructor({ fetchRules, refreshMs = REFRESH_MS }) {
    this.fetchRules = fetchRules;
    this.refreshMs = refreshMs;
    /** @type {SealedRule[]} */
    this.rules = [];
    this.timer = null;
    this.first = null;
  }

  /**
   * Fetches the rules shortly, then keeps them current. Its timers never keep the process alive:
   * a script that ends right away never waits for them.
   *
   * @returns {void}
   */
  start() {
    if (this.timer || this.first) return;
    this.first = RequestContext.outside(() =>
      setTimeout(() => {
        void this.refresh();
        this.timer = RequestContext.outside(() => setInterval(() => void this.refresh(), this.refreshMs));
        if (typeof this.timer.unref === 'function') this.timer.unref();
      }, FIRST_FETCH_MS)
    );
    if (typeof this.first.unref === 'function') this.first.unref();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /**
   * @returns {Promise<void>} Never rejects: without rules, nothing is reported
   */
  async refresh() {
    try {
      const answer = await RequestContext.outside(() => this.fetchRules());
      this.rules = Array.isArray(answer && answer.rules) ? answer.rules.filter(valid) : [];
    } catch (error) {
      // Kept as they were: PeekInside Cloud may be briefly unreachable.
    }
  }

  /**
   * The rules a record meets on its sealed fields.
   *
   * @param {Object} record - A RequestRecord, ExceptionRecord or LogRecord, before it is sealed
   * @returns {{ rule: string, id: string }[]}
   */
  matches(record) {
    if (!this.rules.length || !record || typeof record.id !== 'string') return [];
    const source = sourceOf(record);
    if (!source) return [];
    const found = [];
    for (const rule of this.rules) {
      if (rule.source !== source) continue;
      if (rule.conditions.every((condition) => meets(condition, valuesOf(record, condition.field)))) found.push({ rule: rule.id, id: record.id });
    }
    return found;
  }
}

function valid(rule) {
  return (
    rule &&
    RULE_ID.test(rule.id) &&
    ['requests', 'exceptions', 'logs'].includes(rule.source) &&
    Array.isArray(rule.conditions) &&
    rule.conditions.length > 0 &&
    rule.conditions.every((condition) => condition && typeof condition.field === 'string' && typeof condition.value === 'string')
  );
}

function sourceOf(record) {
  const name = record.constructor && record.constructor.name;
  if (name === 'RequestRecord') return 'requests';
  if (name === 'ExceptionRecord') return 'exceptions';
  if (name === 'LogRecord') return 'logs';
  return null;
}

// The values a condition looks at (a user has several: its id, email and phone).
function valuesOf(record, field) {
  const summary = record.summary || {};
  switch (field) {
    case 'path':
      return [summary.path];
    case 'user': {
      const user = summary.user || {};
      return [user.id, user.email, user.phone].filter((value) => value !== undefined && value !== null).map(String);
    }
    case 'response': {
      const body = record.detail && record.detail.response ? record.detail.response.body : null;
      const text = typeof body === 'string' ? body : body && typeof body.text === 'string' ? body.text : '';
      return [text.slice(0, MAX_BODY)];
    }
    case 'name':
      return [summary.name];
    case 'message':
      return [summary.message];
    default:
      return [];
  }
}

// Text compares without case; "matches" takes * as anything. A condition is met by any of the values.
function meets(condition, values) {
  const wanted = String(condition.value).toLowerCase();
  const pattern = condition.op === 'matches' ? new RegExp(`^${wanted.split('*').map(escape).join('.*')}$`) : null;
  const met = values.some((value) => {
    if (typeof value !== 'string') return false;
    const text = value.toLowerCase();
    if (condition.op === 'is') return text === wanted;
    if (condition.op === 'is-not') return text !== wanted;
    if (condition.op === 'contains') return text.includes(wanted);
    if (condition.op === 'matches') return pattern.test(text);
    return false;
  });
  return condition.op === 'is-not' ? values.length === 0 || met : met;
}

function escape(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
