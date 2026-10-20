/**
 * Ingests the spool files apps write when they crash (see src/spool.js): at startup, then every
 * second while the hub runs.
 *
 * A spool file holds an ingest batch ({ project, instance, requests, exceptions }) and is
 * validated exactly like a batch posted to /api/ingest. It is deleted once ingested, and also
 * when it can never be ingested (not JSON, malformed, or filed under another project's folder).
 * The process that wrote it has exited, so it doesn't count as a check-in.
 */

import fs from 'fs';
import path from 'path';
import { CLOUD_FOLDER, Spool } from '../spool.js';
import { IngestPayload } from './ingest-payload.js';
import { PROJECT_ID } from './store.js';

const INTERVAL_MS = 1000;

/**
 * Moves spooled records into the store.
 */
export class SpoolIngester {
  /**
   * @param {Object} options
   * @param {import('./store.js').Store} options.store
   * @param {string} options.dataDir - PeekInside data folder
   * @param {(message: string) => void} [options.log] - Receives a line per file it can't ingest
   * @param {() => void} [options.onIngest] - Called when records were ingested
   */
  constructor({ store, dataDir, log = () => {}, onIngest = () => {} }) {
    this.store = store;
    this.root = Spool.root(dataDir);
    this.log = log;
    this.onIngest = onIngest;
    this.timer = null;
  }

  /**
   * Ingests what is waiting now, then checks every second.
   *
   * @returns {SpoolIngester} This ingester
   */
  start() {
    this.ingest();
    if (!this.timer) {
      this.timer = setInterval(() => this.ingest(), INTERVAL_MS);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
    return this;
  }

  /**
   * Stops checking.
   *
   * @returns {void}
   */
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Ingests every spool file waiting.
   *
   * @returns {{ requests: number, exceptions: number }} Records added
   */
  ingest() {
    const added = { requests: 0, exceptions: 0 };
    let folders;
    try {
      folders = fs.readdirSync(this.root);
    } catch (error) {
      return added;
    }

    for (const folder of folders) {
      // Cloud batches are sealed for PeekInside Cloud; the SDK resends them itself.
      if (folder === CLOUD_FOLDER || !PROJECT_ID.test(folder)) continue;
      const spool = new Spool(path.join(this.root, folder));
      for (const name of spool.list()) {
        try {
          const counts = this._ingestFile(spool, folder, name);
          added.requests += counts.requests;
          added.exceptions += counts.exceptions;
        } catch (error) {
          // The store couldn't write: keep the file and try again next time.
          this.log(`Could not ingest ${path.join(spool.dir, name)}: ${error.message}`);
        }
      }
    }
    if (added.requests || added.exceptions) this.onIngest();
    return added;
  }

  _ingestFile(spool, folder, name) {
    const payload = IngestPayload.parse(spool.read(name));
    if (!payload || payload.project.id !== folder) {
      this.log(`Deleting ${path.join(spool.dir, name)}: not a valid spool file.`);
      spool.remove(name);
      return { requests: 0, exceptions: 0 };
    }
    this.store.ensure(payload.project);
    const requests = this.store.append(payload.project.id, payload.records).length;
    const exceptions = this.store.appendExceptions(payload.project.id, payload.exceptions).length;
    this.store.appendJobs(payload.project.id, payload.jobs);
    this.store.appendLogs(payload.project.id, payload.logs);
    this.store.appendDumps(payload.project.id, payload.dumps);
    spool.remove(name);
    return { requests, exceptions };
  }
}
