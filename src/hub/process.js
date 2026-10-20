/**
 * The local hub process: one per machine, shared by every app that uses PeekInside.
 *
 * Apps start it in the background when they need it (HubClient#spawn() runs entry.js), or
 * people run `npx peekinside`. It stops by itself after an hour without apps or open
 * dashboards; the data stays on disk.
 */

import fs from 'fs';
import path from 'path';
import { VERSION, settings } from '../config.js';
import { HubClient } from './client.js';
import { HubServer } from './server.js';
import { SpoolIngester } from './spool-ingester.js';
import { Store } from './store.js';

const IDLE_MS = 60 * 60 * 1000;
const PERSIST_MS = 60 * 1000;

/**
 * Runs the hub in this process: loads the store, serves the API, ingests what crashed apps
 * spooled, saves metadata every minute, and stops when idle or signalled.
 *
 * hub.json in the data folder says which process runs the hub, on which port, so a second hub
 * never writes to the same folder.
 */
export class HubProcess {
  /**
   * Nothing is read or started until run(), so failures surface from run() as rejections.
   */
  constructor() {
    this.dataDir = null;
    this.port = null;
    this.infoFile = null;
    this.store = null;
    this.server = null;
    this.spool = null;
    this.lastActivity = 0;
    this.stopping = false;
  }

  /**
   * Starts the hub with the current settings. Exits the process when this hub can't run: with
   * status 1 when another hub uses the data folder or another program holds the port, and with
   * status 0 when a hub already serves the port.
   *
   * @returns {Promise<void>} Resolves once startup has begun; the hub keeps running afterwards
   */
  async run() {
    this.dataDir = settings.dataDir();
    this.port = settings.hubPort();
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.infoFile = path.join(this.dataDir, 'hub.json');

    // Two hubs must never write to the same folder.
    const other = this._readInfo();
    if (other && other.pid !== process.pid && isRunning(other.pid) && other.port !== this.port) {
      console.error(`${timestamp()} Another PeekInside hub (pid ${other.pid}) uses ${this.dataDir} on port ${other.port}. Stop it first (npx peekinside stop).`);
      process.exit(1);
    }

    this.store = new Store(this.dataDir, { maxRequests: settings.maxRequests(), maxExceptions: settings.maxExceptions() }).load();
    this.lastActivity = Date.now();
    // Crashes recorded while no hub ran are waiting in the spool folder; more arrive while it runs.
    // Ingesting writes to the store, so it starts once this hub owns the port: a hub that loses
    // the race for it exits without touching the data.
    this.spool = new SpoolIngester({
      store: this.store,
      dataDir: this.dataDir,
      log: (message) => console.error(`${timestamp()} ${message}`),
      onIngest: () => {
        this.lastActivity = Date.now();
      }
    });
    this.server = new HubServer({
      store: this.store,
      port: this.port,
      siteUrl: settings.siteUrl(),
      version: VERSION,
      dataDir: this.dataDir,
      onActivity: () => {
        this.lastActivity = Date.now();
      }
    });

    this.server.httpServer.on('error', (error) => this._onServerError(error));
    this.server.listen(() => {
      this._writeInfo({ pid: process.pid, port: this.port, version: VERSION, startedAt: Date.now() });
      this.spool.start();
      console.log(`${timestamp()} PeekInside Local ${VERSION} on ${settings.hubUrl(this.port)} · data in ${this.dataDir} · ${this.store.size} project(s)`);
    });

    setInterval(() => {
      this._persist();
      if (Date.now() - this.lastActivity > IDLE_MS) this.stop('idle for an hour');
    }, PERSIST_MS);

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('SIGHUP', () => this.stop('SIGHUP'));
  }

  /**
   * Saves metadata, releases hub.json and exits shortly after.
   *
   * @param {string} reason - Logged, such as "SIGTERM"
   * @returns {void}
   */
  stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    console.log(`${timestamp()} Stopping (${reason}).`);
    this.spool.stop();
    this._persist();
    // Only the hub that wrote hub.json removes it.
    const info = this._readInfo();
    if (info && info.pid === process.pid) fs.rmSync(this.infoFile, { force: true });
    this.server.close();
    setTimeout(() => process.exit(0), 200).unref();
  }

  // The port is taken: by another hub (a race between two apps starting it), which is fine, or by
  // another program, which isn't.
  async _onServerError(error) {
    if (error.code === 'EADDRINUSE') {
      const running = await new HubClient(this.port).status().catch(() => null);
      if (running) {
        console.log(`${timestamp()} Already running on ${settings.hubUrl(this.port)} (pid ${running.pid}).`);
        process.exit(0);
      }
      console.error(`${timestamp()} Port ${this.port} is used by another program. Set PEEKINSIDE_HUB_PORT to use a different port.`);
    } else {
      console.error(`${timestamp()} ${error.message}`);
    }
    process.exit(1);
  }

  _persist() {
    try {
      this.store.persist();
    } catch (error) {
      console.error(`${timestamp()} Could not save project data: ${error.message}`);
    }
  }

  _readInfo() {
    try {
      const info = JSON.parse(fs.readFileSync(this.infoFile, 'utf8'));
      return Number.isInteger(info.pid) ? info : null;
    } catch (error) {
      return null;
    }
  }

  // Written to a temporary file first, so readers never see half a file.
  _writeInfo(info) {
    const temp = `${this.infoFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.infoFile);
  }
}

// A process that exists but belongs to another user (EPERM) is running too.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function timestamp() {
  return new Date().toISOString();
}
