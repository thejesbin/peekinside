/**
 * MongoDB driver (5.x and 6.x) operations on the request's timeline, and so Mongoose's (7 and 8).
 *
 * The hook is the driver's internal Connection#command, which every operation goes through
 * (finds, aggregations, writes, cursor batches), whatever API the app used. Commands the driver
 * sends for itself (handshakes, authentication, session cleanup) are left out.
 *
 * Each command becomes a statement such as `orders.find({ customerId: ?, status: { $in: ? } })`:
 * the collection, the command and the shape of its main argument, without values. The values
 * themselves (filter, update, documents, pipeline...) are the span's parameters, masked by key.
 *
 * In driver 6 the command is async and the request's context follows its promise chain. In driver
 * 5 it takes a callback, and the pool's wait queue hands connections out from other requests'
 * callbacks: queued checkOut callbacks are bound to the context they were queued in.
 */

import { AsyncResource } from 'async_hooks';
import { Shape } from '../timeline/shape.js';
import { Timeline } from '../timeline/timeline.js';
import { Operation } from './operation.js';
import { ownerOf, patchMethod } from './patch.js';

// Commands the driver runs for itself, never for the app's queries.
const INTERNAL = new Set([
  'hello', 'ismaster', 'saslstart', 'saslcontinue', 'authenticate', 'getnonce', 'logout', 'endsessions',
  'killcursors', 'buildinfo', 'ping', 'getparameter', 'serverstatus', 'connectionstatus', 'getlasterror'
]);
// The fields of each command that carry the app's values.
const VALUE_FIELDS = ['filter', 'query', 'update', 'updates', 'deletes', 'documents', 'pipeline', 'key', 'sort', 'projection', 'limit', 'skip'];

/**
 * Patches a MongoDB driver.
 */
export class MongoInstrumentation {
  /**
   * @param {{ Connection: Function, ConnectionPool?: Function }} internals - The driver's internal
   *   classes (lib/cmap/connection.js, lib/cmap/connection_pool.js)
   * @returns {boolean} Whether they were recognized and patched
   */
  static patch({ Connection, ConnectionPool }) {
    try {
      if (typeof Connection !== 'function' || typeof Connection.prototype.command !== 'function') return false;
      patchCommand(ownerOf(Connection.prototype, 'command'));
      if (typeof ConnectionPool === 'function') patchPool(ConnectionPool.prototype);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * The statement text and parameters of a command, or null for the driver's own commands.
   *
   * @param {{ db?: string, collection?: string }} ns - The command's namespace
   * @param {Object} command - The command document, such as { find: 'orders', filter: {...} }
   * @returns {{ text: string, params: Object|undefined }|null}
   */
  static describe(ns, command) {
    if (!command || typeof command !== 'object') return null;
    const name = Object.keys(command)[0];
    if (!name || INTERNAL.has(name.toLowerCase())) return null;
    const target = command[name];
    // Database commands go to the "$cmd" collection: they are named after the database.
    const nsCollection = ns && ns.collection && ns.collection !== '$cmd' ? ns.collection : null;
    const collection = typeof target === 'string' ? target
      : typeof command.collection === 'string' ? command.collection
        : nsCollection || (ns && ns.db) || 'db';

    let shape = '';
    switch (name) {
      case 'find':
        shape = Shape.of(command.filter || {});
        break;
      case 'aggregate':
        shape = Shape.of(command.pipeline || []);
        break;
      case 'count':
      case 'distinct':
        shape = Shape.of(command.query || {});
        break;
      case 'insert':
        shape = Shape.of(Array.isArray(command.documents) && command.documents.length ? command.documents[0] : {});
        break;
      case 'update': {
        const first = Array.isArray(command.updates) ? command.updates[0] : null;
        shape = Shape.of({ q: (first && first.q) || {}, u: (first && first.u) || {} });
        break;
      }
      case 'delete': {
        const first = Array.isArray(command.deletes) ? command.deletes[0] : null;
        shape = Shape.of((first && first.q) || {});
        break;
      }
      case 'findAndModify':
        shape = Shape.of({ query: command.query || {}, update: command.update || {} });
        break;
      default:
        break;
    }

    let params;
    for (const field of VALUE_FIELDS) {
      // { update: 'orders', updates: [...] }: the command's own key names the collection.
      if (field === name || command[field] === undefined) continue;
      params = params || {};
      params[field] = command[field];
    }
    return { text: `${collection}.${name}(${shape})`, params };
  }
}

function patchCommand(owner) {
  patchMethod(owner, 'command', (original) => {
    // Driver 6's command is async and its last parameter is a response class (a function too);
    // driver 5's takes a callback. The method's kind says which, not the argument's type.
    const callbackStyle = original.constructor.name !== 'AsyncFunction';
    return commandWrapper(original, callbackStyle);
  });
}

function commandWrapper(original, callbackStyle) {
  return function command(ns, cmd) {
    const timeline = Timeline.current();
    if (!timeline || !timeline.settings.captureQueries) return original.apply(this, arguments);
    let described;
    try {
      described = MongoInstrumentation.describe(ns, cmd);
    } catch (error) {
      described = null;
    }
    if (!described) return original.apply(this, arguments);

    const span = timeline.query({ system: 'mongodb', client: 'mongodb', text: described.text, sql: false, params: described.params, operation: Operation.noteQuery() });
    if (!span) return original.apply(this, arguments);

    // Driver 5: command(ns, cmd, options, callback)
    const last = callbackStyle ? arguments[arguments.length - 1] : undefined;
    let args = arguments;
    if (typeof last === 'function') {
      args = Array.prototype.slice.call(arguments);
      args[args.length - 1] = function (err, reply) {
        span.end(err ? { error: err } : outcomeOf(reply));
        return last.apply(this, arguments);
      };
    }

    let result;
    let returned = false;
    try {
      result = original.apply(this, args);
      returned = true;
    } finally {
      if (!returned) span.cancel();
    }
    // Driver 6: an internal promise the driver awaits; the app never sees it.
    if (result && typeof result.then === 'function' && typeof last !== 'function') {
      return result.then(
        (reply) => {
          span.end(outcomeOf(reply));
          return reply;
        },
        (error) => {
          span.end({ error });
          throw error;
        }
      );
    }
    return result;
  };
}

// Driver 5's pool queues checkOut callbacks; bind them to the context they were queued in.
function patchPool(proto) {
  const owner = ownerOf(proto, 'checkOut');
  if (!owner) return;
  patchMethod(owner, 'checkOut', (original) => function checkOut(callback) {
    if (typeof callback === 'function') {
      const args = Array.prototype.slice.call(arguments);
      args[0] = AsyncResource.bind(callback);
      return original.apply(this, args);
    }
    return original.apply(this, arguments);
  });
}

// What a reply says: documents returned (a cursor's batch) or matched / written (n), and the
// first write error. A write that hit a duplicate key answers ok: 1 with writeErrors.
function outcomeOf(reply) {
  try {
    if (!reply || typeof reply !== 'object') return {};
    // Driver 6 cursor replies are read lazily; the batch size is cheap.
    if (typeof reply.batchSize === 'number') return { rows: reply.batchSize };
    // Other driver 6 replies are lazy BSON too; write replies are small.
    const object = typeof reply.toObject === 'function' ? reply.toObject() : reply;
    const failure = firstWriteError(object);
    const cursor = object.cursor;
    let rows = null;
    if (cursor && typeof cursor === 'object') {
      const batch = cursor.firstBatch || cursor.nextBatch;
      if (Array.isArray(batch)) rows = batch.length;
    } else if (Number.isInteger(object.n)) {
      rows = object.n;
    } else if (Array.isArray(object.values)) {
      rows = object.values.length;
    } else if ('value' in object) {
      rows = object.value ? 1 : 0;
    }
    return failure ? { rows, error: failure } : { rows };
  } catch (error) {
    return {};
  }
}

function firstWriteError(reply) {
  const writeError = Array.isArray(reply.writeErrors) && reply.writeErrors[0];
  const concernError = reply.writeConcernError;
  const error = writeError || concernError;
  if (!error || typeof error !== 'object') return null;
  const message = String(error.errmsg || error.message || 'write error');
  return error.code !== undefined ? `${error.code}: ${message}` : message;
}
