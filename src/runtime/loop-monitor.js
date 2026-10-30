/**
 * Watches the event loop with a light timer that measures how late it fires. A late timer means
 * the loop was blocked by synchronous work (a large JSON.parse, a slow regular expression, a sync
 * file read, a CPU-heavy loop), and every request in flight waited for it. Blocks long enough are
 * recorded on the timelines of those requests (Timeline#block); every delay feeds the process
 * samples (see RuntimeSampler).
 *
 * One monitor serves the whole process. Its timer is unref'd, never keeps the process alive, and
 * runs outside any request; the work per tick is a subtraction and a write into a fixed buffer.
 */

import { performance } from 'perf_hooks';
import { RequestContext } from '../exceptions/request-context.js';

// How often the timer fires: a block is measured within TICK_MS.
export const TICK_MS = 20;
// Delays kept for the samples: two minutes of ticks.
const MAX_DELAYS = Math.ceil(120_000 / TICK_MS);
// Shorter delays are scheduling noise, never a block worth showing.
const MIN_BLOCK_MS = 50;

/**
 * The process's event-loop monitor.
 */
export class LoopMonitor {
  /**
   * Starts the shared monitor (or counts one more user of it).
   *
   * @returns {LoopMonitor}
   */
  static acquire() {
    if (!LoopMonitor.shared) LoopMonitor.shared = new LoopMonitor();
    LoopMonitor.shared.users++;
    LoopMonitor.shared.start();
    return LoopMonitor.shared;
  }

  /**
   * One user is done; the monitor stops with the last one.
   *
   * @returns {void}
   */
  static release() {
    const monitor = LoopMonitor.shared;
    if (!monitor) return;
    monitor.users = Math.max(0, monitor.users - 1);
    if (monitor.users === 0) monitor.stop();
  }

  /**
   * Follows a timeline until it is untracked: blocks that happen meanwhile are recorded on it.
   * Does nothing while no monitor runs.
   *
   * @param {{ block: (start: number, duration: number) => void }} timeline
   * @returns {void}
   */
  static track(timeline) {
    if (LoopMonitor.shared && LoopMonitor.shared.timer) LoopMonitor.shared.timelines.add(timeline);
  }

  /**
   * @param {Object} timeline
   * @returns {void}
   */
  static untrack(timeline) {
    if (LoopMonitor.shared) LoopMonitor.shared.timelines.delete(timeline);
  }

  /**
   * Calls `listener(start, duration)` for each block, before the timelines hear of it (the CPU
   * profiler works out what ran, for them too).
   *
   * @param {(start: number, duration: number) => void} listener
   * @returns {() => void} Stops listening
   */
  static onBlock(listener) {
    LoopMonitor.blockListeners.add(listener);
    return () => LoopMonitor.blockListeners.delete(listener);
  }

  /**
   * The block in progress, if the timer is late right now: a request that blocked the loop itself
   * often finishes before the timer can fire, and asks when its timeline closes.
   *
   * @param {number} [now=performance.now()]
   * @returns {{ start: number, duration: number }|null}
   */
  static pending(now = performance.now()) {
    const monitor = LoopMonitor.shared;
    if (!monitor || !monitor.timer) return null;
    const due = monitor.last + TICK_MS;
    return now - due >= MIN_BLOCK_MS ? { start: due, duration: now - due } : null;
  }

  constructor() {
    this.users = 0;
    this.timer = null;
    this.last = 0;
    this.timelines = new Set();
    // Ring buffer of (performance.now(), delay ms) per tick.
    this.times = new Float64Array(MAX_DELAYS);
    this.delays = new Float64Array(MAX_DELAYS);
    this.next = 0;
    this.size = 0;
  }

  /**
   * @returns {void}
   */
  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = RequestContext.outside(() => setInterval(() => this.tick(), TICK_MS));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.timelines.clear();
  }

  /**
   * One tick of the timer: how late it fired is how long the loop was blocked.
   *
   * @param {number} [now=performance.now()]
   * @returns {void}
   */
  tick(now = performance.now()) {
    const delay = Math.max(0, now - this.last - TICK_MS);
    this.last = now;
    this.times[this.next] = now;
    this.delays[this.next] = delay;
    this.next = (this.next + 1) % MAX_DELAYS;
    this.size = Math.min(MAX_DELAYS, this.size + 1);
    if (delay < MIN_BLOCK_MS) return;
    // The loop was blocked from when the tick was due until now.
    for (const listener of LoopMonitor.blockListeners) {
      try {
        listener(now - delay, delay);
      } catch (error) {
        // A listener's failure never affects the timelines.
      }
    }
    for (const timeline of this.timelines) {
      try {
        timeline.block(now - delay, delay);
      } catch (error) {
        // One timeline's failure never affects the others.
      }
    }
  }

  /**
   * The event-loop delay since a moment: its median, 99th percentile and maximum, in ms.
   *
   * @param {number} since - performance.now() at the start of the window
   * @returns {{ p50: number, p99: number, max: number }|null} null without ticks in the window
   */
  delaySince(since) {
    const window = [];
    for (let i = 0; i < this.size; i++) {
      const index = (this.next - 1 - i + MAX_DELAYS) % MAX_DELAYS;
      if (this.times[index] < since) break;
      window.push(this.delays[index]);
    }
    if (!window.length) return null;
    window.sort((a, b) => a - b);
    const at = (fraction) => window[Math.min(window.length - 1, Math.floor(fraction * window.length))];
    return { p50: round(at(0.5)), p99: round(at(0.99)), max: round(window[window.length - 1]) };
  }
}

LoopMonitor.shared = null;
LoopMonitor.blockListeners = new Set();

function round(value) {
  return Math.round(value * 10) / 10;
}
