import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Council T1, through the real `sessionAuth` middleware and the real routes: a revoked (or otherwise invalid) API key
 * is refused before any chart-export handling, on upload, upload estimate and reprocess, and nothing is written; a
 * request carrying both a session cookie and an API key acts as the key (run origin `machine`, never `app`).
 */
const keyActor = {
  type: "apiKey", userId: "u1",
  apiKey: { keyId: "k1", userId: "u1", orgId: "o1", keyType: "server", scopes: ["ingest"], projectIds: [], allowedDomains: [], rateLimitRpm: null, rateLimitPpd: 10_000, rateLimits: [] },
};
const cookieActor = { type: "session", userId: "u1", sessionId: "s1", user: { id: "u1", email: "a@example.com", name: "A" } };

const resolveApiKeyActor = vi.fn();
const resolveBetterAuthSessionActor = vi.fn(async () => cookieActor);
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/request-actor.js")>()),
  resolveApiKeyActor: (...args: unknown[]) => resolveApiKeyActor(...args),
  resolveBetterAuthSessionActor: () => resolveBetterAuthSessionActor(),
}));
const reprocessRun = vi.fn();
vi.mock("../services/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/runs.js")>()),
  reprocessRun: (...args: unknown[]) => reprocessRun(...args),
}));
const estimateUpload = vi.fn();
vi.mock("../services/work-estimates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/work-estimates.js")>()),
  estimateUpload: (...args: unknown[]) => estimateUpload(...args),
}));

const { sessionAuth } = await import("../middleware/session-auth.js");
const { acceptApiKeys } = await import("../lib/route-auth.js");
const { runOriginOf } = await import("../lib/run-origin.js");
const { runsRoutes } = await import("../routes/runs.js");
const { createUploadsRoutes, uploadEstimateRoutes } = await import("../routes/uploads.js");

const intake = vi.fn();
const ports = new Proxy({}, { get: () => intake }) as never;

function app() {
  const root = new Hono();
  root.use("/v1/*", sessionAuth);
  root.route("/v1/runs", runsRoutes);
  root.route("/v1/uploads", uploadEstimateRoutes);
  root.route("/v1/uploads", createUploadsRoutes(ports));
  root.route("/v1/origin", acceptApiKeys(new Hono().post("/", (c) => c.text(runOriginOf(c)))));
  return root;
}

const request = (path: string, body: unknown, headers: Record<string, string>) =>
  app().request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

afterEach(() => { vi.clearAllMocks(); });

describe("chart export through the real auth middleware", () => {
  it("refuses a revoked key with 401 on upload, URL ingest, upload estimate and reprocess, before any chart handling", async () => {
    resolveApiKeyActor.mockResolvedValue(null); // what a revoked key resolves to
    const headers = { Authorization: "Bearer dslp_revoked", cookie: "better-auth.session_token=valid" };
    const chartExport = { tier: "models" };
    const responses = await Promise.all([
      request("/v1/runs/run-1/reprocess", { chartExport }, headers),
      request("/v1/runs/run-1/reprocess/estimate", { chartExport }, headers),
      request("/v1/uploads/estimate", { files: [{ name: "a.pdf", size: 10 }], chartExport }, headers),
      request("/v1/uploads/url", { urls: ["https://example.com/a.pdf"], pipeline: { chartExport } }, headers),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toMatch(/chart_export/);
    }
    // Never fell back to the cookie, and no handler ran (nothing written).
    expect(resolveBetterAuthSessionActor).not.toHaveBeenCalled();
    expect(reprocessRun).not.toHaveBeenCalled();
    expect(estimateUpload).not.toHaveBeenCalled();
    expect(intake).not.toHaveBeenCalled();
  });

  it("a request with both a session cookie and a valid API key acts as the key: run origin machine", async () => {
    resolveApiKeyActor.mockResolvedValue(keyActor);
    const res = await request("/v1/origin", {}, { Authorization: "Bearer dslp_live", cookie: "better-auth.session_token=valid", "x-docslurp-origin": "app" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("machine");
    expect(resolveBetterAuthSessionActor).not.toHaveBeenCalled();
  });
});
