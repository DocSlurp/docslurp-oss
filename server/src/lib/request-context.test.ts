import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestContextMiddleware, setCurrentRequestUserId } from "./request-context.js";

const { observe, posthogLog, database, otlpLogs } = vi.hoisted(() => ({ observe: vi.fn(), posthogLog: vi.fn(), database: vi.fn(), otlpLogs: vi.fn(() => false) }));
vi.mock("@docslurp/shared/observability", () => ({
  withObservation: observe,
  withHttpSpan: async (_options: unknown, run: () => Promise<unknown>) => run(),
  addTraceMetadata: vi.fn(),
  exportsOtlpLogs: otlpLogs,
}));
vi.mock("../db.js", () => ({ sql: Object.assign(database, { json: (value: unknown) => value }) }));
vi.mock("./posthog-ai-observability.js", () => ({ emitPostHogApiLog: posthogLog }));

beforeEach(() => {
  database.mockReset();
  observe.mockReset();
  posthogLog.mockReset();
  otlpLogs.mockReturnValue(false);
  observe.mockImplementation(async (_options, run) => run());
});

describe("request logs", () => {
  it("writes the stdout line only when no OTLP log exporter carries the structured record", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/v1/models", c => c.text("ok"));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await app.request("/v1/models");
      expect(stdout.mock.calls.some(([line]) => String(line).startsWith("[api] requestId="))).toBe(true);
      stdout.mockClear();
      otlpLogs.mockReturnValue(true);
      await app.request("/v1/models");
      expect(stdout.mock.calls.some(([line]) => String(line).startsWith("[api] requestId="))).toBe(false);
      expect(posthogLog).toHaveBeenCalledTimes(2);
    } finally { stdout.mockRestore(); }
  });
});

describe("request observation names", () => {
  it("groups different document IDs under the mounted route template and preserves paths in metadata", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    const runs = new Hono();
    runs.get("/:id", (c) => c.json({ id: c.req.param("id") }));
    app.route("/v1/documents", runs);

    for (const id of ["3bd4b650-4442-4e00-8c84-a6ce1f2156f8", "another-run"]) {
      const path = `/v1/documents/${id}`;
      expect((await app.request(path)).status).toBe(200);
      expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({
        name: "api.GET./v1/documents/:id",
        metadata: { method: "GET", path, route: "/v1/documents/:id" },
      });
      expect(posthogLog.mock.calls.at(-1)?.[0]).toMatchObject({
        eventName: "docslurp.api.request_completed",
        body: expect.stringMatching(new RegExp(`^GET ${path} 200 \\d+ms$`)),
        attributes: { "http.request.method": "GET", "http.route": "/v1/documents/:id", "url.path": path },
      });
    }
  });

  it("keeps polling and progress HTTP telemetry without creating AI observations", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    for (const route of ["/v1/runs/:id", "/v1/runs/:id/progress", "/v1/runs/:id/events", "/v1/ai-operations/:operationId"]) app.get(route, c => c.text("ready"));
    for (const path of ["/v1/runs/run-a", "/v1/runs/run-a/progress", "/v1/runs/run-a/events", "/v1/ai-operations/op-a"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Request-ID")).toBeTruthy();
    }
    expect(observe).not.toHaveBeenCalled();
    expect(posthogLog).toHaveBeenCalledTimes(4);
    expect(posthogLog.mock.calls[1][0].attributes["http.route"]).toBe("/v1/runs/:id/progress");
  });

  it("does not create AI observations for infrastructure probes", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    const probes = ["/health", "/ready", "/metrics", "/fly-scaler-metrics"];
    for (const route of probes) app.get(route, c => c.text("ok"));
    app.get("/v1/workspaces/:id/metrics", c => c.text("ok"));
    for (const path of probes) expect((await app.request(path)).status).toBe(200);
    expect(observe).not.toHaveBeenCalled();
    // Successful probes are not logged; failing ones still are.
    expect(posthogLog).not.toHaveBeenCalled();
    const failingProbe = new Hono();
    failingProbe.use("*", requestContextMiddleware);
    failingProbe.get("/ready", c => c.text("down", 503));
    expect((await failingProbe.request("/ready")).status).toBe(503);
    expect(posthogLog.mock.calls.at(-1)?.[0]).toMatchObject({ severityText: "error", attributes: { "http.route": "/ready" } });
    // Only the exact probe routes are skipped.
    await app.request("/v1/workspaces/w/metrics");
    expect(observe.mock.calls.at(-1)?.[0]).toMatchObject({ name: "api.GET./v1/workspaces/:id/metrics" });
  });

  it("keeps static and wildcard endpoint names stable", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/v1/models", (c) => c.text("ok"));
    app.all("/auth/*", (c) => c.text("ok"));

    await app.request("/v1/models");
    await app.request("/auth/session/user-123");
    expect(observe.mock.calls.map(([options]) => options.name)).toEqual([
      "api.GET./v1/models", "api.GET./auth/*",
    ]);
  });

  it("does not use arbitrary missing paths as observation names", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    expect((await app.request("/missing/user-123")).status).toBe(404);
    expect(observe.mock.calls[0][0].name).toBe("api.GET.unmatched");
  });

  it("uses endpoint templates when auth middleware rejects the request", async () => {
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.use("/v1/*", async (c) => c.text("unauthorized", 401));
    app.post("/v1/workspaces/:workspaceId/connectors/:connectorId/sync", (c) => c.text("ok"));
    expect((await app.request("/v1/workspaces/workspace-a/connectors/connector-b/sync", { method: "POST" })).status).toBe(401);
    expect(observe.mock.calls[0][0].name).toBe("api.POST./v1/workspaces/:workspaceId/connectors/:connectorId/sync");
  });
  it("reports final response and telemetry duration separately from handler timing", async () => {
    vi.useFakeTimers();
    database.mockImplementation(() => new Promise<void>(resolve => setTimeout(resolve, 30)));
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => { setCurrentRequestUserId("u"); return c.text("ok"); });
    try {
      const response = app.request("/private");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30);
      expect((await response).status).toBe(200);
      expect(posthogLog.mock.calls[0][0].attributes).toMatchObject({
        duration_ms: 30, handler_duration_ms: 0, telemetry_flush_ms: 30, telemetry_flush: "persisted",
      });
    } finally { vi.useRealTimers(); }
  });

  it("stops waiting on a slow telemetry flush without cancelling the query", async () => {
    // A Postgres cancel hits whatever statement the pooled backend runs next,
    // which under burst load is another request's intake query.
    vi.useFakeTimers();
    const cancel = vi.fn();
    database.mockImplementation(() => Object.assign(new Promise<void>(resolve => setTimeout(resolve, 5_000)), { cancel }));
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/private", c => { setCurrentRequestUserId("u"); return c.text("ok"); });
    try {
      const response = app.request("/private");
      await vi.advanceTimersByTimeAsync(100);
      expect((await response).status).toBe(200);
      expect(posthogLog.mock.calls[0][0].attributes).toMatchObject({ telemetry_flush: "timeout" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cancel).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

});
