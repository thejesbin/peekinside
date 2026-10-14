/**
 * End-to-end encryption for PeekInside Cloud, format v1.
 *
 * Mirrors the dashboard's implementation: ephemeral ECDH P-256, HKDF-SHA-256 and AES-256-GCM,
 * all from Node's Web Crypto. Events are sealed to the project's public key, so only browsers
 * holding the project's private key can read them; this process can encrypt but never decrypt.
 *
 * Output: "v1.<ephemeral public key>.<iv>.<ciphertext>" (base64url parts). Any change here must
 * stay byte-compatible with the dashboard, or existing projects can no longer read their events.
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes, webcrypto } from 'crypto';

const subtle = webcrypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const encoder = new TextEncoder();

const PROJECT_ID = /^p[0-9a-z]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string} Base64url without padding
 */
export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * @param {string} text - Base64url
 * @returns {Uint8Array}
 */
export function fromBase64Url(text) {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/**
 * Encrypts messages to one recipient public key, with one ephemeral key pair.
 *
 * The key agreement is the expensive part, so one sealer serves a whole batch: each message
 * still gets its own random IV. Create a new sealer per batch, so ephemeral keys are not reused
 * for long.
 */
export class Sealer {
  /**
   * Use Sealer.create(): the key agreement is asynchronous.
   *
   * @param {CryptoKey} key - AES-256-GCM key derived for this sealer
   * @param {Uint8Array} ephemeralPublicKey - Raw ephemeral public key, sent with every message so
   *   the recipient can derive the same key
   */
  constructor(key, ephemeralPublicKey) {
    this._key = key;
    this._prefix = `v1.${toBase64Url(ephemeralPublicKey)}.`;
  }

  /**
   * Agrees on a key with the recipient: ECDH with a fresh ephemeral key, then HKDF-SHA-256 with
   * both public keys as salt and "peekinside/v1/<purpose>" as info, so keys derived for one
   * purpose never decrypt another.
   *
   * @param {string} recipientPublicKey - Project public key (base64url, uncompressed P-256 point)
   * @param {string} purpose - "event"
   * @returns {Promise<Sealer>}
   */
  static async create(recipientPublicKey, purpose) {
    const recipientRaw = fromBase64Url(recipientPublicKey);
    const recipient = await subtle.importKey('raw', recipientRaw, ECDH, false, []);
    const ephemeral = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const ephemeralRaw = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));

    const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256);
    const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const salt = new Uint8Array(ephemeralRaw.length + recipientRaw.length);
    salt.set(ephemeralRaw, 0);
    salt.set(recipientRaw, ephemeralRaw.length);
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`peekinside/v1/${purpose}`) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    return new Sealer(key, ephemeralRaw);
  }

  /**
   * Encrypts one message with AES-256-GCM and a random 12-byte IV.
   *
   * @param {string|Uint8Array} plaintext
   * @param {string} aad - Additional authenticated data, such as "detail:<request id>": decryption
   *   fails unless the reader expects the same value, which binds the message to its context
   * @returns {Promise<string>} "v1.<ephemeral public key>.<iv>.<ciphertext>"
   */
  async seal(plaintext, aad) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const data = typeof plaintext === 'string' ? encoder.encode(plaintext) : plaintext;
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, this._key, data);
    return `${this._prefix}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
  }
}

/**
 * Sealer for a process that is crashing: the same key agreement and format as Sealer, but
 * synchronous (node:crypto instead of Web Crypto), because nothing asynchronous runs once the
 * process has started to exit.
 *
 * ECDH on P-256 yields the x-coordinate of the shared point in both APIs, HKDF and AES-GCM are the
 * same algorithms, and Web Crypto appends the 16-byte GCM tag to the ciphertext: output is
 * interchangeable with Sealer's, and opens with the dashboard's Opener.
 */
export class SyncSealer {
  /**
   * Use SyncSealer.create().
   *
   * @param {Buffer} key - AES-256-GCM key derived for this sealer
   * @param {Buffer} ephemeralPublicKey - Raw (uncompressed) ephemeral public key
   */
  constructor(key, ephemeralPublicKey) {
    this._key = key;
    this._prefix = `v1.${toBase64Url(ephemeralPublicKey)}.`;
  }

  /**
   * Agrees on a key with the recipient, exactly like Sealer.create().
   *
   * @param {string} recipientPublicKey - Project public key (base64url, uncompressed P-256 point)
   * @param {string} purpose - "event"
   * @returns {SyncSealer}
   * @throws {Error} When the public key is not a valid P-256 point
   */
  static create(recipientPublicKey, purpose) {
    const recipientRaw = Buffer.from(recipientPublicKey, 'base64url');
    const ecdh = createECDH('prime256v1');
    const ephemeralRaw = ecdh.generateKeys();
    const shared = ecdh.computeSecret(recipientRaw);
    const salt = Buffer.concat([ephemeralRaw, recipientRaw]);
    const key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`peekinside/v1/${purpose}`), 32));
    return new SyncSealer(key, ephemeralRaw);
  }

  /**
   * Encrypts one message with AES-256-GCM and a random 12-byte IV.
   *
   * @param {string|Uint8Array} plaintext
   * @param {string} aad - Additional authenticated data (see Sealer#seal())
   * @returns {string} "v1.<ephemeral public key>.<iv>.<ciphertext and tag>"
   */
  seal(plaintext, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this._key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    return `${this._prefix}${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
  }
}

/**
 * A PeekInside Cloud API key: "pik1.<projectId>.<secret>.<projectPublicKey>".
 *
 * The secret authorizes sending events; the public key lets the SDK encrypt them. The key never
 * contains anything that can decrypt events.
 */
export class ApiKey {
  /**
   * @param {Object} parts
   * @param {string} parts.projectId - Project id, such as "p0123456789ab"
   * @param {string} parts.secret - Ingest secret (base64url)
   * @param {string} parts.publicKey - Project public key (base64url, uncompressed P-256 point)
   */
  constructor({ projectId, secret, publicKey }) {
    this.projectId = projectId;
    this.secret = secret;
    this.publicKey = publicKey;
  }

  /**
   * @param {string} apiKey
   * @returns {ApiKey|null} The key's parts, or null when it isn't a well-formed v1 key
   */
  static parse(apiKey) {
    const [version, projectId, secret, publicKey, ...rest] = String(apiKey).trim().split('.');
    if (version !== 'pik1' || rest.length) return null;
    if (!PROJECT_ID.test(projectId) || !SECRET.test(secret) || !PUBLIC_KEY.test(publicKey)) return null;
    return new ApiKey({ projectId, secret, publicKey });
  }
}
