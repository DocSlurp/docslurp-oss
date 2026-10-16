import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunMock = vi.fn();
const reprocessRunMock = vi.fn();
const sqlCalls: string[] = [];

class MockReprocessRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409,
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

vi.mock("../db.js", () => ({
  sql: (strings: TemplateStringsArray) => {
    sqlCalls.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve([]);
  }
}));

vi.mock("../services/runs.js", () => ({
  getRun: getRunMock,
  reprocessRun: reprocessRunMock,
  isReprocessRejectedError: (error: unknown) => error instanceof MockReprocessRejectedError,
  isRunCreationBlockedError: () => false
}));

const { indexStalenessRoutes } = await import("../routes/index-staleness.js");

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "Test User" } as never);
    await next();
  });
  app.route("/runs", indexStalenessRoutes);
  return app;
}

describe("POST /runs/:runId/reindex", () => {
  beforeEach(() => {
    getRunMock.mockReset();
    reprocessRunMock.mockReset();
    sqlCalls.length = 0;
    getRunMock.mockResolvedValue({ id: "run-1", pipeline: { embed: true } });
  });

  it("reprocesses only embed and index and starts the new run", async () => {
    const newRun = { id: "run-2", orgId: "org-1", workspaceId: "ws-1", pipeline: { embed: true, stageSubset: ["embed", "index"] } };
    reprocessRunMock.mockResolvedValue({ run: newRun, deferredReason: null });

    const response = await buildApp().request("/runs/run-1/reindex", { method: "POST" });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ runId: "run-2" });
    expect(reprocessRunMock).toHaveBeenCalledWith("run-1", "user-1", { stages: ["embed", "index"] });
    expect(sqlCalls.some((query) => query.includes("set reindex_queued_at = now()"))).toBe(true);
  });

  it("returns the 4xx when the source run cannot be reindexed, without marking it queued", async () => {
    reprocessRunMock.mockRejectedValue(
      new MockReprocessRejectedError("missing", 409, "missing_stage_artifacts", { missing: [] })
    );

    const response = await buildApp().request("/runs/run-1/reindex", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "missing_stage_artifacts" });
    expect(sqlCalls).toEqual([]);
  });

  it("reports a deferred start when Temporal is unavailable", async () => {
    reprocessRunMock.mockResolvedValue({ run: { id: "run-2", orgId: "org-1", workspaceId: "ws-1", pipeline: {} }, deferredReason: "Temporal unavailable" });

    const response = await buildApp().request("/runs/run-1/reindex", { method: "POST" });

    expect(response.status).toBe(201);
    expect(response.headers.get("X-Temporal-Deferred")).toBe("true");
    await expect(response.json()).resolves.toEqual({ runId: "run-2", warnings: ["Temporal unavailable"] });
  });

  it("returns 404 for an unknown run", async () => {
    getRunMock.mockResolvedValue(null);
    const response = await buildApp().request("/runs/missing/reindex", { method: "POST" });
    expect(response.status).toBe(404);
    expect(reprocessRunMock).not.toHaveBeenCalled();
  });
});
