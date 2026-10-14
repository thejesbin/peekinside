/**
 * Finds the app's HTTP servers, to learn the port the app listens on (the local dashboard shows
 * it, and registers the app as soon as it is known) and, for plain http servers, to see every
 * request.
 *
 * Servers are found three ways: passed directly (http.Server, Fastify), returned by a patched
 * app.listen() (Express, Koa), or discovered from the socket of a request the app handled, which
 * catches servers created with http.createServer(app).
 */

/**
 * Binds each of the app's servers once.
 */
export class ServerBinder {
  /**
   * @param {{ _intercept: Function }} peekInside - Records exchanges, for servers whose requests
   *   are intercepted here
   * @param {Object} options
   * @param {(port: number) => void} options.onListening - Called once, with the first port the
   *   app listens on
   */
  constructor(peekInside, { onListening }) {
    this.peekInside = peekInside;
    this._onListening = onListening;
    this._bound = new WeakSet();

    /**
     * Port the app listens on, once known
     * @type {number|null}
     */
    this.appPort = null;
  }

  /**
   * Wraps app.listen() so the server it creates is bound as soon as it exists.
   *
   * @param {Object} app - Express or Koa app
   * @returns {void}
   */
  patchListen(app) {
    if (typeof app.listen !== 'function') {
      return;
    }
    const binder = this;
    const originalListen = app.listen;

    app.listen = function (...args) {
      const server = originalListen.apply(this, args);
      if (server && typeof server.emit === 'function') {
        binder.bind(server);
      }
      return server;
    };
  }

  /**
   * Binds the server a request arrived on, if it isn't bound yet.
   *
   * @param {import('http').IncomingMessage} req
   * @returns {void}
   */
  discover(req) {
    const socket = req.socket;
    const server = socket && (socket.server || socket._server);
    if (server && !this._bound.has(server)) {
      this.bind(server);
    }
  }

  /**
   * Watches a server for its port. A server is bound only once: binding it again changes nothing.
   *
   * @param {import('http').Server} server
   * @param {Object} [options]
   * @param {boolean} [options.interceptRequests=false] - Also record every request the server
   *   emits, for plain http servers where no middleware runs
   * @returns {void}
   */
  bind(server, { interceptRequests = false } = {}) {
    if (!server || typeof server.emit !== 'function' || this._bound.has(server)) {
      return;
    }
    this._bound.add(server);

    if (interceptRequests) {
      // Wrapping emit() runs PeekInside before every 'request' listener, including the app's, and
      // runs the listeners inside the request's context. An error a listener throws escapes
      // through here unchanged.
      const peekInside = this.peekInside;
      const originalEmit = server.emit;
      server.emit = function (event, req, res) {
        if (event === 'request' && req && res) {
          const args = arguments;
          return peekInside._intercept(req, res, () => originalEmit.apply(this, args), 'http');
        }
        return originalEmit.apply(this, arguments);
      };
    }

    if (typeof server.once === 'function') {
      const onListening = () => this._noteListening(server);
      if (server.listening) {
        onListening();
      } else {
        server.once('listening', onListening);
      }
    }
  }

  // The first port seen is the app's port; servers on pipes or sockets have no port.
  _noteListening(server) {
    const address = typeof server.address === 'function' ? server.address() : null;
    const port = address && typeof address === 'object' ? address.port : null;
    if (port === null || this.appPort !== null) {
      return;
    }
    this.appPort = port;
    this._onListening(port);
  }
}
