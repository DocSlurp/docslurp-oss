import { defaultPipelineFeatures, mergePipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Ingest report against a database built from server/db/migrations (0054 adds
 * document_page_facts): seeded text-only, scanned, mixed and audio files in
 * one workspace, a second organization's workspace that must never leak in,
 * and the editor-only apply and reprocess actions.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let report: typeof import("../services/ingest-report.js");
let workspaces: typeof import("../services/workspaces.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(), startPipelineWorkflow: vi.fn() }));

  const json = (value: unknown) => sql.json(value as postgres.JSONValue);
  await sql`insert into "user"(id, name, email) values ('owner', 'Owner', 'o@x'), ('viewer', 'Viewer', 'v@x'), ('stranger', 'S', 's@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'One', 'one', 'owner', 100000), ('o2', 'Two', 'two', 'stranger', 100000)`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'owner', 'owner'), ('o1', 'viewer', 'member'), ('o2', 'stranger', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline) values
    ('w1', 'o1', 'owner', 'Contracts', ${json(defaultPipelineFeatures)}),
    ('w2', 'o2', 'stranger', 'Other org', ${json(defaultPipelineFeatures)})`;
  await sql`insert into workspace_members(workspace_id, user_id, role) values ('w1', 'viewer', 'viewer')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total, pages_processed, created_at, updated_at)
    values ('r1', 'o1', 'owner', 'w1', 'bulk-upload', 'completed', 'completed', ${json(defaultPipelineFeatures)}, 4, 11, 11, now() - interval '2 minutes', now()),
           ('r2', 'o2', 'stranger', 'w2', 'bulk-upload', 'completed', 'completed', ${json(defaultPipelineFeatures)}, 1, 50, 50, now() - interval '1 minute', now())`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_size) values
    ('text', 'o1', 'owner', 'w1', 'r1', 'handbook.pdf', 'application/pdf', 'k/text', 'completed', 3, 300000),
    ('scan', 'o1', 'owner', 'w1', 'r1', 'scan.pdf', 'application/pdf', 'k/scan', 'completed', 2, 2000000),
    ('mixed', 'o1', 'owner', 'w1', 'r1', 'mixed.pdf', 'application/pdf', 'k/mixed', 'completed', 4, 900000),
    ('call', 'o1', 'owner', 'w1', 'r1', 'call.mp3', 'audio/mpeg', 'k/call', 'completed', 1, 5000000),
    ('foreign', 'o2', 'stranger', 'w2', 'r2', 'secret.pdf', 'application/pdf', 'k/foreign', 'completed', 50, 9000000)`;
  const chunk = (doc: string, run: string, index: number, page: number | null) => sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number)
    values (${`${doc}-${index}`}, ${doc}, ${run}, 'owner', ${index}, ${"word ".repeat(300)}, ${page})`;
  for (const [index, page] of [[0, 1], [1, 2], [2, 3]] as const) await chunk("text", "r1", index, page);
  for (const [index, page] of [[0, 1], [1, 3]] as const) await chunk("mixed", "r1", index, page);
  for (let index = 0; index < 50; index++) await chunk("foreign", "r2", index, index + 1);
  const facts = (doc: string, run: string, rows: Array<[number, number, number, string | null]>) => Promise.all(rows.map(([page, text, images, vision]) => sql`
    insert into document_page_facts (document_id, page_number, run_id, text_bytes, word_count, image_count, facts_source, vision_status)
    values (${doc}, ${page}, ${run}, ${text}, ${Math.round(text / 6)}, ${images}, 'pdftotext+pdfimages', ${vision})`));
  await facts("text", "r1", [[1, 2400, 0, null], [2, 2100, 0, null], [3, 1800, 1, null]]);
  await facts("scan", "r1", [[1, 0, 1, "not-selected"], [2, 0, 1, "not-selected"]]);
  await facts("mixed", "r1", [[1, 2000, 0, "not-selected"], [2, 0, 1, "not-selected"], [3, 1900, 0, "not-selected"], [4, 0, 1, "not-selected"]]);
  await facts("foreign", "r2", Array.from({ length: 50 }, (_, index) => [index + 1, 0, 3, "over-cap"] as [number, number, number, string]));
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, stats) values
    ('r1', 'scan', 'vision-extract', 'completed', ${json({ skipped: true, reason: "page-triage-skip", pages: 2, selectedPages: [] })}),
    ('r1', 'mixed', 'vision-extract', 'completed', ${json({ skipped: true, reason: "page-triage-skip", pages: 4, selectedPages: [] })}),
    ('r2', 'foreign', 'vision-extract', 'failed', ${json({})}),
    ('r2', 'foreign', 'classify-route', 'completed', ${json({ tablePages: 40 })})`;
  await sql`insert into performance_log (id, user_id, run_id, document_id, scope, stage_name, metric, value, unit, metadata) values
    ('p1', 'stranger', 'r2', 'foreign', 'document', 'embed', 'detected-language', 1, 'ratio', ${json({ detectedLanguage: "fr" })})`;

  report = await import("../services/ingest-report.js");
  workspaces = await import("../services/workspaces.js");
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function workspace(id: string, userId: string) {
  const record = await workspaces.getWorkspace(id, userId);
  if (!record) throw new Error(`no access to ${id} for ${userId}`);
  return record;
}

describe("ingest report on a migrated database", () => {
  it("reports the workspace's own files page by page", async () => {
    const result = await report.loadIngestReport({ workspace: await workspace("w1", "owner"), canEdit: true });
    expect(result.files.total).toBe(4);
    expect(result.files.byType).toEqual([
      { type: "pdf", files: 3, pages: 9, bytes: 3_200_000 },
      { type: "audio", files: 1, pages: 1, bytes: 5_000_000 },
    ]);
    expect(result.pages.total).toBe(10);
    expect(result.text).toMatchObject({ recordedPages: 9, zeroTextPages: 4, avgBytesPerPage: Math.round((2400 + 2100 + 1800 + 2000 + 1900) / 9) });
    expect(result.images).toMatchObject({ recordedPages: 9, pagesWithImages: 5, scannedLookingPages: 4 });
    expect(result.searchability.searchablePages).toBe(5);
    expect(result.searchability.byReason).toEqual([{ reason: "scanned-no-vision", pages: 4 }]);
    expect(result.stages.skipped).toEqual([{ stage: "vision-extract", reason: "page-triage-skip", documents: 2 }]);
    expect(result.media).toMatchObject({ audioFiles: 1, mediaFilesWithoutText: 1 });
    expect(result.performance.pagesPerMinute).toBeCloseTo(5.5, 1);
    const vision = result.recommendations.find((rec) => rec.id === "vision-all-pages");
    expect(vision).toMatchObject({ affectedPages: 4, affectedDocuments: 2 });
    expect(vision?.reprocessDocumentIds.sort()).toEqual(["mixed", "scan"]);
  });

  it("never mixes in another organization's files, stages, languages or pages", async () => {
    const own = await workspace("w1", "owner");
    const all = await report.loadIngestReport({ workspace: own, canEdit: true });
    const text = JSON.stringify(all);
    expect(text).not.toContain("secret.pdf");
    expect(text).not.toContain("foreign");
    expect(all.languages).toEqual([]);
    expect(all.tables.pages).toBe(0);
    expect(all.stages.failed).toEqual([]);
    expect(all.extraction.visionOverCapPages).toBe(0);

    // Another workspace's run or document ids match nothing in this workspace.
    const viaRun = await report.loadIngestReport({ workspace: own, canEdit: true, runId: "r2" });
    expect(viaRun.files.total).toBe(0);
    expect(viaRun.scope.matchedDocuments).toBe(0);
    const viaIds = await report.loadIngestReport({ workspace: own, canEdit: true, documentIds: ["foreign", "scan"] });
    expect(viaIds.files.total).toBe(1);
    expect(JSON.stringify(viaIds)).not.toContain("secret.pdf");

    // The other org's members cannot load this workspace at all.
    await expect(workspaces.getWorkspace("w1", "stranger")).resolves.toBeNull();
  });

  it("scopes to one run", async () => {
    const result = await report.loadIngestReport({ workspace: await workspace("w1", "owner"), canEdit: true, runId: "r1" });
    expect(result.scope).toMatchObject({ runId: "r1", matchedDocuments: 4, documents: 4 });
  });

  it("lets viewers read but not apply or reprocess", async () => {
    const asViewer = await workspace("w1", "viewer");
    const read = await report.loadIngestReport({ workspace: asViewer, canEdit: false });
    expect(read.files.total).toBe(4);
    await expect(report.applyIngestRecommendation({ workspace: asViewer, userId: "viewer", recommendationId: "vision-all-pages" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(report.reprocessIngestRecommendation({ workspace: asViewer, userId: "viewer", recommendationId: "vision-all-pages" }))
      .rejects.toMatchObject({ status: 403 });
    const [{ pipeline }] = await sql<{ pipeline: { vision?: { forceAllPages?: boolean } } }[]>`select pipeline from workspaces where id = 'w1'`;
    expect(pipeline.vision?.forceAllPages ?? false).toBe(false);
  });

  it("applies a recommendation for an editor by merging onto the stored pipeline", async () => {
    await sql`update workspaces set pipeline = ${sql.json(mergePipelineFeatures(defaultPipelineFeatures, { summarize: true }) as unknown as postgres.JSONValue)} where id = 'w1'`;
    const asOwner = await workspace("w1", "owner");
    await expect(report.applyIngestRecommendation({ workspace: asOwner, userId: "owner", recommendationId: "made-up" }))
      .rejects.toMatchObject({ status: 409 });
    const applied = await report.applyIngestRecommendation({ workspace: asOwner, userId: "owner", recommendationId: "vision-all-pages" });
    expect(applied.pipeline.vision).toMatchObject({ forceAllPages: true, maxPagesPerDocument: 4 });
    expect(applied.pipeline.summarize).toBe(true);
    // The rule no longer fires the same way once vision covers every page; the scans still need reprocessing.
    const after = await report.loadIngestReport({ workspace: await workspace("w1", "owner"), canEdit: true });
    expect(after.config.find((item) => item.key === "vision.forceAllPages")?.value).toBe("On");
  });

  it("reprocesses the affected files with the workspace's current settings", async () => {
    const asOwner = await workspace("w1", "owner");
    // Vision already reads every page now, so the recommendation is a reprocess only.
    const after = await report.loadIngestReport({ workspace: asOwner, canEdit: true });
    expect(after.recommendations.find((rec) => rec.id === "reprocess-with-vision")?.patch).toBeNull();
    const result = await report.reprocessIngestRecommendation({ workspace: asOwner, userId: "owner", recommendationId: "reprocess-with-vision" });
    expect(result.documentIds.sort()).toEqual(["mixed", "scan"]);
    expect(result.runs).toHaveLength(1);
    const [run] = await sql<{ pipeline: { vision: { forceAllPages: boolean } }; workspace_id: string }[]>`
      select pipeline, workspace_id from workspace_runs where id = ${result.runs[0]!.id}`;
    expect(run).toMatchObject({ workspace_id: "w1", pipeline: { vision: { forceAllPages: true } } });
    const versions = await sql<{ filename: string; file_size: number; page_count: number }[]>`
      select filename, file_size::int as file_size, page_count from documents where run_id = ${result.runs[0]!.id} order by filename`;
    expect(versions).toEqual([{ filename: "mixed.pdf", file_size: 900000, page_count: 4 }, { filename: "scan.pdf", file_size: 2000000, page_count: 2 }]);
    const [{ pages_total }] = await sql<{ pages_total: number }[]>`select pages_total from workspace_runs where id = ${result.runs[0]!.id}`;
    expect(pages_total).toBe(6);
  });

  it("recomputes the report the action came from (document scope)", async () => {
    const asOwner = await workspace("w1", "owner");
    await expect(report.reprocessIngestRecommendation({ workspace: asOwner, userId: "owner", recommendationId: "reprocess-with-vision", documentIds: ["text"] }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("counts chunks that span pages for every page they cover", async () => {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_size)
      values ('span', 'o1', 'owner', 'w1', 'r1', 'span.pdf', 'application/pdf', 'k/span', 'completed', 3, 1000)`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number, metadata) values
      ('span-0', 'span', 'r1', 'owner', 0, ${"a".repeat(900)}, 1, '{}'::jsonb),
      ('span-1', 'span', 'r1', 'owner', 1, ${"b".repeat(1000)}, null, ${sql.json({ pageNumbers: [2, 3] })})`;
    const result = await report.loadIngestReport({ workspace: await workspace("w1", "owner"), canEdit: true, documentIds: ["span"] });
    expect(result.searchability).toMatchObject({ searchablePages: 3, unsearchablePages: 0 });
    expect(result.text.indexedPerPage.samples).toBe(3);
  });
});
