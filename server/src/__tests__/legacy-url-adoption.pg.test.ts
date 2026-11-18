import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { canonicalIdForUrl, opaqueCanonicalIdForUrl } from "../lib/canonical-id.js";

/**
 * Real PostgreSQL, two sessions: legacy URL adoption against a worker
 * completing a legacy row (row locks and the supersession trigger's advisory
 * lock), and a reprocess racing a URL re-ingest. Single-connection PGlite cannot
 * interleave sessions. Needs a migrated, disposable loopback TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;
const pdfFacts = { declaredMimeType: "application/pdf", sniffedMimeType: "application/pdf", mimeType: "application/pdf", format: "pdf", container: null, encoding: null, mismatch: "none" };

describe.skipIf(!url)("legacy URL adoption under concurrency (real PostgreSQL)", () => {
  let pool: postgres.Sql;
  let worker: postgres.Sql;
  let runCreation: ReturnType<typeof import("../services/run-creation.js").createRunCreation>;

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires a loopback TEST_DATABASE_URL");
    pool = postgres(url, { max: 6, prepare: false, onnotice: () => {} });
    worker = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql: pool }));
    vi.doMock("../services/source-metadata.js", async (importOriginal) => ({
      ...await importOriginal<typeof import("../services/source-metadata.js")>(),
      resolveSourceMetadata: vi.fn(async () => ({ pageCount: 1, sourceSha256: `sha-${randomUUID()}`, fileFacts: pdfFacts })),
    }));
    vi.doMock("../lib/temporal.js", () => ({
      startPipelineWorkflow: vi.fn(async () => {}), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
      isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
    }));
    const creation = await import("../services/run-creation.js");
    runCreation = creation.createRunCreation({ sql: pool, start: vi.fn(async () => ({ status: "started" })) } as never);
  }, 120_000);
  afterAll(async () => { await pool?.end(); await worker?.end(); });

  /** A fresh org and project with one URL-intake run, and helpers for this URL's legacy chain. */
  async function scenario() {
    const id = randomUUID().slice(0, 8);
    const [user, org, project, run] = [`u-${id}`, `o-${id}`, `w-${id}`, `run-${id}`];
    const sourceUrl = `https://files.example.com/d/${id}.pdf?X-Amz-Signature=SIG`;
    await pool`insert into "user" (id, name, email) values (${user}, 'U', ${`${id}@example.test`})`;
    await pool`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values (${org}, 'O', ${org}, ${user}, 100000)`;
    await pool`insert into org_memberships (org_id, user_id, role) values (${org}, ${user}, 'owner')`;
    await pool`insert into projects (id, org_id, user_id, name) values (${project}, ${org}, ${user}, 'W')`;
    await pool`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (100, ${run}, ${org}, ${user}, ${project}, 'url-ingest', 'completed', 'index', '{}'::jsonb)`;
    const legacyDoc = async (doc: string, status: string, created: string, version: number) => pool`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, metadata, version_number, created_at,
        page_count, page_count_source, billing_pages, file_size)
      values (${doc}, ${org}, ${user}, ${project}, ${run}, 'report.pdf', 'application/pdf', ${`k/${doc}`}, ${status}, ${canonicalIdForUrl(sourceUrl)},
        ${pool.json({ sourceUrl })}, ${version}, ${created}, 1, 'counted', 1, 1000)`;
    const ingest = () => runCreation.create({
      userId: user, projectId: project, kind: "url-ingest", pipeline: defaultPipelineFeatures,
      sources: { kind: "files", files: [{ filename: "files.example.com-0.pdf", mimeType: "application/pdf", sourceKey: `u/raw/${randomUUID()}`, fileSize: 1000, canonicalId: opaqueCanonicalIdForUrl(sourceUrl), metadata: { sourceUrl } }] },
    } as never);
    const reprocess = (documentId: string) => runCreation.create({
      userId: user, projectId: project, kind: "bulk-reprocess", pipeline: defaultPipelineFeatures,
      sources: { kind: "versionsOf", documentIds: [documentId] },
    } as never);
    const chain = () => pool<{ id: string; canonical_id: string; version_number: number; previous_version_id: string | null; superseded: boolean }[]>`
      select id, canonical_id, version_number, previous_version_id, superseded_at is not null as superseded
      from documents where project_id = ${project} order by created_at, id`;
    return { project, sourceUrl, opaque: opaqueCanonicalIdForUrl(sourceUrl), legacyDoc, ingest, reprocess, chain, ids: { l1: `l1-${id}`, l2: `l2-${id}` } };
  }

  it("does not deadlock with a worker completing a legacy row: adoption locks newest first and waits for it", async () => {
    const s = await scenario();
    await s.legacyDoc(s.ids.l1, "completed", "2026-01-01", 1);
    await s.legacyDoc(s.ids.l2, "processing", "2026-01-02", 2);
    // Session 1 (the worker) holds the newest legacy row, as its completing UPDATE does.
    const connection = await worker.reserve();
    await connection`begin`;
    await connection`select id from documents where id = ${s.ids.l2} for update`;
    // Session 2 (run creation) starts adopting the chain while the worker holds L2.
    const ingest = s.ingest();
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The worker now completes L2: its supersession trigger takes the legacy key and row-locks L1. Had adoption
    // locked L1 first (oldest first), this would cycle (40P01); newest first, adoption holds nothing here yet.
    await connection`update documents set status = 'completed' where id = ${s.ids.l2}`;
    await connection`commit`;
    connection.release();
    await expect(ingest).resolves.toBeTruthy();
    const chain = await s.chain();
    expect(chain.map((row) => row.canonical_id)).toEqual([s.opaque, s.opaque, s.opaque]);
    const created = chain.find((row) => ![s.ids.l1, s.ids.l2].includes(row.id))!;
    expect(created).toMatchObject({ version_number: 3, previous_version_id: s.ids.l2 });
    expect(chain.find((row) => row.id === s.ids.l1)!.superseded).toBe(true);
  });

  it("serializes a reprocess with a URL re-ingest of the same URL: one chain, under the opaque key, no number reused", async () => {
    const s = await scenario();
    await s.legacyDoc(s.ids.l1, "completed", "2026-01-01", 1);
    // Both race: the reprocess of the legacy source and a re-ingest of its URL, on separate connections.
    const results = await Promise.allSettled([s.reprocess(s.ids.l1), s.ingest(), s.reprocess(s.ids.l1), s.ingest()]);
    for (const result of results) expect(result.status, String((result as PromiseRejectedResult).reason)).toBe("fulfilled");
    const chain = await s.chain();
    expect(chain).toHaveLength(5);
    // Nothing is left under, or recreated under, the raw-URL key.
    expect(new Set(chain.map((row) => row.canonical_id))).toEqual(new Set([s.opaque]));
    expect(new Set(chain.map((row) => row.version_number)).size).toBe(chain.length);
  });
});
