/**
 * The tools `npx peekinside mcp` gives AI tools: read what PeekInside recorded (errors, requests,
 * queries, logs, jobs, the runtime), replay a request on this machine, and mark an error resolved.
 * Each answers in text: the facts that help find and fix a problem, with the ids to ask for more,
 * and never throws: what goes wrong is its answer.
 */

import path from 'path';
import { Fmt, bodyText, dumpText, frameLines, headerLines, mask, maskText, timelineLines } from './format.js';
import { PAGE_SIZE, SourceError } from './sources.js';

// What was read is reused by the next call for this long: the data keeps arriving.
const FRESH_MS = 15_000;
// Records read at most for one window: a busy app's longer windows are its latest records.
const CAPS = { requests: 10_000, exceptions: 5_000, jobs: 5_000, logs: 10_000, dumps: 1_000, mails: 500 };
// Requests opened at once, and in all, to read their queries.
const DETAIL_WORKERS = 6;
const QUERY_DETAILS = 200;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const RUNTIME_RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'];
const UNITS = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** A tool call that can't be answered as asked; its message is the answer. */
export class ToolError extends Error {}

// Arguments most tools share.
const ARGS = {
  project: { type: 'string', description: 'Project id or name, from list_projects. Default: the project of the folder you run in.' },
  environment: { type: 'string', description: 'Only this environment, such as "production".' },
  since: (fallback) => ({ type: 'string', description: `How far back to look: "30m", "6h", "7d", "all", or a date (default "${fallback}").` }),
  limit: (fallback, max) => ({ type: 'integer', minimum: 1, maximum: max, description: `At most this many (default ${fallback}).` }),
  id: (what) => ({ type: 'string', description: what })
};

/**
 * The tools, as AI tools list them: `local` and `cloud` say where each works, `permission` what the
 * member's role must allow on PeekInside Cloud, `changes` whether it changes anything, and
 * `destructive` and `idempotent` how (for AI tools deciding what to run without asking).
 */
export const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List the projects PeekInside records: on this machine, every app that uses PeekInside (running or not, with its folder); on PeekInside Cloud, the project this MCP key reads. Use the id as "project" in the other tools.',
    properties: {},
    local: true,
    cloud: true,
    run: (box) => box.listProjects()
  },
  {
    name: 'list_errors',
    title: 'List errors',
    description: 'List errors the app threw, grouped into issues (the same error from the same code), the most recent first: how often each happened, when, where in the code, the route, and whether it is resolved. Start here to find bugs to fix, then call get_error with an issue id for its stack trace, source lines and the request behind it.',
    properties: {
      project: ARGS.project,
      since: ARGS.since('7d'),
      status: { type: 'string', enum: ['unresolved', 'resolved', 'all'], description: 'Unresolved (the default) includes resolved issues that came back.' },
      search: { type: 'string', description: 'Only issues whose name, message, code, file, function or path contains this.' },
      environment: ARGS.environment,
      limit: ARGS.limit(20, 100)
    },
    local: true,
    cloud: true,
    permission: 'exceptions:read',
    run: (box, args, project) => box.listErrors(args, project)
  },
  {
    name: 'get_error',
    title: 'Get an error',
    description: 'Everything about one error: the stack trace with the source lines around each line of the app\'s code, the causes, how often it happened, and the request it happened in (method, URL, status, route, user) with what that request did before failing (database queries, outgoing HTTP calls, logs). Pass an issue id from list_errors (its latest occurrence) or an exception id.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('An issue id (16 hex characters) or an exception id.')
    },
    required: ['id'],
    local: true,
    cloud: true,
    permission: 'exceptions:read',
    run: (box, args, project) => box.getError(args, project)
  },
  {
    name: 'resolve_error',
    title: 'Resolve an error',
    description: 'Mark an error issue resolved once its fix is in, as the Exceptions page does: if it happens again, PeekInside shows it as a regression. Pass reopen: true to mark it unresolved again.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('An issue id (16 hex characters) or an exception id.'),
      reopen: { type: 'boolean', description: 'Mark it unresolved instead.' }
    },
    required: ['id'],
    local: true,
    cloud: true,
    permission: 'exceptions:resolve',
    changes: true,
    run: (box, args, project) => box.resolveError(args, project)
  },
  {
    name: 'list_requests',
    title: 'List requests',
    description: 'List HTTP requests the app handled, newest (or slowest) first, with status, duration, queries and errors. Filter by status ("5xx", "4xx", "404"), method, path or route, duration, and by what they had: an exception, an N+1 query pattern, a slow or duplicate query, a blocked event loop.',
    properties: {
      project: ARGS.project,
      since: ARGS.since('1h'),
      status: { type: 'string', description: 'A class such as "5xx" or "4xx", a code such as "404", or "none" (no response sent).' },
      method: { type: 'string', description: 'Such as "POST".' },
      path: { type: 'string', description: 'Only requests whose path, URL or route contains this.' },
      min_duration: { type: 'number', minimum: 0, description: 'Only requests that took at least this many ms.' },
      has: { type: 'string', enum: ['exception', 'n+1', 'slow-query', 'duplicate-query', 'blocked-loop'], description: 'Only requests that had this.' },
      sort: { type: 'string', enum: ['newest', 'slowest'], description: 'Default: newest.' },
      environment: ARGS.environment,
      limit: ARGS.limit(30, 200)
    },
    local: true,
    cloud: true,
    permission: 'requests:read',
    run: (box, args, project) => box.listRequests(args, project)
  },
  {
    name: 'get_request',
    title: 'Get a request',
    description: 'One request in full: headers, query, parameters and body, and the response (credentials masked); its exceptions; and its timeline: every database query grouped by statement (N+1 patterns, slow and duplicate queries flagged, with the code that ran them), outgoing HTTP calls, logs, event-loop blocks, in order.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('A request id, from list_requests, list_errors or get_error.')
    },
    required: ['id'],
    local: true,
    cloud: true,
    permission: 'requests:read',
    run: (box, args, project) => box.getRequest(args, project)
  },
  {
    name: 'replay_request',
    title: 'Replay a request',
    description: 'Send a recorded request to the app running on this machine again (same method, URL, headers and body), to check a fix: answers with the new status, and the new request\'s id for get_request. Only for the local dashboard; the app must be running.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('The id of the request to send again.')
    },
    required: ['id'],
    local: true,
    cloud: false,
    changes: true,
    // It sends a recorded POST or DELETE again, with its cookies and credentials: AI tools should ask first.
    destructive: true,
    idempotent: false,
    run: (box, args, project) => box.replayRequest(args, project)
  },
  {
    name: 'list_queries',
    title: 'List database queries',
    description: 'Database queries across recent requests, grouped by statement, the worst first: N+1 patterns (the same statement run once per item), slow statements and duplicates, with the code that runs them and the routes they slow down. Use it to find performance problems in data access.',
    properties: {
      project: ARGS.project,
      since: ARGS.since('1h'),
      path: { type: 'string', description: 'Only requests whose path, URL or route contains this.' },
      environment: ARGS.environment,
      limit: ARGS.limit(15, 50)
    },
    local: true,
    cloud: true,
    permission: 'requests:read',
    run: (box, args, project) => box.listQueries(args, project)
  },
  {
    name: 'list_logs',
    title: 'List logs',
    description: 'Log lines the app wrote (console, pino, winston, NestJS), newest first, by level and text; or the lines of one request or job run.',
    properties: {
      project: ARGS.project,
      since: ARGS.since('1h'),
      level: { type: 'string', enum: LEVELS, description: 'This level and above (default: all).' },
      search: { type: 'string', description: 'Only lines that contain this.' },
      request_id: { type: 'string', description: 'Only the lines of this request.' },
      job_run_id: { type: 'string', description: 'Only the lines of this job run.' },
      environment: ARGS.environment,
      limit: ARGS.limit(50, 500)
    },
    local: true,
    cloud: true,
    permission: 'logs:read',
    run: (box, args, project) => box.listLogs(args, project)
  },
  {
    name: 'list_jobs',
    title: 'List job runs',
    description: 'Background and scheduled jobs (cron, BullMQ, NestJS schedules, and jobs the app reports): each job\'s runs, failures, last run and schedule, then the runs themselves, newest first, with their errors.',
    properties: {
      project: ARGS.project,
      since: ARGS.since('24h'),
      name: { type: 'string', description: 'Only jobs whose name contains this.' },
      status: { type: 'string', enum: ['failed', 'ok'], description: 'Only runs with this outcome.' },
      environment: ARGS.environment,
      limit: ARGS.limit(30, 200)
    },
    local: true,
    cloud: true,
    permission: 'jobs:read',
    run: (box, args, project) => box.listJobs(args, project)
  },
  {
    name: 'get_job_run',
    title: 'Get a job run',
    description: 'One job run in full: its error, the data it ran with, its exceptions, and its timeline (database queries, outgoing HTTP calls, logs).',
    properties: {
      project: ARGS.project,
      id: ARGS.id('A job run id, from list_jobs.')
    },
    required: ['id'],
    local: true,
    cloud: true,
    permission: 'jobs:read',
    run: (box, args, project) => box.getJobRun(args, project)
  },
  {
    name: 'get_runtime',
    title: 'Get the runtime',
    description: 'The app\'s processes: memory (heap, RSS, and whether the heap keeps growing), CPU, event-loop delay, garbage collection, open handles, and, when profiling is on, the functions holding the most heap memory and the functions that blocked the event loop. Use it for memory leaks, high CPU, and slowness that queries don\'t explain.',
    properties: {
      project: ARGS.project,
      range: { type: 'string', enum: RUNTIME_RANGES, description: 'PeekInside Cloud: the window (default "1h"). The local dashboard keeps the last few minutes.' },
      environment: ARGS.environment
    },
    local: true,
    cloud: true,
    permission: 'runtime:read',
    run: (box, args, project) => box.getRuntime(args, project)
  },
  {
    name: 'list_dumps',
    title: 'List dumps',
    description: 'Values the app dumped with PeekInside\'s dump(), newest first, with where each was dumped; pass an id for one value in full. Only for the local dashboard.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('One dump\'s id, for its whole value.'),
      since: ARGS.since('1h'),
      request_id: { type: 'string', description: 'Only the dumps of this request.' },
      limit: ARGS.limit(20, 100)
    },
    local: true,
    cloud: false,
    run: (box, args, project) => box.listDumps(args, project)
  },
  {
    name: 'list_emails',
    title: 'List emails',
    description: 'Emails the app sent (Nodemailer), newest first: who to, the subject, and whether the transport accepted them; pass an id for one email\'s headers and text. Only for the local dashboard.',
    properties: {
      project: ARGS.project,
      id: ARGS.id('One email\'s id, for its headers and text.'),
      since: ARGS.since('24h'),
      limit: ARGS.limit(20, 100)
    },
    local: true,
    cloud: false,
    run: (box, args, project) => box.listEmails(args, project)
  }
];

/**
 * Runs tools against one source.
 */
export class Toolbox {
  /**
   * @param {Object} options
   * @param {import('./sources.js').HubSource|import('./sources.js').CloudSource} options.source
   * @param {string|null} [options.project] - The project tools read when they aren't told (local):
   *   an id or a name; by default the one of `cwd`
   * @param {string|null} [options.cwd] - The folder the AI tool started this in (null: unknown,
   *   as over HTTP)
   * @param {() => number} [options.now]
   */
  constructor({ source, project = null, cwd = process.cwd(), now = Date.now }) {
    this.source = source;
    this.defaultProject = project;
    this.cwd = cwd;
    this.now = now;
    this.reader = new RecordReader(source);
  }

  /**
   * The tools this source offers, as MCP lists them. On PeekInside Cloud, only those the key's
   * member may use (all of them when the key can't be checked now: calls then say why).
   *
   * @returns {Promise<Object[]>}
   */
  async definitions() {
    let permissions = null;
    if (this.source.cloud) {
      permissions = await this.source.connect().then((session) => session.permissions, () => null);
    }
    return TOOLS
      .filter((tool) => (this.source.cloud ? tool.cloud : tool.local))
      .filter((tool) => !permissions || !tool.permission || permissions.includes(tool.permission))
      .map((tool) => {
        const properties = { ...tool.properties };
        if (this.source.cloud) delete properties.project;
        return {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: { type: 'object', properties, ...(tool.required ? { required: tool.required } : {}), additionalProperties: false },
          annotations: { title: tool.title, readOnlyHint: !tool.changes, destructiveHint: tool.destructive === true, idempotentHint: tool.idempotent !== false, openWorldHint: false }
        };
      });
  }

  /**
   * @param {string} name
   * @returns {boolean} Whether there is such a tool for this source
   */
  has(name) {
    return TOOLS.some((tool) => tool.name === name && (this.source.cloud ? tool.cloud : tool.local));
  }

  /**
   * Runs a tool. Never throws: a failure is the answer, marked as an error.
   *
   * @param {string} name
   * @param {Object} [args]
   * @returns {Promise<{ text: string, isError: boolean }>}
   */
  async call(name, args = {}) {
    const tool = TOOLS.find((item) => item.name === name && (this.source.cloud ? item.cloud : item.local));
    try {
      if (!tool) throw new ToolError(`There's no tool called ${name} here.`);
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const project = tool.name === 'list_projects' ? null : await this.project(input);
      return { text: await tool.run(this, input, project), isError: false };
    } catch (error) {
      if (error instanceof ToolError || error instanceof SourceError) return { text: error.message, isError: true };
      return { text: `PeekInside couldn't answer: ${error && error.message ? error.message : error}`, isError: true };
    }
  }

  /**
   * The project a call is about: the one named, else the default, else the one of the folder.
   *
   * @param {Object} args
   * @returns {Promise<{ id: string, name: string, root?: string }>}
   */
  async project(args) {
    if (this.source.cloud) {
      const session = await this.source.connect();
      return session.project;
    }
    const projects = await this.source.projects();
    if (!projects.length) {
      throw new ToolError('PeekInside has no projects yet. Start an app that uses PeekInside, or run `npx peekinside test` in a project\'s folder to send a test error.');
    }
    const names = () => projects.map((project) => `${project.id}${project.name !== project.id ? ` (${project.name})` : ''}`).join(', ');
    const named = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    for (const wanted of [named, this.defaultProject]) {
      if (!wanted) continue;
      const lower = wanted.toLowerCase();
      const match = projects.find((project) => project.id === wanted)
        || projects.find((project) => String(project.name).toLowerCase() === lower)
        || projects.find((project) => project.root && path.basename(project.root).toLowerCase() === lower);
      if (match) return match;
      if (wanted === named) throw new ToolError(`There's no project "${wanted}". Projects: ${names()}.`);
    }
    if (!this.cwd) {
      if (projects.length === 1) return projects[0];
      throw new ToolError(`Several projects use PeekInside: pass "project" as one of ${names()}.`);
    }
    const cwd = path.resolve(this.cwd);
    const rooted = projects.filter((project) => typeof project.root === 'string' && project.root);
    const containing = rooted
      .filter((project) => isInside(cwd, path.resolve(project.root)))
      .sort((a, b) => b.root.length - a.root.length);
    if (containing.length) return containing[0];
    const below = rooted.filter((project) => isInside(path.resolve(project.root), cwd));
    if (below.length === 1) return below[0];
    if (projects.length === 1) return projects[0];
    throw new ToolError(`Several projects use PeekInside: pass "project" as one of ${names()}.`);
  }

  // list_projects
  async listProjects() {
    const now = this.now();
    if (this.source.cloud) {
      const session = await this.source.connect();
      const reads = session.permissions.filter((permission) => permission.endsWith(':read')).map((permission) => permission.split(':')[0]);
      const lines = [
        `PeekInside Cloud project: ${session.project.name} (id ${session.project.id})${session.organization ? `, in ${session.organization.name}` : ''}`,
        `This MCP key${session.keyName ? ` ("${session.keyName}")` : ''} reads its ${reads.length ? reads.join(', ') : 'nothing: its member\'s role reads none of it'}${session.permissions.includes('exceptions:resolve') ? ', and can resolve errors' : ''}.`,
        `Records are decrypted on this machine; the dashboard: ${session.dashboardUrl}`
      ];
      return lines.join('\n');
    }
    const projects = await this.source.projects();
    if (!projects.length) return `PeekInside Local (${this.source.dashboardUrl}) has no projects yet. Start an app that uses PeekInside.`;
    let current = null;
    try {
      current = await this.project({});
    } catch (error) {
      current = null;
    }
    const lines = [`Projects in PeekInside Local (${this.source.dashboardUrl}):`];
    for (const project of projects) {
      const instance = project.instances && project.instances[0];
      const state = project.online
        ? `running${instance && instance.port ? ` on port ${instance.port}` : ''}${instance && instance.framework ? ` (${instance.framework}${instance.pid ? `, pid ${instance.pid}` : ''})` : ''}`
        : `stopped${project.lastSeenAt ? `, last seen ${Fmt.ago(project.lastSeenAt, now)}` : ''}`;
      lines.push(`${project.online ? '●' : '○'} ${project.name} (id ${project.id})${current && current.id === project.id ? ' [this folder\'s project, the default]' : ''}: ${state}`);
      if (project.root) lines.push(`  folder: ${project.root}`);
      const counts = [
        Number.isInteger(project.requestCount) ? Fmt.count(project.requestCount, 'request') : null,
        Number.isInteger(project.exceptionCount) ? `${Fmt.count(project.exceptionCount, 'exception')}${project.lastExceptionAt ? ` (last ${Fmt.ago(project.lastExceptionAt, now)})` : ''}` : null,
        project.jobCount ? Fmt.count(project.jobCount, 'job run') : null,
        project.logCount ? Fmt.count(project.logCount, 'log line') : null
      ].filter(Boolean);
      if (counts.length) lines.push(`  ${counts.join(' · ')}${project.lastRequestAt ? ` · last request ${Fmt.ago(project.lastRequestAt, now)}` : ''}`);
    }
    return lines.join('\n');
  }

  // list_errors
  async listErrors(args, project) {
    const now = this.now();
    const since = parseSince(args.since, '7d', now);
    const status = oneOf(args, 'status', ['unresolved', 'resolved', 'all'], 'unresolved');
    const search = text(args, 'search');
    const environment = text(args, 'environment');
    const limit = integer(args, 'limit', 20, 1, 100);
    const [window, state] = await Promise.all([this.reader.since(project.id, 'exceptions', since, now), this.resolvedState(project)]);
    const exceptions = window.items.filter((item) => !environment || item.environment === environment);
    const issues = groupIssues(exceptions.filter((item) => !item.locked));
    const matching = issues.filter((issue) => {
      const issueStatus = issue.status(state[issue.fingerprint]);
      if (status === 'unresolved' && issueStatus === 'resolved') return false;
      if (status === 'resolved' && issueStatus !== 'resolved') return false;
      return !search || issue.searchable.includes(search.toLowerCase());
    });

    const where = `${describeSince(args.since, '7d')}${environment ? ` in ${environment}` : ''}`;
    const lines = [];
    if (!matching.length) {
      lines.push(`No ${status === 'all' ? '' : `${status} `}errors ${where}${search ? ` matching "${search}"` : ''}${issues.length ? ` (${Fmt.count(issues.length, 'issue')} in all)` : ''}.`);
    } else {
      lines.push(`${Fmt.count(matching.length, `${status === 'all' ? '' : `${status} `}issue`)} ${where}${search ? ` matching "${search}"` : ''}, from ${Fmt.count(exceptions.length, 'exception')}; the most recent first.`);
      matching.slice(0, limit).forEach((issue, index) => {
        lines.push('');
        lines.push(...issueLines(issue, state[issue.fingerprint], now, `${index + 1}. `));
      });
      if (matching.length > limit) lines.push('', `… and ${Fmt.count(matching.length - limit, 'more issue')}: raise "limit" or narrow with "search".`);
      lines.push('', 'Call get_error with an issue id for its stack trace, source lines and request.');
    }
    lines.push(...this.coverage(window, 'exceptions'));
    return lines.join('\n');
  }

  // get_error
  async getError(args, project) {
    const now = this.now();
    const id = required(args, 'id');
    let summary = null;
    let issue = null;
    if (FINGERPRINT.test(id)) {
      const window = await this.reader.since(project.id, 'exceptions', 0, now);
      issue = groupIssues(window.items.filter((item) => item.fingerprint === id && !item.locked))[0] || null;
      if (!issue) throw new ToolError(`No error with the issue id ${id} is stored (any more). list_errors lists them.`);
      summary = issue.latest;
    } else {
      recordId(id, 'exception');
      summary = this.reader.find(project.id, 'exceptions', id) || await this.source.summary(project.id, 'exceptions', id);
      if (!summary) throw new ToolError(`Exception ${id} isn't stored (any more). list_errors lists the ones that are.`);
      if (summary.locked) throw new ToolError(`Exception ${id} couldn't be decrypted: it was sealed to the project's earlier keys.`);
      if (summary.fingerprint) {
        const window = await this.reader.since(project.id, 'exceptions', 0, now);
        issue = groupIssues(window.items.filter((item) => item.fingerprint === summary.fingerprint && !item.locked))[0] || null;
      }
    }
    const detail = await this.source.detail(project.id, 'exceptions', summary.id);
    const state = await this.resolvedState(project).catch(() => ({}));

    const lines = [`# ${summary.name || 'Error'}: ${Fmt.clip(maskText(summary.message), 1000)}`];
    if (summary.code) lines.push(`Code: ${summary.code}`);
    if (issue) {
      const resolvedAt = state[issue.fingerprint];
      lines.push(`Issue ${issue.fingerprint}: ${issue.status(resolvedAt)}${resolvedAt ? ` (resolved ${Fmt.ago(resolvedAt, now)})` : ''}, ${issue.severity}; ${Fmt.count(issue.count, 'time')} from ${Fmt.ago(issue.first.occurredAt, now)} to ${Fmt.ago(issue.latest.occurredAt, now)}${issue.requestCount ? `, in ${Fmt.count(issue.requestCount, 'request')}` : ''}${issue.userCount ? `, to ${Fmt.count(issue.userCount, 'user')}` : ''}`);
      if (issue.environments.length) lines.push(`Environments: ${issue.environments.join(', ')}${issue.firstRelease ? ` · first seen in release ${issue.firstRelease}` : ''}${issue.releases.length > 1 ? ` · releases: ${issue.releases.slice(0, 5).join(', ')}` : ''}`);
    }
    lines.push(`This occurrence: exception ${summary.id}, ${Fmt.when(summary.occurredAt, now)}, ${summary.environment}${summary.release ? `, release ${summary.release}` : ''}; ${summary.fatal ? 'it crashed the process' : summary.handled ? 'handled by the app' : 'unhandled'}${summary.mechanism ? ` (${mechanismText(summary.mechanism)})` : ''}`);
    if (summary.request) {
      const request = summary.request;
      lines.push(`Request: ${request.method} ${Fmt.url(request.path, 300)}${request.route ? ` (route ${request.route})` : ''}${request.handler ? `, handler ${request.handler}` : ''}${summary.requestId ? `, request id ${summary.requestId}` : ''}`);
    }
    if (summary.job) lines.push(`Job: ${summary.job.name || summary.job}${summary.jobRunId ? `, run ${summary.jobRunId}` : ''}`);
    if (summary.user) lines.push(`User: ${Fmt.user(summary.user)}`);

    if (!detail) {
      lines.push('', 'Its detail (stack trace, request) is no longer stored.');
    } else {
      lines.push('', 'Stack trace (the most recent call first; ▶ marks the app\'s own code, → the line that threw):');
      const frames = frameLines(detail.frames);
      lines.push(...(frames.length ? frames : [Fmt.clip(maskText(detail.stack || '(no stack)'), 3000)]));
      for (const cause of Array.isArray(detail.causes) ? detail.causes : []) {
        lines.push('', `${cause.kind === 'aggregate' || cause.type === 'aggregate' ? 'One of its errors' : 'Caused by'}: ${cause.name || 'Error'}: ${Fmt.clip(maskText(cause.message), 500)}${cause.code ? ` (code ${cause.code})` : ''}`);
        lines.push(...frameLines(cause.frames, { maxFrames: 4, source: false }));
      }
      if (detail.tags && Object.keys(detail.tags).length) lines.push('', `Tags: ${Object.entries(detail.tags).map(([key, value]) => `${key}=${value}`).join(', ')}`);
      if (detail.extra && Object.keys(detail.extra).length) lines.push('', 'Extra:', Fmt.json(detail.extra, 1500));
      if (detail.process && typeof detail.process === 'object') lines.push('', `Process: ${processText(detail.process)}`);
    }

    if (summary.requestId) lines.push(...await this.requestContext(project, summary.requestId, detail && detail.request, now));
    if (summary.jobRunId) lines.push('', `It happened in job run ${summary.jobRunId}: get_job_run has its data and timeline.`);
    lines.push('', `In the dashboard: ${this.link(project, `/exceptions?exception=${encodeURIComponent(summary.id)}`)}`);
    return lines.join('\n');
  }

  // What the request an error happened in did before it: its line, and its timeline.
  async requestContext(project, requestId, captured, now) {
    const lines = [''];
    if (this.source.cloud) {
      const session = await this.source.connect();
      if (!session.permissions.includes('requests:read')) {
        lines.push(`It happened in request ${requestId} (this key's member can't read requests).`);
        return lines;
      }
    }
    const [summary, detail] = await Promise.all([
      this.reader.find(project.id, 'requests', requestId) || this.source.summary(project.id, 'requests', requestId).catch(() => null),
      this.source.detail(project.id, 'requests', requestId).catch(() => null)
    ]);
    if (summary && !summary.locked) {
      lines.push(`The request: ${summary.method} ${Fmt.url(summary.url || summary.path, 300)} → ${statusText(summary)} in ${Fmt.ms(summary.duration)} (request ${requestId}, ${Fmt.ago(summary.occurredAt, now)})`);
    } else if (captured) {
      lines.push(`The request: ${captured.method} ${Fmt.url(captured.url, 300)} (request ${requestId})`);
    } else {
      lines.push(`It happened in request ${requestId}.`);
    }
    const request = detail || captured;
    if (request) {
      if (request.query && Object.keys(request.query).length) lines.push(`Query: ${Fmt.line(JSON.stringify(mask(request.query)), 500)}`);
      if (request.params && Object.keys(request.params).length) lines.push(`Route parameters: ${Fmt.line(JSON.stringify(mask(request.params)), 500)}`);
      const body = bodyText(request.body, request.bodyEncoding, request.bodySize, request.bodyTruncated, 1500);
      if (body) lines.push('Body:', body);
    }
    if (detail && (detail.timeline || (summary && summary.stats))) {
      const timeline = timelineLines(detail.timeline, summary && summary.stats, { statements: 6, spans: 25, logs: 10 });
      if (timeline.length) lines.push('', 'What the request did:', ...timeline);
    }
    lines.push(`(get_request ${requestId} for its headers, response and full timeline)`);
    return lines;
  }

  // resolve_error
  async resolveError(args, project) {
    const id = required(args, 'id');
    const reopen = args.reopen === true;
    let fingerprint = id;
    let name = null;
    if (!FINGERPRINT.test(id)) {
      recordId(id, 'exception');
      const summary = this.reader.find(project.id, 'exceptions', id) || await this.source.summary(project.id, 'exceptions', id);
      if (!summary || summary.locked || !summary.fingerprint) throw new ToolError(`Exception ${id} isn't stored (any more), so its issue isn't known: pass the issue id from list_errors.`);
      fingerprint = summary.fingerprint;
      name = `${summary.name}: ${Fmt.clip(maskText(summary.message), 120)}`;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, version } = await this.source.exceptionState(project.id);
      const resolved = { ...state.resolved };
      if (reopen) {
        if (resolved[fingerprint] === undefined) return `Issue ${fingerprint}${name ? ` (${name})` : ''} isn't resolved.`;
        delete resolved[fingerprint];
      } else {
        resolved[fingerprint] = this.now();
      }
      const result = await this.source.saveExceptionState(project.id, { resolved }, version);
      if (result.saved) {
        return reopen
          ? `Issue ${fingerprint}${name ? ` (${name})` : ''} is unresolved again.`
          : `Issue ${fingerprint}${name ? ` (${name})` : ''} is resolved. If it happens again, PeekInside shows it as a regression.`;
      }
    }
    throw new ToolError('Someone else kept changing the resolved errors at the same time: try again.');
  }

  // list_requests
  async listRequests(args, project) {
    const now = this.now();
    const since = parseSince(args.since, '1h', now);
    const status = statusFilter(text(args, 'status'));
    const method = text(args, 'method');
    const where = text(args, 'path');
    const minDuration = number(args, 'min_duration');
    const has = oneOf(args, 'has', ['exception', 'n+1', 'slow-query', 'duplicate-query', 'blocked-loop'], null);
    const sort = oneOf(args, 'sort', ['newest', 'slowest'], 'newest');
    const environment = text(args, 'environment');
    const limit = integer(args, 'limit', 30, 1, 200);
    const window = await this.reader.since(project.id, 'requests', since, now);
    const matching = window.items.filter((request) => !request.locked
      && (!environment || request.environment === environment)
      && (!method || request.method === method.toUpperCase())
      && (!status || status(request))
      && (!where || matchesPath(request, where))
      && (minDuration === null || (request.duration ?? -1) >= minDuration)
      && (!has || hasFeature(request, has)));
    if (sort === 'slowest') matching.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1));

    const filters = [args.status && `status ${args.status}`, method && method.toUpperCase(), where && `path containing "${where}"`, minDuration !== null && `at least ${Fmt.ms(minDuration)}`, has && `with ${has}`, environment && `in ${environment}`].filter(Boolean);
    const lines = [`${Fmt.count(matching.length, 'request')} ${describeSince(args.since, '1h')}${filters.length ? ` (${filters.join(', ')})` : ''}, of ${Fmt.count(window.items.length, 'request')} recorded; ${sort === 'slowest' ? 'the slowest' : 'the newest'} first.`];
    if (matching.length) {
      const durations = matching.map((request) => request.duration).filter(Number.isFinite).sort((a, b) => a - b);
      if (durations.length >= 5) lines.push(`Duration: median ${Fmt.ms(quantile(durations, 0.5))}, p95 ${Fmt.ms(quantile(durations, 0.95))}, max ${Fmt.ms(durations[durations.length - 1])}`);
      lines.push('');
      for (const request of matching.slice(0, limit)) lines.push(requestLine(request, now));
      if (matching.length > limit) lines.push(`… and ${Fmt.count(matching.length - limit, 'more request')}.`);
      lines.push('', 'Call get_request with an id for its headers, body, response and timeline.');
    }
    lines.push(...this.coverage(window, 'requests'));
    return lines.join('\n');
  }

  // get_request
  async getRequest(args, project) {
    const now = this.now();
    const id = recordId(required(args, 'id'), 'request');
    const [summary, detail] = await Promise.all([
      this.reader.find(project.id, 'requests', id) || this.source.summary(project.id, 'requests', id),
      this.source.detail(project.id, 'requests', id)
    ]);
    if (!summary && !detail) throw new ToolError(`Request ${id} isn't stored (any more). list_requests lists the ones that are.`);
    if (summary && summary.locked) throw new ToolError(`Request ${id} couldn't be decrypted: it was sealed to the project's earlier keys.`);
    const lines = [];
    if (summary) {
      lines.push(`# ${summary.method} ${Fmt.url(summary.path || summary.url, 300)} → ${statusText(summary, detail)} in ${Fmt.ms(summary.duration)}`);
      lines.push(`Request ${id} · ${Fmt.when(summary.occurredAt, now)} · ${summary.environment}${summary.release ? ` · release ${summary.release}` : ''}${summary.replayOf ? ` · a replay of request ${summary.replayOf}` : ''}`);
      if (summary.route || summary.handler) lines.push(`Route: ${summary.route || '?'}${summary.handler ? ` · handler ${summary.handler}` : ''}`);
      if (summary.url) lines.push(`URL: ${Fmt.url(summary.url)}`);
      if (summary.user) lines.push(`User: ${Fmt.user(summary.user)}`);
    } else {
      lines.push(`# Request ${id}`);
    }
    if (!detail) {
      lines.push('', 'Its detail (headers, bodies, timeline) is no longer stored.');
      return lines.join('\n');
    }
    const client = [detail.ip, detail.userAgent && Fmt.clip(detail.userAgent, 120), detail.httpVersion && `HTTP/${detail.httpVersion}`].filter(Boolean);
    if (client.length) lines.push(`Client: ${client.join(' · ')}`);
    lines.push('', 'Request headers:', ...headerLines(detail.headers));
    if (detail.query && Object.keys(detail.query).length) lines.push(`Query: ${Fmt.line(JSON.stringify(mask(detail.query)), 1000)}`);
    if (detail.params && Object.keys(detail.params).length) lines.push(`Route parameters: ${Fmt.line(JSON.stringify(mask(detail.params)), 1000)}`);
    const body = bodyText(detail.body, detail.bodyEncoding, detail.bodySize, detail.bodyTruncated);
    if (body) lines.push(`Body (${Fmt.bytes(detail.bodySize ?? Buffer.byteLength(String(detail.body)))}):`, body);

    const response = detail.response || {};
    lines.push('', `Response: ${statusText(summary || {}, detail)}${summary && summary.contentType ? ` · ${summary.contentType}` : ''}${Number.isFinite(response.size) ? ` · ${Fmt.bytes(response.size)}` : ''}${summary && summary.aborted ? ' · the client closed the connection first' : ''}`);
    lines.push(...headerLines(response.headers));
    const responseBody = bodyText(response.body, response.bodyEncoding, response.size, response.bodyTruncated, 3000);
    if (responseBody) lines.push('Response body:', responseBody);

    const exceptions = Array.isArray(detail.exceptions) ? detail.exceptions : [];
    if (exceptions.length) {
      lines.push('', `Exceptions (${exceptions.length}${summary && summary.exceptionCount > exceptions.length ? ` of ${summary.exceptionCount}` : ''}):`);
      for (const exception of exceptions) lines.push(`  ${exception.name}: ${Fmt.line(maskText(exception.message), 300)} (exception ${exception.id}: get_error)`);
    }
    const timeline = timelineLines(detail.timeline, summary && summary.stats);
    if (timeline.length) lines.push('', ...timeline);
    if (Array.isArray(detail.dumps) && detail.dumps.length) lines.push('', `Dumps: ${detail.dumps.length} (list_dumps with request_id ${id})`);
    if (Array.isArray(detail.mails) && detail.mails.length) lines.push('', `Emails sent: ${detail.mails.length} (list_emails)`);
    lines.push('', `In the dashboard: ${this.link(project, `?request=${encodeURIComponent(id)}`)}`);
    if (!this.source.cloud) lines.push('replay_request sends it to the app again, to check a fix.');
    return lines.join('\n');
  }

  // replay_request
  async replayRequest(args, project) {
    const id = recordId(required(args, 'id'), 'request');
    const replay = await this.source.replay(project.id, id);
    const lines = [`Sent request ${id} again: the app answered ${replay.status}${replay.statusMessage ? ` ${replay.statusMessage}` : ''} in ${Fmt.ms(replay.duration)}.`];
    // The replay's record arrives with the app's next batch: a moment later.
    let record = null;
    for (let attempt = 0; attempt < 12 && !record; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      record = await this.source.summary(project.id, 'requests', replay.id).catch(() => null);
    }
    if (record) {
      const facts = [record.exceptionCount ? Fmt.count(record.exceptionCount, 'exception') : 'no exceptions'];
      if (record.stats && record.stats.queries) facts.push(`${Fmt.count(record.stats.queries, 'query', 'queries')}${record.stats.nPlusOne ? ', with an N+1 pattern' : ''}`);
      lines.push(`The replay is request ${replay.id}: ${facts.join(', ')}. get_request ${replay.id} has its detail.`);
    } else {
      lines.push(`The replay is request ${replay.id}; its record arrives in a moment (get_request ${replay.id}).`);
    }
    this.reader.forget(project.id, 'requests');
    return lines.join('\n');
  }

  // list_queries
  async listQueries(args, project) {
    const now = this.now();
    const since = parseSince(args.since, '1h', now);
    const where = text(args, 'path');
    const environment = text(args, 'environment');
    const limit = integer(args, 'limit', 15, 1, 50);
    const window = await this.reader.since(project.id, 'requests', since, now);
    const candidates = window.items.filter((request) => !request.locked && request.stats && request.stats.queries > 0
      && (!environment || request.environment === environment)
      && (!where || matchesPath(request, where)));
    const opened = candidates.slice(0, QUERY_DETAILS);
    const details = await mapLimit(opened, DETAIL_WORKERS, (request) => this.source.detail(project.id, 'requests', request.id).catch(() => null));

    const groups = new Map();
    opened.forEach((request, index) => {
      const timeline = details[index] && details[index].timeline;
      if (!timeline || !Array.isArray(timeline.statements)) return;
      const route = `${request.method} ${request.route || request.path}`;
      for (const statement of timeline.statements) {
        const key = statement.fingerprint || statement.text;
        let group = groups.get(key);
        if (!group) {
          group = { text: statement.text, system: statement.system, client: statement.client, fingerprint: statement.fingerprint, count: 0, time: 0, maxTime: 0, slow: 0, duplicates: 0, requests: 0, nPlusOne: 0, routes: new Map(), callers: new Map(), example: request.id };
          groups.set(key, group);
        }
        group.count += statement.count;
        group.time += statement.time;
        group.maxTime = Math.max(group.maxTime, statement.maxTime);
        group.slow += statement.slow;
        group.duplicates += statement.duplicates;
        group.requests++;
        if (statement.nPlusOne) {
          group.nPlusOne++;
          group.example = request.id;
        }
        group.routes.set(route, (group.routes.get(route) || 0) + 1);
        if (statement.caller) {
          const caller = `${Fmt.place(statement.caller)}${statement.caller.function ? ` in ${statement.caller.function}` : ''}`;
          group.callers.set(caller, (group.callers.get(caller) || 0) + 1);
        }
      }
    });
    const ranked = [...groups.values()].sort((a, b) => b.nPlusOne - a.nPlusOne || b.slow - a.slow || b.time - a.time);
    const lines = [`Database statements in ${Fmt.count(opened.length, 'request')} with queries ${describeSince(args.since, '1h')}${where ? ` to paths containing "${where}"` : ''}${environment ? ` in ${environment}` : ''}${candidates.length > opened.length ? ` (the newest ${opened.length} of ${candidates.length})` : ''}; the worst first.`];
    if (!ranked.length) {
      lines.push('No queries recorded in that window.');
    } else {
      ranked.slice(0, limit).forEach((group, index) => {
        const flags = [];
        if (group.nPlusOne) flags.push(`N+1 in ${Fmt.count(group.nPlusOne, 'request')}`);
        if (group.slow) flags.push(`${group.slow} slow`);
        if (group.duplicates) flags.push(`${Fmt.count(group.duplicates, 'duplicate')}`);
        lines.push('');
        lines.push(`${index + 1}. ${flags.length ? `${flags.join(', ')} · ` : ''}ran ${Fmt.count(group.count, 'time')} in ${Fmt.count(group.requests, 'request')}, ${Fmt.ms(group.time)} in all, ${Fmt.ms(group.time / group.count)} on average, ${Fmt.ms(group.maxTime)} at most${group.system ? ` · ${group.system}${group.client ? ` via ${group.client}` : ''}` : ''}`);
        lines.push(`   ${Fmt.line(group.text, 800)}`);
        const callers = [...group.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([caller]) => caller);
        if (callers.length) lines.push(`   from ${callers.join('; ')}`);
        const routes = [...group.routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([route, count]) => `${route} (${count})`);
        lines.push(`   routes: ${routes.join(', ')} · e.g. request ${group.example}`);
      });
      if (ranked.length > limit) lines.push('', `… and ${Fmt.count(ranked.length - limit, 'more statement')}.`);
      lines.push('', 'An N+1 pattern runs one query per item of a list: load them in one query instead (a JOIN, WHERE id IN (…), or the ORM\'s include/populate).');
    }
    lines.push(...this.coverage(window, 'requests'));
    return lines.join('\n');
  }

  // list_logs
  async listLogs(args, project) {
    const now = this.now();
    const requestId = text(args, 'request_id');
    const jobRunId = text(args, 'job_run_id');
    const since = parseSince(args.since, requestId || jobRunId ? 'all' : '1h', now);
    const level = oneOf(args, 'level', LEVELS, null);
    const search = text(args, 'search');
    const environment = text(args, 'environment');
    const limit = integer(args, 'limit', 50, 1, 500);
    const window = await this.reader.since(project.id, 'logs', since, now);
    const minimum = level ? LEVELS.indexOf(level) : 0;
    const matching = window.items.filter((line) => !line.locked
      && LEVELS.indexOf(line.level) >= minimum
      && (!environment || line.environment === environment)
      && (!requestId || line.requestId === requestId)
      && (!jobRunId || line.jobRunId === jobRunId)
      && (!search || String(line.message || '').toLowerCase().includes(search.toLowerCase())));
    const filters = [level && `${level} and above`, search && `containing "${search}"`, requestId && `of request ${requestId}`, jobRunId && `of job run ${jobRunId}`, environment && `in ${environment}`].filter(Boolean);
    const lines = [`${Fmt.count(matching.length, 'log line')} ${describeSince(args.since, requestId || jobRunId ? 'all' : '1h')}${filters.length ? ` (${filters.join(', ')})` : ''}; the newest first.`];
    for (const line of matching.slice(0, limit)) {
      const links = [line.requestId && `request ${line.requestId}`, line.jobRunId && `job run ${line.jobRunId}`].filter(Boolean);
      lines.push(`${Fmt.time(line.occurredAt).slice(11, 19)} (${Fmt.ago(line.occurredAt, now)}) [${line.level}] ${line.source && line.source !== 'console' ? `${line.source}: ` : ''}${Fmt.clip(maskText(line.message), 1000)}${links.length ? `  (${links.join(', ')})` : ''}`);
      if (line.fields && typeof line.fields === 'object' && Object.keys(line.fields).length) lines.push(`    ${Fmt.line(JSON.stringify(mask(line.fields)), 500)}`);
    }
    if (matching.length > limit) lines.push(`… and ${Fmt.count(matching.length - limit, 'more line')}.`);
    lines.push(...this.coverage(window, 'logs'));
    return lines.join('\n');
  }

  // list_jobs
  async listJobs(args, project) {
    const now = this.now();
    const since = parseSince(args.since, '24h', now);
    const name = text(args, 'name');
    const status = oneOf(args, 'status', ['failed', 'ok'], null);
    const environment = text(args, 'environment');
    const limit = integer(args, 'limit', 30, 1, 200);
    const window = await this.reader.since(project.id, 'jobs', since, now);
    const runs = window.items.filter((run) => !run.locked && (!environment || run.environment === environment) && (!name || String(run.name).toLowerCase().includes(name.toLowerCase())));
    if (!runs.length) return [`No job runs ${describeSince(args.since, '24h')}${name ? ` of jobs named like "${name}"` : ''}.`, ...this.coverage(window, 'jobs')].join('\n');

    const jobs = new Map();
    for (const run of runs) {
      let job = jobs.get(run.name);
      if (!job) {
        job = { name: run.name, runs: 0, failed: 0, durations: [], last: run, lastFailure: null, schedule: run.schedule, queue: run.queue, trigger: run.trigger };
        jobs.set(run.name, job);
      }
      job.runs++;
      if (run.status === 'failed') {
        job.failed++;
        if (!job.lastFailure) job.lastFailure = run;
      }
      if (Number.isFinite(run.duration)) job.durations.push(run.duration);
    }
    const lines = [`${Fmt.count(jobs.size, 'job')} ran ${Fmt.count(runs.length, 'time')} ${describeSince(args.since, '24h')}${environment ? ` in ${environment}` : ''}:`];
    for (const job of [...jobs.values()].sort((a, b) => b.failed - a.failed || b.last.occurredAt - a.last.occurredAt)) {
      const average = job.durations.length ? job.durations.reduce((sum, value) => sum + value, 0) / job.durations.length : null;
      lines.push(`- ${job.name}${job.schedule ? ` (cron "${job.schedule}")` : job.queue ? ` (queue ${job.queue})` : ` (${job.trigger})`}: ${Fmt.count(job.runs, 'run')}, ${job.failed ? `${job.failed} failed` : 'none failed'}${average !== null ? `, ${Fmt.ms(average)} on average` : ''}; last ${Fmt.ago(job.last.occurredAt, now)} (${job.last.status})`);
      if (job.lastFailure && job.lastFailure.error) lines.push(`    last failure ${Fmt.ago(job.lastFailure.occurredAt, now)}: ${job.lastFailure.error.name}: ${Fmt.line(maskText(job.lastFailure.error.message), 300)} (run ${job.lastFailure.id})`);
    }
    const shown = runs.filter((run) => !status || run.status === status);
    lines.push('', `${status ? `${status === 'failed' ? 'Failed' : 'Successful'} runs` : 'Runs'}, the newest first:`);
    for (const run of shown.slice(0, limit)) {
      lines.push(`${Fmt.time(run.occurredAt).slice(5, 19)} (${Fmt.ago(run.occurredAt, now)})  ${run.name}  ${run.status}${Number.isFinite(run.duration) ? ` in ${Fmt.ms(run.duration)}` : ''}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}${run.error ? `: ${run.error.name}: ${Fmt.line(maskText(run.error.message), 200)}` : ''}  (run ${run.id})`);
    }
    if (shown.length > limit) lines.push(`… and ${Fmt.count(shown.length - limit, 'more run')}.`);
    lines.push('', 'Call get_job_run with a run id for its data, exceptions and timeline.');
    lines.push(...this.coverage(window, 'jobs'));
    return lines.join('\n');
  }

  // get_job_run
  async getJobRun(args, project) {
    const now = this.now();
    const id = recordId(required(args, 'id'), 'job run');
    const [summary, detail] = await Promise.all([
      this.reader.find(project.id, 'jobs', id) || this.source.summary(project.id, 'jobs', id),
      this.source.detail(project.id, 'jobs', id)
    ]);
    if (!summary && !detail) throw new ToolError(`Job run ${id} isn't stored (any more). list_jobs lists the ones that are.`);
    if (summary && summary.locked) throw new ToolError(`Job run ${id} couldn't be decrypted: it was sealed to the project's earlier keys.`);
    const lines = [];
    if (summary) {
      lines.push(`# Job ${summary.name}: ${summary.status}${Number.isFinite(summary.duration) ? ` in ${Fmt.ms(summary.duration)}` : ''}`);
      lines.push(`Run ${id} · ${Fmt.when(summary.occurredAt, now)} · ${summary.environment}${summary.release ? ` · release ${summary.release}` : ''} · ${summary.trigger}${summary.schedule ? ` on "${summary.schedule}"${summary.timezone ? ` (${summary.timezone})` : ''}` : ''}${summary.queue ? ` from queue ${summary.queue}` : ''}${summary.attempt > 1 ? ` · attempt ${summary.attempt}` : ''}`);
      if (summary.error) lines.push(`Error: ${summary.error.name}: ${Fmt.clip(maskText(summary.error.message), 1000)}`);
      if (summary.user) lines.push(`User: ${Fmt.user(summary.user)}`);
    } else {
      lines.push(`# Job run ${id}`);
    }
    if (!detail) {
      lines.push('', 'Its detail (data, timeline) is no longer stored.');
      return lines.join('\n');
    }
    if (detail.data !== undefined && detail.data !== null) lines.push('', 'Data:', Fmt.json(detail.data, 3000));
    const exceptions = Array.isArray(detail.exceptions) ? detail.exceptions : [];
    if (exceptions.length) {
      lines.push('', 'Exceptions:');
      for (const exception of exceptions) lines.push(`  ${exception.name}: ${Fmt.line(maskText(exception.message), 300)} (exception ${exception.id}: get_error)`);
    }
    const timeline = timelineLines(detail.timeline, summary && summary.stats);
    if (timeline.length) lines.push('', ...timeline);
    lines.push('', `In the dashboard: ${this.link(project, `/jobs?run=${encodeURIComponent(id)}`)}`);
    return lines.join('\n');
  }

  // get_runtime
  async getRuntime(args, project) {
    const now = this.now();
    const range = oneOf(args, 'range', RUNTIME_RANGES, '1h');
    const environment = text(args, 'environment');
    const history = this.source.cloud ? await this.source.runtime(project.id, range) : await this.source.runtime(project.id);
    const processes = history.processes.filter((process) => !environment || process.environment === environment);
    if (!processes.length) return `No processes reported ${this.source.cloud ? `in the last ${range}` : 'recently'}${environment ? ` in ${environment}` : ''}. Processes report while the app runs with PeekInside.`;
    const lines = [`${Fmt.count(processes.length, 'process', 'processes')}${this.source.cloud ? ` in the last ${range}` : ' (the local dashboard keeps their last few minutes)'}:`];
    const ranked = [...processes].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt);
    for (const process of ranked.slice(0, 6)) {
      lines.push('', ...processLines(process, now));
    }
    if (ranked.length > 6) lines.push('', `… and ${Fmt.count(ranked.length - 6, 'more process', 'more processes')}.`);
    if (history.profiling === false) lines.push('', 'Heap and CPU profiles (where memory is held, what blocks the event loop) come with PeekInside Cloud Pro and up.');
    lines.push('', `In the dashboard: ${this.link(project, '/runtime')}`);
    return lines.join('\n');
  }

  // list_dumps
  async listDumps(args, project) {
    const now = this.now();
    const id = text(args, 'id');
    if (id) {
      recordId(id, 'dump');
      const [summary, detail] = await Promise.all([this.source.summary(project.id, 'dumps', id), this.source.detail(project.id, 'dumps', id)]);
      if (!detail) throw new ToolError(`Dump ${id} isn't stored (any more).`);
      const lines = [`# Dump${summary && summary.label ? ` "${summary.label}"` : ''}${summary && summary.type ? ` (${summary.type})` : ''}`];
      if (summary) lines.push(`${Fmt.when(summary.occurredAt, now)}${summary.location ? ` · at ${Fmt.place(summary.location)}` : ''}${summary.requestId ? ` · request ${summary.requestId}` : ''}${summary.jobRunId ? ` · job run ${summary.jobRunId}` : ''}`);
      lines.push('', dumpText(detail.value ?? detail.tree ?? detail, 8000));
      return lines.join('\n');
    }
    const requestId = text(args, 'request_id');
    const since = parseSince(args.since, requestId ? 'all' : '1h', now);
    const limit = integer(args, 'limit', 20, 1, 100);
    const window = await this.reader.since(project.id, 'dumps', since, now);
    const dumps = window.items.filter((dump) => !requestId || dump.requestId === requestId);
    const lines = [`${Fmt.count(dumps.length, 'dump')} ${describeSince(args.since, requestId ? 'all' : '1h')}${requestId ? ` of request ${requestId}` : ''}; the newest first.`];
    for (const dump of dumps.slice(0, limit)) {
      lines.push(`${Fmt.ago(dump.occurredAt, now)}${dump.label ? ` "${dump.label}"` : ''} ${dump.type || ''}${dump.location ? ` at ${Fmt.place(dump.location)}` : ''}: ${Fmt.line(maskText(dump.preview), 300)}  (dump ${dump.id})`);
    }
    if (dumps.length) lines.push('', 'Pass a dump\'s id as "id" for its whole value.');
    return lines.join('\n');
  }

  // list_emails
  async listEmails(args, project) {
    const now = this.now();
    const id = text(args, 'id');
    if (id) {
      recordId(id, 'email');
      const [summary, detail] = await Promise.all([this.source.summary(project.id, 'mails', id), this.source.detail(project.id, 'mails', id)]);
      if (!detail) throw new ToolError(`Email ${id} isn't stored (any more).`);
      return mailLines(summary, detail, now).join('\n');
    }
    const since = parseSince(args.since, '24h', now);
    const limit = integer(args, 'limit', 20, 1, 100);
    const window = await this.reader.since(project.id, 'mails', since, now);
    const lines = [`${Fmt.count(window.items.length, 'email')} ${describeSince(args.since, '24h')}; the newest first.`];
    for (const mail of window.items.slice(0, limit)) {
      lines.push(`${Fmt.ago(mail.occurredAt, now)} "${Fmt.line(mail.subject, 200)}" to ${(mail.to || []).join(', ')}${mail.recipients > (mail.to || []).length ? ` and ${mail.recipients - mail.to.length} more` : ''}: ${mail.status || 'sent'}${mail.error ? ` (${mail.error.name}: ${Fmt.line(maskText(mail.error.message), 200)})` : ''}  (email ${mail.id})`);
    }
    if (window.items.length) lines.push('', 'Pass an email\'s id as "id" for its headers and text.');
    return lines.join('\n');
  }

  /**
   * Which issues are resolved, and since when.
   *
   * @param {{ id: string }} project
   * @returns {Promise<Object<string, number>>}
   */
  async resolvedState(project) {
    if (this.source.cloud) {
      const session = await this.source.connect();
      if (!session.permissions.includes('exceptions:read')) return {};
    }
    const { state } = await this.source.exceptionState(project.id);
    return state.resolved || {};
  }

  // A note when a window wasn't read to its start.
  coverage(window, kind) {
    if (window.complete) return [];
    return ['', `(Only the newest ${window.read.toLocaleString('en-US')} ${kind} were read, back to ${Fmt.time(window.oldest)}: narrow "since" to see a complete window.)`];
  }

  // A page of the dashboard: the hub's /p/<project>, or Cloud's project address.
  link(project, suffix) {
    const base = this.source.cloud ? this.source.dashboardUrl : `${this.source.dashboardUrl}/p/${encodeURIComponent(project.id)}`;
    return `${base}${suffix}`;
  }
}

/**
 * Records of each kind, newest first, read page by page back to a point in time, and reused by the
 * calls of the next few seconds.
 */
class RecordReader {
  constructor(source) {
    this.source = source;
    this.windows = new Map();
  }

  /**
   * @param {string} projectId
   * @param {string} kind
   * @param {number} since - ms since the epoch
   * @param {number} now
   * @returns {Promise<{ items: Object[], complete: boolean, read: number, oldest: number|null }>}
   */
  since(projectId, kind, since, now) {
    const key = `${projectId}:${kind}`;
    let window = this.windows.get(key);
    if (!window || now - window.readAt > FRESH_MS) {
      window = { items: [], ids: new Set(), more: true, newestOfLastPage: null, readAt: now, queue: Promise.resolve() };
      this.windows.set(key, window);
    }
    // One reader at a time per window: two calls at once share the pages.
    const read = window.queue.then(() => this._extend(window, projectId, kind, since));
    window.queue = read.catch(() => {});
    return read;
  }

  // Pages come newest first by when they arrived, not when they happened: records an app sent late
  // (spooled while the hub or Cloud was away) sit among newer ones. So reading stops only once a
  // whole page happened before the window.
  async _extend(window, projectId, kind, since) {
    const cap = CAPS[kind] || 1000;
    while (window.more && window.items.length < cap && !(window.newestOfLastPage !== null && window.newestOfLastPage < since)) {
      const last = window.items[window.items.length - 1];
      const page = await this.source.page(projectId, kind, { before: last ? last.seq : undefined, limit: PAGE_SIZE });
      for (const item of page.items) {
        if (window.ids.has(item.id)) continue;
        window.ids.add(item.id);
        window.items.push(item);
      }
      window.newestOfLastPage = page.items.length ? Math.max(...page.items.map((item) => item.occurredAt)) : null;
      window.more = page.hasMore && page.items.length > 0;
    }
    const oldest = window.items.length ? Math.min(...window.items.map((item) => item.occurredAt)) : null;
    return {
      items: window.items.filter((item) => item.occurredAt >= since),
      complete: !window.more || (window.newestOfLastPage !== null && window.newestOfLastPage < since),
      read: window.items.length,
      oldest
    };
  }

  /**
   * @param {string} projectId
   * @param {string} kind
   * @param {string} id
   * @returns {Object|null} The record, when a recent call read it
   */
  find(projectId, kind, id) {
    const window = this.windows.get(`${projectId}:${kind}`);
    return (window && window.items.find((item) => item.id === id)) || null;
  }

  /**
   * Forgets what was read of a kind, so the next call reads it afresh.
   *
   * @param {string} projectId
   * @param {string} kind
   */
  forget(projectId, kind) {
    this.windows.delete(`${projectId}:${kind}`);
  }
}

/**
 * Every occurrence of the same error (the SDK's fingerprint: the same type thrown from the same
 * functions), newest first. The dashboard's issues, read the same way.
 */
class Issue {
  constructor(fingerprint, occurrences) {
    this.fingerprint = fingerprint;
    this.occurrences = occurrences;
    this.latest = occurrences[0];
    this.first = occurrences[occurrences.length - 1];
    this.count = occurrences.length;
    this.requestCount = new Set(occurrences.map((item) => item.requestId).filter(Boolean)).size;
    this.userCount = new Set(occurrences.map((item) => Fmt.userKey(item.user)).filter(Boolean)).size;
    this.environments = [...new Set(occurrences.map((item) => item.environment))];
    this.releases = [...new Set(occurrences.map((item) => item.release).filter(Boolean))];
    this.firstRelease = this.first.release || null;
    this.severity = occurrences.some((item) => item.fatal) ? 'crashed the process' : occurrences.some((item) => !item.handled) ? 'unhandled' : 'handled';
    const { name, message, code, location, request } = this.latest;
    this.searchable = [name, message, code, location && location.file, location && location.function, request && request.method, request && request.path, request && request.route]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  /**
   * @param {number|undefined} resolvedAt
   * @returns {'unresolved'|'resolved'|'regressed'} Regressed: it happened again after it was resolved
   */
  status(resolvedAt) {
    if (resolvedAt === undefined) return 'unresolved';
    return this.latest.occurredAt > resolvedAt ? 'regressed' : 'resolved';
  }
}

function groupIssues(exceptions) {
  const groups = new Map();
  for (const exception of exceptions) {
    // Exceptions from before fingerprints group by what they say and where.
    const key = exception.fingerprint || `${exception.name}|${exception.location ? `${exception.location.file}:${exception.location.function}` : exception.message}`;
    const group = groups.get(key);
    if (group) group.push(exception);
    else groups.set(key, [exception]);
  }
  return [...groups.entries()]
    .map(([fingerprint, items]) => new Issue(fingerprint, items.sort((a, b) => b.occurredAt - a.occurredAt || b.seq - a.seq)))
    .sort((a, b) => b.latest.occurredAt - a.latest.occurredAt);
}

function issueLines(issue, resolvedAt, now, prefix) {
  const latest = issue.latest;
  const status = issue.status(resolvedAt);
  const lines = [`${prefix}${latest.name || 'Error'}: ${Fmt.line(maskText(latest.message), 300)}${latest.code ? ` [${latest.code}]` : ''}`];
  lines.push(`   issue ${issue.fingerprint} · ${status === 'unresolved' ? '' : `${status} · `}${issue.severity} · ${Fmt.count(issue.count, 'time')}, last ${Fmt.ago(latest.occurredAt, now)}, first ${Fmt.ago(issue.first.occurredAt, now)}${issue.requestCount ? ` · ${Fmt.count(issue.requestCount, 'request')}` : ''}${issue.userCount ? ` · ${Fmt.count(issue.userCount, 'user')}` : ''}`);
  const where = [];
  if (latest.location) where.push(`at ${latest.location.function ? `${latest.location.function} (${Fmt.place(latest.location)})` : Fmt.place(latest.location)}`);
  if (latest.request) where.push(`${latest.request.method} ${latest.request.route || latest.request.path}`);
  if (latest.job) where.push(`job ${latest.job.name || latest.job}`);
  where.push(issue.environments.join(', '));
  if (latest.release) where.push(`release ${latest.release}`);
  lines.push(`   ${where.join(' · ')}`);
  lines.push(`   latest exception ${latest.id}`);
  return lines;
}

function requestLine(request, now) {
  const facts = [];
  if (request.stats && request.stats.queries) {
    const flags = [request.stats.nPlusOne && 'N+1', request.stats.slowQueries && 'slow', request.stats.duplicates && 'duplicates'].filter(Boolean);
    facts.push(`${Fmt.count(request.stats.queries, 'query', 'queries')}${flags.length ? ` (${flags.join(', ')})` : ''}`);
  }
  if (request.stats && request.stats.http) facts.push(Fmt.count(request.stats.http, 'HTTP call'));
  if (request.exceptionCount) facts.push(Fmt.count(request.exceptionCount, 'exception'));
  if (request.stats && request.stats.loopBlock) facts.push(`loop blocked ${Fmt.ms(request.stats.loopBlock)}`);
  const status = request.status === null || request.status === undefined ? (request.aborted ? 'aborted' : 'no response') : request.status;
  return `${Fmt.time(request.occurredAt).slice(11, 19)} (${Fmt.ago(request.occurredAt, now)})  ${request.method} ${Fmt.url(request.path || request.url, 160)} → ${status}  ${Fmt.ms(request.duration)}${facts.length ? `  · ${facts.join(' · ')}` : ''}  (id ${request.id})`;
}

function statusText(summary, detail) {
  if (summary.status === null || summary.status === undefined) return summary.aborted ? 'no response (the client went away)' : 'no response';
  const message = detail && detail.response && detail.response.statusMessage;
  return `${summary.status}${message ? ` ${message}` : ''}`;
}

function processLines(process, now) {
  const lines = [];
  const about = [process.framework && `${process.framework}${process.port ? ` on port ${process.port}` : ''}`, process.node && `Node ${process.node}`].filter(Boolean);
  lines.push(`Process ${process.pid || process.id}${about.length ? ` (${about.join(', ')})` : ''} · ${process.environment || 'unknown environment'}${process.release ? ` · release ${process.release}` : ''}${process.startedAt ? ` · started ${Fmt.ago(process.startedAt, now)}` : ''} · ${process.online ? 'running' : `stopped reporting ${Fmt.ago(process.lastSeenAt, now)}`}`);
  const points = (Array.isArray(process.points) ? process.points : []).filter((point) => point && Number.isFinite(point.at)).sort((a, b) => a.at - b.at);
  const last = points[points.length - 1];
  if (last) {
    lines.push(`  Memory now: heap ${Fmt.bytes(last.heapUsed)} used${Number.isFinite(last.heapLimit) ? ` of a ${Fmt.bytes(last.heapLimit)} limit (${Math.round((last.heapUsed / last.heapLimit) * 100)}%)` : ''} · RSS ${Fmt.bytes(last.rss)} · external ${Fmt.bytes(last.external)}${Number.isFinite(last.arrayBuffers) ? ` (buffers ${Fmt.bytes(last.arrayBuffers)})` : ''}`);
    const trend = heapTrend(points);
    if (trend) lines.push(`  ${trend}`);
    const cpu = points.map((point) => point.cpu).filter(Number.isFinite);
    const elu = points.map((point) => point.elu).filter(Number.isFinite);
    if (cpu.length) lines.push(`  CPU: ${Math.round(average(cpu))}% of a core on average, ${Math.round(Math.max(...cpu))}% at most${elu.length ? ` · event loop busy ${Math.round(average(elu))}% of the time` : ''}`);
    const p99 = points.map((point) => point.loopP99).filter(Number.isFinite);
    const worst = points.map((point) => point.loopMax).filter(Number.isFinite);
    if (p99.length) lines.push(`  Event-loop delay: p99 ${Fmt.ms(average(p99))} on average${worst.length ? `, ${Fmt.ms(Math.max(...worst))} at worst` : ''}`);
    const gcCount = sum(points.map((point) => point.gcCount));
    if (gcCount) lines.push(`  Garbage collection: ${Fmt.count(gcCount, 'collection')}, ${Fmt.ms(sum(points.map((point) => point.gcMs)))} paused in all, ${Fmt.ms(Math.max(...points.map((point) => point.gcMax).filter(Number.isFinite), 0))} at most`);
    const requests = sum(points.map((point) => point.requests));
    const inFlight = points.map((point) => point.inFlight).filter(Number.isFinite);
    if (Number.isFinite(last.handles) || requests) lines.push(`  ${Number.isFinite(last.handles) ? `Open handles: ${last.handles}` : ''}${Number.isFinite(last.handles) && requests ? ' · ' : ''}${requests ? `requests: ${requests.toLocaleString('en-US')} finished${inFlight.length ? `, ${Math.max(...inFlight)} open at once at most` : ''}` : ''}`);
  } else {
    lines.push('  No samples in this window.');
  }
  const heap = process.heap;
  if (heap && Array.isArray(heap.windows) && heap.windows.length) {
    const latest = heap.windows[heap.windows.length - 1];
    const held = Object.entries(latest.bytes || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push(`  Heap held by (the profile of ${Fmt.ago(latest.at, now)}, ${Fmt.bytes(latest.total)} sampled${latest.reason === 'pressure' ? ', read as the heap neared its limit' : ''}):`);
    for (const [id, bytes] of held) {
      const site = heap.sites[id] || {};
      lines.push(`    ${Fmt.bytes(bytes).padStart(7)}  ${site.function || '<anonymous>'}  ${Fmt.place(site)}${site.inApp ? ' (the app\'s)' : site.package ? ` (${site.package})` : ''}`);
    }
    if (heap.windows.length >= 3) {
      const first = heap.windows[0];
      const growing = held
        .map(([id, bytes]) => ({ id, bytes, before: (first.bytes || {})[id] || 0 }))
        .filter((item) => item.bytes - item.before > Math.max(5 * 1024 * 1024, item.before * 0.5))
        .slice(0, 3);
      for (const item of growing) {
        const site = heap.sites[item.id] || {};
        lines.push(`    growing: ${site.function || '<anonymous>'} (${Fmt.place(site)}) held ${Fmt.bytes(item.before)} ${Fmt.ago(first.at, now)}, ${Fmt.bytes(item.bytes)} now`);
      }
    }
  }
  const blocks = Array.isArray(process.blocks) ? process.blocks : [];
  if (blocks.length) {
    const count = sum(blocks.map((window) => window.count));
    const total = sum(blocks.map((window) => window.total));
    const worst = Math.max(...blocks.map((window) => window.worst));
    lines.push(`  Event loop blocked ${Fmt.count(count, 'time')}, ${Fmt.ms(total)} in all, ${Fmt.ms(worst)} at worst; where the time went:`);
    const sites = new Map();
    for (const window of blocks) {
      for (const site of window.sites || []) {
        const entry = sites.get(site.id) || { site, ms: 0, blocks: 0, max: 0 };
        entry.ms += site.ms || 0;
        entry.blocks += site.blocks || 0;
        entry.max = Math.max(entry.max, site.max || 0);
        sites.set(site.id, entry);
      }
    }
    for (const entry of [...sites.values()].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
      const site = entry.site;
      lines.push(`    ${Fmt.ms(entry.ms).padStart(8)} in ${Fmt.count(entry.blocks, 'block')}  ${site.function || '<anonymous>'}  ${Fmt.place(site)}${site.inApp ? ' (the app\'s)' : site.package ? ` (${site.package})` : ''}${site.calls ? `, mostly in ${site.calls}` : ''}`);
    }
  }
  return lines;
}

// Whether the heap left after garbage collection keeps growing: its lowest in the first and the
// last quarter of the window.
function heapTrend(points) {
  if (points.length < 8) return null;
  const quarter = Math.max(2, Math.floor(points.length / 4));
  const low = (items) => Math.min(...items.map((point) => (Number.isFinite(point.heapMin) ? point.heapMin : point.heapUsed)).filter(Number.isFinite));
  const before = low(points.slice(0, quarter));
  const after = low(points.slice(-quarter));
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return null;
  const change = (after - before) / before;
  const span = Fmt.ago(points[0].at, points[points.length - 1].at).replace(' ago', '');
  const text = `Heap after garbage collection: ${Fmt.bytes(before)} → ${Fmt.bytes(after)} over ${span}`;
  if (change > 0.2 && after - before > 10 * 1024 * 1024) return `${text} (+${Math.round(change * 100)}%: it keeps growing, a memory leak is possible; see what holds it below)`;
  return `${text} (${change >= 0 ? '+' : ''}${Math.round(change * 100)}%: steady)`;
}

function mailLines(summary, detail, now) {
  const lines = [`# Email "${Fmt.line(detail.subject || (summary && summary.subject), 300)}"`];
  if (summary) lines.push(`${Fmt.when(summary.occurredAt, now)}${summary.requestId ? ` · request ${summary.requestId}` : ''}${summary.jobRunId ? ` · job run ${summary.jobRunId}` : ''}${summary.status ? ` · ${summary.status}` : ''}`);
  const addresses = (list) => (Array.isArray(list) ? list.map((item) => (typeof item === 'string' ? item : item && (item.name ? `${item.name} <${item.address}>` : item.address))).filter(Boolean).join(', ') : '');
  for (const field of ['from', 'to', 'cc', 'bcc', 'replyTo']) {
    const value = addresses(detail[field]);
    if (value) lines.push(`${field}: ${value}`);
  }
  if (summary && summary.error) lines.push(`Error: ${summary.error.name}: ${Fmt.clip(maskText(summary.error.message), 500)}`);
  if (Array.isArray(detail.attachments) && detail.attachments.length) lines.push(`Attachments: ${detail.attachments.map((item) => `${item.filename || 'unnamed'}${item.contentType ? ` (${item.contentType})` : ''}`).join(', ')}`);
  if (detail.text) lines.push('', 'Text:', Fmt.clip(maskText(detail.text), 6000));
  else if (detail.html) lines.push('', 'HTML (as text):', Fmt.clip(maskText(String(detail.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()), 6000));
  return lines;
}

function processText(info) {
  return Object.entries(info)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => `${key} ${key === 'uptime' && Number.isFinite(value) ? Fmt.ms(value * 1000) : value}`)
    .join(', ');
}

function mechanismText(mechanism) {
  switch (mechanism) {
    case 'uncaught':
      return 'an uncaught exception';
    case 'unhandledRejection':
      return 'an unhandled promise rejection';
    case 'report':
      return 'reported by the app';
    case 'job':
      return 'in a job';
    default:
      return `caught by ${mechanism}`;
  }
}

function matchesPath(request, value) {
  const needle = value.toLowerCase();
  return [request.path, request.url, request.route].some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

function hasFeature(request, feature) {
  const stats = request.stats || {};
  switch (feature) {
    case 'exception':
      return request.exceptionCount > 0;
    case 'n+1':
      return stats.nPlusOne > 0;
    case 'slow-query':
      return stats.slowQueries > 0;
    case 'duplicate-query':
      return stats.duplicates > 0;
    case 'blocked-loop':
      return stats.loopBlock > 0;
    default:
      return true;
  }
}

function statusFilter(value) {
  if (!value) return null;
  const textValue = value.trim().toLowerCase();
  const range = /^([1-5])xx$/.exec(textValue);
  if (range) return (request) => Number.isInteger(request.status) && Math.floor(request.status / 100) === Number(range[1]);
  if (/^[1-5]\d\d$/.test(textValue)) return (request) => request.status === Number(textValue);
  if (textValue === 'none') return (request) => request.status === null || request.status === undefined;
  if (textValue === 'error' || textValue === 'errors') return (request) => request.status === null || request.status === undefined || request.status >= 500;
  throw new ToolError(`"status" must be a class such as "5xx", a code such as "404", or "none"; not "${Fmt.clip(value, 40)}".`);
}

/**
 * When a window starts: now minus "30m", "6h", "7d"..., "all", or a date.
 *
 * @param {*} value
 * @param {string} fallback
 * @param {number} now
 * @returns {number} ms since the epoch
 */
export function parseSince(value, fallback, now) {
  const input = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  if (input.toLowerCase() === 'all') return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|w)$/i.exec(input);
  if (match) return now - Number(match[1]) * UNITS[match[2].toLowerCase()];
  const at = Date.parse(input);
  if (Number.isFinite(at)) return at;
  throw new ToolError(`"since" must look like "30m", "6h", "7d" or "all" (or a date), not "${Fmt.clip(input, 40)}".`);
}

function describeSince(value, fallback) {
  const input = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  if (input.toLowerCase() === 'all') return 'in all that is stored';
  if (/^\d/.test(input) && !/^\d{4}-/.test(input)) return `in the last ${input}`;
  return `since ${input}`;
}

function text(args, name) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ToolError(`"${name}" must be text.`);
  return value.trim() || null;
}

function required(args, name) {
  const value = text(args, name);
  if (!value) throw new ToolError(`"${name}" is required.`);
  return value;
}

function recordId(value, what) {
  if (!RECORD_ID.test(value)) throw new ToolError(`"${Fmt.clip(value, 70)}" isn't ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what} id.`);
  return value;
}

function integer(args, name, fallback, min, max) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ToolError(`"${name}" must be a number.`);
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function number(args, name) {
  const value = args[name];
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ToolError(`"${name}" must be a positive number.`);
  return parsed;
}

function oneOf(args, name, values, fallback) {
  const value = text(args, name);
  if (value === null) return fallback;
  const lower = value.toLowerCase();
  if (!values.includes(lower)) throw new ToolError(`"${name}" must be one of ${values.join(', ')}.`);
  return lower;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

// Runs `work` over items, `limit` at a time, keeping their order.
async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
