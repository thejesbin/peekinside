/**
 * The value a dump shows: a typed tree of what the app passed to dump(), read without running the
 * app's code.
 *
 * console.log turns a value into text; a dump keeps its shape, so the dashboard can show it as a
 * tree that opens level by level, with the type of each node: a Map stays a Map, a Date a date, a
 * class instance says its class. Reading is careful: getters aren't called (they could do
 * anything), proxies aren't looked into, and a cycle becomes a reference to the ancestor it loops
 * back to. The tree stops at bounds on depth, items per object, string length and total size, and
 * says what it left out.
 *
 * Nodes, by `t`:
 *
 *   str  { v, len? }                 a string; `len` is its full length when it was cut
 *   num  { v }  big { v }            numbers and BigInts, as text (NaN, Infinity and -0 survive)
 *   bool { v }  null  undef  hole    hole: an empty slot of a sparse array
 *   sym  { v }                       a symbol, as text
 *   fn   { name, kind? }             a function; kind is "class", "async" or "generator"
 *   date { v }  re { v }             a date (ISO, or "Invalid Date") and a regular expression
 *   err  { cls, msg, stack?, props } an error, with its own properties (code, status...)
 *   arr  { cls?, len, items }        an array (cls for subclasses and typed arrays)
 *   obj  { cls, len, props }         an object: cls is its class, null for a plain object
 *   map  { len, entries }  set { len, items }
 *   buf  { cls, len, hex }           a Buffer or ArrayBuffer: its size and first bytes
 *   box  { cls, v }                  a boxed primitive (new String("x"))
 *   get  { set? }                    an own accessor property, not called
 *   ref  { path }                    a cycle: the ancestor it points back to ("$.owner")
 *   cut  { cls?, len? }              not read: past the depth or size bounds
 *   proxy  promise  weak { cls }     kinds whose contents aren't read
 *
 * `len` of a container counts all its items, even when only the first ones are in the tree.
 */

import { types } from 'util';

export const DUMP_LIMITS = Object.freeze({
  depth: 10,
  items: 100,
  string: 4000,
  stack: 4000,
  nodes: 5000,
  // Characters of strings in one tree, all together.
  text: 256 * 1024,
  bytes: 48,
  preview: 160
});

/**
 * Reads values into dump trees.
 */
export class DumpValue {
  /**
   * @param {*} value
   * @returns {{ tree: Object, type: string, preview: string, truncated: boolean }} The tree, a short
   *   name of its type ("User", "array", "string"), a one-line preview, and whether bounds cut it
   */
  static capture(value) {
    const reader = new Reader();
    let tree;
    try {
      tree = reader.node(value, 0, '$');
    } catch (error) {
      // Every read is guarded; this is the last line of defense.
      tree = { t: 'cut' };
      reader.truncated = true;
    }
    return { tree, type: DumpValue.typeOf(tree), preview: DumpValue.preview(tree, DUMP_LIMITS.preview), truncated: reader.truncated };
  }

  /**
   * A short name of a node's type: its class for objects, else its kind.
   *
   * @param {Object} node
   * @returns {string}
   */
  static typeOf(node) {
    switch (node.t) {
      case 'str':
        return 'string';
      case 'num':
        return 'number';
      case 'big':
        return 'bigint';
      case 'bool':
        return 'boolean';
      case 'undef':
        return 'undefined';
      case 'sym':
        return 'symbol';
      case 'fn':
        return node.kind === 'class' ? 'class' : 'function';
      case 're':
        return 'RegExp';
      case 'date':
        return 'Date';
      case 'arr':
        return node.cls || 'array';
      case 'map':
        return 'Map';
      case 'set':
        return 'Set';
      case 'err':
      case 'obj':
      case 'buf':
      case 'box':
        return node.cls || 'object';
      default:
        return node.t;
    }
  }

  /**
   * The node on one line, as a list shows it: `User { id: 1, name: "Ada", … }`.
   *
   * @param {Object} node
   * @param {number} [max=160] - Characters at most
   * @returns {string}
   */
  static preview(node, max = DUMP_LIMITS.preview) {
    const text = line(node, 2);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
}

class Reader {
  constructor() {
    this.nodes = 0;
    this.text = 0;
    this.truncated = false;
    // The objects being read, from the root down, to their paths: a cycle points back to one.
    this.ancestors = new Map();
  }

  node(value, depth, path) {
    this.nodes++;
    switch (typeof value) {
      case 'string':
        return this.string(value, DUMP_LIMITS.string);
      case 'number':
        return { t: 'num', v: Object.is(value, -0) ? '-0' : String(value) };
      case 'bigint':
        return { t: 'big', v: value.toString() };
      case 'boolean':
        return { t: 'bool', v: value };
      case 'undefined':
        return { t: 'undef' };
      case 'symbol':
        return { t: 'sym', v: guard(() => value.toString(), 'Symbol()') };
      case 'function':
        return fn(value);
      default:
        return value === null ? { t: 'null' } : this.object(value, depth, path);
    }
  }

  string(value, max) {
    const room = Math.max(0, Math.min(max, DUMP_LIMITS.text - this.text));
    if (value.length <= room) {
      this.text += value.length;
      return { t: 'str', v: value };
    }
    this.truncated = true;
    const cut = value.slice(0, room);
    this.text += cut.length;
    return { t: 'str', v: cut, len: value.length };
  }

  object(value, depth, path) {
    if (types.isProxy(value)) return { t: 'proxy' };
    const ancestor = this.ancestors.get(value);
    if (ancestor) return { t: 'ref', path: ancestor };
    const cls = className(value);
    if (types.isDate(value)) return { t: 'date', v: guard(() => (Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()), 'Invalid Date') };
    if (types.isRegExp(value)) return { t: 're', v: guard(() => RegExp.prototype.toString.call(value), '/(?:)/') };
    if (types.isPromise(value)) return { t: 'promise' };
    if (types.isWeakMap(value) || types.isWeakSet(value)) return { t: 'weak', cls: cls || 'Weak' };
    if (Buffer.isBuffer(value)) return { t: 'buf', cls: 'Buffer', len: value.length, hex: value.subarray(0, DUMP_LIMITS.bytes).toString('hex') };
    if (types.isAnyArrayBuffer(value)) {
      return { t: 'buf', cls: cls || 'ArrayBuffer', len: value.byteLength, hex: Buffer.from(value, 0, Math.min(DUMP_LIMITS.bytes, value.byteLength)).toString('hex') };
    }
    if (types.isBoxedPrimitive(value)) return { t: 'box', cls: cls || 'Object', v: this.node(guard(() => value.valueOf(), undefined), depth + 1, path) };
    if (depth >= DUMP_LIMITS.depth || this.nodes > DUMP_LIMITS.nodes || this.text >= DUMP_LIMITS.text) {
      this.truncated = true;
      return { t: 'cut', ...(cls ? { cls } : {}), ...sizeOf(value) };
    }

    this.ancestors.set(value, path);
    try {
      if (types.isNativeError(value) || value instanceof Error) return this.error(value, cls, depth, path);
      if (Array.isArray(value)) return this.array(value, cls, depth, path);
      if (types.isTypedArray(value)) return this.typedArray(value, cls);
      if (types.isMap(value)) return this.map(value, depth, path);
      if (types.isSet(value)) return this.set(value, depth, path);
      return { t: 'obj', cls, ...this.props(value, depth, path, null) };
    } finally {
      this.ancestors.delete(value);
    }
  }

  // Own enumerable properties, string keys then symbols; `skip` leaves some out.
  props(value, depth, path, skip) {
    const keys = guard(() => Reflect.ownKeys(value), []);
    const props = [];
    let len = 0;
    for (const key of keys) {
      if (skip && skip.has(key)) continue;
      const descriptor = guard(() => Object.getOwnPropertyDescriptor(value, key), undefined);
      if (!descriptor || !descriptor.enumerable) continue;
      len++;
      if (props.length >= DUMP_LIMITS.items || this.nodes > DUMP_LIMITS.nodes) {
        this.truncated = true;
        continue;
      }
      const name = typeof key === 'symbol' ? `[${guard(() => key.toString(), 'Symbol()')}]` : key;
      props.push([name, this.property(descriptor, depth, childPath(path, name))]);
    }
    return { len, props };
  }

  property(descriptor, depth, path) {
    if ('value' in descriptor) return this.node(descriptor.value, depth + 1, path);
    this.nodes++;
    return descriptor.set ? { t: 'get', set: true } : { t: 'get' };
  }

  array(value, cls, depth, path) {
    const len = value.length;
    const count = Math.min(len, DUMP_LIMITS.items);
    const items = [];
    for (let index = 0; index < count && this.nodes <= DUMP_LIMITS.nodes; index++) {
      const descriptor = guard(() => Object.getOwnPropertyDescriptor(value, index), undefined);
      items.push(descriptor ? this.property(descriptor, depth, `${path}[${index}]`) : (this.nodes++, { t: 'hole' }));
    }
    if (items.length < len) this.truncated = true;
    return { t: 'arr', ...(cls && cls !== 'Array' ? { cls } : {}), len, items };
  }

  typedArray(value, cls) {
    const len = value.length;
    const count = Math.min(len, DUMP_LIMITS.items);
    const items = [];
    for (let index = 0; index < count; index++) {
      this.nodes++;
      const item = value[index];
      items.push(typeof item === 'bigint' ? { t: 'big', v: item.toString() } : { t: 'num', v: Object.is(item, -0) ? '-0' : String(item) });
    }
    if (count < len) this.truncated = true;
    return { t: 'arr', cls: cls || 'TypedArray', len, items };
  }

  map(value, depth, path) {
    const len = guard(() => MAP_SIZE.call(value), 0);
    const entries = [];
    for (const [key, item] of guard(() => Map.prototype.entries.call(value), [])) {
      if (entries.length >= DUMP_LIMITS.items || this.nodes > DUMP_LIMITS.nodes) break;
      const keyNode = this.node(key, depth + 1, `${path}.keys()[${entries.length}]`);
      entries.push([keyNode, this.node(item, depth + 1, `${path}.get(${keyText(keyNode)})`)]);
    }
    if (entries.length < len) this.truncated = true;
    return { t: 'map', len, entries };
  }

  set(value, depth, path) {
    const len = guard(() => SET_SIZE.call(value), 0);
    const items = [];
    for (const item of guard(() => Set.prototype.values.call(value), [])) {
      if (items.length >= DUMP_LIMITS.items || this.nodes > DUMP_LIMITS.nodes) break;
      items.push(this.node(item, depth + 1, `${path}[${items.length}]`));
    }
    if (items.length < len) this.truncated = true;
    return { t: 'set', len, items };
  }

  error(value, cls, depth, path) {
    const name = ownString(value, 'name') || cls || 'Error';
    const message = ownString(value, 'message');
    // V8 keeps a native error's stack behind its own accessor; reading it runs no app code.
    const stack = types.isNativeError(value) ? guard(() => (typeof value.stack === 'string' ? value.stack : ''), '') : ownString(value, 'stack');
    const { props } = this.props(value, depth, path, ERROR_OWN);
    const cause = guard(() => Object.getOwnPropertyDescriptor(value, 'cause'), undefined);
    if (cause && 'value' in cause) props.push(['cause', this.node(cause.value, depth + 1, `${path}.cause`)]);
    return {
      t: 'err',
      cls: name,
      msg: this.string(message, DUMP_LIMITS.string).v,
      ...(stack ? { stack: this.string(stack, DUMP_LIMITS.stack).v } : {}),
      props
    };
  }
}

const ERROR_OWN = new Set(['name', 'message', 'stack', 'cause']);
// Map's and Set's own size getters, so an object's own `size` can't stand in.
const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;

function fn(value) {
  if (types.isProxy(value)) return { t: 'proxy' };
  const name = guard(() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'name');
    return descriptor && typeof descriptor.value === 'string' ? descriptor.value : '';
  }, '');
  let kind = null;
  if (types.isAsyncFunction(value)) kind = 'async';
  else if (types.isGeneratorFunction(value)) kind = 'generator';
  else if (guard(() => /^class\b/.test(Function.prototype.toString.call(value)), false)) kind = 'class';
  return { t: 'fn', name, ...(kind ? { kind } : {}) };
}

// The class of an object, read without getters: null for plain objects (and those without a
// prototype).
function className(value) {
  return guard(() => {
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) return null;
    const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    const name = constructor && typeof constructor.value === 'function' ? Object.getOwnPropertyDescriptor(constructor.value, 'name') : null;
    return name && typeof name.value === 'string' && name.value ? name.value : 'Object';
  }, null);
}

// How big a container left unread is, when that is cheap to know.
function sizeOf(value) {
  if (Array.isArray(value)) return { len: value.length };
  if (types.isMap(value)) return { len: guard(() => MAP_SIZE.call(value), 0) };
  if (types.isSet(value)) return { len: guard(() => SET_SIZE.call(value), 0) };
  return {};
}

function ownString(value, key) {
  const descriptor = guard(() => Object.getOwnPropertyDescriptor(value, key), undefined);
  if (descriptor && typeof descriptor.value === 'string') return descriptor.value;
  // name and message usually live on the prototype (Error.prototype.name); read as data only.
  for (let proto = guard(() => Object.getPrototypeOf(value), null); proto; proto = guard(() => Object.getPrototypeOf(proto), null)) {
    const inherited = guard(() => Object.getOwnPropertyDescriptor(proto, key), undefined);
    if (inherited) return typeof inherited.value === 'string' ? inherited.value : '';
  }
  return '';
}

function childPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function keyText(node) {
  return node.t === 'str' ? JSON.stringify(node.v) : node.t === 'num' || node.t === 'big' || node.t === 'bool' ? String(node.v) : '…';
}

function guard(read, fallback) {
  try {
    return read();
  } catch (error) {
    return fallback;
  }
}

// One node as text, `depth` levels down.
function line(node, depth) {
  switch (node.t) {
    case 'str':
      return JSON.stringify(node.v.length > 60 ? `${node.v.slice(0, 60)}…` : node.v);
    case 'num':
    case 'sym':
    case 'date':
    case 're':
      return node.v;
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
    case 'err':
      return node.msg ? `${node.cls}: ${node.msg}` : node.cls;
    case 'buf':
      return `<${node.cls} ${(node.hex.match(/../g) || []).slice(0, 8).join(' ')}${node.len > 8 ? ' …' : ''}>`;
    case 'box':
      return `[${node.cls}: ${line(node.v, 0)}]`;
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
      const head = node.cls ? `${node.cls}(${node.len}) ` : '';
      if (!node.len) return `${head}[]`;
      if (depth <= 0) return `${head}[…]`;
      return `${head}[${list(node.items.map((item) => line(item, depth - 1)), node.len)}]`;
    }
    case 'map': {
      if (!node.len) return 'Map(0) {}';
      if (depth <= 0) return `Map(${node.len}) {…}`;
      return `Map(${node.len}) { ${list(node.entries.map(([key, value]) => `${line(key, 0)} => ${line(value, depth - 1)}`), node.len)} }`;
    }
    case 'set': {
      if (!node.len) return 'Set(0) {}';
      if (depth <= 0) return `Set(${node.len}) {…}`;
      return `Set(${node.len}) { ${list(node.items.map((item) => line(item, depth - 1)), node.len)} }`;
    }
    case 'obj': {
      const head = node.cls ? `${node.cls} ` : '';
      if (!node.len) return `${head}{}`;
      if (depth <= 0) return `${head}{…}`;
      return `${head}{ ${list(node.props.map(([key, value]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${line(value, depth - 1)}`), node.len)} }`;
    }
    default:
      return '…';
  }
}

// The first few parts, and an ellipsis for the rest.
function list(parts, total) {
  const shown = parts.slice(0, 4);
  return total > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
}
