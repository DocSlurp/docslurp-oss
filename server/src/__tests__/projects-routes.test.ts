import { Hono } from "hono";
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getIngestReport,
  getMessageText,
  getProjectMeta,
  type ProjectChatUIMessage,
  projectChatDataPartSchemas,
} from "@docslurp/shared/project-chat-ui";

const appendAuditLogMock = vi.fn();
const archiveProjectMock = vi.fn();
const createProjectMock = vi.fn();
const deleteProjectMock = vi.fn();
const getProjectMock = vi.fn();
const getProjectStateMock = vi.fn();
const listProjectTagsMock = vi.fn();
vi.mock("../services/project-tags.js", () => ({ listProjectTags: listProjectTagsMock }));
vi.mock("../services/project-state.js", () => ({ getProjectState: getProjectStateMock }));
const chatProjectMock = vi.fn();
const projectChatDisabledBodyMock = vi.fn(async (_projectId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null);
const listProjectBoardRecordsMock = vi.fn(async () => []);
const listProjectsMock = vi.fn(async () => []);
const inviteProjectMemberMock = vi.fn();
const removeProjectMemberMock = vi.fn();
const restoreProjectMock = vi.fn();
const revokeProjectInviteMock = vi.fn();
const getProjectSearchSettingsForUserMock = vi.fn();
const hybridSearchMock = vi.fn();
const updateProjectSearchSettingsForUserMock = vi.fn();
const updateProjectMock = vi.fn();
const updateProjectMemberRoleMock = vi.fn();

vi.mock("../services/projects.js", () => ({
  archiveProject: archiveProjectMock,
  ensurePersonalDefaultProject: vi.fn(async () => {}),
  cloneProject: vi.fn(),
  createProject: createProjectMock,
  deleteProject: deleteProjectMock,
  getProject: getProjectMock,
  getProjectCockpit: vi.fn(),
  getProjectTraceFeed: vi.fn(),
  listProjectBoardRecords: listProjectBoardRecordsMock,
  listProjectVersions: vi.fn(),
  listProjects: listProjectsMock,
  restoreProject: restoreProjectMock,
  rollbackProjectVersion: vi.fn(),
  updateProject: updateProjectMock,
  ProjectSlugError: class ProjectSlugError extends Error {
    constructor(message: string, readonly status: 400 | 409) { super(message); }
  },
}));

vi.mock("../services/config-change.js", () => ({
  planProjectChange: vi.fn(async (args: { projectId: string; input: unknown }) => ({ project: { id: args.projectId }, input: args.input })),
  applyProjectChange: vi.fn(async ({ plan, userId, updateOptions }: { plan: { project: { id: string }; input: unknown }; userId: string; updateOptions?: unknown }) => {
    const project = await updateProjectMock(plan.project.id, userId, plan.input, ...(updateOptions ? [updateOptions] : []));
    return project ? { project, plan, job: null, queuedRunIds: [] } : null;
  }),
  estimateProjectChange: vi.fn(),
  billingState: () => "disabled",
}));

vi.mock("../services/project-chat.js", () => ({
  chatProject: chatProjectMock,
  projectChatDisabledBody: projectChatDisabledBodyMock,
}));

vi.mock("../services/search.js", () => ({
  hybridSearch: hybridSearchMock,
}));

vi.mock("../services/search-controls.js", () => ({
  getProjectSearchSettingsForUser: getProjectSearchSettingsForUserMock,
  updateProjectSearchSettingsForUser: updateProjectSearchSettingsForUserMock,
}));

const loadIngestReportMock = vi.fn();
const applyIngestRecommendationMock = vi.fn();
const reprocessIngestRecommendationMock = vi.fn();
const getProjectAccessMock = vi.fn(async (): Promise<unknown> => ({ role: "editor" }));
const canEditProjectMock = vi.fn(() => true);
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
  canEditProject: canEditProjectMock,
  getProjectAccess: getProjectAccessMock,
  acceptProjectInvite: vi.fn(),
  inviteProjectMember: inviteProjectMemberMock,
  listProjectInvites: vi.fn(),
  listProjectMembers: vi.fn(),
  removeProjectMember: removeProjectMemberMock,
  revokeProjectInvite: revokeProjectInviteMock,
  updateProjectMemberRole: updateProjectMemberRoleMock,
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

const { projectsRoutes } = await import("../routes/projects.js");

function buildApp(apiKey?: { orgId: string | null; scopes: string[]; keyType?: string; keyId?: string; projectIds?: string[]; oauth?: object }) {
  const app = new Hono();
  app.use("/projects/*", async (c, next) => {
    const user = { id: "demo-user", email: "demo@example.com", name: "Demo User" };
    c.set("sessionUser", user);
    if (apiKey) c.set("apiKey", { keyType: "server", ...apiKey } as never);
    // A signed-in app session, as sessionAuth resolves it from the Better Auth cookie.
    else c.set("requestActor", { type: "session", userId: user.id, sessionId: "app-session-1", user });
    await next();
  });
  app.route("/projects", projectsRoutes);
  return app;
}

describe("projectsRoutes validation", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    appendAuditLogMock.mockReset();
    archiveProjectMock.mockReset();
    createProjectMock.mockReset();
    deleteProjectMock.mockReset();
    getProjectMock.mockReset();
    getProjectStateMock.mockReset();
    chatProjectMock.mockReset();
    listProjectBoardRecordsMock.mockReset();
    getProjectSearchSettingsForUserMock.mockReset();
    hybridSearchMock.mockReset();
    inviteProjectMemberMock.mockReset();
    removeProjectMemberMock.mockReset();
    restoreProjectMock.mockReset();
    revokeProjectInviteMock.mockReset();
    updateProjectSearchSettingsForUserMock.mockReset();
    updateProjectMock.mockReset();
    updateProjectMemberRoleMock.mockReset();
    loadIngestReportMock.mockReset();
    applyIngestRecommendationMock.mockReset();
    reprocessIngestRecommendationMock.mockReset();
    getProjectAccessMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns current project state with a validated window for an authorized server key", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    getProjectStateMock.mockResolvedValue({ projectId: "ws-1", pages: { indexed: 2, notIndexed: 1 } });
    const response = await buildApp({ orgId: "org-1", scopes: ["search"] }).request("/projects/ws-1/state?recentWindowHours=48");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ pages: { indexed: 2, notIndexed: 1 } });
    expect(getProjectStateMock).toHaveBeenCalledWith({ projectId: "ws-1", orgId: "org-1", recentWindowHours: 48 });
  });

  it("rejects cross-organization, public, and unscoped keys before computing state", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    for (const [key, status] of [
      [{ orgId: "other-org", scopes: ["search"] }, 404],
      [{ orgId: "org-1", scopes: ["search"], keyType: "public" }, 403],
      [{ orgId: "org-1", scopes: ["chat"] }, 403],
    ] as const) {
      const response = await buildApp({ ...key, scopes: [...key.scopes] }).request("/projects/ws-1/state");
      expect(response.status).toBe(status);
    }
    expect(getProjectStateMock).not.toHaveBeenCalled();
  });

  it("validates project state windows and conceals inaccessible projects", async () => {
    const bad = await app.request("/projects/ws-1/state?recentWindowHours=721");
    expect(bad.status).toBe(400);
    getProjectMock.mockResolvedValue(null);
    expect((await app.request("/projects/ws-1/state")).status).toBe(404);
    expect(getProjectStateMock).not.toHaveBeenCalled();
  });

  it("returns the ingest report for the authorized project, with edit rights from the member's role", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "W" });
    loadIngestReportMock.mockResolvedValue({ projectId: "ws-1", files: { total: 2 } });
    canEditProjectMock.mockReturnValueOnce(false);
    const response = await app.request("/projects/ws-1/ingest-report?runId=run-9&documentIds=a,b,a");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ files: { total: 2 } });
    expect(loadIngestReportMock).toHaveBeenCalledWith({
      project: expect.objectContaining({ id: "ws-1" }), canEdit: false, runId: "run-9", documentIds: ["a", "b"],
    });
    expect(getProjectMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("conceals inaccessible projects and rejects foreign, public or unscoped keys before building a report", async () => {
    getProjectMock.mockResolvedValue(null);
    expect((await app.request("/projects/ws-1/ingest-report")).status).toBe(404);
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    for (const [key, status] of [
      [{ orgId: "other-org", scopes: ["search"] }, 404],
      [{ orgId: "org-1", scopes: ["search"], keyType: "public" }, 403],
      [{ orgId: "org-1", scopes: ["chat"] }, 403],
    ] as const) {
      const response = await buildApp({ ...key, scopes: [...key.scopes] }).request("/projects/ws-1/ingest-report");
      expect(response.status).toBe(status);
    }
    const tooMany = Array.from({ length: 101 }, (_, index) => `d${index}`).join(",");
    expect((await app.request(`/projects/ws-1/ingest-report?documentIds=${tooMany}`)).status).toBe(400);
    expect(loadIngestReportMock).not.toHaveBeenCalled();
  });

  it("gives a search-only key a read-only report and an ingest key the editor's actions", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    loadIngestReportMock.mockResolvedValue({ projectId: "ws-1" });
    const response = await buildApp({ orgId: "org-1", scopes: ["search"] }).request("/projects/ws-1/ingest-report");
    expect(response.status).toBe(200);
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false }));
    await buildApp({ orgId: "org-1", scopes: ["ingest"] }).request("/projects/ws-1/ingest-report");
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: true }));
    // The key never exceeds its user's role.
    canEditProjectMock.mockReturnValueOnce(false);
    await buildApp({ orgId: "org-1", scopes: ["ingest"] }).request("/projects/ws-1/ingest-report");
    expect(loadIngestReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false }));
  });

  it("applies a recommendation, audits it and maps editor and conflict errors", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    applyIngestRecommendationMock.mockResolvedValueOnce({
      project: { id: "ws-1", orgId: "org-1", pipeline: {} }, recommendation: { patch: { preserveTables: true } }, pipeline: { preserveTables: true },
    });
    const ok = await app.request("/projects/ws-1/ingest-report/apply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
    });
    expect(ok.status).toBe(200);
    expect(applyIngestRecommendationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "demo-user", recommendationId: "preserve-tables", runId: null }));
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.updated", projectId: "ws-1", metadata: expect.objectContaining({ source: "ingest-report", patch: { preserveTables: true } }),
    }));

    for (const status of [403, 409] as const) {
      applyIngestRecommendationMock.mockRejectedValueOnce(new IngestReportActionErrorMock("nope", status));
      const response = await app.request("/projects/ws-1/ingest-report/apply", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
      });
      expect(response.status).toBe(status);
    }
    // The change itself always comes from the server: unknown body fields are not passed on.
    const injected = await app.request("/projects/ws-1/ingest-report/apply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "x".repeat(65) }),
    });
    expect(injected.status).toBe(400);
  });

  it("accepts API keys on the report and its actions", async () => {
    const { listRouteAuthModes } = await import("../lib/route-auth.js");
    const modes = Object.fromEntries(listRouteAuthModes(projectsRoutes).map((route) => [`${route.method} ${route.path}`, route.mode]));
    expect(modes["GET /:projectId/ingest-report"]).toBe("apiKey");
    expect(modes["POST /:projectId/ingest-report/apply"]).toBe("apiKey");
    expect(modes["POST /:projectId/ingest-report/reprocess"]).toBe("apiKey");
    expect(modes["POST /:projectId/documents/bulk/estimate"]).toBe("apiKey");
  });

  it("lets an ingest server key reprocess findings and a projects:manage key apply them, in its own projects only", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    reprocessIngestRecommendationMock.mockResolvedValue({ runs: [{ id: "run-2" }], documentIds: ["d1"], skippedDocuments: 0, estimatedCents: 1 });
    applyIngestRecommendationMock.mockResolvedValue({
      project: { id: "ws-1", orgId: "org-1", pipeline: {} }, recommendation: { patch: { preserveTables: true } }, pipeline: { preserveTables: true },
    });
    const post = (key: Parameters<typeof buildApp>[0], action: "apply" | "reprocess") => buildApp(key).request(`/projects/ws-1/ingest-report/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "preserve-tables" }),
    });
    for (const [key, action, status] of [
      [{ orgId: "org-1", scopes: ["search"] }, "reprocess", 403],
      [{ orgId: "org-1", scopes: ["ingest"], keyType: "client" }, "reprocess", 403],
      [{ orgId: "other-org", scopes: ["ingest"] }, "reprocess", 404],
      [{ orgId: "org-1", scopes: ["ingest"] }, "apply", 403],
      [{ orgId: "org-1", scopes: ["projects:manage"], keyType: "client" }, "apply", 403],
      [{ orgId: "other-org", scopes: ["projects:manage"] }, "apply", 404],
    ] as const) {
      expect((await post({ ...key, scopes: [...key.scopes] }, action)).status, `${action} ${JSON.stringify(key)}`).toBe(status);
    }
    expect(reprocessIngestRecommendationMock).not.toHaveBeenCalled();
    expect(applyIngestRecommendationMock).not.toHaveBeenCalled();

    expect((await post({ orgId: "org-1", scopes: ["ingest"], keyId: "key-1" }, "reprocess")).status).toBe(201);
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "documents.bulk_reprocessed", apiKeyId: "key-1" }));
    expect((await post({ orgId: "org-1", scopes: ["projects:manage"], keyId: "key-2" }, "apply")).status).toBe(200);
    expect(appendAuditLogMock).toHaveBeenLastCalledWith(expect.objectContaining({ action: "project.updated", apiKeyId: "key-2" }));
  });

  it("reprocesses a recommendation's files and audits the runs", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    reprocessIngestRecommendationMock.mockResolvedValueOnce({ runs: [{ id: "run-2" }], documentIds: ["d1"], skippedDocuments: 0, estimatedCents: 1.5 });
    const response = await app.request("/projects/ws-1/ingest-report/reprocess", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: "vision-all-pages" }),
    });
    expect(response.status).toBe(201);
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "documents.bulk_reprocessed", metadata: expect.objectContaining({ source: "ingest-report", runs: ["run-2"], estimatedCents: 1.5 }),
    }));
  });

  it("returns 400 for unsupported embedding models on project create", async () => {
    const response = await app.request("/projects", {
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
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("returns the batched project board payload", async () => {
    listProjectBoardRecordsMock.mockResolvedValue([
      {
        project: {
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

    const response = await app.request('/projects/board');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      records: [
        expect.objectContaining({
          project: expect.objectContaining({ id: 'ws-1' }),
          summary: expect.objectContaining({ totalPages: 12 })
        })
      ]
    });
    expect(listProjectBoardRecordsMock).toHaveBeenCalledWith('demo-user');
  });

  it("returns 400 for unsupported embedding models on project update", async () => {
    const response = await app.request("/projects/ws-1", {
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
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("updates project member role and records an audit entry", async () => {
    updateProjectMemberRoleMock.mockResolvedValue({
      projectId: "ws-1",
      userId: "member-1",
      email: "member@example.com",
      name: "Member",
      role: "editor",
      invitedByUserId: "owner-1",
      createdAt: "2026-03-12T00:00:00.000Z",
    });

    const response = await app.request("/projects/ws-1/members/member-1", {
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
      projectId: "ws-1",
      userId: "member-1",
      role: "editor",
    });
    expect(updateProjectMemberRoleMock).toHaveBeenCalledWith({
      projectId: "ws-1",
      userId: "demo-user",
      memberUserId: "member-1",
      role: "editor",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.member.updated",
      resourceId: "ws-1:member-1",
    }));
  });

  it("has no add-by-user-ID route for project members", async () => {
    const response = await app.request("/projects/ws-1/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberUserId: "member-1", role: "viewer" }),
    });
    expect(response.status).toBe(404);
  });

  it("streams project search updates until results are available", async () => {
    getProjectMock.mockResolvedValue({
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
            projectId: "ws-1",
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
            projectId: "ws-1",
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

    const response = await app.request("/projects/ws-1/search/stream?q=class%20list");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const body = await response.text();
    expect(body).toContain("event: status");
    expect(body).toContain("Running project search");
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
          projectId: "ws-1",
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
          projectId: "ws-1",
        }),
      }),
    );
    expect(hybridSearchMock.mock.calls[0]?.[2].rootSessionId).toBe(
      hybridSearchMock.mock.calls[1]?.[2].rootSessionId,
    );
  });

  it("finishes an empty project search without a second retrieval", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "empty-search",
      availability: { status: "empty", coverage: { queuedRuns: 0, processingRuns: 0 } },
    });
    const response = await app.request("/projects/ws-1/search/stream?q=missing");
    const body = await response.text();
    expect(body).toContain("event: results");
    expect(body).toContain('"sessionId":"empty-search"');
    expect(body).toContain("event: done");
    expect(hybridSearchMock).toHaveBeenCalledTimes(1);
  });

  it("stops polling while indexing once a search branch hit the statement timeout", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "timed-out",
      timings: { textMs: 8000, lexicalTimeout: 1 },
      availability: { status: "pending", coverage: { queuedRuns: 1, processingRuns: 1 } },
    });
    const body = await (await app.request("/projects/ws-1/search/stream?q=broad")).text();
    expect(body).toContain("event: done");
    expect(hybridSearchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves omitted stream search flags to the project defaults and honours graph and multi-hop flags", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    hybridSearchMock.mockResolvedValue({
      results: [],
      sessionId: "flags",
      availability: { status: "empty", coverage: { queuedRuns: 0, processingRuns: 0 } },
    });
    await (await app.request("/projects/ws-1/search/stream?q=x&rerank=false&graphExpansion=true&iterativeMultiHop=true&graphHops=2")).text();
    const options = hybridSearchMock.mock.calls[0]?.[2];
    expect(options).toMatchObject({ useRerank: false, enableGraphExpansion: true, iterativeMultiHop: true, graphHops: 2 });
    expect(options.useHyDE).toBeUndefined();
    expect(options.useMmr).toBeUndefined();
    expect(options.parentRetrieval).toBeUndefined();
  });

  it("forwards composer retrieval overrides and filters, and rejects invalid ones", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatProjectMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const ok = await app.request("/projects/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "hi", retrieval: { resultCount: 6, useRerank: false }, filters: { tags: ["legal"], dateTo: "2026-10-01" } }) });
    expect(ok.status).toBe(200);
    expect(chatProjectMock).toHaveBeenCalledWith(expect.objectContaining({
      retrieval: { resultCount: 6, useRerank: false },
      filters: { tags: ["legal"], dateTo: "2026-10-01" },
    }));

    chatProjectMock.mockClear();
    const bad = await app.request("/projects/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "hi", retrieval: { resultCount: 99 } }) });
    expect(bad.status).toBe(400);
    expect(chatProjectMock).not.toHaveBeenCalled();
  });

  it("disables tools and configuration writes for automatic transport recovery", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatProjectMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const response = await app.request("/projects/ws-1/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "ingest these sources", retrievalOnly: true }) });
    expect(response.status).toBe(200);
    expect(chatProjectMock).toHaveBeenCalledWith(expect.objectContaining({ actor: undefined, allowConfiguration: false }));
  });

  it("maps composer toggles to agent modes: web off and suggestions on unless the user changes them", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatProjectMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const send = (body: Record<string, unknown>) => app.request("/projects/ws-1/chat", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "hi", ...body }) });
    await send({});
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: true } }));
    await send({ webTools: true, suggestions: false });
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: true, suggestions: false } }));
    // Only a literal true turns web tools on.
    await send({ webTools: "yes" });
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: true } }));
  });

  it.each([{ keyType: "server" }, { keyType: "client" }])("never gives API keys suggestions mode on the dashboard chat routes, even when they ask: %j", async ({ keyType }) => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatProjectMock.mockResolvedValue({ id: "answer", debug: { model: null, fallback: true }, citations: [] });
    const keyApp = buildApp({ orgId: "org-1", scopes: ["search", "chat", "projects:manage"], keyType });
    const send = (body: Record<string, unknown>) => keyApp.request("/projects/ws-1/chat", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "hi", ...body }) });
    chatProjectMock.mockClear();
    await send({});
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: false } }));
    await send({ suggestions: true });
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: false, suggestions: false } }));
  });

  it("refuses settings-proposal Apply for API keys before any change", async () => {
    const keyApp = buildApp({ orgId: "org-1", scopes: ["search", "chat", "projects:manage"], keyType: "server" });
    const response = await keyApp.request("/projects/ws-1/settings-proposals/apply", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "forged", reprocessExisting: false }) });
    expect(response.status).toBe(403);
  });

  it("streams the turn's agent modes in project metadata", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    chatProjectMock.mockResolvedValue({
      id: "answer-3", sessionId: "session-3", searchSessionId: null, answer: "Done.",
      citations: [], evidenceSpans: [], availability: null,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costCents: 0 },
      runtime: { startedAt: "2026-10-24T00:00:00.000Z", completedAt: "2026-10-24T00:00:00.010Z", totalMs: 10 },
      debug: { citations: 0, model: "m", fallback: false, historyTurns: 0, mode: "retrieval", modes: { web: "unavailable", suggestions: true },
        wholeCorpus: { attempted: false, eligible: false, documentCount: null, chunkCount: null, tokenEstimate: null, charEstimate: null, maxDocuments: 1, maxChunks: 1, maxTokens: 1, maxChars: 1, fallbackReason: null } },
    });
    const transport = new DefaultChatTransport<ProjectChatUIMessage>({
      api: "http://localhost/projects/ws-1/chat/project-agent",
      body: { webTools: true },
      fetch: async (input, init) => app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<ProjectChatUIMessage>({ id: "thread-3", messages: [], transport, dataPartSchemas: projectChatDataPartSchemas });
    await chat.sendMessage({ text: "Search the web for pricing" });
    expect(chat.error).toBeUndefined();
    expect(getProjectMeta(chat.messages.at(-1)!)?.modes).toEqual({ web: "unavailable", suggestions: true });
    expect(chatProjectMock).toHaveBeenLastCalledWith(expect.objectContaining({ agent: { web: true, suggestions: true } }));
  });

  it("returns 403 from project chat routes when the project turned chat off", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    projectChatDisabledBodyMock.mockResolvedValue({ error: "Chat is turned off for this project.", code: "chat_disabled" });
    try {
      const agent = await app.request("/projects/ws-1/chat/project-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }] }),
      });
      expect(agent.status).toBe(403);
      expect(await agent.json()).toMatchObject({ error: { code: "chat_disabled" } });

      const plain = await app.request("/projects/ws-1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "Hi" }),
      });
      expect(plain.status).toBe(403);
      expect(chatProjectMock).not.toHaveBeenCalled();
    } finally {
      projectChatDisabledBodyMock.mockResolvedValue(null);
    }
  });

  it("streams project chat responses through the AI SDK chat transport", async () => {
    getProjectMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
    });
    chatProjectMock.mockImplementation(
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

    const transport = new DefaultChatTransport<ProjectChatUIMessage>({
      api: "http://localhost/projects/ws-1/chat/project-agent",
      credentials: "include",
      body: {
        sessionId: "session-1",
        model: "anthropic/claude-haiku-5.5",
      },
      fetch: async (input, init) =>
        app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<ProjectChatUIMessage>({
      id: "thread-1",
      messages: [],
      transport,
      dataPartSchemas: projectChatDataPartSchemas,
    });

    await chat.sendMessage({ text: "What changed?" });

    expect(chat.status).toBe("ready");
    expect(chat.error).toBeUndefined();
    const assistantMessage = chat.messages.at(-1);
    expect(assistantMessage?.role).toBe("assistant");
    expect(getMessageText(assistantMessage!)).toBe(
      "The streamed answer loaded.",
    );
    expect(getProjectMeta(assistantMessage!)?.sessionId).toBe("session-1");
    expect(chatProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "ws-1",
        userId: "demo-user",
        query: "What changed?",
        sessionId: "session-1",
        model: "anthropic/claude-haiku-5.5",
        onTextDelta: expect.any(Function),
      }),
    );
  });

  it("streams the ingest report as a data part when chat answers /status", async () => {
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1" });
    const { buildIngestReport } = await vi.importActual<typeof import("../services/ingest-report.js")>("../services/ingest-report.js");
    const { defaultPipelineFeatures } = await import("@docslurp/shared");
    const report = buildIngestReport({
      project: { id: "ws-1", name: "W", pipeline: defaultPipelineFeatures },
      scope: { runId: null, documentIds: null, matchedDocuments: 0 },
      documents: [], pageDetailDocumentIds: [], pages: [], stages: [], runs: [], costCents: null, canEdit: true,
    });
    chatProjectMock.mockResolvedValue({
      id: "answer-2", sessionId: "session-2", searchSessionId: null, answer: "**Ingest report** for W: no files yet.",
      citations: [], evidenceSpans: [], availability: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
      runtime: { startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:00.010Z", totalMs: 10 },
      debug: { citations: 0, model: null, fallback: false, historyTurns: 0, mode: "retrieval", wholeCorpus: { attempted: false, eligible: false, documentCount: null, chunkCount: null, tokenEstimate: null, charEstimate: null, maxDocuments: 1, maxChunks: 1, maxTokens: 1, maxChars: 1, fallbackReason: null } },
      ingestReport: report,
    });
    const transport = new DefaultChatTransport<ProjectChatUIMessage>({
      api: "http://localhost/projects/ws-1/chat/project-agent",
      fetch: async (input, init) => app.request(new Request(input, init as RequestInit)),
    });
    const chat = new Chat<ProjectChatUIMessage>({ id: "thread-2", messages: [], transport, dataPartSchemas: projectChatDataPartSchemas });
    await chat.sendMessage({ text: "/status" });
    expect(chat.error).toBeUndefined();
    const assistant = chat.messages.at(-1)!;
    expect(getIngestReport(assistant)?.projectId).toBe("ws-1");
    expect(getProjectMeta(assistant)).toMatchObject({ sessionId: "session-2", mode: "ingest-report" });
    expect(getMessageText(assistant)).toContain("Ingest report");
    // Only the signed-in dashboard chat may answer with the report.
    expect(chatProjectMock).toHaveBeenCalledWith(expect.objectContaining({ query: "/status", answerIngestReport: true }));
  });

  it("keeps project chat streams alive while answer generation is pending", async () => {
    vi.useFakeTimers();
    getProjectMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
    });

    let resolveChat: (value: unknown) => void = () => {};
    chatProjectMock.mockReturnValue(
      new Promise((resolve) => {
        resolveChat = resolve;
      }),
    );

    const response = await app.request("/projects/ws-1/chat/project-agent", {
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
    chatProjectMock.mock.calls.at(-1)?.[0].onEvidence?.(evidence);
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

  it("removes a project member and records an audit entry", async () => {
    removeProjectMemberMock.mockResolvedValue(true);

    const response = await app.request("/projects/ws-1/members/member-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(removeProjectMemberMock).toHaveBeenCalledWith({
      projectId: "ws-1",
      userId: "demo-user",
      memberUserId: "member-1",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.member.removed",
      resourceId: "ws-1:member-1",
    }));
  });

  it("revokes a project invite and records an audit entry", async () => {
    revokeProjectInviteMock.mockResolvedValue({
      id: "invite-1",
      projectId: "ws-1",
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

    const response = await app.request("/projects/ws-1/invites/invite-1", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "invite-1",
      projectId: "ws-1",
      status: "revoked",
    });
    expect(revokeProjectInviteMock).toHaveBeenCalledWith({
      projectId: "ws-1",
      userId: "demo-user",
      inviteId: "invite-1",
    });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.invite.revoked",
      resourceId: "invite-1",
    }));
  });

  it.each(["archive", "restore"])("preserves access status while sanitizing %s failures", async action => {
    const handler = action === "archive" ? archiveProjectMock : restoreProjectMock;
    for (const [cause, status] of [["Forbidden", 403], ["Project not found", 404]] as const) {
      handler.mockRejectedValueOnce(new Error(cause));
      const response = await app.request(`/projects/ws-1/${action}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationText: "Contracts" }),
      });
      expect(response.status).toBe(status);
      expect((await response.json()).error).toMatchObject({
        code: status === 404 ? "project_not_found" : "forbidden",
        message: "We couldn’t complete that request. Please try again in a moment.",
      });
    }
  });

  it("archives a project with confirmation and records an audit entry", async () => {
    archiveProjectMock.mockResolvedValue({
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

    const response = await app.request("/projects/ws-1/archive", {
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
    expect(archiveProjectMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.archived",
      resourceId: "ws-1",
    }));
  });

  it("restores a project with confirmation and records an audit entry", async () => {
    restoreProjectMock.mockResolvedValue({
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

    const response = await app.request("/projects/ws-1/restore", {
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
    expect(restoreProjectMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.restored",
      resourceId: "ws-1",
    }));
  });

  it("deletes a project with confirmation and records an audit entry", async () => {
    deleteProjectMock.mockResolvedValue({
      id: "ws-1",
      orgId: "org-1",
      userId: "demo-user",
      name: "Contracts",
      archivedAt: "2026-03-12T10:00:00.000Z",
    });

    const response = await app.request("/projects/ws-1", {
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
      projectId: "ws-1",
      projectName: "Contracts",
    });
    expect(deleteProjectMock).toHaveBeenCalledWith("ws-1", "demo-user", "Contracts");
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.deleted",
      resourceId: "ws-1",
    }));
  });

  it("loads project search settings", async () => {
    getProjectSearchSettingsForUserMock.mockResolvedValue({
      projectId: "ws-1",
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

    const response = await app.request("/projects/ws-1/search-settings");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectId: "ws-1",
      retrievalDefaults: {
        resultCount: 8,
      },
    });
    expect(getProjectSearchSettingsForUserMock).toHaveBeenCalledWith("ws-1", "demo-user");
  });

  it("updates project search settings and records an audit entry", async () => {
    getProjectMock.mockResolvedValueOnce({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "legal" });
    updateProjectSearchSettingsForUserMock.mockResolvedValue({
      projectId: "ws-1",
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

    const response = await app.request("/projects/ws-1/search-settings", {
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
      projectId: "ws-1",
      retrievalDefaults: {
        resultCount: 12,
        useHyDE: true,
      },
      chat: {
        mode: "whole-corpus",
      },
    });
    expect(updateProjectSearchSettingsForUserMock).toHaveBeenCalledWith({
      projectId: "ws-1",
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
      action: "project.search-settings.updated",
      orgId: "org-1",
      projectId: "ws-1",
      resourceId: "ws-1",
      apiKeyId: null,
    }));
  });
});


describe("project bearer resource reads", () => {
  it.each(["/projects", "/projects/one"])("rejects public keys before reading metadata at %s", async (path) => {
    const response = await buildApp({ orgId: "org-a", scopes: ["search"], keyType: "public" }).request(path);
    expect(response.status).toBe(403);
  });
  it("filters listings to the key organization", async () => {
    listProjectsMock.mockResolvedValueOnce([{ id: "one", orgId: "org-a" }, { id: "two", orgId: "org-b" }] as never);
    const response = await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [{ id: "one", orgId: "org-a" }] });
  });
  it("hides foreign organization project details", async () => {
    getProjectMock.mockResolvedValueOnce({ id: "foreign", orgId: "org-b" });
    const response = await buildApp({ orgId: "org-a", scopes: ["ingest"] }).request("/projects/foreign");
    expect(response.status).toBe(404);
  });
  it("rejects keys without read scopes", async () => {
    const response = await buildApp({ orgId: "org-a", scopes: [] }).request("/projects/one");
    expect(response.status).toBe(403);
  });
});

describe("project rename via API keys", () => {
  const patch = (app: Hono) => app.request("/projects/amber-falcon-ridge", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "legal-contracts" }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "amber-falcon-ridge" });
    updateProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "legal-contracts", pipeline: {} });
  });

  it("requires the opt-in projects:manage scope on a server key", async () => {
    expect((await patch(buildApp({ orgId: "org-1", scopes: ["ingest", "search"] }))).status).toBe(403);
    expect((await patch(buildApp({ orgId: "org-1", scopes: ["projects:manage"], keyType: "client" }))).status).toBe(403);
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it("rejects a prohibited pipeline model selection (SEC-2026-10-ROUND4-01)", async () => {
    const app = buildApp({ orgId: "org-1", scopes: ["projects:manage"] });
    const response = await app.request("/projects/amber-falcon-ridge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline: { textGeneration: { model: "openai/gpt-5.1-pro" } } }),
    });
    expect(response.status).toBe(400);
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it("stays inside the key organization", async () => {
    const response = await patch(buildApp({ orgId: "org-2", scopes: ["projects:manage"] }));
    expect(response.status).toBe(404);
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it("renames with projects:manage and attributes the audit entry to the key", async () => {
    const response = await patch(buildApp({ orgId: "org-1", scopes: ["projects:manage"], keyId: "key-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ slug: "legal-contracts" });
    expect(updateProjectMock).toHaveBeenCalledWith("amber-falcon-ridge", "demo-user", { slug: "legal-contracts" });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project.updated", apiKeyId: "key-1" }));
  });
});


describe("project search settings via API keys", () => {
  const settingsPath = "/projects/ws-1/search-settings";
  const send = (app: Hono, path = settingsPath) => app.request(path, {
    method: path.endsWith("/estimate") ? "POST" : "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat: { answerStyle: "concise" } }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectMock.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Legal", slug: "legal" });
    updateProjectSearchSettingsForUserMock.mockResolvedValue({ projectId: "ws-1", retrievalDefaults: {}, chat: { answerStyle: "concise" } });
  });

  it("updates with a projects:manage server key and attributes the audit entry to the key", async () => {
    const response = await send(buildApp({ orgId: "org-1", scopes: ["projects:manage"], keyId: "key-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ chat: { answerStyle: "concise" } });
    expect(updateProjectSearchSettingsForUserMock).toHaveBeenCalledWith({ projectId: "ws-1", userId: "demo-user", input: { chat: { answerStyle: "concise" } } });
    expect(appendAuditLogMock).toHaveBeenCalledWith(expect.objectContaining({ action: "project.search-settings.updated", apiKeyId: "key-1", orgId: "org-1", projectId: "ws-1", resourceId: "ws-1" }));
  });

  it("refuses a wrong key before validating the body, so it never sees a schema error", async () => {
    for (const method of ["PATCH", "POST"]) {
      const path = method === "POST" ? `${settingsPath}/estimate` : settingsPath;
      const response = await buildApp({ orgId: "org-1", scopes: ["search"] }).request(path, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify({ synonyms: "not-an-object" }),
      });
      expect(response.status, path).toBe(403);
    }
    // A permitted key with an invalid body gets the validation envelope on both routes.
    for (const method of ["PATCH", "POST"]) {
      const path = method === "POST" ? `${settingsPath}/estimate` : settingsPath;
      const response = await buildApp({ orgId: "org-1", scopes: ["projects:manage"] }).request(path, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify({ synonyms: "not-an-object" }),
      });
      expect(response.status, path).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(updateProjectSearchSettingsForUserMock).not.toHaveBeenCalled();
  });

  it.each([
    ["search-only server key", { orgId: "org-1", scopes: ["search", "chat", "ingest"] }],
    ["browser key with projects:manage", { orgId: "org-1", scopes: ["projects:manage"], keyType: "client", projectIds: ["ws-1"] }],
    ["OAuth token, even if it held projects:manage", { orgId: "org-1", scopes: ["projects:manage"], oauth: { audience: "api", grantId: "g", clientId: "docslurp-cli", clientName: "CLI", resource: "x", grantedScopes: [], expiresAt: "2099-01-01T00:00:00Z" } }],
  ])("refuses a %s with 403 and writes nothing", async (_name, key) => {
    for (const path of [settingsPath, `${settingsPath}/estimate`]) {
      const response = await send(buildApp(key), path);
      expect(response.status, path).toBe(403);
    }
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(updateProjectSearchSettingsForUserMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another organization's key", { orgId: "org-2", scopes: ["projects:manage"] }],
    ["a key restricted to other projects", { orgId: "org-1", scopes: ["projects:manage"], projectIds: ["ws-2"] }],
  ])("answers 404 for %s and writes nothing", async (_name, key) => {
    for (const path of [settingsPath, `${settingsPath}/estimate`]) {
      expect((await send(buildApp(key), path)).status, path).toBe(404);
    }
    expect(updateProjectSearchSettingsForUserMock).not.toHaveBeenCalled();
    expect(appendAuditLogMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the key owner cannot see the project", async () => {
    getProjectMock.mockResolvedValue(null);
    expect((await send(buildApp({ orgId: "org-1", scopes: ["projects:manage"] }))).status).toBe(404);
    expect(updateProjectSearchSettingsForUserMock).not.toHaveBeenCalled();
  });
});

describe("project tags API", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("lists counts using the resolved project ID", async () => {
    getProjectMock.mockResolvedValueOnce({ id: "ws-1", orgId: "org-a" });
    listProjectTagsMock.mockResolvedValueOnce([{ tag: "finance", documentCount: 3 }]);
    const response = await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/projects/my-project/tags");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: [{ tag: "finance", documentCount: 3 }] });
    expect(listProjectTagsMock).toHaveBeenCalledWith("ws-1");
  });
  it("hides tags outside the key organization", async () => {
    getProjectMock.mockResolvedValueOnce({ id: "foreign", orgId: "org-b" });
    expect((await buildApp({ orgId: "org-a", scopes: ["search"] }).request("/projects/foreign/tags")).status).toBe(404);
    expect(listProjectTagsMock).not.toHaveBeenCalled();
  });
  it("requires a read scope", async () => {
    expect((await buildApp({ orgId: "org-a", scopes: [] }).request("/projects/one/tags")).status).toBe(403);
    expect(listProjectTagsMock).not.toHaveBeenCalled();
  });
});
