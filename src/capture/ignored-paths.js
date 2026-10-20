/**
 * Which request paths are never recorded: browser and dev-server noise, plus the app's own
 * `ignorePaths` rules.
 */

/**
 * Prefixes of browser and dev-server noise that is never worth recording.
 *
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_SKIP_PATHS = Object.freeze(['/.well-known/', '/favicon.ico', '/__webpack_hmr', '/sockjs-node/', '/_next/static/', '/static/']);

/**
 * Whether a path must not be recorded.
 *
 * The rules are passed on every call rather than kept, because apps may change their
 * `ignorePaths` option after PeekInside starts (attachTo() merges new options in).
 *
 * @param {string} pathname - Request path, without the query string
 * @param {string|RegExp|Function|Array<string|RegExp|Function>} rules - String prefixes, regular
 *   expressions, or predicates receiving the pathname. Empty strings match nothing, and a
 *   predicate that throws counts as no match.
 * @returns {boolean}
 */
export function isIgnoredPath(pathname, rules) {
  if (DEFAULT_SKIP_PATHS.some(prefix => pathname.startsWith(prefix))) {
    return true;
  }

  const list = Array.isArray(rules) ? rules : [rules];
  return list.some(rule => {
    if (typeof rule === 'string') {
      return rule !== '' && pathname.startsWith(rule);
    }
    if (rule instanceof RegExp) {
      // A global or sticky expression would otherwise resume from where its last match ended.
      rule.lastIndex = 0;
      return rule.test(pathname);
    }
    if (typeof rule === 'function') {
      try {
        return Boolean(rule(pathname));
      } catch (error) {
        return false;
      }
    }
    return false;
  });
}
