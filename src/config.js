/**
 * Settings shared by the SDK, the local hub and the CLI: product constants, and the environment
 * variables that decide where requests go.
 *
 * Environment variables are read each time a setting is used, never cached, so a process (or a
 * test) can change them at runtime.
 *
 *   PEEKINSIDE_URL           Base URL of the PeekInside site: cloud ingest and the dashboard interface
 *                            (default https://peekinside.dev). Change it when developing the dashboard.
 *   PEEKINSIDE_HOME          Folder for local data (default ~/.peekinside)
 *   PEEKINSIDE_HUB_PORT      Port of the local dashboard (default 7335)
 *   PEEKINSIDE_MAX_REQUESTS  Requests the local dashboard keeps per project (default 1000)
 *   PEEKINSIDE_MAX_EXCEPTIONS  Exceptions the local dashboard keeps per project (default 500)
 *   PEEKINSIDE_API_KEY       PeekInside Cloud API key; turns on cloud mode
 *   PEEKINSIDE_ENV           Environment label (falls back to NODE_ENV)
 *   PEEKINSIDE_PROJECT       Project name in the local dashboard
 *   PEEKINSIDE_LOCAL         1 or 0 to force the local dashboard on or off
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const PRODUCT_NAME = 'PeekInside';
export const LOG_PREFIX = '[peekinside]';
export const DEFAULT_SITE_URL = 'https://peekinside.dev';
// "PEEK" on a phone keypad
export const DEFAULT_HUB_PORT = 7335;
// Bumped only for breaking changes to the hub's HTTP API; the dashboard interface is versioned with it.
export const HUB_API_VERSION = 1;
export const HUB_APP_ID = 'peekinside-hub';

export const VERSION = readPackageVersion();

const TRUE_FLAGS = ['1', 'true', 'yes', 'on'];
const FALSE_FLAGS = ['0', 'false', 'no', 'off'];

/**
 * Reads PeekInside's settings from environment variables.
 *
 * Every method reads the variables again, so changes made after startup apply.
 */
export class Settings {
  /**
   * @param {Object<string, string>} [env] - Variables to read. By default process.env, looked up on
   *   every read.
   */
  constructor(env = null) {
    this._env = env;
  }

  /**
   * The variables settings are read from.
   *
   * @type {Object<string, string>}
   */
  get env() {
    return this._env || process.env;
  }

  /**
   * Origin of the PeekInside site, which hosts cloud ingest and the dashboard interface.
   * An invalid PEEKINSIDE_URL is reported and ignored, so a typo can't send data elsewhere.
   *
   * @returns {string} Origin such as "https://peekinside.dev"
   */
  siteUrl() {
    const value = this.env.PEEKINSIDE_URL;
    if (!value) return DEFAULT_SITE_URL;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch (error) {
      // Fall through to the default.
    }
    console.warn(`${LOG_PREFIX} Ignoring PEEKINSIDE_URL: "${value}" is not an http(s) URL`);
    return DEFAULT_SITE_URL;
  }

  /**
   * Folder of the local dashboard's data.
   *
   * @returns {string} Absolute path
   */
  dataDir() {
    return path.resolve(this.env.PEEKINSIDE_HOME || path.join(os.homedir(), '.peekinside'));
  }

  /**
   * Port of the local dashboard; invalid values fall back to the default.
   *
   * @returns {number}
   */
  hubPort() {
    const port = Number(this.env.PEEKINSIDE_HUB_PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HUB_PORT;
  }

  /**
   * Address of the local dashboard, as shown to people.
   *
   * @param {number} [port] - Hub port (default: hubPort())
   * @returns {string}
   */
  hubUrl(port = this.hubPort()) {
    return `http://localhost:${port}`;
  }

  /**
   * Requests the local dashboard keeps per project.
   *
   * @returns {number|undefined} The configured number, or undefined for the store's default
   */
  maxRequests() {
    return Number(this.env.PEEKINSIDE_MAX_REQUESTS) || undefined;
  }

  /**
   * Exceptions the local dashboard keeps per project.
   *
   * @returns {number|undefined} The configured number, or undefined for the store's default
   */
  maxExceptions() {
    return Number(this.env.PEEKINSIDE_MAX_EXCEPTIONS) || undefined;
  }

  /**
   * @returns {string|undefined} PeekInside Cloud API key
   */
  apiKey() {
    return this.env.PEEKINSIDE_API_KEY;
  }

  /**
   * @returns {string|undefined} Environment label: PEEKINSIDE_ENV, then NODE_ENV
   */
  environment() {
    return this.env.PEEKINSIDE_ENV || this.env.NODE_ENV;
  }

  /**
   * @returns {string|undefined} Project name chosen for the local dashboard
   */
  projectName() {
    return this.env.PEEKINSIDE_PROJECT;
  }

  /**
   * Whether the free local dashboard is on when the app doesn't decide. It is for development,
   * so it is off in production, in tests and in CI, unless PEEKINSIDE_LOCAL says otherwise.
   *
   * @returns {boolean}
   */
  localMode() {
    const flag = String(this.env.PEEKINSIDE_LOCAL || '').trim().toLowerCase();
    if (TRUE_FLAGS.includes(flag)) return true;
    if (FALSE_FLAGS.includes(flag)) return false;

    const ci = String(this.env.CI || '').toLowerCase();
    const inCi = ci !== '' && ci !== '0' && ci !== 'false';
    return this.env.NODE_ENV !== 'production' && this.env.NODE_ENV !== 'test' && !inCi;
  }

  /**
   * @returns {boolean} Whether NODE_ENV is "production"
   */
  isProduction() {
    return this.env.NODE_ENV === 'production';
  }
}

/** Settings read from process.env, shared by every module. */
export const settings = new Settings();

function readPackageVersion() {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || '';
  } catch (error) {
    return '';
  }
}
