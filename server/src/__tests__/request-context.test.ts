import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn()
}));

(sqlMock as typeof sqlMock & { array?: (value: string[]) => string[] }).array = (value: string[]) => value;
(sqlMock as typeof sqlMock & { json?: (value: unknown) => unknown }).json = (value: unknown) => value;

vi.mock("../db.js", () => ({
  sql: sqlMock
}));

import { getRequestId, requestContextMiddleware, setCurrentRequestUserId, pushRequestPerformanceEvent } from "../lib/request-context.js";

describe("requestContextMiddleware", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it("propagates request ids into the response and context", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/health", (c) => c.json({ requestId: getRequestId(c) }));

    const response = await app.request("/health", {
      headers: {
        "X-Request-ID": "req-123"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe("req-123");
    expect(await response.json()).toEqual({ requestId: "req-123" });
  });

  it("records large RSS deltas without changing the measurement unit", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private/health", (c) => {
      setCurrentRequestUserId("user-123");
      return c.json({ ok: true });
    });

    const memoryUsageSpy = vi.spyOn(process, "memoryUsage");
    memoryUsageSpy
      .mockReturnValueOnce({
        rss: 100_000_000,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0
      })
      .mockReturnValueOnce({
        rss: 250_000_000,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0
      });

    try {
      const response = await app.request("/private/health");

      expect(response.status).toBe(200);
      expect(sqlMock).toHaveBeenCalledTimes(1);
      const rows = (sqlMock.mock.calls[0].at(-1) as any[]);
      expect(rows.find((row: { metric: string }) => row.metric === "request-rss-delta")).toMatchObject({
        value: 150_000_000, unit: "byte",
      });
    } finally {
      memoryUsageSpy.mockRestore();
    }
  });

  it("groups persisted request metrics by route while retaining the concrete path", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/v1/documents/:documentId", (c) => {
      setCurrentRequestUserId("user-123");
      return c.json({ ok: true });
    });
    for (const id of ["document-a", "document-b"]) {
      sqlMock.mockClear();
      await app.request(`/v1/documents/${id}`);
      expect(sqlMock).toHaveBeenCalledTimes(1);
      const rows = (sqlMock.mock.calls[0].at(-1) as any[]);
      for (const row of rows) {
        expect(row.stage_name).toBe("/v1/documents/:documentId");
        expect(row.metadata).toMatchObject({ path: `/v1/documents/${id}`, route: "/v1/documents/:documentId" });
      }
    }
  });
  it("batches custom metrics and preserves IDs, tags, and metadata", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => {
      setCurrentRequestUserId("u");
      pushRequestPerformanceEvent({ scope: "search", stageName: "retrieve", metric: "latency", value: 12, unit: "ms", tags: ["vector"], metadata: { count: 3 } });
      return c.text("ok");
    });
    await app.request("/private", { headers: { "X-Request-ID": "batch-id" } });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const rows = (sqlMock.mock.calls[0].at(-1) as any[]);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(5);
    expect(rows[0]).toMatchObject({ scope: "search", value: 12, tags: ["vector"], metadata: { count: 3, requestId: "batch-id" } });
  });

  it("bounds a stalled diagnostic write without cancelling it or losing the response", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = Object.assign(new Promise<void>(resolve => { finish = resolve; }), { cancel: vi.fn(async () => {}) });
    sqlMock.mockReturnValue(pending);
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => { setCurrentRequestUserId("u"); return c.text("ok"); });
    try {
      const response = app.request("/private");
      await vi.advanceTimersByTimeAsync(100);
      expect((await response).status).toBe(200);
      expect(pending.cancel).not.toHaveBeenCalled();
    } finally {
      finish();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("keeps database failures from replacing the endpoint response", async () => {
    sqlMock.mockRejectedValue(new Error("diagnostics unavailable"));
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => { setCurrentRequestUserId("u"); return c.text("ok"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await app.request("/private")).status).toBe(200); }
    finally { log.mockRestore(); }
  });

  it("caps unresolved diagnostic writes when cancellation does not settle them", async () => {
    vi.useFakeTimers();
    const finishers: Array<() => void> = [];
    sqlMock.mockImplementation(() => new Promise<void>(resolve => { finishers.push(resolve); }));
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => { setCurrentRequestUserId("u"); return c.text("ok"); });
    try {
      const requests = Array.from({ length: 10 }, () => app.request("/private"));
      await vi.advanceTimersByTimeAsync(0);
      expect(sqlMock).toHaveBeenCalledTimes(10);
      expect((await app.request("/private")).status).toBe(200);
      expect(sqlMock).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(100);
      expect((await Promise.all(requests)).every(response => response.status === 200)).toBe(true);
    } finally {
      finishers.forEach(finish => finish());
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

});
