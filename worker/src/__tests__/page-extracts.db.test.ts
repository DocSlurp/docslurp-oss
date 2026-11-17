import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractionPageRecords,
  pageExtractStatements,
  recordPageExtracts,
  routingPageTags,
  tagPageExtracts,
  visionPageRecords,
  type PageExtractState,
  type ScanFillPageRead,
} from "../pipeline/page-extracts.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";

/**
 * Page extract records (migration 0187, pipeline/page-extracts.ts) over a migrated database: a mixed PDF (text pages,
 * scanned pages read by OCR, one page escalated to a second read, one page read by vision) yields one final record per
 * page; a retried write changes nothing; rows are scoped to the run's organization.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  await sql`insert into "user"(id, name, email) values ('ua', 'A', 'a@example.com'), ('ub', 'B', 'b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-a', 'A', 'a', 'ua'), ('org-b', 'B', 'b', 'ub')`;
  await sql`insert into projects(id, org_id, user_id, name) values ('proj-a', 'org-a', 'ua', 'A'), ('proj-b', 'org-b', 'ub', 'B')`;
  await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    (100, 'run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract-markdown', '{}'),
    (100, 'run-a2', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract-markdown', '{}'),
    (100, 'run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract-markdown', '{}')`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 5),
    ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 5)`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

function state(runId: string, orgId: string | null, projectId: string): PageExtractState {
  return { run: { id: runId, orgId, projectId }, pendingPageExtracts: [], pendingPageExtractTags: [] };
}

/** What a checkpoint does: write the queued rows in one transaction, then drop what it wrote. */
async function flush(s: PageExtractState): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of pageExtractStatements(tx as unknown as typeof sql, s.pendingPageExtracts, s.pendingPageExtractTags)) await statement;
  });
  s.pendingPageExtracts = [];
  s.pendingPageExtractTags = [];
}

async function rows(documentId: string) {
  return await sql<Array<{ page_number: number; run_id: string; pass: string; method: string; engine: string | null; billed_class: string | null;
    tags: string[]; confidence: number | null; is_final: boolean; superseded_by_pass: string | null; org_id: string; updated_at: string }>>`
    select page_number, run_id, pass, method, engine, billed_class, tags, confidence, is_final, superseded_by_pass, org_id, updated_at::text
    from document_page_extracts where document_id = ${documentId} order by page_number, pass, run_id`;
}

const DOC_A = { id: "doc-a", projectId: "proj-a" };
// Pages 1-2 text layer; 3-5 had no words: 3 read by OCR, 4 read by OCR then escalated, 5 read with low confidence and
// held at the escalation cap. Page 2 is then read by vision (accepted).
const FINAL_TEXT = ["Earnings beat estimates", "Revenue table | Q1 | Q2", "Scanned memo text", "Escalated text", "faint words"];
const SCAN_FILL = new Map<number, ScanFillPageRead>([
  [3, { reader: "latin", confidence: 0.93, durationMs: 400 }],
  [4, { reader: "escalated:some-model", confidence: null, durationMs: 1_200 }],
  [5, { reader: "latin", confidence: 0.41, durationMs: 380, escalationHeld: "capped" }],
]);

function mixedPdf(s: PageExtractState): void {
  recordPageExtracts(s, DOC_A, extractionPageRecords({
    pageCount: 5, finalPages: FINAL_TEXT, extractor: "vm-pdf", imageOcr: false, winnerOcrPages: [], scanFill: SCAN_FILL,
    ocrFailedPages: new Set(), critiquePages: [], ocrPageClass: true, plausibility: 0.82, extractMs: 2_500,
  }));
}

describe("page extract records", () => {
  it("a mixed PDF yields one final record per page, with the right methods, tags and supersession", async () => {
    const s = state("run-a", "org-a", "proj-a");
    mixedPdf(s);
    await flush(s);
    tagPageExtracts(s, DOC_A, routingPageTags([
      { pageNumber: 2, route: "table-heavy", signals: [], ocrDecision: { authorized: false, signals: [] } },
      { pageNumber: 4, route: "formula-heavy", signals: [], ocrDecision: { authorized: false, signals: [] } },
    ], () => "other", "blank-page"));
    recordPageExtracts(s, DOC_A, visionPageRecords({
      outputs: [{ pageNumber: 2, runtime: "openai-compatible", text: "| Q1 | Q2 |", latencyMs: 900, finishReason: "stop" }],
      skips: [{ pageNumber: 5, outcome: "ladder-capped" }],
      reconciliation: { changedPages: [2], decisions: [{ pageNumber: 2, outcome: "accepted" }] },
      ocrPageClass: true,
    }));
    await flush(s);

    const all = await rows("doc-a");
    const finals = all.filter((row) => row.is_final);
    expect(finals.map((row) => [row.page_number, row.pass, row.method])).toEqual([
      [1, "extract", "text-layer"],
      [2, "vision", "vision"],
      [3, "scan-ocr", "ocr"],
      [4, "scan-ocr", "ocr-second-read"],
      [5, "scan-ocr", "ocr"],
    ]);
    const find = (page: number, pass: string) => all.find((row) => row.page_number === page && row.pass === pass)!;
    expect(find(2, "extract")).toMatchObject({ is_final: false, superseded_by_pass: "vision", method: "text-layer", billed_class: "fast" });
    expect(find(2, "extract").tags).toEqual(["table"]);
    expect(find(2, "vision")).toMatchObject({ engine: "vision-model", billed_class: "rich" });
    expect(find(3, "extract")).toMatchObject({ method: "none", is_final: false, superseded_by_pass: "scan-ocr" });
    expect(find(3, "scan-ocr")).toMatchObject({ engine: "page-ocr", billed_class: "ocr", tags: ["scanned"] });
    expect(find(3, "scan-ocr").confidence).toBeCloseTo(0.93, 5);
    // The escalated page: a second read, Vision class; no model id is stored.
    expect(find(4, "scan-ocr")).toMatchObject({ engine: "ocr-escalation", billed_class: "rich" });
    expect(find(4, "scan-ocr").tags).toEqual(["math", "scanned"]);
    expect(find(5, "scan-ocr").tags).toEqual(["escalation-capped", "low-confidence", "scanned"]);
    // Vision did not read page 5: recorded, never final, the OCR read stays the page's source.
    expect(find(5, "vision")).toMatchObject({ method: "none", is_final: false, superseded_by_pass: null, tags: ["ladder-capped"] });
    expect(all.every((row) => row.org_id === "org-a")).toBe(true);
    expect(JSON.stringify(all)).not.toContain("some-model");
  });

  it("a retried stage and checkpoint rewrite the same rows (idempotent)", async () => {
    const before = await rows("doc-a");
    const s = state("run-a", "org-a", "proj-a");
    mixedPdf(s);
    recordPageExtracts(s, DOC_A, visionPageRecords({
      outputs: [{ pageNumber: 2, runtime: "openai-compatible", text: "| Q1 | Q2 |", latencyMs: 900, finishReason: "stop" }],
      skips: [{ pageNumber: 5, outcome: "ladder-capped" }],
      reconciliation: { changedPages: [2], decisions: [{ pageNumber: 2, outcome: "accepted" }] },
      ocrPageClass: true,
    }));
    const queued = s.pendingPageExtracts.map((row) => ({ ...row, tags: [...row.tags] }));
    expect(queued).toHaveLength(10);
    await flush(s);
    // The same checkpoint written twice (a retried transaction) changes nothing either.
    s.pendingPageExtracts = queued;
    await flush(s);
    const strip = (list: Awaited<ReturnType<typeof rows>>) => list.map(({ updated_at: _u, ...rest }) => rest);
    const after = await rows("doc-a");
    expect(strip(after)).toEqual(strip(before));
  });

  it("a later run's final record supersedes the earlier run's", async () => {
    const s = state("run-a2", "org-a", "proj-a");
    recordPageExtracts(s, DOC_A, [{ pageNumber: 1, pass: "extract", method: "text-layer", engine: "vm-pdf", textBytes: 10 }]);
    await flush(s);
    const page1 = (await rows("doc-a")).filter((row) => row.page_number === 1);
    expect(page1.filter((row) => row.is_final).map((row) => row.run_id)).toEqual(["run-a2"]);
    expect(page1.find((row) => row.run_id === "run-a")).toMatchObject({ is_final: false, superseded_by_pass: "extract" });
  });

  it("records nothing for a run without an organization, and cannot name another organization's document", async () => {
    const unscoped = state("run-a", null, "proj-a");
    recordPageExtracts(unscoped, DOC_A, [{ pageNumber: 1, pass: "extract", method: "text-layer" }]);
    expect(unscoped.pendingPageExtracts).toEqual([]);
    // Org B's run naming org A's document: the composite foreign key refuses it.
    const crossed = state("run-b", "org-b", "proj-b");
    recordPageExtracts(crossed, DOC_A, [{ pageNumber: 1, pass: "extract", method: "text-layer" }]);
    await expect(flush(crossed)).rejects.toThrow(/foreign key/);
    // And org B's tag merge never touches org A's rows.
    const before = await rows("doc-a");
    const tagger = state("run-a", "org-b", "proj-a");
    tagPageExtracts(tagger, DOC_A, new Map([[1, ["drawn" as const]]]));
    await flush(tagger);
    expect((await rows("doc-a")).map((row) => row.tags)).toEqual(before.map((row) => row.tags));
  });

  it("refuses values outside the vocabularies", async () => {
    await expect(sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, tags)
      values ('doc-b', 'org-b', 'proj-b', 'run-b', 1, 'extract', 'text-layer', '{secret-text}')`).rejects.toThrow(/check/);
    await expect(sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, engine)
      values ('doc-b', 'org-b', 'proj-b', 'run-b', 1, 'extract', 'text-layer', 'Vendor/Model Name')`).rejects.toThrow(/check/);
  });
});

describe("extraction page records (pure)", () => {
  it("marks critique corrections final and OCR-winner pages as ocr", () => {
    const records = extractionPageRecords({
      pageCount: 3, finalPages: ["a", "b", ""], extractor: "ocr", imageOcr: false, winnerOcrPages: [2], scanFill: null,
      ocrFailedPages: new Set([3]), critiquePages: [1], ocrPageClass: false, plausibility: null, extractMs: null,
    });
    const s = state("run-a", "org-a", "proj-a");
    recordPageExtracts(s, DOC_A, records);
    expect(s.pendingPageExtracts.filter((row) => row.is_final).map((row) => [row.page_number, row.pass, row.method])).toEqual([
      [1, "critique", "correction"], [2, "extract", "ocr"], [3, "extract", "none"],
    ]);
    expect(s.pendingPageExtracts.find((row) => row.page_number === 1 && row.pass === "extract")!.superseded_by_pass).toBe("critique");
    expect(records.filter((record) => record.pass !== "extract").map((record) => [record.pageNumber, record.pass, record.method])).toEqual([
      [1, "critique", "correction"],
    ]);
    expect(records.find((record) => record.pageNumber === 2)!.billedClass).toBe("rich");
    expect(records.find((record) => record.pageNumber === 3)!.tags).toEqual(["scanned", "failed"]);
  });
});
