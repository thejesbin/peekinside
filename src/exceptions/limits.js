/**
 * Size limits of exception records, from the data contract shared with PeekInside Cloud, and the
 * helpers that apply them.
 *
 * Exceptions carry text the app doesn't control (messages built from user input, stack traces of
 * deep recursion, whatever was passed to report()), so every field is bounded before it is queued:
 * one exception can never take more than a few hundred kilobytes, however large the error.
 */

export const LIMITS = Object.freeze({
  name: 200,
  message: 2000,
  // Preview of a thrown value that isn't an Error
  valuePreview: 500,
  code: 64,
  // Bytes of error.stack
  stack: 32 * 1024,
  frames: 100,
  causeDepth: 5,
  aggregateErrors: 10,
  // Bytes of each cause's stack
  causeStack: 8 * 1024,
  causeFrames: 20,
  // In-app frames that get source lines, and the lines on each side of the frame's line
  contextFrames: 5,
  contextLines: 5,
  contextLineLength: 240,
  tags: 32,
  tagKey: 64,
  tagValue: 256,
  // Bytes of `extra` once serialized, and of the preview kept when it is larger
  extra: 16 * 1024,
  extraPreview: 2048,
  // Bytes of the request body kept with an exception
  requestBody: 8 * 1024,
  // Exceptions listed in a request record, and the length of their messages there
  requestLinks: 10,
  linkMessage: 500
});

/**
 * Cuts a string to at most `max` characters without splitting a surrogate pair.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  let end = max;
  // A high surrogate at the cut would leave half a character behind.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * Cuts a stack trace to at most `maxBytes` bytes of UTF-8, keeping its start and its end: the
 * message comes first and the frames last, and a huge message (an error that quotes a whole
 * response body) must not push the frames out.
 *
 * @param {string} stack
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateStack(stack, maxBytes) {
  if (typeof stack !== 'string' || stack.length * 3 <= maxBytes || Buffer.byteLength(stack) <= maxBytes) return stack;
  const marker = '\n    [...]\n';
  const half = Math.floor((maxBytes - marker.length) / 2);
  const head = truncateBytes(stack, half);
  const tail = Buffer.from(stack, 'utf8');
  let start = tail.length - half;
  // Forward over continuation bytes (10xxxxxx) to the start of a character.
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return `${head}${marker}${tail.subarray(start).toString('utf8')}`;
}

/**
 * Cuts a string to at most `maxBytes` bytes of UTF-8, at a character boundary.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateBytes(text, maxBytes) {
  if (typeof text !== 'string') return text;
  // Most strings are ASCII-sized: no need to encode them.
  if (text.length * 3 <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
