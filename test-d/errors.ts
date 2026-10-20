import PeekInside from "peekinside";

// @ts-expect-error: unknown option
new PeekInside({ maxBody: 10 });
// @ts-expect-error: wrong type
new PeekInside({ maxBodySize: "1kb" });
// @ts-expect-error: not an app
PeekInside.attach(42);
const peek = new PeekInside();
// @ts-expect-error: read-only, use setEnabled()
peek.isEnabled = false;
// @ts-expect-error: tags are strings
peek.report(new Error("x"), { tags: { attempt: 3 } });
// @ts-expect-error: unknown report option
PeekInside.report(new Error("x"), { severity: "high" });
// @ts-expect-error: the id may be null when nothing was recorded
const id: string = peek.report(new Error("x"));
// @ts-expect-error: captureExceptions is a boolean
new PeekInside({ captureExceptions: "yes" });
// @ts-expect-error: slowQueryMs is a number of milliseconds
new PeekInside({ slowQueryMs: "100ms" });
// @ts-expect-error: measure() needs a function
peek.measure("render", 42);
// @ts-expect-error: measure() returns what the function returns
const measured: string = peek.measure("count", () => 1);
// @ts-expect-error: requestId() is static
peek.requestId();
// @ts-expect-error: a user is an object, an id or null
PeekInside.setUser(true);
// @ts-expect-error: the release is read-only
peek.release = "v2";
// @ts-expect-error: loopBlockMs is a number of milliseconds, or false
new PeekInside({ loopBlockMs: true });
// @ts-expect-error: job() needs a function
peek.job("nightly", 42);
// @ts-expect-error: logLevel is a level name
new PeekInside({ logLevel: "verbose" });
void id;
void measured;
