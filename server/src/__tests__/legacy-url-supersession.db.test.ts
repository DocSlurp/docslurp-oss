import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { canonicalIdForUrl, opaqueCanonicalIdForUrl } from "../lib/canonical-id.js";
import type { SqlClient } from "../db.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let adoptLegacyUrlVersions: typeof import("../services/run-creation.js").adoptLegacyUrlVersions;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  ({ adoptLegacyUrlVersions } = await import("../services/run-creation.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'Test', 'legacy-url@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Test', 'legacy-url', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'Test')`;
  await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values (100, 'old', 'o', 'u', 'w', 'url-ingest', 'completed', 'index', '{}'::jsonb),
      (100, 'new', 'o', 'u', 'w', 'url-ingest', 'processing', 'index', '{}'::jsonb)`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("a URL re-ingest supersedes the URL's legacy documents", () => {
  const sourceUrl = "https://files.example.com/d/report.pdf?X-Amz-Signature=SIG";

  it("re-keys the legacy raw-URL row, and the new version supersedes it when it completes", async () => {
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, created_at)
      values ('legacy-doc', 'o', 'u', 'w', 'old', 'report.pdf', 'application/pdf', 'old-key', 'completed', ${canonicalIdForUrl(sourceUrl)},
        ${sql.json({ sourceUrl })}, '2026-01-01')`;
    const opaque = opaqueCanonicalIdForUrl(sourceUrl);
    const adopted = await sql.begin(async (tx) => adoptLegacyUrlVersions(tx as unknown as SqlClient, { projectId: "w", canonicalId: opaque, metadata: { sourceUrl } }));
    expect(adopted).toBe(1);
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, previous_version_id, version_number, created_at)
      values ('new-doc', 'o', 'u', 'w', 'new', 'files.example.com-0.pdf', 'application/pdf', 'new-key', 'queued', ${opaque},
        ${sql.json({ sourceUrl })}, 'legacy-doc', 2, '2026-01-02')`;
    await sql`update documents set status = 'completed' where id = 'new-doc'`;
    const rows = await sql`select id, superseded_by_document_id as replacement, superseded_at is not null as superseded from documents where project_id = 'w' order by created_at`;
    expect(rows).toEqual([
      { id: "legacy-doc", replacement: "new-doc", superseded: true },
      { id: "new-doc", replacement: null, superseded: false },
    ]);
  });

  it("never re-keys a caller's own canonical ID or a document without sourceUrl metadata", async () => {
    const other = "https://example.com/mine";
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, created_at)
      values ('upload-doc', 'o', 'u', 'w', 'old', 'mine.pdf', 'application/pdf', 'k1', 'completed', ${canonicalIdForUrl(other)}, ${sql.json({})}, '2026-01-03')`;
    // An upload that used a URL as its own canonical ID has no sourceUrl: untouched.
    expect(await sql.begin(async (tx) => adoptLegacyUrlVersions(tx as unknown as SqlClient, { projectId: "w", canonicalId: opaqueCanonicalIdForUrl(other), metadata: { sourceUrl: other } }))).toBe(0);
    // A caller-supplied canonical ID (not the server's opaque one) never adopts anything.
    expect(await sql.begin(async (tx) => adoptLegacyUrlVersions(tx as unknown as SqlClient, { projectId: "w", canonicalId: "/products", metadata: { sourceUrl } }))).toBe(0);
    expect(await sql`select canonical_id from documents where id = 'upload-doc'`).toEqual([{ canonical_id: canonicalIdForUrl(other) }]);
  });
});
