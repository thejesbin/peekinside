/**
 * Samples the process now and then: memory (to spot leaks, as growth over hours), CPU and the
 * event-loop delay. Samples are numbers only, and go to the dashboard with the other records:
 * every 10 seconds to the local dashboard, every minute to PeekInside Cloud.
 */

import { performance } from 'perf_hooks';
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
 */

/**
 * Takes a sample every `intervalMs` and hands it over.
 */
export class RuntimeSampler {
  /**
   * @param {Object} options
   * @param {number} options.intervalMs
   * @param {(sample: RuntimeSample) => void} options.onSample
   * @param {import('./loop-monitor.js').LoopMonitor} options.monitor - Measures the delay
   */
  constructor({ intervalMs, onSample, monitor }) {
    this.intervalMs = intervalMs;
    this.onSample = onSample;
    this.monitor = monitor;
    this.timer = null;
    this.lastAt = performance.now();
    this.lastCpu = process.cpuUsage();
  }

  /**
   * @returns {this}
   */
  start() {
    if (this.timer) return this;
    this.lastAt = performance.now();
    this.lastCpu = process.cpuUsage();
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
      this.lastAt = now;
      this.lastCpu = process.cpuUsage();
      const memory = process.memoryUsage();
      const sample = {
        at: Date.now(),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        cpu: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 1000) / 10,
        loopP50: delay ? delay.p50 : null,
        loopP99: delay ? delay.p99 : null,
        loopMax: delay ? delay.max : null
      };
      this.onSample(sample);
      return sample;
    } catch (error) {
      return null;
    }
  }
}
