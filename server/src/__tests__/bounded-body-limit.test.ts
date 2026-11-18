import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { nativeBodyLimit } from "../lib/api-error.js";
import { rejectNulBytes } from "../lib/reject-nul.js";

function app() {
  const app = new Hono();
  app.use("*", nativeBodyLimit(64));
  app.use("*", rejectNulBytes);
  app.post("/v1/echo", async c => c.text(await c.req.raw.text()));
  return app;
}
function request(chunks: string[], headers: Record<string, string>) {
  let index = 0;
  const body = new ReadableStream({ pull(controller) {
    if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
    else controller.close();
  } });
  return new Request("http://localhost/v1/echo", { method: "POST", headers, body, duplex: "half" } as RequestInit);
}
describe("bounded request bodies before readers", () => {
  it.each(["application/json", "application/problem+json", "text/plain", ""])("counts streamed bytes for %s with no content length", async type => {
    const response = await app().request(request(['{"q":"', 'x'.repeat(64), '"}'], type ? { "content-type": type } : {}));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
  it("keeps protocol error responses flat", async () => {
    const protocol = new Hono();
    protocol.use("*", nativeBodyLimit(64));
    protocol.post("/v1/chat/completions", c => c.text("unexpected"));
    const response = await protocol.request("/v1/chat/completions", { method: "POST", body: "x".repeat(65) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large", error: expect.any(String) });
  });
  it("does not trust an understated content length", async () => {
    expect((await app().request(request(["x".repeat(65)], { "content-length": "1" }))).status).toBe(413);
  });
  it("preserves exact-limit raw bytes for downstream readers", async () => {
    const body = "é".repeat(32);
    const response = await app().request(request([body], { "content-type": "text/plain" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });
  it("answers 413 before the NUL reader scans an oversized JSON body", async () => {
    expect((await app().request(request(['{"q":"\\u0000', 'x'.repeat(65), '"}'], { "content-type": "application/json" }))).status).toBe(413);
  });
  it("keeps data after a zero-length first chunk", async () => {
    const response = await app().request(request(["", "abc"], { "content-type": "text/plain" }));
    expect(await response.text()).toBe("abc");
  });
  it("drops an empty body but keeps the client's abort signal", async () => {
    const seen: { body?: boolean; aborted?: boolean } = {};
    const client = new AbortController();
    const limited = new Hono();
    limited.use("*", nativeBodyLimit(64));
    limited.post("/v1/x", c => {
      seen.body = c.req.raw.body !== null;
      client.abort();
      seen.aborted = c.req.raw.signal.aborted;
      return c.text("ok");
    });
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    await limited.request(new Request("http://localhost/v1/x", { method: "POST", body, duplex: "half", signal: client.signal } as RequestInit));
    expect(seen).toEqual({ body: false, aborted: true });
  });
});
