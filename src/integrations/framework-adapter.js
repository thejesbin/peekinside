/**
 * Base class of the framework integrations.
 *
 * An adapter recognizes one kind of app and plugs PeekInside into it. Every adapter hands each
 * request to the same PeekInside#_intercept(), which also runs the rest of the request inside its
 * context, so recording works the same everywhere; adapters only differ in where they hook in,
 * how they see the framework's errors and how they find the app's HTTP server.
 */

/**
 * Plugs PeekInside into one kind of app.
 *
 * Subclasses set `framework`, and implement matches() and attach().
 */
export class FrameworkAdapter {
  /**
   * Framework name shown next to the app in the local dashboard.
   *
   * @type {string}
   */
  static framework = 'node';

  /**
   * Whether `app` is the kind of app this adapter handles. Detection is duck-typed, so PeekInside
   * never has to import (or depend on) the frameworks themselves.
   *
   * @param {*} app
   * @returns {boolean}
   */
  static matches(app) {
    return false;
  }

  /**
   * @param {{ _intercept: Function, options: Object }} peekInside - The PeekInside instance that
   *   records exchanges
   * @param {import('./server-binder.js').ServerBinder} servers - Tracks the app's HTTP servers
   */
  constructor(peekInside, servers) {
    this.peekInside = peekInside;
    this.servers = servers;
  }

  /**
   * Starts recording every request the app handles.
   *
   * @param {Object} app - An app this adapter matches
   * @returns {void}
   */
  attach(app) {
    throw new Error(`${this.constructor.name} does not implement attach()`);
  }
}
