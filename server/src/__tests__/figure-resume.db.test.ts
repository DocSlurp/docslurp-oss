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
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  // Proposal tokens are sealed with the deployment's secret.
  process.env.BETTER_AUTH_SECRET ??= "figure-resume-test-secret-0123456789abcdef";
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
    expect(await res.json()).toEqual({ documentId: "doc-a", status: "queued", reason: null, granted: false, grantsLeft: 2 });
    expect(await queued("doc-a")).toBe(true);
    const { rawKey } = await keys.createApiKey("ua", "ingest", { orgId: "org-a", scopes: ["ingest"], keyType: "server", projectIds: ["proj-a"] });
    expect(await (await post("doc-a", { authorization: `Bearer ${rawKey}` })).json()).toMatchObject({ documentId: "doc-a", status: "already-queued" });
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
    // A browser key can never hold ingest: refused when it is created (the route also requires a server key).
    await expect(keys.createApiKey("ua", "client-ingest", { orgId: "org-a", scopes: ["ingest"], keyType: "client", allowedDomains: ["docs.example.com"] })).rejects.toThrow();
    // A revoked key never authenticates.
    const revoked = await keys.createApiKey("ua", "revoked", { orgId: "org-a", scopes: ["ingest"], keyType: "server" });
    await keys.revokeApiKey(revoked.key.id, "ua");
    expect((await post("doc-a", { authorization: `Bearer ${revoked.rawKey}` })).status).toBe(401);
    // A member who sees the document but cannot edit the project: 403, not a 404 (owner decision, council L3).
    expect((await post("doc-a", { "x-test-user": "uv" })).status).toBe(403);
    expect(await queued("doc-a")).toBe(false);
  });

  it("is off for a project whose resumes are off", async () => {
    await resumableDocument("doc-off", "proj-off", "org-a", "run-off");
    expect(await (await post("doc-off", { "x-test-user": "ua" })).json()).toMatchObject({ documentId: "doc-off", status: "off" });
    expect(await queued("doc-off")).toBe(false);
  });

  it("H4: a request never resets the failure count for a block that is not a budget stop", async () => {
    await resumableDocument("doc-a");
    await sql`update document_extraction_levels set resume_failures = 2, resume_blocked = 'stale' where document_id = 'doc-a'`;
    expect(await (await post("doc-a", { "x-test-user": "ua" })).json()).toEqual({ documentId: "doc-a", status: "queued", reason: "stale", granted: false, grantsLeft: 2 });
    expect((await sql`select resume_failures, resume_blocked, resume_grants from document_extraction_levels where document_id = 'doc-a'`)[0])
      .toEqual({ resume_failures: 2, resume_blocked: null, resume_grants: 0 });
  });

  it("budget stops: each block is visible by reason, a request clears it with a bounded grant, then it reports capped", async () => {
    await resumableDocument("doc-a");
    const state = async () => (await sql`select resume_blocked, resume_blocked_at is not null as at, resume_grants, resume_stalls, resume_failures,
      resume_unit_failures, resume_after is not null as q from document_extraction_levels where document_id = 'doc-a'`)[0];
    // Each budget reason (the runner's: launches, VM time, no progress) is cleared once per grant; two grants per run.
    const reasons = ["vm-budget", "no-progress"] as const;
    for (const [i, reason] of reasons.entries()) {
      await sql`update document_extraction_levels set resume_blocked = ${reason}, resume_blocked_at = now(), resume_after = null, resume_stalls = 3,
        resume_failures = 2, resume_unit_failures = '{"doc": 2}'::jsonb where document_id = 'doc-a'`;
      const res = await post("doc-a", { "x-test-user": "ua" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ documentId: "doc-a", status: "queued", reason, granted: true, grantsLeft: 1 - i });
      // The document's counts reset; a unit's own counts are kept (H1: a poisoned unit stays sorted last).
      expect(await state()).toEqual({ resume_blocked: null, at: false, resume_grants: i + 1, resume_stalls: 0, resume_failures: 0, resume_unit_failures: { doc: 2 }, q: true });
    }
    // Grants spent: the reason stays visible and nothing is queued; only a reprocess (a new run) starts clean.
    await sql`update document_extraction_levels set resume_blocked = 'attempts', resume_blocked_at = now(), resume_after = null where document_id = 'doc-a'`;
    const res = await post("doc-a", { "x-test-user": "ua" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documentId: "doc-a", status: "capped", reason: "attempts", granted: false, grantsLeft: 0 });
    expect(await state()).toMatchObject({ resume_blocked: "attempts", at: true, resume_grants: 2, q: false });
    // The request is audited with its reason.
    const [audit] = await sql<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_log where action = 'document.figures.resume_requested' and resource_id = 'doc-a' order by created_at desc limit 1`;
    expect(audit!.metadata).toMatchObject({ status: "capped", reason: "attempts", granted: false });
  });

  it("L5: the route and the chat offer read only the runner's stored block, never a launch count (the old 6-vs-12 disagreement)", async () => {
    await resumableDocument("doc-a");
    // An unblocked document past the old API cap (6) but under the runner's page-scaled one: still resumable everywhere.
    await sql`update document_extraction_levels set resume_vm_launches = 8 where document_id = 'doc-a'`;
    expect(await service.countResumableFigureDocuments({ orgId: "org-a", projectId: "proj-a" })).toBe(1);
    expect(await (await post("doc-a", { "x-test-user": "ua" })).json()).toMatchObject({ status: "queued", reason: null, granted: false });
    // Once the runner blocks it at its own cap, both see the block.
    await sql`update document_extraction_levels set resume_after = null, resume_blocked = 'attempts', resume_blocked_at = now(), resume_grants = 2 where document_id = 'doc-a'`;
    expect(await service.countResumableFigureDocuments({ orgId: "org-a", projectId: "proj-a" })).toBe(0);
    expect(await (await post("doc-a", { "x-test-user": "ua" })).json()).toMatchObject({ status: "capped", reason: "attempts" });
  });

  it("L4: the document detail and its asset ledger show the block reason, when it was set and the grants left; other tenants see nothing", async () => {
    await resumableDocument("doc-a");
    await sql`update document_extraction_levels set resume_blocked = 'no-progress', resume_blocked_at = now(), resume_grants = 1 where document_id = 'doc-a'`;
    const assetsRes = await app.request("/documents/doc-a/assets", { headers: { "x-test-user": "ua" } });
    expect(assetsRes.status).toBe(200);
    const assets = await assetsRes.json() as { level: { resume: Record<string, unknown> } };
    expect(assets.level.resume).toMatchObject({ queued: false, blocked: "no-progress", grantsLeft: 1 });
    expect(Date.parse(String(assets.level.resume.blockedAt))).toBeGreaterThan(0);
    // The document detail (getDocumentViewerPayload's `figureResume`) reads the same scoped state.
    expect(await service.documentFigureResumeState({ orgId: "org-a", documentId: "doc-a" })).toMatchObject({ blocked: "no-progress", grantsLeft: 1 });
    expect((await app.request("/documents/doc-a/assets", { headers: { "x-test-user": "ub" } })).status).toBe(404);
    expect(await service.documentFigureResumeState({ orgId: "org-b", documentId: "doc-a" })).toBeNull();
    // A level that is no longer current: no state.
    await sql`update document_extraction_levels set assets_current = false where document_id = 'doc-a'`;
    expect(await service.documentFigureResumeState({ orgId: "org-a", documentId: "doc-a" })).toBeNull();
  });

  it("bulk requests and the backstop never grant: a budget-blocked document is left blocked", async () => {
    await resumableDocument("doc-a");
    await resumableDocument("doc-b2");
    await sql`update document_extraction_levels set resume_blocked = 'vm-budget', updated_at = now() - interval '1 hour' where document_id = 'doc-a'`;
    await sql`update document_extraction_levels set updated_at = now() - interval '1 hour' where document_id = 'doc-b2'`;
    // L4: the bulk answer counts what it skipped, by reason.
    expect(await (await app.request("/projects/proj-a/figures/resume", { method: "POST", headers: { "x-test-user": "ua" } })).json())
      .toMatchObject({ queued: 1, blocked: { "vm-budget": 1 } });
    service.resetFigureResumeBackstopForTest();
    await sql`update document_extraction_levels set resume_after = null`;
    expect(await service.sweepFigureResumeQueue()).toBe(1);
    expect((await sql`select resume_blocked, resume_grants, resume_after is not null as q from document_extraction_levels where document_id = 'doc-a'`)[0])
      .toEqual({ resume_blocked: "vm-budget", resume_grants: 0, q: false });
    expect(await service.countResumableFigureDocuments({ orgId: "org-a", projectId: "proj-a" })).toBe(1);
  });

  it("R6-H1 F3: no request clears an unscanned block (only a new run that records a parse decision does)", async () => {
    await resumableDocument("doc-a");
    await sql`update document_extraction_levels set resume_blocked = 'unscanned' where document_id = 'doc-a'`;
    const res = await (await post("doc-a", { "x-test-user": "ua" })).json() as { status: string };
    expect(res.status).not.toBe("queued");
    expect(await (await app.request("/projects/proj-a/figures/resume", { method: "POST", headers: { "x-test-user": "ua" } })).json()).toMatchObject({ queued: 0 });
    expect((await sql`select resume_blocked, resume_after is not null as q from document_extraction_levels where document_id = 'doc-a'`)[0]).toEqual({ resume_blocked: "unscanned", q: false });
  });

  it("M1: a failed, cancelled or PII-blocked document, or one whose Markdown never committed, is not resumable", async () => {
    await resumableDocument("doc-a");
    for (const status of ["failed", "cancelled", "pii_blocked"]) {
      await sql`update documents set status = ${status} where id = 'doc-a'`;
      expect(await (await post("doc-a", { "x-test-user": "ua" })).json(), status).toMatchObject({ status: expect.stringMatching(/^(not-resumable|capped)$/) });
      expect(await queued("doc-a")).toBe(false);
    }
    await sql`update documents set status = 'completed' where id = 'doc-a'`;
    await sql`update document_extraction_levels set markdown_complete = false where document_id = 'doc-a'`;
    expect(await queued("doc-a")).toBe(false);
    await post("doc-a", { "x-test-user": "ua" });
    expect(await queued("doc-a")).toBe(false);
  });

  it("a manual project queues on request only (the backstop leaves it alone)", async () => {
    await resumableDocument("doc-m", "proj-m", "org-a", "run-m");
    await sql`update document_extraction_levels set updated_at = now() - interval '1 hour'`;
    service.resetFigureResumeBackstopForTest();
    expect(await service.sweepFigureResumeQueue()).toBe(0);
    expect(await (await post("doc-m", { "x-test-user": "ua" })).json()).toMatchObject({ documentId: "doc-m", status: "queued" });
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

  it("L10: the document past the cap keeps its block reason (selected, never updated and put back)", async () => {
    for (let i = 0; i < 3; i += 1) await resumableDocument(`e-${i}`);
    await sql`update document_extraction_levels set resume_blocked = 'stale', resume_blocked_at = now(), updated_at = now() - (interval '1 minute' * (3 - substr(document_id, 3)::int))`;
    const res = await app.request("/projects/proj-a/figures/resume?limit=2", { method: "POST", headers: { "x-test-user": "ua" } });
    expect(await res.json()).toMatchObject({ queued: 2, capped: true });
    // L2: a cleared block also clears its timestamp.
    expect(await sql`select document_id, resume_blocked, resume_blocked_at is not null as at, resume_after is not null as q from document_extraction_levels order by document_id`).toEqual([
      { document_id: "e-0", resume_blocked: null, at: false, q: true }, { document_id: "e-1", resume_blocked: null, at: false, q: true },
      { document_id: "e-2", resume_blocked: "stale", at: true, q: false },
    ]);
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
    // Single use: a replay of the same token is refused.
    await expect(fresh.applyFigureResumeProposal({ actor: actor("ua"), projectId: "proj-a", token: proposal.token })).rejects.toMatchObject({ status: 410 });
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
