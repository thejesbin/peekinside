/**
 * Identifies the running app for the local dashboard, so every Node.js project on the machine
 * gets its own entry: named after its package.json and told apart by its folder.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const MAX_NAME_LENGTH = 80;

/**
 * Which project the running app is: a stable id, a display name and the project's folder.
 */
export class ProjectIdentity {
  /**
   * @param {Object} fields
   * @param {string} fields.id - Stable id, also the project's folder name in the hub: a slug of
   *   the name plus a hash of the folder, so two apps with the same name stay apart
   * @param {string} fields.name - Display name
   * @param {string} fields.root - Project folder
   */
  constructor({ id, name, root }) {
    this.id = id;
    this.name = name;
    this.root = root;
  }

  /**
   * Identifies the running app.
   *
   * @param {string} [explicitName] - Name chosen in the options or PEEKINSIDE_PROJECT; otherwise
   *   the name in package.json, then the folder name
   * @param {string} [from] - Folder to look for the project from; by default the entry script's
   *   (or the working directory, when the entry script is a tool in node_modules)
   * @returns {ProjectIdentity}
   */
  static detect(explicitName, from) {
    const root = findRoot(from);
    const name = clean(explicitName) || clean(readPackageName(root)) || clean(path.basename(root)) || 'app';
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'app';
    const hash = createHash('sha256').update(`${root}\0${name}`).digest('hex').slice(0, 8);
    return new ProjectIdentity({ id: `${slug}-${hash}`, name, root });
  }
}

// The folder of the nearest package.json above the entry script. Entry scripts inside
// node_modules (nodemon, ts-node-dev, next...) say nothing about the app, so the working
// directory is used for those.
function findRoot(from) {
  const entry = process.argv[1];
  const start = from
    ? path.resolve(from)
    : entry && !entry.split(path.sep).includes('node_modules')
      ? path.dirname(path.resolve(entry))
      : process.cwd();

  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

function readPackageName(dir) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    return typeof name === 'string' ? name : '';
  } catch (error) {
    return '';
  }
}

// Names end up in the dashboard and the CLI's output: no control characters, bounded length.
function clean(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH) : '';
}
