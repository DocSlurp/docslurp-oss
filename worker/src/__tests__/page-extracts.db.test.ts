import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractionPageRecords,
  finalizePageExtracts,
  materializedPageRecords,
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
 * Page extract records (migration 0188, pipeline/page-extracts.ts) over a migrated database: a mixed PDF (text pages,
 * scanned pages read by OCR, one page escalated to a second read, one page read by vision) yields exactly one final record
 * per page once its document completes; retries are idempotent and a withdrawn pass restores the one before it; a failed
 * reprocess, an older run and a shorter reprocess never leave two finals or a stale one; rows stay in their organization.
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
  await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, created_at) values
    (100, 'run-a', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract-markdown', '{}', now() - interval '3 hours'),
    (100, 'run-a2', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract-markdown', '{}', now() - interval '2 hours'),
    (100, 'run-m', 'org-a', 'ua', 'proj-a', 'materialize', 'processing', 'materialize', '{}', now() - interval '1 hour'),
    (100, 'run-m2', 'org-a', 'ua', 'proj-a', 'materialize', 'processing', 'materialize', '{}', now() - interval '30 minutes'),
    (100, 'run-big', 'org-a', 'ua', 'proj-a', 'upload', 'processing', 'extract-markdown', '{}', now()),
    (100, 'run-b', 'org-b', 'ub', 'proj-b', 'upload', 'processing', 'extract-markdown', '{}', now())`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
    ('doc-a', 'org-a', 'ua', 'proj-a', 'run-a', 'a.pdf', 'application/pdf', 'ka', 'processing', 5),
    ('doc-big', 'org-a', 'ua', 'proj-a', 'run-big', 'big.pdf', 'application/pdf', 'kbig', 'processing', 20000),
    ('doc-b', 'org-b', 'ub', 'proj-b', 'run-b', 'b.pdf', 'application/pdf', 'kb', 'processing', 5)`;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

function state(runId: string, orgId: string | null, projectId: string): PageExtractState {
  return { run: { id: runId, orgId, projectId }, usageLedger: { modelClass: { quality: "auto", visionProfile: "good-fast-hosted" } },
    pendingPageExtracts: [], pendingPageExtractTags: [] };
}

/** What a checkpoint does: write the queued rows in one transaction, then drop what it wrote. */
async function flush(s: PageExtractState): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of pageExtractStatements(tx as unknown as typeof sql, s.pendingPageExtracts, s.pendingPageExtractTags)) await statement;
  });
  s.pendingPageExtracts = [];
  s.pendingPageExtractTags = [];
}

async function finalize(runId: string, documentId: string, pages?: number[]): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of finalizePageExtracts(tx as unknown as typeof sql, { orgId: "org-a", runId, documentIds: [documentId], ...(pages ? { pages } : {}) })) await statement;
  });
}

type Row = { page_number: number; run_id: string; pass: string; method: string; engine: string | null; billed_class: string | null;
  tags: string[]; confidence: number | null; adopted: boolean; is_final: boolean; superseded_by_pass: string | null; org_id: string;
  model_uri: string | null; model_class: string | null };

async function rows(documentId: string): Promise<Row[]> {
  return await sql<Row[]>`
    select page_number, run_id, pass, method, engine, billed_class, tags, confidence, adopted, is_final, superseded_by_pass, org_id,
      model_uri, model_class
    from document_page_extracts where document_id = ${documentId} order by page_number, run_id, pass`;
}

/** Final rows by page: [page, run, pass, method]. Fails when any page has more than one. */
async function finals(documentId: string): Promise<Array<[number, string, string, string]>> {
  const all = await rows(documentId);
  const byPage = new Map<number, Row[]>();
  for (const row of all.filter((r) => r.is_final)) byPage.set(row.page_number, [...(byPage.get(row.page_number) ?? []), row]);
  for (const [page, list] of byPage) expect(list.length, `page ${page} has ${list.length} finals`).toBe(1);
  return [...byPage.values()].map(([row]) => [row!.page_number, row!.run_id, row!.pass, row!.method]);
}

const DOC_A = { id: "doc-a" };
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
    ocrFailedPages: new Set(), critiquePages: [], ocrPageClass: true, plausibility: 0.82, extractMs: 2_500, readsPages: true,
  }));
}

function vision(s: PageExtractState, accepted: boolean): void {
  recordPageExtracts(s, DOC_A, visionPageRecords({
    outputs: [{ pageNumber: 2, runtime: "openai-compatible", text: "| Q1 | Q2 |", latencyMs: 900, finishReason: "stop",
      model: "z-ai/glm-5.3-flash", provider: "openrouter" }],
    skips: [{ pageNumber: 5, outcome: "ladder-capped" }],
    reconciliation: { changedPages: accepted ? [2] : [], decisions: [{ pageNumber: 2, outcome: accepted ? "accepted" : "rejected" }] },
    ocrPageClass: true,
  }));
}

describe("page extract records: what read the page", () => {
  it("names the same provider and model as the read's usage row, an OCR read by its reader, and nothing it does not know", () => {
    const records = visionPageRecords({
      outputs: [
        { pageNumber: 1, runtime: "openai-compatible", provider: "private", model: "gpu1/acme-vision", text: "a", latencyMs: 1 },
        { pageNumber: 2, runtime: "openai-compatible", provider: "openrouter", model: "z-ai/glm-5.3-flash:nitro", text: "b", latencyMs: 1 },
        { pageNumber: 3, runtime: "page-reader", provider: "page-reader:gpu-a", model: "reader-v2", text: "c", latencyMs: 1 },
        { pageNumber: 4, runtime: "ocr-vm", model: "page-ocr", reader: "escalated:qwen/qwen3-vl-30b", text: "d", latencyMs: 1 },
        { pageNumber: 5, runtime: "ocr-vm", model: "page-ocr", reader: "latin", text: "e", latencyMs: 1 },
        // No reader label and no provider: unknown stays unset instead of a made-up model.
        { pageNumber: 6, runtime: "ocr-vm", model: "page-ocr", text: "f", latencyMs: 1 },
        { pageNumber: 7, runtime: "chart-export", model: "chart-export", text: "", latencyMs: 1 },
        { pageNumber: 8, runtime: "ocr-vm", model: "page-ocr", reader: "none", text: "", latencyMs: 1 },
        // An endpoint that reports an address as its model names nothing.
        { pageNumber: 9, runtime: "openai-compatible", provider: "openrouter", model: "http://10.0.0.5:8000/v1", text: "g", latencyMs: 1 },
      ],
      skips: [], reconciliation: { changedPages: [], decisions: [] }, ocrPageClass: true,
    });
    expect(records.map((record) => record.modelUri)).toEqual([
      "llm://private/gpu1/acme-vision", "llm://openrouter/z-ai/glm-5.3-flash:nitro", "llm://page-reader-gpu-a/reader-v2",
      "llm://ocr-escalation/qwen/qwen3-vl-30b", "llm://page-ocr/latin", null, null, null, null,
    ]);
  });
});

describe("page extract records", () => {
  it("a mixed PDF yields exactly one final record per page once the document completes", async () => {
    const s = state("run-a", "org-a", "proj-a");
    mixedPdf(s);
    await flush(s);
    tagPageExtracts(s, DOC_A, routingPageTags([
      { pageNumber: 2, route: "table-heavy", signals: [], ocrDecision: { authorized: false, signals: [] } },
      { pageNumber: 4, route: "formula-heavy", signals: [], ocrDecision: { authorized: false, signals: [] } },
    ], () => "other", "blank-page"));
    vision(s, true);
    await flush(s);
    // Nothing is final before the document completes.
    expect(await finals("doc-a")).toEqual([]);
    await finalize("run-a", "doc-a");

    expect(await finals("doc-a")).toEqual([
      [1, "run-a", "extract", "text-layer"],
      [2, "run-a", "vision", "vision"],
      [3, "run-a", "scan-ocr", "ocr"],
      [4, "run-a", "scan-ocr", "ocr-second-read"],
      [5, "run-a", "scan-ocr", "ocr"],
    ]);
    const all = await rows("doc-a");
    const find = (page: number, pass: string) => all.find((row) => row.page_number === page && row.pass === pass)!;
    expect(find(2, "extract")).toMatchObject({ is_final: false, superseded_by_pass: "vision", method: "text-layer", billed_class: "fast", tags: ["table"] });
    expect(find(2, "vision")).toMatchObject({ engine: "vision-model", billed_class: "rich" });
    expect(find(3, "extract")).toMatchObject({ method: "none", is_final: false, superseded_by_pass: "scan-ocr" });
    expect(find(3, "scan-ocr")).toMatchObject({ engine: "page-ocr", billed_class: "ocr", tags: ["scanned"] });
    expect(find(3, "scan-ocr").confidence).toBeCloseTo(0.93, 5);
    // The escalated page: a second read, Vision class. The engine stays a route word; the model is in model_uri only.
    expect(find(4, "scan-ocr")).toMatchObject({ engine: "ocr-escalation", billed_class: "rich", tags: ["math", "scanned"], model_uri: "llm://ocr-escalation/some-model" });
    // What read each page, as an llm:// URI, with the run's levels at the time; nothing for a text layer.
    expect(find(2, "vision")).toMatchObject({ model_uri: "llm://openrouter/z-ai/glm-5.3-flash", model_class: "quality=auto;visionProfile=good-fast-hosted" });
    expect(find(3, "scan-ocr")).toMatchObject({ model_uri: "llm://page-ocr/latin", model_class: "quality=auto;visionProfile=good-fast-hosted" });
    expect(find(1, "extract")).toMatchObject({ model_uri: null, model_class: null });
    expect(find(5, "vision")).toMatchObject({ model_uri: null, model_class: null });
    expect(find(5, "scan-ocr").tags).toEqual(["escalation-capped", "low-confidence", "scanned"]);
    // Vision did not read page 5: recorded, not adopted, never final; the OCR read stays the page's source.
    expect(find(5, "vision")).toMatchObject({ method: "none", adopted: false, is_final: false, superseded_by_pass: null, tags: ["ladder-capped"] });
    expect(all.every((row) => row.org_id === "org-a")).toBe(true);
    expect(JSON.stringify(all.map(({ model_uri: _modelUri, ...rest }) => rest))).not.toContain("some-model");
  });

  it("a retried stage and checkpoint rewrite the same rows (idempotent)", async () => {
    const before = await rows("doc-a");
    const s = state("run-a", "org-a", "proj-a");
    mixedPdf(s);
    vision(s, true);
    const queued = s.pendingPageExtracts.map((row) => ({ ...row, tags: [...row.tags] }));
    expect(queued).toHaveLength(10);
    await flush(s);
    // The same checkpoint written twice (a retried transaction), and the completion finalized twice, change nothing.
    s.pendingPageExtracts = queued;
    await flush(s);
    await finalize("run-a", "doc-a");
    await finalize("run-a", "doc-a");
    expect(await rows("doc-a")).toEqual(before);
  });

  it("a retry that withdraws a pass restores the pass before it", async () => {
    const s = state("run-a", "org-a", "proj-a");
    vision(s, false);
    await flush(s);
    // Withdrawn: page 2's vision row is no longer adopted, and stops being final at once.
    expect((await finals("doc-a")).find(([page]) => page === 2)).toBeUndefined();
    await finalize("run-a", "doc-a");
    expect((await finals("doc-a")).find(([page]) => page === 2)).toEqual([2, "run-a", "extract", "text-layer"]);
    vision(s, true);
    await flush(s);
    await finalize("run-a", "doc-a");
    expect((await finals("doc-a")).find(([page]) => page === 2)).toEqual([2, "run-a", "vision", "vision"]);
  });

  it("a failed reprocess keeps the previous finals; a shorter reprocess clears finals past its page count", async () => {
    const before = await finals("doc-a");
    const s = state("run-a2", "org-a", "proj-a");
    recordPageExtracts(s, DOC_A, [1, 2, 3].map((pageNumber) => ({ pageNumber, pass: "extract" as const, method: "text-layer" as const, engine: "vm-pdf" })));
    await flush(s);
    // run-a2 is not the document's current run (it failed before taking it over): its completion finalizes nothing.
    await finalize("run-a2", "doc-a");
    expect(await finals("doc-a")).toEqual(before);
    // The reprocess succeeds with 3 pages: only its pages are final, and pages 4-5 have none.
    await sql`update documents set run_id = 'run-a2', page_count = 3 where id = 'doc-a'`;
    await finalize("run-a2", "doc-a");
    expect(await finals("doc-a")).toEqual([
      [1, "run-a2", "extract", "text-layer"], [2, "run-a2", "extract", "text-layer"], [3, "run-a2", "extract", "text-layer"],
    ]);
    expect((await rows("doc-a")).find((row) => row.run_id === "run-a" && row.page_number === 2 && row.pass === "vision"))
      .toMatchObject({ is_final: false, superseded_by_pass: "extract" });
  });

  it("an older run's late completion never overrides a newer run's finals; a query-time read finalizes its pages", async () => {
    const before = await finals("doc-a");
    // run-a (older) finalizing again, as a late retry would (even with the document pointing back at it).
    await sql`update documents set run_id = 'run-a', page_count = 5 where id = 'doc-a'`;
    await finalize("run-a", "doc-a");
    const after = await finals("doc-a");
    expect(after.filter(([page]) => page <= 3)).toEqual(before);
    await sql`update documents set run_id = 'run-a2', page_count = 3 where id = 'doc-a'`;
    // A newer materialization reads page 2 with a model and keeps page 3 as an image.
    const m = state("run-m", "org-a", "proj-a");
    recordPageExtracts(m, DOC_A, materializedPageRecords({
      published: [2], modelRead: () => true, blocked: [], failed: [[3, "kept-as-image"]], keptAsImageReason: "kept-as-image",
    }));
    await flush(m);
    await finalize("run-m", "doc-a", [2, 3]);
    const now = await finals("doc-a");
    expect(now.filter(([page]) => page <= 3)).toEqual([
      [1, "run-a2", "extract", "text-layer"], [2, "run-m", "vision", "vision"], [3, "run-m", "extract", "kept-as-image"],
    ]);
    // And run-a2 completing again later does not take those pages back.
    await finalize("run-a2", "doc-a");
    expect((await finals("doc-a")).filter(([page]) => page <= 3)).toEqual(now.filter(([page]) => page <= 3));
  });

  it("a query-time read that failed keeps the older final; one that found PII clears it", async () => {
    const before = await finals("doc-a");
    expect(before.find(([page]) => page === 1)).toEqual([1, "run-a2", "extract", "text-layer"]);
    const m2 = state("run-m2", "org-a", "proj-a");
    recordPageExtracts(m2, DOC_A, materializedPageRecords({
      published: [], modelRead: () => false, blocked: [3], failed: [[1, "embedding failed"]], keptAsImageReason: "kept-as-image",
    }));
    await flush(m2);
    await finalize("run-m2", "doc-a", [1, 3]);
    const after = await finals("doc-a");
    // Page 1: the newer read failed, so the older final stands.
    expect(after.find(([page]) => page === 1)).toEqual([1, "run-a2", "extract", "text-layer"]);
    // Page 3: the newer read found PII, so the page has no final any more.
    expect(after.find(([page]) => page === 3)).toBeUndefined();
    expect(after.find(([page]) => page === 2)).toEqual([2, "run-m", "vision", "vision"]);
  });

  it("records nothing for a run without an organization, and cannot name another organization's document", async () => {
    const unscoped = state("run-a", null, "proj-a");
    recordPageExtracts(unscoped, DOC_A, [{ pageNumber: 1, pass: "extract", method: "text-layer" }]);
    expect(unscoped.pendingPageExtracts).toEqual([]);
    // Org B's run naming org A's document: the composite foreign key refuses it.
    const crossed = state("run-b", "org-b", "proj-b");
    recordPageExtracts(crossed, DOC_A, [{ pageNumber: 1, pass: "extract", method: "text-layer" }]);
    await expect(flush(crossed)).rejects.toThrow(/foreign key/);
    // Org B's tag merge and finalization never touch org A's rows.
    const before = await rows("doc-a");
    const tagger = state("run-a", "org-b", "proj-a");
    tagPageExtracts(tagger, DOC_A, new Map([[1, ["drawn" as const]]]));
    await flush(tagger);
    await sql.begin(async (tx) => {
      for (const statement of finalizePageExtracts(tx as unknown as typeof sql, { orgId: "org-b", runId: "run-b", documentIds: ["doc-a"] })) await statement;
    });
    expect(await rows("doc-a")).toEqual(before);
  });

  it("refuses values outside the vocabularies", async () => {
    await expect(sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, tags)
      values ('doc-b', 'org-b', 'proj-b', 'run-b', 1, 'extract', 'text-layer', '{secret-text}')`).rejects.toThrow(/check/);
    await expect(sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, engine)
      values ('doc-b', 'org-b', 'proj-b', 'run-b', 1, 'extract', 'text-layer', 'Vendor/Model Name')`).rejects.toThrow(/check/);
  });

  it("queues, writes and finalizes a 20,000-page document quickly", async () => {
    const pageCount = 20_000;
    const finalPages = Array.from({ length: pageCount }, (_, i) => (i % 10 === 9 ? "" : `Page ${i + 1} text`));
    const scanFill = new Map<number, ScanFillPageRead>(
      Array.from({ length: pageCount / 10 }, (_, i) => [i * 10 + 10, { reader: "latin", confidence: 0.9, durationMs: 300 }] as const));
    const s = state("run-big", "org-a", "proj-a");
    const started = performance.now();
    recordPageExtracts(s, { id: "doc-big" }, extractionPageRecords({
      pageCount, finalPages, extractor: "vm-pdf", imageOcr: false, winnerOcrPages: [], scanFill, ocrFailedPages: new Set(),
      critiquePages: [], ocrPageClass: true, plausibility: 0.9, extractMs: 60_000, readsPages: true,
    }));
    tagPageExtracts(s, { id: "doc-big" }, new Map(Array.from({ length: pageCount }, (_, i) => [i + 1, ["table" as const]])));
    const statements = pageExtractStatements(sql, s.pendingPageExtracts, s.pendingPageExtractTags);
    const cpuMs = performance.now() - started;
    console.log(`[page-extracts bench] pages=${pageCount} rows=${s.pendingPageExtracts.length} statements=${statements.length} queueAndBuildMs=${cpuMs.toFixed(1)}`);
    expect(cpuMs).toBeLessThan(1_000);
    expect(statements.length).toBe(Math.ceil(s.pendingPageExtracts.length / 2_000) + Math.ceil(pageCount / 2_000));
    const writeStarted = performance.now();
    await flush(s);
    const writeMs = performance.now() - writeStarted;
    const finalizeStarted = performance.now();
    await finalize("run-big", "doc-big");
    const finalizeMs = performance.now() - finalizeStarted;
    console.log(`[page-extracts bench] writeMs=${writeMs.toFixed(0)} finalizeMs=${finalizeMs.toFixed(0)} (PGlite)`);
    const [counts] = await sql<{ finals: number; pages: number }[]>`
      select count(*) filter (where is_final)::int as finals, count(distinct page_number)::int as pages
      from document_page_extracts where document_id = 'doc-big'`;
    expect(counts).toEqual({ finals: pageCount, pages: pageCount });
  }, 120_000);
});

describe("extraction page records (pure)", () => {
  it("adopts critique corrections and OCR-winner pages; Fast keeps pages without words as images", () => {
    const records = extractionPageRecords({
      pageCount: 3, finalPages: ["a", "b", ""], extractor: "ocr", imageOcr: false, winnerOcrPages: [2], scanFill: null,
      ocrFailedPages: new Set([3]), critiquePages: [1], ocrPageClass: false, plausibility: null, extractMs: null,
    });
    expect(records.map((record) => [record.pageNumber, record.pass, record.method])).toEqual([
      [1, "extract", "text-layer"], [1, "critique", "correction"], [2, "extract", "ocr"], [3, "extract", "none"],
    ]);
    expect(records.find((record) => record.pageNumber === 2)!.billedClass).toBe("rich");
    expect(records.find((record) => record.pageNumber === 3)!.tags).toEqual(["scanned", "failed"]);
    const fast = extractionPageRecords({
      pageCount: 2, finalPages: ["words", "  "], extractor: "vm-pdf", imageOcr: false, winnerOcrPages: [], scanFill: null,
      ocrFailedPages: new Set(), critiquePages: [], ocrPageClass: false, plausibility: null, extractMs: null, readsPages: false,
    });
    expect(fast.map((record) => [record.pageNumber, record.method, record.tags])).toEqual([[1, "text-layer", []], [2, "kept-as-image", ["image-only"]]]);
  });
});
