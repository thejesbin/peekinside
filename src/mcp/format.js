/**
 * Records as text for AI tools: the facts that help find and fix a problem, compact enough to fit
 * in a model's context, with the ids to ask for more. Credentials in headers and bodies are
 * masked, the way the dashboard shows them.
 */

import { Masker } from '../timeline/masking.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const MASKED = '[masked]';

/**
 * Small formatting helpers.
 */
export class Fmt {
  /**
   * @param {number} at - ms since the epoch
   * @param {number} now
   * @returns {string} Such as "just now", "40s ago", "5m ago", "3h ago", "2d ago"
   */
  static ago(at, now) {
    const ms = Math.max(0, now - at);
    if (ms < 5000) return 'just now';
    if (ms < MINUTE) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
    if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
    return `${Math.floor(ms / DAY)}d ago`;
  }

  /**
   * @param {number} at - ms since the epoch
   * @returns {string} Such as "2026-10-26 14:03:12 UTC"
   */
  static time(at) {
    return Number.isFinite(at) ? `${new Date(at).toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'unknown time';
  }

  /**
   * @param {number} at
   * @param {number} now
   * @returns {string} Such as "2026-10-26 14:03:12 UTC (5m ago)"
   */
  static when(at, now) {
    return `${Fmt.time(at)} (${Fmt.ago(at, now)})`;
  }

  /**
   * @param {number|null|undefined} ms
   * @returns {string} Such as "0.4 ms", "12 ms", "1.24 s", "2m 03s"
   */
  static ms(ms) {
    if (!Number.isFinite(ms)) return '?';
    if (ms < 1) return `${Math.round(ms * 100) / 100} ms`;
    if (ms < 10) return `${Math.round(ms * 10) / 10} ms`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < MINUTE) return `${(ms / 1000).toFixed(2)} s`;
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }

  /**
   * @param {number|null|undefined} bytes
   * @returns {string} Such as "512 B", "1.2 KB", "182 MB"
   */
  static bytes(bytes) {
    if (!Number.isFinite(bytes)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  /**
   * @param {number} count
   * @param {string} one
   * @param {string} [many] - Default: `one` + "s"
   * @returns {string} Such as "1 query", "12 queries"
   */
  static count(count, one, many = `${one}s`) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  }

  /**
   * @param {*} text
   * @param {number} max - Characters
   * @returns {string} The text, cut with "…" past `max`
   */
  static clip(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  /**
   * @param {*} text
   * @param {number} max
   * @returns {string} On one line: line breaks become spaces
   */
  static line(text, max) {
    return Fmt.clip(String(text ?? '').replace(/\s*\n\s*/g, ' ').trim(), max);
  }

  /**
   * A value as indented JSON, masked and cut.
   *
   * @param {*} value
   * @param {number} [max=2000] - Characters
   * @returns {string}
   */
  static json(value, max = 2000) {
    let text;
    try {
      text = JSON.stringify(mask(value), null, 2);
    } catch (error) {
      text = String(value);
    }
    if (text === undefined) return 'undefined';
    return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters)` : text;
  }

  /**
   * A URL as the dashboard shows it: without credentials, sensitive query values masked.
   *
   * @param {*} url
   * @param {number} [max=1000]
   * @returns {string}
   */
  static url(url, max = 1000) {
    return Fmt.clip(Masker.url(String(url ?? '')), max);
  }

  /**
   * Where a frame or a site is: "src/orders.js:42:13", or "node:internal/…", or "native".
   *
   * @param {{ relativeFile?: string|null, file?: string|null, line?: number|null, column?: number|null }} place
   * @returns {string}
   */
  static place(place) {
    if (!place) return 'unknown place';
    const file = place.relativeFile || place.file;
    if (!file) return 'native';
    return `${file}${Number.isFinite(place.line) ? `:${place.line}` : ''}${Number.isFinite(place.column) ? `:${place.column}` : ''}`;
  }

  /**
   * @param {Object|null|undefined} user - As the app set it (PeekInside.setUser())
   * @returns {string} Such as "id 42, ada@example.com"; "" without one
   */
  static user(user) {
    if (!user || typeof user !== 'object') return '';
    const parts = [];
    if (user.id !== undefined && user.id !== null) parts.push(`id ${user.id}`);
    for (const key of ['email', 'name', 'username', 'phone']) {
      if (typeof user[key] === 'string' && user[key]) parts.push(user[key]);
    }
    return Fmt.clip(parts.join(', '), 160);
  }

  /**
   * The key a user is counted by: id, else email, name or phone.
   *
   * @param {Object|null|undefined} user
   * @returns {string|null}
   */
  static userKey(user) {
    if (!user || typeof user !== 'object') return null;
    for (const key of ['id', 'email', 'name', 'username', 'phone']) {
      if (user[key] !== undefined && user[key] !== null && user[key] !== '') return `${key}:${user[key]}`;
    }
    return null;
  }
}

/**
 * Headers as lines, with credentials masked.
 *
 * @param {Object<string, string|string[]>|null|undefined} headers
 * @param {string} indent
 * @returns {string[]}
 */
export function headerLines(headers, indent = '  ') {
  if (!headers || typeof headers !== 'object') return [];
  return Object.entries(headers).map(([name, value]) => {
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    return `${indent}${name}: ${Masker.isSensitiveName(name) || Masker.isSecretString(text) ? MASKED : Fmt.clip(text, 300)}`;
  });
}

/**
 * A captured body, as text: JSON indented with sensitive fields masked, other text cut, binary
 * described.
 *
 * @param {*} body
 * @param {string} encoding - "none", "utf8", "binary" or "unavailable"
 * @param {number|undefined} size - Bytes
 * @param {boolean} truncated - Whether the SDK kept only its start
 * @param {number} [max=4000]
 * @returns {string|null} null when there was none
 */
export function bodyText(body, encoding, size, truncated, max = 4000) {
  if (encoding === 'none' || ((body === '' || body == null) && !size)) return null;
  if (encoding === 'binary') return `(binary, ${Fmt.bytes(size)})`;
  if (encoding === 'unavailable') return '(not captured)';
  const note = truncated ? `\n(PeekInside kept only the start of this body${Number.isFinite(size) ? `, of ${Fmt.bytes(size)}` : ''})` : '';
  if (body !== null && typeof body === 'object') return Fmt.json(body, max) + note;
  const text = String(body ?? '');
  if (/^\s*[[{]/.test(text)) {
    try {
      return Fmt.json(JSON.parse(text), max) + note;
    } catch (error) {
      // Not JSON (or cut off): shown as text, masked as text.
    }
  }
  return Fmt.clip(maskText(text), max) + note;
}

// In free text: "key": "value" pairs (JSON, whole or cut off), key=value pairs (forms, query
// strings), multipart fields, and bearer tokens, JWTs and password hashes wherever they are.
const JSON_PAIR = /("((?:[^"\\\n]|\\.){1,200})"\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,}\]\s]+)/g;
const FORM_PAIR = /((?:^|[?&;\s])([^=&;\s"'{}]{1,200}))=([^&;\s]*)/g;
const MULTIPART_FIELD = /(name="([^"]{1,200})"[^\r\n]*(?:\r?\n[^\r\n]+)*\r?\n\r?\n)([^\r\n]*)/g;
const BEARER = /\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_ANYWHERE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const HASH_ANYWHERE = /\$(?:2[aby]\$\d\d\$[./A-Za-z0-9]{53}|argon2(?:id|i|d)?\$[^\s"']+|scrypt\$[^\s"']+)/g;

/**
 * Free text (a body that isn't JSON, a log line, an error message) with what looks like a
 * credential masked: values under sensitive names, tokens, JWTs and password hashes.
 *
 * @param {*} text
 * @returns {string}
 */
export function maskText(text) {
  return String(text ?? '')
    .replace(JSON_PAIR, (all, head, name, value) => (Masker.isSensitiveName(name) ? `${head}"${MASKED}"` : all))
    .replace(FORM_PAIR, (all, head, name) => (Masker.isSensitiveName(name) ? `${head}=${MASKED}` : all))
    .replace(MULTIPART_FIELD, (all, head, name) => (Masker.isSensitiveName(name) ? `${head}${MASKED}` : all))
    .replace(BEARER, (all, scheme, space) => `${scheme}${space}${MASKED}`)
    .replace(JWT_ANYWHERE, MASKED)
    .replace(HASH_ANYWHERE, MASKED);
}

/**
 * A value with what sits under sensitive names, and secret-shaped strings, masked.
 *
 * @param {*} value
 * @param {number} [depth=0]
 * @returns {*}
 */
export function mask(value, depth = 0) {
  if (typeof value === 'string') return Masker.isSecretString(value) ? MASKED : value;
  if (value === null || typeof value !== 'object' || depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = Masker.isSensitiveName(key) && item !== null && item !== '' ? MASKED : mask(item, depth + 1);
  }
  return out;
}

/**
 * A stack's frames, the app's own marked, with the source lines PeekInside read for them. Runs of
 * frames in packages or Node.js are folded into one line.
 *
 * @param {Object[]} frames - Top frame first (see exceptions/frame-classifier.js)
 * @param {{ maxFrames?: number, source?: boolean }} [options]
 * @returns {string[]}
 */
export function frameLines(frames, { maxFrames = 14, source = true } = {}) {
  const lines = [];
  let shown = 0;
  let folded = [];
  const flush = () => {
    if (!folded.length) return;
    const names = [...new Set(folded.map((frame) => frame.module || (String(frame.file || '').startsWith('node:') ? 'node' : null)).filter(Boolean))];
    lines.push(`  … ${Fmt.count(folded.length, 'frame')}${names.length ? ` in ${names.slice(0, 4).join(', ')}` : ''}`);
    folded = [];
  };
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (shown >= maxFrames) {
      folded.push(frame);
      continue;
    }
    // The top frame is shown wherever it is (a driver or a parser often says what failed); below
    // it, frames outside the app are folded.
    if (!frame.inApp && shown > 0 && !(frame.context && frame.context.lines)) {
      folded.push(frame);
      continue;
    }
    flush();
    shown++;
    const where = `${Fmt.place(frame)}${frame.module ? ` (${frame.module})` : ''}`;
    lines.push(`${frame.inApp ? '▶' : ' '} ${frame.function || '<anonymous>'}  ${where}`);
    if (source && frame.context && Array.isArray(frame.context.lines)) {
      const width = String(frame.context.start + frame.context.lines.length - 1).length;
      frame.context.lines.forEach((text, index) => {
        const number = frame.context.start + index;
        lines.push(`  ${number === frame.line ? '→' : ' '} ${String(number).padStart(width)} │ ${Fmt.clip(text, 200)}`);
      });
    }
  }
  flush();
  return lines;
}

/**
 * What a timeline (a request's or a job run's) shows: its queries grouped by statement, its HTTP
 * calls, logs, event-loop blocks, and the order things happened in.
 *
 * @param {Object|undefined} timeline - See timeline/timeline.js
 * @param {Object|null|undefined} stats - The record's counters
 * @param {{ statements?: number, spans?: number, logs?: number }} [limits]
 * @returns {string[]}
 */
export function timelineLines(timeline, stats, { statements: maxStatements = 12, spans: maxSpans = 40, logs: maxLogs = 15 } = {}) {
  const lines = [];
  const statements = timeline && Array.isArray(timeline.statements) ? timeline.statements : [];
  const spans = timeline && Array.isArray(timeline.spans) ? timeline.spans : [];

  if (stats && stats.queries) {
    const flags = [];
    if (stats.slowQueries) flags.push(Fmt.count(stats.slowQueries, 'slow query', 'slow queries'));
    if (stats.nPlusOne) flags.push(Fmt.count(stats.nPlusOne, 'N+1 pattern'));
    if (stats.duplicates) flags.push(Fmt.count(stats.duplicates, 'duplicate'));
    lines.push(`Database: ${Fmt.count(stats.queries, 'query', 'queries')} in ${Fmt.ms(stats.queryTime)}${flags.length ? ` (${flags.join(', ')})` : ''}`);
  }
  const ranked = [...statements].sort((a, b) => Number(b.nPlusOne) - Number(a.nPlusOne) || b.time - a.time);
  ranked.slice(0, maxStatements).forEach((statement, index) => {
    const flags = [];
    if (statement.nPlusOne) flags.push('N+1');
    if (statement.slow) flags.push(`${statement.slow} slow`);
    if (statement.duplicates) flags.push(`${statement.duplicates} duplicate${statement.duplicates === 1 ? '' : 's'}`);
    const times = statement.count > 1 ? `×${statement.count}, ${Fmt.ms(statement.time)} in all (max ${Fmt.ms(statement.maxTime)})` : Fmt.ms(statement.time);
    lines.push(`  ${index + 1}. ${times}${flags.length ? ` [${flags.join(', ')}]` : ''} ${statement.system || ''}${statement.client ? ` via ${statement.client}` : ''}`);
    lines.push(`     ${Fmt.line(statement.text, 600)}`);
    if (statement.caller) lines.push(`     from ${Fmt.place(statement.caller)}${statement.caller.function ? ` in ${statement.caller.function}` : ''}`);
    const example = spans.find((span) => span.type === 'query' && span.statement === statements.indexOf(statement) && span.params !== undefined);
    if (example) lines.push(`     parameters, e.g.: ${Fmt.line(JSON.stringify(mask(example.params)), 300)}`);
  });
  if (ranked.length > maxStatements) lines.push(`  … ${Fmt.count(ranked.length - maxStatements, 'more statement')}`);

  const calls = spans.filter((span) => span.type === 'http');
  if (calls.length || (stats && stats.http)) {
    lines.push(`Outgoing HTTP: ${Fmt.count(stats && stats.http ? stats.http : calls.length, 'call')}${stats && stats.httpTime ? ` in ${Fmt.ms(stats.httpTime)}` : ''}`);
    for (const call of calls.slice(0, 15)) {
      const outcome = call.error ? `failed: ${Fmt.line(maskText(call.error), 200)}` : call.status ? `→ ${call.status}` : '→ no answer';
      lines.push(`  ${call.method} ${Fmt.url(call.url, 300)} ${outcome} in ${Fmt.ms(call.duration)}`);
    }
    if (calls.length > 15) lines.push(`  … ${Fmt.count(calls.length - 15, 'more call')}`);
  }

  const logs = spans.filter((span) => span.type === 'log');
  if (logs.length) {
    lines.push(`Logs: ${Fmt.count(logs.length, 'line')}`);
    for (const log of logs.slice(-maxLogs)) lines.push(`  +${Fmt.ms(log.start)} [${log.level}] ${Fmt.line(maskText(log.message), 300)}`);
    if (logs.length > maxLogs) lines.push(`  (the last ${maxLogs} shown)`);
  }

  const blocks = spans.filter((span) => span.type === 'block');
  for (const block of blocks.slice(0, 5)) {
    const sites = Array.isArray(block.sites) && block.sites.length
      ? ` while running ${block.sites.map((site) => `${site.function || '<anonymous>'} (${Fmt.place(site)}${site.package ? `, ${site.package}` : ''})`).join(', ')}`
      : '';
    lines.push(`Event loop blocked for ${Fmt.ms(block.duration)} at +${Fmt.ms(block.start)}${sites}`);
  }

  const measures = spans.filter((span) => span.type === 'measure');
  for (const measure of measures.slice(0, 10)) lines.push(`Measure "${Fmt.line(measure.name, 100)}": ${Fmt.ms(measure.duration)} at +${Fmt.ms(measure.start)}`);

  if (spans.length > 1) {
    lines.push(`Order of events (ms from the start${spans.length > maxSpans ? `, the first ${maxSpans} of ${spans.length}` : ''}):`);
    for (const span of spans.slice(0, maxSpans)) lines.push(`  +${Fmt.ms(span.start)} ${spanLabel(span, statements)}`);
  }
  if (timeline && timeline.dropped) lines.push(`(${Fmt.count(timeline.dropped, 'event')} not listed: the timeline keeps a bounded number)`);
  return lines;
}

function spanLabel(span, statements) {
  switch (span.type) {
    case 'query': {
      const statement = statements[span.statement];
      return `query ${Fmt.ms(span.duration)}${Number.isInteger(span.rows) ? `, ${Fmt.count(span.rows, 'row')}` : ''}${span.error ? `, FAILED: ${Fmt.line(span.error, 120)}` : ''}: ${Fmt.line(span.text || (statement && statement.text) || '', 140)}`;
    }
    case 'http':
      return `HTTP ${span.method} ${Fmt.clip(span.host || span.url, 80)} ${span.status || (span.error ? 'failed' : '')} ${Fmt.ms(span.duration)}`;
    case 'log':
      return `log [${span.level}] ${Fmt.line(maskText(span.message), 120)}`;
    case 'exception':
      return `exception ${span.name}: ${Fmt.line(maskText(span.message), 120)} (id ${span.id})`;
    case 'block':
      return `event loop blocked ${Fmt.ms(span.duration)}`;
    case 'measure':
      return `measure "${Fmt.line(span.name, 60)}" ${Fmt.ms(span.duration)}`;
    case 'dump':
      return `dump${span.label ? ` "${Fmt.line(span.label, 60)}"` : ''}: ${Fmt.line(maskText(span.preview), 100)}`;
    case 'mail':
      return `email "${Fmt.line(span.subject, 80)}" to ${Array.isArray(span.to) ? span.to.join(', ') : ''}`;
    default:
      return span.type;
  }
}

/**
 * A dump's tree (see dumps/dump-value.js) as indented text, the way util.inspect would show it.
 *
 * @param {Object} node
 * @param {number} [max=8000] - Characters
 * @returns {string}
 */
export function dumpText(node, max = 8000) {
  const out = renderNode(node, 0);
  return out.length > max ? `${out.slice(0, max)}\n… (cut at ${max.toLocaleString('en-US')} characters)` : out;
}

function renderNode(node, depth) {
  if (!node || typeof node !== 'object') return String(node);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  const more = (shown, total) => (total > shown ? `\n${pad}… ${total - shown} more` : '');
  switch (node.t) {
    case 'str':
      return `${JSON.stringify(node.v)}${node.len ? ` (${node.len} characters, cut)` : ''}`;
    case 'num':
    case 'sym':
    case 'date':
    case 're':
      return String(node.v);
    case 'big':
      return `${node.v}n`;
    case 'bool':
      return String(node.v);
    case 'null':
      return 'null';
    case 'undef':
      return 'undefined';
    case 'hole':
      return '<empty>';
    case 'fn':
      return node.kind === 'class' ? `[class ${node.name || '(anonymous)'}]` : `[${node.kind === 'async' ? 'AsyncFunction' : 'Function'}${node.name ? ` ${node.name}` : ''}]`;
    case 'err': {
      const head = `${node.cls}${node.msg ? `: ${node.msg}` : ''}`;
      const props = Array.isArray(node.props) ? node.props : [];
      const stack = node.stack ? `\n${pad}${String(node.stack).split('\n').slice(1, 6).map((line) => line.trim()).join(`\n${pad}`)}` : '';
      return props.length ? `${head} { ${props.map(([key, value]) => `${key}: ${renderNode(value, depth + 1)}`).join(', ')} }${stack}` : `${head}${stack}`;
    }
    case 'buf':
      return `<${node.cls} ${node.len} bytes: ${(String(node.hex || '').match(/../g) || []).join(' ')}${node.len > String(node.hex || '').length / 2 ? ' …' : ''}>`;
    case 'box':
      return `[${node.cls}: ${renderNode(node.v, depth)}]`;
    case 'get':
      return node.set ? '[Getter/Setter]' : '[Getter]';
    case 'ref':
      return `[Circular ${node.path}]`;
    case 'proxy':
      return '[Proxy]';
    case 'promise':
      return 'Promise';
    case 'weak':
      return node.cls;
    case 'cut':
      return `${node.cls ? `${node.cls} ` : ''}{…}`;
    case 'arr': {
      const items = Array.isArray(node.items) ? node.items : [];
      const head = node.cls ? `${node.cls}(${node.len}) ` : '';
      if (!items.length) return `${head}[]`;
      return `${head}[\n${items.map((item) => `${pad}${renderNode(item, depth + 1)}`).join(',\n')}${more(items.length, node.len)}\n${close}]`;
    }
    case 'map': {
      const entries = Array.isArray(node.entries) ? node.entries : [];
      if (!entries.length) return 'Map(0) {}';
      return `Map(${node.len}) {\n${entries.map(([key, value]) => `${pad}${renderNode(key, depth + 1)} => ${renderNode(value, depth + 1)}`).join(',\n')}${more(entries.length, node.len)}\n${close}}`;
    }
    case 'set': {
      const items = Array.isArray(node.items) ? node.items : [];
      if (!items.length) return 'Set(0) {}';
      return `Set(${node.len}) {\n${items.map((item) => `${pad}${renderNode(item, depth + 1)}`).join(',\n')}${more(items.length, node.len)}\n${close}}`;
    }
    case 'obj': {
      const props = Array.isArray(node.props) ? node.props : [];
      const head = node.cls ? `${node.cls} ` : '';
      if (!props.length) return `${head}{}`;
      const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
      return `${head}{\n${props.map(([name, value]) => `${pad}${key(name)}: ${Masker.isSensitiveName(name) && value && value.t === 'str' ? MASKED : renderNode(value, depth + 1)}`).join(',\n')}${more(props.length, node.len)}\n${close}}`;
    }
    default:
      return '…';
  }
}
