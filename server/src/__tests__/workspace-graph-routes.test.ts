import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getStatusMock = vi.fn();
const updateMock = vi.fn();
const startMock = vi.fn();
const getJobMock = vi.fn();
const cancelMock = vi.fn();
const auditMock = vi.fn();

class MockWorkspaceGraphError extends Error {
  constructor(message: string, readonly status: number, readonly activeJob?: unknown) {
    super(message);
  }
}

vi.mock("../services/workspace-graph.js", () => ({
  getWorkspaceGraphStatus: getStatusMock,
  updateWorkspaceGraph: updateMock,
  startGraphRebuild: startMock,
  getGraphJob: getJobMock,
  cancelGraphJob: cancelMock,
  isGraphJobActive: (job: { status: string }) => job.status === "queued" || job.status === "running",
  WorkspaceGraphError: MockWorkspaceGraphError,
}));
vi.mock("../services/workspaces.js", () => ({
  getWorkspace: vi.fn(async () => ({ id: "ws-1", orgId: "org-1" })),
}));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: auditMock }));
vi.mock("../lib/request-context.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-context.js")>("../lib/request-context.js");
  return { ...actual, requestIp: vi.fn(() => "127.0.0.1") };
});

const { workspaceGraphRoutes } = await import("../routes/workspace-graph.js");

function buildApp(apiKey?: { scopes: string[]; keyType: "server" | "client" }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "Test User" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", ...apiKey } as never);
    await next();
  });
  app.route("/v1/workspaces", workspaceGraphRoutes);
  return app;
}

const job = (status: string, processed: number) => ({ id: "job-1", status, documentsProcessed: processed });

describe("workspace graph routes", () => {
  beforeEach(() => {
    for (const mock of [getStatusMock, updateMock, startMock, getJobMock, cancelMock, auditMock]) mock.mockReset();
  });

  it("returns the graph status", async () => {
    getStatusMock.mockResolvedValue({ workspaceId: "ws-1", enabled: true });
    const response = await buildApp().request("/v1/workspaces/ws-1/graph");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: "ws-1", enabled: true });
    expect(getStatusMock).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("accepts partial updates and rejects unknown fields", async () => {
    updateMock.mockResolvedValue({ workspaceId: "ws-1", configHash: "g1-x" });
    const app = buildApp();
    const ok = await app.request("/v1/workspaces/ws-1/graph", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depth: "deep", entityTypes: ["Payment Term"] }),
    });
    expect(ok.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith("ws-1", "user-1", { depth: "deep", entityTypes: ["payment_term"] });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.graph.updated" }));

    const rejected = await app.request("/v1/workspaces/ws-1/graph", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline: {} }),
    });
    expect(rejected.status).toBe(400);
  });

  it("reports the already-running job when a rebuild conflicts", async () => {
    startMock.mockRejectedValue(new MockWorkspaceGraphError("A graph rebuild is already running", 409, job("running", 2)));
    const response = await buildApp().request("/v1/workspaces/ws-1/graph/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A graph rebuild is already running", activeJob: job("running", 2) });
  });

  it("lets read-scoped API keys read but not change the graph", async () => {
    getStatusMock.mockResolvedValue({ workspaceId: "ws-1" });
    const app = buildApp({ scopes: ["search"], keyType: "server" });
    expect((await app.request("/v1/workspaces/ws-1/graph")).status).toBe(200);
    const denied = await app.request("/v1/workspaces/ws-1/graph/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    expect(startMock).not.toHaveBeenCalled();
  });

  it("streams job progress until the job finishes", async () => {
    getJobMock
      .mockResolvedValueOnce(job("running", 1))
      .mockResolvedValueOnce(job("completed", 3));
    const response = await buildApp().request("/v1/workspaces/ws-1/graph/jobs/job-1/events");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    const events = [...body.matchAll(/event: (\w+)\ndata: (.+)\n/g)].map(([, event, data]) => [event, JSON.parse(data!).documentsProcessed]);
    expect(events).toEqual([["progress", 1], ["progress", 3], ["done", 3]]);
  });
});
