<h1 align="center">
  <a href="https://www.peekinside.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thejesbin/peekinside/HEAD/.github/assets/peekinside-span-core-lockup-dark.svg">
      <img src="https://raw.githubusercontent.com/thejesbin/peekinside/HEAD/.github/assets/peekinside-span-core-lockup-light.svg" alt="PeekInside" width="280">
    </picture>
  </a>
</h1>

<p align="center">
  <strong>Debug Node.js from the inside.</strong><br>
  Every error with the request that set it off, the queries and calls it made, what it logged and your code around the line that threw.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/peekinside"><img src="https://img.shields.io/npm/v/peekinside?color=18b69b" alt="npm version"></a>
  <a href="https://github.com/thejesbin/peekinside/blob/HEAD/LICENSE"><img src="https://img.shields.io/badge/license-MIT-18b69b" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-18b69b" alt="Node.js 18 or later">
  <img src="https://img.shields.io/badge/types-included-18b69b" alt="TypeScript types included">
</p>

<p align="center">
  <a href="https://www.peekinside.dev/docs/quick-start">Quick start</a> ·
  <a href="https://www.peekinside.dev/docs">Documentation</a> ·
  <a href="https://www.peekinside.dev/guides/laravel-telescope-for-nodejs">Coming from Laravel Telescope?</a> ·
  <a href="https://www.peekinside.dev">peekinside.dev</a>
</p>

![The PeekInside dashboard: an unhandled TypeError, the user it happened to and the code around the line that threw](https://raw.githubusercontent.com/thejesbin/peekinside/HEAD/.github/assets/dashboard.png)

PeekInside records what your app does with each request (the response, the exception, the database queries, the outgoing calls and the log lines) and what your background jobs do, and shows it in a dashboard: free on your machine while you develop, and encrypted end to end on PeekInside Cloud for your servers.

If you know Laravel Telescope, this is Telescope for Node.js: requests, exceptions, queries with N+1 detection, outgoing HTTP calls, logs, jobs and dumps, for Express, NestJS, Fastify, Koa and Hono.

## Quick start

```bash
npm install peekinside
```

```javascript
import express from 'express';
import PeekInside from 'peekinside';

const app = express();
PeekInside.attach(app);
```

Start your app as usual. PeekInside prints the link to its dashboard:

```text
[peekinside] Requests from orders-api: http://localhost:7335/p/orders-api-1a2b3c4d
```

Open it and use your app: requests show up as they happen. To check the setup before anything breaks on its own, `npx peekinside test` sends a test error from your project.

## Frameworks

`PeekInside.attach()` takes the app or server you already have:

| Framework | Attach | Notes |
| --- | --- | --- |
| [Express](https://www.peekinside.dev/frameworks/express) 4 and 5 | `PeekInside.attach(app)` | Bodies are captured whether `express.json()` runs before it or after |
| [NestJS](https://www.peekinside.dev/frameworks/nestjs) 10 and later | `PeekInside.attach(app)` | Before `app.listen()`, on Express or Fastify |
| [Fastify](https://www.peekinside.dev/frameworks/fastify) | `PeekInside.attach(fastify)` | Before `fastify.listen()` |
| [Koa](https://www.peekinside.dev/frameworks/koa) | `PeekInside.attach(app)` | |
| [Hono](https://www.peekinside.dev/frameworks/hono) | `PeekInside.attach(app)` | Before `serve()`, on Node.js with `@hono/node-server` |
| `node:http` | `PeekInside.attach(server)` | Any `http.Server` |

## What it records

- **Requests and responses:** headers, query, route parameters, bodies, status and duration, with the route that matched.
- **Exceptions:** stack traces with your source lines around each frame (TypeScript through source maps), grouped into issues, handled told apart from unhandled. Crashes too, with the request they happened in.
- **Database queries:** pg, mysql2, Prisma, MongoDB and Mongoose, and the ORMs on top of them (Knex, Sequelize, TypeORM, Drizzle, Kysely), with slow queries and [N+1 loops](https://www.peekinside.dev/guides/nodejs-n-plus-one-queries) flagged.
- **Outgoing HTTP calls:** through `node:http` (axios, got and the rest) and `fetch`.
- **Logs:** from the console, pino, winston and NestJS's Logger, on the timeline of the request that wrote them.
- **Jobs:** node-cron, cron, BullMQ and `@nestjs/schedule`, or your own with `PeekInside.job()`. A scheduled job that misses its run is flagged.
- **Dumps:** `PeekInside.dump(value)` shows a value in the dashboard instead of your terminal, as a tree you can open, under the request it belongs to.
- **Runtime:** memory, CPU and event-loop delay over time, and the requests in flight when the event loop was blocked.
- **Who and which deploy:** the user each request was for (`PeekInside.setUser()`) and the release each error came from.

## On your machine, and on your servers

**The local dashboard** is free, needs no account, and keeps what it records on your machine. The first app that needs it starts it in the background, and every app on your machine that uses PeekInside shows up in it as a project. It's for development: it's off when `NODE_ENV` is `production`.

**[PeekInside Cloud](https://www.peekinside.dev/docs/cloud)** is the same dashboard for your servers and your team. Set `PEEKINSIDE_API_KEY` on a server and the same `PeekInside.attach()` sends there. What it sends is encrypted on your server and decrypted in your browser, so PeekInside Cloud only ever stores ciphertext. With Pro and up, alerts reach you by email or Slack. No card is needed to start: see [pricing](https://www.peekinside.dev/#pricing).

## Documentation

Everything else is at **[peekinside.dev/docs](https://www.peekinside.dev/docs)**.

**Docs:** [Quick start](https://www.peekinside.dev/docs/quick-start) · [Local dashboard](https://www.peekinside.dev/docs/local-dashboard) · [PeekInside Cloud](https://www.peekinside.dev/docs/cloud) · [Security](https://www.peekinside.dev/docs/security) · [Exceptions](https://www.peekinside.dev/docs/exceptions) · [Timeline and queries](https://www.peekinside.dev/docs/timeline) · [Routes](https://www.peekinside.dev/docs/routes) · [Logs](https://www.peekinside.dev/docs/logs) · [Jobs and schedules](https://www.peekinside.dev/docs/jobs) · [Dumps](https://www.peekinside.dev/docs/dumps) · [Runtime](https://www.peekinside.dev/docs/runtime) · [Alerts](https://www.peekinside.dev/docs/alerts) · [Configuration](https://www.peekinside.dev/docs/configuration) · [API](https://www.peekinside.dev/docs/api)

**Guides:** [Laravel Telescope for Node.js](https://www.peekinside.dev/guides/laravel-telescope-for-nodejs) · [Node.js debugging tools](https://www.peekinside.dev/guides/nodejs-debugging-tools) · [Finding N+1 queries in Node.js](https://www.peekinside.dev/guides/nodejs-n-plus-one-queries)

Found a bug or have a question? [Open an issue](https://github.com/thejesbin/peekinside/issues).

## License

[MIT](https://github.com/thejesbin/peekinside/blob/HEAD/LICENSE)
