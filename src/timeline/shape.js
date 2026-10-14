/**
 * Value-free shapes of query arguments, for statements that aren't SQL: MongoDB commands
 * (`orders.find({ customerId: ?, status: { $in: ? } })`) and Prisma operations
 * (`User.findMany({ where: { id: ? }, include: { posts: ? } })`).
 *
 * Every value becomes `?` and only the structure stays, so the shape is the same for every
 * execution of the same call: it is both the statement's text and what its fingerprint is
 * computed from.
 */

const IDENTIFIER = /^[$A-Za-z_][\w$]*$/;
const MAX_DEPTH = 6;
// Arrays of objects ($or branches, pipeline stages) list at most this many entries.
const MAX_ITEMS = 20;
const MAX_LENGTH = 4096;

/**
 * Writes shapes.
 */
export class Shape {
  /**
   * The shape of a value: objects keep their keys, arrays of objects their entries, everything
   * else is `?`.
   *
   * @param {*} value
   * @returns {string} At most 4096 characters
   */
  static of(value) {
    const text = write(value, 0);
    return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
  }
}

function write(value, depth) {
  if (Array.isArray(value)) {
    // Values ($in: [1, 2, 3]) are one value; objects (pipeline stages, $or branches) are structure.
    if (value.length === 0 || !value.every(isStructure)) return '?';
    if (depth >= MAX_DEPTH) return '[…]';
    const items = value.slice(0, MAX_ITEMS).map((item) => write(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push('…');
    return `[${items.join(', ')}]`;
  }
  if (!isStructure(value)) return '?';
  const keys = safeKeys(value);
  if (keys.length === 0) return '{}';
  if (depth >= MAX_DEPTH) return '{ … }';
  const fields = keys.map((key) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${write(safeGet(value, key), depth + 1)}`);
  return `{ ${fields.join(', ')} }`;
}

// Plain objects carry structure; driver values (ObjectId, Date, Decimal, Buffer) are values.
function isStructure(value) {
  if (value === null || typeof value !== 'object') return false;
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch (error) {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

function safeKeys(value) {
  try {
    return Object.keys(value);
  } catch (error) {
    return [];
  }
}

function safeGet(target, key) {
  try {
    return target[key];
  } catch (error) {
    return undefined;
  }
}
