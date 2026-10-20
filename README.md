# PeekInside

Debug Node.js from the inside: every error with the request that set it off, the queries and calls it made, what it logged and your code around the line that threw. A free dashboard on your computer while you develop, and encrypted monitoring for your servers.

[![npm](https://img.shields.io/npm/v/peekinside?color=18b69b)](https://www.npmjs.com/package/peekinside)
![License](https://img.shields.io/badge/license-MIT-18b69b)
![Node](https://img.shields.io/badge/node-%3E%3D18-18b69b)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://buymeacoffee.com/thejesbin)

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

Start your app, and PeekInside prints the link to its dashboard. It works with Express, Koa, Fastify, NestJS, Hono and the native http module.

Check the setup before anything breaks on its own: `npx peekinside test` sends a test error from your project.

While you develop, `PeekInside.dump(value)` shows any value in the local dashboard instead of your terminal: as a tree you can open, under the request it belongs to, with the line that dumped it.

Also recorded: background jobs (node-cron, cron, BullMQ, @nestjs/schedule, or `PeekInside.job()`, with an email when a scheduled job misses its run), log lines from the console, pino, winston and NestJS's Logger, event-loop blocks and memory, the deploy each error came from, the user it happened to (`PeekInside.setUser()`), and TypeScript lines through your source maps.

## Documentation

Everything else is in the docs: **[peekinside.dev/docs](https://peekinside.dev/docs)**

- [Quick start](https://peekinside.dev/docs/quick-start)
- [Local dashboard](https://peekinside.dev/docs/local-dashboard)
- [PeekInside Cloud](https://peekinside.dev/docs/cloud)
- [Exceptions](https://peekinside.dev/docs/exceptions)
- [Timeline and queries](https://peekinside.dev/docs/timeline)
- [Logs](https://peekinside.dev/docs/logs)
- [Jobs and schedules](https://peekinside.dev/docs/jobs)
- [Dumps](https://peekinside.dev/docs/dumps)
- [Runtime](https://peekinside.dev/docs/runtime)
- [Alerts](https://peekinside.dev/docs/alerts)
- [Configuration](https://peekinside.dev/docs/configuration)
- [API](https://peekinside.dev/docs/api)

## Support

If PeekInside saves you a debugging session, you can buy me a coffee:

[![Buy me a coffee](https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=thejesbin&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff)](https://buymeacoffee.com/thejesbin)

## License

MIT
