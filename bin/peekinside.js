#!/usr/bin/env node
/**
 * peekinside: manage the free local dashboard. See src/cli.js for the commands.
 */

import { Cli } from '../src/cli.js';

new Cli().run(process.argv.slice(2));
