/**
 * Hono integration, for Hono apps served on Node.js by @hono/node-server.
 *
 * node-server hands each request to app.fetch() along with the Node.js request and response
 * (`env.incoming` and `env.outgoing`), so app.fetch is wrapped to record them; the rest of the
 * request runs inside its context. node-server reads app.fetch when serve() is called, so attach
 * before serve().
 *
 * Hono catches what a handler throws and passes it to the app's error handler (app.onError()), or
 * to its default one, which answers 500 and logs it. The error handler is wrapped, whenever the app
 * sets it, to see each error: handled when the app set its own handler, unhandled with Hono's. A
 * sub-app mounted with its own error handler (app.route()) answers its errors itself; they are found
 * on the context (c.error) once the route's handler returns. HTTPExceptions with a 4xx status are
 * how an app answers bad requests, and aren't recorded.
 *
 * Route patterns ("/users/:id") come from the router: each handler it matches for a request is
 * wrapped to note its route when it runs, and to forget it when it hands the request on (next()),
 * so a request's route is the one of the handler that answered it, wherever PeekInside was attached
 * among the app's routes and middleware.
 */

import { RequestContext } from '../exceptions/request-context.js';
import { FrameworkAdapter } from './framework-adapter.js';

const kAttached = Symbol('peekInside.hono');

/**
 * Records a Hono app's requests from app.fetch(), its errors from its error handler, and its routes
 * from its router.
 */
export class HonoAdapter extends FrameworkAdapter {
  static framework = 'hono';

  /**
   * @param {*} app
   * @returns {boolean} Whether `app` looks like a Hono app
   */
  static matches(app) {
    return Boolean(app) && typeof app.fetch === 'function' && typeof app.route === 'function' && typeof app.onError === 'function' && Array.isArray(app.routes);
  }

  /**
   * Wraps app.fetch, the error handler and the router's match(). An app is wrapped once.
   *
   * @param {Object} app - Hono app
   * @returns {void}
   */
  attach(app) {
    if (app[kAttached]) return;
    Object.defineProperty(app, kAttached, { value: true });
    if (this.peekInside.options.captureExceptions !== false) wrapErrorHandler(app);
    wrapRouter(app.router);
    wrapFetch(app, this.peekInside);
  }
}

function wrapFetch(app, peekInside) {
  const original = app.fetch;
  app.fetch = function fetch(request, env) {
    const incoming = env && env.incoming;
    const outgoing = env && env.outgoing;
    // Elsewhere than node-server (app.request() in tests, other runtimes): nothing to record.
    if (!incoming || !outgoing || typeof outgoing.on !== 'function') return original.apply(this, arguments);
    const args = arguments;
    return peekInside._intercept(incoming, outgoing, () => dispatch(original, this, args, incoming), 'hono');
  };
}

// What escapes app.fetch() is what Hono itself didn't handle: a value thrown that isn't an Error,
// or an error handler that threw. node-server answers it with a 500.
function dispatch(original, self, args, incoming) {
  let result;
  try {
    result = original.apply(self, args);
  } catch (error) {
    noteError(incoming, error, false);
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(undefined, (error) => {
      noteError(incoming, error, false);
      throw error;
    });
  }
  return result;
}

// app.errorHandler becomes an accessor: setting it (app.onError() does) keeps the wrapper in front.
function wrapErrorHandler(app) {
  const isDefault = defaultHandlerTest(app);
  let current = app.errorHandler;
  if (typeof current !== 'function') return;
  const wrapper = function (error, c) {
    noteError(c && c.env && c.env.incoming, error, !isDefault(current));
    return current.apply(this, arguments);
  };
  Object.defineProperty(app, 'errorHandler', {
    configurable: true,
    enumerable: true,
    get() {
      return wrapper;
    },
    set(handler) {
      current = handler;
    }
  });
}

// Hono's own error handler is the one a new app of the same class has; when one can't be made,
// it is known by its name.
function defaultHandlerTest(app) {
  let fallback = null;
  try {
    const probe = typeof app.constructor === 'function' ? new app.constructor() : null;
    fallback = probe && typeof probe.errorHandler === 'function' ? probe.errorHandler : null;
  } catch (error) {
    fallback = null;
  }
  return (handler) => (fallback ? handler === fallback : Boolean(handler) && handler.name === 'errorHandler');
}

// The router's match() becomes an accessor too: Hono's routers replace it on first use (and the
// RegExpRouter then calls the replacement, whose result is wrapped already).
function wrapRouter(router) {
  if (!router || typeof router.match !== 'function') return;
  let current = router.match;
  const cache = { tuples: new WeakMap(), lists: new WeakMap(), own: new WeakSet() };
  const match = function match() {
    return withRoutes(current.apply(this, arguments), cache);
  };
  Object.defineProperty(router, 'match', {
    configurable: true,
    get() {
      return match;
    },
    set(fn) {
      current = fn;
    }
  });
}

// A match result is [[[handler, route], params][], stash?]: the same result, its handlers wrapped.
// Lists and handlers are wrapped once each (the RegExpRouter returns the same list for a route).
function withRoutes(result, { tuples, lists, own }) {
  if (!Array.isArray(result) || !Array.isArray(result[0]) || own.has(result[0])) return result;
  const handlers = result[0];
  let wrapped = lists.get(handlers);
  if (!wrapped) {
    wrapped = handlers.map((entry) => {
      const tuple = Array.isArray(entry) ? entry[0] : null;
      if (!Array.isArray(tuple) || typeof tuple[0] !== 'function') return entry;
      let routed = tuples.get(tuple);
      if (!routed) {
        routed = [routeHandler(tuple[0], tuple[1]), tuple[1]];
        tuples.set(tuple, routed);
      }
      return [routed, entry[1]];
    });
    lists.set(handlers, wrapped);
    own.add(wrapped);
  }
  const copy = result.slice();
  copy[0] = wrapped;
  return copy;
}

function routeHandler(handler, route) {
  const pattern = route && typeof route.path === 'string' ? route.path : null;
  return function (c, next) {
    const context = c && c.env ? RequestContext.of(c.env.incoming) : null;
    if (!context) return handler.apply(this, arguments);
    context.noteRoute({ route: pattern, params: () => c.req.param() });
    const args = Array.prototype.slice.call(arguments);
    if (typeof next === 'function') {
      args[1] = function () {
        context.noteRoute({ route: null, params: null });
        return next.apply(this, arguments);
      };
    }
    const result = handler.apply(this, args);
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        noteCaught(context, c);
        return value;
      });
    }
    noteCaught(context, c);
    return result;
  };
}

// A sub-app's own error handler answered an error: Hono leaves it on the context.
function noteCaught(context, c) {
  try {
    if (c.error && context.capture) context.capture.frameworkError(context, c.error, { mechanism: 'hono', handled: true, open: true });
  } catch (failure) {
    // Recording must never change the response.
  }
}

// An error the app's own handler answers stays open: the handler may still throw it on.
function noteError(incoming, error, handled) {
  try {
    const context = RequestContext.of(incoming) || RequestContext.current();
    if (context && context.capture) context.capture.frameworkError(context, error, { mechanism: 'hono', handled, open: handled });
  } catch (failure) {
    // Recording must never change the error the app sees.
  }
}
