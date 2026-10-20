// Entry point of the background hub process started by HubClient#spawn().
import { HubProcess } from './process.js';

new HubProcess().run();
