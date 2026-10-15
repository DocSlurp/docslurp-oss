import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ValidatedKey } from "../services/api-keys.js";

// Every route that takes a workspace in a query or body must accept the same
// references: UUID, current slug, former slug, `default`, or nothing. Action
// routes send an omitted reference to the org's default workspace; list and
// filter routes treat it as "no filter".
const WS_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  createDirectUploadSession: vi.fn(),
  listDocumentsWithFilters: vi.fn(),
  listDocumentIndexEntries: vi.fn(),
  listLowConfidenceReviewQueue: vi.fn(),
  aggregateWorkspaceRagSearch: vi.fn(),
  createRun: vi.fn(),
  getRunProcessingPreview: vi.fn(),
  getAutomationUsage: vi.fn(),
  listNotificationInbox: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  validateApiKey: vi.fn(),
  ensureDefaultWorkspace: vi.fn(),
}));

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../services/workspaces.js", () => ({
  resolveWorkspaceRef: vi.fn(async (ref: string) => {
    if (ref === WS_ID || ref === "legal") return { id: WS_ID, slug: "legal", renamedFrom: null };
    if (ref === "old-legal") return { id: WS_ID, slug: "legal", renamedFrom: "old-legal" };
    return null;
  }),
  ensureDefaultWorkspace: mocks.ensureDefaultWorkspace,
  getWorkspace: vi.fn(async (id: string) =>
    id === WS_ID || id === DEFAULT_ID ? { id, orgId: "org-1", userId: "user-1", pipeline: {} } : null),
}));
vi.mock("../services/direct-upload-session.js", () => ({
  createDirectUploadSession: mocks.createDirectUploadSession,
  abortDirectUploadSession: vi.fn(),
  completeDirectUploadFile: vi.fn(),
  getDirectUploadSessionDescription: vi.fn(),
  directUploadSessionBelongsToOrganization: vi.fn(),
}));
vi.mock("../services/documents.js", () => ({
  listDocumentsWithFilters: mocks.listDocumentsWithFilters,
  listDocumentIndexEntries: mocks.listDocumentIndexEntries,
}));
vi.mock("../services/document-review.js", () => ({
  listLowConfidenceReviewQueue: mocks.listLowConfidenceReviewQueue,
}));
vi.mock("../services/search.js", () => ({ hybridSearch: vi.fn(), MissingWorkspaceScopeError: class extends Error {} }));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace: vi.fn() }));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateWorkspaceRagSearch: mocks.aggregateWorkspaceRagSearch }));
vi.mock("../services/runs.js", () => ({
  createRun: mocks.createRun,
  getRunProcessingPreview: mocks.getRunProcessingPreview,
  isRunCreationBlockedError: () => false,
}));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn() }));
vi.mock("../services/automation.js", () => ({ getAutomationUsage: mocks.getAutomationUsage }));
vi.mock("../services/api-keys.js", () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock("../services/notifications.js", () => ({
  listNotificationInbox: mocks.listNotificationInbox,
  markAllNotificationsRead: mocks.markAllNotificationsRead,
}));

const { uploadsRoutes } = await import("../routes/uploads.js");
const { documentsRoutes } = await import("../routes/documents.js");
const { searchRoutes } = await import("../routes/search.js");
const { runsRoutes } = await import("../routes/runs.js");
const { aiRoutes } = await import("../routes/ai.js");
const { notificationsRoutes } = await import("../routes/notifications.js");
const { WorkspaceAccessError } = await import("../services/default-workspace.js");

const apiKey: ValidatedKey = {
  keyId: "key-1",
  userId: "user-1",
  orgId: "org-1",
  keyType: "server",
  allowedDomains: [],
  scopes: ["search", "ingest", "artifacts"],
  rateLimitRpm: 60,
  rateLimitPpd: 10_000,
  rateLimits: [],
  workspaceIds: [],
};

function buildApp() {
  const app = new Hono();
  app.route("/ai", aiRoutes);
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "User" } as never);
    await next();
  });
  app.route("/ingest", uploadsRoutes);
  app.route("/documents", documentsRoutes);
  app.route("/search", searchRoutes);
  app.route("/runs", runsRoutes);
  app.route("/notifications", notificationsRoutes);
  return app;
}

const post = (body: Record<string, unknown>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const withRef = (ref: string | undefined) => (ref === undefined ? {} : { workspaceId: ref });
const query = (ref: string | undefined) => (ref === undefined ? "" : `?workspaceId=${encodeURIComponent(ref)}`);

type Boundary = {
  route: string;
  /** Action routes resolve an omitted reference to the default workspace. */
  omitted: "default" | "unfiltered";
  call: (app: Hono, ref: string | undefined) => Response | Promise<Response>;
  /** The workspace ID the service layer received. */
  received: () => unknown;
};

const boundaries: Boundary[] = [
  {
    route: "POST /ingest/direct/sessions",
    omitted: "default",
    call: (app, ref) => app.request("/ingest/direct/sessions", post({
      ...withRef(ref),
      files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }],
    })),
    received: () => mocks.createDirectUploadSession.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "GET /documents",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/documents${query(ref)}`),
    received: () => mocks.listDocumentsWithFilters.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "GET /documents/index",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/documents/index${query(ref)}`),
    received: () => mocks.listDocumentIndexEntries.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "GET /documents/review-queue",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/documents/review-queue${query(ref)}`),
    received: () => mocks.listLowConfidenceReviewQueue.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "POST /search/aggregate",
    omitted: "unfiltered",
    call: (app, ref) => app.request("/search/aggregate", post({ q: "terms", workspaceIds: ref === undefined ? [] : [ref] })),
    received: () => mocks.aggregateWorkspaceRagSearch.mock.calls[0]?.[0]?.request.workspaceIds[0],
  },
  {
    route: "POST /runs",
    omitted: "default",
    call: (app, ref) => app.request("/runs", post({ ...withRef(ref), totalDocuments: 1 })),
    received: () => mocks.createRun.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "POST /runs/preview",
    omitted: "default",
    call: (app, ref) => app.request("/runs/preview", post({
      ...withRef(ref),
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }],
    })),
    received: () => mocks.getRunProcessingPreview.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "GET /ai/usage",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/ai/usage${query(ref)}`, { headers: { Authorization: "Bearer dslp_test" } }),
    received: () => mocks.getAutomationUsage.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "GET /notifications/inbox",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/notifications/inbox${query(ref)}`),
    received: () => mocks.listNotificationInbox.mock.calls[0]?.[0]?.workspaceId,
  },
  {
    route: "POST /notifications/inbox/read-all",
    omitted: "unfiltered",
    call: (app, ref) => app.request("/notifications/inbox/read-all", post(withRef(ref))),
    received: () => mocks.markAllNotificationsRead.mock.calls[0]?.[0]?.workspaceId,
  },
];

const references: Array<[label: string, ref: string | undefined, expected: (b: Boundary) => string | undefined]> = [
  ["UUID", WS_ID, () => WS_ID],
  ["slug", "legal", () => WS_ID],
  ["former slug", "old-legal", () => WS_ID],
  ["default", "default", () => DEFAULT_ID],
  ["omitted", undefined, (b) => (b.omitted === "default" ? DEFAULT_ID : undefined)],
];

describe("workspace reference boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.validateApiKey.mockResolvedValue(apiKey);
    mocks.ensureDefaultWorkspace.mockResolvedValue({ id: DEFAULT_ID, orgId: "org-1", userId: "user-1" });
    mocks.createDirectUploadSession.mockResolvedValue({ sessionId: "session-1" });
    mocks.listDocumentsWithFilters.mockResolvedValue([]);
    mocks.listDocumentIndexEntries.mockResolvedValue({ entries: [] });
    mocks.listLowConfidenceReviewQueue.mockResolvedValue([]);
    mocks.aggregateWorkspaceRagSearch.mockResolvedValue({ workspaces: [] });
    mocks.createRun.mockImplementation(async (input: { workspaceId: string }) => ({ id: "run-1", orgId: "org-1", workspaceId: input.workspaceId, kind: "bulk-upload", totalDocuments: 1 }));
    mocks.getRunProcessingPreview.mockResolvedValue({ estimatedPages: 1 });
    mocks.getAutomationUsage.mockResolvedValue({});
    mocks.listNotificationInbox.mockResolvedValue({ deliveries: [], unreadCount: 0 });
    mocks.markAllNotificationsRead.mockResolvedValue(0);
  });

  for (const boundary of boundaries) {
    describe(boundary.route, () => {
      it.each(references)("resolves a %s reference", async (_label, ref, expected) => {
        const response = await boundary.call(buildApp(), ref);
        expect(response.status, await response.clone().text()).toBeLessThan(300);
        expect(boundary.received()).toBe(expected(boundary));
      });

      if (boundary.route !== "POST /search/aggregate") {
        it("answers 404 for an unknown reference", async () => {
          const response = await boundary.call(buildApp(), "no-such-workspace");
          expect(response.status).toBe(404);
        });
      }
    });
  }

  it("answers 404, not 500, when the default workspace's organization is not the caller's", async () => {
    mocks.ensureDefaultWorkspace.mockRejectedValue(
      new WorkspaceAccessError(404, "organization_not_found", "Organization not found"),
    );
    const app = buildApp();
    const runs = await app.request("/runs", post({ totalDocuments: 1 }));
    expect(runs.status).toBe(404);
    await expect(runs.json()).resolves.toMatchObject({ code: "organization_not_found" });
    const direct = await app.request("/ingest/direct/sessions", post({
      orgId: "org-other",
      files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }],
    }));
    expect(direct.status).toBe(404);
  });
});
