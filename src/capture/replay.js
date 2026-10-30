/**
 * Replays from the local dashboard. The hub sends a recorded request to the app again with two
 * headers: the request it replays, and the id its own record takes, so the dashboard can open the
 * replay and put it next to the original. Only the local dashboard honors them (PeekInside Cloud
 * records a request that carries them like any other), and they are never recorded.
 */

/** The id of the request a replay sends again. */
export const REPLAY_OF_HEADER = 'x-peekinside-replay-of';

/** The id the replay's own record takes. */
export const REPLAY_ID_HEADER = 'x-peekinside-replay-id';

// Request ids as the hub stores them (see REQUEST_ID in hub/ingest-payload.js).
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The replay a request's headers announce: both ids, valid and different.
 *
 * @param {Object} headers - Request headers, with lowercase names
 * @returns {{ id: string, of: string } | null} null when it isn't a replay
 */
export function readReplay(headers) {
  const id = headers[REPLAY_ID_HEADER];
  const of = headers[REPLAY_OF_HEADER];
  return typeof id === 'string' && typeof of === 'string' && ID.test(id) && ID.test(of) && id !== of ? { id, of } : null;
}

/**
 * Request headers as they are recorded: without the replay's own.
 *
 * @param {Object} headers - A copy of the request's headers, changed in place
 * @returns {Object} The same object
 */
export function withoutReplayHeaders(headers) {
  delete headers[REPLAY_OF_HEADER];
  delete headers[REPLAY_ID_HEADER];
  return headers;
}
