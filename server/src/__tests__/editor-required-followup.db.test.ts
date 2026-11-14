import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, EDITOR_REQUIRED_MESSAGE } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Follow-up to the editors-only rule (#389): project reads carry this caller's `canEdit` (R1), and every editor-only
 * refusal answers 403 `editor_required` (R3): graph settings, rebuild, its estimate and cancel, chat-instructions Improve,
 * a page render start, clone and rollback. Another organization still gets 404.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let app: Hono;
const SECRET = "cd".repeat(32);

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
  }));
  vi.doMock("../services/run-lifecycle.js", () => ({ runLifecycle: { start: vi.fn(async () => ({ status: "started" })) } }));

  await sql`insert into "user"(id, name, email) values
    ('ua', 'Admin', 'admin@example.com'), ('ue', 'Editor', 'editor@example.com'), ('uv', 'Viewer', 'viewer@example.com'),
    ('um', 'Member', 'member@example.com'), ('ub', 'Other', 'other@example.com'), ('ux', 'Second admin', 'admin2@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values
    ('org-a', 'A', 'a', 'ua', 100000, now()), ('org-b', 'B', 'b', 'ub', 100000, now())`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('org-a', 'ua', 'admin'), ('org-a', 'ue', 'member'), ('org-a', 'uv', 'member'), ('org-a', 'um', 'member'), ('org-a', 'ux', 'admin'),
    ('org-b', 'ub', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name, slug, is_default, pipeline) values
    ('proj-a', 'org-a', 'ua', 'A', 'proj-a', true, ${sql.json(defaultPipelineFeatures as never)}),
    ('proj-b', 'org-b', 'ub', 'B', 'proj-b', true, '{}')`;
  await sql`insert into project_members (project_id, user_id, role) values ('proj-a', 'ue', 'editor'), ('proj-a', 'uv', 'viewer')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total) values
    ('run-a', 'org-a', 'ua', 'proj-a', 'bulk-upload', 'completed', 'completed', ${sql.json(defaultPipelineFeatures as never)}, 1, 4)`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ua/raw/a.pdf', 'completed', 4)`;
  await sql`update documents set parse_source_scan_version = 1, parse_source_sha256 = ${"e".repeat(64)} where id = 'doc-a'`;

  keys = await import("../services/api-keys.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { projectsRoutes } = await import("../routes/projects.js");
  const { projectGraphRoutes } = await import("../routes/project-graph.js");
  const { chatInstructionsRoutes } = await import("../routes/chat-instructions.js");
  const { dashboardRoutes } = await import("../routes/frontend.js");
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
      c.set("requestActor", { type: "session", userId: user, sessionId: `session-${user}`, user: { id: user, email: `${user}@example.com`, name: user } } as never);
      context.setCurrentRequestUserId(user);
      context.setCurrentRequestSessionId(`session-${user}`);
    }
    await next();
  });
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/projects", projectsRoutes);
  app.route("/v1/projects", projectGraphRoutes);
  app.route("/v1/projects", chatInstructionsRoutes);
  app.route("/dashboard/bootstrap", dashboardRoutes);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(() => { vi.stubEnv("FILE_TOKEN_SECRET", SECRET); });

type Caller = { headers: Record<string, string> };
const as = (user: string): Caller => ({ headers: { "x-test-user": user } });
const bearer = (raw: string): Caller => ({ headers: { authorization: `Bearer ${raw}` } });
async function send(caller: Caller, method: string, path: string, body?: unknown): Promise<Response> {
  return await app.request(path, { method, headers: { ...caller.headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("project reads carry canEdit (R1)", () => {
  const listFlag = async (caller: Caller) => {
    const body = await (await send(caller, "GET", "/v1/projects")).json() as { projects: Array<{ id: string; canEdit?: boolean }> };
    return body.projects.find((project) => project.id === "proj-a")?.canEdit;
  };
  const detailFlag = async (caller: Caller) => (await (await send(caller, "GET", "/v1/projects/proj-a")).json() as { canEdit?: boolean }).canEdit;

  it("is false for a default-project viewer and a plain member, true for an editor and both admins", async () => {
    for (const user of ["uv", "um"]) {
      expect(await listFlag(as(user)), user).toBe(false);
      expect(await detailFlag(as(user)), user).toBe(false);
    }
    for (const user of ["ue", "ua", "ux"]) {
      expect(await listFlag(as(user)), user).toBe(true);
      expect(await detailFlag(as(user)), user).toBe(true);
    }
  });

  it("the dashboard bootstrap carries it too", async () => {
    const flag = async (user: string) => ((await (await send(as(user), "GET", "/dashboard/bootstrap")).json()) as { projects: Array<{ id: string; canEdit?: boolean }> })
      .projects.find((project) => project.id === "proj-a")?.canEdit;
    expect(await flag("uv")).toBe(false);
    expect(await flag("ue")).toBe(true);
  });

  it("a key needs ingest as well as an editor user; another org never sees the project", async () => {
    const { rawKey: artifacts } = await keys.createApiKey("ue", `a-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    const { rawKey: ingest } = await keys.createApiKey("ue", `i-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts", "ingest"], projectIds: ["proj-a"] });
    const { rawKey: viewerIngest } = await keys.createApiKey("uv", `v-${randomUUID()}`, { orgId: "org-a", scopes: ["artifacts", "ingest"], projectIds: ["proj-a"] });
    expect(await listFlag(bearer(artifacts))).toBe(false);
    expect(await listFlag(bearer(ingest))).toBe(true);
    expect(await listFlag(bearer(viewerIngest))).toBe(false);
    expect(await listFlag(as("ub"))).toBeUndefined();
    expect((await send(as("ub"), "GET", "/v1/projects/proj-a")).status).toBe(404);
  });
});

describe("editor-only refusals answer 403 editor_required (R3)", () => {
  const PATHS: Array<[string, (caller: Caller, foreign?: boolean) => Promise<Response>]> = [
    ["graph settings", (caller, f) => send(caller, "PATCH", `/v1/projects/${f ? "proj-b" : "proj-a"}/graph`, { domain: "Annual reports" })],
    ["graph rebuild", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/graph/rebuild`, { mode: "full" })],
    ["graph rebuild estimate", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/graph/jobs/estimate`, { mode: "full" })],
    ["graph cancel", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/graph/jobs/job-x/cancel`)],
    ["chat-instructions Improve", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/chat-instructions/improve`, { instructions: "Be brief." })],
    ["page render start", (caller, f) => send(caller, "POST", `/v1/documents/${f ? "doc-b" : "doc-a"}/pages/1/image`)],
    ["clone", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/clone`, { name: "Copy" })],
    ["rollback", (caller, f) => send(caller, "POST", `/v1/projects/${f ? "proj-b" : "proj-a"}/versions/missing-version/rollback`, {})],
  ];

  it.each(PATHS)("%s: viewer and member 403 editor_required; editors past it; another org 404", async (_name, call) => {
    for (const user of ["uv", "um"]) {
      const response = await call(as(user));
      expect(response.status, `${user}: ${await response.clone().text()}`).toBe(403);
      expect(await response.json(), user).toMatchObject({ error: { code: "editor_required", message: EDITOR_REQUIRED_MESSAGE } });
    }
    for (const user of ["ue", "ux"]) {
      const response = await call(as(user));
      const text = await response.text();
      expect(response.status === 403 && text.includes("editor_required"), `${user}: ${response.status} ${text}`).toBe(false);
    }
    expect((await call(as("ub"))).status).toBe(404);
    expect((await call(as("ua"), true)).status).toBe(404);
  });

  it("a viewer may still read a page image (GET) without starting a render", async () => {
    const response = await send(as("uv"), "GET", "/v1/documents/doc-a/pages/1/image");
    expect(response.status).not.toBe(403);
  });
});
