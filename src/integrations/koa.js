/**
 * Koa integration.
 */

import { ExchangeRecorder } from '../capture/exchange-recorder.js';
import { RequestContext } from '../exceptions/request-context.js';
import { FrameworkAdapter } from './framework-adapter.js';

/**
 * Records requests through a Koa middleware, and the errors that propagate out of the middleware
 * after it.
 *
 * Errors are seen by catching around `await next()` and rethrowing them unchanged, so Koa still
 * answers them and still emits 'error' (which logs them when the app has no listener). No 'error'
 * listener is added: Koa only logs errors itself while the app has none.
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
   * Errors are recorded as unhandled: Koa's default handler answers them, unless middleware
   * registered before this one catches them, so attach PeekInside before your own error handler.
   *
   * @returns {Function} Koa middleware `(ctx, next)`
   */
  middleware() {
    return (ctx, next) => {
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
    this.servers.patchListen(app);
  }

  // Runs the downstream middleware and records what it throws, then rethrows it unchanged.
  static async _next(ctx, next) {
    try {
      await next();
    } catch (error) {
      try {
        const context = RequestContext.of(ctx.req);
        if (context && context.capture) {
          context.capture.frameworkError(context, error, { mechanism: 'koa', handled: false });
        }
      } catch (failure) {
        // Recording must never change the error the app sees.
      }
      throw error;
    }
  }
}
