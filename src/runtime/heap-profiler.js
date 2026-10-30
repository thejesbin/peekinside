/**
 * Where a process's memory is held, for the Runtime page's leak findings. V8's sampling heap
 * profiler runs all the time (on average one sample per 512 KiB allocated: a few percent of CPU at
 * most), and now and then its live profile, the sampled objects still alive, is summed by the
 * function of the app's own code that allocated them, or that called the package or built-in that
 * did. The dashboard compares these windows: a function whose memory keeps growing is where a leak
 * is. V8 locates allocations by function, not by line: a site's line is where its function starts.
 *
 * Only code locations and byte counts leave the process, never values. A heap snapshot (every
 * string in memory, and seconds of pause) is never taken.
 */

import { createRequire } from 'module';
import { RequestContext } from '../exceptions/request-context.js';
import { ProfileFrames } from './profile-frames.js';

const requireHere = createRequire(import.meta.url);

// V8 has one sampling heap profiler per process: every PeekInside instance shares it, and the last
// to stop stops it.
const sampler = { session: null, users: 0 };

export const HEAP_PROFILE_DEFAULTS = Object.freeze({
  // Node's --heap-prof, Datadog and Pyroscope use the same: smaller intervals cost far more.
  samplingInterval: 512 * 1024,
  maxSites: 30,
  // Under memory pressure, at most one extra window this often.
  pressureEveryMs: 60_000
});

/**
 * @typedef {Object} HeapSite
 * @property {string} id - Stable across windows: the same function gets the same id
 * @property {string|null} function
 * @property {string|null} file - Absolute path (or null for code without a file)
 * @property {string|null} relativeFile - Relative to the project folder
 * @property {number|null} line - Where the function starts
 * @property {number|null} column
 * @property {string|null} package - The npm package (or "node") that allocated, when not the app itself
 * @property {boolean} inApp - Whether the function is the app's own code
 * @property {number} bytes - Live bytes sampled there (V8's estimate)
 */

/**
 * @typedef {Object} HeapWindow
 * @property {number} at - When the profile was read (ms since the epoch)
 * @property {'interval'|'pressure'} reason - Read on schedule, or early because the heap neared its limit
 * @property {number} total - Live bytes in the profile
 * @property {HeapSite[]} sites - The functions holding the most, largest first
 */

/**
 * Samples the heap and reads windows from it. Never throws into the app: when the profiler can't
 * run (no inspector, another tool already sampling), it stays off and says why.
 */
export class HeapProfiler {
  /**
   * @param {Object} options
   * @param {{ classifier: Object, sourceMaps: Object|null }} options.builder - The exception builder:
   *   classifies frames as the app's or a package's, and maps them through source maps
   * @param {number} options.intervalMs - How often a window is read
   * @param {(window: HeapWindow) => void} options.onWindow
   * @param {number} [options.samplingInterval]
   * @param {number} [options.maxSites]
   */
  constructor({ builder, intervalMs, onWindow, samplingInterval = HEAP_PROFILE_DEFAULTS.samplingInterval, maxSites = HEAP_PROFILE_DEFAULTS.maxSites }) {
    this.builder = builder;
    this.intervalMs = intervalMs;
    this.onWindow = onWindow;
    this.samplingInterval = samplingInterval;
    this.maxSites = maxSites;
    this.timer = null;
    this.running = false;
    this.lastPressure = 0;
    /** Why the profiler isn't running, when it couldn't start. @type {string|null} */
    this.failure = null;
    this.frames = new ProfileFrames(builder);
  }

  /**
   * Starts sampling, then reads a window every `intervalMs`.
   *
   * @returns {this}
   */
  start() {
    if (this.running) return this;
    try {
      if (!sampler.session) sampler.session = openSampler(this.samplingInterval);
      sampler.users++;
      this.running = true;
      this.failure = null;
    } catch (error) {
      this.failure = error && error.message ? String(error.message).slice(0, 200) : 'The heap profiler is unavailable';
      return this;
    }
    this.timer = RequestContext.outside(() => setInterval(() => this.take('interval'), this.intervalMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /**
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.running) return;
    this.running = false;
    if (--sampler.users > 0) return;
    const session = sampler.session;
    sampler.session = null;
    try {
      post(session, 'HeapProfiler.stopSampling');
    } catch (error) {
      // Already stopped.
    }
    session.disconnect();
  }

  /**
   * Reads a window now and hands it over. Under memory pressure, at most one extra window a minute.
   *
   * @param {'interval'|'pressure'} [reason='interval']
   * @returns {HeapWindow|null}
   */
  take(reason = 'interval') {
    if (!this.running) return null;
    if (reason === 'pressure') {
      const now = Date.now();
      if (now - this.lastPressure < HEAP_PROFILE_DEFAULTS.pressureEveryMs) return null;
      this.lastPressure = now;
    }
    try {
      const { profile } = post(sampler.session, 'HeapProfiler.getSamplingProfile');
      const window = { at: Date.now(), reason, ...HeapProfiler.summarize(profile, (frame) => this.frames.locate(frame), this.maxSites) };
      this.frames.mapSources(window.sites);
      this.onWindow(window);
      return window;
    } catch (error) {
      return null;
    }
  }

  /**
   * Sums a sampling heap profile by the function that holds the memory: for each allocation, the
   * nearest frame of the app's own code on its stack, else the nearest frame with a file (a
   * package's), else the allocating function itself.
   *
   * @param {{ head: Object }} profile - HeapProfiler.SamplingHeapProfile
   * @param {(callFrame: Object) => { function: string|null, file: string|null, relativeFile: string|null, line: number|null, column: number|null, inApp: boolean, module: string|null }} locate
   * @param {number} maxSites
   * @returns {{ total: number, sites: HeapSite[] }}
   */
  static summarize(profile, locate, maxSites) {
    const sites = new Map();
    let total = 0;
    // Depth-first, with the path of frames from the root: stacks are a few dozen frames deep.
    const stack = profile && profile.head ? [{ node: profile.head, path: [] }] : [];
    while (stack.length) {
      const { node, path } = stack.pop();
      const frames = node.callFrame && node.callFrame.functionName !== '(root)' ? [...path, locate(node.callFrame)] : path;
      if (node.selfSize > 0 && frames.length) {
        total += node.selfSize;
        const site = HeapProfiler.siteOf(frames);
        const entry = sites.get(site.key);
        if (entry) entry.bytes += node.selfSize;
        else sites.set(site.key, { ...site.frame, package: site.package, inApp: site.frame.inApp, bytes: node.selfSize, key: site.key });
      }
      for (const child of node.children || []) stack.push({ node: child, path: frames });
    }
    const ranked = [...sites.values()].sort((a, b) => b.bytes - a.bytes).slice(0, maxSites);
    return {
      total,
      sites: ranked.map(({ key, module, ...site }) => ({
        id: ProfileFrames.id(key),
        function: site.function,
        file: site.file,
        relativeFile: site.relativeFile,
        line: site.line,
        column: site.column,
        package: site.package,
        inApp: site.inApp,
        bytes: site.bytes
      }))
    };
  }

  /**
   * The function an allocation is charged to, from its stack (outermost frame first).
   *
   * @param {Object[]} frames - Located frames
   * @returns {{ key: string, frame: Object, package: string|null }}
   */
  static siteOf(frames) {
    let app = null;
    let withFile = null;
    let library = null;
    for (let index = frames.length - 1; index >= 0; index--) {
      const frame = frames[index];
      if (frame.inApp) {
        app = frame;
        break;
      }
      if (!withFile && frame.file) withFile = frame;
      if (!library && frame.module && frame.module !== 'node') library = frame.module;
    }
    const frame = app || withFile || frames[frames.length - 1];
    const pkg = app ? library : frame.module || library;
    const key = `${frame.file || ''}:${frame.line ?? ''}:${frame.function || ''}|${pkg || ''}`;
    return { key, frame, package: pkg || null };
  }
}

// Starts V8's sampler through an in-process inspector session. Another tool (Datadog's profiler, a
// DevTools session) may already be sampling: starting over it would share its profile, and stopping
// would stop theirs, so then PeekInside leaves the heap alone.
function openSampler(samplingInterval) {
  const { Session } = requireHere('inspector');
  const session = new Session();
  session.connect();
  try {
    let running = true;
    try {
      post(session, 'HeapProfiler.getSamplingProfile');
    } catch (error) {
      running = false;
    }
    if (running) throw new Error('Another heap profiler is already sampling this process');
    post(session, 'HeapProfiler.startSampling', { samplingInterval });
    return session;
  } catch (error) {
    session.disconnect();
    throw error;
  }
}

// The in-process session answers synchronously.
function post(session, method, params = {}) {
  let failure = null;
  let answer;
  session.post(method, params, (error, result) => {
    failure = error;
    answer = result;
  });
  if (failure) throw failure;
  return answer || {};
}
