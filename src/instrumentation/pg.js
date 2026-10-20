/**
 * node-postgres (pg 8) queries on the request's timeline. Knex, Sequelize, TypeORM, Drizzle,
 * Kysely and Prisma's pg adapter all send their queries through it.
 *
 * - Client.prototype.query starts the span, for every calling form: text, a config object, a
 *   Submittable (pg.Query, pg-cursor, pg-query-stream), with a callback or a promise. It returns
 *   exactly what pg returns: the promise pg created, the Submittable, or undefined.
 * - The span ends when the query does, in Query#handleReadyForQuery / Query#handleError: the
 *   methods pg's client calls on every query, whatever form it was sent in. Nothing is added to the
 *   promise the app gets, and no listener to the query.
 * - To know which span a query belongs to, Query.prototype gets a `callback` accessor: the Query
 *   constructor assigns `this.callback`, inside client.query(), and the accessor turns that into
 *   the same own property a plain assignment would create, while noting the span.
 * - A pool hands a released client to the next waiting connect() from inside another request's
 *   handling; queued callbacks are bound to the context they were queued in, so each query lands
 *   on its own request's timeline. pool.query() also reads the caller, which a pooled query run
 *   from a callback can no longer find on the stack.
 */

import { AsyncResource } from 'async_hooks';
import { Caller } from '../timeline/caller.js';
import { Timeline } from '../timeline/timeline.js';
import { Operation } from './operation.js';
import { ownerOf, patchMethod } from './patch.js';

const kSpan = Symbol('peekInside.querySpan');
const kAccessor = Symbol('peekInside.callbackAccessor');
// The span of the query being created inside client.query(), for the callback accessor.
let pending = null;

/**
 * Patches a pg module.
 */
export class PgInstrumentation {
  /**
   * @param {*} pg - What require('pg') returns
   * @returns {boolean} Whether it was recognized and patched
   */
  static patch(pg) {
    try {
      const Client = pg && pg.Client;
      if (typeof Client !== 'function' || !Client.prototype || typeof Client.prototype.query !== 'function') return false;
      const Query = pg.Query || Client.Query;
      if (typeof Query === 'function') patchQuery(Query.prototype);
      patchClient(ownerOf(Client.prototype, 'query'), Query);
      if (typeof pg.Pool === 'function') patchPool(pg.Pool.prototype);
      return true;
    } catch (error) {
      return false;
    }
  }
}

function patchClient(owner, Query) {
  patchMethod(owner, 'query', (original) => function query(config, values, callback) {
    const timeline = Timeline.current();
    if (!timeline || config === null || config === undefined || !timeline.settings.captureQueries) {
      return original.apply(this, arguments);
    }

    let text;
    let params;
    try {
      if (typeof config === 'string') {
        text = config;
        params = Array.isArray(values) ? values : undefined;
      } else if (typeof config === 'object') {
        // pg-query-stream keeps its statement on the cursor it wraps.
        const source = typeof config.text !== 'string' && config.cursor && typeof config.cursor.text === 'string' ? config.cursor : config;
        text = source.text;
        params = Array.isArray(source.values) ? source.values : Array.isArray(values) ? values : undefined;
      }
    } catch (error) {
      text = undefined;
    }
    if (typeof text !== 'string') return original.apply(this, arguments);

    const span = timeline.query({ system: 'postgresql', client: 'pg', text, params, operation: Operation.noteQuery() });
    if (!span) return original.apply(this, arguments);

    const submittable = typeof config === 'object' && typeof config.submit === 'function';
    const previous = pending;
    pending = submittable ? null : span;
    let returned = false;
    try {
      const result = original.apply(this, arguments);
      returned = true;
      return result;
    } finally {
      // The accessor took the span if a Query was created; otherwise it is still here.
      const untaken = pending === span;
      pending = previous;
      if (!returned) {
        span.cancel();
      } else if (submittable) {
        attach(config, span, Query);
      } else if (untaken) {
        // A pg version whose Query doesn't assign callback in its constructor: no way to see the
        // end, so the span stays open (its duration is null).
      }
    }
  });
}

// Query.prototype: the end of every query, and the accessor that tags new queries with their span.
function patchQuery(proto) {
  if (!proto || proto[kAccessor]) return;
  const existing = Object.getOwnPropertyDescriptor(proto, 'callback');
  if (!existing) {
    Object.defineProperty(proto, 'callback', {
      configurable: true,
      enumerable: false,
      get() {
        return undefined;
      },
      set(value) {
        Object.defineProperty(this, 'callback', { value, writable: true, enumerable: true, configurable: true });
        if (pending && !this[kSpan]) {
          Object.defineProperty(this, kSpan, { value: pending, writable: true, configurable: true });
          pending = null;
        }
      }
    });
  }
  Object.defineProperty(proto, kAccessor, { value: true });

  patchMethod(proto, 'handleReadyForQuery', (original) => function handleReadyForQuery(con) {
    const span = this[kSpan];
    // A query canceled by an error ends in handleError, which this calls.
    if (span && !this._canceledDueToError) {
      this[kSpan] = null;
      span.end({ rows: rowsOf(this._results) });
    }
    return original.apply(this, arguments);
  });
  patchMethod(proto, 'handleError', (original) => function handleError(err, connection) {
    const span = this[kSpan];
    if (span) {
      this[kSpan] = null;
      span.end({ error: this._canceledDueToError || err });
    }
    return original.apply(this, arguments);
  });
}

// A Submittable the app created: pg.Query instances end through the patched prototype; other
// classes (pg-cursor, pg-query-stream) through their own handlers, wrapped on the instance.
function attach(submittable, span, Query) {
  try {
    Object.defineProperty(submittable, kSpan, { value: span, writable: true, configurable: true });
    if (typeof Query === 'function' && submittable instanceof Query) return;
    for (const name of ['handleReadyForQuery', 'handleError']) {
      const handler = submittable[name];
      if (typeof handler !== 'function') continue;
      submittable[name] = function () {
        const current = this[kSpan];
        if (current) {
          this[kSpan] = null;
          // A cursor reads in batches: its last result holds only the last batch, so the row
          // count isn't known.
          current.end(name === 'handleError' ? { error: arguments[0] } : {});
        }
        return handler.apply(this, arguments);
      };
    }
  } catch (error) {
    span.end();
  }
}

// pg-pool: queued callbacks run in the context they were queued in; pool.query() reads the caller.
function patchPool(proto) {
  // Bound whatever the caller's context: otherwise a callback queued outside any request (or by a
  // request that has already answered) runs in the context of the request that freed the client.
  patchMethod(ownerOf(proto, 'connect'), 'connect', (original) => function connect(cb) {
    if (typeof cb === 'function') {
      return original.call(this, AsyncResource.bind(cb));
    }
    return original.apply(this, arguments);
  });
  patchMethod(ownerOf(proto, 'query'), 'query', (original) => function query(text, values, cb) {
    const timeline = Timeline.current();
    if (!timeline || !timeline.settings.captureQueries) return original.apply(this, arguments);
    let sql;
    try {
      sql = typeof text === 'string' ? text : text && typeof text === 'object' ? text.text : undefined;
    } catch (error) {
      sql = undefined;
    }
    if (typeof sql !== 'string') return original.apply(this, arguments);
    const key = Timeline.sqlFingerprint(sql, 'postgresql');
    // Inside a Prisma operation, the caller is the line that made the Prisma call, when known.
    if (!timeline.needsCaller(key) || Operation.caller()) return original.apply(this, arguments);
    const caller = timeline.settings.caller.capture();
    const args = arguments;
    return Caller.withHint({ key, caller }, () => original.apply(this, args));
  });
}

// Rows returned or affected: one Result, or one per statement of a multi-statement query.
function rowsOf(results) {
  try {
    const list = Array.isArray(results) ? results : [results];
    let total = 0;
    let known = false;
    for (const result of list) {
      if (!result) continue;
      const count = Number.isInteger(result.rowCount) ? result.rowCount : Array.isArray(result.rows) ? result.rows.length : null;
      if (count !== null) {
        total += count;
        known = true;
      }
    }
    return known ? total : null;
  } catch (error) {
    return null;
  }
}
