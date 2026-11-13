import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The asset ledger's read side (services/document-assets.ts, GET /documents/:id/assets) over a migrated database, with
 * real API keys: org B (or a key scoped elsewhere, without `artifacts`, or revoked) never reads org A's ledger.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let service: typeof import("../services/document-assets.js");
let keys: typeof import("../services/api-keys.js");
let app: Hono;

const SHA = "f".repeat(64);

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
  for (const [doc, org, project, user] of [["doc-a", "org-a", "proj-a", "ua"], ["doc-b", "org-b", "proj-b", "ub"]] as const) {
    await sql`insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
        resumable, source, format, bytes, sha256, width, height, link_path, file_of, storage_key) values
      (${doc}, ${org}, ${project}, ${doc === "doc-a" ? "run-a" : "run-b"}, 'p1.1', 1, 'picture', 'block', 'extracted', null, false, 'render', 'webp', 20, ${SHA}, 6, 4,
        'images/page-0001/image-001.webp', 'p1.1', ${`${user}/run/doppler-figures/${doc}/p1.1.webp`}),
      (${doc}, ${org}, ${project}, null, 'p3.2', 3, 'picture', 'inline', 'not-extracted', 'budget', true, null, 'webp', null, null, null, null,
        'images/page-0003/image-002.webp', null, null)`;
    await sql`insert into document_extraction_levels (document_id, org_id, project_id, markdown_complete, images_status, images_exit_code,
        manifest_version, assets_total, assets_extracted, assets_not_extracted, assets_resumable, source_render, asset_bytes, last_cut_page)
      values (${doc}, ${org}, ${project}, true, 'resumable', 5, 2, 2, 1, 1, 1, 1, 20, 3)`;
  }
  service = await import("../services/document-assets.js");
  keys = await import("../services/api-keys.js");
  const { documentsRoutes } = await import("../routes/documents.js");
  const { syntheticApiKeySessionUser } = await import("../lib/request-actor.js");
  // What the API's auth does for these routes: a session user, or a key validated (revoked and expired keys never are).
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

describe("getDocumentAssetLedger", () => {
  it("returns the document's images, slots and level within its organization", async () => {
    const ledger = await service.getDocumentAssetLedger({ orgId: "org-a", documentId: "doc-a" });
    expect(ledger?.assets.map((a) => [a.id, a.status, a.reason, a.resumable, a.slot, a.link])).toEqual([
      ["p1.1", "extracted", null, false, "doc-a:doppler-figure:p1.1", "images/page-0001/image-001.webp"],
      ["p3.2", "not-extracted", "budget", true, null, "images/page-0003/image-002.webp"],
    ]);
    expect(ledger?.level).toMatchObject({ imagesStatus: "resumable", imagesExitCode: 5, lastCutPage: 3, counts: { total: 2, extracted: 1, resumable: 1, bytes: 20 } });
    expect(JSON.stringify(ledger)).not.toContain("doppler-figures/doc-a"); // storage keys stay internal
  });

  it("reads another organization's or project's document as missing, and refuses an unscoped read", async () => {
    expect(await service.getDocumentAssetLedger({ orgId: "org-b", documentId: "doc-a" })).toBeNull();
    expect(await service.getDocumentAssetLedger({ orgId: "org-a", projectId: "proj-a2", documentId: "doc-a" })).toBeNull();
    expect(await service.getDocumentAssetLedger({ orgId: "org-a", projectId: "proj-a", documentId: "doc-a" })).not.toBeNull();
    await expect(service.getDocumentAssetLedger({ orgId: "", documentId: "doc-a" })).rejects.toThrow();
    await expect(service.getDocumentAssetLedger({ orgId: "org-a", documentId: "doc-a' or '1'='1" })).rejects.toThrow();
  });
});

describe("GET /documents/:id/assets", () => {
  const get = (doc: string, headers: Record<string, string>) => app.request(`/documents/${doc}/assets`, { headers });

  it("serves the owner's session and a key of the document's project with artifacts", async () => {
    const session = await get("doc-a", { "x-test-user": "ua" });
    expect(session.status).toBe(200);
    expect((await session.json() as { assets: unknown[] }).assets).toHaveLength(2);
    const { rawKey } = await keys.createApiKey("ua", "artifacts", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect((await get("doc-a", { authorization: `Bearer ${rawKey}` })).status).toBe(200);
  });

  it("answers 404 to another organization's session and key, and to a key scoped to another project", async () => {
    expect((await get("doc-a", { "x-test-user": "ub" })).status).toBe(404);
    const { rawKey: foreign } = await keys.createApiKey("ub", "foreign", { orgId: "org-b", scopes: ["artifacts"] });
    const foreignRead = await get("doc-a", { authorization: `Bearer ${foreign}` });
    expect(foreignRead.status).toBe(404);
    expect(await foreignRead.text()).not.toContain("p1.1");
    expect((await get("doc-b", { authorization: `Bearer ${foreign}` })).status).toBe(200);
    const { rawKey: elsewhere } = await keys.createApiKey("ua", "elsewhere", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a2"] });
    expect((await get("doc-a", { authorization: `Bearer ${elsewhere}` })).status).toBe(404);
  });

  it("refuses a key without the artifacts scope, and a revoked key", async () => {
    const { rawKey: searchOnly } = await keys.createApiKey("ua", "search", { orgId: "org-a", scopes: ["search:deep"], projectIds: ["proj-a"] });
    expect((await get("doc-a", { authorization: `Bearer ${searchOnly}` })).status).toBe(403);
    const { key, rawKey: revoked } = await keys.createApiKey("ua", "revoked", { orgId: "org-a", scopes: ["artifacts"], projectIds: ["proj-a"] });
    expect((await get("doc-a", { authorization: `Bearer ${revoked}` })).status).toBe(200);
    await keys.revokeApiKey(key.id, "ua");
    expect((await get("doc-a", { authorization: `Bearer ${revoked}` })).status).toBe(401);
  });

  it("a document id that is not one answers 404, never an error with detail", async () => {
    const response = await get(encodeURIComponent("doc-a' or '1'='1"), { "x-test-user": "ua" });
    expect(response.status).toBe(404);
  });
});
