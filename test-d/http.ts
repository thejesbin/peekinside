import http from "node:http";
import PeekInside, { type PeekInsideOptions } from "peekinside";

const options: PeekInsideOptions = {
  project: "orders-api",
  maxBodySize: 128 * 1024,
  ignorePaths: ["/health", /^\/metrics/, (pathname) => pathname.startsWith("/internal")],
  local: true,
  environment: "development",
  timeline: true,
  captureQueries: true,
  captureOutgoing: true,
  captureLogs: false,
  queryParams: true,
  slowQueryMs: 250,
  nPlusOneThreshold: 10,
};

const server = http.createServer((req, res) => res.end("ok"));
const peek = PeekInside.attach(server, options);
const enabled: boolean = peek.isEnabled;
const limit: number = peek.options.maxBodySize;
peek.setEnabled(!enabled && limit > 0);
const same: http.Server = new PeekInside({ local: false }).wrapHttpServer(http.createServer());
http.createServer(async (req, res) => {
  peek.intercept(req, res);
  const total: number = peek.measure("sum", () => 1 + 2);
  const text: string = await PeekInside.measure("load", async () => "loaded");
  const id: string | null = PeekInside.requestId();
  res.end(`${total} ${text} ${id ?? "none"}`);
});
const chained: PeekInside = peek.instrument({ Client: class {} }, "unknown values are ignored");
void same;
void chained;
void peek.flush().then(() => peek.stop());
