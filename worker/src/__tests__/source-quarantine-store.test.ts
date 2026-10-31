import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postgresSourceQuarantine } from "../sandbox/source-quarantine.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// #234 round 5 (M3): a source whose command teardown failed is denylisted by its server-computed
// hash, so the same bytes cannot quarantine another worker, whoever uploads them.
let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1'), ('o2', 'Other', 'other', 'u2');
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u2', 'W2');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w1', 'upload', 'processing', 'render-images', '{}', 3),
             ('run-2', 'o2', 'u2', 'w2', 'upload', 'processing', 'render-images', '{}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, source_sha256)
      values ('hostile', 'o1', 'u1', 'w1', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 1, 'aaaa'),
             ('same-bytes-other-org', 'o2', 'u2', 'w2', 'run-2', 'b.pdf', 'application/pdf', 'k2', 'processing', 1, 'aaaa'),
             ('innocent', 'o1', 'u1', 'w1', 'run-1', 'c.pdf', 'application/pdf', 'k3', 'processing', 1, 'bbbb'),
             ('unhashed', 'o1', 'u1', 'w1', 'run-1', 'd.pdf', 'application/pdf', 'k4', 'processing', 1, null),
             ('swapped', 'o1', 'u1', 'w1', 'run-1', 'p.pdf', 'application/pdf', 'k5', 'processing', 1, 'pppp'),
             ('popular-other-org', 'o2', 'u2', 'w2', 'run-2', 'p.pdf', 'application/pdf', 'k6', 'processing', 1, 'pppp');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1 });
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

describe("postgres source quarantine", () => {
  it("records the document's source hash with its owner and refuses every document with those bytes", async () => {
    const store = postgresSourceQuarantine(sql);
    expect(await store.find("hostile")).toBeNull();
    expect(await store.record({ documentId: "hostile", runId: "run-1", stage: "render-images", detail: "pdftoppm teardown could not be verified", ttlHours: 168 }))
      .toEqual({ sourceSha256: "aaaa", orgId: "o1", workspaceId: "w1" });
    // Recording again (a second worker raced it) keeps the first attribution.
    expect(await store.record({ documentId: "same-bytes-other-org", detail: "again", ttlHours: 168 })).toEqual({ sourceSha256: "aaaa", orgId: "o1", workspaceId: "w1" });
    expect(await store.find("hostile")).toEqual({ sourceSha256: "aaaa", orgId: "o1", workspaceId: "w1" });
    expect(await store.find("same-bytes-other-org")).toMatchObject({ sourceSha256: "aaaa" });
    expect(await store.find("innocent")).toBeNull();
    expect(await store.find("missing")).toBeNull();
  });

  it("expires, so a false positive heals itself, and keeps every organization that hit it", async () => {
    const store = postgresSourceQuarantine(sql);
    await sql`delete from quarantined_sources`;
    await store.record({ documentId: "hostile", runId: "run-1", stage: "render-images", detail: "held", ttlHours: 168 });
    const [listed] = await sql`select expires_at - created_at as ttl, org_ids, teardown_count, refused_count from quarantined_sources where source_sha256 = 'aaaa'`;
    expect(String(listed!.ttl)).toMatch(/^(7 days|168:00:00)/);
    expect(listed!.org_ids).toEqual(["o1"]);
    // A refusal of the same bytes in another organization joins the attribution.
    await store.noteRefusal({ documentId: "same-bytes-other-org", sourceSha256: "aaaa" });
    await store.noteRefusal({ documentId: "same-bytes-other-org", sourceSha256: "aaaa" });
    const [refused] = await sql`select org_id, org_ids, last_org_id, last_document_id, refused_count from quarantined_sources where source_sha256 = 'aaaa'`;
    expect(refused).toEqual({ org_id: "o1", org_ids: ["o1", "o2"], last_org_id: "o2", last_document_id: "same-bytes-other-org", refused_count: 2 });
    // A refusal note for another document's bytes changes nothing.
    await store.noteRefusal({ documentId: "innocent", sourceSha256: "aaaa" });
    expect((await sql`select refused_count from quarantined_sources where source_sha256 = 'aaaa'`)[0]!.refused_count).toBe(2);
    // Once expired, the bytes are admitted again.
    await sql`update quarantined_sources set expires_at = now() - interval '1 second' where source_sha256 = 'aaaa'`;
    expect(await store.find("hostile")).toBeNull();
    expect(await store.find("same-bytes-other-org")).toBeNull();
    // A new attributable failure lists them again, keeps the first attribution and counts it.
    expect(await store.record({ documentId: "same-bytes-other-org", detail: "again", ttlHours: 1 })).toEqual({ sourceSha256: "aaaa", orgId: "o1", workspaceId: "w1" });
    expect(await store.find("hostile")).toMatchObject({ sourceSha256: "aaaa" });
    const [again] = await sql`select teardown_count, org_ids, expires_at > now() + interval '50 minutes' as fresh from quarantined_sources where source_sha256 = 'aaaa'`;
    expect(again).toEqual({ teardown_count: 2, org_ids: ["o1", "o2"], fresh: true });
  });

  it("cannot list a document without a source hash", async () => {
    const store = postgresSourceQuarantine(sql);
    expect(await store.record({ documentId: "unhashed", detail: "x", ttlHours: 168 })).toBeNull();
    expect(await store.find("unhashed")).toBeNull();
  });
});

// #234 round 7 (H2): the quarantine keys on the hash of the bytes the worker staged, so a source
// replaced after upload cannot list another tenant's popular file, nor hide listed hostile bytes.
describe("postgres source quarantine keyed by the staged hash", () => {
  it("cross-tenant poisoning: a teardown on swapped bytes lists those bytes, never the hash the server recorded", async () => {
    const store = postgresSourceQuarantine(sql);
    await sql`delete from quarantined_sources`;
    // 'swapped' claims P's hash (pppp) but the worker staged other bytes (xxxx). (Staging refuses such a
    // mismatch before any command; this is the store's own guarantee if a record ever happened.)
    expect(await store.record({ documentId: "swapped", stagedSha256: "x".repeat(64), detail: "held", ttlHours: 168 }))
      .toEqual({ sourceSha256: "x".repeat(64), orgId: "o1", workspaceId: "w1" });
    // The other organization's popular file P stays admitted.
    expect(await store.find("popular-other-org", "pppp")).toBeNull();
    expect(await store.find("popular-other-org")).toBeNull();
    // The staged hash is what is checked: the listed bytes are refused under any server hash.
    expect(await store.find("innocent", "x".repeat(64))).toMatchObject({ sourceSha256: "x".repeat(64) });
    // A document without a server hash is keyed by its staged hash.
    expect(await store.record({ documentId: "unhashed", stagedSha256: "u".repeat(64), detail: "held", ttlHours: 1 }))
      .toMatchObject({ sourceSha256: "u".repeat(64) });
    expect(await store.find("unhashed", "u".repeat(64))).toMatchObject({ sourceSha256: "u".repeat(64) });
    expect(await store.find("unhashed")).toBeNull();
  });
});

describe("postgres organization teardown breaker", () => {
  it("counts every teardown against the document's organization within the window", async () => {
    const store = postgresSourceQuarantine(sql);
    await sql`delete from org_teardown_failures`;
    expect(await store.orgFailures("hostile", 24)).toBeNull();
    expect(await store.recordOrgFailure({ documentId: "hostile", runId: "run-1", stage: "extract-markdown", attributable: false, detail: "held", windowHours: 24 }))
      .toEqual({ orgId: "o1", count: 1 });
    expect(await store.recordOrgFailure({ documentId: "innocent", attributable: true, detail: "held", windowHours: 24 })).toEqual({ orgId: "o1", count: 2 });
    // Another organization's documents are not affected.
    expect(await store.orgFailures("same-bytes-other-org", 24)).toBeNull();
    expect(await store.orgFailures("hostile", 24)).toEqual({ orgId: "o1", count: 2 });
    // The window slides: old failures stop counting.
    await sql`update org_teardown_failures set created_at = now() - interval '25 hours' where document_id = 'hostile'`;
    expect(await store.orgFailures("innocent", 24)).toEqual({ orgId: "o1", count: 1 });
    // An unknown document records nothing.
    expect(await store.recordOrgFailure({ documentId: "missing", attributable: true, detail: "x", windowHours: 24 })).toBeNull();
  });
});
