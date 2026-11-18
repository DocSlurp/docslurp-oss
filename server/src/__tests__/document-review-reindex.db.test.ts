import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * A human-correction reindex replaces the document's pages and chunks. A kept model read
 * (document_page_states.read_text) is page content too: it must not survive to be republished
 * by a later query materialization (round 8 M1). The billing decision (read_billed_run) stays.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let reindexDocumentCorrection: typeof import("../services/document-review.js").reindexDocumentCorrection;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/documents.js", async (importOriginal) => ({
    getDocumentViewerPayload: vi.fn(async () => null),
    replaceDocumentTagsIn: (await importOriginal<typeof import("../services/documents.js")>()).replaceDocumentTagsIn,
  }));
  vi.doMock("../search/eligibility-hint.js", () => ({ notifySearchEligibilityChanged: vi.fn(async () => {}) }));
  ({ reindexDocumentCorrection } = await import("../services/document-review.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'w', 'upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('d', 'o', 'u', 'w', 'r', 'a.pdf', 'application/pdf', 'k', 'completed', 2)`;
  await sql`insert into document_corrections (id, document_id, run_id, user_id, corrected_markdown)
    values ('c', 'd', 'r', 'u', 'Corrected page one.')`;
  await sql`insert into document_page_states (document_id, page_number, state, read_billed_run, read_text)
    values ('d', 1, 'failed', 'm1', 'OLD MODEL READ page 1'), ('d', 2, 'failed', 'm1', 'OLD MODEL READ page 2')`;
}, 120_000);

afterAll(async () => { await sql?.end(); await stop?.(); });

describe("human-correction reindex", () => {
  it("preserves omitted structured corrections and clears explicit null", async () => {
    const { saveDocumentCorrection } = await import("../services/document-review.js");
    await saveDocumentCorrection({ docId: "d", userId: "u", structuredData: { location: "corrected" } });
    await saveDocumentCorrection({docId:"d",userId:"u",markdown:"Keep corrected prose."});
    const [beforeNote] = await sql`select projection_revision from documents where id='d'`;
    await saveDocumentCorrection({ docId: "d", userId: "u", notes: "Only notes changed" });
    const [afterNote] = await sql`select projection_revision from documents where id='d'`;
    expect(afterNote).toEqual(beforeNote);
    const [prose] = await sql`select corrected_markdown from document_corrections where document_id='d'`;
    expect(prose.corrected_markdown).toBe("Keep corrected prose.");
    const [preserved] = await sql`select corrected_structured_data from document_corrections where document_id = 'd'`;
    expect(preserved.corrected_structured_data).toEqual({ location: "corrected" });
    await saveDocumentCorrection({ docId: "d", userId: "u", structuredData: null, markdown: "Corrected page one." });
    const [cleared] = await sql`select corrected_structured_data from document_corrections where document_id = 'd'`;
    expect(cleared.corrected_structured_data).toBeNull();
  });
  it("clears kept model reads of the document and keeps their billing decision", async () => {
    const result = await reindexDocumentCorrection({ docId: "d", userId: "u" });
    expect(result).toMatchObject({ documentId: "d" });
    const rows = await sql<{ page_number: number; read_billed_run: string | null; read_text: string | null }[]>`
      select page_number, read_billed_run, read_text from document_page_states where document_id = 'd' order by page_number`;
    const [document] = await sql`select materialization_generation, source_materialization_blocked from documents where id = 'd'`;
    expect(document).toEqual({ materialization_generation: 1, source_materialization_blocked: true });
    expect(rows).toEqual([
      { page_number: 1, read_billed_run: "m1", read_text: null },
      { page_number: 2, read_billed_run: "m1", read_text: null },
    ]);
  });
  it("withdraws the document's summary tree with the corrected chunks and queues strict removal of its rows", async () => {
    // d2 has a ready tree built from the text the correction replaces; d3 has none yet (its build has not started).
    for (const id of ["d2", "d3"]) {
      await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
        values (${id}, 'o', 'u', 'w', 'r', ${`${id}.pdf`}, 'application/pdf', ${`k-${id}`}, 'completed', 1)`;
      await sql`insert into document_corrections (id, document_id, run_id, user_id, corrected_markdown)
        values (${`c-${id}`}, ${id}, 'r', 'u', 'Corrected text.')`;
    }
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, node_count, root_node_id, built_at, build_owner)
      values ('d2', 'o', 'w', 'r', 'ready', 'model/x', 4, 1, 'd2:L1:0-3', now(), null)`;
    await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, run_id, node_hash, level, status, chunk_start, chunk_end)
      values ('d2:L1:0-3', 'd2', 'o', 'w', 'r', 'h', 1, 'ready', 0, 3)`;
    await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
      values ('root-d2', 'd2', 'r', 'u', 'Root from withdrawn text')`;
    // A correction that is saved but not reindexed changes no chunk and withdraws nothing.
    expect(await sql`select status from document_summary_trees where document_id = 'd2'`).toEqual([{ status: "ready" }]);

    await reindexDocumentCorrection({ docId: "d2", userId: "u" });
    await reindexDocumentCorrection({ docId: "d3", userId: "u" });

    expect(await sql`select 1 from document_summaries where document_id = 'd2'`).toHaveLength(0);
    const trees = await sql`select document_id, status, skip_reason, built_at, root_node_id, node_count, embedding_model, dimension
      from document_summary_trees where document_id in ('d2', 'd3') order by document_id`;
    expect(trees).toEqual([
      // The embedding space stays on the row: it is where the queued removal looks for the rows.
      { document_id: "d2", status: "skipped", skip_reason: "corrected", built_at: null, root_node_id: null, node_count: 0, embedding_model: "model/x", dimension: 4 },
      { document_id: "d3", status: "skipped", skip_reason: "corrected", built_at: null, root_node_id: null, node_count: 0, embedding_model: null, dimension: null },
    ]);
    expect(await sql`select 1 from document_summary_tree_nodes where document_id = 'd2'`).toHaveLength(0);
    const queued = await sql`select kind, org_id, target, payload, reason, attempts, not_before <= now() as due
      from storage_cleanup_queue where kind = 'summary_tree_document' and target in ('o|w|d2', 'o|w|d3') order by target`;
    expect(queued).toEqual([
      { kind: "summary_tree_document", org_id: "o", target: "o|w|d2", payload: { projectId: "w", documentId: "d2", generation: 0 }, reason: "document_corrected", attempts: 0, due: true },
      { kind: "summary_tree_document", org_id: "o", target: "o|w|d3", payload: { projectId: "w", documentId: "d3", generation: 0 }, reason: "document_corrected", attempts: 0, due: true },
    ]);
    // A second reindex makes a removal that had been failing due again.
    await sql`update storage_cleanup_queue set attempts = 10, last_error = 'x' where target = 'o|w|d2'`;
    await reindexDocumentCorrection({ docId: "d2", userId: "u" });
    expect(await sql`select attempts, last_error from storage_cleanup_queue where target = 'o|w|d2'`).toEqual([{ attempts: 0, last_error: null }]);
  });

  it("refuses cross-user corrections and rolls back geo edits without spatial capability", async () => {
    const { saveDocumentCorrection } = await import("../services/document-review.js");
    await sql`insert into "user" (id,name,email) values('outsider','Other','other@example.com')`;
    expect(await saveDocumentCorrection({docId:"d",userId:"outsider",structuredData:{site:{type:"Point",coordinates:[0,0]}}})).toBeNull();
    await sql`update projects set pipeline=${sql.json({outputSchema:{type:"object",properties:{site:{type:"object",format:"geojson"}}}})}::jsonb where id='w'`;
    const [before] = await sql`select projection_revision from documents where id='d'`;
    await expect(saveDocumentCorrection({docId:"d",userId:"u",structuredData:{site:{type:"Point",coordinates:[0,0]}}})).rejects.toThrow("spatial migrations");
    const [after] = await sql`select projection_revision from documents where id='d'`;
    expect(after).toEqual(before);
    const [correction] = await sql`select corrected_structured_data from document_corrections where document_id='d'`;
    expect(correction.corrected_structured_data).toBeNull();
  });


  it("#512: a correction save replaces its tags in the save's transaction; a failed audit insert rolls back both", async () => {
    const { saveDocumentCorrection } = await import("../services/document-review.js");
    await sql`delete from document_tags where document_id = 'd'`;
    await sql`insert into document_tags (document_id, user_id, tag) values ('d', 'u', 'old')`;
    const [{ corrected_markdown: before }] = await sql`select corrected_markdown from document_corrections where document_id = 'd'`;
    const marker = `correction-${Math.random()}`;
    await expect(saveDocumentCorrection({ docId: "d", userId: "u", markdown: "Never saved.", tags: ["new"],
      audit: () => ({ userId: "u", action: null as unknown as string, resourceType: "document", metadata: { marker } }) })).rejects.toBeTruthy();
    expect(await sql`select tag from document_tags where document_id = 'd' order by tag`).toEqual([{ tag: "old" }]);
    expect(await sql`select corrected_markdown from document_corrections where document_id = 'd'`).toEqual([{ corrected_markdown: before }]);
    expect(await sql`select id from audit_log where metadata ->> 'marker' = ${marker}`).toEqual([]);
    // A record that can be written commits with the correction and its tags, scoped to the document.
    await saveDocumentCorrection({ docId: "d", userId: "u", markdown: before, tags: ["new"],
      audit: () => ({ userId: "u", action: "document.correction.saved", resourceType: "document", resourceId: "d", metadata: { marker } }) });
    expect(await sql`select tag from document_tags where document_id = 'd' order by tag`).toEqual([{ tag: "new" }]);
    // Scope comes from the document row locked in the save's transaction, its run included.
    expect(await sql`select org_id, project_id, document_id, run_id from audit_log where metadata ->> 'marker' = ${marker}`)
      .toEqual([{ org_id: "o", project_id: "w", document_id: "d", run_id: "r" }]);
  });
});
