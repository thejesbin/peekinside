/**
 * Prisma Client operations on the request's timeline.
 *
 * Every Prisma Client call (prisma.user.findMany(), $queryRaw, ...) goes through the client's
 * _request(), which gets the model, the action, the arguments and the call site Prisma captured
 * where the app made the call.
 *
 * - With a query engine (Prisma 5 and 6 without driver adapters), the database work happens
 *   inside the engine, out of reach: each operation is one span, such as
 *   `User.findMany({ where: { id: ? }, include: { posts: ? } })`, with the arguments, masked, as
 *   its parameters. Raw queries ($queryRaw, $executeRaw) are recorded as their SQL and values.
 * - With a driver adapter (pg, mysql2 underneath), the driver's queries are recorded by the pg and
 *   mysql2 integrations, with the operation that ran them ("User.findMany") and its caller (also
 *   for the queries Prisma runs on its own, an include's); the operation itself isn't recorded, so
 *   nothing is counted twice. Prisma 6 runs adapters from its WASM engine, outside the request's
 *   context, where the driver queries can't be told apart: an operation none of whose queries
 *   were seen is recorded as a whole, as with the query engine.
 *
 * The caller comes from Prisma's call site: Prisma runs the operation lazily, when its promise is
 * awaited, by which time the app's frame is no longer on the stack. Without a call site
 * (errorFormat "minimal"), the caller is unknown.
 */

import { performance } from 'perf_hooks';
import { Shape } from '../timeline/shape.js';
import { Timeline } from '../timeline/timeline.js';
import { Operation } from './operation.js';
import { ownerOf, patchMethod } from './patch.js';

const SYSTEMS = { postgresql: 'postgresql', postgres: 'postgresql', cockroachdb: 'postgresql', mysql: 'mysql', sqlite: 'sqlite', sqlserver: 'sqlserver', mongodb: 'mongodb' };
const RAW = new Set(['queryRaw', 'executeRaw']);
const SINGLE = /^(findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow|create|update|upsert|delete)$/;

/**
 * Patches Prisma Client.
 */
export class PrismaInstrumentation {
  /**
   * @param {*} target - A PrismaClient class, a PrismaClient instance, or the @prisma/client module
   * @returns {boolean} Whether it was recognized and patched
   */
  static patch(target) {
    try {
      const proto = prototypeOf(target);
      if (!proto) return false;
      patchMethod(ownerOf(proto, '_request'), '_request', (original) => function _request(params) {
        const timeline = Timeline.current();
        if (!timeline || !timeline.settings.captureQueries || !params || typeof params !== 'object') {
          return original.apply(this, arguments);
        }
        const action = String(params.action || '');
        const name = params.model ? `${params.model}.${action}` : String(params.clientMethod || action || 'query');
        const args = arguments;

        // The span's description, or null if the call can't be described (it runs unrecorded).
        const describe = (startedAt) => {
          try {
            const statement = RAW.has(action) ? rawStatement(params.args, this._activeProvider) : null;
            return {
              system: SYSTEMS[this._activeProvider] || 'other',
              client: 'prisma',
              text: statement ? statement.text : `${name}(${Shape.of(params.args)})`,
              sql: Boolean(statement),
              params: statement ? statement.values : params.args,
              caller: () => callerOf(timeline.settings.caller, params.callsite),
              startedAt
            };
          } catch (error) {
            return null;
          }
        };

        // A driver adapter: the driver integrations record the queries, labeled with the operation
        // and with its caller.
        if (usesAdapter(this)) {
          const operation = { name, queries: 0, caller: params.callsite ? () => callerOf(timeline.settings.caller, params.callsite) : null };
          const startedAt = performance.now();
          const result = Operation.run(operation, () => original.apply(this, args));
          if (!result || typeof result.then !== 'function') return result;
          // None of its queries was seen: record the operation itself, from its start.
          const settle = (outcome) => {
            if (operation.queries > 0) return;
            const description = describe(startedAt);
            const span = description && timeline.query(description);
            if (span) span.end(outcome);
          };
          return result.then(
            (value) => {
              settle({ rows: rowsOf(action, value) });
              return value;
            },
            (error) => {
              settle({ error });
              throw error;
            }
          );
        }

        const description = describe(performance.now());
        const span = description && timeline.query(description);
        if (!span) return original.apply(this, arguments);

        let result;
        let returned = false;
        try {
          result = original.apply(this, arguments);
          returned = true;
        } finally {
          if (!returned) span.cancel();
        }
        // Prisma's own promise, awaited by its PrismaPromise: not the one the app holds.
        if (result && typeof result.then === 'function') {
          return result.then(
            (value) => {
              span.end({ rows: rowsOf(action, value) });
              return value;
            },
            (error) => {
              span.end({ error });
              throw error;
            }
          );
        }
        span.end();
        return result;
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

// The class's prototype, from the class itself, an instance, or the @prisma/client module.
function prototypeOf(target) {
  if (!target) return null;
  if (typeof target === 'function' && target.prototype && typeof target.prototype._request === 'function') return target.prototype;
  if (typeof target === 'object' && typeof target._request === 'function') return Object.getPrototypeOf(target);
  if (typeof target === 'object' && typeof target.PrismaClient === 'function') return prototypeOf(target.PrismaClient);
  return null;
}

function usesAdapter(client) {
  try {
    return Boolean(client._engineConfig && client._engineConfig.adapter);
  } catch (error) {
    return false;
  }
}

// $queryRaw`...` passes a Sql object (text with $1 placeholders, sql with ?); $queryRawUnsafe
// passes [query, ...values].
function rawStatement(args, provider) {
  if (Array.isArray(args)) return { text: String(args[0]), values: args.slice(1) };
  if (!args || typeof args !== 'object') return null;
  const pg = SYSTEMS[provider] === 'postgresql';
  const text = pg ? args.text ?? args.sql : args.sql ?? args.text;
  if (typeof text !== 'string') return null;
  return { text, values: Array.isArray(args.values) ? args.values : undefined };
}

// The app's frame from the stack Prisma captured at the call, or from Prisma's own location.
function callerOf(caller, callsite) {
  if (!callsite || typeof callsite !== 'object') return null;
  const error = callsite._error;
  if (error && typeof error.stack === 'string') return caller.fromStack(error.stack);
  if (typeof callsite.getLocation === 'function') return caller.fromLocation(callsite.getLocation());
  return null;
}

function rowsOf(action, value) {
  try {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object' && Number.isInteger(value.count) && /Many$/.test(action)) return value.count;
    if (action === 'executeRaw' && Number.isInteger(value)) return value;
    if (SINGLE.test(action)) return value ? 1 : 0;
  } catch (error) {
    // A result that can't be read: the row count is unknown.
  }
  return null;
}
