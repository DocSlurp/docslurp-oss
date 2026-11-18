import { it, expect } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import net from "node:net";
import { boundedBodyLimit } from "./bounded-body-limit.js";
import { bodyTimeoutResponse } from "./api-error.js";
import { requestContextMiddleware } from "./request-context.js";
it("wire 408", async () => {
  const app = new Hono();
  app.use("*", boundedBodyLimit(1024, (c) => c.text("big", 413), { onTimeout: (c) => { c.header("Connection", "close"); return c.json({ error: "slow" }, 408); }, idleTimeoutMs: 300 }));
  app.post("/", async (c) => c.text("ok"));
  const server = await new Promise<any>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
  const port = server.address().port;
  const out: string = await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (d) => { data += d.toString(); });
    sock.on("close", () => resolve(`CLOSED:${data}`));
    sock.on("error", (e) => resolve(`ERR:${e.message}:${data}`));
    sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\":");
    setTimeout(() => resolve(`TIMEOUT:${data}`), 3000);
  });
  server.close();
  expect(out).toBe("probe");
});
