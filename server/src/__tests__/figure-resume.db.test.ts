import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * On-demand figure resumes (services/figure-resume.ts, POST /documents/:id/assets/resume, POST /projects/:id/figures/resume)
 * and the chat's proposal (services/figure-resume-proposals.ts) over a migrated database with real API keys: only queues,
 * never across organizations or projects, never for a key without `ingest` or a revoked one, capped per request, and
 * never for a project whose figures or resumes are off.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let service: typeof import("../services/figure-resume.js");
let proposals: typeof import("../services/figure-resume-proposals.js");
let app: Hono;

const SHA = "a".repeat(64);

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com'), ('uv', 'V', 'v@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org-a', 'ua', 'owner'), ('org-b', 'ub', 'owner'), ('org-a', 'uv', 'member')`;
  await sql`insert into projects(id, org_id, user_id, name, is_default, pipeline) values
    ('proj-a', 'org-a', 'ua', 'A', true, '{}'), ('proj-a2', 'org-a', 'ua', 'A2', false, '{}'), ('proj-off', 'org-a', 'ua', 'Off', false, '{"figureResume":"off"}'),
    ('proj-m', 'org-a', 'ua', 'M', false, '{"figureResume":"manual"}'), ('proj-b', 'org-b', 'ub', 'B', true, '{}')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}'), ('run-off', 'org-a', 'ua', 'proj-off', 'upload', 'completed', 'completed', '{}'),
    ('run-m', 'org-a', 'ua', 'proj-m', 'upload', 'completed', 'completed', '{}'), ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'completed', 'completed', '{}')`;
  keys = await import("../services/api-keys.js");
  service = await import("../services/figure-resume.js");
  proposals = await import("../services/figure-resume-proposals.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { projectsRoutes } = await import("../routes/projects.js");
  const { syntheticApiKeySessionUser } = await import("../lib/request-actor.js");
  app = new Hono();
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = await keys.validateApiKey(auth.slice(7));
      if (!key) return c.json({ error: "invalid key" }, 401);
      c.set("apiKey", key);
      c.set("sessionUser", syntheticApiKeySessionUser(key));
    } else {
      c.set("sessionUser", { id: c.req.header("x-test-user") ?? "nobody" } as never);
    }
    await next();
  });
  app.route("/documents", documentsRoutes);
  app.route("/projects", projectsRoutes);
}, 600_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

/** A resumable, current level for `doc` (a partial pass left one image a resume would retry). */
async function resumableDocument(doc: string, project = "proj-a", org = "org-a", run = "run-a", user = "ua") {
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, source_sha256)
    values (${doc}, ${org}, ${user}, ${project}, ${run}, 'x.pdf', 'application/pdf', ${`k-${doc}`}, 'completed', 3, ${SHA})`;
  await sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason, resumable, format, storage_state)
    values (${doc}, ${org}, ${project}, ${run}, 'p3.2', 3, 'picture', 'inline', 'not-extracted', 'budget', true, 'webp', 'none')`;
  await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, manifest_version,
      manifest_key, manifest_sha256, assets_total, assets_not_extracted, assets_resumable)
    values (${doc}, ${org}, ${project}, ${run}, true, 'resumable', 3, ${`${user}/${run}/doppler/${doc}/images/manifest.jsonl`}, ${SHA}, 1, 1, 1)`;
}

beforeEach(async () => {
  await sql`delete from document_extraction_levels`;
  await sql`delete from document_assets`;
  await sql`delete from documents`;
  await sql`delete from chat_sessions`;
});

const queued = async (doc: string) => (await sql<{ q: boolean }[]>`select resume_after is not null as q from document_extraction_levels where document_id = ${doc}`)[0]?.q;

describe("POST /documents/:id/assets/resume", () => {
  const post = (doc: string, headers: Record<string, string>) => app.request(`/documents/${doc}/assets/resume`, { method: "POST", headers });

  it("an editor's session or a server key with ingest queues it; again is already-queued", async () => {
    await resumableDocument("doc-a");
    const res = await post("doc-a", { "x-test-user": "ua" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ documentId: "doc-a", status: "queued" });
    expect(await queued("doc-a")).toBe(true);
    const { rawKey } = await keys.createApiKey("ua", "ingest", { orgId: "org-a", scopes: ["ingest"], keyType: "server", projectIds: ["proj-a"] });
    expect(await (await post("doc-a", { authorization: `Bearer ${rawKey}` })).json()).toEqual({ documentId: "doc-a", status: "already-queued" });
  });

  it("cross-tenant, another project's key, a key without ingest, a client key and a revoked key are refused; nothing is queued", async () => {
    await resumableDocument("doc-a");
    // Org B's session and key: the same 404 as a missing document.
    expect((await post("doc-a", { "x-test-user": "ub" })).status).toBe(404);
    const b = await keys.createApiKey("ub", "b", { orgId: "org-b", scopes: ["ingest"], keyType: "server" });
    expect((await post("doc-a", { authorization: `Bearer ${b.rawKey}` })).status).toBe(404);
    // Org A, a key restricted to another project.
    const other = await keys.createApiKey("ua", "other", { orgId: "org-a", scopes: ["ingest"], keyType: "server", projectIds: ["proj-a2"] });
    expect((await post("doc-a", { authorization: `Bearer ${other.rawKey}` })).status).toBe(404);
    // Wrong scope and a client key.
    const readOnly = await keys.createApiKey("ua", "read", { orgId: "org-a", scopes: ["artifacts"], keyType: "server" });
    expect((await post("doc-a", { authorization: `Bearer ${readOnly.rawKey}` })).status).toBe(403);
    const client = await keys.createApiKey("ua", "client", { orgId: "org-a", scopes: ["ingest"], keyType: "client" });
    expect((await post("doc-a", { authorization: `Bearer ${client.rawKey}` })).status).toBe(403);
    // A revoked key never authenticates.
    const revoked = await keys.createApiKey("ua", "revoked", { orgId: "org-a", scopes: ["ingest"], keyType: "server" });
    await keys.revokeApiKey(revoked.id, "ua");
    expect((await post("doc-a", { authorization: `Bearer ${revoked.rawKey}` })).status).toBe(401);
    // A member who cannot edit the project.
    expect((await post("doc-a", { "x-test-user": "uv" })).status).toBe(404);
    expect(await queued("doc-a")).toBe(false);
  });

  it("is off for a project whose resumes are off, and capped after three attempts", async () => {
    await resumableDocument("doc-off", "proj-off", "org-a", "run-off");
    expect(await (await post("doc-off", { "x-test-user": "ua" })).json()).toEqual({ documentId: "doc-off", status: "off" });
    expect(await queued("doc-off")).toBe(false);
    await resumableDocument("doc-a");
    await sql`update document_extraction_levels set resume_blocked = 'attempts', resumes = 3 where document_id = 'doc-a'`;
    expect(await (await post("doc-a", { "x-test-user": "ua" })).json()).toEqual({ documentId: "doc-a", status: "capped" });
  });

  it("a manual project queues on request only (the backstop leaves it alone)", async () => {
    await resumableDocument("doc-m", "proj-m", "org-a", "run-m");
    await sql`update document_extraction_levels set updated_at = now() - interval '1 hour'`;
    service.resetFigureResumeBackstopForTest();
    expect(await service.sweepFigureResumeQueue()).toBe(0);
    expect(await (await post("doc-m", { "x-test-user": "ua" })).json()).toEqual({ documentId: "doc-m", status: "queued" });
  });
});

describe("POST /projects/:id/figures/resume", () => {
  it("queues at most 100 per request and says more remain", async () => {
    for (let i = 0; i < 103; i += 1) await resumableDocument(`d-${String(i).padStart(3, "0")}`);
    const res = await app.request("/projects/proj-a/figures/resume", { method: "POST", headers: { "x-test-user": "ua" } });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ projectId: "proj-a", status: "queued", queued: 100, capped: true });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from document_extraction_levels where resume_after is not null`)[0]!.n).toBe(100);
    // A limit below the cap is honoured; then the rest.
    const next = await app.request("/projects/proj-a/figures/resume?limit=2", { method: "POST", headers: { "x-test-user": "ua" } });
    expect(await next.json()).toMatchObject({ queued: 2, capped: true });
    expect((await app.request("/projects/proj-a/figures/resume?limit=0", { method: "POST", headers: { "x-test-user": "ua" } })).status).toBe(400);
  });

  it("never queues another organization's project, and the backstop only touches auto projects", async () => {
    await resumableDocument("doc-a");
    await resumableDocument("doc-b", "proj-b", "org-b", "run-b", "ub");
    expect((await app.request("/projects/proj-b/figures/resume", { method: "POST", headers: { "x-test-user": "ua" } })).status).toBe(404);
    expect(await queued("doc-b")).toBe(false);
    await sql`update document_extraction_levels set updated_at = now() - interval '1 hour'`;
    service.resetFigureResumeBackstopForTest();
    expect(await service.sweepFigureResumeQueue()).toBe(2);
  });
});

describe("the chat's proposal", () => {
  const actor = (userId: string, sessionId = "auth-1") => ({ type: "session", userId, sessionId, user: { id: userId, email: "", name: "" } }) as never;

  it("is prepared only for an editor in the project's own chat session, scoped to its organization, and Apply queues", async () => {
    await resumableDocument("doc-a");
    await resumableDocument("doc-b", "proj-b", "org-b", "run-b", "ub");
    await sql`insert into chat_sessions (id, project_id, user_id) values ('chat-a', 'proj-a', 'ua'), ('chat-b', 'proj-b', 'ub')`;
    vi.doMock("../lib/first-party-app.js", () => ({ isFirstPartyAppActor: (a: { type: string }) => a.type === "session" }));
    vi.resetModules();
    vi.doMock("../db.js", () => ({ sql }));
    const fresh = await import("../services/figure-resume-proposals.js");
    const proposal = await fresh.proposeFigureResume({ actor: actor("ua"), projectId: "proj-a", sessionId: "chat-a" });
    expect(proposal).toMatchObject({ projectId: "proj-a", documentId: null, documents: 1, more: false, credits: 0 });
    // Another org's project, another user's session, a document of another org: refused.
    await expect(fresh.proposeFigureResume({ actor: actor("ua"), projectId: "proj-b", sessionId: "chat-b" })).rejects.toMatchObject({ status: 403 });
    await expect(fresh.proposeFigureResume({ actor: actor("ub"), projectId: "proj-a", sessionId: "chat-a" })).rejects.toMatchObject({ status: 403 });
    await expect(fresh.proposeFigureResume({ actor: actor("ua"), projectId: "proj-a", sessionId: "chat-a", documentId: "doc-b" })).rejects.toMatchObject({ status: 400 });
    // The token belongs to its actor and project.
    await expect(fresh.applyFigureResumeProposal({ actor: actor("ub"), projectId: "proj-a", token: proposal.token })).rejects.toMatchObject({ status: 403 });
    await expect(fresh.applyFigureResumeProposal({ actor: actor("ua"), projectId: "proj-a2", token: proposal.token })).rejects.toMatchObject({ status: 403 });
    await expect(fresh.applyFigureResumeProposal({ actor: actor("ua"), projectId: "proj-a", token: `${proposal.token}x` })).rejects.toMatchObject({ status: 403 });
    await expect(fresh.applyFigureResumeProposal({ actor: actor("ua"), projectId: "proj-a", token: proposal.token, now: Date.now() + 11 * 60_000 })).rejects.toMatchObject({ status: 410 });
    expect(await fresh.applyFigureResumeProposal({ actor: actor("ua"), projectId: "proj-a", token: proposal.token })).toMatchObject({ applied: true, queued: 1 });
    expect(await queued("doc-a")).toBe(true);
    expect(await queued("doc-b")).toBe(false);
    vi.doUnmock("../lib/first-party-app.js");
  });

  it("refuses an API key (never the first-party app)", async () => {
    await resumableDocument("doc-a");
    const keyActor = { type: "apiKey", userId: "ua", apiKey: { keyId: "k", userId: "ua", orgId: "org-a", keyType: "server", scopes: ["ingest"], projectIds: [] } } as never;
    await expect(proposals.proposeFigureResume({ actor: keyActor, projectId: "proj-a", sessionId: "chat-a" })).rejects.toMatchObject({ status: 403 });
  });
});
