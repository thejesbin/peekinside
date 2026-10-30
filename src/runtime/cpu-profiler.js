/**
 * What blocked the event loop. V8's CPU profiler runs all the time, recording what the main thread
 * runs every 10 ms (about 0.1% of CPU); when the loop monitor sees a block, the samples from that
 * stretch are summed by function: the app's own that ran, with the package or Node.js function it
 * was in, else the package's. Each request that waited carries the answer on its timeline, and the
 * Runtime page sums blocks by function (see BlockRecorder).
 *
 * Reading a profile means stopping it, and V8 starts its profiler afresh by reading every compiled
 * function again: tens of milliseconds in a large app, a block of its own. So two profiles take
 * turns, one begun with Profiler.start and one with the inspector console's profile(), each started
 * before the other is read: the profiler never stops, and a switch costs a fraction of a
 * millisecond. Only the very first start pays, once.
 *
 * It starts with the app: V8 lists the code it compiles while profiling, but not loops it
 * optimized on the fly before (on-stack replacement), whose samples it charges to the caller.
 *
 * Only code locations and times leave the process, never values.
 */

import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import { RequestContext } from '../exceptions/request-context.js';
import { LoopMonitor } from './loop-monitor.js';
import { ProfileFrames } from './profile-frames.js';

const requireHere = createRequire(import.meta.url);

export const CPU_PROFILE_DEFAULTS = Object.freeze({
  samplingIntervalUs: 10_000,
  // A profile is read and the other begun this often, so what's kept stays small.
  rotateMs: 30_000,
  // Functions kept per block, and per window of the Runtime page.
  maxSites: 5,
  maxWindowSites: 20
});

// The console profile's title: one of the two profiles that take turns.
const TITLE = 'peekinside';
// Blocks already attributed, by when they began: the requests that waited ask after the first.
const MAX_CACHED = 64;
// Samples that aren't code: the thread waiting for work.
const IDLE = '(idle)';

/**
 * @typedef {Object} BlockSite
 * @property {string} id - Stable: the same function, calling the same one, gets the same id
 * @property {string|null} function
 * @property {string|null} file - Absolute path (or "node:..."), null for code without a file
 * @property {string|null} relativeFile - Relative to the project folder
 * @property {number|null} line - Where the function starts
 * @property {number|null} column
 * @property {string|null} package - The npm package (or "node") the time went to, when not the app's own code
 * @property {boolean} inApp - Whether the function is the app's own code
 * @property {string|null} calls - The package's or Node.js's function it was in, when not its own code
 * @property {number} ms - The share of the block spent there, estimated from samples
 */

/**
 * @typedef {Object} BlockWindow
 * @property {number} at - Start of the window (ms since the epoch)
 * @property {number} count - Blocks attributed in it
 * @property {number} total - Their time in all, ms
 * @property {number} worst - The longest, ms
 * @property {(BlockSite & { blocks: number, max: number })[]} sites - Where the time went, the
 *   most first: `ms` in all, in how many `blocks`, and the most in one (`max`)
 */

/**
 * The process's CPU profiler: one per process, shared by every PeekInside instance.
 */
export class CpuProfiler {
  /**
   * Starts the shared profiler (or counts one more user of it).
   *
   * @param {{ classifier: Object, sourceMaps: Object|null }} builder - The exception builder
   * @returns {CpuProfiler} Check `running`: when it can't run, `failure` says why
   */
  static acquire(builder) {
    if (!CpuProfiler.shared) CpuProfiler.shared = new CpuProfiler(builder);
    const profiler = CpuProfiler.shared;
    profiler.users++;
    profiler.start();
    return profiler;
  }

  /**
   * One user is done; the profiler stops with the last one.
   *
   * @returns {void}
   */
  static release() {
    const profiler = CpuProfiler.shared;
    if (!profiler) return;
    profiler.users = Math.max(0, profiler.users - 1);
    if (profiler.users) return;
    profiler.stop();
    CpuProfiler.shared = null;
  }

  /**
   * What ran during a block, when the profiler runs.
   *
   * @param {number} start - performance.now() when the block began
   * @param {number} duration - ms
   * @returns {{ samples: number, sites: BlockSite[] }|null}
   */
  static blame(start, duration) {
    const profiler = CpuProfiler.shared;
    return profiler && profiler.running ? profiler.attribute(start, start + duration) : null;
  }

  /**
   * @param {{ classifier: Object, sourceMaps: Object|null }} builder
   */
  constructor(builder) {
    this.frames = new ProfileFrames(builder);
    this.users = 0;
    this.session = null;
    this.console = null;
    this.running = false;
    /** Why the profiler isn't running, when it couldn't start. @type {string|null} */
    this.failure = null;
    // Which profile records now ('frontend' or 'console'), and since when (performance.now()).
    this.slot = null;
    this.slotStart = 0;
    // The last two profiles read: a block may span the switch between them.
    this.chunks = [];
    this.cache = new Map();
    this.finished = null;
    this.timer = null;
  }

  /**
   * @returns {this}
   */
  start() {
    if (this.running) return this;
    try {
      const inspector = requireHere('inspector');
      const session = new inspector.Session();
      session.connect();
      this.session = session;
      this.console = inspector.console;
      session.on('Profiler.consoleProfileFinished', (message) => {
        const params = message && message.params;
        if (params && params.title === TITLE) this.finished = params.profile;
      });
      post(session, 'Profiler.enable');
      post(session, 'Profiler.setSamplingInterval', { interval: CPU_PROFILE_DEFAULTS.samplingIntervalUs });
      post(session, 'Profiler.start');
      // The console's profile has to come back at once, or the two can't take turns.
      this.finished = null;
      this.console.profile(TITLE);
      this.console.profileEnd(TITLE);
      if (!this.finished) throw new Error("The inspector console doesn't record profiles in this process");
      this.finished = null;
    } catch (error) {
      this._close();
      this.failure = error && error.message ? String(error.message).slice(0, 200) : 'The CPU profiler is unavailable';
      return this;
    }
    this.slot = 'frontend';
    this.slotStart = performance.now();
    this.running = true;
    this.failure = null;
    this.timer = RequestContext.outside(() => setInterval(() => this._rotate(), CPU_PROFILE_DEFAULTS.rotateMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /**
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.running) {
      try {
        if (this.slot === 'frontend') post(this.session, 'Profiler.stop');
        else this.console.profileEnd(TITLE);
        post(this.session, 'Profiler.disable');
      } catch (error) {
        // Stopping anyway.
      }
    }
    this.running = false;
    this.chunks = [];
    this.cache.clear();
    this._close();
  }

  /**
   * What ran between two moments (a block), summed by function: read from the profile now, and
   * kept for whoever asks after the same block.
   *
   * @param {number} start - performance.now()
   * @param {number} end - performance.now()
   * @returns {{ samples: number, sites: BlockSite[] }|null}
   */
  attribute(start, end) {
    if (!this.running) return null;
    const key = Math.round(start);
    const cached = this.cache.get(key);
    if (cached) return cached;
    let result;
    try {
      this._switch();
      result = this._summarize(start, end);
    } catch (error) {
      this.stop();
      this.failure = error && error.message ? String(error.message).slice(0, 200) : 'The CPU profiler stopped';
      return null;
    }
    this.cache.set(key, result);
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  /**
   * The function a sample is charged to, from its stack (the running function first): the app's
   * own nearest the top, with the package's or Node.js's function it was in; else the running
   * function with a file (a package's); else the running one (garbage collection, V8 itself).
   *
   * @param {import('./profile-frames.js').ProfileFrame[]} stack - Located frames, the running one first
   * @returns {{ key: string, frame: Object, calls: string|null, package: string|null }|null} null
   *   for a thread waiting for work. `key` is the function's; what it called is apart.
   */
  static siteOf(stack) {
    if (!stack.length || (!stack[0].file && stack[0].function === IDLE)) return null;
    const app = stack.findIndex((frame) => frame.inApp);
    let frame;
    let calls = null;
    if (app >= 0) {
      frame = stack[app];
      // What it called: the function just inside it with a file (the entry point it used).
      for (let index = app - 1; index >= 0; index--) {
        if (stack[index].file) {
          calls = stack[index];
          break;
        }
      }
    } else {
      frame = stack.find((item) => item.file) || stack[0];
    }
    const pkg = (calls ? calls.module : app >= 0 ? null : frame.module) || null;
    const key = `${frame.file || ''}:${frame.line ?? ''}:${frame.function || ''}|${app >= 0 ? '' : pkg || ''}`;
    return { key, frame, calls: calls ? calls.function || '(anonymous)' : null, package: pkg };
  }

  // Reads the profile recording now, after starting the other: the profiler never stops.
  _switch() {
    const readAt = performance.now();
    let profile;
    if (this.slot === 'frontend') {
      this.console.profile(TITLE);
      profile = post(this.session, 'Profiler.stop').profile;
      this.slot = 'console';
    } else {
      post(this.session, 'Profiler.start');
      this.finished = null;
      this.console.profileEnd(TITLE);
      profile = this.finished;
      this.finished = null;
      this.slot = 'frontend';
    }
    if (profile) {
      // Its clock against performance.now(), from when it ended.
      this.chunks.push({ from: this.slotStart, to: readAt, profile, offsetUs: profile.endTime - readAt * 1000, index: null });
      if (this.chunks.length > 2) this.chunks.shift();
    }
    this.slotStart = readAt;
  }

  _rotate() {
    try {
      this._switch();
    } catch (error) {
      this.stop();
      this.failure = error && error.message ? String(error.message).slice(0, 200) : 'The CPU profiler stopped';
    }
  }

  // The samples between start and end, summed by function, each with what it mostly called.
  _summarize(start, end) {
    const counts = new Map();
    let samples = 0;
    for (const chunk of this.chunks) {
      if (chunk.to < start || chunk.from > end) continue;
      if (!chunk.index) chunk.index = CpuProfiler.index(chunk.profile, chunk.offsetUs);
      const { times } = chunk.index;
      for (let i = 0; i < times.length; i++) {
        if (times[i] < start || times[i] > end) continue;
        const site = this._siteOf(chunk.index, chunk.profile.samples[i]);
        if (!site) continue;
        samples++;
        let entry = counts.get(site.key);
        if (!entry) counts.set(site.key, (entry = { site, samples: 0, calls: new Map() }));
        entry.samples++;
        const called = `${site.calls ?? ''}\u0000${site.package ?? ''}`;
        entry.calls.set(called, (entry.calls.get(called) || 0) + 1);
      }
    }
    if (!samples) return { samples: 0, sites: [] };
    const duration = end - start;
    const sites = [...counts.values()]
      .sort((a, b) => b.samples - a.samples)
      .slice(0, CPU_PROFILE_DEFAULTS.maxSites)
      .map(({ site, samples: count, calls }) => {
        // What it called most, when that was at least half of its time.
        const [called, times] = [...calls.entries()].sort((a, b) => b[1] - a[1])[0];
        const [name, pkg] = times * 2 >= count ? called.split('\u0000') : ['', ''];
        return {
          id: ProfileFrames.id(site.key),
          function: site.frame.function,
          file: site.frame.file,
          relativeFile: site.frame.relativeFile,
          line: site.frame.line,
          column: site.frame.column,
          package: site.frame.inApp ? pkg || null : site.package,
          inApp: site.frame.inApp,
          calls: name || null,
          ms: round((duration * count) / samples)
        };
      });
    this.frames.mapSources(sites);
    return { samples, sites };
  }

  // A sample's site, from its node's stack: worked out once per node of a profile.
  _siteOf(index, nodeId) {
    if (index.sites.has(nodeId)) return index.sites.get(nodeId);
    const stack = [];
    for (let id = nodeId; id !== undefined; id = index.parent.get(id)) {
      const node = index.nodes.get(id);
      if (!node) break;
      if (node.callFrame.functionName === '(root)' && !node.callFrame.url) continue;
      stack.push(this.frames.locate(node.callFrame));
    }
    const site = CpuProfiler.siteOf(stack);
    index.sites.set(nodeId, site);
    return site;
  }

  /**
   * A profile's samples in performance.now() time, and its nodes by id with their parents.
   *
   * @param {{ nodes: Object[], startTime: number, samples: number[], timeDeltas: number[] }} profile
   * @param {number} offsetUs - The profile's clock (µs) minus performance.now() (µs)
   * @returns {{ times: Float64Array, nodes: Map<number, Object>, parent: Map<number, number>, sites: Map<number, Object|null> }}
   */
  static index(profile, offsetUs) {
    const times = new Float64Array(profile.samples.length);
    let at = profile.startTime;
    for (let i = 0; i < times.length; i++) {
      at += profile.timeDeltas[i] || 0;
      times[i] = (at - offsetUs) / 1000;
    }
    const nodes = new Map();
    const parent = new Map();
    for (const node of profile.nodes) {
      nodes.set(node.id, node);
      for (const child of node.children || []) parent.set(child, node.id);
    }
    return { times, nodes, parent, sites: new Map() };
  }

  _close() {
    if (!this.session) return;
    try {
      this.session.disconnect();
    } catch (error) {
      // Already gone.
    }
    this.session = null;
  }
}

CpuProfiler.shared = null;

/**
 * Sums the blocks a PeekInside instance sees into windows for the Runtime page: how many, how long
 * in all and at worst, and the functions that ran during them.
 */
export class BlockRecorder {
  /**
   * @param {Object} options
   * @param {{ classifier: Object, sourceMaps: Object|null }} options.builder - The exception builder
   * @param {number} options.thresholdMs - Shorter blocks are left out (loopBlockMs)
   * @param {number} options.periodMs - A window's length
   * @param {(window: BlockWindow) => void} options.onWindow
   */
  constructor({ builder, thresholdMs, periodMs, onWindow }) {
    this.builder = builder;
    this.thresholdMs = thresholdMs;
    this.periodMs = periodMs;
    this.onWindow = onWindow;
    this.running = false;
    /** Why blocks aren't attributed, when the profiler couldn't start. @type {string|null} */
    this.failure = null;
    this.current = null;
    this.unsubscribe = null;
    this.timer = null;
  }

  /**
   * @returns {this}
   */
  start() {
    if (this.running) return this;
    const profiler = CpuProfiler.acquire(this.builder);
    if (!profiler.running) {
      this.failure = profiler.failure;
      CpuProfiler.release();
      return this;
    }
    this.running = true;
    this.failure = null;
    this.unsubscribe = LoopMonitor.onBlock((start, duration) => this.note(start, duration));
    this.timer = RequestContext.outside(() => setInterval(() => this.flush(), Math.min(this.periodMs, 15_000)));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /**
   * Stops, handing over the window in progress.
   *
   * @returns {void}
   */
  stop() {
    if (!this.running) return;
    this.flush(true);
    this.running = false;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    clearInterval(this.timer);
    this.timer = null;
    CpuProfiler.release();
  }

  /**
   * Counts a block (see LoopMonitor.onBlock).
   *
   * @param {number} start - performance.now() when it began
   * @param {number} duration - ms
   * @returns {void}
   */
  note(start, duration) {
    if (!this.running || duration < this.thresholdMs) return;
    const blamed = CpuProfiler.blame(start, duration);
    if (!blamed || !blamed.sites.length) return;
    const at = Math.floor((performance.timeOrigin + start) / this.periodMs) * this.periodMs;
    if (this.current && this.current.at !== at) this.flush(true);
    if (!this.current) this.current = { at, count: 0, total: 0, worst: 0, sites: new Map() };
    const window = this.current;
    window.count++;
    window.total += duration;
    window.worst = Math.max(window.worst, duration);
    for (const site of blamed.sites) {
      const entry = window.sites.get(site.id);
      if (entry) {
        entry.ms += site.ms;
        entry.blocks++;
        entry.max = Math.max(entry.max, site.ms);
      } else {
        window.sites.set(site.id, { ...site, blocks: 1, max: site.ms });
      }
    }
  }

  /**
   * Hands over the window in progress once its period is over (or now, with `force`).
   *
   * @param {boolean} [force=false]
   * @returns {BlockWindow|null}
   */
  flush(force = false) {
    const window = this.current;
    if (!window || (!force && Date.now() < window.at + this.periodMs)) return null;
    this.current = null;
    const sites = [...window.sites.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, CPU_PROFILE_DEFAULTS.maxWindowSites)
      .map((site) => ({ ...site, ms: round(site.ms), max: round(site.max) }));
    const finished = { at: window.at, count: window.count, total: round(window.total), worst: round(window.worst), sites };
    try {
      this.onWindow(finished);
    } catch (error) {
      // Never into the app.
    }
    return finished;
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

function round(value) {
  return Math.round(value * 10) / 10;
}
