/**
 * mysql2 (3.x) queries on the request's timeline, including mysql2/promise, which runs on the same
 * core connections. Knex, Sequelize, TypeORM, Drizzle, Kysely and Prisma's MariaDB/MySQL adapters
 * send their queries through it.
 *
 * - Connection.prototype.query and .execute start the span. The statement is recorded with its
 *   placeholders and values (mysql2 formats query() values into the SQL client side; the timeline
 *   keeps them apart, so values can be masked by column).
 * - The span ends with the callback (mysql2/promise always passes one), or, in streaming mode, with
 *   the command's 'end' or 'error' event, seen by wrapping the command's emit(): no listener is
 *   added, so an unhandled 'error' still behaves as it would.
 * - Pool.getConnection callbacks run in the context they were queued in, and pool.query() /
 *   pool.execute() read the caller (the pooled query runs from a callback, on a later tick).
 */

import { AsyncResource } from 'async_hooks';
import { Caller } from '../timeline/caller.js';
import { Timeline } from '../timeline/timeline.js';
import { Operation } from './operation.js';
import { ownerOf, patchMethod } from './patch.js';

/**
 * Patches a mysql2 module.
 */
export class Mysql2Instrumentation {
  /**
   * @param {*} mysql2 - What require('mysql2') returns
   * @returns {boolean} Whether it was recognized and patched
   */
  static patch(mysql2) {
    try {
      const Connection = mysql2 && mysql2.Connection;
      // The core Connection queues commands; mysql2/promise's Connection only wraps one.
      if (typeof Connection !== 'function' || !Connection.prototype || typeof Connection.prototype.execute !== 'function' || typeof Connection.prototype.addCommand !== 'function') return false;
      for (const method of ['query', 'execute']) {
        patchMethod(ownerOf(Connection.prototype, method), method, (original) => function (sql, values, cb) {
          return run(this, original, arguments);
        });
      }
      if (typeof mysql2.Pool === 'function') patchPool(mysql2.Pool.prototype);
      return true;
    } catch (error) {
      return false;
    }
  }
}

function run(connection, original, args) {
  const timeline = Timeline.current();
  if (!timeline || !timeline.settings.captureQueries) return original.apply(connection, args);

  const sql = args[0];
  let text;
  let params;
  try {
    if (sql && typeof sql === 'object') {
      text = sql.sql;
      params = sql.values !== undefined ? sql.values : typeof args[1] !== 'function' ? args[1] : undefined;
    } else {
      text = sql;
      params = typeof args[1] === 'function' ? undefined : args[1];
    }
  } catch (error) {
    text = undefined;
  }
  if (typeof text !== 'string') return original.apply(connection, args);

  const span = timeline.query({ system: 'mysql', client: 'mysql2', text, params, operation: Operation.noteQuery() });
  if (!span) return original.apply(connection, args);

  const finish = (err, rows) => span.end(err ? { error: err } : { rows: rowsOf(rows) });
  const callArgs = Array.prototype.slice.call(args);
  let observed = false;
  if (sql && typeof sql === 'object' && typeof sql.onResult === 'function') {
    // A command built elsewhere (pool.query builds it, then hands it to a connection).
    const onResult = sql.onResult;
    sql.onResult = function (err, rows, fields) {
      finish(err, rows);
      return onResult.apply(this, arguments);
    };
    observed = true;
  } else {
    for (let i = 1; i < 3 && i < callArgs.length; i++) {
      if (typeof callArgs[i] !== 'function') continue;
      const callback = callArgs[i];
      callArgs[i] = function (err, rows, fields) {
        finish(err, rows);
        return callback.apply(this, arguments);
      };
      observed = true;
      break;
    }
  }

  let command;
  let returned = false;
  try {
    command = original.apply(connection, callArgs);
    returned = true;
  } finally {
    if (!returned) span.cancel();
  }
  if (!observed) observeEvents(command, span);
  return command;
}

// Streaming mode: the command emits 'result' per row, then 'end' (or 'error').
function observeEvents(command, span) {
  if (!command || typeof command.emit !== 'function') {
    span.end();
    return;
  }
  const emit = command.emit;
  let rows = 0;
  command.emit = function (event, value) {
    if (event === 'result') rows++;
    else if (event === 'end') span.end({ rows });
    else if (event === 'error') span.end({ error: value });
    return emit.apply(this, arguments);
  };
}

function patchPool(proto) {
  // Bound whatever the caller's context (see the pg integration).
  patchMethod(ownerOf(proto, 'getConnection'), 'getConnection', (original) => function getConnection(cb) {
    if (typeof cb === 'function') {
      return original.call(this, AsyncResource.bind(cb));
    }
    return original.apply(this, arguments);
  });
  for (const method of ['query', 'execute']) {
    patchMethod(ownerOf(proto, method), method, (original) => function (sql, values, cb) {
      const timeline = Timeline.current();
      if (!timeline || !timeline.settings.captureQueries) return original.apply(this, arguments);
      let text;
      try {
        text = sql && typeof sql === 'object' ? sql.sql : sql;
      } catch (error) {
        text = undefined;
      }
      if (typeof text !== 'string') return original.apply(this, arguments);
      const key = Timeline.sqlFingerprint(text, 'mysql');
      // Inside a Prisma operation, the caller is the line that made the Prisma call, when known.
      if (!timeline.needsCaller(key) || Operation.caller()) return original.apply(this, arguments);
      const caller = timeline.settings.caller.capture();
      const args = arguments;
      return Caller.withHint({ key, caller }, () => original.apply(this, args));
    });
  }
}

// Rows returned (a SELECT's rows) or affected (a ResultSetHeader's affectedRows).
function rowsOf(rows) {
  try {
    if (Array.isArray(rows)) return rows.length;
    if (rows && Number.isInteger(rows.affectedRows)) return rows.affectedRows;
  } catch (error) {
    // Unreadable: unknown.
  }
  return null;
}
