/**
 * Tells the app's own code apart from its dependencies and Node.js itself, frame by frame.
 *
 * The dashboard highlights in-app frames, groups exceptions by them (see fingerprint.js) and shows
 * their source lines, so "in app" has to mean the code people can change: files inside the
 * project folder, except anything under node_modules.
 */

import fs from 'fs';
import path from 'path';

/**
 * @typedef {Object} Frame
 * @property {string|null} function
 * @property {string|null} file - Absolute path, "node:..." for internals, null for built-ins
 * @property {string|null} relativeFile - Relative to the project folder with forward slashes, when
 *   the file is inside it
 * @property {number|null} line
 * @property {number|null} column
 * @property {boolean} inApp - Inside the project folder and not under node_modules
 * @property {string|null} module - npm package ("express", "@scope/pkg") of node_modules frames,
 *   "node" for Node.js internals
 * @property {boolean} native
 * @property {boolean} async
 * @property {{ start: number, lines: string[] }|null} context - Source lines, set by SourceContext
 */

/**
 * Classifies parsed frames relative to one project folder.
 */
export class FrameClassifier {
  /**
   * @param {string} root - The project folder (ProjectIdentity#root)
   */
  constructor(root) {
    this.root = path.resolve(root || process.cwd());
    // Stack traces show where modules really are: a project reached through a symlink (macOS's
    // /tmp and /var, linked workspaces, mounted volumes) appears under its real path there.
    let real = this.root;
    try {
      real = fs.realpathSync(this.root);
    } catch (error) {
      real = this.root;
    }
    this.roots = real === this.root ? [this.root] : [this.root, real];
  }

  /**
   * Completes a parsed frame with where it comes from.
   *
   * @param {import('./stack-parser.js').ParsedFrame} parsed
   * @returns {Frame}
   */
  classify(parsed) {
    const file = parsed.file;
    let relativeFile = null;
    let inApp = false;
    let module = null;

    if (file && file.startsWith('node:')) {
      module = 'node';
    } else if (file) {
      module = FrameClassifier.moduleOf(file);
      relativeFile = this.relativeFile(file);
      inApp = relativeFile !== null && !relativeFile.split('/').includes('node_modules');
    }

    return {
      function: parsed.function,
      file,
      relativeFile,
      line: parsed.line,
      column: parsed.column,
      inApp,
      module,
      native: parsed.native,
      async: parsed.async,
      context: null
    };
  }

  /**
   * @param {string} file
   * @returns {string|null} The path relative to the project folder, with forward slashes, or
   *   null when the file is outside it (or isn't a path)
   */
  relativeFile(file) {
    if (!path.isAbsolute(file)) return null;
    for (const root of this.roots) {
      const relative = path.relative(root, file);
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      return relative.split(path.sep).join('/');
    }
    return null;
  }

  /**
   * The npm package a file belongs to: the folder after the last node_modules segment, so
   * nested installs and pnpm's .pnpm store name the package that actually runs.
   *
   * @param {string} file
   * @returns {string|null}
   */
  static moduleOf(file) {
    const segments = file.split(/[\\/]/);
    const index = segments.lastIndexOf('node_modules');
    if (index === -1 || index + 1 >= segments.length) return null;
    const name = segments[index + 1];
    if (name.startsWith('@')) {
      return index + 2 < segments.length ? `${name}/${segments[index + 2]}` : null;
    }
    return name || null;
  }
}
