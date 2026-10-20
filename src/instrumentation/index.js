/**
 * Turns the timeline's instrumentations on.
 *
 * Database drivers are found from the app's project folder: each one installed there (pg, mysql2,
 * mongodb, the mongodb copy Mongoose carries, @prisma/client) is loaded and its prototypes are
 * patched. Loading a driver first is harmless: the app's own require() or import gets the same
 * module instance (ES modules importing a CommonJS driver share it too), already patched. A
 * driver that isn't installed is skipped; one that fails to load is left alone.
 *
 * Apps whose drivers can't be found that way (bundled apps, a monorepo package with its own copy)
 * pass them to PeekInside#instrument().
 *
 * Outgoing HTTP and console capture are process-wide subscriptions; they record only for code
 * running inside a request (log lines go to the Logs page from anywhere). Loggers (pino, winston)
 * and job libraries (node-cron, cron, BullMQ) are found and patched like the drivers; NestJS's
 * Logger and @nestjs/schedule are reached through the app instead (see integrations/nest.js).
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ConsoleInstrumentation } from './console.js';
import { HttpInstrumentation } from './http.js';
import { JobInstrumentation } from './jobs.js';
import { LoggerInstrumentation } from './loggers.js';
import { MongoInstrumentation } from './mongodb.js';
import { Mysql2Instrumentation } from './mysql2.js';
import { PgInstrumentation } from './pg.js';
import { PrismaInstrumentation } from './prisma.js';

const requireHere = createRequire(import.meta.url);
const scanned = new Set();
const scannedLoggers = new Set();
const scannedJobs = new Set();

/**
 * Installs instrumentations.
 */
export class Instrumentation {
  /**
   * Turns on what a recording instance captures. Safe to call again: each piece installs once.
   *
   * @param {Object} options
   * @param {string} options.root - The project folder drivers are resolved from
   * @param {boolean} options.queries - Database drivers
   * @param {boolean} options.outgoing - node:http/https and fetch
   * @param {boolean} options.logs - The console, pino and winston
   * @param {boolean} [options.jobs=false] - node-cron, cron and BullMQ
   * @returns {void}
   */
  static install({ root, queries, outgoing, logs, jobs = false }) {
    try {
      if (outgoing) HttpInstrumentation.install();
      if (logs) ConsoleInstrumentation.install();
      if (queries) Instrumentation.patchInstalled(root);
      if (logs) Instrumentation.patchLoggers(root);
      if (jobs) Instrumentation.patchJobs(root);
    } catch (error) {
      // Monitoring must never break the host application.
    }
  }

  /**
   * Patches the loggers installed in a project (pino, winston), once per project folder.
   *
   * @param {string} root
   * @returns {string[]} Names of the loggers patched
   */
  static patchLoggers(root) {
    const patched = [];
    const fromRoot = projectRequire(root, scannedLoggers);
    if (!fromRoot) return patched;
    if (patchWith(fromRoot, 'pino', LoggerInstrumentation.pino)) patched.push('pino');
    if (patchWith(fromRoot, 'winston', LoggerInstrumentation.winston)) patched.push('winston');
    // NestJS's ConsoleLogger, for a NestJS project.
    if (declares(root, '@nestjs/common')) {
      void importInstalled(fromRoot, '@nestjs/common', null, (common) => LoggerInstrumentation.nest(exported(common, 'ConsoleLogger')));
    }
    return patched;
  }

  /**
   * Patches the job libraries installed in a project (node-cron, cron, BullMQ), once per project
   * folder. Their ES module builds are patched as soon as they are imported.
   *
   * @param {string} root
   * @returns {string[]} Names of the libraries patched (CommonJS builds)
   */
  static patchJobs(root) {
    const patched = [];
    const fromRoot = projectRequire(root, scannedJobs);
    if (!fromRoot) return patched;
    for (const [name, patch] of [['node-cron', JobInstrumentation.nodeCron], ['cron', JobInstrumentation.cron], ['bullmq', JobInstrumentation.bullmq]]) {
      const main = resolve(fromRoot, name);
      if (!main) continue;
      if (patchWith(fromRoot, name, patch)) patched.push(name);
      const directory = packageDirectory(main, name);
      if (directory) void JobInstrumentation.patchModuleBuild(directory, patch);
    }
    // @nestjs/schedule registers a NestJS app's scheduled methods as the app initializes, which a
    // worker (NestFactory.createApplicationContext()) does before it can be attached.
    if (declares(root, '@nestjs/schedule')) {
      void importInstalled(fromRoot, '@nestjs/schedule', path.join('dist', 'schedule.explorer.js'), (explorer) => JobInstrumentation.nestSchedule(exported(explorer, 'ScheduleExplorer')));
    }
    return patched;
  }

  /**
   * Patches the database drivers installed in a project, once per project folder.
   *
   * @param {string} root
   * @returns {string[]} Names of the drivers patched
   */
  static patchInstalled(root) {
    const patched = [];
    if (!root || scanned.has(root)) return patched;
    scanned.add(root);
    let fromRoot;
    try {
      fromRoot = createRequire(path.join(root, 'package.json'));
    } catch (error) {
      return patched;
    }

    if (patchWith(fromRoot, 'pg', PgInstrumentation.patch)) patched.push('pg');
    if (patchWith(fromRoot, 'mysql2', Mysql2Instrumentation.patch)) patched.push('mysql2');
    if (patchMongo(fromRoot)) patched.push('mongodb');
    // Mongoose depends on an exact driver version, often installed under its own node_modules.
    const mongoose = resolve(fromRoot, 'mongoose');
    if (mongoose && patchMongo(createRequire(mongoose))) patched.push('mongoose');
    if (patchWith(fromRoot, '@prisma/client', PrismaInstrumentation.patch)) patched.push('@prisma/client');
    return patched;
  }

  /**
   * Patches modules given by the app: pg, mysql2, mysql2/promise, mongodb, mongoose, a PrismaClient
   * class or instance, or the @prisma/client module. Anything else is ignored.
   *
   * @param {Array} modules
   * @returns {number} How many were recognized
   */
  static instrument(modules) {
    let recognized = 0;
    for (const value of modules) {
      try {
        if (patchModule(value) || (value && typeof value === 'object' && patchModule(value.default))) recognized++;
      } catch (error) {
        // An unknown value is ignored.
      }
    }
    return recognized;
  }
}

function patchModule(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (LoggerInstrumentation.pino(value) || LoggerInstrumentation.winston(value)) return true;
  if (JobInstrumentation.nodeCron(value) || JobInstrumentation.cron(value) || JobInstrumentation.bullmq(value)) return true;
  if (PgInstrumentation.patch(value)) return true;
  if (Mysql2Instrumentation.patch(value)) return true;
  if (PrismaInstrumentation.patch(value)) return true;
  if (typeof value.MongoClient === 'function') return patchMongoModule(value);
  // Mongoose exposes the driver it uses.
  if (value.mongo && typeof value.mongo.MongoClient === 'function') return patchMongoModule(value.mongo);
  // mysql2/promise runs on the core module next to it.
  const file = fileOf(value);
  if (file && /mysql2[\\/]promise\.js$/.test(file)) {
    return Mysql2Instrumentation.patch(createRequire(file)('./index.js'));
  }
  return false;
}

// require() from a project folder, the first time the folder is scanned for `scanned`.
function projectRequire(root, scanned) {
  if (!root || scanned.has(root)) return null;
  scanned.add(root);
  try {
    return createRequire(path.join(root, 'package.json'));
  } catch (error) {
    return null;
  }
}

function patchWith(fromRoot, name, patch) {
  if (!resolve(fromRoot, name)) return false;
  try {
    return patch(fromRoot(name));
  } catch (error) {
    return false;
  }
}

// The driver's Connection is internal: it is loaded from the package's own files, which gives the
// same module instance the driver uses.
function patchMongo(fromSomewhere) {
  const main = resolve(fromSomewhere, 'mongodb');
  return main ? patchMongoDirectory(packageDirectory(main, 'mongodb')) : false;
}

function patchMongoModule(mongodb) {
  const file = fileOf(mongodb);
  return file ? patchMongoDirectory(packageDirectory(file, 'mongodb')) : false;
}

function patchMongoDirectory(directory) {
  if (!directory) return false;
  try {
    const load = createRequire(path.join(directory, 'package.json'));
    const { Connection } = load(path.join(directory, 'lib', 'cmap', 'connection.js'));
    let ConnectionPool;
    try {
      ({ ConnectionPool } = load(path.join(directory, 'lib', 'cmap', 'connection_pool.js')));
    } catch (error) {
      ConnectionPool = undefined;
    }
    return MongoInstrumentation.patch({ Connection, ConnectionPool });
  } catch (error) {
    return false;
  }
}

function resolve(fromSomewhere, name) {
  try {
    return fromSomewhere.resolve(name);
  } catch (error) {
    return null;
  }
}

// The folder of the package `name` (scoped or not) that contains `file`.
function packageDirectory(file, name) {
  const [scope, base] = name.includes('/') ? name.split('/') : [null, name];
  for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
    const named = path.basename(directory) === base && (!scope || path.basename(path.dirname(directory)) === scope);
    if (named && fs.existsSync(path.join(directory, 'package.json'))) return directory;
    if (path.dirname(directory) === directory) return null;
  }
}

// Whether the project's package.json depends on a package. Frameworks are only loaded for projects
// that use them: a monorepo's shared node_modules may hold another app's.
function declares(root, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => Boolean(pkg[field] && pkg[field][name]));
  } catch (error) {
    return false;
  }
}

// Loads a package installed in the project (or one of its files) the way an import does, which
// gives the module instance the app runs whether the package ships CommonJS or ES modules, and
// patches it.
async function importInstalled(fromRoot, name, file, patch) {
  const main = resolve(fromRoot, name);
  const directory = main && file ? packageDirectory(main, name) : null;
  const target = file ? directory && path.join(directory, file) : main;
  if (!target || !fs.existsSync(target)) return false;
  try {
    return patch(await import(pathToFileURL(target).href));
  } catch (error) {
    return false;
  }
}

// An export of a module, imported as an ES module or as CommonJS (under `default`).
function exported(module, name) {
  if (!module) return undefined;
  return module[name] || (module.default && module.default[name]);
}

// The file a module object was loaded from, found in the CommonJS cache.
function fileOf(exports) {
  for (const module of Object.values(requireHere.cache)) {
    if (module && module.exports === exports) return module.filename;
  }
  return null;
}
