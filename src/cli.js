/**
 * The `peekinside` command, which manages the free local dashboard:
 *
 *   npx peekinside            Start it in the background (if needed) and print its address
 *   npx peekinside open       Same, then open it in the browser
 *   npx peekinside status     Show whether it runs and which projects it holds
 *   npx peekinside stop       Stop it (data stays on disk)
 *   npx peekinside run        Run it in this terminal, with its log
 *   npx peekinside test       Send a test error, to check that a project is set up
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LOG_PREFIX, VERSION, settings } from './config.js';
import { HubClient } from './hub/client.js';
import { HubProcess } from './hub/process.js';

/**
 * Runs one command against the hub on the configured port.
 */
export class Cli {
  /**
   * Targets the hub on PEEKINSIDE_HUB_PORT (default 7335).
   */
  constructor() {
    this.port = settings.hubPort();
    this.url = settings.hubUrl(this.port);
    this.hub = new HubClient(this.port);
  }

  /**
   * Runs a command. Unknown commands print the help and exit with status 1, as do failures.
   *
   * @param {string[]} args - Command-line arguments, without node and the script
   * @returns {void}
   */
  run(args) {
    const command = args[0] || 'start';
    const commands = {
      start: () => this.start(false),
      open: () => this.start(true),
      status: () => this.status(),
      stop: () => this.stop(),
      run: () => new HubProcess().run(),
      test: () => this.test(),
      help: () => this.help(),
      '--help': () => this.help(),
      '-h': () => this.help(),
      '--version': () => console.log(VERSION),
      '-v': () => console.log(VERSION)
    };

    if (!commands[command]) {
      console.error(`Unknown command: ${command}\n`);
      this.help();
      process.exit(1);
    }
    Promise.resolve(commands[command]()).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  }

  /**
   * Starts the hub in the background unless it already runs, and prints its address.
   *
   * @param {boolean} openBrowser - Also open the dashboard in the default browser
   * @returns {Promise<void>}
   * @throws {Error} When the hub did not start in time
   */
  async start(openBrowser) {
    // A hub left running by an older PeekInside is replaced by this version's (its data stays).
    const replaced = await this.hub.replaceIfOlder();
    if (replaced) console.log(`Restarted PeekInside Local: it was version ${replaced}, now ${VERSION}.`);
    let running = await this.hub.status();
    if (!running) {
      this.hub.spawn();
      running = await this.hub.waitUntilReady(8000);
      if (!running) {
        throw new Error(`The local dashboard did not start. See ${settings.dataDir()}/hub.log`);
      }
    }
    console.log(`PeekInside Local is running: ${this.url}`);
    if (openBrowser) this._openInBrowser(this.url);
  }

  /**
   * Prints whether the hub runs, and its projects.
   *
   * @returns {Promise<void>}
   */
  async status() {
    const running = await this.hub.status();
    if (!running) {
      console.log(`PeekInside Local is not running. Start it with: npx peekinside`);
      console.log(`Data folder: ${settings.dataDir()}`);
      return;
    }
    const { projects } = await this.hub.request('GET', '/api/projects');
    console.log(`PeekInside Local ${running.version} is running: ${this.url} (pid ${running.pid})`);
    console.log(`Data folder: ${running.dataDir}\n`);
    if (!projects.length) {
      console.log('No projects yet. Attach PeekInside to an app and start it.');
      return;
    }
    for (const project of projects) {
      const state = project.online
        ? `running${project.instances[0] && project.instances[0].port ? ` on :${project.instances[0].port}` : ''}`
        : 'stopped';
      const exceptions = Number.isInteger(project.exceptionCount) ? `${String(project.exceptionCount).padStart(5)} exceptions   ` : '';
      console.log(`  ${project.online ? '●' : '○'} ${project.name.padEnd(28)} ${String(project.requestCount).padStart(6)} requests ${exceptions}  ${state}`);
      console.log(`    ${project.root}`);
    }
  }

  /**
   * Stops the hub and waits up to five seconds for it to exit.
   *
   * @returns {Promise<void>}
   * @throws {Error} When it is still running after that
   */
  async stop() {
    const running = await this.hub.status();
    if (!running) {
      console.log('PeekInside Local is not running.');
      return;
    }
    process.kill(running.pid, 'SIGTERM');
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!(await this.hub.status().catch(() => null))) {
        console.log('PeekInside Local stopped. Your data stays in ' + running.dataDir);
        return;
      }
    }
    throw new Error(`PeekInside Local (pid ${running.pid}) did not stop.`);
  }

  /**
   * Sends a test error the way the app would, run from the project's folder: to PeekInside Cloud
   * when PEEKINSIDE_API_KEY is set (in the environment, or in the project's .env), otherwise to the
   * local dashboard, which is started if needed. Exits with status 1 when it didn't arrive.
   *
   * @returns {Promise<void>}
   * @throws {Error} When the error could not be delivered
   */
  async test() {
    loadProjectEnv(process.cwd());
    const { default: PeekInside } = await import('./PeekInside.js');
    const cloud = Boolean(settings.apiKey());
    if (!cloud) await this.start(false);

    // Only report(): no automatic capture of this command's own errors, no instrumentation.
    const peekInside = new PeekInside({ local: true, captureExceptions: false, timeline: false, projectRoot: process.cwd() });
    const transport = peekInside._transport;
    if (!transport) throw new Error('PeekInside could not set up a destination for the test error.');
    if (peekInside._local) {
      // This command prints where the error went; the app's "Requests from ..." line would only confuse.
      peekInside._local.announced = true;
      peekInside._local.start();
    }

    const id = peekInside.report(new PeekInsideTestError(), {
      request: { method: 'GET', url: '/peekinside/test', headers: { host: 'localhost', 'user-agent': `peekinside-cli/${VERSION}` } },
      tags: { test: 'true' },
      extra: { sentBy: 'npx peekinside test', node: process.version, release: peekInside.release },
      handled: true
    });
    if (!id) throw new Error('PeekInside is paused or not recording, so no test error was sent.');

    const deadline = Date.now() + 15_000;
    while ((transport.queue.length || transport.inflight) && !transport.disabled && Date.now() < deadline) {
      await transport.flush();
      if (transport.queue.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const delivered = !transport.disabled && !transport.queue.length && !transport.inflight;
    peekInside.stop();
    if (!delivered) {
      throw new Error(cloud
        ? 'The test error did not reach PeekInside Cloud. Check PEEKINSIDE_API_KEY and your connection.'
        : `The test error did not reach the local dashboard. See ${settings.dataDir()}/hub.log`);
    }

    const where = cloud
      ? `PeekInside Cloud (${transport.environment}). Open your project's Exceptions page: ${settings.siteUrl()}/projects`
      : `PeekInside Local: ${this.url}/p/${peekInside._local.project.id}/exceptions`;
    console.log(`${LOG_PREFIX} Sent a test error to ${where}`);
    if (peekInside.release) console.log(`${LOG_PREFIX} Release: ${peekInside.release}`);
  }

  /**
   * Prints the usage.
   *
   * @returns {void}
   */
  help() {
    console.log(`PeekInside ${VERSION}: the free local dashboard for all your Node.js projects

Usage: npx peekinside [command]

  start     Start the dashboard in the background and print its address (default)
  open      Start it and open it in your browser
  status    Show whether it is running and list your projects
  stop      Stop it; your data stays in ${settings.dataDir()}
  run       Run it in this terminal
  test      Send a test error from this project, to check it's set up

Apps that use PeekInside start the dashboard automatically.
Settings: PEEKINSIDE_HUB_PORT (default 7335), PEEKINSIDE_HOME (default ~/.peekinside)`);
  }

  // Opening a browser is a convenience: when it fails, the address is printed instead.
  _openInBrowser(target) {
    const [cmd, args] = process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open ${target} in your browser.`));
    child.unref();
  }
}

/**
 * The error `npx peekinside test` sends: a stand-in for a real one, with a name of its own so it
 * groups into one issue however often it is sent.
 */
class PeekInsideTestError extends Error {
  constructor() {
    super('This is a test error sent by `npx peekinside test`: errors from this project reach PeekInside.');
    this.name = 'PeekInsideTestError';
  }
}

// PEEKINSIDE_* settings from the project's .env files, for the variables the environment doesn't
// set already: apps usually load PEEKINSIDE_API_KEY from .env, and so does this command. Nothing
// else in those files is read into the environment.
function loadProjectEnv(dir) {
  for (const name of ['.env.local', '.env']) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (error) {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(PEEKINSIDE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      const quoted = /^(['"])(.*)\1$/.exec(value);
      value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
      process.env[match[1]] = value;
    }
  }
}
