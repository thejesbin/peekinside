/**
 * Pure helpers for the parts of HTTP messages that PeekInside records: request targets, query
 * strings and header objects.
 *
 * Query keys and header names come from the network, so the objects built from them define
 * every key as an own property: a key such as "__proto__" stays a plain entry instead of
 * changing the object's prototype.
 */

/**
 * Splits a request target into pathname and search, without normalizing it: the dashboard shows
 * the path exactly as the client sent it.
 *
 * @param {string} url - Request target, such as "/users?page=2" or an absolute URL (sent to proxies)
 * @returns {{ pathname: string, search: string }} `search` includes the "?" when present
 */
export function splitUrl(url) {
  let target = typeof url === 'string' && url !== '' ? url : '/';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(target)) {
    // Absolute-form target, as sent to proxies
    try {
      const parsed = new URL(target);
      target = parsed.pathname + parsed.search;
    } catch (error) {
      target = '/';
    }
  }
  const index = target.indexOf('?');
  return index === -1
    ? { pathname: target, search: '' }
    : { pathname: target.slice(0, index), search: target.slice(index) };
}

/**
 * Parses a query string. Repeated keys become arrays, in order.
 *
 * @param {string} search - Query string, including the leading "?"
 * @returns {Object<string, string|string[]>}
 */
export function parseQuery(search) {
  const query = {};
  if (!search || search.length < 2) {
    return query;
  }

  let params;
  try {
    params = new URLSearchParams(search.slice(1));
  } catch (error) {
    return query;
  }

  for (const [key, value] of params) {
    const existing = Object.prototype.hasOwnProperty.call(query, key) ? query[key] : undefined;
    setOwn(query, key, existing === undefined ? value : [].concat(existing, value));
  }
  return query;
}

/**
 * Turns headers in any form writeHead() accepts into an object with lowercase names.
 *
 * @param {Object|Array} headers - An object, a flat array [name, value, ...] or an array of pairs
 * @returns {Object<string, *>}
 */
export function normalizeHeaders(headers) {
  const normalized = {};
  const add = (name, value) => {
    if (name !== undefined && name !== null && value !== undefined) {
      setOwn(normalized, String(name).toLowerCase(), value);
    }
  };

  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const pair of headers) add(pair[0], pair[1]);
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) add(headers[i], headers[i + 1]);
    }
  } else if (headers && typeof headers === 'object') {
    for (const name of Object.keys(headers)) add(name, headers[name]);
  }
  return normalized;
}

/**
 * Merges header objects; later sources win.
 *
 * @param {...(Object|null|undefined)} sources
 * @returns {Object<string, *>}
 */
export function mergeHeaders(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source) continue;
    for (const name of Object.keys(source)) {
      setOwn(merged, name, source[name]);
    }
  }
  return merged;
}

/**
 * @param {Object} headers - Headers with lowercase names
 * @param {string} name - Lowercase header name
 * @returns {*} The header's value, or its first value when it was sent several times
 */
export function headerValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether request headers announce a body: chunked, or a positive Content-Length.
 *
 * @param {Object} headers - Request headers
 * @returns {boolean}
 */
export function hasBody(headers) {
  if (headers['transfer-encoding'] !== undefined) {
    return true;
  }
  const length = Number(headers['content-length']);
  return Number.isFinite(length) && length > 0;
}

/**
 * Sets a property as an own, enumerable entry, even for keys such as "__proto__" that would
 * otherwise change the object's prototype.
 *
 * @param {Object} target
 * @param {string} key
 * @param {*} value
 * @returns {void}
 */
export function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
