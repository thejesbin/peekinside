/**
 * Spool folders: records written to disk by a process that may exit at any moment (it is
 * crashing), for someone else to deliver later.
 *
 *   <data dir>/spool/<project id>/<uuid>.json         Local hub batches ({ project, instance,
 *                                                     requests, exceptions }), which the hub
 *                                                     ingests at startup and every second
 *   <data dir>/spool/cloud/<project id>/<uuid>.json   Sealed PeekInside Cloud batches, which the
 *                                                     SDK resends when the app starts again
 *
 * Writing is synchronous and atomic (a temporary file, then a rename), so a reader never sees half
 * a file. Folders are private to the user (0700, files 0600), like the rest of the data folder.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// The "project" folder that holds cloud batches; local project ids always contain a dash.
export const CLOUD_FOLDER = 'cloud';
// A temporary file this old was left by a writer that died mid-write.
const STALE_TEMP_MS = 60_000;
// Most files, and bytes, one folder keeps: past either, the oldest files go. An app that crashes
// in a loop while its destination is down can't fill the disk.
const MAX_FILES = 100;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * One spool folder.
 */
export class Spool {
  /**
   * The folder of a local hub project.
   *
   * @param {string} dataDir
   * @param {string} projectId
   * @returns {Spool}
   */
  static local(dataDir, projectId) {
    return new Spool(path.join(Spool.root(dataDir), projectId));
  }

  /**
   * The folder of a PeekInside Cloud project.
   *
   * @param {string} dataDir
   * @param {string} projectId
   * @returns {Spool}
   */
  static cloud(dataDir, projectId) {
    return new Spool(path.join(Spool.root(dataDir), CLOUD_FOLDER, projectId));
  }

  /**
   * @param {string} dataDir
   * @returns {string} The folder that holds every spool folder
   */
  static root(dataDir) {
    return path.join(dataDir, 'spool');
  }

  /**
   * @param {string} dir
   */
  constructor(dir) {
    this.dir = dir;
  }

  /**
   * Writes one file, synchronously.
   *
   * @param {*} content - Saved as JSON
   * @returns {string} The file's name
   * @throws {Error} When the folder can't be written (callers decide whether that matters)
   */
  write(content) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.json`;
    const file = path.join(this.dir, name);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(content), { mode: 0o600 });
    fs.renameSync(temp, file);
    this._prune(name);
    return name;
  }

  // Deletes the oldest waiting files beyond MAX_FILES or MAX_BYTES, never the one just written.
  _prune(keep) {
    try {
      const files = [];
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const stat = fs.statSync(path.join(this.dir, name));
        files.push({ name, at: stat.mtimeMs, size: stat.size });
      }
      if (files.length <= MAX_FILES && files.reduce((total, file) => total + file.size, 0) <= MAX_BYTES) return;
      files.sort((a, b) => (a.name === keep ? -1 : b.name === keep ? 1 : b.at - a.at));
      let total = 0;
      files.forEach((file, index) => {
        total += file.size;
        if (file.name !== keep && (index >= MAX_FILES || total > MAX_BYTES)) fs.rmSync(path.join(this.dir, file.name), { force: true });
      });
    } catch (error) {
      // Pruning is housekeeping: a folder that can't be read is left as it is.
    }
  }

  /**
   * The files waiting, oldest first. Files older than `maxAgeMs` are deleted instead, as are
   * temporary files left by writers that died.
   *
   * @param {Object} [options]
   * @param {number} [options.maxAgeMs=Infinity]
   * @returns {string[]} File names
   */
  list({ maxAgeMs = Infinity } = {}) {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (error) {
      return [];
    }

    const now = Date.now();
    const files = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        continue;
      }
      if (!stat.isFile()) continue;

      if (name.endsWith('.tmp')) {
        if (now - stat.mtimeMs > STALE_TEMP_MS) fs.rmSync(file, { force: true });
        continue;
      }
      const claimed = /^(.+\.json)\.(\d+)\.sending$/.exec(name);
      if (claimed) {
        // A process that died while sending: the file is up for grabs again.
        if (!isRunning(Number(claimed[2])) && this._rename(name, claimed[1])) files.push({ name: claimed[1], at: stat.mtimeMs });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      files.push({ name, at: stat.mtimeMs });
    }
    return files.sort((a, b) => a.at - b.at).map((entry) => entry.name);
  }

  /**
   * Reads a file.
   *
   * @param {string} name
   * @returns {*} The parsed content, or undefined when it is missing or not JSON
   */
  read(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Deletes a file.
   *
   * @param {string} name
   * @returns {void}
   */
  remove(name) {
    fs.rmSync(path.join(this.dir, name), { force: true });
  }

  /**
   * Claims a file for this process, so that processes starting together (cluster workers) don't
   * send it twice: the rename succeeds for one of them only.
   *
   * @param {string} name - From list()
   * @returns {string|null} The claimed file's name, or null when another process has it
   */
  claim(name) {
    const claimed = `${name}.${process.pid}.sending`;
    return this._rename(name, claimed) ? claimed : null;
  }

  /**
   * Gives a claimed file back, to be sent another time.
   *
   * @param {string} claimed - From claim()
   * @returns {void}
   */
  release(claimed) {
    this._rename(claimed, claimed.replace(/\.\d+\.sending$/, ''));
  }

  _rename(from, to) {
    try {
      fs.renameSync(path.join(this.dir, from), path.join(this.dir, to));
      return true;
    } catch (error) {
      return false;
    }
  }
}

// A process that exists but belongs to another user (EPERM) is running too.
function isRunning(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
