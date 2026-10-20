/**
 * The ORM operation the code running now belongs to ("User.findMany"), so the database queries a
 * Prisma call runs through a driver adapter (pg, mysql2) are recorded with the call that ran them,
 * and with the app's line that made it: Prisma runs some of them on its own (an include's), where
 * the app's frame isn't on the stack.
 */

import { AsyncLocalStorage } from 'async_hooks';

const operations = new AsyncLocalStorage();

/**
 * Carries the current ORM operation through the async work it causes, and counts the driver
 * queries recorded for it: an operation whose queries can't be seen (Prisma 6's engine runs its
 * adapter outside the request's context) is recorded as a whole instead.
 */
export class Operation {
  /**
   * Runs `fn` as part of `operation`.
   *
   * @param {{ name: string, queries: number, caller?: Function|null }} operation - Such as
   *   { name: "User.findMany", queries: 0 }; `caller`, when the ORM captured its call site,
   *   returns the app's frame that made the call (a CallerInfo, or null)
   * @param {Function} fn
   * @returns {*} What fn returns
   */
  static run(operation, fn) {
    return operations.run(operation, fn);
  }

  /**
   * @returns {{ name: string, queries: number }|undefined} The operation the code running now
   *   belongs to
   */
  static current() {
    return operations.getStore();
  }

  /**
   * The app's frame that made the current operation's call, when the ORM captured it (read once
   * per operation): the queries the operation runs take their caller from it.
   *
   * @returns {import('../timeline/caller.js').CallerInfo|null}
   */
  static caller() {
    const operation = operations.getStore();
    if (!operation || typeof operation.caller !== 'function') return null;
    if (operation.found === undefined) {
      try {
        operation.found = operation.caller() || null;
      } catch (error) {
        operation.found = null;
      }
    }
    return operation.found;
  }

  /**
   * Notes a driver query recorded for the current operation, and returns the operation's name
   * for the query's span.
   *
   * @returns {string|undefined}
   */
  static noteQuery() {
    const operation = operations.getStore();
    if (!operation) return undefined;
    operation.queries++;
    return operation.name;
  }
}
