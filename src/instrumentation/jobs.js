/**
 * Job runs from the common job libraries, without code changes: node-cron and cron (scheduled
 * tasks, with their cron expression, so PeekInside can tell when one misses its run) and BullMQ
 * (queue workers, with the queue, the attempt and the job's data, and the schedule of repeatable
 * jobs). Each run goes through JobRunner, exactly as PeekInside.job() would run it.
 *
 * A schedule is recorded with its time zone: the one given to the library, else the process's
 * own, which is the one these libraries read a cron expression in without one.
 *
 * Libraries that ship separate CommonJS and ES module builds (node-cron, BullMQ) are patched in
 * both: the CommonJS one right away, the ES module one as soon as it is imported here, which is
 * before any job can run.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { JobRunner } from '../jobs/job-runner.js';

const kWrapped = Symbol('peekInside.job');
// node-cron tasks created through named imports are found by looking again now and then.
const RESCAN_MS = 30_000;

/**
 * Patches job libraries.
 */
export class JobInstrumentation {
  /**
   * node-cron: tasks scheduled through the module (and those already scheduled).
   *
   * @param {*} nodeCron - The module, or its default export
   * @returns {boolean}
   */
  static nodeCron(nodeCron) {
    const api = nodeCron && typeof nodeCron.schedule === 'function' ? nodeCron : nodeCron && nodeCron.default;
    if (!api || typeof api.schedule !== 'function' || typeof api.getTasks !== 'function') return false;
    if (api[kWrapped]) return true;
    for (const method of ['schedule', 'createTask']) {
      const original = api[method];
      if (typeof original !== 'function') continue;
      try {
        api[method] = function () {
          const task = original.apply(this, arguments);
          wrapCronTask(task);
          return task;
        };
      } catch (error) {
        // A frozen module namespace: the rescan below still finds its tasks.
      }
    }
    wrapAll(api);
    const timer = setInterval(() => wrapAll(api), RESCAN_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      Object.defineProperty(api, kWrapped, { value: true });
    } catch (error) {
      // Marked or not, patching twice is avoided per task.
    }
    return true;
  }

  /**
   * cron: every CronJob's callbacks, wrapped when the job first fires.
   *
   * @param {*} cron - The module
   * @returns {boolean}
   */
  static cron(cron) {
    const CronJob = cron && (cron.CronJob || (cron.default && cron.default.CronJob));
    const proto = typeof CronJob === 'function' ? CronJob.prototype : null;
    if (!proto || typeof proto.fireOnTick !== 'function') return false;
    if (proto[kWrapped]) return true;
    const original = proto.fireOnTick;
    proto.fireOnTick = function () {
      if (Array.isArray(this._callbacks)) this._callbacks = this._callbacks.map((callback) => wrapCronJobCallback(this, callback));
      return original.apply(this, arguments);
    };
    Object.defineProperty(proto, kWrapped, { value: true });
    return true;
  }

  /**
   * BullMQ: every job a Worker processes.
   *
   * @param {*} bullmq - The module
   * @returns {boolean}
   */
  static bullmq(bullmq) {
    const Worker = bullmq && (bullmq.Worker || (bullmq.default && bullmq.default.Worker));
    const proto = typeof Worker === 'function' ? Worker.prototype : null;
    if (!proto || typeof proto.callProcessJob !== 'function') return false;
    if (proto[kWrapped]) return true;
    const original = proto.callProcessJob;
    proto.callProcessJob = function (job) {
      const args = arguments;
      const repeat = job && job.opts && job.opts.repeat;
      const pattern = repeat ? repeat.pattern || repeat.cron : undefined;
      const schedule = repeat ? pattern || (Number.isFinite(repeat.every) ? `@every ${repeat.every}ms` : undefined) : undefined;
      return JobRunner.run(
        job && job.name && job.name !== '__default__' ? job.name : this.name,
        () => original.apply(this, args),
        {
          queue: this.name,
          attempt: job && Number.isInteger(job.attemptsMade) ? job.attemptsMade + 1 : 1,
          data: job ? job.data : undefined,
          schedule,
          timezone: repeat && typeof repeat.tz === 'string' && repeat.tz ? repeat.tz : pattern ? localTimeZone() : undefined,
          trigger: schedule ? 'cron' : 'queue'
        }
      );
    };
    Object.defineProperty(proto, kWrapped, { value: true });
    return true;
  }

  /**
   * Patches the ES module build of a package installed in the project, when it has one.
   *
   * @param {string} packageDir - The package's folder
   * @param {(module: *) => boolean} patch
   * @returns {Promise<boolean>}
   */
  static async patchModuleBuild(packageDir, patch) {
    const entry = esmEntry(packageDir);
    if (!entry) return false;
    try {
      return patch(await import(pathToFileURL(entry).href));
    } catch (error) {
      return false;
    }
  }
}

function wrapAll(api) {
  try {
    const tasks = api.getTasks();
    for (const task of tasks instanceof Map ? tasks.values() : Object.values(tasks || {})) wrapCronTask(task);
  } catch (error) {
    // The rescan tries again.
  }
}

// A node-cron task runs its function through runner.onMatch.
function wrapCronTask(task) {
  const runner = task && task.runner;
  if (!runner || typeof runner.onMatch !== 'function' || runner.onMatch[kWrapped]) return;
  const original = runner.onMatch;
  const expression = typeof task.cronExpression === 'string' ? task.cronExpression : null;
  // Without a name of its own, a task is named after a random id: its schedule says more.
  const name = task.name && task.name !== task.id ? task.name : `cron ${expression || 'task'}`;
  const wrapped = function () {
    const args = arguments;
    return JobRunner.run(name, () => original.apply(this, args), {
      schedule: expression || undefined,
      timezone: (typeof task.timezone === 'string' && task.timezone) || localTimeZone(),
      trigger: 'cron'
    });
  };
  wrapped[kWrapped] = true;
  runner.onMatch = wrapped;
}

function wrapCronJobCallback(job, callback) {
  if (typeof callback !== 'function' || callback[kWrapped]) return callback;
  const source = job.cronTime && typeof job.cronTime.source === 'string' ? job.cronTime.source : null;
  const wrapped = function () {
    const args = arguments;
    return JobRunner.run(job.name || `cron ${source || 'job'}`, () => callback.apply(this, args), {
      schedule: source || undefined,
      timezone: (job.cronTime && typeof job.cronTime.timeZone === 'string' && job.cronTime.timeZone) || localTimeZone(),
      trigger: 'cron'
    });
  };
  wrapped[kWrapped] = true;
  return wrapped;
}

// The process's time zone (TZ, else the system's).
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch (error) {
    return undefined;
  }
}

// The file an `import` of the package loads, when it differs from what require() loads.
function esmEntry(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const root = pkg.exports && (pkg.exports['.'] || pkg.exports);
    let target = null;
    if (root && typeof root === 'object' && root.import) {
      target = typeof root.import === 'string' ? root.import : root.import.default || root.import.node || null;
    }
    if (!target && typeof pkg.module === 'string') target = pkg.module;
    if (!target || typeof target !== 'string') return null;
    const file = path.resolve(packageDir, target);
    return fs.existsSync(file) ? file : null;
  } catch (error) {
    return null;
  }
}
