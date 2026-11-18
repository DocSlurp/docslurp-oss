import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeBodyLimit } from "../lib/api-error.js";
import { BODY_IDLE_TIMEOUT_MS, MAX_IN_MEMORY_BODY_BYTES, bodyBudgetWarnings, bodyReadDeadlineMs, bodyReadSettings, boundedBodyLimit, bufferedBodyBytes, configureBodyReads } from "../lib/bounded-body-limit.js";
import { multipartBodyLimit } from "../lib/upload-policy.js";
import { safeErrorResponse } from "../lib/public-errors.js";
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

describe("request body buffer budgets", () => {
  let saved: ReturnType<typeof bodyReadSettings>;
  beforeEach(() => { saved = bodyReadSettings(); });
  afterEach(() => configureBodyReads(saved));

  /**
   * A limiter app whose `/v1/hold` route waits until released. `x-org` makes a
   * request an API key's (authenticated, charged to that org); without it the
   * request is public (charged to its client IP).
   */
  function budgetApp() {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const org = c.req.header("x-org");
      if (org) c.set("apiKey", { orgId: org, keyId: `key-${org}` } as never);
      await next();
    });
    app.use("*", nativeBodyLimit(8 * 1024 * 1024));
    app.post("/v1/hold", async c => { await held; return c.text("ok"); });
    app.post("/v1/quick", c => c.text("ok"));
    const post = (path: string, bytes: number, org?: string) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json", ...(org ? { "x-org": org } : {}) }, body: new Uint8Array(bytes),
    });
    return { post, release: () => release() };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it("keeps public requests in their own pool: they cannot starve authenticated ones", async () => {
    // One client IP may hold at most a quarter of the public pool (100 KiB here).
    configureBodyReads({ publicBytes: 400 * 1024, perIpBytes: 1024 * 1024, bufferBudgetBytes: 1024 * 1024 });
    const { post, release } = budgetApp();
    const holding = post("/v1/hold", 80 * 1024);
    await settle();
    expect(bufferedBodyBytes("public")).toBe(80 * 1024);
    const second = await post("/v1/quick", 80 * 1024);
    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBe("5");
    expect(await second.json()).toMatchObject({ error: { code: "unavailable" } });
    // An authenticated request draws from its own pool.
    expect((await post("/v1/quick", 80 * 1024, "org-a")).status).toBe(200);
    release();
    expect((await holding).status).toBe(200);
    expect(bufferedBodyBytes()).toBe(0);
  });

  it("caps a public request's size whatever its route allows", async () => {
    configureBodyReads({ publicRequestBytes: 64 * 1024 });
    const { post } = budgetApp();
    expect((await post("/v1/quick", 65 * 1024)).status).toBe(413);
    expect((await post("/v1/quick", 65 * 1024, "org-a")).status).toBe(200);
  });

  it("leaves another org's small requests working while one org's large bodies fill its share", async () => {
    configureBodyReads({ bufferBudgetBytes: 1024 * 1024, smallReserveBytes: 256 * 1024, smallRequestBytes: 64 * 1024, perOwnerBytes: 600 * 1024, largestBodyBytes: 300 * 1024 });
    const { post, release } = budgetApp();
    const holding = [post("/v1/hold", 300 * 1024, "org-a"), post("/v1/hold", 300 * 1024, "org-a")];
    await settle();
    expect(bufferedBodyBytes("authenticated")).toBe(600 * 1024);
    // Org A is at its share.
    expect((await post("/v1/quick", 100 * 1024, "org-a")).status).toBe(503);
    // Org B's large body would reach into the small-request reserve; its small one never does.
    expect((await post("/v1/quick", 200 * 1024, "org-b")).status).toBe(503);
    expect((await post("/v1/quick", 10 * 1024, "org-b")).status).toBe(200);
    release();
    for (const response of await Promise.all(holding)) expect(response.status).toBe(200);
    expect(bufferedBodyBytes()).toBe(0);
  });

  it("fits one cap-sized upload per org, and concurrent cap-sized uploads never reach the small-request reserve", async () => {
    // Scaled: a 1 MiB pool, a 256 KiB reserve, a 300 KiB bulk cap and an org share set below it.
    configureBodyReads({ bufferBudgetBytes: 1024 * 1024, smallReserveBytes: 256 * 1024, perOwnerBytes: 128 * 1024, largestBodyBytes: 300 * 1024 });
    const { post, release } = budgetApp();
    // The share is never below one upload of the cap, so honest uploads from two orgs fit.
    const holding = [post("/v1/hold", 300 * 1024, "org-a"), post("/v1/hold", 300 * 1024, "org-b")];
    await settle();
    expect(bufferedBodyBytes("authenticated")).toBe(600 * 1024);
    // A third would reach into the reserve: refused, while small requests keep working.
    expect((await post("/v1/quick", 300 * 1024, "org-c")).status).toBe(503);
    expect((await post("/v1/quick", 10 * 1024, "org-d")).status).toBe(200);
    release();
    for (const response of await Promise.all(holding)) expect(response.status).toBe(200);
  });

  it("warns at startup when the pool holds fewer than four uploads of the bulk cap", () => {
    configureBodyReads({ bufferBudgetBytes: 256 * 1024 * 1024, largestBodyBytes: 100 * 1024 * 1024 });
    expect(bodyBudgetWarnings()).toEqual([expect.stringContaining("fewer than 4 concurrent bodies")]);
    configureBodyReads({ largestBodyBytes: 25 * 1024 * 1024 });
    expect(bodyBudgetWarnings()).toEqual([]);
  });

  it("releases an aborted request's reservation and cancels its pending read", async () => {
    const app = new Hono();
    app.use("*", nativeBodyLimit(8 * 1024 * 1024));
    app.post("/v1/x", c => c.text("ok"));
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(50 * 1024)); return; }
        return new Promise(() => {});
      },
      cancel,
    });
    const client = new AbortController();
    const pending = app.request(new Request("http://localhost/v1/x", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half", signal: client.signal } as RequestInit));
    await settle();
    expect(bufferedBodyBytes()).toBe(50 * 1024);
    client.abort();
    await Promise.resolve(pending).catch(() => undefined);
    expect(bufferedBodyBytes()).toBe(0);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("body read deadline", () => {
  it("gives a slow but steady near-cap bulk upload time to finish (80 KiB/s on a 25 MiB cap)", () => {
    const cap = 25 * 1024 * 1024;
    expect(bodyReadDeadlineMs(cap)).toBeGreaterThan((cap / (80 * 1024)) * 1000);
    configureBodyReads({ minBytesPerSecond: 100 * 1024 });
    try {
      expect(bodyReadDeadlineMs(cap)).toBeLessThan((cap / (80 * 1024)) * 1000);
    } finally {
      configureBodyReads({ minBytesPerSecond: 32 * 1024 });
    }
  });

  it("answers a bulk upload past its deadline with 408 whose public copy points to direct upload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const bulk = new Hono();
      bulk.use("*", multipartBodyLimit(1024 * 1024));
      bulk.post("/v1/uploads/bulk", c => c.text("ok"));
      // Progressing (one chunk every 10 s, inside the idle timeout) but past the overall deadline.
      const trickle = new ReadableStream<Uint8Array>({ async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        controller.enqueue(new Uint8Array(1));
      } }, { highWaterMark: 0 });
      const pending = bulk.request(new Request("http://localhost/v1/uploads/bulk", {
        method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: trickle, duplex: "half",
      } as RequestInit));
      await vi.advanceTimersByTimeAsync(bodyReadDeadlineMs(1024 * 1024) + 10_000);
      const response = await pending;
      expect(response.status).toBe(408);
      const envelope = await (await safeErrorResponse(response, "req-1", true)).json();
      expect(envelope.error).toMatchObject({ code: "invalid_request", details: { directUpload: { createSession: "/v1/uploads/direct/sessions" } } });
      expect(envelope.error.message).toContain("direct upload session (POST /v1/uploads/direct/sessions)");
    } finally {
      vi.useRealTimers();
    }
  });

  /** A limiter app whose body arrives one byte per `everyMs` (fake timers), `chunks` times. */
  function paced(cap: number, everyMs: number, chunks: number, headers: Record<string, string> = {}) {
    const app = new Hono();
    // An API key's request: public requests are capped at 1 MiB, which would shorten the deadline.
    app.use("*", async (c, next) => { c.set("apiKey", { orgId: "org-a", keyId: "key-a" } as never); await next(); });
    app.use("*", nativeBodyLimit(cap));
    app.post("/v1/x", async c => c.text(String((await c.req.raw.arrayBuffer()).byteLength)));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (sent === chunks) { controller.close(); return; }
      await new Promise(resolve => setTimeout(resolve, everyMs));
      sent++;
      controller.enqueue(new Uint8Array(1));
    } }, { highWaterMark: 0 });
    return app.request(new Request("http://localhost/v1/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit));
  }

  it("lets a steady slow upload through: a chunk every idle - 1 ms for longer than the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A 4 MiB cap with no declared length: the overall deadline (60 s + 128 s) outlasts three chunks.
      const pending = paced(4 * 1024 * 1024, BODY_IDLE_TIMEOUT_MS - 1, 3);
      await vi.advanceTimersByTimeAsync(3 * BODY_IDLE_TIMEOUT_MS);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("3");
      // Both read timers are cleared once the body is complete.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 408 once a body pauses longer than the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = paced(4 * 1024 * 1024, BODY_IDLE_TIMEOUT_MS + 10_000, 1);
      await vi.advanceTimersByTimeAsync(BODY_IDLE_TIMEOUT_MS + 1);
      expect((await pending).status).toBe(408);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes the overall deadline from the declared length: a trickle gets 408 at that deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // 1 KB declared on a 4 MiB cap: the deadline is ~60 s, not the cap's ~188 s.
      const deadline = bodyReadDeadlineMs(1000);
      expect(deadline).toBeLessThan(bodyReadDeadlineMs(4 * 1024 * 1024));
      let settled = false;
      const pending = Promise.resolve(paced(4 * 1024 * 1024, 10_000, 1000, { "content-length": "1000" })).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await pending).status).toBe(408);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never holds more than the in-memory ceiling, whatever cap it is given", async () => {
    const huge = new Hono();
    huge.use("*", boundedBodyLimit(500 * 1024 * 1024, c => c.text("too large", 413), { onTimeout: c => c.text("slow", 408), onBusy: c => c.text("busy", 503) }));
    huge.post("/x", c => c.text("ok"));
    const response = await huge.request("/x", { method: "POST", headers: { "content-length": String(MAX_IN_MEMORY_BODY_BYTES + 1) }, body: "x" });
    expect(response.status).toBe(413);
  });
});
