# PeekInside

Debug Node.js from the inside: every error with the request that set it off, the queries and calls it made, what it logged and your code around the line that threw. A free dashboard on your computer while you develop, and encrypted monitoring for your servers.

[![npm](https://img.shields.io/npm/v/peekinside?color=18b69b)](https://www.npmjs.com/package/peekinside)
![License](https://img.shields.io/badge/license-MIT-18b69b)
![Node](https://img.shields.io/badge/node-%3E%3D18-18b69b)

## Install

```bash
npm install peekinside
```

```javascript
import express from 'express';
import PeekInside from 'peekinside';

const app = express();
PeekInside.attach(app);
```

Start your app, and PeekInside prints the link to its dashboard. It works with Express, Koa, Fastify and the native http module.

Check the setup before anything breaks on its own: `npx peekinside test` sends a test error from your project.

Also recorded: background jobs (node-cron, cron, BullMQ, or `PeekInside.job()`, with an email when a scheduled job misses its run), log lines from the console, pino and winston, event-loop blocks and memory, the deploy each error came from, the user it happened to (`PeekInside.setUser()`), and TypeScript lines through your source maps.

## Documentation

Everything else is in the docs: **[peekinside.dev/docs](https://peekinside.dev/docs)**

- [Quick start](https://peekinside.dev/docs/quick-start)
- [Local dashboard](https://peekinside.dev/docs/local-dashboard)
- [PeekInside Cloud](https://peekinside.dev/docs/cloud)
- [Exceptions](https://peekinside.dev/docs/exceptions)
- [Timeline and queries](https://peekinside.dev/docs/timeline)
- [Logs](https://peekinside.dev/docs/logs)
- [Jobs and schedules](https://peekinside.dev/docs/jobs)
- [Runtime](https://peekinside.dev/docs/runtime)
- [Configuration](https://peekinside.dev/docs/configuration)
- [API](https://peekinside.dev/docs/api)

## License

MIT
