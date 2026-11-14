import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Owner decision (council L3, 2026-11-13): reprocessing and other paid work on existing content is for editors only, in
 * the org's default project too. Membership of the default project still allows uploads (canContributeToProject), never a
 * reprocess. Every path answers the same way, against a migrated database with real API keys:
 * - a default-project viewer, and a plain org member with no project role: 403;
 * - a project editor and an org admin: allowed (past authorization);
 * - a server key without `ingest`: 403; a key with `ingest` whose user may edit: allowed;
 * - another organization (session or key): the same 404 as a missing resource.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let app: Hono;
const SECRET = "ab".repeat(32);

beforeAll(async () => {
  vi.stubEnv("FILE_TOKEN_SECRET", SECRET);
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (load) => ({
    ...(await load<typeof import("../lib/temporal.js")>()),
    startPipelineWorkflow: vi.fn(async () => undefined), startPageRenderWorkflow: vi.fn(async () => undefined),
    startMaterializeWorkflow: vi.fn(async () => undefined), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(),
    signalPipelineResume: vi.fn(), isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  vi.doMock("../services/run-lifecycle.js", () => ({ runLifecycle: { start: vi.fn(async () => ({ status: "started" })) } }));

  await sql`insert into "user"(id, name, email) values
    ('ua', 'Admin', 'admin@example.com'), ('ue', 'Editor', 'editor@example.com'), ('uv', 'Viewer', 'viewer@example.com'),
    ('um', 'Member', 'member@example.com'), ('ub', 'Other', 'other@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values
    ('org-a', 'A', 'a', 'ua', 100000, now()), ('org-b', 'B', 'b', 'ub', 100000, now())`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('org-a', 'ua', 'admin'), ('org-a', 'ue', 'member'), ('org-a', 'uv', 'member'), ('org-a', 'um', 'member'), ('org-b', 'ub', 'owner')`;
  // proj-a is org A's default project: every member reaches it, which used to be enough to reprocess in it.
  // Slugs equal to the ids: a key names a project by reference, and these test ids are not UUIDs.
  await sql`insert into projects(id, org_id, user_id, name, slug, is_default, pipeline) values
    ('proj-a', 'org-a', 'ua', 'A', 'proj-a', true, ${sql.json({ ...defaultPipelineFeatures, indexingMode: "map" } as never)}),
    ('proj-b', 'org-b', 'ub', 'B', 'proj-b', true, '{}')`;
  await sql`insert into project_members (project_id, user_id, role) values ('proj-a', 'ue', 'editor'), ('proj-a', 'uv', 'viewer')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total) values
    ('run-a', 'org-a', 'uv', 'proj-a', 'bulk-upload', 'failed', 'failed', ${sql.json(defaultPipelineFeatures as never)}, 1, 4),
    ('run-b', 'org-b', 'ub', 'proj-b', 'bulk-upload', 'failed', 'failed', ${sql.json(defaultPipelineFeatures as never)}, 1, 4)`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode) values
    ('doc-a', 'org-a', 'uv', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'uv/raw/a.pdf', 'completed', 4, 'map'),
    ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'ub/raw/b.pdf', 'completed', 4, 'map')`;

  keys = await import("../services/api-keys.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { runsRoutes } = await import("../routes/runs.js");
  const { projectsRoutes } = await import("../routes/projects.js");
  const { syntheticApiKeySessionUser } = await import("../lib/request-actor.js");
  const context = await import("../lib/request-context.js");
  app = new Hono();
  app.use("*", context.requestContextMiddleware);
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = await keys.validateApiKey(auth.slice(7));
      if (!key) return c.json({ error: "invalid key" }, 401);
      c.set("apiKey", key);
      c.set("sessionUser", syntheticApiKeySessionUser(key));
      context.setCurrentRequestUserId(key.userId);
      context.setCurrentRequestApiKeyId(key.keyId);
    } else {
      const user = c.req.header("x-test-user") ?? "nobody";
      c.set("sessionUser", { id: user, email: `${user}@example.com`, name: user } as never);
      c.set("requestActor", { type: "session", userId: user, sessionId: `session-${user}`, user: { id: user } } as never);
      context.setCurrentRequestUserId(user);
      context.setCurrentRequestSessionId(`session-${user}`);
    }
    await next();
  });
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/projects", projectsRoutes);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(() => {
  vi.stubEnv("FILE_TOKEN_SECRET", SECRET);
  vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
});

type Caller = { headers: Record<string, string> };
const as = (user: string): Caller => ({ headers: { "x-test-user": user } });
const bearer = (raw: string): Caller => ({ headers: { authorization: `Bearer ${raw}` } });

/** Each reprocess or spend path, against org A's resources (`own`) or org B's (`foreign`). */
type Path = {
  name: string;
  call: (caller: Caller, foreign?: boolean) => Promise<Response>;
  keys: boolean;
  /** Past authorization for an allowed caller. Default: anything but 401/403/404. */
  allowed?: (response: Response, body: string) => boolean;
};
const pastAuthorization = (response: Response) => ![401, 403, 404].includes(response.status);
const PATHS: Path[] = [
  {
    name: "single-document reprocess", keys: true,
    call: (caller, foreign) => post(caller, "/v1/documents/bulk", { action: "reprocess", documentIds: [foreign ? "doc-b" : "doc-a"] }),
  },
  {
    name: "bulk reprocess", keys: true,
    call: (caller, foreign) => post(caller, "/v1/documents/bulk", { action: "reprocess", documentIds: foreign ? ["doc-b"] : ["doc-a", "doc-a"] }),
  },
  { name: "run reprocess", keys: true, call: (caller, foreign) => post(caller, `/v1/runs/${foreign ? "run-b" : "run-a"}/reprocess`, {}) },
  { name: "run retry", keys: false, call: (caller, foreign) => post(caller, `/v1/runs/${foreign ? "run-b" : "run-a"}/retry`, {}) },
  { name: "reindex (settings change)", keys: false, call: (caller, foreign) => patch(caller, `/v1/projects/${foreign ? "proj-b" : "proj-a"}`, { name: "Renamed" }) },
  {
    // No correction is saved (re-indexing one would call an embedding provider): an editor gets past the edit check to
    // "Correction not found", where a viewer of the same document is refused with 403.
    name: "correction re-index", keys: false,
    call: (caller, foreign) => post(caller, `/v1/documents/${foreign ? "doc-b" : "doc-a"}/correction-workbench/reindex`, {}),
    allowed: (response, body) => response.status === 404 && body.includes("Correction not found"),
  },
  { name: "document full index", keys: true, call: (caller, foreign) => post(caller, `/v1/documents/${foreign ? "doc-b" : "doc-a"}/full-index`, {}) },
  { name: "project full index", keys: true, call: (caller, foreign) => post(caller, `/v1/projects/${foreign ? "proj-b" : "proj-a"}/full-index`, {}) },
  { name: "document figure resume", keys: true, call: (caller, foreign) => post(caller, `/v1/documents/${foreign ? "doc-b" : "doc-a"}/assets/resume`, {}) },
  { name: "project figure resume", keys: true, call: (caller, foreign) => post(caller, `/v1/projects/${foreign ? "proj-b" : "proj-a"}/figures/resume`, {}) },
];

async function post(caller: Caller, path: string, body: unknown): Promise<Response> {
  return await app.request(path, { method: "POST", headers: { ...caller.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function patch(caller: Caller, path: string, body: unknown): Promise<Response> {
  return await app.request(path, { method: "PATCH", headers: { ...caller.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const runsQueued = async () => (await sql<{ n: number }[]>`select count(*)::int as n from project_runs where id not in ('run-a', 'run-b')`)[0]!.n;

describe.each(PATHS)("$name", ({ call, keys: acceptsKeys, allowed = pastAuthorization }) => {
  it("refuses a default-project viewer and a plain member with 403, queueing nothing", async () => {
    const before = await runsQueued();
    for (const user of ["uv", "um"]) {
      const response = await call(as(user));
      expect(response.status, user).toBe(403);
    }
    expect(await runsQueued()).toBe(before);
  });

  it("lets a project editor and an org admin past authorization", async () => {
    for (const user of ["ue", "ua"]) {
      const response = await call(as(user));
      const body = await response.text();
      expect(allowed(response, body), `${user} got ${response.status}: ${body}`).toBe(true);
    }
  });

  it("cross-org: another organization gets the same 404 as a missing resource", async () => {
    expect((await call(as("ub"))).status).toBe(404);
    expect((await call(as("ua"), true)).status).toBe(404);
  });

  it.skipIf(!acceptsKeys)("API keys: without ingest 403, with ingest (an editor's) allowed, another org's key 404", async () => {
    const { rawKey: artifactsOnly } = await keys.createApiKey("ue", `artifacts-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect((await call(bearer(artifactsOnly))).status).toBe(403);
    const { rawKey: viewerIngest } = await keys.createApiKey("uv", `viewer-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts", "ingest"], projectIds: ["proj-a"] });
    const viewerResponse = await call(bearer(viewerIngest));
    expect(viewerResponse.status, `a viewer's ingest key: ${await viewerResponse.clone().text()}`).toBe(403);
    const { rawKey: editorIngest } = await keys.createApiKey("ue", `editor-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts", "ingest"], projectIds: ["proj-a"] });
    const editorResponse = await call(bearer(editorIngest));
    const editorBody = await editorResponse.text();
    expect(allowed(editorResponse, editorBody), `${editorResponse.status}: ${editorBody}`).toBe(true);
    const { rawKey: foreign } = await keys.createApiKey("ub", `foreign-${randomUUID()}`, { orgId: "org-b", scopes: ["artifacts", "ingest"] });
    expect((await call(bearer(foreign))).status).toBe(404);
  });
});

describe("uploads keep the contribute rule", () => {
  it("a default-project member may still contribute (upload) though not reprocess", async () => {
    const { canContributeToProject, canEditProject, getProjectAccess, listEditableProjectIds, listReprocessableProjectIds } = await import("../services/organizations.js");
    const access = await getProjectAccess("proj-a", "um");
    expect(access && canContributeToProject(access, "um")).toBe(true);
    expect(access && canEditProject(access, "um")).toBe(false);
    expect(await listEditableProjectIds("um")).toContain("proj-a");
    expect(await listReprocessableProjectIds("um")).not.toContain("proj-a");
    expect(await listReprocessableProjectIds("uv")).not.toContain("proj-a");
    expect(await listReprocessableProjectIds("ue")).toContain("proj-a");
    expect(await listReprocessableProjectIds("ua")).toContain("proj-a");
    expect(await listReprocessableProjectIds("ub")).not.toContain("proj-a");
  });
});

describe("chat proposal Apply", () => {
  it("refuses a default-project viewer even holding a well-formed proposal for their own session", async () => {
    const { sealSettingsProposal } = await import("../lib/settings-proposal-tokens.js");
    const { applyFigureResumeProposal } = await import("../services/figure-resume-proposals.js");
    await sql`insert into chat_sessions (id, user_id, project_id) values ('chat-uv', 'uv', 'proj-a') on conflict do nothing`;
    const token = sealSettingsProposal({
      purpose: "figure-resume-proposal-v1", actor: "session:uv:session-uv", userId: "uv", sessionId: "chat-uv",
      projectId: "proj-a", orgId: "org-a", documentId: null, expiresAt: Date.now() + 60_000, jti: randomUUID(),
    });
    const actor = { type: "session", userId: "uv", sessionId: "session-uv", user: { id: "uv" } } as never;
    await expect(applyFigureResumeProposal({ actor, projectId: "proj-a", token })).rejects.toMatchObject({ status: 403 });
    const response = await post(as("uv"), "/v1/projects/proj-a/figure-resume-proposals/apply", { token });
    expect(response.status).toBe(403);
  });
});
