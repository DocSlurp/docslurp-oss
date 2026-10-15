import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../lib/temporal.js", () => ({ startPipelineWorkflow: vi.fn() }));
vi.mock("../config.js", () => ({ env: { metricsSecret: "metrics-secret" } }));
vi.mock("../services/readiness.js", () => ({
  cachedReadiness: async () => ({
    ok: true,
    serving: true,
    checkedAt: "2026-10-15T00:00:00.000Z",
    checks: [{ name: "migrations", ok: true, critical: true, latencyMs: 12, detail: "schema at 0056_run_spent_cents" }],
  }),
}));

process.env.DOCSLURP_SCALER_CACHE_MS = "0";
const { healthRoutes } = await import("../routes/health.js");

const app = new Hono().route("/", healthRoutes);
const edge = { "fly-client-ip": "203.0.113.7" };

describe("public-edge gating on Fly (F-03, F-07)", () => {
  beforeEach(() => {
    process.env.FLY_APP_NAME = "docslurp-app";
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });
  afterEach(() => {
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_SCALER_METRICS_PUBLIC;
  });

  it("hides /fly-scaler-metrics from the public edge but serves private-network scrapes", async () => {
    expect((await app.request("/fly-scaler-metrics", { headers: edge })).status).toBe(404);
    expect(sqlMock).not.toHaveBeenCalled();
    // Fly's Prometheus scraper reaches the machine directly: no Fly-Client-IP.
    expect((await app.request("/fly-scaler-metrics")).status).toBe(200);
  });

  it("lets the metrics bearer, or an explicit opt-out, read it through the edge", async () => {
    const authorized = await app.request("/fly-scaler-metrics", { headers: { ...edge, Authorization: "Bearer metrics-secret" } });
    expect(authorized.status).toBe(200);
    process.env.FLY_SCALER_METRICS_PUBLIC = "true";
    expect((await app.request("/fly-scaler-metrics", { headers: edge })).status).toBe(200);
  });

  it("does not gate anything outside Fly", async () => {
    delete process.env.FLY_APP_NAME;
    expect((await app.request("/fly-scaler-metrics", { headers: edge })).status).toBe(200);
  });

  it("redacts /ready detail and latency for the public edge only", async () => {
    const publicBody = await (await app.request("/ready", { headers: edge })).json();
    expect(publicBody.checks).toEqual([{ name: "migrations", ok: true, critical: true }]);
    expect(publicBody.ok).toBe(true);

    const privateBody = await (await app.request("/ready")).json();
    expect(privateBody.checks[0].detail).toContain("0056");

    const bearerBody = await (await app.request("/ready", { headers: { ...edge, Authorization: "Bearer metrics-secret" } })).json();
    expect(bearerBody.checks[0].latencyMs).toBe(12);
  });
});
