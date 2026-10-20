import Koa from "koa";
import PeekInside from "peekinside";

const app = new Koa();
const peek = PeekInside.attach(app);
app.use(new PeekInside({ local: false }).koaMiddleware());
app.use(async (ctx) => {
  peek.report("a thrown string", { request: ctx.req, handled: false });
  ctx.body = { ok: true };
});
