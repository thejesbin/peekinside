/**
 * Fastify integration.
 */

import { ExchangeRecorder } from '../capture/exchange-recorder.js';
import { RequestContext } from '../exceptions/request-context.js';
import { FrameworkAdapter } from './framework-adapter.js';

/**
 * Records requests from a Fastify onRequest hook, and errors from an onError hook.
 *
 * onRequest runs before Fastify reads the body, so bodies are captured as Fastify parses them.
 * Hooks must be added before the app is ready, so attach before fastify.listen().
 */
export class FastifyAdapter extends FrameworkAdapter {
  static framework = 'fastify';

  /**
   * @param {*} app
   * @returns {boolean} Whether `app` looks like a Fastify instance
   */
  static matches(app) {
    return Boolean(app) && typeof app.addHook === 'function' && typeof app.decorate === 'function';
  }

  /**
   * Adds the hooks, and binds the Fastify server to learn the app's port.
   *
   * The rest of each request (Fastify's done()) runs inside the request's context. onError runs
   * before Fastify's error handler and can't change the response: an error counts as handled when
   * the app set its own error handler (setErrorHandler()).
   *
   * @param {Object} fastify - Fastify instance
   * @returns {void}
   */
  attach(fastify) {
    fastify.addHook('onRequest', (request, reply, done) => {
      ExchangeRecorder.setBodySource(request.raw, () => request.body);
      this.peekInside._intercept(request.raw, reply.raw, done, 'fastify');
    });
    if (this.peekInside.options.captureExceptions !== false) {
      fastify.addHook('onError', (request, reply, error, done) => {
        FastifyAdapter._noteError(request, error);
        done();
      });
    }
    if (fastify.server) {
      this.servers.bind(fastify.server);
    }
  }

  static _noteError(request, error) {
    try {
      const context = RequestContext.of(request.raw);
      if (context && context.capture) {
        context.capture.frameworkError(context, error, { mechanism: 'fastify', handled: FastifyAdapter._hasErrorHandler(request) });
      }
    } catch (failure) {
      // Recording must never change the error the app sees.
    }
  }

  // Fastify's own handler is named defaultErrorHandler; anything else was set by the app.
  static _hasErrorHandler(request) {
    try {
      const handler = request.server && request.server.errorHandler;
      return typeof handler === 'function' && handler.name !== 'defaultErrorHandler';
    } catch (error) {
      return false;
    }
  }
}
