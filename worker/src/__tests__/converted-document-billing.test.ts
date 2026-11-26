import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { measureExtractedPages, recordMeasuredPageCount } from "../lib/office-page-count.js";
import { PageBasis } from "../pipeline/page-basis.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { ProjectRun } from "../models.js";
import { loadFixtureDocument } from "../test/load-document.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/*
 * DocSlurp/app issue 601: Word, slide, sheet and EPUB files arrive counted as one assumed page. The worker measures them from
 * the extractor's output into documents.billing_pages, and the completion charge bills that one stored number: N pages, once,
 * however often the measurement or the charge is retried. A content-deduplicated copy reuses its original's conversion and
 * bills the original's measured pages like the original did (the reuse is the platform's saving, not a discount).
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  epub: "application/epub+zip",
} as const;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

/** Extractor output for each format, as the worker's extractors write it. */
const prose = (pages: number) =>
  Array.from({ length: pages * 5 }, (_, index) => `Paragraph ${index}: ${"the supplier shall deliver the goods. ".repeat(18)}`.trim()).join("\n\n");
const deck = (slides: number) => Array.from({ length: slides }, (_, index) => `## Slide ${index + 1}\n\n- Launch in London`).join("\n\f\n");
/** The header row is a line of cell text too: 719 rows and the header are 720 lines, 12 pages of 60. */
const sheet = (rows: number) => `## Orders\n\n| id | status |\n| --- | --- |\n${Array.from({ length: rows }, (_, index) => `| ${index + 1} | live |`).join("\n")}\n`;

const FORMATS = [
  { key: "docx", format: "office-word", extractor: "pandoc", markdown: prose(300), pages: 300, method: "text-rule" },
  { key: "pptx", format: "office-pptx", extractor: "pptx", markdown: deck(48), pages: 48, method: "slides" },
  { key: "xlsx", format: "office-excel", extractor: "xlsx", markdown: sheet(719), pages: 12, method: "sheet-rows" },
  { key: "epub", format: "epub", extractor: "pandoc", markdown: prose(229), pages: 229, method: "text-rule" },
] as const;
const TOTAL = FORMATS.reduce((sum, entry) => sum + entry.pages, 0);

beforeAll(async () => {
  db = await createMigratedDatabase();
  const originals = FORMATS.map((entry) => `('orig-${entry.key}', 'o1', 'u1', 'w1', 'runA', 'deck.${entry.key}', '${MIME[entry.key]}', 'raw/${entry.key}', 'completed', 1, 'assumed', 'sha-${entry.key}')`).join(",\n");
  // Copies as intake seeds them (server run-creation findDedupCandidate): same org, intake's assumed one page, pointing at the
  // original (the vector owner). runC is billed with the flag off; runX's copies point at another organization's documents.
  const copies = (run: string, org: string, project: string, prefix: string) => FORMATS.map((entry) =>
    `('${prefix}-${entry.key}', '${org}', 'u1', '${project}', '${run}', 'deck.${entry.key}', '${MIME[entry.key]}', 'raw/${prefix}/${entry.key}', 'completed', 1, 'assumed', 'sha-${entry.key}', 'orig-${entry.key}')`).join(",\n");
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents)
      values ('o1', 'Org', 'org', 'u1', 8, 10000000), ('o2', 'Other', 'other', 'u1', 8, 10000000);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'X');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'runA', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '${pipeline}', 4, 4),
             (100, 'runB', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '${pipeline}', 4, 4),
             (100, 'runC', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '${pipeline}', 4, 4),
             (100, 'runX', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'embed', '${pipeline}', 4, 4);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, source_sha256)
      values ${originals};
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, source_sha256, deduped_from_document_id)
      values ${copies("runB", "o1", "w1", "copy")}, ${copies("runC", "o1", "w1", "flagoff")}, ${copies("runX", "o2", "w2", "foreign")};
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

afterEach(() => {
  delete process.env.DOCSLURP_BILL_DEDUP_COPIES;
});

const basis = (run: ProjectRun) => ({ pageBasis: new PageBasis({ run, usageLedger: { pendingBillableCents: 0 } }, store.pageBasisLedger) });
const sql = () => (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;

async function chargeRun(runId: string, prefix: string) {
  const run = await store.loadRun(runId);
  const documents = await Promise.all(FORMATS.map(async (entry) => (await loadFixtureDocument(store, `${prefix}-${entry.key}`))!));
  return await recordPageBaseFee(sql(), WorkflowState.create(run, documents));
}

async function fastCharges(runId: string) {
  const { rows } = await db.query<{ id: string; amount: string }>(
    `select id, amount::text from usage_events where run_id = $1 and metric = $2`, [runId, BILLABLE_UNIT_METRICS.fastPage]);
  return rows;
}

describe("each converted format measures its structure", () => {
  it.each(FORMATS)("$key counts $pages pages by $method", (entry) => {
    expect(measureExtractedPages(entry.format, entry.extractor, entry.markdown)).toEqual({ pages: entry.pages, method: entry.method });
  });
});

describe("a multi-page DOCX, PPTX, XLSX and EPUB bill their measured pages exactly once", () => {
  it("measured, re-measured on a retry, then charged twice: N pages in one charge", async () => {
    const run = await store.loadRun("runA");
    for (const attempt of [1, 2]) {
      for (const entry of FORMATS) {
        const document = (await loadFixtureDocument(store, `orig-${entry.key}`))!;
        const measured = await recordMeasuredPageCount(basis(run), document, entry.format, { extractor: entry.extractor, markdown: entry.markdown });
        expect(measured, `attempt ${attempt} ${entry.key}`).toMatchObject({ pages: entry.pages, method: entry.method });
      }
    }
    for (const entry of FORMATS) {
      // Intake's assumed page is left as the page basis; the measured count is the one stored billing number.
      expect(await loadFixtureDocument(store, `orig-${entry.key}`)).toMatchObject({ pageCount: 1, billingPages: entry.pages, billingPagesMethod: entry.method });
    }
    expect((await chargeRun("runA", "orig")).fastPages).toBe(TOTAL);
    // A retried completion charges nothing more: one Fast charge row for the run, for exactly N pages.
    await chargeRun("runA", "orig");
    expect(await fastCharges("runA")).toEqual([{ id: "fast:runA", amount: String(TOTAL) }]);
  }, 60_000);
});

describe("a content-deduplicated copy bills like its original", () => {
  it("a copy in a later run bills the original's measured pages, once", async () => {
    expect((await chargeRun("runB", "copy")).fastPages).toBe(TOTAL);
    await chargeRun("runB", "copy");
    expect(await fastCharges("runB")).toEqual([{ id: "fast:runB", amount: String(TOTAL) }]);
  }, 60_000);

  it("DOCSLURP_BILL_DEDUP_COPIES=0 restores the earlier rule: copies bill nothing", async () => {
    process.env.DOCSLURP_BILL_DEDUP_COPIES = "0";
    expect((await chargeRun("runC", "flagoff")).fastPages).toBe(0);
  }, 60_000);

  it("a copy never reads another organization's document: it bills nothing rather than the other org's count", async () => {
    // Intake never pairs documents across organizations; a row that did must not price one org's charge from another's data.
    expect((await chargeRun("runX", "foreign")).fastPages).toBe(0);
  }, 60_000);
});
