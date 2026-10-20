/**
 * Which release of the app is running: the deploy a request or an exception came from, so the
 * dashboard can say when an issue first appeared and what broke after a deploy.
 *
 * In order: the `release` option or PEEKINSIDE_RELEASE; else the commit the hosting platform
 * deployed (Vercel, Netlify, Render, Railway, Heroku, Cloudflare Pages, Google Cloud Run, Fly.io,
 * and the CI services); else the commit checked out in the project folder; else none.
 *
 * Releases are labels, not secrets: PeekInside Cloud stores them readable, like the environment,
 * so they can be filtered and counted.
 */

import fs from 'fs';
import path from 'path';

// Commit (or deploy) variables the platforms set, most specific first.
const PLATFORM_VARIABLES = [
  'VERCEL_GIT_COMMIT_SHA',
  'COMMIT_REF', // Netlify
  'RENDER_GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'HEROKU_BUILD_COMMIT',
  'HEROKU_SLUG_COMMIT',
  'SOURCE_VERSION', // Heroku builds
  'CF_PAGES_COMMIT_SHA',
  'K_REVISION', // Google Cloud Run
  'FLY_IMAGE_REF',
  'GITHUB_SHA',
  'CI_COMMIT_SHA', // GitLab
  'BITBUCKET_COMMIT',
  'CIRCLE_SHA1',
  'CODEBUILD_RESOLVED_SOURCE_VERSION', // AWS CodeBuild
  'COMMIT_SHA' // Google Cloud Build
];

// What a stored release may contain: the characters of commits, versions and image tags.
const UNSAFE = /[^A-Za-z0-9._:@/+-]+/g;
export const MAX_RELEASE_LENGTH = 64;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// How far up from the project folder a repository is looked for (monorepos).
const MAX_GIT_DEPTH = 6;

/**
 * Finds and normalizes the running release.
 */
export class Release {
  /**
   * The running release.
   *
   * @param {Object} [options]
   * @param {string} [options.explicit] - The `release` option
   * @param {Object<string, string|undefined>} [options.env=process.env]
   * @param {string} [options.root] - The project folder, where the checked-out commit is read
   * @returns {string|null}
   */
  static detect({ explicit, env = process.env, root } = {}) {
    const chosen = Release.normalize(explicit) || Release.normalize(env.PEEKINSIDE_RELEASE);
    if (chosen) return chosen;
    for (const name of PLATFORM_VARIABLES) {
      const value = Release.normalize(env[name]);
      if (value) return value;
    }
    return root ? Release.normalize(Release.gitCommit(root)) : null;
  }

  /**
   * Turns a label into the form records store: at most 64 characters among letters, digits and
   * `. _ : @ / + -`; anything else becomes "-".
   *
   * @param {*} value
   * @returns {string|null} null when nothing usable remains
   */
  static normalize(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim().replace(UNSAFE, '-').replace(/^-+|-+$/g, '').slice(0, MAX_RELEASE_LENGTH);
    return clean || null;
  }

  /**
   * The commit checked out in the git repository holding a folder, read from its files (no git
   * process is started). Handles branches, detached heads, packed refs and worktrees.
   *
   * @param {string} root - A folder inside the repository
   * @returns {string|null} The commit hash, or null outside a repository
   */
  static gitCommit(root) {
    try {
      const gitDir = findGitDir(path.resolve(root));
      if (!gitDir) return null;
      const head = readText(path.join(gitDir, 'HEAD'));
      if (!head) return null;
      if (COMMIT.test(head)) return head;
      const ref = /^ref:\s*(\S+)$/.exec(head);
      if (!ref) return null;
      // A worktree keeps its HEAD; the refs live in the main repository ("commondir").
      const common = readText(path.join(gitDir, 'commondir'));
      const refsDir = common ? path.resolve(gitDir, common) : gitDir;
      for (const dir of new Set([gitDir, refsDir])) {
        const loose = readText(path.join(dir, ...ref[1].split('/')));
        if (loose && COMMIT.test(loose)) return loose;
      }
      const packed = readText(path.join(refsDir, 'packed-refs')) || '';
      for (const line of packed.split('\n')) {
        const [hash, name] = line.trim().split(/\s+/);
        if (name === ref[1] && COMMIT.test(hash)) return hash;
      }
    } catch (error) {
      // Not a repository we can read: no release from git.
    }
    return null;
  }

  /**
   * How the dashboard shows a release: commits as their first 7 characters, other labels as they are.
   *
   * @param {string|null} release
   * @returns {string}
   */
  static short(release) {
    if (!release) return '';
    return COMMIT.test(release) ? release.slice(0, 7) : release;
  }
}

// The .git folder of the repository holding `start`: a folder, or a file pointing at one
// (worktrees, submodules).
function findGitDir(start) {
  let dir = start;
  for (let depth = 0; depth < MAX_GIT_DEPTH; depth++) {
    const candidate = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch (error) {
      stat = null;
    }
    if (stat && stat.isDirectory()) return candidate;
    if (stat && stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(candidate) || '');
      return pointer ? path.resolve(dir, pointer[1].trim()) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    return null;
  }
}
