import { defaultPipelineFeatures } from "@docslurp/shared";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Page extract records' read side (services/document-page-extracts.ts, GET /documents/:id/page-extracts, the ingest
 * report's page views) over a migrated database with real API keys: organization B (or a key scoped elsewhere, without
 * `artifacts`, or revoked) never reads organization A's records.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let service: typeof import("../services/document-page-extracts.js");
let keys: typeof import("../services/api-keys.js");
let app: Hono;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org-a', 'ua', 'owner'), ('org-b', 'ub', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name, is_default) values
    ('proj-a', 'org-a', 'ua', 'A', true), ('proj-a2', 'org-a', 'ua', 'A2', false), ('proj-b', 'org-b', 'ub', 'B', true)`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run-a', 'org-a', 'ua', 'proj-a', 'upload', 'completed', 'completed', '{}'), ('run-b', 'org-b', 'ub', 'proj-b', 'upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'completed', 3),
    ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'completed', 3)`;
  await sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, engine, billed_class, tags,
      confidence, text_bytes, is_final, superseded_by_pass) values
    ('doc-a', 'org-a', 'proj-a', 'run-a', 1, 'extract', 'text-layer', 'vm-pdf', 'fast', '{}', null, 120, true, null),
    ('doc-a', 'org-a', 'proj-a', 'run-a', 2, 'extract', 'none', 'vm-pdf', null, '{scanned}', null, null, false, 'scan-ocr'),
    ('doc-a', 'org-a', 'proj-a', 'run-a', 2, 'scan-ocr', 'ocr', 'page-ocr', 'ocr', '{scanned}', 0.91, 80, true, null),
    ('doc-a', 'org-a', 'proj-a', 'run-a', 3, 'extract', 'text-layer', 'vm-pdf', 'fast', '{table}', null, 300, false, 'vision'),
    ('doc-a', 'org-a', 'proj-a', 'run-a', 3, 'vision', 'vision', 'vision-model', 'rich', '{table}', null, 280, true, null),
    ('doc-b', 'org-b', 'proj-b', 'run-b', 1, 'extract', 'text-layer', 'vm-pdf', 'fast', '{}', null, 50, true, null)`;
  await sql`insert into document_page_states (document_id, page_number, state) values ('doc-a', 3, 'blocked-pii')`;
  service = await import("../services/document-page-extracts.js");
  keys = await import("../services/api-keys.js");
  const { documentsRoutes } = await import("../routes/documents.js");
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
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("getDocumentPageExtracts", () => {
  it("returns every pass in page order, finals marked, PII-withheld pages tagged", async () => {
    const view = await service.getDocumentPageExtracts({ orgId: "org-a", documentId: "doc-a" });
    expect(view?.records.map((r) => [r.pageNumber, r.pass, r.method, r.isFinal, r.supersededByPass])).toEqual([
      [1, "extract", "text-layer", true, null],
      [2, "extract", "none", false, "scan-ocr"],
      [2, "scan-ocr", "ocr", true, null],
      [3, "extract", "text-layer", false, "vision"],
      [3, "vision", "vision", true, null],
    ]);
    expect(view?.records.at(-1)?.tags).toEqual(["table", "pii-withheld"]);
    expect(view?.records[2]?.confidence).toBeCloseTo(0.91, 5);
    expect(view?.nextAfterPage).toBeNull();
  });

  it("pages by page window and filters finals", async () => {
    const first = await service.getDocumentPageExtracts({ orgId: "org-a", documentId: "doc-a" }, { limit: 2, finalOnly: true });
    expect(first?.records.map((r) => r.pageNumber)).toEqual([1, 2]);
    expect(first?.nextAfterPage).toBe(2);
    const next = await service.getDocumentPageExtracts({ orgId: "org-a", documentId: "doc-a" }, { limit: 2, afterPage: 2, finalOnly: true });
    expect(next?.records.map((r) => [r.pageNumber, r.pass])).toEqual([[3, "vision"]]);
    await expect(service.getDocumentPageExtracts({ orgId: "org-a", documentId: "doc-a" }, { limit: 0 })).rejects.toThrow(service.DocumentPageExtractQueryError);
  });

  it("reads another organization's or project's document as missing, and refuses an unscoped read", async () => {
    expect(await service.getDocumentPageExtracts({ orgId: "org-b", documentId: "doc-a" })).toBeNull();
    expect(await service.getDocumentPageExtracts({ orgId: "org-a", projectId: "proj-a2", documentId: "doc-a" })).toBeNull();
    await expect(service.getDocumentPageExtracts({ orgId: "", documentId: "doc-a" })).rejects.toThrow();
  });
});

describe("GET /documents/:id/page-extracts", () => {
  const get = (doc: string, headers: Record<string, string>, query = "") => app.request(`/documents/${doc}/page-extracts${query}`, { headers });

  it("serves the owner's session and a key of the document's project with artifacts", async () => {
    const session = await get("doc-a", { "x-test-user": "ua" }, "?final=true");
    expect(session.status).toBe(200);
    expect(((await session.json()) as { records: unknown[] }).records).toHaveLength(3);
    const { rawKey } = await keys.createApiKey("ua", "artifacts", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect((await get("doc-a", { authorization: `Bearer ${rawKey}` })).status).toBe(200);
    expect((await get("doc-a", { "x-test-user": "ua" }, "?limit=abc")).status).toBe(400);
  });

  it("answers 404 to another organization's session and key, and to a key scoped to another project", async () => {
    expect((await get("doc-a", { "x-test-user": "ub" })).status).toBe(404);
    const { rawKey: foreign } = await keys.createApiKey("ub", "foreign", { orgId: "org-b", scopes: ["artifacts"] });
    const foreignRead = await get("doc-a", { authorization: `Bearer ${foreign}` });
    expect(foreignRead.status).toBe(404);
    expect(JSON.stringify(await foreignRead.json())).not.toContain("vm-pdf");
    expect((await get("doc-b", { authorization: `Bearer ${foreign}` })).status).toBe(200);
    const { rawKey: elsewhere } = await keys.createApiKey("ua", "elsewhere", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a2"] });
    expect((await get("doc-a", { authorization: `Bearer ${elsewhere}` })).status).toBe(404);
  });

  it("refuses a key without the artifacts scope, and a revoked key", async () => {
    const { rawKey: searchOnly } = await keys.createApiKey("ua", "search", { orgId: "org-a", scopes: ["search:deep"], projectIds: ["proj-a"] });
    expect((await get("doc-a", { authorization: `Bearer ${searchOnly}` })).status).toBe(403);
    const { key, rawKey: revoked } = await keys.createApiKey("ua", "revoked", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    await keys.revokeApiKey(key.id, "ua");
    expect((await get("doc-a", { authorization: `Bearer ${revoked}` })).status).toBe(401);
  });
});

describe("ingest report page views", () => {
  it("carry each page's final method, pass and tags, within the project", async () => {
    const { loadIngestReport } = await import("../services/ingest-report.js");
    const report = await loadIngestReport({ project: { id: "proj-a", name: "A", pipeline: defaultPipelineFeatures }, canEdit: false, documentIds: ["doc-a"], focusPages: [1, 2, 3] });
    const pages = (report.focus ?? []).map((page) => [page.pageNumber, page.extractMethod, page.finalPass, page.extractTags]);
    expect(pages).toEqual([
      [1, "text-layer", "extract", []],
      [2, "ocr", "scan-ocr", ["scanned"]],
      [3, "vision", "vision", ["table", "pii-withheld"]],
    ]);
  });
});
