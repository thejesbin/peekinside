/**
 * Who a request or an exception was for, as the app tells PeekInside (PeekInside.setUser()), so the
 * dashboard can count the users an issue affects and list everything one customer ran into.
 *
 * A user is personal data: PeekInside Cloud only ever receives it sealed, inside the summary of
 * the request or exception, so only the project's browsers can read it.
 */

const MAX_ID = 128;
const MAX_EMAIL = 254;
const MAX_NAME = 128;
const MAX_PHONE = 32;

/**
 * @typedef {Object} User
 * @property {string|null} id
 * @property {string|null} email
 * @property {string|null} name
 * @property {string|null} phone
 */

/**
 * Normalizes what apps pass as a user.
 */
export class UserInfo {
  /**
   * Accepts `{ id, email, name, phone }` (also `_id`, `userId`, `username`, `phoneNumber`,
   * `phone_number` and `mobile`, as user objects of common libraries and apps have them), or just
   * an id. Anything else is no user.
   *
   * @param {*} user
   * @returns {User|null} null when it names nobody
   *
   * @example
   * UserInfo.normalize({ id: 42, phone: '+91 98765 43210' }) // { id: '42', email: null, name: null, phone: '+91 98765 43210' }
   */
  static normalize(user) {
    if (user === null || user === undefined) return null;
    if (typeof user !== 'object') return UserInfo.normalize({ id: user });
    let id;
    let email;
    let name;
    let phone;
    try {
      id = firstDefined(user.id, user._id, user.userId);
      email = user.email;
      name = firstDefined(user.name, user.username);
      phone = firstDefined(user.phone, user.phoneNumber, user.phone_number, user.mobile);
    } catch (error) {
      return null;
    }
    const clean = { id: identifier(id), email: label(email, MAX_EMAIL), name: label(name, MAX_NAME), phone: phoneNumber(phone) };
    return clean.id || clean.email || clean.name || clean.phone ? clean : null;
  }

  /**
   * One string that tells users apart: the id, else the email, else the phone, else the name.
   *
   * @param {User|null} user
   * @returns {string|null}
   */
  static key(user) {
    return user ? user.id || user.email || user.phone || user.name || null : null;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

// Strings and numbers as they are; objects (a MongoDB ObjectId) by their own toString().
function identifier(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return label(String(value), MAX_ID);
  if (value && typeof value === 'object') {
    try {
      if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) return label(String(value), MAX_ID);
    } catch (error) {
      return null;
    }
  }
  return null;
}

// As the app wrote it ("+91 98765 43210"); numbers (and bigints) as their digits.
function phoneNumber(value) {
  if (typeof value === 'number' || typeof value === 'bigint') return label(String(value), MAX_PHONE);
  return label(value, MAX_PHONE);
}

function label(value, max) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().slice(0, max);
  return clean || null;
}
