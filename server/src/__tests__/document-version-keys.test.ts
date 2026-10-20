import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// PGlite is a worker dev dependency; its migrated-Postgres harness is shared by path.
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Upload version keys against a database built from db/migrations: every
 * upload is keyed by workspace + folder path + filename (or the caller's
 * canonicalId), and the existing supersede trigger keeps one current version.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let runCreation: typeof import("../services/run-creation.js").runCreation;
let eligibility: typeof import("../search/eligibility.js");
let uploads: typeof import("../lib/canonical-id.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: vi.fn(async () => {}), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  vi.doMock("../services/source-metadata.js", () => ({
    resolveSourceMetadata: async (file: { sourceKey: string }) => ({ pageCount: 1, sourceSha256: `sha-${file.sourceKey}` }),
  }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, plan_id) values ('o1', 'Org', 'org', 'u1', 100000, 'gold')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W1'), ('w2', 'o1', 'u1', 'W2')`;
  ({ runCreation } = await import("../services/run-creation.js"));
  eligibility = await import("../search/eligibility.js");
  uploads = await import("../lib/canonical-id.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from document_chunks`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

let counter = 0;

/** One upload: a run, a document row (created in order) and a chunk containing the upload's marker word. */
async function upload(workspaceId: string, filename: string, path = "", extra: { canonicalId?: string } = {}) {
  counter += 1;
  const created = await runCreation.create({
    userId: "u1",
    workspaceId,
    kind: "bulk-upload",
    pipeline: defaultPipelineFeatures,
    sources: { kind: "files", files: [{ filename, mimeType: "application/pdf", sourceKey: `raw/${counter}`, path, ...extra }] },
  });
  const runId = created.run.id;
  const doc = created.documents[0];
  await sql`update documents set created_at = to_timestamp(${1_800_000_000 + counter}) where id = ${doc!.id}`;
  await sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
    values (${`${doc!.id}-c`}, ${doc!.id}, ${runId}, 'u1', 0, ${`marker${counter} shared clause`}, '{}', 3, '{}'::jsonb)
  `;
  return doc!.id;
}

const complete = (id: string) => sql`update documents set status = 'completed' where id = ${id}`;

async function liveIds(workspaceId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select d.id from documents d
    where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
    order by d.created_at
  `;
  return rows.map((row) => row.id);
}

async function searchHits(workspaceId: string): Promise<string[]> {
  const rows = await sql<{ document_id: string }[]>`
    select c.document_id from document_chunks c join documents d on d.id = c.document_id
    where ${eligibility.lexicalSearchableDocument("d", false)}
      and d.workspace_id = ${workspaceId}
      and c.ts_content @@ websearch_to_tsquery('english', 'shared')
    order by c.document_id
  `;
  return rows.map((row) => row.document_id).sort();
}

describe("path-keyed document versions", () => {
  it("keeps the same filename in two folders as two live chains", async () => {
    const a = await upload("w1", "report.pdf", "a");
    const b = await upload("w1", "report.pdf", "b");
    await complete(a);
    await complete(b);

    expect(await liveIds("w1")).toEqual([a, b]);
    const rows = await sql<{ version_number: number; source_path: string }[]>`select version_number, source_path from documents order by created_at`;
    expect(rows).toEqual([{ version_number: 1, source_path: "a" }, { version_number: 1, source_path: "b" }]);
  });

  it("supersedes v1 on completion of a re-upload and serves only v2 chunks", async () => {
    const v1 = await upload("w1", "report.pdf", "Contracts/2025");
    await complete(v1);
    const v2 = await upload("w1", "REPORT.pdf", "contracts//2025/");
    const [row] = await sql<{ version_number: number; previous_version_id: string; source_path: string }[]>`select version_number, previous_version_id, source_path from documents where id = ${v2}`;
    expect(row).toMatchObject({ version_number: 2, previous_version_id: v1, source_path: "contracts/2025" });
    await complete(v2);

    expect(await liveIds("w1")).toEqual([v2]);
    expect(await searchHits("w1")).toEqual([v2]);
  });

  it("keeps the same name in two workspaces independent", async () => {
    const a = await upload("w1", "report.pdf", "x");
    const b = await upload("w2", "report.pdf", "x");
    await complete(a);
    await complete(b);

    expect(await liveIds("w1")).toEqual([a]);
    expect(await liveIds("w2")).toEqual([b]);
    const versions = await sql<{ version_number: number }[]>`select version_number from documents`;
    expect(versions.map((v) => v.version_number)).toEqual([1, 1]);
  });

  it("supersedes the late v1 on arrival when v2 finishes first", async () => {
    const v1 = await upload("w1", "report.pdf");
    const v2 = await upload("w1", "report.pdf");
    await complete(v2);
    await complete(v1);

    expect(await liveIds("w1")).toEqual([v2]);
    expect(await searchHits("w1")).toEqual([v2]);
    const [late] = await sql<{ superseded_by_document_id: string }[]>`select superseded_by_document_id from documents where id = ${v1}`;
    expect(late?.superseded_by_document_id).toBe(v2);
  });

  it("creates v2 for an identical re-upload", async () => {
    const v1 = await upload("w1", "same.pdf", "f");
    await sql`update documents set source_sha256 = 'identical' where id = ${v1}`;
    const v2 = await upload("w1", "same.pdf", "f");
    await sql`update documents set source_sha256 = 'identical' where id = ${v2}`;
    const [row] = await sql<{ version_number: number }[]>`select version_number from documents where id = ${v2}`;
    expect(row?.version_number).toBe(2);
  });

  it("lets an explicit canonicalId override the path key", async () => {
    const a = await upload("w1", "a.pdf", "one", { canonicalId: "https://example.com/p" });
    const b = await upload("w1", "b.pdf", "two", { canonicalId: "https://example.com/p" });
    await complete(a);
    await complete(b);
    expect(await liveIds("w1")).toEqual([b]);
  });

  it("rejects '..' segments and over-long paths", () => {
    expect(() => uploads.normalizeUploadPath("a/../b")).toThrow(uploads.InvalidCanonicalIdError);
    expect(() => uploads.normalizeUploadPath("x".repeat(1025))).toThrow(uploads.InvalidCanonicalIdError);
    expect(uploads.sourcePathsForFiles(2, { paths: JSON.stringify(["a", "b\\c"]) })).toEqual(["a", "b/c"]);
    expect(() => uploads.sourcePathsForFiles(1, { path: "../x" })).toThrow(uploads.InvalidCanonicalIdError);
  });
});
