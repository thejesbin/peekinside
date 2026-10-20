/**
 * PeekInside - Real-time HTTP request inspector for Node.js applications
 *
 * Records every request and response your app handles. During development they go to the free
 * local dashboard, which is shared by all your projects and keeps its data on this machine.
 * With an API key they are encrypted and sent to PeekInside Cloud instead.
 * Works with Express, Koa, Fastify, NestJS, Hono and the native http module.
 *
 * Exceptions are recorded too: errors that reach the framework's error handling, crashes
 * (uncaught exceptions and unhandled rejections), and errors the app reports. Each is linked to the
 * request it happened in.
 *
 * Each request also gets a timeline: the database queries, outgoing HTTP calls, console lines and
 * exceptions that happened while it was handled (see src/timeline and src/instrumentation).
 *
 * In development, dump() shows values in the local dashboard, under the request they were dumped
 * in (see src/dumps).
 *
 * This class is the public API. It decides where requests go and which requests are recorded,
 * and leaves the work to the capture (src/capture), exception (src/exceptions), framework
 * (src/integrations) and transport (src/transport) classes.
 *
 * @license MIT
 */

import { ExchangeRecorder } from './capture/exchange-recorder.js';
import { splitUrl } from './capture/http-message.js';
import { isIgnoredPath } from './capture/ignored-paths.js';
import { LOG_PREFIX, VERSION, settings } from './config.js';
import { TrafficClassifier } from './deployment.js';
import { ExceptionCapture } from './exceptions/exception-capture.js';
import { DumpCapture } from './dumps/dump-capture.js';
import { ProcessMonitor } from './exceptions/process-monitor.js';
import { RequestContext } from './exceptions/request-context.js';
import { Instrumentation } from './instrumentation/index.js';
import { isNativePromise } from './instrumentation/patch.js';
import { TIMELINE_DEFAULTS, Timeline, TimelineSettings } from './timeline/timeline.js';
import { ExpressAdapter } from './integrations/express.js';
import { FastifyAdapter } from './integrations/fastify.js';
import { HonoAdapter } from './integrations/hono.js';
import { HttpServerAdapter } from './integrations/http-server.js';
import { KoaAdapter } from './integrations/koa.js';
import { NestAdapter } from './integrations/nest.js';
import { ServerBinder } from './integrations/server-binder.js';
import { ProjectIdentity } from './project.js';
import { Release } from './release.js';
import { JobRunner } from './jobs/job-runner.js';
import { LogCapture } from './logs/log-capture.js';
import { LoopMonitor } from './runtime/loop-monitor.js';
import { RuntimeSampler } from './runtime/sampler.js';
import { RequestCounter } from './runtime/request-counter.js';
import { UserInfo } from './user.js';
import { CloudTransport } from './transport/cloud.js';
import { LocalTransport } from './transport/local.js';

const DEFAULT_OPTIONS = {
  maxBodySize: 64 * 1024,
  ignorePaths: [],
  captureExceptions: true,
  sourceContext: true,
  sourceMaps: true,
  runtime: true,
  captureJobs: true,
  logLevel: 'info',
  timeline: true,
  ...TIMELINE_DEFAULTS
};

// Tried in this order by attachTo(): Nest apps (which pass Express's or Fastify's methods
// through), Hono, Fastify and Koa apps also have use(), and anything with use() is handled as
// middleware before falling back to a plain server.
const ADAPTERS = [NestAdapter, HonoAdapter, FastifyAdapter, KoaAdapter, ExpressAdapter, HttpServerAdapter];

// Marks requests already being recorded, so a request that passes through several integrations
// (or PeekInside instances) is recorded once.
const kTracked = Symbol('peekInside.tracked');

/**
 * PeekInside Class
 *
 * @class PeekInside
 * @example
 * // Express, Koa, Fastify, NestJS, Hono or an http.Server
 * PeekInside.attach(app);
 *
 * @example
 * // Recording through middleware only
 * const peekInside = new PeekInside();
 * app.use(peekInside.expressMiddleware());
 */
class PeekInside {
  /**
   * Create a PeekInside instance
   *
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxBodySize=65536] - Maximum bytes captured per request or response body
   * @param {Array<string|RegExp|Function>} [options.ignorePaths=[]] - Paths that are never recorded:
   *   string prefixes, regular expressions, or predicates receiving the pathname
   * @param {string} [options.project] - Name in the local dashboard. Defaults to PEEKINSIDE_PROJECT,
   *   then the name in your package.json.
   * @param {string} [options.projectRoot] - The project's folder, where its package.json is. By
   *   default it is found from the entry script; its own files are told apart from node_modules
   *   by it.
   * @param {boolean} [options.local] - Turn the free local dashboard on or off. By default it is on,
   *   except when NODE_ENV is "production" or "test", or in CI. PEEKINSIDE_LOCAL=1 or 0 does the same.
   * @param {string} [options.apiKey=process.env.PEEKINSIDE_API_KEY] - PeekInside Cloud API key. When set,
   *   requests are encrypted and sent to PeekInside Cloud instead of the local dashboard.
   * @param {string} [options.environment] - Environment label, such as "staging". Defaults to
   *   PEEKINSIDE_ENV, then NODE_ENV.
   * @param {string} [options.release] - The deploy that is running, such as a commit hash or
   *   "v2.4.0". Defaults to PEEKINSIDE_RELEASE, then the commit your host deployed (Vercel, Render,
   *   Railway, Heroku and others set it), then the commit checked out in the project folder.
   * @param {boolean} [options.captureExceptions=true] - Record exceptions automatically: errors that
   *   reach Express, Koa, Fastify, NestJS or Hono error handling, uncaught exceptions and unhandled
   *   rejections. report() works either way.
   * @param {boolean} [options.sourceContext=true] - Include the source lines around the app's own
   *   stack frames in exception records
   * @param {boolean} [options.sourceMaps=true] - Map stack frames of compiled code (TypeScript
   *   output, bundles) back to the source files, with the source maps the build wrote
   * @param {boolean} [options.timeline=true] - Record a timeline for each request: its database
   *   queries, outgoing calls, console lines and exceptions
   * @param {boolean} [options.captureQueries=true] - pg, mysql2, MongoDB (and Mongoose), Prisma
   * @param {boolean} [options.captureOutgoing=true] - node:http/https requests and fetch
   * @param {boolean} [options.captureLogs=true] - Log lines (the console, pino, winston, NestJS's
   *   Logger): on request timelines and the Logs page
   * @param {'debug'|'info'|'warn'|'error'} [options.logLevel='info'] - The lowest level the Logs
   *   page records
   * @param {boolean} [options.captureJobs=true] - Runs of node-cron, cron, BullMQ and
   *   @nestjs/schedule jobs
   * @param {boolean} [options.queryParams=true] - Keep the (masked) values sent with queries
   * @param {number} [options.slowQueryMs=100] - Queries this slow or slower are flagged
   * @param {number} [options.nPlusOneThreshold=5] - A statement run this many times in one request
   *   is flagged as an N+1
   * @param {number|false} [options.loopBlockMs=100] - Event-loop blocks this long or longer are
   *   recorded on the timelines of the requests in flight; false turns detection off
   * @param {boolean} [options.runtime=true] - Sample the process's memory, CPU and event-loop delay
   *   (every 10 s for the local dashboard, every minute for PeekInside Cloud)
   *
   * @example
   * const peekInside = new PeekInside({
   *   project: 'orders-api',
   *   maxBodySize: 128 * 1024,
   *   ignorePaths: ['/health', /^\/metrics/]
   * });
   */
  constructor(options = {}) {
    /**
     * Effective configuration
     * @type {Object}
     */
    this.options = { ...DEFAULT_OPTIONS, ...definedOnly(options) };

    /**
     * Whether new exchanges are recorded
     * @type {boolean}
     */
    this.isEnabled = true;

    // At most one transport is set: cloud mode wins over the local dashboard.
    this._cloud = null;
    this._local = null;
    // Records this instance's exceptions; null when nothing is recorded at all.
    this._exceptions = null;
    // What each request's timeline records; null when timelines are off.
    this._timeline = null;
    // Local mode only: requests that reached a server are counted instead of recorded.
    this._classifier = null;
    // Whether this instance uses the event-loop monitor, and its process sampler.
    this._loopMonitor = false;
    this._sampler = null;
    // The requests this instance serves, counted for its process samples.
    this._requests = null;
    // Log lines for the Logs page, job runs, and dumps (local mode only).
    this._logs = null;
    this._jobs = null;
    this._dumps = null;
    this._servers = new ServerBinder(this, { onListening: (port) => this._onAppListening(port) });

    const environment = this.options.environment || settings.environment();
    const apiKey = this.options.apiKey || settings.apiKey();
    let project = null;
    const identify = () => project || (project = ProjectIdentity.detect(this.options.project || settings.projectName(), this.options.projectRoot));

    /**
     * The running release, stored with every request and exception; null when none was found
     * @type {string|null}
     */
    this.release = Release.detect({ explicit: this.options.release, root: identify().root });

    if (apiKey) {
      try {
        this._cloud = new CloudTransport({ apiKey, environment, release: this.release, version: VERSION });
        console.log(`${LOG_PREFIX} Sending encrypted requests to PeekInside Cloud (${this._cloud.environment})`);
      } catch (error) {
        console.error(`${LOG_PREFIX} ${error.message}. Nothing will be sent to PeekInside Cloud.`);
      }
    }

    if (!this._cloud) {
      const local = typeof this.options.local === 'boolean' ? this.options.local : settings.localMode();
      if (local) {
        this._local = new LocalTransport({ project: identify(), environment, release: this.release });
        this._classifier = new TrafficClassifier();
      } else {
        this.isEnabled = false;
        if (settings.isProduction()) {
          console.warn(`${LOG_PREFIX} The free local dashboard is for development, so it is off when NODE_ENV=production. Set PEEKINSIDE_API_KEY to use PeekInside Cloud.`);
        }
      }
    }

    if (this._transport) {
      // In both modes, the project folder tells the app's own stack frames from its dependencies'.
      this._exceptions = new ExceptionCapture({
        root: identify().root,
        automatic: this.options.captureExceptions !== false,
        sourceContext: this.options.sourceContext !== false,
        sourceMaps: this.options.sourceMaps !== false,
        isEnabled: () => this.isEnabled,
        sink: () => this._transport,
        owner: this
      });
      ExceptionCapture.register(this._exceptions);
      ProcessMonitor.update();

      const blocks = this.options.timeline !== false && this.options.loopBlockMs !== false && this.options.loopBlockMs !== 0;
      if (blocks || this.options.runtime !== false) {
        LoopMonitor.acquire();
        this._loopMonitor = true;
      }
      if (this.options.runtime !== false) {
        const transport = this._transport;
        this._requests = new RequestCounter();
        this._sampler = new RuntimeSampler({
          intervalMs: this._cloud ? 60_000 : 10_000,
          monitor: LoopMonitor.shared,
          requests: this._requests,
          onSample: (sample) => transport.addSample(sample)
        }).start();
      }

      if (this.options.timeline !== false) {
        this._timeline = new TimelineSettings(this.options, identify().root);
      }
      const logs = this.options.captureLogs !== false;
      if (logs) {
        this._logs = new LogCapture({ level: LogCapture.level(this.options.logLevel), sink: () => this._transport, isEnabled: () => this.isEnabled });
      }
      if (this._local) {
        this._dumps = new DumpCapture({ capture: this._exceptions, sink: () => this._transport, isEnabled: () => this.isEnabled });
      }
      this._jobs = new JobRunner({
        capture: this._exceptions,
        sink: () => this._transport,
        timeline: () => this._timeline,
        isEnabled: () => this.isEnabled
      });
      Instrumentation.install({
        root: identify().root,
        queries: Boolean(this._timeline && this._timeline.captureQueries),
        outgoing: Boolean(this._timeline && this._timeline.captureOutgoing),
        logs,
        jobs: this.options.captureJobs !== false
      });
    }
  }

  /**
   * Record a request/response exchange
   *
   * Works with the native `req`/`res` objects of any Node.js HTTP framework. Request bodies are
   * captured as the application reads them, so middleware order does not matter. The exchange is
   * recorded once the response has been sent, or when the connection closes early (as aborted).
   * Paths matching `ignorePaths` are skipped. In local mode, requests that reached the app on a
   * server (a public domain or client address) are not recorded: servers need PeekInside Cloud.
   *
   * @param {http.IncomingMessage} req - The HTTP request
   * @param {http.ServerResponse} res - The HTTP response
   * @param {Function} [next] - Called once tracking is set up (middleware style)
   * @returns {*} The return value of `next`, if given
   *
   * @example
   * const server = http.createServer((req, res) => {
   *   peekInside.intercept(req, res);
   *   res.end('Hello World!');
   * });
   */
  intercept(req, res, next = null) {
    return this._intercept(req, res, next, 'custom');
  }

  /**
   * Records an error, with the request it relates to: the request running now (found through
   * AsyncLocalStorage), or `options.request`.
   *
   * @param {*} error - An Error, or any thrown value
   * @param {Object} [options]
   * @param {http.IncomingMessage} [options.request] - The request the error relates to
   * @param {Object<string, string>} [options.tags] - Up to 32 short labels, such as `{ plan: 'pro' }`
   * @param {*} [options.extra] - Any JSON-safe data; past 16 KB only a preview is kept
   * @param {boolean} [options.handled=true] - Whether the app handled the error
   * @returns {string|null} The exception's id, or null when nothing was recorded (recording is
   *   off or paused, the request isn't recorded, or too many exceptions were recorded this second)
   *
   * @example
   * try {
   *   await chargeCard(order);
   * } catch (error) {
   *   peekInside.report(error, { tags: { provider: 'stripe' } });
   *   res.status(502).json({ error: 'payment_failed' });
   * }
   */
  report(error, options = {}) {
    return this._exceptions ? this._exceptions.report(error, options || {}) : null;
  }

  /**
   * Runs `fn` and records how long it took on the request's timeline, as a measure span. Async
   * functions are measured until their promise settles. Outside a request (or with timelines off),
   * just runs `fn`.
   *
   * @param {string} name - Shown on the timeline, such as "render invoice"
   * @param {Function} fn - Sync or async
   * @returns {*} What `fn` returns (for an async `fn`, a promise of the same outcome)
   *
   * @example
   * const pdf = await peekInside.measure('render invoice', () => renderPdf(order));
   */
  measure(name, fn) {
    const timeline = this._timeline ? Timeline.current() : null;
    const span = timeline && timeline.settings === this._timeline ? timeline.measure(name) : null;
    if (!span) return fn();

    let result;
    try {
      result = fn();
    } catch (error) {
      span.end({ error });
      throw error;
    }
    // A native promise is followed to its outcome; the returned promise settles the same way, so a
    // rejection nobody handles is still reported. Lazy thenables (query builders) are left alone.
    if (isNativePromise(result)) {
      return result.then(
        (value) => {
          span.end();
          return value;
        },
        (error) => {
          span.end({ error });
          throw error;
        }
      );
    }
    span.end();
    return result;
  }

  /**
   * PeekInside#measure() with the instance that tracks the current request, or else the most
   * recently created instance that records. Without one, just runs `fn`.
   *
   * @param {string} name
   * @param {Function} fn
   * @returns {*} What `fn` returns
   */
  static measure(name, fn) {
    let instance = null;
    try {
      const context = RequestContext.current();
      const capture = context && context.capture && context.capture.recording ? context.capture : ExceptionCapture.latest();
      instance = capture ? capture.owner : null;
    } catch (error) {
      instance = null;
    }
    return instance ? instance.measure(name, fn) : fn();
  }

  /**
   * Shows a value in the local dashboard instead of your terminal: on the Dumps page and under the
   * request (or job run) it was dumped in, as a tree that opens level by level, with the line that
   * dumped it. Returns the value, so it can wrap an expression in place.
   *
   * Dumps are for development: they go to the local dashboard only. With PeekInside Cloud, or when
   * nothing is recorded, dump() just returns the value.
   *
   * @template T
   * @param {T} value - Anything: objects, arrays, Maps, class instances, errors...
   * @param {string} [label] - Shown with the dump, such as "cart before checkout"
   * @returns {T} The same value
   *
   * @example
   * const order = PeekInside.dump(await buildOrder(cart), 'order');
   */
  dump(value, label) {
    if (this._dumps) this._dumps.record(value, label, PeekInside.prototype.dump);
    return value;
  }

  /**
   * PeekInside#dump() with the instance that tracks the current request, or else the most recently
   * created instance that records.
   *
   * @template T
   * @param {T} value
   * @param {string} [label]
   * @returns {T} The same value
   */
  static dump(value, label) {
    try {
      const context = RequestContext.current();
      const capture = context && context.capture && context.capture.recording ? context.capture : ExceptionCapture.latest();
      const owner = capture ? capture.owner : null;
      if (owner && owner._dumps) owner._dumps.record(value, label, PeekInside.dump);
    } catch (error) {
      // The value comes back all the same.
    }
    return value;
  }

  /**
   * The id of the request the calling code runs for: the id its record has in the dashboard, to
   * put in the app's own logs.
   *
   * @returns {string|null} null outside a recorded request
   *
   * @example
   * logger.info({ requestId: PeekInside.requestId() }, 'Charging card');
   */
  static requestId() {
    try {
      const context = RequestContext.current();
      return context ? context.requestId : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Runs a background job as a recorded job run: the Jobs page lists it with how long it took and
   * how it ended, and its queries, calls, log lines and exceptions link to it. A job that throws
   * (or rejects) is recorded as failed, and its error as an exception, grouped into issues like
   * the others. `fn` runs exactly as it would without PeekInside.
   *
   * @param {string} name - Such as "send-invoices"
   * @param {Function} fn - Sync or async
   * @param {Object} [options]
   * @param {string} [options.schedule] - Its cron expression ("0 * * * *"), when it runs on one:
   *   the Jobs page then shows when it misses a run, and PeekInside Cloud can alert you
   * @param {string} [options.timezone] - The schedule's time zone
   * @param {string} [options.queue] - The queue it came from
   * @param {number} [options.attempt=1]
   * @param {*} [options.data] - The job's input, shown with the run (first 8 KB)
   * @returns {*} What fn returns (for an async fn, a promise of the same outcome)
   *
   * @example
   * cron.schedule('0 * * * *', () => peekInside.job('send-invoices', sendInvoices, { schedule: '0 * * * *' }));
   */
  job(name, fn, options = {}) {
    return this._jobs ? this._jobs.run(name, fn, options || {}) : fn();
  }

  /**
   * job() with the instance that tracks the current request, or else the most recently created
   * instance that records. Without one, just runs `fn`.
   *
   * @param {string} name
   * @param {Function} fn
   * @param {Object} [options] - See job()
   * @returns {*} What fn returns
   */
  static job(name, fn, options = {}) {
    try {
      const context = RequestContext.current();
      const owner = context && context.capture && context.capture.recording ? context.capture.owner : null;
      if (owner) return owner.job(name, fn, options);
    } catch (error) {
      // Fall back to the latest instance.
    }
    return JobRunner.run(name, fn, options || {});
  }

  /**
   * Tells PeekInside who the current request is for. The request and every exception it runs into
   * carry the user, so the dashboard counts the users an issue affects and lists everything one
   * customer ran into. In PeekInside Cloud the user is encrypted with the rest of the request.
   * Call it once the user is known, such as in your authentication middleware.
   *
   * @param {{ id?: string|number, email?: string, name?: string, phone?: string|number }|string|number|null} user -
   *   The user, or just their id; null forgets it. The phone is kept as written (phoneNumber,
   *   phone_number and mobile work too).
   * @returns {boolean} Whether a request was running to attach it to
   *
   * @example
   * app.use((req, res, next) => {
   *   if (req.user) PeekInside.setUser({ id: req.user.id, email: req.user.email, name: req.user.name, phone: req.user.phone });
   *   next();
   * });
   */
  static setUser(user) {
    try {
      const context = RequestContext.current();
      if (!context) return false;
      context.user = UserInfo.normalize(user);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Same as PeekInside.setUser(): the user belongs to the request running now.
   *
   * @param {{ id?: string|number, email?: string, name?: string }|string|number|null} user
   * @returns {boolean}
   */
  setUser(user) {
    return PeekInside.setUser(user);
  }

  /**
   * Instruments database modules that automatic patching can't reach: bundled apps, or a
   * monorepo package with its own copy of a driver. Accepts pg, mysql2, mysql2/promise, mongodb,
   * mongoose, a PrismaClient class or instance, and the @prisma/client module; anything else is
   * ignored.
   *
   * @param {...*} modules
   * @returns {PeekInside} This instance, for chaining
   *
   * @example
   * import pg from 'pg';
   * peekInside.instrument(pg);
   */
  instrument(...modules) {
    Instrumentation.instrument(modules);
    return this;
  }

  /**
   * Records an error with the instance that tracks the current request, or else the most recently
   * created instance that records. See PeekInside#report().
   *
   * @param {*} error
   * @param {Object} [options] - See PeekInside#report()
   * @returns {string|null} The exception's id, or null when nothing was recorded
   *
   * @example
   * PeekInside.report(new Error('Cache unavailable'), { extra: { key } });
   */
  static report(error, options = {}) {
    try {
      const request = options && options.request;
      const context = request
        ? RequestContext.of(request) || RequestContext.of(request.raw) || RequestContext.of(request.req)
        : RequestContext.current();
      const owner = context && context.capture && context.capture.recording ? context.capture : null;
      const capture = owner || ExceptionCapture.latest();
      return capture ? capture.report(error, options || {}) : null;
    } catch (failure) {
      return null;
    }
  }

  /**
   * Enable or disable recording
   *
   * @param {boolean} enabled - True to record, false to pause recording
   * @returns {void}
   */
  setEnabled(enabled) {
    this.isEnabled = Boolean(enabled) && Boolean(this._transport);
  }

  /**
   * Express/Connect middleware that records exchanges
   *
   * @returns {Function} Middleware `(req, res, next)`
   */
  expressMiddleware() {
    return this._adapter(ExpressAdapter).middleware();
  }

  /**
   * Koa middleware that records exchanges
   *
   * @returns {Function} Koa middleware `(ctx, next)`
   */
  koaMiddleware() {
    return this._adapter(KoaAdapter).middleware();
  }

  /**
   * Register a Fastify `onRequest` hook that records exchanges
   *
   * @param {Object} fastify - Fastify instance
   * @returns {void}
   */
  fastifyHook(fastify) {
    this._adapter(FastifyAdapter).attach(fastify);
  }

  /**
   * Record every request handled by a native HTTP server
   *
   * @param {http.Server} server - HTTP server
   * @returns {http.Server} The same server
   */
  wrapHttpServer(server) {
    this._adapter(HttpServerAdapter).attach(server);
    return server;
  }

  /**
   * Attach to an application and record its traffic
   *
   * Detects NestJS apps (and application contexts), Hono apps, Fastify, Koa, Express-like apps
   * (Express, Connect) and native `http.Server`s. Attach a NestJS app before app.listen(), a Hono
   * app before serve(), and a Fastify app before fastify.listen().
   *
   * @param {Object} app - Application or server instance
   * @param {Object} [options] - `maxBodySize` and `ignorePaths` to merge into the configuration
   * @returns {PeekInside} This instance, for chaining
   */
  attachTo(app, options = {}) {
    const { maxBodySize, ignorePaths } = options;
    Object.assign(this.options, definedOnly({ maxBodySize, ignorePaths }));

    const Adapter = ADAPTERS.find((candidate) => candidate.matches(app));
    if (Adapter) {
      this._adapter(Adapter).attach(app);
    } else {
      console.warn(`${LOG_PREFIX} Could not detect the framework. Pass an Express, Koa, Fastify, NestJS or Hono app, or use expressMiddleware(), koaMiddleware(), fastifyHook() or wrapHttpServer().`);
    }
    return this;
  }

  /**
   * One-line setup: record every request an app handles
   *
   * @param {Object} app - Express, Koa, Fastify, NestJS or Hono app, or an http.Server
   * @param {Object} [options] - Configuration options (see constructor)
   * @returns {PeekInside} PeekInside instance
   *
   * @example
   * PeekInside.attach(app);
   */
  static attach(app, options = {}) {
    const peekInside = new PeekInside(options);
    if (app) {
      peekInside.attachTo(app);
    }
    return peekInside;
  }

  /**
   * Send everything still queued
   *
   * Useful before a short-lived process exits (scripts, serverless functions, tests).
   *
   * @returns {Promise<void>}
   */
  async flush() {
    const transport = this._transport;
    if (transport) {
      await transport.drain();
    }
  }

  /**
   * Stop recording and sending
   *
   * @returns {void}
   */
  stop() {
    this.isEnabled = false;
    if (this._cloud) {
      this._cloud.stop();
    }
    if (this._local) {
      this._local.stop();
    }
    if (this._exceptions) {
      ExceptionCapture.unregister(this._exceptions);
      ProcessMonitor.update();
    }
    if (this._sampler) {
      this._sampler.stop();
      this._sampler = null;
    }
    if (this._loopMonitor) {
      this._loopMonitor = false;
      LoopMonitor.release();
    }
  }

  // Where recorded exchanges go, or null when recording is off.
  get _transport() {
    return this._cloud || this._local;
  }

  // An adapter for one integration. The first integration used names the app's framework in
  // the local dashboard.
  _adapter(Adapter) {
    if (this._local) {
      this._local.setFramework(Adapter.framework);
    }
    return new Adapter(this, this._servers);
  }

  // Tracks one request and runs the rest of its handling (`next`) inside its context, so that
  // exceptions during it are linked to it. Integrations pass their name, which says how an error
  // escaping the request was captured.
  _intercept(req, res, next, integration) {
    const proceed = typeof next === 'function' ? next : noop;

    if (!this.isEnabled || !req || !res || req[kTracked]) {
      return proceed();
    }

    const url = req.originalUrl || req.url || '/';
    const { pathname, search } = splitUrl(url);
    if (isIgnoredPath(pathname, this.options.ignorePaths)) {
      return proceed();
    }

    req[kTracked] = true;
    let context = null;
    try {
      this._servers.discover(req);
      const target = { url, pathname, search };
      // The free local dashboard is for development: requests that reached a server are not
      // recorded, and neither are their exceptions.
      const signal = this._classifier ? this._classifier.serverSignal(req) : null;
      if (signal) {
        this._local.noteServerRequest(signal);
        context = new RequestContext({ capture: this._exceptions, req, target, blocked: true, integration });
      } else {
        context = this._track(req, res, target, integration);
      }
    } catch (error) {
      // Monitoring must never break the host application.
    }
    return context ? context.run(proceed) : proceed();
  }

  _track(req, res, target, integration) {
    let context = null;
    const requests = this._requests;
    const recorder = new ExchangeRecorder(req, res, target, {
      maxBodySize: () => this.options.maxBodySize,
      onExchange: (exchange) => {
        // Exceptions and timeline first: the record is built from the completed exchange.
        if (context) {
          context.complete(exchange);
        }
        const transport = this._transport;
        if (transport) {
          transport.enqueue(exchange);
        }
      }
    });
    context = new RequestContext({ capture: this._exceptions, req, recorder, target, integration });
    recorder.start();
    if (requests) {
      // Counted off the response itself, so a request ends once whatever happens to its record.
      requests.started();
      let open = true;
      const end = () => {
        if (open) {
          open = false;
          requests.ended();
        }
      };
      res.once('finish', end);
      res.once('close', end);
    }
    if (this._timeline) {
      context.timeline = new Timeline(this._timeline, recorder.perfStart);
    }
    // Listeners of the request's and response's events run for this request too.
    context.bind(req);
    context.bind(res);
    return context;
  }

  // Registers the app with the local dashboard as soon as its port is known.
  _onAppListening(port) {
    if (this._local && this.isEnabled) {
      this._local.start(port);
    }
  }
}

function noop() {}

// Options left undefined must not override the defaults.
function definedOnly(options) {
  const defined = {};
  for (const key of Object.keys(options || {})) {
    if (options[key] !== undefined) {
      defined[key] = options[key];
    }
  }
  return defined;
}

export default PeekInside;
