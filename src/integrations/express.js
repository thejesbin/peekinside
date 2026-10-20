/**
 * Express integration, which also covers Connect and other apps built on use() middleware.
 */

import { ExpressErrorHooks } from './express-errors.js';
import { FrameworkAdapter } from './framework-adapter.js';

/**
 * Records requests through a middleware, and the errors Express routes (see express-errors.js).
 */
export class ExpressAdapter extends FrameworkAdapter {
  static framework = 'express';

  /**
   * @param {*} app
   * @returns {boolean} Whether `app` takes middleware through use()
   */
  static matches(app) {
    return Boolean(app) && typeof app.use === 'function';
  }

  /**
   * Middleware that records each exchange. Its place in the stack doesn't matter: request bodies
   * are captured as the app reads them, or taken from req.body when a parser ran first. The rest
   * of the request runs inside its context, so exceptions are linked to it.
   *
   * Used on its own (expressMiddleware()), it installs the error hooks on the app of the first
   * request it sees; errors that reach Express's final handler are recorded from the next request
   * on.
   *
   * @returns {Function} Middleware `(req, res, next)`
   */
  middleware() {
    return (req, res, next) => {
      if (this.peekInside.options.captureExceptions !== false && req && req.app) {
        ExpressErrorHooks.install(req.app);
      }
      return this.peekInside._intercept(req, res, next, 'express');
    };
  }

  /**
   * Adds the middleware, hooks into the app's error handling, and watches app.listen() for the
   * app's server.
   *
   * @param {Object} app - Express or Connect app
   * @returns {void}
   */
  attach(app) {
    app.use(this.middleware());
    // app.use() has created the router the hooks need.
    if (this.peekInside.options.captureExceptions !== false) {
      ExpressErrorHooks.install(app);
    }
    this.servers.patchListen(app);
  }
}
