import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** GET /ops/estimate-signing: operator-only (METRICS_SECRET bearer), the key's source and fingerprint, never the value. */
const config = vi.hoisted(() => ({ env: { metricsSecret: "metrics-secret" as string | undefined } }));
const SECRET = "q".repeat(48);

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../config.js", () => config);

const { healthRoutes } = await import("../routes/health.js");
const { estimateSigningKeyFingerprint } = await import("../lib/estimate-signing-key.js");

const app = () => new Hono().route("/", healthRoutes);

describe("GET /ops/estimate-signing", () => {
  beforeEach(() => {
    config.env.metricsSecret = "metrics-secret";
    vi.stubEnv("DOCSLURP_ESTIMATE_SIGNING_SECRET", SECRET);
  });

  it("is not found without METRICS_SECRET and refuses a missing or wrong bearer", async () => {
    config.env.metricsSecret = undefined;
    expect((await app().request("/ops/estimate-signing")).status).toBe(404);
    config.env.metricsSecret = "metrics-secret";
    expect((await app().request("/ops/estimate-signing")).status).toBe(401);
    expect((await app().request("/ops/estimate-signing", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("returns the source and fingerprint, uncached, and never the secret", async () => {
    const response = await app().request("/ops/estimate-signing", { headers: { Authorization: "Bearer metrics-secret" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ source: "DOCSLURP_ESTIMATE_SIGNING_SECRET", fingerprint: estimateSigningKeyFingerprint({ DOCSLURP_ESTIMATE_SIGNING_SECRET: SECRET }) });
    expect(text).not.toContain(SECRET);
  });
});
