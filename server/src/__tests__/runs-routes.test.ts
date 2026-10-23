import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createDocSlurpClient } from "@docslurp/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunMock = vi.fn();
const getRunProgressMock = vi.fn();
const listRunsMock = vi.fn();
const getWorkspaceMock = vi.fn();
const getRunProcessingPreviewMock = vi.fn();
const reprocessRunMock = vi.fn();
const retryRunMock = vi.fn();
const startPipelineWorkflowMock = vi.fn();
const listenForRunEventsMock = vi.fn();
const listRunEventsMock = vi.fn();
const isApiKeyLiveMock = vi.fn(async () => true);
vi.mock("../services/api-key-liveness.js", () => ({ isApiKeyLive: isApiKeyLiveMock }));

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

class MockRunCreationBlockedError extends Error {
  constructor(
    message: string,
    readonly statusCode: 402 = 402,
    readonly code = "credit_exhausted"
  ) {
    super(message);
    this.name = "RunCreationBlockedError";
  }
}

vi.mock("../services/runs.js", () => ({
  controlRun: vi.fn(),
  exportRun: vi.fn(),
  getRun: getRunMock,
  getRunProcessingPreview: getRunProcessingPreviewMock,
  getRunProgress: getRunProgressMock,
  isReprocessRejectedError: (error: unknown) =>
    error instanceof MockReprocessRejectedError,
  isRunCreationBlockedError: (error: unknown) =>
    error instanceof MockRunCreationBlockedError,
  listenForRunEvents: listenForRunEventsMock,
  listRunEvents: listRunEventsMock,
  listRuns: listRunsMock,
  reprocessRun: reprocessRunMock,
  retryRun: retryRunMock
}));

vi.mock("../services/jobs.js", () => ({
  inlineEstimate: vi.fn(async () => ({ estimate: null })),
  jobMetaFor: (id: string, kind: string) => ({ id, kind }),
  recordJobMeta: vi.fn(async () => undefined),
  jobStatusForMutation: vi.fn(async (meta: { id: string }) => ({ id: meta.id })),
}));
vi.mock("../services/work-estimates.js", () => ({ estimateRunReprocess: vi.fn(async () => null) }));
vi.mock("../services/config-change.js", () => ({ billingState: () => "disabled" }));

vi.mock("../services/idempotency.js", () => ({
  getCachedIdempotentResponse: vi.fn(),
  hashIdempotencyPayload: vi.fn(() => "request-hash"),
  storeIdempotentResponse: vi.fn()
}));

vi.mock("../services/audit-log.js", () => ({
  appendAuditLog: vi.fn()
}));

vi.mock("../services/run-forensics.js", () => ({
  getRunForensics: vi.fn()
}));

vi.mock("../services/run-lifecycle.js", () => ({
  runLifecycle: { start: async (run: { id: string; pipeline: unknown }) => {
    await startPipelineWorkflowMock(run.id, run.pipeline);
    return { status: "started" };
  } },
}));

vi.mock("../lib/temporal.js", () => ({
  startPipelineWorkflow: startPipelineWorkflowMock
}));

vi.mock("../lib/request-context.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-context.js")>("../lib/request-context.js");
  return {
    ...actual,
    requestIp: vi.fn(() => "127.0.0.1"),
    requestUserAgent: vi.fn(() => "vitest")
  };
});

vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null), findWorkspaceForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })), getWorkspace: getWorkspaceMock }));

const { runsRoutes } = await import("../routes/runs.js");

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "Test User" } as never);
    await next();
  });
  app.route("/runs", runsRoutes);
  return app;
}

describe("runsRoutes validation", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    getWorkspaceMock.mockReset();
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", userId: "user-1" });
    getRunProcessingPreviewMock.mockReset();
    reprocessRunMock.mockReset();
    retryRunMock.mockReset();
    startPipelineWorkflowMock.mockReset();
  });

  it("returns preview validation issues before querying preview estimates", async () => {
    const response = await app.request("/runs/preview", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId: "ws-1",
        files: [],
        urls: []
      })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "Invalid run payload" }
    });
    expect(getRunProcessingPreviewMock).not.toHaveBeenCalled();
  });

  it("returns the reprocessed run and warns when Run creation deferred its start", async () => {
    const run = { id: "run-2", orgId: "org-1", workspaceId: "ws-1", pipeline: { embed: true } };
    reprocessRunMock.mockResolvedValueOnce({ run, deferredReason: null });
    const ok = await app.request("/runs/run-1/reprocess", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(ok.status).toBe(201);
    await expect(ok.json()).resolves.toMatchObject({ id: "run-2" });
    expect(ok.headers.get("X-Temporal-Deferred")).toBeNull();

    reprocessRunMock.mockResolvedValueOnce({ run, deferredReason: "Temporal unavailable" });
    const deferred = await app.request("/runs/run-1/reprocess", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(deferred.status).toBe(201);
    expect(deferred.headers.get("X-Temporal-Deferred")).toBe("true");
    await expect(deferred.json()).resolves.toMatchObject({ run: { id: "run-2" }, warnings: ["Temporal unavailable"] });
  });

  it("answers 402 when reprocessing is blocked by spend admission", async () => {
    reprocessRunMock.mockRejectedValue(new MockRunCreationBlockedError("Insufficient credits.", 402, "minimum_credit_required"));
    const response = await app.request("/runs/run-1/reprocess", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "minimum_credit_required" } });
  });

  it("passes a stage selection through and rejects restarts the source cannot satisfy", async () => {
    reprocessRunMock.mockRejectedValue(
      new MockReprocessRejectedError("missing artifacts", 409, "missing_stage_artifacts", {
        missing: [{ documentId: "doc-1", stage: "embed", anyOf: ["markdown"] }]
      })
    );

    const response = await app.request("/runs/run-1/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageFrom: "embed" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(reprocessRunMock).toHaveBeenCalledWith("run-1", "user-1", { stageFrom: "embed" });
  });

  it("rejects unknown reprocess stages before creating a run", async () => {
    const response = await app.request("/runs/run-1/reprocess", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stages: ["embed", "not-a-stage"] })
    });

    expect(response.status).toBe(400);
    expect(reprocessRunMock).not.toHaveBeenCalled();
  });

  it("returns the retried run without a warning when the workflow started", async () => {
    retryRunMock.mockResolvedValue({
      run: { id: "run-3", orgId: "org-1", workspaceId: "ws-1", pipeline: { embed: true } },
      outcome: { status: "resumed", start: { status: "started" } }
    });

    const response = await app.request("/runs/run-1/retry", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Temporal-Deferred")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ id: "run-3" });
  });

  it("returns a deferred warning when retry cannot reach Temporal", async () => {
    retryRunMock.mockResolvedValue({
      run: { id: "run-4", orgId: "org-1", workspaceId: "ws-1", pipeline: { embed: true } },
      outcome: {
        status: "restarted",
        start: {
          status: "deferred",
          reason: "Run is queued, but processing has not started yet because Temporal is currently unavailable. Retry it after Temporal recovers."
        }
      }
    });

    const response = await app.request("/runs/run-1/retry", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Temporal-Deferred")).toBe("true");
    await expect(response.json()).resolves.toMatchObject({
      run: expect.objectContaining({ id: "run-4" }),
      warnings: [
        expect.stringContaining("processing has not started yet because Temporal is currently unavailable")
      ]
    });
  });
});


describe("API-key run reads", () => {
  function keyApp(scopes = ["ingest"], keyType = "server") {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionUser", { id: "user-1", email: "", name: "API key" });
      c.set("apiKey", { userId: "user-1", orgId: "org-1", scopes, keyType } as never);
      await next();
    });
    return app.route("/runs", runsRoutes);
  }
  beforeEach(() => {
    getRunMock.mockReset();
    getRunProgressMock.mockReset();
    listenForRunEventsMock.mockReset();
    listRunEventsMock.mockReset();
    getWorkspaceMock.mockReset();
    listRunsMock.mockReset();
    getRunMock.mockResolvedValue({ id: "run-1", workspaceId: "ws-1", orgId: "org-1" });
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    getRunProgressMock.mockResolvedValue({ run: { id: "run-1", workspaceId: "ws-1", status: "completed" } });
  });
  it.each(["/runs", "/runs/activity/stream", "/runs/run-1/progress", "/runs/run-1/events"])("rejects public-key metadata access at %s", async (path) => {
    const response = await keyApp(["search"], "public").request(path);
    expect(response.status).toBe(403);
    expect(listRunsMock).not.toHaveBeenCalled();
    expect(getRunMock).not.toHaveBeenCalled();
  });
  it("allows an ingest key to observe its run completion", async () => {
    const response = await keyApp().request("/runs/run-1/progress");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { status: "completed" } });
  });
  it("does not return progress from another key organization", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-2" });
    const response = await keyApp().request("/runs/run-1/progress");
    expect(response.status).toBe(404);
    expect(getRunProgressMock).not.toHaveBeenCalled();
  });
  it("requires a service scope for run reads", async () => {
    expect((await keyApp([]).request("/runs/run-1/progress")).status).toBe(403);
    expect(getRunProgressMock).not.toHaveBeenCalled();
  });
  it("rejects a browser/client key on run reads even with a service scope (SEC-2026-10-ROUND3-01)", async () => {
    expect((await keyApp(["search"], "client").request("/runs")).status).toBe(403);
    expect((await keyApp(["search"], "client").request("/runs/activity/stream")).status).toBe(403);
    expect((await keyApp(["search"], "client").request("/runs/run-1/progress")).status).toBe(403);
    expect(listRunsMock).not.toHaveBeenCalled();
  });
  it("filters run lists to the key organization", async () => {
    listRunsMock.mockResolvedValue([{ id: "own", orgId: "org-1" }, { id: "foreign", orgId: "org-2" }]);
    const response = await keyApp().request("/runs");
    expect(await response.json()).toEqual({ runs: [{ id: "own", orgId: "org-1" }] });
  });
  it.each(["/events", "/events/stream", "/progress/stream"])("isolates streaming/event reads across organizations at %s", async suffix => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-2" });
    expect((await keyApp().request(`/runs/run-1${suffix}`)).status).toBe(404);
    expect(listenForRunEventsMock).not.toHaveBeenCalled();
    expect(listRunEventsMock).not.toHaveBeenCalled();
  });
  it.each(["/events", "/events/stream", "/progress/stream"])("requires a service scope at %s", async suffix => {
    expect((await keyApp([]).request(`/runs/run-1${suffix}`)).status).toBe(403);
  });
  it("offers authenticated event polling as a non-streaming fallback", async () => {
    listRunEventsMock.mockResolvedValue([{ id: "event-1", type: "run.progress" }]);
    const response = await keyApp().request("/runs/run-1/events?after=2026-10-02T00%3A00%3A00.000Z&limit=5");
    expect(await response.json()).toEqual({ events: [{ id: "event-1", type: "run.progress" }] });
    expect(listRunEventsMock).toHaveBeenCalledWith({ runId: "run-1", userId: "user-1", after: "2026-10-02T00:00:00.000Z", limit: 5 });
  });
  it("sends snapshots and run deltas, then releases its listener on disconnect", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    const response = await keyApp().request("/runs/run-1/events/stream");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    await vi.waitFor(() => expect(listenForRunEventsMock).toHaveBeenCalledOnce());
    const notify = listenForRunEventsMock.mock.calls[0][0];
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: heartbeat");
    const delta = notify({ id: "event-2", runId: "run-1", type: "run.completed" });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: run.completed");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    await delta;
    await reader.cancel();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 2000 });
  });

  it("serves a final typed progress snapshot and closes without requiring polling", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    getRunProgressMock.mockResolvedValue({ run: { id: "run-1", workspaceId: "ws-1", status: "completed" }, progress: { pageRollup: { completed: 20, total: 20 } } });
    const response = await keyApp().request("/runs/run-1/progress/stream");
    const body = await response.text();
    expect(body).toContain("event: snapshot");
    expect(body).toContain('"completed":20');
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(getRunProgressMock).toHaveBeenCalledWith("run-1", "user-1", { recentEventLimit: 0 });
    expect(isApiKeyLiveMock).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("consumes the mounted progress API through the SDK over actual HTTP", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    getRunProgressMock.mockResolvedValue({
      run: { id: "run-1", workspaceId: "ws-1", orgId: "org-1", stage: "index", status: "completed", controlState: null,
        totalDocuments: 2, processedDocuments: 2, pagesTotal: 20, pagesProcessed: 20, costCents: 0.75 },
      stages: [], recentEvents: [], temporal: null, stats: {}, artifacts: {},
    });
    const app = new Hono().route("/v1", keyApp());
    const server = await new Promise<ReturnType<typeof serve>>(resolve => {
      const instance = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(instance));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected HTTP server address");
      const client = createDocSlurpClient({ apiUrl: `http://127.0.0.1:${address.port}`, apiKey: "local-contract", timeoutMs: 2_000 });
      const initial = await client.getRunProgress("run-1");
      expect(initial.run.pagesProcessed).toBe(20);
      const snapshots = [];
      for await (const snapshot of client.streamProgress("run-1", { transport: "sse", timeoutMs: 2_000 })) snapshots.push(snapshot);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].run.processedDocuments).toBe(2);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("does not emit a progress snapshot for a revoked key", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    isApiKeyLiveMock.mockResolvedValueOnce(false);
    const response = await keyApp().request("/runs/run-1/progress/stream");
    expect(await response.text()).toContain('"code":"access_revoked"');
    expect(getRunProgressMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("streams user activity with organization isolation and releases the listener", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    listRunsMock.mockResolvedValue([{ id: "own", orgId: "org-1" }, { id: "foreign", orgId: "org-2" }]);
    const response = await keyApp().request("/runs/activity/stream");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"id":"own"');
    expect(first).not.toContain('"id":"foreign"');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: heartbeat");
    const notify = listenForRunEventsMock.mock.calls[0][0];
    getRunMock.mockResolvedValueOnce(null);
    await notify({ id: "foreign-event", runId: "foreign", type: "run.progress" });
    const delta = notify({ id: "own-event", runId: "own", type: "run.completed" });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: activity-run");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("own-event");
    await delta;
    await reader.cancel();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 5000 });
  });
  it("uses cheap heartbeats between bounded inventory reconciliations", async () => {
    vi.useFakeTimers();
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    listRunsMock.mockResolvedValue([]);
    const response = await keyApp().request("/runs/activity/stream");
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    const drain = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(new TextDecoder().decode(chunk.value));
      }
    })();
    try {
      await vi.advanceTimersByTimeAsync(28_000);
      expect(listRunsMock).toHaveBeenCalledTimes(1);
      expect(chunks.filter(chunk => chunk.includes("event: heartbeat")).length).toBeGreaterThanOrEqual(7);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(listRunsMock).toHaveBeenCalledTimes(2);
      await reader.cancel();
      await drain;
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await reader.cancel();
      vi.useRealTimers();
    }
  });

  it("does not emit run events after access is revoked", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    listenForRunEventsMock.mockResolvedValue({ close });
    const response = await keyApp().request("/runs/run-1/events/stream");
    const reader = response.body!.getReader();
    await reader.read(); // Initial authorized snapshot.
    await reader.read(); // Liveness only.
    getRunProgressMock.mockResolvedValue(null);
    await listenForRunEventsMock.mock.calls[0][0]({ id: "revoked-event", runId: "run-1", type: "run.progress" });
    // If a rejected event was queued, cancellation would resolve this read with it.
    const pendingRead = reader.read();
    await reader.cancel();
    expect((await pendingRead).done).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("provides authoritative activity inventory without a history limit", async () => {
    listRunsMock.mockResolvedValue([]);
    const response = await keyApp().request("/runs?activity=true");
    expect(response.status).toBe(200);
    expect(listRunsMock).toHaveBeenCalledWith("user-1", true);
    expect((await keyApp([]).request("/runs/activity/stream")).status).toBe(403);
  });

});
