/**
 * NestJS integration (Nest 10 and later, on Express or Fastify).
 *
 * Nest answers errors itself: its exception filters run before Express or Fastify see an error,
 * and its default filter answers 500 and logs it. So PeekInside hooks into Nest's own pieces,
 * reached through the app object, which makes the copy of Nest the app runs the one that is
 * patched, whichever module system loaded it:
 *
 * - Requests are recorded from the HTTP server Nest created, before Express or Fastify runs, so
 *   bodies are captured as they arrive and middleware order doesn't matter.
 * - Each route handler Nest builds (RouterExplorer#createCallbackProxy) is wrapped to note the
 *   controller method and the route pattern on the request, before guards, pipes and
 *   interceptors run.
 * - Every error of an HTTP request passes through ExceptionsHandler#next. One that an exception
 *   filter of the app catches is handled, unless the filter hands it to Nest's default answer
 *   (BaseExceptionFilter#catch, what `super.catch()` calls); an error that gets the default answer
 *   is unhandled. Errors with a 4xx status (NotFoundException, BadRequestException...) are how an
 *   app answers bad requests, and aren't recorded.
 * - Nest's Logger lines and @nestjs/schedule's jobs are recorded too (see
 *   instrumentation/loggers.js and instrumentation/jobs.js).
 *
 * Nest registers routes and scheduled methods when the app initializes, so attach before
 * app.listen() (or app.init()). A worker made with NestFactory.createApplicationContext() is
 * initialized by then: for its scheduled methods, PeekInside must exist before the worker does
 * (instrumentation/index.js patches @nestjs/schedule when PeekInside is created). Every step is
 * feature-detected: a Nest version that doesn't fit is left alone.
 */

import { LOG_PREFIX } from '../config.js';
import { RequestContext } from '../exceptions/request-context.js';
import { JobInstrumentation } from '../instrumentation/jobs.js';
import { LoggerInstrumentation } from '../instrumentation/loggers.js';
import { FrameworkAdapter } from './framework-adapter.js';

const kRoutes = Symbol('peekInside.nestRoutes');
const kErrors = Symbol('peekInside.nestErrors');

/**
 * Records a Nest app's requests from its HTTP server, and hooks into Nest for the rest.
 */
export class NestAdapter extends FrameworkAdapter {
  static framework = 'nest';

  /**
   * @param {*} app
   * @returns {boolean} Whether `app` looks like a Nest application (NestFactory.create()) or
   *   application context (NestFactory.createApplicationContext(), such as a worker)
   */
  static matches(app) {
    return Boolean(app) && typeof app.select === 'function' && typeof app.useLogger === 'function' && typeof app.resolve === 'function';
  }

  /**
   * Binds the app's HTTP server (an application context has none) and installs the hooks. Logs and
   * jobs are only hooked for an instance that records.
   *
   * @param {Object} app - What NestFactory.create() returned
   * @returns {void}
   */
  attach(app) {
    const { options } = this.peekInside;
    const records = Boolean(this.peekInside._transport);
    const installed = NestHooks.install(app, {
      exceptions: options.captureExceptions !== false,
      logs: records && options.captureLogs !== false,
      jobs: records && options.captureJobs !== false
    });
    if (installed.lateJobs) {
      console.warn(`${LOG_PREFIX} This NestJS app set up its scheduled jobs before PeekInside existed, so their failures and their @Interval and @Timeout runs aren't recorded. Create PeekInside first (new PeekInside()), then attach it with peekInside.attachTo(app).`);
    }
    const server = httpServerOf(app);
    if (server) this.servers.bind(server, { interceptRequests: true, integration: 'nest' });
  }
}

/**
 * Installs the hooks into a Nest app.
 */
export class NestHooks {
  /**
   * @param {Object} app
   * @param {Object} [options]
   * @param {boolean} [options.exceptions=true] - Record the errors Nest answers
   * @param {boolean} [options.logs=true] - Record Nest's Logger lines (ConsoleLogger)
   * @param {boolean} [options.jobs=true] - Record @nestjs/schedule's jobs
   * @returns {{ routes: boolean, errors: boolean, logs: boolean, jobs: boolean, lateJobs: boolean }}
   *   What was hooked, and whether scheduled methods were registered before the scheduler was
   */
  static install(app, { exceptions = true, logs = true, jobs = true } = {}) {
    const installed = { routes: false, errors: false, logs: false, jobs: false, lateJobs: false };
    try {
      const resolver = read(app, 'routesResolver');
      installed.routes = patchRoutes(read(resolver, 'routerExplorer'));
      if (exceptions) installed.errors = patchErrors(read(resolver, 'routerExceptionsFilter'));
      if (logs) installed.logs = LoggerInstrumentation.nest(activeLogger(app));
      const explorer = jobs ? scheduleExplorer(app) : null;
      if (explorer) {
        installed.jobs = JobInstrumentation.nestSchedule(explorer);
        installed.lateJobs = registeredBefore(explorer);
      }
    } catch (error) {
      // Whatever was hooked stays; the rest is left alone.
    }
    return installed;
  }
}

// Wraps the handler Nest builds for each route: it notes the controller method and the route the
// request matched before Nest runs guards, pipes, interceptors and the method.
function patchRoutes(explorer) {
  const proto = explorer ? Object.getPrototypeOf(explorer) : null;
  if (!proto || typeof proto.createCallbackProxy !== 'function') return false;
  if (proto[kRoutes]) return true;
  const original = proto.createCallbackProxy;
  proto.createCallbackProxy = function (instance, callback, methodName) {
    const proxy = original.apply(this, arguments);
    if (typeof proxy !== 'function') return proxy;
    const handler = handlerName(instance, methodName);
    return function (req, res, next) {
      noteRoute(req, handler);
      return proxy.apply(this, arguments);
    };
  };
  Object.defineProperty(proto, kRoutes, { value: true });
  return true;
}

// Observes ExceptionsHandler#next and BaseExceptionFilter#catch. ExceptionsHandler isn't exported
// by every Nest version: the app's RouterExceptionFilters creates one, which gives its prototype.
function patchErrors(filters) {
  let sample = null;
  try {
    sample = filters && typeof filters.create === 'function' ? filters.create({}, function handler() {}, undefined) : null;
  } catch (error) {
    sample = null;
  }
  const proto = sample ? Object.getPrototypeOf(sample) : null;
  if (!proto || typeof proto.next !== 'function') return false;
  if (proto[kErrors]) return true;

  const originalNext = proto.next;
  proto.next = function (exception, host) {
    try {
      if (catchesIt(this.filters, exception)) noteError(host, exception, true);
    } catch (failure) {
      // Never in the way of the app's error handling.
    }
    return originalNext.apply(this, arguments);
  };
  Object.defineProperty(proto, kErrors, { value: true });

  const base = Object.getPrototypeOf(proto);
  if (base && base !== Object.prototype && typeof base.catch === 'function' && !base[kErrors]) {
    const originalCatch = base.catch;
    base.catch = function (exception, host) {
      noteError(host, exception, false);
      return originalCatch.apply(this, arguments);
    };
    Object.defineProperty(base, kErrors, { value: true });
  }
  return true;
}

// Whether one of the app's exception filters catches the error, as Nest picks them: a filter
// with no exception types catches everything.
function catchesIt(filters, exception) {
  if (!Array.isArray(filters) || !filters.length) return false;
  return filters.some((filter) => {
    const types = filter && Array.isArray(filter.exceptionMetatypes) ? filter.exceptionMetatypes : [];
    return !types.length || types.some((type) => typeof type === 'function' && exception instanceof type);
  });
}

// An error a filter catches stays open: the filter may still hand it to Nest's default answer.
function noteError(host, exception, handled) {
  try {
    const req = host && typeof host.getArgByIndex === 'function' ? host.getArgByIndex(0) : null;
    const context = RequestContext.of(nodeRequest(req)) || RequestContext.current();
    if (context && context.capture) {
      context.capture.frameworkError(context, exception, { mechanism: 'nest', handled, open: handled });
    }
  } catch (failure) {
    // Recording must never change the error the app sees.
  }
}

function noteRoute(req, handler) {
  try {
    const raw = nodeRequest(req);
    const context = RequestContext.of(raw);
    if (!context) return;
    // Express keeps the route parameters on the Node.js request; Fastify on its own request.
    context.noteRoute({ route: routeOf(req), handler, ...(raw !== req ? { params: () => req.params } : {}) });
  } catch (error) {
    // The request is recorded without them.
  }
}

// The route pattern the platform matched: Express's Route, Fastify's route options (routerPath
// before Fastify 4.10).
function routeOf(req) {
  if (!req) return null;
  if (req.route && typeof req.route.path === 'string') return req.route.path;
  const options = req.routeOptions;
  if (options && typeof options === 'object') return typeof options.url === 'string' ? options.url : null;
  return typeof req.routerPath === 'string' ? req.routerPath : null;
}

// "OrdersController.create"
function handlerName(instance, methodName) {
  const owner = instance && instance.constructor && typeof instance.constructor.name === 'string' ? instance.constructor.name : '';
  const method = typeof methodName === 'string' ? methodName : '';
  return owner && method ? `${owner}.${method}` : method || null;
}

// The Node.js request behind what Nest passes around: Express's request is the Node.js one,
// Fastify's keeps it in `raw`.
function nodeRequest(req) {
  return req && typeof req === 'object' && req.raw && typeof req.raw === 'object' ? req.raw : req;
}

// The logger Nest's Logger writes through: its ConsoleLogger, unless the app set another one.
function activeLogger(app) {
  const logger = read(app, 'logger');
  const Logger = logger && logger.constructor;
  return Logger && typeof Logger === 'function' ? Logger.staticInstanceRef || null : null;
}

// @nestjs/schedule's ScheduleExplorer, one of the app's providers.
function scheduleExplorer(app) {
  const container = read(app, 'container');
  const modules = container && typeof container.getModules === 'function' ? container.getModules() : null;
  if (!modules || typeof modules.values !== 'function') return null;
  for (const module of modules.values()) {
    const providers = module && module.providers;
    if (!providers || typeof providers.values !== 'function') continue;
    for (const wrapper of providers.values()) {
      let instance = null;
      try {
        instance = wrapper ? wrapper.instance : null;
      } catch (error) {
        instance = null;
      }
      if (instance && typeof instance.wrapFunctionInTryCatchBlocks === 'function' && typeof instance.lookupSchedulers === 'function') return instance;
    }
  }
  return null;
}

// Whether the scheduler registered methods before it was patched: their errors are swallowed
// unrecorded, and intervals and timeouts aren't job runs.
function registeredBefore(explorer) {
  const orchestrator = read(explorer, 'schedulerOrchestrator');
  return ['cronJobs', 'intervals', 'timeouts'].some((key) => {
    const registered = read(orchestrator, key);
    return Boolean(registered) && Object.values(registered).some((entry) => entry && typeof entry.target === 'function' && !JobInstrumentation.isRun(entry.target));
  });
}

function httpServerOf(app) {
  try {
    const server = typeof app.getHttpServer === 'function' ? app.getHttpServer() : null;
    return server && typeof server.emit === 'function' ? server : null;
  } catch (error) {
    return null;
  }
}

// An object property of Nest's internals, or null.
function read(target, key) {
  try {
    const value = target ? target[key] : null;
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    return null;
  }
}
