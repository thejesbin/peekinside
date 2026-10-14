/**
 * Outgoing HTTP calls on the request's timeline: node:http/https requests (and every client built
 * on them: axios, got, node-fetch...) and fetch (undici, built into Node.js).
 *
 * Both are observed through diagnostics_channel, which Node.js publishes to without any patching:
 *
 * - node:http: 'http.client.request.start' (in the app's context, when the request is created)
 *   starts the span; 'http.client.response.finish' (when the response's headers arrive) gives the
 *   status; the span ends when the response's body has been read. Errors are seen by wrapping the
 *   request's and the response's emit(), never by adding an 'error' listener, which would change
 *   what an unhandled error does.
 * - fetch: 'undici:request:create' starts the span, 'undici:request:headers' gives the status,
 *   'undici:request:trailers' (the body is complete) or 'undici:request:error' ends it.
 *
 * Channels that don't exist in the running Node.js version are simply never published to.
 */

import dc from 'diagnostics_channel';
import { Timeline } from '../timeline/timeline.js';

let installed = false;
// node:http requests and undici requests -> their span and status.
const calls = new WeakMap();

/**
 * Subscribes to the channels, once per process.
 */
export class HttpInstrumentation {
  /**
   * @returns {void}
   */
  static install() {
    if (installed || typeof dc.subscribe !== 'function') return;
    installed = true;
    subscribe('http.client.request.start', onRequestStart);
    subscribe('http.client.response.finish', onResponse);
    subscribe('undici:request:create', onFetchCreate);
    subscribe('undici:request:headers', onFetchHeaders);
    subscribe('undici:request:trailers', onFetchTrailers);
    subscribe('undici:request:error', onFetchError);
  }
}

function subscribe(name, handler) {
  try {
    dc.subscribe(name, (message) => {
      try {
        handler(message);
      } catch (error) {
        // An observer must never break the app's call.
      }
    });
  } catch (error) {
    // Channel unavailable in this Node.js version.
  }
}

// --- node:http ---------------------------------------------------------------------------------

function onRequestStart({ request }) {
  const timeline = Timeline.current();
  if (!timeline || !request || calls.has(request)) return;
  // `host` is the hostname option; strip a port only from "name:port", never from an IPv6 address.
  const raw = String(request.host || '');
  const host = raw.split(':').length === 2 ? raw.slice(0, raw.indexOf(':')) : raw.replace(/^\[|\]$/g, '');
  const span = timeline.http({ client: 'http', method: request.method, url: urlOf(request), host });
  if (!span) return;
  const call = { span, status: null };
  calls.set(request, call);
  watch(request, (event, value) => {
    if (event === 'error') span.end({ status: call.status, error: value });
    else if (event === 'close' && call.status === null) span.end({ error: 'socket closed before a response' });
  });
}

function onResponse({ request, response }) {
  const call = request && calls.get(request);
  if (!call) return;
  call.status = response && Number.isInteger(response.statusCode) ? response.statusCode : null;
  if (!response || typeof response.emit !== 'function') {
    call.span.end({ status: call.status });
    return;
  }
  watch(response, (event, value) => {
    if (event === 'end' || event === 'close') call.span.end({ status: call.status });
    else if (event === 'error') call.span.end({ status: call.status, error: value });
    else if (event === 'aborted') call.span.end({ status: call.status, error: 'response aborted' });
  });
}

// Sees an emitter's events without becoming a listener.
function watch(emitter, observe) {
  if (!emitter || typeof emitter.emit !== 'function') return;
  const emit = emitter.emit;
  emitter.emit = function (event, value) {
    try {
      observe(event, value);
    } catch (error) {
      // Ignore.
    }
    return emit.apply(this, arguments);
  };
}

function urlOf(request) {
  const path = String(request.path || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path; // absolute-form, through a proxy
  let host;
  try {
    host = request.getHeader('host');
  } catch (error) {
    host = undefined;
  }
  return `${request.protocol || 'http:'}//${host || request.host || 'localhost'}${path}`;
}

// --- fetch (undici) ---------------------------------------------------------------------------

function onFetchCreate({ request }) {
  const timeline = Timeline.current();
  if (!timeline || !request) return;
  const origin = String(request.origin || '');
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch (error) {
    host = '';
  }
  const span = timeline.http({ client: 'fetch', method: request.method, url: `${origin}${request.path || ''}`, host });
  if (span) calls.set(request, { span, status: null });
}

function onFetchHeaders({ request, response }) {
  const call = request && calls.get(request);
  if (call && response) call.status = Number.isInteger(response.statusCode) ? response.statusCode : null;
}

function onFetchTrailers({ request }) {
  const call = request && calls.get(request);
  if (call) call.span.end({ status: call.status });
}

function onFetchError({ request, error }) {
  const call = request && calls.get(request);
  if (call) call.span.end({ status: call.status, error });
}
