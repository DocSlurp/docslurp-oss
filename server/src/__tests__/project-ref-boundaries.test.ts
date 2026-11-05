import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ValidatedKey } from "../services/api-keys.js";

// Every route that takes a project in a query or body must accept the same
// references: UUID, current slug, former slug, `default`, or nothing. Action
// routes send an omitted reference to the org's default project; list and
// filter routes treat it as "no filter".
const WS_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  createDirectUploadSession: vi.fn(),
  listDocumentsWithFilters: vi.fn(),
  listDocumentIndexEntries: vi.fn(),
  aggregateProjectRagSearch: vi.fn(),
  getRunProcessingPreview: vi.fn(),
  listNotificationInbox: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  validateApiKey: vi.fn(),
  ensureDefaultProject: vi.fn(),
}));

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../services/projects.js", () => ({
  resolveProjectRef: vi.fn(async (ref: string) => {
    if (ref === WS_ID || ref === "legal") return { id: WS_ID, slug: "legal", renamedFrom: null };
    if (ref === "old-legal") return { id: WS_ID, slug: "legal", renamedFrom: "old-legal" };
    return null;
  }),
  findProjectForInput: vi.fn(async (ref: { kind: string; id?: string; slug?: string }) => {
    if (ref.kind === "id") return ref.id === WS_ID || ref.id === DEFAULT_ID ? { id: ref.id, orgId: "org-1" } : null;
    return ref.slug === "legal" || ref.slug === "old-legal" ? { id: WS_ID, orgId: "org-1" } : null;
  }),
  ensureDefaultProject: mocks.ensureDefaultProject,
  getProject: vi.fn(async (id: string) =>
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
}));
vi.mock("../services/search.js", () => ({ hybridSearch: vi.fn(), MissingProjectScopeError: class extends Error {}, CrossProjectScopeError: class extends Error {}, ProjectNotFoundError: class extends Error { constructor() { super("Project not found"); } }, }));
vi.mock("../services/project-chat.js", () => ({ chatProject: vi.fn() }));
vi.mock("../services/organizations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/organizations.js")>(),
  resolveDefaultOrganization: vi.fn(async () => ({ id: "org-1" })),
}));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateProjectRagSearch: mocks.aggregateProjectRagSearch }));
vi.mock("../services/runs.js", () => ({
  getRunProcessingPreview: mocks.getRunProcessingPreview,
  isRunCreationBlockedError: () => false,
}));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn() }));
vi.mock("../services/api-keys.js", () => ({ validateApiKey: mocks.validateApiKey }));
vi.mock("../services/notifications.js", () => ({
  listNotificationInbox: mocks.listNotificationInbox,
  markAllNotificationsRead: mocks.markAllNotificationsRead,
}));

const { uploadsRoutes } = await import("../routes/uploads.js");
const { documentsRoutes } = await import("../routes/documents.js");
const { searchRoutes } = await import("../routes/search.js");
const { runsRoutes } = await import("../routes/runs.js");
const { notificationsRoutes } = await import("../routes/notifications.js");
const { ProjectAccessError } = await import("../services/default-project.js");

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
  projectIds: [],
};

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user@example.com", name: "User" } as never);
    await next();
  });
  app.route("/uploads", uploadsRoutes);
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
const withRef = (ref: string | undefined) => (ref === undefined ? {} : { project: ref });
const query = (ref: string | undefined) => (ref === undefined ? "" : `?project=${encodeURIComponent(ref)}`);

type Boundary = {
  route: string;
  /** Action routes resolve an omitted reference to the default project. */
  omitted: "default" | "unfiltered";
  call: (app: Hono, ref: string | undefined) => Response | Promise<Response>;
  /** The project ID the service layer received. */
  received: () => unknown;
};

const boundaries: Boundary[] = [
  {
    route: "POST /uploads/direct/sessions",
    omitted: "default",
    call: (app, ref) => app.request("/uploads/direct/sessions", post({
      ...withRef(ref),
      files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }],
    })),
    received: () => mocks.createDirectUploadSession.mock.calls[0]?.[0]?.projectId,
  },
  {
    route: "GET /documents",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/documents${query(ref)}`),
    received: () => mocks.listDocumentsWithFilters.mock.calls[0]?.[0]?.projectId,
  },
  {
    route: "GET /documents/index",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/documents/index${query(ref)}`),
    received: () => mocks.listDocumentIndexEntries.mock.calls[0]?.[0]?.projectId,
  },
  {
    route: "POST /search/aggregate",
    omitted: "unfiltered",
    call: (app, ref) => app.request("/search/aggregate", post({ q: "terms", projects: ref === undefined ? [] : [ref] })),
    received: () => mocks.aggregateProjectRagSearch.mock.calls[0]?.[0]?.request.projects[0],
  },
  {
    route: "POST /runs/preview",
    omitted: "default",
    call: (app, ref) => app.request("/runs/preview", post({
      ...withRef(ref),
      files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }],
    })),
    received: () => mocks.getRunProcessingPreview.mock.calls[0]?.[0]?.projectId,
  },
  {
    route: "GET /notifications/inbox",
    omitted: "unfiltered",
    call: (app, ref) => app.request(`/notifications/inbox${query(ref)}`),
    received: () => mocks.listNotificationInbox.mock.calls[0]?.[0]?.projectId,
  },
  {
    route: "POST /notifications/inbox/read-all",
    omitted: "unfiltered",
    call: (app, ref) => app.request("/notifications/inbox/read-all", post(withRef(ref))),
    received: () => mocks.markAllNotificationsRead.mock.calls[0]?.[0]?.projectId,
  },
];

const references: Array<[label: string, ref: string | undefined, expected: (b: Boundary) => string | undefined]> = [
  ["UUID", WS_ID, () => WS_ID],
  ["slug", "legal", () => WS_ID],
  ["former slug", "old-legal", () => WS_ID],
  ["default", "default", () => DEFAULT_ID],
  ["omitted", undefined, (b) => (b.omitted === "default" ? DEFAULT_ID : undefined)],
];

describe("project reference boundaries", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.validateApiKey.mockResolvedValue(apiKey);
    mocks.ensureDefaultProject.mockResolvedValue({ id: DEFAULT_ID, orgId: "org-1", userId: "user-1" });
    mocks.createDirectUploadSession.mockResolvedValue({ sessionId: "session-1" });
    mocks.listDocumentsWithFilters.mockResolvedValue([]);
    mocks.listDocumentIndexEntries.mockResolvedValue({ entries: [] });
    mocks.aggregateProjectRagSearch.mockResolvedValue({ projects: [] });
    mocks.getRunProcessingPreview.mockResolvedValue({ estimatedPages: 1 });
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

      if (boundary.route !== "POST /uploads/direct/sessions") {
        it("answers 404 for an unknown reference", async () => {
          const response = await boundary.call(buildApp(), "no-such-project");
          expect(response.status).toBe(404);
        });
      }
    });
  }

  it("creates an unknown named project on direct upload, but 404s an unknown UUID", async () => {
    const files = [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }];
    const named = await buildApp().request("/uploads/direct/sessions", post({ project: "No Such Project", files }));
    expect(named.status).toBe(201);
    expect(mocks.createDirectUploadSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, projectName: "No Such Project" }));
    mocks.createDirectUploadSession.mockClear();
    const unknownId = await buildApp().request("/uploads/direct/sessions", post({ project: "33333333-3333-4333-8333-333333333333", files }));
    expect(unknownId.status).toBe(404);
    await expect(unknownId.json()).resolves.toMatchObject({ error: { code: "project_not_found" } });
    expect(mocks.createDirectUploadSession).not.toHaveBeenCalled();
  });

  it("answers 404, not 500, when the default project's organization is not the caller's", async () => {
    mocks.ensureDefaultProject.mockRejectedValue(
      new ProjectAccessError(404, "organization_not_found", "Organization not found"),
    );
    const app = buildApp();
    const runs = await app.request("/runs/preview", post({ files: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }] }));
    expect(runs.status).toBe(404);
    await expect(runs.json()).resolves.toMatchObject({ error: { code: "organization_not_found" } });
    const direct = await app.request("/uploads/direct/sessions", post({
      orgId: "org-other",
      files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }],
    }));
    expect(direct.status).toBe(404);
  });
});
