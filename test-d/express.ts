import express from "express";
import PeekInside from "peekinside";

const app = express();
PeekInside.attach(app, { project: "api" }).attachTo(app, { maxBodySize: 1024 });
const peek = new PeekInside({ local: false, captureExceptions: true, sourceContext: false, sourceMaps: true, release: "v2.4.0", loopBlockMs: 200, runtime: false });
const release: string | null = peek.release;
void release;
app.use(peek.expressMiddleware());
app.use((req, res, next) => {
  const attached: boolean = PeekInside.setUser({ id: 42, email: "ada@example.com", name: "Ada", phone: "+91 98765 43210" });
  const sent: Promise<number> = PeekInside.job("send-invoices", async () => 3, { schedule: "0 * * * *", data: { batch: 1 } });
  const count: number = peek.job("count", () => 1);
  const cart: { items: string[] } = PeekInside.dump({ items: ["sku-1"] }, "cart");
  const total: number = peek.dump(42);
  void sent;
  void count;
  void cart;
  void total;
  peek.setUser("user_42");
  void attached;
  next();
});
app.use(express.json());
app.post("/users", (req, res) => res.status(201).json(req.body));
app.get("/orders/:id", (req, res) => {
  const id: string | null = PeekInside.report(new Error("Cache unavailable"), {
    request: req,
    tags: { cache: "redis" },
    extra: { orderId: req.params.id },
    user: { id: "user_42" },
  });
  res.json({ reported: id });
});
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  peek.report(error, { handled: true });
  res.status(500).json({ error: error.message });
  void next;
});
