import { Hono } from "hono";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getIngestReport,
  getMessageText,
  getWorkspaceMeta,
  type WorkspaceChatUIMessage,
  workspaceChatDataPartSchemas,
} from "@docslurp/shared/workspace-chat-ui";

const appendAuditLogMock = vi.fn();
const archiveWorkspaceMock = vi.fn();
const createWorkspaceMock = vi.fn();
const deleteWorkspaceMock = vi.fn();
const getWorkspaceMock = vi.fn();
const getWorkspaceStateMock = vi.fn();
const listWorkspaceTagsMock = vi.fn();
vi.mock("../services/workspace-tags.js", () => ({ listWorkspaceTags: listWorkspaceTagsMock }));
vi.mock("../services/workspace-state.js", () => ({ getWorkspaceState: getWorkspaceStateMock }));
const chatWorkspaceMock = vi.fn();
const workspaceChatDisabledBodyMock = vi.fn(async (_workspaceId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null);
const listWorkspaceBoardRecordsMock = vi.fn(async () => []);
const listWorkspacesMock = vi.fn(async () => []);
const inviteWorkspaceMemberMock = vi.fn();
const removeWorkspaceMemberMock = vi.fn();
const restoreWorkspaceMock = vi.fn();
const revokeWorkspaceInviteMock = vi.fn();
const getWorkspaceSearchSettingsForUserMock = vi.fn();
const hybridSearchMock = vi.fn();
const updateWorkspaceSearchSettingsForUserMock = vi.fn();
const updateWorkspaceMock = vi.fn();
const updateWorkspaceMemberRoleMock = vi.fn();

vi.mock("../services/workspaces.js", () => ({
  archiveWorkspace: archiveWorkspaceMock,
  ensurePersonalDefaultWorkspace: vi.fn(async () => {}),
  cloneWorkspace: vi.fn(),
  createWorkspace: createWorkspaceMock,
  deleteWorkspace: deleteWorkspaceMock,
  getWorkspace: getWorkspaceMock,
  getWorkspaceCockpit: vi.fn(),
  getWorkspaceTraceFeed: vi.fn(),
  listWorkspaceBoardRecords: listWorkspaceBoardRecordsMock,
  listWorkspaceVersions: vi.fn(),
  listWorkspaces: listWorkspacesMock,
  restoreWorkspace: restoreWorkspaceMock,
  rollbackWorkspaceVersion: vi.fn(),
  updateWorkspace: updateWorkspaceMock,
  WorkspaceSlugError: class WorkspaceSlugError extends Error {
    constructor(message: string, readonly status: 400 | 409) { super(message); }
  },
}));

vi.mock("../services/config-change.js", () => ({
  planWorkspaceChange: vi.fn(async (args: { workspaceId: string; input: unknown }) => ({ workspace: { id: args.workspaceId }, input: args.input })),
  applyWorkspaceChange: vi.fn(async ({ plan, userId, updateOptions }: { plan: { workspace: { id: string }; input: unknown }; userId: string; updateOptions?: unknown }) => {
    const workspace = await updateWorkspaceMock(plan.workspace.id, userId, plan.input, ...(updateOptions ? [updateOptions] : []));
    return workspace ? { workspace, plan, job: null, queuedRunIds: [] } : null;
  }),
  estimateWorkspaceChange: vi.fn(),
  billingState: () => "disabled",
}));

vi.mock("../services/workspace-chat.js", () => ({
  chatWorkspace: chatWorkspaceMock,
  workspaceChatDisabledBody: workspaceChatDisabledBodyMock,
}));

vi.mock("../services/search.js", () => ({
  hybridSearch: hybridSearchMock,
}));

vi.mock("../services/search-controls.js", () => ({
  getWorkspaceSearchSettingsForUser: getWorkspaceSearchSettingsForUserMock,
  updateWorkspaceSearchSettingsForUser: updateWorkspaceSearchSettingsForUserMock,
}));

const loadIngestReportMock = vi.fn();
const applyIngestRecommendationMock = vi.fn();
const reprocessIngestRecommendationMock = vi.fn();
const getWorkspaceAccessMock = vi.fn(async (): Promise<unknown> => ({ role: "editor" }));
const canEditWorkspaceMock = vi.fn(() => true);
class IngestReportActionErrorMock extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409) { super(message); }
}
vi.mock("../services/ingest-report.js", () => ({
  loadIngestReport: loadIngestReportMock,
  applyIngestRecommendation: applyIngestRecommendationMock,
  reprocessIngestRecommendation: reprocessIngestRecommendationMock,
  IngestReportActionError: IngestReportActionErrorMock,
}));

vi.mock("../services/organizations.js", () => ({
  canEditWorkspace: canEditWorkspaceMock,
  getWorkspaceAccess: getWorkspaceAccessMock,
  acceptWorkspaceInvite: vi.fn(),
  inviteWorkspaceMember: inviteWorkspaceMemberMock,
  listWorkspaceInvites: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  removeWorkspaceMember: removeWorkspaceMemberMock,
  revokeWorkspaceInvite: revokeWorkspaceInviteMock,
  updateWorkspaceMemberRole: updateWorkspaceMemberRoleMock,
}));

vi.mock("../services/audit-log.js", () => ({
  appendAuditLog: appendAuditLogMock,
}));

vi.mock("../lib/request-context.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-context.js")>("../lib/request-context.js");
  return {
    ...actual,
    requestIp: vi.fn(() => "127.0.0.1"),
    requestUserAgent: vi.fn(() => "vitest"),
  };
});

const { workspacesRoutes } = await import("../routes/workspaces.js");

function buildApp(apiKey?: { orgId: string | null; scopes: string[]; keyType?: string; keyId?: string }) {
  const app = new Hono();
  app.use("/workspaces/*", async (c, next) => {
    c.set("sessionUser", {
      id: "demo-user",
      email: "demo@example.com",
      name: "Demo User",
    });
    if (apiKey) c.set("apiKey", { keyType: "server", ...apiKey } as never);
    await next();
  });
  app.route("/workspaces", workspacesRoutes);
  return app;
}

describe("workspacesRoutes validation", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    appendAuditLogMock.mockReset();
    archiveWorkspaceMock.mockReset();
    createWorkspaceMock.mockReset();
    deleteWorkspaceMock.mockReset();
    getWorkspaceMock.mockReset();
    getWorkspaceStateMock.mockReset();
    chatWorkspaceMock.mockReset();
    listWorkspaceBoardRecordsMock.mockReset();
    getWorkspaceSearchSettingsForUserMock.mockReset();
    hybridSearchMock.mockReset();
    inviteWorkspaceMemberMock.mockReset();
    removeWorkspaceMemberMock.mockReset();
    restoreWorkspaceMock.mockReset();
    revokeWorkspaceInviteMock.mockReset();
    updateWorkspaceSearchSettingsForUserMock.mockReset();
    updateWorkspaceMock.mockReset();
    updateWorkspaceMemberRoleMock.mockReset();
    loadIngestReportMock.mockReset();
    applyIngestRecommendationMock.mockReset();
    reprocessIngestRecommendationMock.mockReset();
    getWorkspaceAccessMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns current workspace state with a validated window for an authorized server key", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    getWorkspaceStateMock.mockResolvedValue({ workspaceId: "ws-1", pages: { indexed: 2, notIndexed: 1 } });
    const response = await buildApp({ orgId: "org-1", scopes: ["search"] }).request("/workspaces/ws-1/state?recentWindowHours=48");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ pages: { indexed: 2, notIndexed: 1 } });
    expect(getWorkspaceStateMock).toHaveBeenCalledWith({ workspaceId: "ws-1", orgId: "org-1", recentWindowHours: 48 });
  });

  it("rejects cross-organization, public, and unscoped keys before computing state", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    for (const [key, status] of [
      [{ orgId: "other-org", scopes: ["search"] }, 404],
      [{ orgId: "org-1", scopes: ["search"], keyType: "public" }, 403],
      [{ orgId: "org-1", scopes: ["chat"] }, 403],
    ] as const) {
      const response = await buildApp({ ...key, scopes: [...key.scopes] }).request("/workspaces/ws-1/state");
      expect(response.status).toBe(status);
    }
    expect(getWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it("validates workspace state windows and conceals inaccessible workspaces", async () => {
    const bad = await app.request("/workspaces/ws-1/state?recentWindowHours=721");
    expect(bad.status).toBe(400);
    getWorkspaceMock.mockResolvedValue(null);
    expect((await app.request("/workspaces/ws-1/state")).status).toBe(404);
    expect(getWorkspaceStateMock).not.toHaveBeenCalled();
  });

  it("returns the ingest report for the authorized workspace, with edit rights from the member's role", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "W" });
    loadIngestReportMock.mockResolvedValue({ workspaceId: "ws-1", files: { total: 2 } });
    canEditWorkspaceMock.mockReturnValueOnce(false);
    const response = await app.request("/workspaces/ws-1/ingest-report?runId=run-9&documentIds=a,b,a");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ files: { total: 2 } });
    expect(loadIngestReportMock).toHaveBeenCalledWith({
      workspace: expect.objectContaining({ id: "ws-1" }), canEdit: false, runId: "run-9", documentIds: ["a", "b"],
    });
    expect(getWorkspaceMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("conceals inaccessible workspaces and rejects foreign, public or unscoped keys before building a report", async () => {
    getWorkspaceMock.mockResolvedValue(null);
    expect((await app.request("/workspaces/ws-1/ingest-report")).status).toBe(404);
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    for (const [key, status] of [
      [{ orgId: "other-org", scopes: ["search"] }, 404],
      [{ orgId: "org-1", scopes: ["search"], keyType: "public" }, 403],
      [{ orgId: "org-1", scopes: ["chat"] }, 403],
    ] as const) {
      const response = await buildApp({ ...key, scopes: [...key.scopes] }).request("/workspaces/ws-1/ingest-report");
      expect(response.status).toBe(status);
    }
    const tooMany = Array.from({ length: 101 }, (_, index) => `d${index}`).join(",");
    expect((await app.request(`/workspaces/ws-1/ingest-report?documentIds=${tooMany}`)).status).toBe(400);
    expect(loadIngestReportMock).not.toHaveBeenCalled();
  });

  it("gives a search-only key a read-only report and an ingest key the editor's actions", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    loadIngestReportMock.mockResolvedValue({ workspaceId: "ws-1" });
    const response = await buildApp({ orgId: "org-1", scopes: ["search"] }).request("/workspaces/ws-1/ingest-report");
    expect(response.status).toBe(200);
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false }));
    await buildApp({ orgId: "org-1", scopes: ["ingest"] }).request("/workspaces/ws-1/ingest-report");
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: true }));
    // The key never exceeds its user's role.
    canEditWorkspaceMock.mockReturnValueOnce(false);
    await buildApp({ orgId: "org-1", scopes: ["ingest"] }).request("/workspaces/ws-1/ingest-report");
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false }));
  });

  it("applies a recommendation, audits it and maps editor and conflict errors", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    applyIngestRecommendationMock.mockResolvedValueOnce({
      workspace: { id: "ws-1", orgId: "org-1", pipeline: {} }, recommendation: { patch: { preserveTables: true } }, pipeline: { preserveTables: true },
    });
    const ok = await app.request("/workspaces/ws-1/ingest-report/apply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
    });
    expect(ok.status).toBe(200);
    expect(applyIngestRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "demo-user", recommendationId: "preserve-tables", runId: null }));
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.updated", workspaceId: "ws-1", metadata: expect.objectContaining({ source: "ingest-report", patch: { preserveTables: true } }),
    }));

    for (const status of [403, 409] as const) {
      applyIngestRecommendationMock.mockRejectedValueOnce(new IngestReportActionErrorMock("nope", status));
      const response = await app.request("/workspaces/ws-1/ingest-report/apply", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
      });
      expect(response.status).toBe(status);
    }
    // The change itself always comes from the server: unknown body fields are not passed on.
    const injected = await app.request("/workspaces/ws-1/ingest-report/apply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "x".repeat(65) }),
    });
    expect(injected.status).toBe(400);
  });

  it("accepts API keys on the report and its actions", async () => {
    const { listRouteAuthModes } = await import("../lib/route-auth.js");
    const modes = Object.fromEntries(listRouteAuthModes(workspacesRoutes).map((route) => [`${route.method} ${route.path}`, route.mode]));
    expect(modes["GET /:workspaceId/ingest-report"]).toBe("apiKey");
    expect(modes["POST /:workspaceId/ingest-report/apply"]).toBe("apiKey");
    expect(modes["POST /:workspaceId/ingest-report/reprocess"]).toBe("apiKey");
    expect(modes["POST /:workspaceId/documents/bulk/estimate"]).toBe("apiKey");
  });

  it("lets an ingest server key reprocess findings and a workspaces:manage key apply them, in its own workspaces only", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    reprocessIngestRecommendationMock.mockResolvedValue({ runs: [{ id: "run-2" }], documentIds: ["d1"], skippedDocuments: 0, estimatedCents: 1 });
    applyIngestRecommendationMock.mockResolvedValue({
      workspace: { id: "ws-1", orgId: "org-1", pipeline: {} }, recommendation: { patch: { preserveTables: true } }, pipeline: { preserveTables: true },
    });
    const post = (key: Parameters<typeof buildApp>[0], action: "apply" | "reprocess") => buildApp(key).request(`/workspaces/ws-1/ingest-report/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
    });
    for (const [key, action, status] of [
      [{ orgId: "org-1", scopes: ["search"] }, "reprocess", 403],
      [{ orgId: "org-1", scopes: ["ingest"], keyType: "client" }, "reprocess", 403],
      [{ orgId: "other-org", scopes: ["ingest"] }, "reprocess", 404],
      [{ orgId: "org-1", scopes: ["ingest"] }, "apply", 403],
      [{ orgId: "org-1", scopes: ["workspaces:manage"], keyType: "client" }, "apply", 403],
      [{ orgId: "other-org", scopes: ["workspaces:manage"] }, "apply", 404],
    ] as const) {
      expect((await post({ ...key, scopes: [...key.scopes] }, action)).status, `${action} ${JSON.stringify(key)}`).toBe(status);
    }
    expect(reprocessIngestRecommendationMock).not.toHaveBeenCalled();
    expect(applyIngestRecommendationMock).not.toHaveBeenCalled();

    expect((await post({ orgId: "org-1", scopes: ["ingest"], keyId: "key-1" }, "reprocess")).status).toBe(201);
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "documents.bulk_reprocessed", apiKeyId: "key-1" }));
    expect((await post({ orgId: "org-1", scopes: ["workspaces:manage"], keyId: "key-2" }, "apply")).status).toBe(200);
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "workspace.updated", apiKeyId: "key-2" }));
  });

  it("reprocesses a recommendation's files and audits the runs", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    reprocessIngestRecommendationMock.mockResolvedValueOnce({ runs: [{ id: "run-2" }], documentIds: ["d1"], skippedDocuments: 0, estimatedCents: 1.5 });
    const response = await app.request("/workspaces/ws-1/ingest-report/reprocess", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "vision-all-pages" }),
    });
    expect(response.status).toBe(201);
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "documents.bulk_reprocessed", metadata: expect.objectContaining({ source: "ingest-report", runs: ["run-2"], estimatedCents: 1.5 }),
    }));
  });

  it("returns 400 for unsupported embedding models on workspace create", async () => {
    const response = await app.request("/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "demo-user",
        name: "Contracts",
        pipeline: {
          embedding: {
            modelUri: "not-a-real-model",
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "pipeline.embedding.modelUri" }),
          ]),
        },
      },
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns the batched workspace board payload", async () => {
    listWorkspaceBoardRecordsMock.mockResolvedValue([
      {
        workspace: {
          id: 'ws-1',
          orgId: 'org-1',
          userId: 'demo-user',
          name: 'Contracts',
          templateKey: null,
          systemPrompt: null,
          pipeline: {},
          monthlyBudgetCents: null,
          documentCount: 3,
          runCount: 2,
          latestRunId: 'run-1',
          latestRunStatus: 'processing',
          archivedAt: null,
          lastActivityAt: '2026-03-27T00:00:00.000Z',
          createdAt: '2026-03-27T00:00:00.000Z',
          updatedAt: '2026-03-27T00:00:00.000Z'
        },
        run: null,
        snapshot: null,
        summary: {
          totalDocuments: 3,
          totalPages: 12,
          processedPages: 4,
          completedRuns: 1,
          indexedBytes: 4096,
          avgCompletedRunMs: 42000,
          searchSessions: 8
        }
      }
    ] as never);

    const response = await app.request('/workspaces/board');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          workspace: expect.objectContaining({ id: 'ws-1' }),
          summary: expect.objectContaining({ totalPages: 12 })
        })
      ]
    });
    expect(listWorkspaceBoardRecordsMock).toHaveBeenCalledWith('demo-user');
  });

  it("returns 400 for unsupported embedding models on workspace update", async () => {
    const response = await app.request("/workspaces/ws-1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        pipeline: {
          embedding: {
            modelUri: "not-a-real-model",
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "pipeline.embedding.modelUri" }),
          ]),
        },
      },
    });
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("updates workspace member role and records an audit entry", async () => {
    updateWorkspaceMemberRoleMock.mockResolvedValue({
      workspaceId: "ws-1",
      userId: "member-1",
      email: "member@example.com",
      name: "Member",
      role: "editor",
      invitedByUserId: "owner-1",
      createdAt: "2026-03-12T00:00:00.000Z",
    });

    const response = await app.request("/workspaces/ws-1/members/member-1", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        role: "editor",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "ws-1",
      userId: "member-1",
      role: "editor",
    });
    expect(updateWorkspaceMemberRoleMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "demo-user",
      memberUserId: "member-1",
      role: "editor",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.member.updated",
      resourceId: "ws-1:member-1",
    }));
  });

  it("has no add-by-user-ID route for workspace members", async () => {
    const response = await app.request("/workspaces/ws-1/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberUserId: "member-1", role: "viewer" }),
    });
    expect(response.status).toBe(404);
  });

  it("streams workspace search updates until results are available", async () => {
    getWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
    });
    hybridSearchMock
      .mockResolvedValueOnce({
        results: [],
        sessionId: "search-1",
        availability: {
          status: "pending",
          isPartial: true,
          scope: {
            workspaceId: "ws-1",
            runId: null,
          },
          coverage: {
            totalDocuments: 2,
            indexedDocuments: 1,
            pageIndexedDocuments: 0,
            searchableDocuments: 1,
            pageOnlyDocuments: 0,
            inProgressDocuments: 1,
            totalPages: 10,
            searchablePages: 4,
            indexedChunkCount: 6,
            queuedRuns: 0,
            processingRuns: 1,
          },
          resultBreakdown: {
            indexedResultCount: 0,
            pageResultCount: 0,
          },
          message: "Search is still warming up for this scope. 1/2 documents are searchable so far.",
        },
      })
      .mockResolvedValueOnce({
        results: [
          {
            text: "Class list",
            score: 0.91,
            citation: {
              source: "document",
              documentId: "doc-1",
              filename: "class-list.pdf",
              pageNumber: 1,
              pageNumbers: [1],
              headingPath: [],
              chunkIndex: 0,
              blockIds: [],
              blockTypes: [],
              regionBoxes: [],
              regions: [],
              regionCoordinateSpace: null,
            },
          },
        ],
        sessionId: "search-1",
        availability: {
          status: "partial",
          isPartial: true,
          scope: {
            workspaceId: "ws-1",
            runId: null,
          },
          coverage: {
            totalDocuments: 2,
            indexedDocuments: 2,
            pageIndexedDocuments: 1,
            searchableDocuments: 2,
            pageOnlyDocuments: 0,
            inProgressDocuments: 0,
            totalPages: 10,
            searchablePages: 10,
            indexedChunkCount: 12,
            queuedRuns: 0,
            processingRuns: 0,
          },
          resultBreakdown: {
            indexedResultCount: 1,
            pageResultCount: 0,
          },
          message: "Search now covers 2/2 documents.",
        },
      });

    const response = await app.request("/workspaces/ws-1/search/stream?q=class%20list");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await response.text();
    expect(body).toContain("event: status");
    expect(body).toContain("Running workspace search");
    expect(body).toContain("event: results");
    expect(body).toContain("\"status\":\"pending\"");
    expect(body).toContain("\"status\":\"partial\"");
    expect(body).toContain("event: done");
    expect(hybridSearchMock).toHaveBeenCalledTimes(2);
    expect(hybridSearchMock).toHaveBeenNthCalledWith(
      1,
      "class list",
      "demo-user",
      expect.objectContaining({
        rootSessionId: expect.any(String),
        filters: expect.objectContaining({
          workspaceId: "ws-1",
        }),
      }),
    );
    expect(hybridSearchMock).toHaveBeenNthCalledWith(
      2,
      "class list",
      "demo-user",
      expect.objectContaining({
        rootSessionId: expect.any(String),
        filters: expect.objectContaining({
          workspaceId: "ws-1",
        }),
      }),
    );
    expect(hybridSearchMock.mock.calls[0]?.[2].rootSessionId).toBe(
      hybridSearchMock.mock.calls[1]?.[2].rootSessionId,
    );
  });

  it("finishes an empty workspace search without a second retrieval", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "empty-search",
      availability: { status: "empty", coverage: { queuedRuns: 0, processingRuns: 0 } },
    });
    const response = await app.request("/workspaces/ws-1/search/stream?q=missing");
    const body = await response.text();
    expect(body).toContain("event: results");
    expect(body).toContain('"sessionId":"empty-search"');
    expect(body).toContain("event: done");
    expect(hybridSearchMock).toHaveBeenCalledTimes(1);
  });

  it("stops polling while indexing once a search branch hit the statement timeout", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "timed-out",
      timings: { textMs: 8000, lexicalTimeout: 1 },
      availability: { status: "pending", coverage: { queuedRuns: 1, processingRuns: 1 } },
    });
    const body = await (await app.request("/workspaces/ws-1/search/stream?q=broad")).text();
    expect(body).toContain("event: done");
    expect(hybridSearchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves omitted stream search flags to the workspace defaults and honours graph and multi-hop flags", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "flags",
      availability: { status: "empty", coverage: { queuedRuns: 0, processingRuns: 0 } },
    });
    await (await app.request("/workspaces/ws-1/search/stream?q=x&rerank=false&graphExpansion=true&iterativeMultiHop=true&graphHops=2")).text();
    const options = hybridSearchMock.mock.calls[0]?.[2];
    expect(options).toMatchObject({ useRerank: false, enableGraphExpansion: true, iterativeMultiHop: true, graphHops: 2 });
    expect(options.useHyDE).toBeUndefined();
    expect(options.useMmr).toBeUndefined();
    expect(options.parentRetrieval).toBeUndefined();
  });

  it("forwards composer retrieval overrides and filters, and rejects invalid ones", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatWorkspaceMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const ok = await app.request("/workspaces/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "hi", retrieval: { resultCount: 6, useRerank: false }, filters: { tags: ["legal"], dateTo: "2026-10-01" } }) });
    expect(ok.status).toBe(200);
    expect(chatWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({
      retrieval: { resultCount: 6, useRerank: false },
      filters: { tags: ["legal"], dateTo: "2026-10-01" },
    }));

    chatWorkspaceMock.mockClear();
    const bad = await app.request("/workspaces/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "hi", retrieval: { resultCount: 99 } }) });
    expect(bad.status).toBe(400);
    expect(chatWorkspaceMock).not.toHaveBeenCalled();
  });

  it("disables tools and configuration writes for automatic transport recovery", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatWorkspaceMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const response = await app.request("/workspaces/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "ingest these sources", retrievalOnly: true }) });
    expect(response.status).toBe(200);
    expect(chatWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ actor: undefined, allowConfiguration: false }));
  });

  it("maps composer toggles to agent modes: web off and suggestions on unless the user changes them", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatWorkspaceMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const send = (body: Record<string, unknown>) => app.request("/workspaces/ws-1/chat", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "hi", ...body }) });
    await send({});
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: true } }));
    await send({ webTools: true, suggestions: false });
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: true, suggestions: false } }));
    // Only a literal true turns web tools on.
    await send({ webTools: "yes" });
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: true } }));
  });

  it("keeps suggestions opt-in for API keys calling the dashboard chat routes", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatWorkspaceMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const keyApp = buildApp({ orgId: "org-1", scopes: ["search"] });
    const send = (body: Record<string, unknown>) => keyApp.request("/workspaces/ws-1/chat", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "hi", ...body }) });
    chatWorkspaceMock.mockClear();
    await send({});
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: false } }));
    await send({ suggestions: true });
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: true } }));
  });

  it("streams the turn's agent modes in workspace metadata", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatWorkspaceMock.mockResolvedValue({
      id: "answer-3", sessionId: "session-3", searchSessionId: null, answer: "Done.",
      citations: [], evidenceSpans: [], availability: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costCents: 0 },
      runtime: { startedAt: "2026-10-24T00:00:00.000Z", completedAt: "2026-10-24T00:00:00.010Z", totalMs: 10 },
      debug: { citations: 0, model: "m", fallback: false, historyTurns: 0, mode: "retrieval", modes: { web: "unavailable", suggestions: true },
        wholeCorpus: { attempted: false, eligible: false, documentCount: null, chunkCount: null, tokenEstimate: null, charEstimate: null, maxDocuments: 1, maxChunks: 1, maxTokens: 1, maxChars: 1, fallbackReason: null } },
    });
    const transport = new DefaultChatTransport<WorkspaceChatUIMessage>({
      api: "http://localhost/workspaces/ws-1/chat/workspace-agent",
      body: { webTools: true },
      fetch: async (input, init) => app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<WorkspaceChatUIMessage>({ id: "thread-3", messages: [], transport, dataPartSchemas: workspaceChatDataPartSchemas });
    await chat.sendMessage({ text: "Search the web for pricing" });
    expect(chat.error).toBeUndefined();
    expect(getWorkspaceMeta(chat.messages.at(-1)!)?.modes).toEqual({ web: "unavailable", suggestions: true });
    expect(chatWorkspaceMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: true, suggestions: true } }));
  });

  it("returns 403 from workspace chat routes when the workspace turned chat off", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    workspaceChatDisabledBodyMock.mockResolvedValue({ error: "Chat is turned off for this workspace.", code: "chat_disabled" });
    try {
      const agent = await app.request("/workspaces/ws-1/chat/workspace-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] }),
      });
      expect(agent.status).toBe(403);
      expect(await agent.json()).toMatchObject({ error: { code: "chat_disabled" } });

      const plain = await app.request("/workspaces/ws-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "Hi" }),
      });
      expect(plain.status).toBe(403);
      expect(chatWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      workspaceChatDisabledBodyMock.mockResolvedValue(null);
    }
  });

  it("streams workspace chat responses through the AI SDK chat transport", async () => {
    getWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
    });
    chatWorkspaceMock.mockImplementation(
      async (args: {
        onTextDelta?: (delta: string) => void | Promise<void>;
      }) => {
        await args.onTextDelta?.("The streamed ");
        await args.onTextDelta?.("answer loaded.");
        return {
          id: "answer-1",
          sessionId: "session-1",
          searchSessionId: "search-1",
          answer: "The streamed answer loaded.",
          citations: [],
          evidenceSpans: [],
          availability: null,
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            totalTokens: 19,
          },
          runtime: {
            startedAt: "2026-05-31T00:00:00.000Z",
            completedAt: "2026-05-31T00:00:01.000Z",
            totalMs: 1000,
          },
          debug: {
            citations: 0,
            model: "fallback-model",
            fallback: false,
            historyTurns: 0,
            mode: "retrieval",
            wholeCorpus: {
              attempted: true,
              eligible: false,
              documentCount: null,
              chunkCount: null,
              tokenEstimate: null,
              charEstimate: null,
              maxDocuments: 20,
              maxChunks: 200,
              maxTokens: 100000,
              maxChars: 400000,
              fallbackReason: null,
            },
          },
        };
      },
    );

    const transport = new DefaultChatTransport<WorkspaceChatUIMessage>({
      api: "http://localhost/workspaces/ws-1/chat/workspace-agent",
      credentials: "include",
      body: {
        sessionId: "session-1",
        model: "anthropic/claude-haiku-5.5",
      },
      fetch: async (input, init) =>
        app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<WorkspaceChatUIMessage>({
      id: "thread-1",
      messages: [],
      transport,
      dataPartSchemas: workspaceChatDataPartSchemas,
    });

    await chat.sendMessage({ text: "What changed?" });

    expect(chat.status).toBe("ready");
    expect(chat.error).toBeUndefined();
    const assistantMessage = chat.messages.at(-1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(getMessageText(assistantMessage!)).toBe(
      "The streamed answer loaded.",
    );
    expect(getWorkspaceMeta(assistantMessage!)?.sessionId).toBe("session-1");
    expect(chatWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        userId: "demo-user",
        query: "What changed?",
        sessionId: "session-1",
        model: "anthropic/claude-haiku-5.5",
        onTextDelta: expect.any(Function),
      }),
    );
  });

  it("streams the ingest report as a data part when chat answers /status", async () => {
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    const { buildIngestReport } = await vi.importActual<typeof import("../services/ingest-report.js")>("../services/ingest-report.js");
    const { defaultPipelineFeatures } = await import("@docslurp/shared");
    const report = buildIngestReport({
      workspace: { id: "ws-1", name: "W", pipeline: defaultPipelineFeatures },
      scope: { runId: null, documentIds: null, matchedDocuments: 0 },
      documents: [], pageDetailDocumentIds: [], pages: [], stages: [], runs: [], costCents: null, canEdit: true,
    });
    chatWorkspaceMock.mockResolvedValue({
      id: "answer-2", sessionId: "session-2", searchSessionId: null, answer: "**Ingest report** for W: no files yet.",
      citations: [], evidenceSpans: [], availability: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      runtime: { startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:00.010Z", totalMs: 10 },
      debug: { citations: 0, model: null, fallback: false, historyTurns: 0, mode: "retrieval", wholeCorpus: { attempted: false, eligible: false, documentCount: null, chunkCount: null, tokenEstimate: null, charEstimate: null, maxDocuments: 1, maxChunks: 1, maxTokens: 1, maxChars: 1, fallbackReason: null } },
      ingestReport: report,
    });
    const transport = new DefaultChatTransport<WorkspaceChatUIMessage>({
      api: "http://localhost/workspaces/ws-1/chat/workspace-agent",
      fetch: async (input, init) => app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<WorkspaceChatUIMessage>({ id: "thread-2", messages: [], transport, dataPartSchemas: workspaceChatDataPartSchemas });
    await chat.sendMessage({ text: "/status" });
    expect(chat.error).toBeUndefined();
    const assistant = chat.messages.at(-1)!;
    expect(getIngestReport(assistant)?.workspaceId).toBe("ws-1");
    expect(getWorkspaceMeta(assistant)).toMatchObject({ sessionId: "session-2", mode: "ingest-report" });
    expect(getMessageText(assistant)).toContain("Ingest report");
    // Only the signed-in dashboard chat may answer with the report.
    expect(chatWorkspaceMock).toHaveBeenCalledWith(expect.objectContaining({ query: "/status", answerIngestReport: true }));
  });

  it("keeps workspace chat streams alive while answer generation is pending", async () => {
    vi.useFakeTimers();
    getWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
    });

    let resolveChat: (value: unknown) => void = () => {};
    chatWorkspaceMock.mockReturnValue(
      new Promise((resolve) => {
        resolveChat = resolve;
      }),
    );

    const response = await app.request("/workspaces/ws-1/chat/workspace-agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "thread-1",
        messages: [
          {
            id: "user-1",
            role: "user",
            parts: [{ type: "text", text: "What changed?" }],
          },
        ],
        sessionId: "session-1",
        model: "anthropic/claude-haiku-5.5",
      }),
    });

    const bodyPromise = response.text();
    const evidence = [{ text: "Source passage", score: 1, citation: { documentId: "doc-1", chunkIndex: 0, filename: "guide.pdf", pageNumber: 1, headingPath: [] } }];
    chatWorkspaceMock.mock.calls.at(-1)?.[0].onEvidence?.(evidence);
    await vi.advanceTimersByTimeAsync(11_000);
    resolveChat({
      id: "answer-1",
      sessionId: "session-1",
      searchSessionId: "search-1",
      answer: "The streamed answer loaded.",
      citations: [],
      evidenceSpans: [],
      availability: null,
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        totalTokens: 19,
      },
      runtime: {
        startedAt: "2026-05-31T00:00:00.000Z",
        completedAt: "2026-05-31T00:00:01.000Z",
        totalMs: 1000,
      },
      debug: {
        citations: 0,
        model: "fallback-model",
        fallback: false,
        historyTurns: 0,
        mode: "retrieval",
        wholeCorpus: {
          attempted: true,
          eligible: false,
          documentCount: null,
          chunkCount: null,
          tokenEstimate: null,
          charEstimate: null,
          maxDocuments: 20,
          maxChunks: 200,
          maxTokens: 100000,
          maxChars: 400000,
          fallbackReason: null,
        },
      },
    });

    const body = await bodyPromise;

    expect(body).toContain("Writing grounded answer");
    expect(body.indexOf("guide.pdf")).toBeLessThan(body.indexOf("The streamed answer loaded."));
    expect(body).toContain("1 source passages retrieved");
    expect(body).toContain("The streamed answer loaded.");
  });

  it("removes a workspace member and records an audit entry", async () => {
    removeWorkspaceMemberMock.mockResolvedValue(true);

    const response = await app.request("/workspaces/ws-1/members/member-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(removeWorkspaceMemberMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "demo-user",
      memberUserId: "member-1",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.member.removed",
      resourceId: "ws-1:member-1",
    }));
  });

  it("revokes a workspace invite and records an audit entry", async () => {
    revokeWorkspaceInviteMock.mockResolvedValue({
      id: "invite-1",
      workspaceId: "ws-1",
      orgId: "org-1",
      email: "invitee@example.com",
      role: "editor",
      token: "token-1",
      status: "revoked",
      invitedByUserId: "demo-user",
      acceptedByUserId: null,
      expiresAt: "2026-03-19T00:00:00.000Z",
      acceptedAt: null,
      createdAt: "2026-03-12T00:00:00.000Z",
    });

    const response = await app.request("/workspaces/ws-1/invites/invite-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "invite-1",
      workspaceId: "ws-1",
      status: "revoked",
    });
    expect(revokeWorkspaceInviteMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "demo-user",
      inviteId: "invite-1",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.invite.revoked",
      resourceId: "invite-1",
    }));
  });

  it.each(["archive", "restore"])("preserves access status while sanitizing %s failures", async action => {
    const handler = action === "archive" ? archiveWorkspaceMock : restoreWorkspaceMock;
    for (const [cause, status] of [["Forbidden", 403], ["Workspace not found", 404]] as const) {
      handler.mockRejectedValueOnce(new Error(cause));
      const response = await app.request(`/workspaces/ws-1/${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationText: "Contracts" }),
      });
      expect(response.status).toBe(status);
      expect((await response.json()).error).toMatchObject({
        code: status === 404 ? "workspace_not_found" : "forbidden",
        message: "We couldn’t complete that request. Please try again in a moment.",
      });
    }
  });

  it("archives a workspace with confirmation and records an audit entry", async () => {
    archiveWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
      userId: "demo-user",
      name: "Contracts",
      templateKey: null,
      systemPrompt: null,
      pipeline: {},
      documentCount: 3,
      runCount: 2,
      latestRunId: null,
      latestRunStatus: null,
      archivedAt: "2026-03-12T10:00:00.000Z",
      lastActivityAt: "2026-03-12T10:00:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-12T10:00:00.000Z",
    });

    const response = await app.request("/workspaces/ws-1/archive", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmationText: "Contracts",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "ws-1",
      archivedAt: "2026-03-12T10:00:00.000Z",
    });
    expect(archiveWorkspaceMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.archived",
      resourceId: "ws-1",
    }));
  });

  it("restores a workspace with confirmation and records an audit entry", async () => {
    restoreWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
      userId: "demo-user",
      name: "Contracts",
      templateKey: null,
      systemPrompt: null,
      pipeline: {},
      documentCount: 3,
      runCount: 2,
      latestRunId: null,
      latestRunStatus: null,
      archivedAt: null,
      lastActivityAt: "2026-03-12T10:05:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-12T10:05:00.000Z",
    });

    const response = await app.request("/workspaces/ws-1/restore", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmationText: "Contracts",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "ws-1",
      archivedAt: null,
    });
    expect(restoreWorkspaceMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.restored",
      resourceId: "ws-1",
    }));
  });

  it("deletes a workspace with confirmation and records an audit entry", async () => {
    deleteWorkspaceMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
      userId: "demo-user",
      name: "Contracts",
      archivedAt: "2026-03-12T10:00:00.000Z",
    });

    const response = await app.request("/workspaces/ws-1", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirmationText: "Contracts",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspaceId: "ws-1",
      workspaceName: "Contracts",
    });
    expect(deleteWorkspaceMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.deleted",
      resourceId: "ws-1",
    }));
  });

  it("loads workspace search settings", async () => {
    getWorkspaceSearchSettingsForUserMock.mockResolvedValue({
      workspaceId: "ws-1",
      userId: "demo-user",
      typoTolerance: true,
      dedupeByFilename: true,
      rankingRules: {},
      boosts: { byMime: {} },
      pinnedResults: [],
      synonyms: {},
      retrievalDefaults: {
        resultCount: 8,
        useHyDE: false,
        useRerank: true,
        useContextualCompression: false,
        useMmr: false,
        mmrLambda: 0.4,
        queryRewrite: false,
        queryDecompose: false,
        stepback: false,
        parentRetrieval: true,
        summarySeed: false,
        selfQuery: false,
      },
      chat: {
        mode: "retrieval",
        answerStyle: "balanced",
        citations: true,
        searchInstructions: null,
      },
      compatSettings: {},
      rules: [],
      compatMetadata: {},
    });

    const response = await app.request("/workspaces/ws-1/search-settings");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "ws-1",
      retrievalDefaults: {
        resultCount: 8,
      },
    });
    expect(getWorkspaceSearchSettingsForUserMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("updates workspace search settings and records an audit entry", async () => {
    updateWorkspaceSearchSettingsForUserMock.mockResolvedValue({
      workspaceId: "ws-1",
      userId: "demo-user",
      typoTolerance: true,
      dedupeByFilename: true,
      rankingRules: {},
      boosts: { byMime: {} },
      pinnedResults: [],
      synonyms: {},
      retrievalDefaults: {
        resultCount: 12,
        useHyDE: true,
        useRerank: true,
        useContextualCompression: false,
        useMmr: false,
        mmrLambda: 0.4,
        queryRewrite: false,
        queryDecompose: false,
        stepback: false,
        parentRetrieval: true,
        summarySeed: false,
        selfQuery: false,
      },
      chat: {
        mode: "whole-corpus",
        answerStyle: "balanced",
        citations: true,
        searchInstructions: "Prefer policy documents first.",
      },
      compatSettings: {},
      rules: [],
      compatMetadata: {},
    });

    const response = await app.request("/workspaces/ws-1/search-settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        retrievalDefaults: {
          resultCount: 12,
          useHyDE: true,
        },
        chat: {
          mode: "whole-corpus",
          searchInstructions: "Prefer policy documents first.",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: "ws-1",
      retrievalDefaults: {
        resultCount: 12,
        useHyDE: true,
      },
      chat: {
        mode: "whole-corpus",
      },
    });
    expect(updateWorkspaceSearchSettingsForUserMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "demo-user",
      input: {
        retrievalDefaults: {
          resultCount: 12,
          useHyDE: true,
        },
        chat: {
          mode: "whole-corpus",
          searchInstructions: "Prefer policy documents first.",
        },
      },
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.search-settings.updated",
      resourceId: "ws-1",
    }));
  });
});


describe("workspace bearer resource reads", () => {
  it.each(["/workspaces", "/workspaces/one"])("rejects public keys before reading metadata at %s", async (path) => {
    const response = await buildApp({ orgId: "org-a", scopes: ["search"], keyType: "public" }).request(path);
    expect(response.status).toBe(403);
  });
  it("filters listings to the key organization", async () => {
    listWorkspacesMock.mockResolvedValueOnce([{ id: "one", orgId: "org-a" }, { id: "two", orgId: "org-b" }] as never);
    const response = await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/workspaces");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaces: [{ id: "one", orgId: "org-a" }] });
  });
  it("hides foreign organization workspace details", async () => {
    getWorkspaceMock.mockResolvedValueOnce({ id: "foreign", orgId: "org-b" });
    const response = await buildApp({ orgId: "org-a", scopes: ["ingest"] }).request("/workspaces/foreign");
    expect(response.status).toBe(404);
  });
  it("rejects keys without read scopes", async () => {
    const response = await buildApp({ orgId: "org-a", scopes: [] }).request("/workspaces/one");
    expect(response.status).toBe(403);
  });
});

describe("workspace rename via API keys", () => {
  const patch = (app: Hono) => app.request("/workspaces/amber-falcon-ridge", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "legal-contracts" }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "amber-falcon-ridge" });
    updateWorkspaceMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "legal-contracts", pipeline: {} });
  });

  it("requires the opt-in workspaces:manage scope on a server key", async () => {
    expect((await patch(buildApp({ orgId: "org-1", scopes: ["ingest", "search"] }))).status).toBe(403);
    expect((await patch(buildApp({ orgId: "org-1", scopes: ["workspaces:manage"], keyType: "client" }))).status).toBe(403);
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
  });

  it("rejects a prohibited pipeline model selection (SEC-2026-10-ROUND4-01)", async () => {
    const app = buildApp({ orgId: "org-1", scopes: ["workspaces:manage"] });
    const response = await app.request("/workspaces/amber-falcon-ridge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline: { textGeneration: { model: "openai/gpt-5.1-pro" } } }),
    });
    expect(response.status).toBe(400);
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
  });

  it("stays inside the key organization", async () => {
    const response = await patch(buildApp({ orgId: "org-2", scopes: ["workspaces:manage"] }));
    expect(response.status).toBe(404);
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
  });

  it("renames with workspaces:manage and attributes the audit entry to the key", async () => {
    const response = await patch(buildApp({ orgId: "org-1", scopes: ["workspaces:manage"], keyId: "key-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ slug: "legal-contracts" });
    expect(updateWorkspaceMock).toHaveBeenCalledWith("amber-falcon-ridge", "demo-user", { slug: "legal-contracts" });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.updated", apiKeyId: "key-1" }));
  });
});


describe("workspace tags API", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("lists counts using the resolved workspace ID", async () => {
    getWorkspaceMock.mockResolvedValueOnce({ id: "ws-1", orgId: "org-a" });
    listWorkspaceTagsMock.mockResolvedValueOnce([{ tag: "finance", documentCount: 3 }]);
    const response = await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/workspaces/my-workspace/tags");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: [{ tag: "finance", documentCount: 3 }] });
    expect(listWorkspaceTagsMock).toHaveBeenCalledWith("ws-1");
  });
  it("hides tags outside the key organization", async () => {
    getWorkspaceMock.mockResolvedValueOnce({ id: "foreign", orgId: "org-b" });
    expect((await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/workspaces/foreign/tags")).status).toBe(404);
    expect(listWorkspaceTagsMock).not.toHaveBeenCalled();
  });
  it("requires a read scope", async () => {
    expect((await buildApp({ orgId: "org-a", scopes: [] }).request("/workspaces/one/tags")).status).toBe(403);
    expect(listWorkspaceTagsMock).not.toHaveBeenCalled();
  });
});
