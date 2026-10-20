import { serve } from "@hono/node-server";
import { Hono } from "hono";
import PeekInside from "peekinside";

const app = new Hono();
PeekInside.attach(app);
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
serve({ fetch: app.fetch, port: 3000 });
