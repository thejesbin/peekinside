import Fastify from "fastify";
import PeekInside from "peekinside";

const fastify = Fastify();
PeekInside.attach(fastify);
new PeekInside({ local: false }).fastifyHook(fastify);
fastify.get("/", async () => ({ ok: true }));
