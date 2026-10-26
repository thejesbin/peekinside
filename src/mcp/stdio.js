/**
 * MCP over standard input and output, as AI tools run local servers: one JSON-RPC message per
 * line each way. Nothing else may be written to standard output; logs go to standard error.
 */

import { parseFailure } from './server.js';

// A line this long without its end is not a message an AI tool sends.
const MAX_LINE = 16 * 1024 * 1024;

/**
 * Connects an McpServer to a pair of streams.
 */
export class StdioTransport {
  /**
   * @param {import('./server.js').McpServer} server
   * @param {Object} [streams]
   * @param {NodeJS.ReadableStream} [streams.input=process.stdin]
   * @param {NodeJS.WritableStream} [streams.output=process.stdout]
   */
  constructor(server, { input = process.stdin, output = process.stdout } = {}) {
    this.server = server;
    this.input = input;
    this.output = output;
    this.pending = new Set();
  }

  /**
   * Reads messages until the input ends, answering each as soon as it's ready (calls run side by
   * side: a slow one never holds up a ping).
   *
   * @returns {Promise<void>} Resolves once the input ended and every answer was written
   */
  run() {
    return new Promise((resolve) => {
      let buffer = '';
      this.input.setEncoding('utf8');
      this.input.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (line.trim()) this._receive(line);
        }
        if (buffer.length > MAX_LINE) {
          buffer = '';
          this._send(parseFailure());
        }
      });
      this.input.on('end', () => {
        if (buffer.trim()) this._receive(buffer);
        Promise.allSettled([...this.pending]).then(() => resolve());
      });
      this.input.on('error', () => resolve());
    });
  }

  _receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this._send(parseFailure());
      return;
    }
    const answer = this.server.handle(message).then((response) => {
      if (response) this._send(response);
    });
    this.pending.add(answer);
    answer.finally(() => this.pending.delete(answer));
  }

  _send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
