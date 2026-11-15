import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const updateMock = vi.fn();
const auditMock = vi.fn();
const getProjectMock = vi.fn();

class MockProjectSummaryTreeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

vi.mock("../services/project-summary-tree.js", () => ({
  getProjectSummaryTree: getMock,
  updateProjectSummaryTree: updateMock,
  ProjectSummaryTreeError: MockProjectSummaryTreeError,
}));
vi.mock("../services/projects.js", () => ({ getProject: getProjectMock }));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: auditMock }));
vi.mock("../lib/request-context.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-context.js")>("../lib/request-context.js");
  return { ...actual, requestIp: vi.fn(() => "127.0.0.1") };
});

const { projectSummaryTreeRoutes } = await import("../routes/project-summary-tree.js");

function buildApp(apiKey?: { scopes: string[]; keyType: "server" | "client"; orgId?: string }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "Test User" } as never);
    if (apiKey) c.set("apiKey", { userId: "user-1", orgId: "org-1", ...apiKey } as never);
    await next();
  });
  app.route("/v1/projects", projectSummaryTreeRoutes);
  return app;
}

const patch = (app: Hono, body: unknown) => app.request("/v1/projects/ws-1/summary-tree", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("project summary tree routes", () => {
  beforeEach(() => {
    for (const mock of [getMock, updateMock, auditMock, getProjectMock]) mock.mockReset();
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
  });

  it("returns the state", async () => {
    getMock.mockResolvedValue({ enabled: false, status: "off" });
    const response = await buildApp().request("/v1/projects/ws-1/summary-tree");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, status: "off" });
    expect(getMock).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("accepts only { enabled } and records the change", async () => {
    updateMock.mockResolvedValue({ enabled: true, status: "ready" });
    const app = buildApp();
    const ok = await patch(app, { enabled: true });
    expect(ok.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith("ws-1", "user-1", { enabled: true });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.summary_tree.updated", orgId: "org-1", projectId: "ws-1", metadata: { enabled: true },
    }));

    updateMock.mockClear();
    for (const body of [{}, { enabled: "yes" }, { enabled: true, groupSize: 3 }, { enabled: true, prompt: "be brief" }, { pipeline: { summaryTree: { enabled: true } } }]) {
      expect((await patch(app, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("answers a refused enable with its code, and records nothing", async () => {
    updateMock.mockRejectedValue(new MockProjectSummaryTreeError("The summary tree is not available on this deployment.", 400, "summary_tree_unavailable"));
    const response = await patch(buildApp(), { enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "summary_tree_unavailable", message: "The summary tree is not available on this deployment." } });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("lets read-scoped server keys read but not change it", async () => {
    getMock.mockResolvedValue({ enabled: false });
    const app = buildApp({ scopes: ["search:deep"], keyType: "server" });
    expect((await app.request("/v1/projects/ws-1/summary-tree")).status).toBe(200);
    expect((await patch(app, { enabled: true })).status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses client keys, wrong-scope keys and keys for a project they cannot use", async () => {
    getMock.mockResolvedValue({ enabled: false });
    // A client (browser) key never changes project settings, even holding the scope.
    expect((await patch(buildApp({ scopes: ["projects:manage"], keyType: "client" }), { enabled: true })).status).toBe(403);
    expect((await buildApp({ scopes: ["search:deep"], keyType: "client" }).request("/v1/projects/ws-1/summary-tree")).status).toBe(403);
    expect((await buildApp({ scopes: [], keyType: "server" }).request("/v1/projects/ws-1/summary-tree")).status).toBe(403);
    // A managing key bound to another organization: the project does not exist for it.
    getProjectMock.mockResolvedValue(null);
    const foreign = buildApp({ scopes: ["projects:manage"], keyType: "server", orgId: "org-2" });
    expect((await patch(foreign, { enabled: true })).status).toBe(404);
    expect((await foreign.request("/v1/projects/ws-1/summary-tree")).status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("lets a managing server key change it", async () => {
    updateMock.mockResolvedValue({ enabled: false, status: "off" });
    const response = await patch(buildApp({ scopes: ["projects:manage"], keyType: "server" }), { enabled: false });
    expect(response.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith("ws-1", "user-1", { enabled: false });
  });
});
