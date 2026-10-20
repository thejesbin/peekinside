/**
 * Koa integration.
 */

import { ExchangeRecorder } from '../capture/exchange-recorder.js';
import { RequestContext } from '../exceptions/request-context.js';
import { FrameworkAdapter } from './framework-adapter.js';

const kErrorHooks = Symbol('peekInside.koaErrors');

/**
 * Records requests through a Koa middleware, and the errors the app runs into, without changing
 * how either is answered.
 *
 * Errors are seen in three places, so where PeekInside sits among the app's middleware doesn't
 * matter:
 *
 * - Around `await next()` in PeekInside's middleware, for errors thrown after it, rethrown
 *   unchanged. Such an error stays open: the app's own error-handling middleware (registered
 *   before PeekInside's) may still answer it, which makes it handled.
 * - In Koa's default handler, `ctx.onerror()`, which answers 500: an error that reaches it is
 *   unhandled.
 * - In `app.emit('error', err, ctx)`, which error-handling middleware calls to report an error it
 *   answered, as Koa suggests: handled. emit() is observed, not listened to: Koa only logs errors
 *   itself while the app has no 'error' listener, so none is added.
 */
export class KoaAdapter extends FrameworkAdapter {
  static framework = 'koa';

  /**
   * @param {*} app
   * @returns {boolean} Whether `app` looks like a Koa application
   */
  static matches(app) {
    return Boolean(app) && typeof app.use === 'function' && typeof app.callback === 'function' && Array.isArray(app.middleware);
  }

  /**
   * Koa middleware that records each exchange from the underlying Node request and response.
   * Body parsers for Koa keep the parsed body on ctx.request, not on the Node request, so the
   * recorder is told where to look in case a parser read the body first.
   *
   * Used on its own (koaMiddleware()), it hooks into the app's error handling on the first request.
   *
   * @returns {Function} Koa middleware `(ctx, next)`
   */
  middleware() {
    return (ctx, next) => {
      if (this.peekInside.options.captureExceptions !== false) KoaAdapter._hookErrors(ctx.app);
      ExchangeRecorder.setBodySource(ctx.req, () => ctx.request.body);
      return this.peekInside._intercept(ctx.req, ctx.res, () => KoaAdapter._next(ctx, next), 'koa');
    };
  }

  /**
   * Adds the middleware and watches app.listen() for the app's server.
   *
   * @param {Object} app - Koa application
   * @returns {void}
   */
  attach(app) {
    app.use(this.middleware());
    if (this.peekInside.options.captureExceptions !== false) KoaAdapter._hookErrors(app);
    this.servers.patchListen(app);
  }

  // Runs the downstream middleware and records what it throws, then rethrows it unchanged.
  static async _next(ctx, next) {
    try {
      await next();
    } catch (error) {
      KoaAdapter._noteError(ctx.req, error, true);
      throw error;
    }
  }

  // Watches the app's default error handler and its 'error' events, once per app.
  static _hookErrors(app) {
    try {
      if (!app || app[kErrorHooks]) return;
      Object.defineProperty(app, kErrorHooks, { value: true });
      const context = app.context;
      if (context && typeof context.onerror === 'function') {
        const onerror = context.onerror;
        context.onerror = function (error) {
          // Only the errors it answers: after the response started, it can only log them.
          if (error != null && !this.headerSent && this.writable) KoaAdapter._noteError(this.req, error, false);
          return onerror.apply(this, arguments);
        };
      }
      if (typeof app.emit === 'function') {
        const emit = app.emit;
        app.emit = function (event, error, ctx) {
          if (event === 'error' && error != null && ctx && ctx.req) KoaAdapter._noteError(ctx.req, error, true);
          return emit.apply(this, arguments);
        };
      }
    } catch (error) {
      // An app that doesn't fit is recorded from the middleware alone.
    }
  }

  // An error the app may still answer stays open; one Koa's default handler answers is final.
  static _noteError(req, error, handled) {
    try {
      const context = RequestContext.of(req);
      if (context && context.capture) {
        context.capture.frameworkError(context, error, { mechanism: 'koa', handled, open: handled });
      }
    } catch (failure) {
      // Recording must never change the error the app sees.
    }
  }
}
