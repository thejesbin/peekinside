/**
 * Patching library methods without the app noticing.
 *
 * A wrapper keeps the original's name and length (some libraries inspect a function's length to
 * pick a calling convention), is installed once per method and module instance, and calls the
 * original with the same `this` and arguments.
 */

// Owner object -> names of its methods this copy of PeekInside has patched.
const patched = new WeakMap();

/**
 * Replaces `owner[name]` with `makeWrapper(original)`, once.
 *
 * @param {Object} owner - The object that holds the method as an own property (a prototype)
 * @param {string} name
 * @param {(original: Function) => Function} makeWrapper
 * @returns {boolean} Whether the method is patched now (also when it already was)
 */
export function patchMethod(owner, name, makeWrapper) {
  if (!owner || typeof owner[name] !== 'function') return false;
  let names = patched.get(owner);
  if (!names) {
    names = new Set();
    patched.set(owner, names);
  }
  if (names.has(name)) return true;

  const original = owner[name];
  const wrapper = makeWrapper(original);
  try {
    Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
    Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true });
  } catch (error) {
    // Cosmetic only.
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  Object.defineProperty(owner, name, {
    value: wrapper,
    writable: descriptor ? descriptor.writable !== false : true,
    enumerable: descriptor ? descriptor.enumerable : false,
    configurable: true
  });
  names.add(name);
  return true;
}

/**
 * The object in `target`'s prototype chain that holds `name` as an own property: where a method
 * has to be patched so every instance (and subclass) sees the wrapper.
 *
 * @param {Object} target - Usually a class's prototype
 * @param {string} name
 * @returns {Object|null}
 */
export function ownerOf(target, name) {
  for (let current = target; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    if (Object.prototype.hasOwnProperty.call(current, name)) return current;
  }
  return null;
}

/**
 * Whether a value is a native promise (not merely a thenable: lazy thenables, such as Prisma's
 * and Mongoose's queries, run when then() is called).
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isNativePromise(value) {
  return value instanceof Promise;
}
