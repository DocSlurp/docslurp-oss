import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, dedupCopiesBill, defaultPipelineFeatures, PAGE_READ_METRICS, pageCredits } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee, splitCopyPages } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { isDedupCopy, UnfundedPagesError } from "../pipeline/page-basis.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { loadFixtureDocument } from "../test/load-document.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

process.env.RUN_CREDIT_OVERDRAFT_CREDITS = "0";

/*
 * Content-deduplicated copies (DocSlurp/app issue 601, council round 1). Intake records a copy's billing facts on its own row
 * (billing_pages, page_count_source, copy_ocr_pages, copy_rich_pages, copy_media_pages; migration 20261126T0240), so:
 * the completion charge bills a copy from its own row at its original's classes, once per run; deleting the original
 * changes nothing; only completed copies bill; and copies are spend-checked before any stage like originals' measured pages.
 * Every test seeds its own organization, run and documents (scenario), so none depends on another's state.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');`);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 2, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

afterEach(() => {
  delete process.env.DOCSLURP_BILL_DEDUP_COPIES;
  setSpendCheckConfig(null);
});

type Doc = {
  id: string; mime?: string; status?: string; pageCount?: number; source?: "assumed" | "counted"; intake?: number;
  billingPages?: number | null; method?: string | null; dedupedFrom?: string | null;
  copyOcr?: number | null; copyRich?: number | null; copyMedia?: number | null; sha?: string; run?: string; org?: string;
};

let counter = 0;
/** A fresh organization (balance in credits), project and two runs (`orig` completed, `run` processing), unique ids. */
async function scenario(balanceCredits = 100_000) {
  const p = `s${++counter}`;
  const ids = { org: `${p}-org`, project: `${p}-w`, orig: `${p}-orig`, run: `${p}-run` };
  await db.exec(`
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('${ids.org}', '${p}', '${p}', 'u1', 8, ${balanceCredits});
    insert into projects(id, org_id, user_id, name) values ('${ids.project}', '${ids.org}', 'u1', '${p}');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, '${ids.orig}', '${ids.org}', 'u1', '${ids.project}', 'bulk-upload', 'completed', 'completed', '${pipeline}', 1, 1),
             (100, '${ids.run}', '${ids.org}', 'u1', '${ids.project}', 'bulk-upload', 'processing', 'embed', '${pipeline}', 1, 1);
  `);
  const insert = async (doc: Doc) => {
    await db.query(`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count,
        page_count_source, intake_page_count, billing_pages, billing_pages_method, source_sha256, deduped_from_document_id,
        copy_ocr_pages, copy_rich_pages, copy_media_pages)
      values ($1, $2, 'u1', $3, $4, $1, $5, 'raw/' || $1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, [
      doc.id, doc.org ?? ids.org, ids.project, doc.run ?? ids.run, doc.mime ?? DOCX, doc.status ?? "processing", doc.pageCount ?? 1,
      doc.source ?? "assumed", doc.intake ?? doc.pageCount ?? 1, doc.billingPages ?? null, doc.method ?? null, doc.sha ?? `${p}-sha`,
      doc.dedupedFrom ?? null, doc.copyOcr ?? null, doc.copyRich ?? null, doc.copyMedia ?? null,
    ]);
    return doc.id;
  };
  return { p, ids, insert };
}

async function charge(runId: string) {
  const { rows } = await db.query<{ id: string }>(`select id from documents where run_id = $1 order by id`, [runId]);
  const run = await store.loadRun(runId);
  const documents = await Promise.all(rows.map(async (row) => (await loadFixtureDocument(store, row.id))!));
  return await recordPageBaseFee((store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql, WorkflowState.create(run, documents));
}

async function events(runId: string) {
  const { rows } = await db.query<{ id: string; metric: string; amount: string }>(
    `select id, metric, amount::text from usage_events where run_id = $1 order by id`, [runId]);
  return rows.map((row) => ({ id: row.id, metric: row.metric, amount: Number(row.amount) }));
}

/** A hydrated activity's state for every document of `runId`: its page basis is bound to the store's Postgres adapter. */
async function activity(runId: string): Promise<WorkflowState> {
  const { rows } = await db.query<{ id: string }>(`select id from documents where run_id = $1 order by id`, [runId]);
  const state = WorkflowState.create(await store.loadRun(runId), await Promise.all(rows.map(async (row) => (await loadFixtureDocument(store, row.id))!)));
  await store.hydrateState(state);
  state.executionGeneration = state.run.executionGeneration;
  return state;
}

describe("DOCSLURP_BILL_DEDUP_COPIES parsing", () => {
  it("unset, empty and the on words bill; the off words do not; anything else bills and is logged once", () => {
    for (const value of [undefined, "", "1", "true", "ON", " yes "]) expect(dedupCopiesBill({ DOCSLURP_BILL_DEDUP_COPIES: value }), String(value)).toBe(true);
    for (const value of ["0", "false", "OFF", " no "]) expect(dedupCopiesBill({ DOCSLURP_BILL_DEDUP_COPIES: value }), value).toBe(false);
    const errors = vi.mocked(console.error);
    errors.mockClear();
    expect(dedupCopiesBill({ DOCSLURP_BILL_DEDUP_COPIES: "disabled" })).toBe(true);
    expect(dedupCopiesBill({ DOCSLURP_BILL_DEDUP_COPIES: "disabled" })).toBe(true);
    expect(errors.mock.calls.filter(([line]) => String(line).includes("DOCSLURP_BILL_DEDUP_COPIES")).length).toBe(1);
  });
});

describe("splitCopyPages", () => {
  it("bills Rich then OCR from the recorded classes, never more than the pages, the rest Fast", () => {
    expect(splitCopyPages({ pages: 10, ocr: 3, rich: 2 })).toEqual({ fast: 5, ocr: 3, rich: 2 });
    expect(splitCopyPages({ pages: 4, ocr: 3, rich: 3 })).toEqual({ fast: 0, ocr: 1, rich: 3 });
    expect(splitCopyPages({ pages: 0, ocr: 5, rich: 5 })).toEqual({ fast: 0, ocr: 0, rich: 0 });
    expect(splitCopyPages({ pages: Number.NaN, ocr: -1, rich: Number.POSITIVE_INFINITY })).toEqual({ fast: 0, ocr: 0, rich: 0 });
  });
});

describe("a copy bills from its own recorded facts", () => {
  it("an Office copy bills its recorded pages Fast once, however often the charge runs or races", async () => {
    const s = await scenario();
    const orig = await s.insert({ id: `${s.p}-o`, run: s.ids.orig, status: "completed", billingPages: 300, method: "text-rule" });
    await s.insert({ id: `${s.p}-c`, dedupedFrom: orig, billingPages: 300, method: "text-rule", copyOcr: 0, copyRich: 0 });
    const outcomes = await Promise.all([charge(s.ids.run), charge(s.ids.run)]);
    expect(outcomes.map((o) => o.fastPages)).toEqual([300, 300]);
    await charge(s.ids.run);
    expect(await events(s.ids.run)).toEqual([
      { id: `copy-fast:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.fastPage, amount: 300 },
      { id: `fast:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.fastPage, amount: 0 },
    ]);
  }, 60_000);

  it("deleting the original leaves the copy's bill unchanged (the pointer is cleared, the facts stay)", async () => {
    const s = await scenario();
    const orig = await s.insert({ id: `${s.p}-o`, run: s.ids.orig, status: "completed", billingPages: 120, method: "text-rule" });
    await s.insert({ id: `${s.p}-c`, dedupedFrom: orig, billingPages: 120, method: "text-rule", copyOcr: 0, copyRich: 0 });
    await db.query(`delete from documents where id = $1`, [orig]);
    expect((await db.query<{ p: string | null }>(`select deduped_from_document_id as p from documents where id = $1`, [`${s.p}-c`])).rows[0]?.p).toBeNull();
    expect((await charge(s.ids.run)).fastPages).toBe(120);
    // Not billed twice as an "original" either: one copy charge, a zero original charge.
    expect((await events(s.ids.run)).map((e) => [e.id.split(":")[0], e.amount])).toEqual([["copy-fast", 120], ["fast", 0]]);
  }, 60_000);

  it("a copy of a scanned PDF bills its original's OCR and Rich pages at those classes, the rest Fast", async () => {
    const s = await scenario();
    await s.insert({ id: `${s.p}-c`, mime: "application/pdf", pageCount: 10, source: "counted", intake: 4, copyOcr: 6, copyRich: 3, dedupedFrom: null });
    const charged = await charge(s.ids.run);
    expect(charged).toMatchObject({ fastPages: 1, ocrPages: 6, richPages: 3, copies: { documents: 1, fastPages: 1, ocrPages: 6, richPages: 3, mediaPages: 0 } });
    expect(await events(s.ids.run)).toEqual([
      { id: `copy-fast:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.fastPage, amount: 1 },
      { id: `copy-ocr:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.ocrPage, amount: 6 },
      { id: `copy-rich:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.richPage, amount: 3 },
      { id: `fast:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.fastPage, amount: 0 },
    ]);
    expect(charged.credits).toBeCloseTo(pageCredits("fast", 1) + pageCredits("ocr", 6) + pageCredits("rich", 3), 6);
  }, 60_000);

  it("an image copy and an audio copy bill their recorded classes and media pages", async () => {
    const s = await scenario();
    await s.insert({ id: `${s.p}-img`, mime: "image/png", pageCount: 1, source: "counted", copyOcr: 1, copyRich: 0 });
    await s.insert({ id: `${s.p}-aud`, mime: "audio/mpeg", pageCount: 1, copyOcr: 0, copyRich: 0, copyMedia: 7 });
    expect((await charge(s.ids.run)).copies).toEqual({ documents: 2, fastPages: 0, ocrPages: 1, richPages: 0, mediaPages: 7 });
    expect((await events(s.ids.run)).filter((e) => e.id.startsWith("copy-"))).toEqual([
      { id: `copy-fast:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.fastPage, amount: 0 },
      { id: `copy-media:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.mediaMinutes, amount: 7 },
      { id: `copy-ocr:${s.ids.run}`, metric: BILLABLE_UNIT_METRICS.ocrPage, amount: 1 },
    ]);
  }, 60_000);

  it("only a copy that completes bills: failed, cancelled, PII-blocked and failed-stage copies bill nothing", async () => {
    const s = await scenario();
    for (const status of ["failed", "cancelled", "pii_blocked"]) {
      await s.insert({ id: `${s.p}-${status}`, status, billingPages: 50, method: "text-rule", copyOcr: 0, copyRich: 0 });
    }
    await s.insert({ id: `${s.p}-stage`, billingPages: 50, method: "text-rule", copyOcr: 0, copyRich: 0 });
    await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status) values ($1, $2, 'quarantine', 'failed')`, [s.ids.run, `${s.p}-stage`]);
    await s.insert({ id: `${s.p}-ok`, billingPages: 5, method: "text-rule", copyOcr: 0, copyRich: 0 });
    expect((await charge(s.ids.run)).copies).toEqual({ documents: 1, fastPages: 5, ocrPages: 0, richPages: 0, mediaPages: 0 });
  }, 60_000);

  it("the flag on bills a copy; the same copy in a run charged with the flag off bills nothing", async () => {
    const on = await scenario();
    await on.insert({ id: `${on.p}-c`, billingPages: 40, method: "text-rule", copyOcr: 0, copyRich: 0 });
    expect((await charge(on.ids.run)).fastPages).toBe(40);
    const off = await scenario();
    await off.insert({ id: `${off.p}-c`, billingPages: 40, method: "text-rule", copyOcr: 0, copyRich: 0 });
    process.env.DOCSLURP_BILL_DEDUP_COPIES = "0";
    const charged = await charge(off.ids.run);
    expect(charged.fastPages).toBe(0);
    expect(charged.copies).toBeUndefined();
    expect((await events(off.ids.run)).map((e) => e.id)).toEqual([`fast:${off.ids.run}`]);
  }, 60_000);
});

describe("copies made before copies recorded their facts", () => {
  it("bill their original's measured count Fast through the pointer", async () => {
    const s = await scenario();
    const orig = await s.insert({ id: `${s.p}-o`, run: s.ids.orig, status: "completed", billingPages: 33, method: "slides" });
    await s.insert({ id: `${s.p}-c`, dedupedFrom: orig });
    expect((await charge(s.ids.run)).copies).toEqual({ documents: 1, fastPages: 33, ocrPages: 0, richPages: 0, mediaPages: 0 });
  }, 60_000);

  it("an orphan (original deleted) or an original never measured bills nothing and never fails the run's charge", async () => {
    const s = await scenario();
    const unmeasured = await s.insert({ id: `${s.p}-u`, run: s.ids.orig, status: "completed" });
    await s.insert({ id: `${s.p}-c1`, dedupedFrom: unmeasured });
    const gone = await s.insert({ id: `${s.p}-g`, run: s.ids.orig, status: "completed", billingPages: 10, method: "text-rule" });
    await s.insert({ id: `${s.p}-c2`, dedupedFrom: gone });
    await db.query(`delete from documents where id = $1`, [gone]);
    await s.insert({ id: `${s.p}-n`, billingPages: 2, method: "text-rule" });
    const charged = await charge(s.ids.run);
    // The orphan lost its pointer, so it is an original with an assumed count: it bills nothing (the original row bills 2).
    expect(charged.fastPages).toBe(2);
    expect(charged.copies).toEqual({ documents: 1, fastPages: 0, ocrPages: 0, richPages: 0, mediaPages: 0 });
  }, 60_000);

  it("never reads another organization's document, in either direction", async () => {
    const a = await scenario();
    const b = await scenario();
    const theirs = await b.insert({ id: `${b.p}-o`, run: b.ids.orig, org: b.ids.org, status: "completed", billingPages: 900, method: "text-rule", sha: `${a.p}-sha` });
    // A row pairing across organizations (intake never makes one): it must not price org A's charge from org B's data.
    await a.insert({ id: `${a.p}-c`, dedupedFrom: theirs });
    expect((await charge(a.ids.run)).copies).toEqual({ documents: 1, fastPages: 0, ocrPages: 0, richPages: 0, mediaPages: 0 });
    // And org B's own runs see nothing of A's copy.
    expect(await events(b.ids.run)).toEqual([]);
    expect((await charge(b.ids.run)).copies).toBeUndefined();
  }, 60_000);
});

describe("copies are spend-checked like originals' measured pages", () => {
  it("run_measured_pages counts a copy's pages above intake at its recorded classes, and none with the flag off", async () => {
    const s = await scenario();
    await s.insert({ id: `${s.p}-c`, mime: "application/pdf", pageCount: 10, source: "counted", intake: 2, copyOcr: 3, copyRich: 4 });
    const measured = await store.pageBasisLedger.runMeasurements(s.ids.run, null, PAGE_READ_METRICS);
    expect(measured).toMatchObject({ fastPages: 1, ocrPages: 3, richPages: 4, ocrFrames: 0 });
    process.env.DOCSLURP_BILL_DEDUP_COPIES = "off";
    expect(await store.pageBasisLedger.runMeasurements(s.ids.run, null, PAGE_READ_METRICS)).toMatchObject({ fastPages: 0, ocrPages: 0, richPages: 0 });
  }, 60_000);

  it("an unfunded organization re-uploading large copies is paused before any stage, not overdrawn", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const s = await scenario(3);
    for (const index of [1, 2, 3]) await s.insert({ id: `${s.p}-c${index}`, billingPages: 2_000, method: "text-rule", copyOcr: 0, copyRich: 0 });
    const state = await activity(s.ids.run);
    expect(state.documents.every(isDedupCopy)).toBe(true);
    await expect(state.pageBasis.authorizeCopies(state.documents)).rejects.toBeInstanceOf(UnfundedPagesError);
    const [run] = (await db.query<{ control_state: string | null; pause_reason: string | null }>(`select control_state, pause_reason from project_runs where id = $1`, [s.ids.run])).rows;
    expect(run).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    // Nothing was charged by the check.
    expect(await events(s.ids.run)).toEqual([]);
  }, 60_000);

  it("a funded run of copies passes; a run whose copies are all within intake is not checked", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const rich = await scenario();
    await rich.insert({ id: `${rich.p}-c`, billingPages: 50, method: "text-rule", copyOcr: 0, copyRich: 0 });
    const funded = await activity(rich.ids.run);
    expect(await funded.pageBasis.authorizeCopies(funded.documents)).toEqual({ checkedPages: 49 });
    const poor = await scenario(0);
    await poor.insert({ id: `${poor.p}-c`, mime: "text/plain", pageCount: 3, source: "counted", intake: 3, copyOcr: 0, copyRich: 0 });
    const within = await activity(poor.ids.run);
    expect(await within.pageBasis.authorizeCopies(within.documents)).toBeNull();
  }, 60_000);
});
