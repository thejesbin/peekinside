/**
 * Samples the process now and then: memory (to spot leaks, as growth over hours, and how close the
 * heap is to its limit), CPU, the event loop (its delay, and how busy it was), garbage collection,
 * open handles and the requests it served. Samples are numbers only, and go to the dashboard with
 * the other records: every 10 seconds to the local dashboard, every minute to PeekInside Cloud.
 */

import { PerformanceObserver, performance } from 'perf_hooks';
import v8 from 'v8';
import { RequestContext } from '../exceptions/request-context.js';

/**
 * @typedef {Object} RuntimeSample
 * @property {number} at - When it was taken (ms since the epoch)
 * @property {number} rss - Bytes of memory the process holds
 * @property {number} heapUsed - Bytes of JavaScript objects
 * @property {number} heapTotal - Bytes of the JavaScript heap
 * @property {number} external - Bytes of memory outside the heap (buffers)
 * @property {number} cpu - Percent of one core used since the last sample
 * @property {number|null} loopP50 - Event-loop delay since the last sample, ms
 * @property {number|null} loopP99
 * @property {number|null} loopMax
 * @property {number|null} arrayBuffers - Bytes of ArrayBuffers and Buffers (part of external)
 * @property {number|null} heapLimit - Bytes the heap may grow to before the process runs out of memory
 * @property {number|null} elu - Percent of the time since the last sample the event loop was busy
 * @property {number|null} gcCount - Garbage collections since the last sample
 * @property {number|null} gcMs - Time they paused the process, ms
 * @property {number|null} gcMax - The longest of them, ms
 * @property {number|null} handles - Open handles and requests (sockets, timers, files) now
 * @property {number|null} requests - Requests this process finished since the last sample
 * @property {number|null} inFlight - Requests open when the sample was taken
 */

/**
 * Garbage collections since the last look: how many, and how long they paused the process.
 */
class GcWatch {
  constructor() {
    this.observer = null;
    this.reset();
  }

  /**
   * @returns {void}
   */
  start() {
    if (this.observer) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.count++;
          this.ms += entry.duration;
          if (entry.duration > this.max) this.max = entry.duration;
        }
      });
      // Outside any request: collections belong to the process, not to the request that started it.
      RequestContext.outside(() => this.observer.observe({ entryTypes: ['gc'] }));
    } catch (error) {
      this.observer = null;
    }
  }

  /**
   * @returns {void}
   */
  stop() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
  }

  /**
   * The collections since the last call, or null when they can't be watched.
   *
   * @returns {{ count: number, ms: number, max: number }|null}
   */
  take() {
    if (!this.observer) return null;
    const taken = { count: this.count, ms: round(this.ms), max: round(this.max) };
    this.reset();
    return taken;
  }

  reset() {
    this.count = 0;
    this.ms = 0;
    this.max = 0;
  }
}

/**
 * Takes a sample every `intervalMs` and hands it over.
 */
export class RuntimeSampler {
  /**
   * @param {Object} options
   * @param {number} options.intervalMs
   * @param {(sample: RuntimeSample) => void} options.onSample
   * @param {import('./loop-monitor.js').LoopMonitor} options.monitor - Measures the delay
   * @param {import('./request-counter.js').RequestCounter} [options.requests] - Counts the requests served
   */
  constructor({ intervalMs, onSample, monitor, requests = null }) {
    this.intervalMs = intervalMs;
    this.onSample = onSample;
    this.monitor = monitor;
    this.requests = requests;
    this.timer = null;
    this.gc = new GcWatch();
    this.lastAt = performance.now();
    this.lastCpu = process.cpuUsage();
    this.lastElu = loopUtilization();
  }

  /**
   * @returns {this}
   */
  start() {
    if (this.timer) return this;
    this.lastAt = performance.now();
    this.lastCpu = process.cpuUsage();
    this.lastElu = loopUtilization();
    this.gc.start();
    this.timer = RequestContext.outside(() => setInterval(() => this.take(), this.intervalMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  /**
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.gc.stop();
  }

  /**
   * Takes a sample now and hands it over. Never throws.
   *
   * @returns {RuntimeSample|null}
   */
  take() {
    try {
      const now = performance.now();
      const elapsed = Math.max(1, now - this.lastAt);
      const cpu = process.cpuUsage(this.lastCpu);
      const delay = this.monitor ? this.monitor.delaySince(this.lastAt) : null;
      const elu = loopUtilization();
      const busy = elu && this.lastElu ? performance.eventLoopUtilization(elu, this.lastElu).utilization : null;
      this.lastAt = now;
      this.lastCpu = process.cpuUsage();
      this.lastElu = elu;
      const memory = process.memoryUsage();
      const gc = this.gc.take();
      const traffic = this.requests ? this.requests.take() : null;
      const sample = {
        at: Date.now(),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        cpu: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 1000) / 10,
        loopP50: delay ? delay.p50 : null,
        loopP99: delay ? delay.p99 : null,
        loopMax: delay ? delay.max : null,
        arrayBuffers: Number.isFinite(memory.arrayBuffers) ? memory.arrayBuffers : null,
        heapLimit: heapLimit(),
        elu: Number.isFinite(busy) ? Math.round(busy * 1000) / 10 : null,
        gcCount: gc ? gc.count : null,
        gcMs: gc ? gc.ms : null,
        gcMax: gc ? gc.max : null,
        handles: openHandles(),
        requests: traffic ? traffic.finished : null,
        inFlight: traffic ? traffic.open : null
      };
      this.onSample(sample);
      return sample;
    } catch (error) {
      return null;
    }
  }
}

// How busy the loop has been since the process started (Node.js 14.10 and later).
function loopUtilization() {
  return typeof performance.eventLoopUtilization === 'function' ? performance.eventLoopUtilization() : null;
}

function heapLimit() {
  try {
    return v8.getHeapStatistics().heap_size_limit;
  } catch (error) {
    return null;
  }
}

// Sockets, timers, files and other resources keeping the loop alive (Node.js 17 and later).
function openHandles() {
  try {
    return typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : null;
  } catch (error) {
    return null;
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}
