import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";
import { CURRENT_INGEST_VERSION, DATA_UNAVAILABLE_MESSAGES, dataUnavailableSchema } from "@docslurp/shared";

/**
 * Ingest version tagging (migration 0160) and the typed unavailable states (ingest-version.ts) over a migrated database
 * with real API keys. Contract: a page, figure or structured result the caller may see but that cannot be shown answers a
 * typed 200 state, never a 409/5xx or raw error; a document outside the caller's scope stays the same 404 as a missing
 * one and carries no reason, version or other hint.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let app: Hono;

const SHA = "a".repeat(64);
const FORBIDDEN_HINTS = ["unavailable", "reason", "ingestVersion", "needs-reprocess", "withheld", "canReprocess"];

beforeAll(async () => {
  vi.stubEnv("FILE_TOKEN_SECRET", "ingest-version-test-secret-0123456789abcdef");
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (load) => ({ ...(await load<typeof import("../lib/temporal.js")>()), startPageRenderWorkflow: vi.fn() }));
  await sql`insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com'), ('uv', 'V', 'v@example.com'), ('ue', 'E', 'e@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org-a', 'ua', 'owner'), ('org-b', 'ub', 'owner'), ('org-a', 'uv', 'viewer'), ('org-a', 'ue', 'member')`;
  await sql`insert into projects(id, org_id, user_id, name, is_default) values ('proj-a', 'org-a', 'ua', 'A', true), ('proj-b', 'org-b', 'ub', 'B', true),
    ('proj-c', 'org-a', 'ua', 'C', false)`;
  // ue edits project C and only views project A (the default project).
  await sql`insert into project_members (project_id, user_id, role) values ('proj-c', 'ue', 'editor'), ('proj-a', 'ue', 'viewer')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}'), ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'completed', 'completed', '{}')`;
  // Rows inserted without the new columns are what the migration backfilled: version 0, no capabilities.
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('doc-old', 'org-a', 'ua', 'proj-a', 'run-a', 'old.pdf', 'application/pdf', 'ka', 'completed', 3),
    ('doc-text', 'org-a', 'ua', 'proj-a', 'run-a', 'notes.txt', 'text/plain', 'kt', 'completed', 1),
    ('doc-busy', 'org-a', 'ua', 'proj-a', 'run-a', 'busy.pdf', 'application/pdf', 'kc', 'embed', 3),
    ('doc-pii', 'org-a', 'ua', 'proj-a', 'run-a', 'pii.pdf', 'application/pdf', 'kp', 'pii_blocked', 3),
    ('doc-failed', 'org-a', 'ua', 'proj-a', 'run-a', 'failed.pdf', 'application/pdf', 'kf', 'failed', 3),
    ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'completed', 3),
    ('doc-c', 'org-a', 'ua', 'proj-c', 'run-a', 'c.pdf', 'application/pdf', 'kcc', 'completed', 1)`;
  // Structured results recorded for a PII-blocked document and for one whose policy withheld the result.
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri) values
    ('run-a', 'doc-pii', 'structured-extract', 'completed', 's3://bucket/structured/doc-pii.json'),
    ('run-a', 'doc-text', 'structured-extract', 'completed', 's3://bucket/structured/doc-text.json')`;
  await sql`update documents set metadata = ${sql.json({ pii: { withheldArtifactUris: ["s3://bucket/structured/doc-text.json"] } })} where id = 'doc-text'`;
  await sql`insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, assets_total,
      assets_not_extracted, assets_resumable, resume_blocked)
    values ('doc-old', 'org-a', 'proj-a', 'run-a', true, 'resumable', 1, 1, 1, 'unscanned')`;
  await sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
      resumable, format, link_path, storage_state) values
    ('doc-old', 'org-a', 'proj-a', 'run-a', 'p1.1', 1, 'picture', 'block', 'not-extracted', 'min_side', false, 'webp', 'images/page-0001/image-001.webp', 'none')`;
  await sql`insert into document_page_states (document_id, page_number, state, failure_reason) values
    ('doc-old', 1, 'failed', 'source-unscanned'), ('doc-old', 2, 'blocked-pii', null), ('doc-old', 3, 'indexed', null),
    ('doc-c', 1, 'failed', 'source-unscanned')`;
  const candidates = [1, 2, 3].map((page) => ({ documentId: "doc-old", page }));
  await sql`insert into search_sessions (id, user_id, project_id, query, metadata) values
    ('sess-a', 'ua', 'proj-a', 'q', ${sql.json({ diagnostics: { deferredCandidates: candidates } })}),
    ('sess-b', 'ub', 'proj-b', 'q', ${sql.json({ diagnostics: { deferredCandidates: candidates } })}),
    ('sess-e', 'ue', 'proj-c', 'q', ${sql.json({ diagnostics: { deferredCandidates: [{ documentId: "doc-old", page: 1 }, { documentId: "doc-c", page: 1 }] } })})`;
  keys = await import("../services/api-keys.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { ingestVersionRoutes } = await import("../routes/ingest-version.js");
  const { searchesRoutes } = await import("../routes/search.js");
  const { syntheticApiKeySessionUser } = await import("../lib/request-actor.js");
  const context = await import("../lib/request-context.js");
  app = new Hono();
  // What the API's auth does: a session user, or a validated key (revoked and expired keys never are), bound to the request.
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
      c.set("sessionUser", { id: user } as never);
      context.setCurrentRequestUserId(user);
      context.setCurrentRequestSessionId(`session-${user}`);
    }
    await next();
  });
  app.route("/documents", documentsRoutes);
  app.route("/ingest-version", ingestVersionRoutes);
  app.route("/searches", searchesRoutes);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const as = (user: string) => ({ headers: { "x-test-user": user } });
const bearer = (raw: string) => ({ headers: { authorization: `Bearer ${raw}` } });
const pageImage = (doc: string, init: { headers: Record<string, string> }, method = "GET") =>
  app.request(`/documents/${doc}/pages/1/image`, { ...init, method });

describe("migration 0160", () => {
  it("backfills existing rows as version 0 with no capabilities, on documents and runs", async () => {
    const docs = await sql<{ ingest_version: number; ingest_capabilities: string[] }[]>`select ingest_version, ingest_capabilities from documents`;
    expect(docs.length).toBeGreaterThan(0);
    for (const row of docs) expect(row).toEqual({ ingest_version: 0, ingest_capabilities: [] });
    const runs = await sql<{ ingest_version: number }[]>`select ingest_version from project_runs`;
    for (const row of runs) expect(row.ingest_version).toBe(0);
    await expect(sql`update documents set ingest_version = -1 where id = 'doc-old'`).rejects.toThrow();
  });
});

describe("GET /ingest-version", () => {
  it("reports the workspace's current version", async () => {
    const response = await app.request("/ingest-version", as("ua"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ingestVersion: CURRENT_INGEST_VERSION, capabilities: ["parseSourceDecision", "pageFacts", "figureLedger"] });
  });
});

describe("document detail", () => {
  it("carries the document's ingest status against the workspace's", async () => {
    const body = await (await app.request("/documents/doc-old", as("ua"))).json();
    expect(body.document).toMatchObject({ ingestVersion: 0, ingestCapabilities: [] });
    expect(body.ingest).toEqual({ version: 0, capabilities: [], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: true });
  });

  it("reports a stamped document as current, with its measured capabilities", async () => {
    await sql`update documents set ingest_version = ${CURRENT_INGEST_VERSION}, ingest_capabilities = '{pageFacts}' where id = 'doc-text'`;
    try {
      const body = await (await app.request("/documents/doc-text", as("ua"))).json();
      expect(body.ingest).toEqual({ version: CURRENT_INGEST_VERSION, capabilities: ["pageFacts"], currentVersion: CURRENT_INGEST_VERSION, updateAvailable: false });
    } finally {
      await sql`update documents set ingest_version = 0, ingest_capabilities = '{}' where id = 'doc-text'`;
    }
  });
});

describe("page images: typed unavailable states", () => {
  it("a document without a current parse decision answers needs-reprocess (200), still refusing to render", async () => {
    for (const method of ["GET", "POST"]) {
      const response = await pageImage("doc-old", as("ua"), method);
      expect(response.status).toBe(200);
      const body = dataUnavailableSchema.parse(await response.json());
      expect(body).toEqual({
        status: "unavailable", reason: "needs-reprocess", message: DATA_UNAVAILABLE_MESSAGES["needs-reprocess"], canReprocess: true,
        ingestVersion: 0, currentIngestVersion: CURRENT_INGEST_VERSION,
      });
    }
    // Nothing was queued: the security refusal is unchanged, only its presentation.
    expect((await sql`select 1 from document_page_renders where document_id = 'doc-old'`).length).toBe(0);
  });

  it("maps file type, processing, PII block and failure to their reasons", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["doc-text", "not-supported", false],
      ["doc-busy", "processing", false],
      ["doc-pii", "withheld", false],
      ["doc-failed", "not-extracted", true],
    ];
    for (const [doc, reason, canReprocess] of cases) {
      const response = await pageImage(doc, as("ua"));
      expect(response.status, doc).toBe(200);
      expect(await response.json(), doc).toMatchObject({ status: "unavailable", reason, canReprocess });
    }
  });

  it("offers a reprocess only to a caller who may start one", async () => {
    // An org viewer (read-only) sees the state without the action.
    expect(await (await pageImage("doc-old", as("uv"))).json()).toMatchObject({ reason: "needs-reprocess", canReprocess: false });
    const { rawKey: readOnly } = await keys.createApiKey("ua", "artifacts", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect(await (await pageImage("doc-old", bearer(readOnly))).json()).toMatchObject({ reason: "needs-reprocess", canReprocess: false });
    const { rawKey: writer } = await keys.createApiKey("ua", "writer", { orgId: "org-a", scopes: ["artifacts", "ingest"], projectIds: ["proj-a"] });
    expect(await (await pageImage("doc-old", bearer(writer))).json()).toMatchObject({ reason: "needs-reprocess", canReprocess: true });
  });

  it("cross-tenant: another organization's document is the same 404 as a missing one, with no state or version", async () => {
    const missing = await pageImage("doc-does-not-exist", as("ub"));
    for (const doc of ["doc-old", "doc-pii", "doc-text"]) {
      const response = await pageImage(doc, as("ub"));
      expect(response.status).toBe(404);
      const text = await response.text();
      for (const hint of FORBIDDEN_HINTS) expect(text).not.toContain(hint);
      expect(text).not.toContain(doc);
      expect(response.status).toBe(missing.status);
    }
    const { rawKey: foreign } = await keys.createApiKey("ub", "foreign", { orgId: "org-b", scopes: ["artifacts", "ingest"] });
    const response = await pageImage("doc-old", bearer(foreign));
    expect(response.status).toBe(404);
    const text = await response.text();
    for (const hint of FORBIDDEN_HINTS) expect(text).not.toContain(hint);
  });

  it("a revoked key gets no state at all", async () => {
    const { key, rawKey } = await keys.createApiKey("ua", "revoked", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect((await pageImage("doc-old", bearer(rawKey))).status).toBe(200);
    await keys.revokeApiKey(key.id, "ua");
    const response = await pageImage("doc-old", bearer(rawKey));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("needs-reprocess");
  });
});

describe("structured results", () => {
  it("a document with no structured result answers a typed state, not a 404", async () => {
    const response = await app.request("/documents/doc-old/structured", as("ua"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ structured: null, availability: { status: "unavailable", reason: "not-extracted", canReprocess: true } });
    expect(await (await app.request("/documents/doc-pii/structured", as("ua"))).json()).toMatchObject({ availability: { reason: "withheld", canReprocess: false } });
    expect(await (await app.request("/documents/doc-busy/structured", as("ua"))).json()).toMatchObject({ availability: { reason: "processing" } });
  });

  it("never serves a PII-blocked document's fields, or a result its policy withheld, even when the stage recorded one", async () => {
    for (const doc of ["doc-pii", "doc-text"]) {
      const response = await app.request(`/documents/${doc}/structured`, as("ua"));
      expect(response.status, doc).toBe(200);
      const body = await response.json();
      expect(body, doc).toEqual({ structured: null, uri: null, availability: expect.objectContaining({ reason: "withheld", canReprocess: false }) });
      expect(JSON.stringify(body)).not.toContain("s3://");
    }
  });

  it("cross-tenant: stays a 404 with no state", async () => {
    const response = await app.request("/documents/doc-old/structured", as("ub"));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("unavailable");
  });
});

describe("figure ledger", () => {
  it("types a not-extracted image and a blocked figure resume", async () => {
    const ledger = await (await app.request("/documents/doc-old/assets", as("ua"))).json();
    expect(ledger.assets[0]).toMatchObject({ id: "p1.1", slot: null, availability: { status: "unavailable", reason: "not-extracted", canReprocess: false, ingestVersion: 0 } });
    expect(ledger.level.resumeBlocked).toMatchObject({ status: "unavailable", reason: "needs-reprocess", canReprocess: true, ingestVersion: 0 });
    const viewer = await (await app.request("/documents/doc-old/assets", as("uv"))).json();
    expect(viewer.level.resumeBlocked).toMatchObject({ reason: "needs-reprocess", canReprocess: false });
  });

  it("cross-tenant: another organization reads nothing", async () => {
    const response = await app.request("/documents/doc-old/assets", as("ub"));
    expect(response.status).toBe(404);
    const text = await response.text();
    for (const hint of FORBIDDEN_HINTS) expect(text).not.toContain(hint);
  });
});

describe("search materialization", () => {
  it("types pages that will not materialize", async () => {
    vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
    try {
      const body = await (await app.request("/searches/sess-a/materialization", as("ua"))).json();
      expect(body.pages).toEqual([
        { documentId: "doc-old", page: 1, state: "failed", reason: "quarantine-rescan-required",
          availability: expect.objectContaining({ status: "unavailable", reason: "needs-reprocess", canReprocess: true, ingestVersion: 0 }) },
        { documentId: "doc-old", page: 2, state: "blocked-pii", availability: expect.objectContaining({ reason: "withheld", canReprocess: false }) },
        { documentId: "doc-old", page: 3, state: "indexed" },
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("FILE_TOKEN_SECRET", "ingest-version-test-secret-0123456789abcdef");
    }
  });

  it("decides canReprocess per document's own project: an editor of C who only views A gets false on an A page", async () => {
    vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
    try {
      const body = await (await app.request("/searches/sess-e/materialization", as("ue"))).json();
      const byDoc = Object.fromEntries(body.pages.map((page: { documentId: string; availability?: { canReprocess: boolean } }) => [page.documentId, page.availability]));
      expect(byDoc["doc-old"]).toMatchObject({ reason: "needs-reprocess", canReprocess: false });
      expect(byDoc["doc-c"]).toMatchObject({ reason: "needs-reprocess", canReprocess: true });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("FILE_TOKEN_SECRET", "ingest-version-test-secret-0123456789abcdef");
    }
  });

  it("cross-tenant: a session naming another organization's pages learns nothing about them", async () => {
    vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
    try {
      // Org B's own session lists org A's page ids as candidates: no state, reason or version of them leaks.
      const body = await (await app.request("/searches/sess-b/materialization", as("ub"))).json();
      expect(body.pages).toEqual([1, 2, 3].map((page) => ({ documentId: "doc-old", page, state: "unseen" })));
      expect(body).toMatchObject({ ready: 0, failed: 0 });
      // And org A's session is not org B's to read.
      expect((await app.request("/searches/sess-a/materialization", as("ub"))).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("FILE_TOKEN_SECRET", "ingest-version-test-secret-0123456789abcdef");
    }
  });
});
