/**
 * End-to-end encryption for PeekInside Cloud, format v1.
 *
 * Mirrors the dashboard's implementation: ephemeral ECDH P-256, HKDF-SHA-256 and AES-256-GCM,
 * all from Node's Web Crypto. Events are sealed to the project's public key, so only browsers
 * holding the project's private key can read them; apps encrypt but never decrypt.
 *
 * The one exception is `npx peekinside mcp` with an MCP key (see McpKey): the key unwraps the
 * project's private key on the developer's machine, so their AI tools can read the project there.
 *
 * Output: "v1.<ephemeral public key>.<iv>.<ciphertext>" (base64url parts). Any change here must
 * stay byte-compatible with the dashboard, or existing projects can no longer read their events.
 */

import { createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, webcrypto } from 'crypto';

const subtle = webcrypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const encoder = new TextEncoder();

const PROJECT_ID = /^p[0-9a-z]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;
const MCP_KEY_ID = /^m[0-9a-z]{16}$/;
// A project key wrapped for an MCP key: "m1.<iv>.<ciphertext and tag>".
const MCP_WRAP = /^m1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{24,})$/;
// Ephemeral keys an Opener remembers the agreed key of.
const MAX_OPENER_KEYS = 2000;

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
   * @param {string} apiKey - Surrounding spaces and quotes are ignored (env files that keep them)
   * @returns {ApiKey|null} The key's parts, or null when it isn't a well-formed v1 key
   */
  static parse(apiKey) {
    const [version, projectId, secret, publicKey, ...rest] = ApiKey.unquote(apiKey).split('.');
    if (version !== 'pik1' || rest.length) return null;
    if (!PROJECT_ID.test(projectId) || !SECRET.test(secret) || !PUBLIC_KEY.test(publicKey)) return null;
    return new ApiKey({ projectId, secret, publicKey });
  }

  /**
   * What's wrong with a value that isn't an API key, in words for the app's log. Never repeats the
   * value: it may hold a secret.
   *
   * @param {string} value
   * @returns {string} A sentence without its final period
   */
  static problem(value) {
    const text = ApiKey.unquote(value);
    if (PUBLIC_KEY.test(text) && Buffer.from(text, 'base64url')[0] === 4) {
      return 'PEEKINSIDE_API_KEY holds your project\'s public key, not an API key. API keys start with "pik1.": create one in PeekInside Cloud, on the project\'s Settings page under API keys';
    }
    if (!text.startsWith('pik1.')) {
      return 'PEEKINSIDE_API_KEY is not a PeekInside API key (those start with "pik1."). Create one in PeekInside Cloud, on the project\'s Settings page under API keys';
    }
    return 'PEEKINSIDE_API_KEY looks cut off or changed: copy the whole key, from "pik1." to its end';
  }

  // Without the spaces and one pair of matching quotes around it.
  static unquote(value) {
    const text = String(value).trim();
    return /^(["'`]).*\1$/s.test(text) && text.length > 1 ? text.slice(1, -1).trim() : text;
  }
}

/** A ciphertext that doesn't open: wrong key, wrong record, wrong purpose, or tampered with. */
export class DecryptionError extends Error {
  constructor(message = "Couldn't decrypt") {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Decrypts what was sealed to one key pair, for one purpose: the dashboard's Opener. The key agreed
 * with each ephemeral key is cached, so a batch sealed together costs one key agreement.
 */
export class Opener {
  /**
   * @param {CryptoKey} privateKey - The recipient's private key (ECDH P-256)
   * @param {string} publicKey - Its public key (base64url, uncompressed point): part of every
   *   message key
   * @param {string} purpose - "event"
   */
  constructor(privateKey, publicKey, purpose) {
    this._privateKey = privateKey;
    this._recipient = fromBase64Url(publicKey);
    this._purpose = purpose;
    this._keys = new Map();
  }

  /**
   * @param {string} sealed - "v1.<ephemeral public key>.<iv>.<ciphertext>"
   * @param {string} aad - What it was sealed with, such as "detail:<request id>"
   * @returns {Promise<Uint8Array>}
   * @throws {DecryptionError}
   */
  async open(sealed, aad) {
    const parts = typeof sealed === 'string' ? sealed.split('.') : [];
    if (parts.length !== 4 || parts[0] !== 'v1') throw new DecryptionError('Unsupported ciphertext format');
    try {
      const plaintext = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(parts[2]), additionalData: encoder.encode(aad) },
        await this._keyFor(parts[1]),
        fromBase64Url(parts[3])
      );
      return new Uint8Array(plaintext);
    } catch (error) {
      throw new DecryptionError();
    }
  }

  /**
   * @param {string} sealed
   * @param {string} aad
   * @returns {Promise<*>} The parsed JSON
   * @throws {DecryptionError}
   */
  async openJson(sealed, aad) {
    const bytes = await this.open(sealed, aad);
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      throw new DecryptionError('Not JSON');
    }
  }

  _keyFor(ephemeral) {
    let key = this._keys.get(ephemeral);
    if (!key) {
      key = (async () => {
        const ephemeralRaw = fromBase64Url(ephemeral);
        const ephemeralPublic = await subtle.importKey('raw', ephemeralRaw, ECDH, false, []);
        const shared = await subtle.deriveBits({ name: 'ECDH', public: ephemeralPublic }, this._privateKey, 256);
        const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        const salt = new Uint8Array(ephemeralRaw.length + this._recipient.length);
        salt.set(ephemeralRaw, 0);
        salt.set(this._recipient, ephemeralRaw.length);
        return subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`peekinside/v1/${this._purpose}`) },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
      })();
      key.catch(() => this._keys.delete(ephemeral));
      this._keys.set(ephemeral, key);
      if (this._keys.size > MAX_OPENER_KEYS) this._keys.delete(this._keys.keys().next().value);
    }
    return key;
  }
}

/**
 * An MCP key: what `npx peekinside mcp` needs to read one PeekInside Cloud project for a member's
 * AI tools, as "pim1.<projectId>.<keyId>.<secret>". A browser of the member makes it, and it's
 * shown once. Mirrors the dashboard's McpKeys (e2ee.ts).
 *
 * The secret never reaches the server. Two keys are derived from it with HKDF-SHA-256: a proof,
 * which the API checks against the hash it stores, and a wrapping key, with which the browser
 * wrapped the project's private key (AES-256-GCM, bound to the project and the key's id). The API
 * hands out the wrapped key, and only the holder of the secret can unwrap it, so records are still
 * decrypted on the member's machine only.
 */
export class McpKey {
  /**
   * @param {Object} parts
   * @param {string} parts.projectId - Project id, such as "p0123456789ab"
   * @param {string} parts.keyId - Such as "m0123456789abcdef"
   * @param {string} parts.secret - 32 random bytes, base64url
   */
  constructor({ projectId, keyId, secret }) {
    this.projectId = projectId;
    this.keyId = keyId;
    this.secret = secret;
  }

  /**
   * @param {string} value - Surrounding spaces and quotes are ignored
   * @returns {McpKey|null} null when it isn't a well-formed v1 key
   */
  static parse(value) {
    const [version, projectId, keyId, secret, ...rest] = ApiKey.unquote(value).split('.');
    if (version !== 'pim1' || rest.length) return null;
    if (!PROJECT_ID.test(projectId) || !MCP_KEY_ID.test(keyId) || !SECRET.test(secret)) return null;
    return new McpKey({ projectId, keyId, secret });
  }

  /**
   * What's wrong with a value that isn't an MCP key, in words. Never repeats the value.
   *
   * @param {string} value
   * @returns {string}
   */
  static problem(value) {
    const text = ApiKey.unquote(value);
    if (text.startsWith('pik1.')) {
      return 'PEEKINSIDE_MCP_KEY holds an API key, which can only send data. Make an MCP key in PeekInside Cloud, on the project\'s Settings page under AI tools (MCP).';
    }
    if (!text.startsWith('pim1.')) return 'PEEKINSIDE_MCP_KEY is not a PeekInside MCP key (those start with "pim1."). Make one in PeekInside Cloud, on the project\'s Settings page under AI tools (MCP).';
    return 'PEEKINSIDE_MCP_KEY looks cut off or changed: copy the whole key, from "pim1." to its end.';
  }

  /**
   * What the API checks: "pim1.<keyId>.<proof>", sent as a bearer token.
   *
   * @returns {string}
   */
  bearer() {
    return `pim1.${this.keyId}.${toBase64Url(this._derive('peekinside/v1/mcp-proof'))}`;
  }

  /**
   * Unwraps the project's private key, and works out its public key from it (rather than trusting
   * the server's).
   *
   * @param {string} wrapped - "m1.<iv>.<ciphertext>", as the API hands it out
   * @returns {Promise<{ privateKey: CryptoKey, publicKey: string }>}
   * @throws {DecryptionError} When this key's secret doesn't open it
   */
  async unwrap(wrapped) {
    const match = MCP_WRAP.exec(String(wrapped || ''));
    if (!match) throw new DecryptionError('Unsupported key format');
    const sealed = Buffer.from(match[2], 'base64url');
    if (sealed.length <= 16) throw new DecryptionError('Unsupported key format');
    let pkcs8;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this._derive('peekinside/v1/mcp-key'), Buffer.from(match[1], 'base64url'));
      decipher.setAAD(Buffer.from(McpKey.aad(this.projectId, this.keyId), 'utf8'));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      pkcs8 = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    } catch (error) {
      throw new DecryptionError("This MCP key doesn't open the project's key");
    }
    try {
      const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
      if (jwk.crv !== 'P-256') throw new Error('Not P-256');
      const publicKey = toBase64Url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
      const privateKey = await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
      return { privateKey, publicKey };
    } catch (error) {
      throw new DecryptionError("The project's key couldn't be read");
    } finally {
      pkcs8.fill(0);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} keyId
   * @returns {string} The additional authenticated data of a wrapped project key
   */
  static aad(projectId, keyId) {
    return `mcp:${projectId}:${keyId}`;
  }

  /**
   * The SHA-256 of a proof, hex: what the API stores.
   *
   * @param {string} proof
   * @returns {string}
   */
  static proofHash(proof) {
    return createHash('sha256').update(proof).digest('hex');
  }

  _derive(info) {
    return Buffer.from(hkdfSync('sha256', Buffer.from(this.secret, 'base64url'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
  }
}
