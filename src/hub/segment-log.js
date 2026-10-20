/**
 * An append-only log of records in one folder, kept in segment files:
 *
 *   00000001.jsonl    details, one JSON object per line
 *   00000001.idx      one summary per line, with the offset and length of its detail line
 *
 * Summaries are kept in memory, so lists never touch the disk; details are read on demand. The log
 * keeps its newest `maxEntries` records: files rotate in segments, and the oldest segment is
 * deleted once the rest still holds `maxEntries`. Deleting whole files keeps retention cheap:
 * nothing is ever rewritten.
 *
 * Every record gets a sequence number. Numbers keep increasing after the log is cleared (the
 * caller stores `seqBase`), so dashboards that poll with `after` stay in step.
 *
 * A project's requests and its exceptions are two such logs (see ProjectLog).
 */

import fs from 'fs';
import path from 'path';

const SEGMENT_INDEX = /^(\d{8})\.idx$/;

/**
 * One log of records with summaries and details.
 */
export class SegmentLog {
  /**
   * Use SegmentLog.load() for a log that may have files already.
   *
   * @param {string} dir - The log's folder; created on the first append
   * @param {Object} options
   * @param {number} options.maxEntries - Records kept
   * @param {number} options.segmentSize - Records per segment file
   * @param {number} options.seqBase - Lowest sequence number the next record may get
   * @param {(source: Object) => Object} options.pick - The summary of a record or index entry:
   *   only known fields, in a fixed order (index lines and API answers never carry anything else)
   */
  constructor(dir, { maxEntries, segmentSize, seqBase, pick }) {
    this.dir = dir;
    this.maxEntries = maxEntries;
    this.segmentSize = segmentSize;
    this.pick = pick;
    // Summaries with their place on disk (seg, off, len), oldest first, sorted by seq.
    this.entries = [];
    this.byId = new Map();
    // Numbers of the segment files on disk, oldest first, and the one being written.
    this.segments = [];
    this.segment = { no: 1, count: 0, size: 0 };
    this.seqBase = seqBase;
    this.nextSeq = seqBase;
  }

  /**
   * Reads a log from its folder. Index lines cut short by a crash are skipped; a missing folder is
   * an empty log.
   *
   * @param {string} dir
   * @param {Object} options - See the constructor
   * @returns {SegmentLog}
   */
  static load(dir, options) {
    const log = new SegmentLog(dir, options);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return log;
      throw error;
    }

    log.segments = names
      .map((name) => SEGMENT_INDEX.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);

    let maxSeq = 0;
    for (const no of log.segments) {
      const lines = fs.readFileSync(log._segmentFile(no, 'idx'), 'utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          continue; // a line cut short by a crash
        }
        if (!entry || typeof entry.id !== 'string' || !Number.isInteger(entry.seq) || log.byId.has(entry.id)) continue;
        entry.seg = no;
        log.entries.push(entry);
        log.byId.set(entry.id, entry);
        maxSeq = Math.max(maxSeq, entry.seq);
      }
    }
    log.entries.sort((a, b) => a.seq - b.seq);
    log.nextSeq = Math.max(log.seqBase, maxSeq + 1);

    const last = log.segments[log.segments.length - 1];
    if (last) {
      let size = 0;
      try {
        size = fs.statSync(log._segmentFile(last, 'jsonl')).size;
      } catch (error) {
        size = 0;
      }
      log.segment = { no: last, count: log.entries.filter((entry) => entry.seg === last).length, size };
    }
    return log;
  }

  /**
   * Number of records kept.
   *
   * @type {number}
   */
  get size() {
    return this.entries.length;
  }

  /**
   * The newest record's summary entry, or null.
   *
   * @type {Object|null}
   */
  get newest() {
    return this.entries[this.entries.length - 1] || null;
  }

  /**
   * Stores new records. Records already stored (same id) are skipped, so retried batches are
   * harmless.
   *
   * @param {Object[]} records - Validated records: summary fields plus `detail`
   * @returns {Object[]} Summaries of the stored records
   */
  append(records) {
    const added = [];
    let data = [];
    let index = [];
    // One write per file and segment, rather than one per record.
    const write = () => {
      if (!data.length) return;
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this._segmentFile(this.segment.no, 'jsonl'), data.join(''), { mode: 0o600 });
      fs.appendFileSync(this._segmentFile(this.segment.no, 'idx'), index.join(''), { mode: 0o600 });
      if (!this.segments.includes(this.segment.no)) this.segments.push(this.segment.no);
      data = [];
      index = [];
    };

    for (const record of records) {
      if (this.byId.has(record.id)) continue;
      if (this.segment.count >= this.segmentSize) {
        write();
        this.segment = { no: this.segment.no + 1, count: 0, size: 0 };
      }

      const line = JSON.stringify(record.detail ?? {});
      const length = Buffer.byteLength(line);
      const entry = {
        ...this.pick({ ...record, seq: this.nextSeq++ }),
        seg: this.segment.no,
        off: this.segment.size,
        len: length
      };
      this.segment.size += length + 1;
      this.segment.count++;
      data.push(`${line}\n`);
      index.push(`${JSON.stringify(entry)}\n`);
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      added.push(this.pick(entry));
    }

    write();
    this.enforceRetention();
    return added;
  }

  /**
   * Summaries, newest first; oldest first when `after` is given (for polling new records).
   *
   * @param {{ after?: number, before?: number, limit: number }} query - Sequence numbers to page by
   * @returns {{ entries: Object[], hasMore: boolean }}
   */
  list({ after, before, limit }) {
    const entries = this.entries;

    if (after !== undefined) {
      const start = firstIndex(entries, (entry) => entry.seq > after);
      return {
        entries: entries.slice(start, start + limit).map(this.pick),
        hasMore: start + limit < entries.length
      };
    }

    const end = before === undefined ? entries.length : firstIndex(entries, (entry) => entry.seq >= before);
    const start = Math.max(0, end - limit);
    return {
      entries: entries.slice(start, end).reverse().map(this.pick),
      hasMore: start > 0
    };
  }

  /**
   * The detail of one record, read from disk.
   *
   * @param {string} id
   * @returns {Object|null} null when it is no longer stored
   */
  detail(id) {
    const entry = this.byId.get(id);
    if (!entry) return null;

    let fd;
    try {
      fd = fs.openSync(this._segmentFile(entry.seg, 'jsonl'), 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(entry.len);
      const read = fs.readSync(fd, buffer, 0, entry.len, entry.off);
      return JSON.parse(buffer.subarray(0, read).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Deletes all records. Sequence numbers continue from where they were: the caller stores the
   * new `seqBase`.
   *
   * @returns {void}
   */
  clear() {
    for (const no of this.segments) this._deleteSegment(no);
    this.segments = [];
    this.entries = [];
    this.byId.clear();
    this.segment = { no: this.segment.no + 1, count: 0, size: 0 };
    this.seqBase = this.nextSeq;
  }

  /**
   * Deletes the oldest segments while the newer ones still hold `maxEntries` records.
   *
   * @returns {void}
   */
  enforceRetention() {
    while (this.segments.length > 1) {
      const oldest = this.segments[0];
      const inOldest = firstIndex(this.entries, (entry) => entry.seg !== oldest);
      if (this.entries.length - inOldest < this.maxEntries) break;
      for (const entry of this.entries.splice(0, inOldest)) this.byId.delete(entry.id);
      this._deleteSegment(oldest);
      this.segments.shift();
    }
  }

  _deleteSegment(no) {
    fs.rmSync(this._segmentFile(no, 'jsonl'), { force: true });
    fs.rmSync(this._segmentFile(no, 'idx'), { force: true });
  }

  _segmentFile(no, extension) {
    return path.join(this.dir, `${String(no).padStart(8, '0')}.${extension}`);
  }
}

// Binary search over entries sorted by seq: the first index where `predicate` holds.
function firstIndex(entries, predicate) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (predicate(entries[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}
