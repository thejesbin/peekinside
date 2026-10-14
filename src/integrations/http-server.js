/**
 * Integration for native http (and https) servers.
 */

import net from 'net';
import { FrameworkAdapter } from './framework-adapter.js';

/**
 * Records every request a server emits, before the app's own request listeners run.
 */
export class HttpServerAdapter extends FrameworkAdapter {
  static framework = 'http';

  /**
   * @param {*} target
   * @returns {boolean} Whether `target` is a server, or behaves like one
   */
  static matches(target) {
    return target instanceof net.Server ||
      (Boolean(target) && typeof target.on === 'function' && typeof target.emit === 'function' && typeof target.listen === 'function');
  }

  /**
   * Records the server's requests and learns its port once it listens.
   *
   * @param {import('http').Server} server
   * @returns {void}
   */
  attach(server) {
    this.servers.bind(server, { interceptRequests: true });
  }
}
