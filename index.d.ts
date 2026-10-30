/**
 * Type definitions for PeekInside: records every request and response your Node.js app handles,
 * and the exceptions that happen while handling them. In development they go to the free local
 * dashboard; with an API key they are encrypted and sent to PeekInside Cloud.
 *
 * The signatures are structural, so Express, Connect, Koa, Fastify, NestJS, Hono and node:http
 * objects fit without PeekInside depending on any of those packages.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * A path that is never recorded: a prefix such as `"/health"`, a regular expression, or a
 * function that receives the pathname and returns `true` to skip it.
 */
export type IgnorePath = string | RegExp | ((pathname: string) => boolean);

export interface PeekInsideOptions {
  /**
   * Maximum bytes captured per request or response body. Longer bodies are truncated and
   * marked as such in the dashboard.
   * @default 65536
   */
  maxBodySize?: number;

  /** Paths that are never recorded. */
  ignorePaths?: IgnorePath | IgnorePath[];

  /**
   * Name of this app in the local dashboard.
   * @default process.env.PEEKINSIDE_PROJECT, then the name in package.json
   */
  project?: string;

  /**
   * Turns the free local dashboard on or off. By default it is on, except when NODE_ENV is
   * "production" or "test", or in CI. Requests that reach the app as a deployed server are
   * never recorded locally either way: servers need PeekInside Cloud.
   */
  local?: boolean;

  /**
   * PeekInside Cloud API key. When set, requests are encrypted and sent to
   * PeekInside Cloud instead of the local dashboard.
   * @default process.env.PEEKINSIDE_API_KEY
   */
  apiKey?: string;

  /**
   * Environment label shown with each request, such as `"staging"`.
   * @default process.env.PEEKINSIDE_ENV, then process.env.NODE_ENV
   */
  environment?: string;

  /**
   * The deploy that is running, such as `"v2.4.0"` or a commit hash. Stored with every request
   * and exception, so the dashboard shows the deploy an issue first happened in.
   * @default process.env.PEEKINSIDE_RELEASE, then the commit your host deployed (Vercel, Render,
   *   Railway, Heroku, Netlify, Fly.io...), then the commit checked out in the project folder
   */
  release?: string;

  /**
   * The project's folder: its name, git commit and source files are read from there.
   * @default the folder of the package.json nearest to the app's entry file
   */
  projectRoot?: string;

  /**
   * Records exceptions automatically: errors that reach Express, Koa, Fastify, NestJS or Hono error
   * handling, uncaught exceptions and unhandled rejections. `report()` works either way.
   * @default true
   */
  captureExceptions?: boolean;

  /**
   * Includes the source lines around your own code's stack frames in exception records.
   * @default true
   */
  sourceContext?: boolean;

  /**
   * Maps stack frames of compiled code (TypeScript output, bundles) back to your source files,
   * with the source maps your build writes (a `.map` file, or inline). Frames keep where they ran
   * in `generated`.
   * @default true
   */
  sourceMaps?: boolean;

  /**
   * Records a timeline for each request: its database queries, outgoing HTTP calls, console
   * lines and exceptions, with counters (queries, slow queries, N+1 statements...) for the
   * request list. `false` turns the whole timeline off.
   * @default true
   */
  timeline?: boolean;

  /**
   * Records database queries: pg, mysql2, MongoDB (and Mongoose), Prisma. ORMs and query
   * builders running on them (Knex, Sequelize, TypeORM, Drizzle, Kysely) are covered too.
   * @default true
   */
  captureQueries?: boolean;

  /**
   * Records outgoing HTTP calls: node:http/https requests (and clients built on them) and fetch.
   * @default true
   */
  captureOutgoing?: boolean;

  /**
   * Records log lines from the console, pino, winston and NestJS's Logger: on the timeline of the
   * request (or job run) they are written in, and on the Logs page, from anywhere in the app.
   * @default true
   */
  captureLogs?: boolean;

  /**
   * The lowest level the Logs page records. Request timelines keep every level.
   * @default "info"
   */
  logLevel?: "debug" | "info" | "warn" | "error";

  /**
   * Records runs of node-cron, cron, BullMQ and @nestjs/schedule jobs automatically (see `job()`
   * for other jobs).
   * @default true
   */
  captureJobs?: boolean;

  /**
   * Records the emails the app sends with nodemailer, for the local dashboard's Mail page: the
   * message as it was sent (HTML, text, headers, attachments' names), linked to its request or
   * job. Local dashboard only: PeekInside Cloud never gets them.
   * @default true
   */
  captureMail?: boolean;

  /**
   * Keeps the values sent with queries, masked (passwords, tokens and secret-looking values
   * never leave the process).
   * @default true
   */
  queryParams?: boolean;

  /**
   * Queries that take this many milliseconds or longer are flagged as slow.
   * @default 100
   */
  slowQueryMs?: number;

  /**
   * A statement run this many times in one request is flagged as an N+1.
   * @default 5
   */
  nPlusOneThreshold?: number;

  /**
   * Event-loop blocks this long or longer (synchronous work: a large JSON.parse, a slow regular
   * expression, a sync file read) are recorded on the timelines of the requests that waited for
   * them. `false` turns detection off.
   * @default 100
   */
  loopBlockMs?: number | false;

  /**
   * Samples the process's memory, CPU and event-loop delay for the Runtime page: every 10 seconds
   * for the local dashboard, every minute for PeekInside Cloud.
   * @default true
   */
  runtime?: boolean;

  /**
   * Samples the heap (V8's sampling heap profiler: a sample per 512 KiB allocated) to name the
   * functions that hold memory, and those whose memory keeps growing: the Runtime page's leak
   * findings. Only code locations and byte counts leave the process, never values. Needs
   * `runtime`. With PeekInside Cloud, it runs on the plans that include it (Pro and up).
   * @default true
   */
  heapProfiling?: boolean;

  /**
   * Samples what the main thread runs (V8's CPU profiler, every 10 ms) to name the functions
   * behind each event-loop block: on the timelines of the requests that waited, and on the
   * Runtime page. Only code locations and times leave the process. Needs `runtime` and
   * `loopBlockMs`. With PeekInside Cloud, it runs on the plans that include it (Pro and up).
   * @default true
   */
  cpuProfiling?: boolean;
}

/** Options of `job()`. */
export interface JobOptions {
  /**
   * The job's cron expression (`"0 * * * *"`), when it runs on one: the Jobs page then shows when
   * it misses a run, and PeekInside Cloud can email you.
   */
  schedule?: string;
  /** The schedule's time zone, such as `"Europe/Paris"`. */
  timezone?: string;
  /** The queue it came from. */
  queue?: string;
  /** @default 1 */
  attempt?: number;
  /** The job's input, shown with the run (the first 8 KB). */
  data?: unknown;
}

/** Options of `report()`. */
export interface ReportOptions {
  /**
   * The request the error relates to. By default, the request being handled when `report()` is
   * called, if any.
   */
  request?: IncomingMessage;

  /** Up to 32 short labels shown with the exception, such as `{ provider: "stripe" }`. */
  tags?: Record<string, string>;

  /** Any JSON-safe data shown with the exception. Past 16 KB, only a preview is kept. */
  extra?: unknown;

  /**
   * Whether your app handled the error.
   * @default true
   */
  handled?: boolean;

  /** Who it happened to. By default, the user set for the current request (see `setUser`). */
  user?: PeekInsideUser | string | number | null;
}

/** Who a request or an exception was for. Encrypted with the rest in PeekInside Cloud. */
export interface PeekInsideUser {
  id?: string | number;
  email?: string;
  name?: string;
  /** As your app writes it, such as "+91 98765 43210". */
  phone?: string | number;
}

/** Options that can still change after the instance is created (see `attachTo`). */
export type CaptureOptions = Pick<PeekInsideOptions, "maxBodySize" | "ignorePaths">;

/**
 * What `PeekInside.attach()` understands: an Express or Connect app, a Koa app, a Fastify
 * instance, a NestJS app or application context, a Hono app, or a node:http (or https) server.
 */
export type AttachTarget =
  | Server
  | { use(...args: any[]): unknown }
  | { addHook(...args: any[]): unknown }
  | { select(...args: any[]): unknown; useLogger(...args: any[]): unknown }
  | { fetch(...args: any[]): unknown; onError(...args: any[]): unknown };

/** Express and Connect style middleware. */
export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/** Koa style middleware. */
export type KoaMiddleware = (
  context: { req: IncomingMessage; res: ServerResponse },
  next: () => Promise<unknown>,
) => Promise<void>;

/**
 * Records every request and response an app handles.
 *
 * @example
 * import PeekInside from "peekinside";
 *
 * PeekInside.attach(app); // Express, Koa, Fastify, NestJS, Hono or an http.Server
 */
declare class PeekInside {
  /**
   * Creates an instance without attaching it. Use the middleware methods to record traffic,
   * or `PeekInside.attach()` to do both in one line.
   */
  constructor(options?: PeekInsideOptions);

  /** The effective configuration. */
  readonly options: PeekInsideOptions & Required<CaptureOptions>;

  /** Whether new requests are recorded (see `setEnabled`). */
  readonly isEnabled: boolean;

  /** The deploy that is running (see the `release` option), or `null` when none was found. */
  readonly release: string | null;

  /**
   * One-line setup: records every request the app handles. Attach a NestJS app before
   * `app.listen()`, a Hono app before `serve()`, and a Fastify app before `fastify.listen()`.
   *
   * @param app - Express or Connect app, Koa app, Fastify instance, NestJS app or application
   *   context, Hono app, or http.Server
   */
  static attach(app: AttachTarget, options?: PeekInsideOptions): PeekInside;

  /** Attaches this instance to an app; see `PeekInside.attach`. */
  attachTo(app: AttachTarget, options?: CaptureOptions): this;

  /**
   * Records an error, linked to the request being handled (or `options.request`).
   *
   * @param error - An Error, or any thrown value
   * @returns The exception's id, or `null` when nothing was recorded (recording is off or paused,
   *   the request isn't recorded, or too many exceptions were recorded this second)
   *
   * @example
   * try {
   *   await chargeCard(order);
   * } catch (error) {
   *   peekInside.report(error, { tags: { provider: "stripe" } });
   * }
   */
  report(error: unknown, options?: ReportOptions): string | null;

  /**
   * Records an error with the instance that tracks the current request, or else the most
   * recently created instance that records. See `report()`.
   */
  static report(error: unknown, options?: ReportOptions): string | null;

  /**
   * Runs `fn` and records how long it took on the request's timeline. Async functions are
   * measured until their promise settles. Outside a request, just runs `fn`.
   *
   * @example
   * const pdf = await peekInside.measure("render invoice", () => renderPdf(order));
   */
  measure<T>(name: string, fn: () => T): T;

  /**
   * `measure()` with the instance that tracks the current request, or else the most recently
   * created instance that records. Without one, just runs `fn`.
   */
  static measure<T>(name: string, fn: () => T): T;

  /**
   * Shows a value in the local dashboard instead of your terminal: on the Dumps page and under the
   * request (or job run) it was dumped in, as a tree that opens level by level, with the line that
   * dumped it. Returns the value, so it can wrap an expression in place.
   *
   * Dumps are for development: they go to the local dashboard only. With PeekInside Cloud, or when
   * nothing is recorded, `dump()` just returns the value.
   *
   * @param label - Shown with the dump, such as `"cart before checkout"`
   *
   * @example
   * const order = PeekInside.dump(await buildOrder(cart), "order");
   */
  dump<T>(value: T, label?: string): T;

  /**
   * `dump()` with the instance that tracks the current request, or else the most recently created
   * instance that records.
   */
  static dump<T>(value: T, label?: string): T;

  /**
   * The id of the request the calling code runs for, as the dashboard knows it: put it in your
   * own logs to find the request from a log line. `null` outside a recorded request.
   */
  static requestId(): string | null;

  /**
   * Tells PeekInside who the current request is for: the request and every exception it runs into
   * carry the user, so the dashboard counts the users an issue affects and lists everything one
   * customer ran into. Call it once the user is known, such as in your authentication middleware.
   *
   * @param user - The user, or just their id; `null` forgets it
   * @returns Whether a request was running to attach it to
   *
   * @example
   * app.use((req, res, next) => {
   *   if (req.user) PeekInside.setUser({ id: req.user.id, email: req.user.email, name: req.user.name, phone: req.user.phone });
   *   next();
   * });
   */
  static setUser(user: PeekInsideUser | string | number | null): boolean;

  /** Same as `PeekInside.setUser()`: the user belongs to the request running now. */
  setUser(user: PeekInsideUser | string | number | null): boolean;

  /**
   * Runs a background job as a recorded job run: the Jobs page lists it with how long it took and
   * how it ended, and its queries, calls, log lines and exceptions link to it. A job that throws or
   * rejects is recorded as failed, and its error as an exception. `fn` runs exactly as without
   * PeekInside, and its result (or error) is returned (or thrown) unchanged.
   *
   * @example
   * cron.schedule("0 * * * *", () =>
   *   peekInside.job("send-invoices", sendInvoices, { schedule: "0 * * * *" }));
   */
  job<T>(name: string, fn: () => T, options?: JobOptions): T;

  /**
   * `job()` with the instance that tracks the current request, or else the most recently created
   * instance that records. Without one, just runs `fn`.
   */
  static job<T>(name: string, fn: () => T, options?: JobOptions): T;

  /**
   * Instruments database modules that automatic patching can't reach (bundled apps, a monorepo
   * package with its own copy): pg, mysql2, mysql2/promise, mongodb, mongoose, a PrismaClient
   * class or instance, or the @prisma/client module. Other values are ignored.
   *
   * @example
   * import pg from "pg";
   * peekInside.instrument(pg);
   */
  instrument(...modules: unknown[]): this;

  /**
   * Records one request/response pair, for frameworks without a ready-made integration.
   * Request bodies are captured as the app reads them, so call it before reading the body.
   *
   * @param next - Called once tracking is set up (middleware style); its result is returned
   */
  intercept(req: IncomingMessage, res: ServerResponse, next?: () => unknown): unknown;

  /** Pauses (`false`) or resumes (`true`) recording. */
  setEnabled(enabled: boolean): void;

  /** Express and Connect middleware that records requests. */
  expressMiddleware(): NodeMiddleware;

  /** Koa middleware that records requests. */
  koaMiddleware(): KoaMiddleware;

  /** Registers a Fastify `onRequest` hook that records requests. */
  fastifyHook(fastify: { addHook(...args: any[]): unknown; server?: Server }): void;

  /** Records every request a node:http (or https) server handles. Returns the same server. */
  wrapHttpServer<T extends Server>(server: T): T;

  /**
   * Sends everything still queued. Call it before a short-lived process (script, serverless
   * function, test) exits.
   */
  flush(): Promise<void>;

  /** Stops recording and sending. */
  stop(): void;
}

export default PeekInside;
