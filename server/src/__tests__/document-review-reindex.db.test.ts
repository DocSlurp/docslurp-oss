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
  vi.doMock("../services/documents.js", () => ({ getDocumentViewerPayload: vi.fn(async () => null) }));
  vi.doMock("../search/eligibility-hint.js", () => ({ notifySearchEligibilityChanged: vi.fn(async () => {}) }));
  ({ reindexDocumentCorrection } = await import("../services/document-review.js"));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values ('r', 'o', 'u', 'w', 'upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
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
    await saveDocumentCorrection({ docId: "d", userId: "u", notes: "Only notes changed" });
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
  it("refuses cross-user corrections and rolls back geo edits without spatial capability", async () => {
    const { saveDocumentCorrection } = await import("../services/document-review.js");
    await sql`insert into "user" (id,name,email) values('outsider','Other','other@example.com')`;
    expect(await saveDocumentCorrection({docId:"d",userId:"outsider",structuredData:{site:{type:"Point",coordinates:[0,0]}}})).toBeNull();
    await sql`update workspaces set pipeline=${sql.json({outputSchema:{type:"object",properties:{site:{type:"object",format:"geojson"}}}})}::jsonb where id='w'`;
    const [before] = await sql`select projection_revision from documents where id='d'`;
    await expect(saveDocumentCorrection({docId:"d",userId:"u",structuredData:{site:{type:"Point",coordinates:[0,0]}}})).rejects.toThrow("spatial migrations");
    const [after] = await sql`select projection_revision from documents where id='d'`;
    expect(after).toEqual(before);
    const [correction] = await sql`select corrected_structured_data from document_corrections where document_id='d'`;
    expect(correction.corrected_structured_data).toBeNull();
  });

});
