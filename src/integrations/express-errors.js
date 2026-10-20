/**
 * Records the errors an Express app handles, and the ones it leaves to Express, without changing
 * how either is answered.
 *
 * Express routes an error (thrown by a handler, passed to next(err), or a rejected promise in
 * Express 5) through the router's stack to the error-handling middleware, the ones with four
 * parameters. Two places see where it ends up:
 *
 * - The router's Layer runs every handler. A four-parameter handler receiving the error means the
 *   app handles it (handled: true). Layer is reached through `router.stack[i].constructor`, and
 *   its error method is `handle_error` in Express 4 and `handleError` in Express 5 (the "router"
 *   package). The patch is on the prototype, so routers created with express.Router() are covered
 *   too, and it only observes: the original runs with the same arguments.
 * - When no handler is left, the router calls the `done` callback that app.handle() gave it:
 *   Express's final handler, which answers 500 (handled: false). app.handle() is wrapped to tell
 *   when it uses the final handler (no callback: the app isn't mounted inside another one), and
 *   router.handle() to wrap that callback.
 *
 * An error middleware may log an error and pass it on with next(err): the record stays open until
 * the error reaches the final handler (unhandled) or the request ends (handled). Every step is
 * feature-detected; an Express version that doesn't fit is left alone.
 */

import { RequestContext } from '../exceptions/request-context.js';

const kInstalled = Symbol('peekInside.expressErrors');
const kLayerPatched = Symbol('peekInside.layerPatched');

/**
 * Installs the error hooks on Express apps (4 and 5).
 */
export class ExpressErrorHooks {
  /**
   * Hooks into an app's router, once per app. Does nothing for apps without an Express router
   * (Connect) or before the app has one.
   *
   * @param {Function} app - Express app
   * @returns {boolean} Whether the hooks are installed
   */
  static install(app) {
    try {
      if (!app || (typeof app !== 'function' && typeof app !== 'object')) return false;
      if (app[kInstalled]) return true;
      const router = routerOf(app);
      if (!router || typeof router.handle !== 'function' || typeof app.handle !== 'function') return false;

      Object.defineProperty(app, kInstalled, { value: true, configurable: true });
      wrapFinalHandler(app, router);
      patchLayers(router);
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Express 4 keeps the router in app._router (app.router throws there); Express 5 creates it on
// first access of app.router.
function routerOf(app) {
  if (app._router) return app._router;
  try {
    return app.router || null;
  } catch (error) {
    return null;
  }
}

function wrapFinalHandler(app, router) {
  // The request app.handle() is dispatching with Express's final handler. router.handle() runs
  // synchronously inside app.handle(), so one variable is enough.
  let finalDispatch = null;

  const originalAppHandle = app.handle;
  app.handle = function handle(req, res, callback) {
    if (typeof callback === 'function') return originalAppHandle.apply(this, arguments);
    const previous = finalDispatch;
    finalDispatch = req;
    try {
      return originalAppHandle.apply(this, arguments);
    } finally {
      finalDispatch = previous;
    }
  };

  const originalRouterHandle = router.handle;
  router.handle = function handle(req, res, out) {
    if (finalDispatch !== req || typeof out !== 'function') {
      return originalRouterHandle.apply(this, arguments);
    }
    const finalHandler = out;
    return originalRouterHandle.call(this, req, res, function done(error) {
      if (error && error !== 'route' && error !== 'router') noteError(req, error, false);
      return finalHandler.apply(this, arguments);
    });
  };
}

function patchLayers(router) {
  const stack = Array.isArray(router.stack) ? router.stack : [];
  for (const layer of stack) {
    const proto = layer && layer.constructor && layer.constructor.prototype;
    if (proto && patchLayer(proto)) return;
  }
}

// Observes four-parameter handlers receiving an error.
function patchLayer(proto) {
  if (proto[kLayerPatched]) return true;
  const method = typeof proto.handle_error === 'function' ? 'handle_error' : typeof proto.handleError === 'function' ? 'handleError' : null;
  if (!method) return false;

  const original = proto[method];
  const patched = {
    [method](error, req, res, next) {
      try {
        if (error && typeof this.handle === 'function' && this.handle.length === 4) noteError(req, error, true);
      } catch (failure) {
        // Never in the way of the app's error handling.
      }
      return original.apply(this, arguments);
    }
  }[method];

  Object.defineProperty(proto, kLayerPatched, { value: true, configurable: true });
  proto[method] = patched;
  return true;
}

// Handled errors stay open (an error middleware may still pass them on); unhandled ones are final.
function noteError(req, error, handled) {
  const context = RequestContext.of(req);
  if (context && context.capture) {
    context.capture.frameworkError(context, error, { mechanism: 'express', handled, open: handled });
  }
}
