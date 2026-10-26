/**
 * A Model Context Protocol server (https://modelcontextprotocol.io): JSON-RPC 2.0 messages in,
 * answers out, whatever carries them (standard input and output for `npx peekinside mcp`, HTTP for
 * the local hub's /mcp). It offers tools only, the ones in tools.js.
 */

// Newest first. The tool calls PeekInside uses read the same in all of them.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
};

/**
 * What AI tools read when they connect: what PeekInside knows, and how to use the tools well.
 */
export const INSTRUCTIONS = `PeekInside records what a Node.js app does: every request (headers, bodies, response), errors with their stack traces and source lines, database queries (N+1 patterns, slow and duplicate queries) and outgoing HTTP calls on a timeline per request, logs, background and scheduled jobs, and its processes' memory, CPU and event loop.

To fix errors: list_errors, then get_error with an issue id for its stack trace and the request behind it, then read the app's code at the frames marked ▶. After a fix, replay_request (local dashboard) sends the request again to check it, and resolve_error marks the issue resolved.
For slow endpoints: list_requests with sort "slowest" or min_duration, get_request for its timeline, and list_queries for N+1 patterns and slow statements across requests.
For memory leaks, high CPU or a blocked event loop: get_runtime.
Ids in answers are for the next call: request, exception, issue and job run ids.`;

/**
 * Answers MCP messages with a toolbox.
 */
export class McpServer {
  /**
   * @param {Object} options
   * @param {import('./tools.js').Toolbox} options.toolbox
   * @param {string} options.version - PeekInside's version
   * @param {string} [options.instructions=INSTRUCTIONS]
   */
  constructor({ toolbox, version, instructions = INSTRUCTIONS }) {
    this.toolbox = toolbox;
    this.version = version;
    this.instructions = instructions;
    this.client = null;
  }

  /**
   * Answers one message, or a batch of them.
   *
   * @param {*} message - Parsed JSON
   * @returns {Promise<Object|Object[]|null>} The response; null when there's none to send (a
   *   notification, or a response from the client)
   */
  async handle(message) {
    if (Array.isArray(message)) {
      if (!message.length) return failure(null, ERRORS.invalidRequest, 'Empty batch');
      const responses = (await Promise.all(message.map((item) => this.handleOne(item)))).filter(Boolean);
      return responses.length ? responses : null;
    }
    return this.handleOne(message);
  }

  /**
   * @param {*} message
   * @returns {Promise<Object|null>}
   */
  async handleOne(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return failure(validId(message && message.id) ? message.id : null, ERRORS.invalidRequest, 'Invalid Request');
    }
    const { id, method, params } = message;
    // A response to something this server asked (it never asks): nothing to answer.
    if (method === undefined) return null;
    if (typeof method !== 'string') return failure(validId(id) ? id : null, ERRORS.invalidRequest, 'Invalid Request');
    const notification = id === undefined;
    if (!notification && !validId(id)) return failure(null, ERRORS.invalidRequest, 'Invalid Request');
    if (notification) return null;

    try {
      return success(id, await this.dispatch(method, params && typeof params === 'object' ? params : {}));
    } catch (error) {
      if (error instanceof RpcError) return failure(id, error.code, error.message);
      return failure(id, ERRORS.internal, error && error.message ? error.message : 'Internal error');
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: await this.toolbox.definitions() };
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !this.toolbox.has(name)) throw new RpcError(ERRORS.invalidParams, `Unknown tool: ${typeof name === 'string' ? name : ''}`);
        if (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
          throw new RpcError(ERRORS.invalidParams, 'Tool arguments must be an object');
        }
        const result = await this.toolbox.call(name, params.arguments || {});
        return { content: [{ type: 'text', text: result.text }], isError: result.isError };
      }
      // Asked by some clients whatever the capabilities say: nothing of either here.
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new RpcError(ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  initialize(params) {
    const asked = params.protocolVersion;
    this.client = params.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo : null;
    return {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'peekinside', title: 'PeekInside', version: this.version },
      instructions: this.instructions
    };
  }
}

/** A JSON-RPC error to answer with. */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The answer to a message that isn't JSON.
 *
 * @returns {Object}
 */
export function parseFailure() {
  return failure(null, ERRORS.parse, 'Parse error');
}

function success(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}
