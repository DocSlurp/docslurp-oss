import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /ops/worker-fleet: operator-only (METRICS_SECRET bearer), never public. */
const config = vi.hoisted(() => ({ env: { metricsSecret: "metrics-secret" as string | undefined } }));
const report = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../config.js", () => config);
vi.mock("../services/worker-fleet.js", () => ({ workerFleetReport: report }));

const { healthRoutes } = await import("../routes/health.js");

function app() {
  return new Hono().route("/", healthRoutes);
}

describe("GET /ops/worker-fleet", () => {
  beforeEach(() => {
    config.env.metricsSecret = "metrics-secret";
    report.mockReset();
    report.mockResolvedValue({ gate: true, taskQueue: "docslurp-pipeline", basis: "pollers", reason: "1 live worker(s)", capabilities: [], features: [], workers: [], checkedAt: "now" });
  });

  it("is not found when METRICS_SECRET is unset", async () => {
    config.env.metricsSecret = undefined;
    const response = await app().request("/ops/worker-fleet");
    expect(response.status).toBe(404);
    expect(report).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong bearer tokens without computing the report", async () => {
    expect((await app().request("/ops/worker-fleet")).status).toBe(401);
    expect((await app().request("/ops/worker-fleet", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect(report).not.toHaveBeenCalled();
  });

  it("returns the report, uncached, to the operator", async () => {
    const response = await app().request("/ops/worker-fleet", { headers: { Authorization: "Bearer metrics-secret" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ gate: true, basis: "pollers" });
  });
});
