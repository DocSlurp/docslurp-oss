import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, UNIT_CHARGE_PROVIDER, resolveChatCreditReserveConfig, resolveCreditLeaseConfig, unitChargeMetadata } from "@docslurp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setChatReserveConfig } from "../db/chat-reserve.js";
import { setCreditLeaseConfig } from "../db/credit-lease.js";
import { FAST_PER_DOCUMENT_SLOT, PAGE_BILLING_RULES_SLOT, pinRunFastPerDocument } from "../db/page-base-fee.js";
import { enforceRunSpend, setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The per-document Fast rule (db/page-base-fee.ts chargeDocumentsFastStatement): a document's Fast pages are charged once, as
 * `fast:<run>:<document>`, in the transaction that completes it. A page read is charged when it is read. A run pinned to the
 * rule never gets a run-wide `fast:<run>` charge, and a run started before it keeps the run-wide charge until it ends.
 *
 * In-memory Postgres (PGlite, one connection): orderings and every way a run can end. Real concurrency is in
 * fast-per-document.native.test.ts (NATIVE_PG_TESTS=1 with a migrated DATABASE_URL).
 */
let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

type Doc = { id: string; pages: number; status?: string; source?: string; failedStage?: boolean; intake?: number };

async function seedRun(runId: string, docs: Doc[], options: { org?: string; perDocument?: boolean | null; control?: string; generation?: string } = {}) {
  const org = options.org ?? "o1";
  const project = org === "o1" ? "w" : "w2";
  // undefined: pinned per document; false: pinned run-wide; null: no pins at all (started by an earlier release).
  const artifacts = options.perDocument === null ? {}
    : { [FAST_PER_DOCUMENT_SLOT]: options.perDocument === false ? "0" : "1", [PAGE_BILLING_RULES_SLOT]: "test" };
  await db.query(
    `insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation, control_state, artifacts, monthly_reservation_cents)
     values ($1, $2, 'u1', $3, 'upload', 'processing', 'embed', '{}', $4, $5, $6, $7, 1)`,
    [runId, org, project, docs.length, options.generation ?? "g1", options.control ?? null, JSON.stringify(artifacts)],
  );
  for (const doc of docs) {
    await db.query(
      `insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, intake_page_count)
       values ($1, $2, 'u1', $3, $4, $5, 'application/pdf', $6, $7, $8, $9, $10)`,
      [doc.id, org, project, runId, `${doc.id}.pdf`, `raw/${doc.id}`, doc.status ?? "processing", doc.pages, doc.source ?? "counted", doc.intake ?? doc.pages],
    );
    if (doc.failedStage) {
      await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status, error) values ($1, $2, 'extract-markdown', 'failed', 'parser exited 1')`, [runId, doc.id]);
    }
  }
}

async function fastCharges(runId: string) {
  const { rows } = await db.query<{ id: string; amount: string; org_id: string }>(
    `select id, amount::text, org_id from usage_events where run_id = $1 and metric = $2 order by id`, [runId, BILLABLE_UNIT_METRICS.fastPage]);
  return rows.map((row) => ({ id: row.id, pages: Number(row.amount), org: row.org_id }));
}
const totalFast = async (runId: string) => (await fastCharges(runId)).reduce((sum, row) => sum + row.pages, 0);

// The socket server serves one client at a time, so each phase opens and closes its own pool.
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
const sqlOf = (store: Store) => (store as unknown as { sql: Parameters<typeof persistRunUsageEvents>[0]["client"] }).sql;
const owner = (runId: string, generation: string, org = "o1") => ({ runId, orgId: org, projectId: org === "o1" ? "w" : "w2", executionGeneration: generation });

/** The index stage completing one document (the transaction that makes it searchable). `reads`: page reads its ledger holds. */
async function indexDocument(runId: string, documentId: string, options: { reads?: number[]; persistReads?: number[]; firstPassShard?: { differs: boolean } } = {}) {
  return withStore(async (store) => {
    const state = await loadRunState(store, runId);
    if (options.firstPassShard) {
      state.firstPassShard = true;
      state.firstPassExtractionDiffers = options.firstPassShard.differs;
    }
    for (const page of options.persistReads ?? []) state.usageLedger.chargeOcrPage({ documentId, pageNumber: page, readBy: "page-ocr" });
    if ((options.persistReads ?? []).length > 0) {
      const batch = state.usageLedger.checkpoint();
      await persistRunUsageEvents({ client: sqlOf(store), state, usageEvents: batch.events });
      batch.commit();
    }
    for (const page of options.reads ?? []) state.usageLedger.chargeRichPage({ documentId, pageNumber: page, readBy: "page-analysis" });
    await store.startDocumentStage(state, documentId, "index");
    await store.completeDocumentStage(state, documentId, "index", "", {});
    // The ledger's reads reach the database with the next checkpoint, as in a run.
    const batch = state.usageLedger.checkpoint();
    await persistRunUsageEvents({ client: sqlOf(store), state, usageEvents: batch.events });
    batch.commit();
    return state;
  });
}
const complete = (runId: string, generation = "g1", org?: string) =>
  withStore(async (store) => store.completeRun(await loadRunState(store, runId), owner(runId, generation, org)));
const fail = (runId: string, generation = "g1", org?: string) =>
  withStore(async (store) => store.failRun(runId, "embed", "workflow cancelled", owner(runId, generation, org)));
/** What the server's retry does (run-lifecycle resumeCompletedWithFailures / resumeFailed): a new generation, failed documents queued. */
async function resume(runId: string, generation: string) {
  await db.query(`delete from document_run_stage_states where run_id = $1 and status <> 'completed'`, [runId]);
  await db.query(`update documents set status = 'queued' where run_id = $1 and status not in ('completed', 'cancelled')`, [runId]);
  await db.query(`update project_runs set status = 'processing', control_state = null, execution_generation = $2 where id = $1`, [runId, generation]);
}
/** An earlier release's run-wide charge, written as that release writes it. */
async function olderWorkerCharge(runId: string, id: string, pages: number, metric: string = BILLABLE_UNIT_METRICS.fastPage, extra: Record<string, unknown> = { pageRules: 2 }) {
  await withStore(async (store) => {
    const state = await loadRunState(store, runId);
    await persistRunUsageEvents({ client: sqlOf(store), state, usageEvents: [{
      id, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric, amount: pages, unit: "page", costCents: pages,
      metadata: unitChargeMetadata({ pages, ...extra }),
    }] });
  });
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 100000);
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o2', 'Broke', 'broke', 'u1', 0.01);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into projects(id, org_id, user_id, name) values ('w2', 'o2', 'u1', 'W2');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 120_000);

beforeEach(() => {
  setSpendCheckConfig({ enabled: true, pages: 1_000_000, credits: 1_000_000 });
  setCreditLeaseConfig(resolveCreditLeaseConfig({ WORKER_CREDIT_LEASES: "off" }));
  setChatReserveConfig(resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0", RUN_CREDIT_OVERDRAFT_CREDITS: "0" }));
});

afterAll(async () => {
  setSpendCheckConfig(null);
  setCreditLeaseConfig(null);
  setChatReserveConfig(null);
  await server?.stop();
  await db?.close();
});

describe("a document's Fast pages are charged when it completes", () => {
  it("charges fast:<run>:<document> in the completing transaction, less the pages a read charged, once", { timeout: 60_000 }, async () => {
    await seedRun("doc", [{ id: "doc-a", pages: 10 }, { id: "doc-b", pages: 4 }]);
    // Pages 1-2 were read by OCR and persisted; page 3 by vision, still in the ledger when the document completes.
    await indexDocument("doc", "doc-a", { persistReads: [1, 2], reads: [3] });
    expect(await fastCharges("doc")).toEqual([{ id: "fast:doc:doc-a", pages: 7, org: "o1" }]);
    // A re-index (retry, stale worker, reprocess in the same run) charges nothing more.
    await indexDocument("doc", "doc-a");
    expect(await fastCharges("doc")).toEqual([{ id: "fast:doc:doc-a", pages: 7, org: "o1" }]);
    // The mid-run spend check counts the charge (the cadence counter), and its pending debit is on the run's organization.
    const [run] = (await db.query<{ unchecked: string; spent: string }>(`select spend_unchecked_credits::text as unchecked, spent_cents::text as spent from project_runs where id = 'doc'`)).rows;
    expect(Number(run!.unchecked)).toBeGreaterThan(0);
    expect(Number(run!.spent)).toBeGreaterThan(0);
    // The run completes: doc-b (no index stage) is completed and charged there; doc-a is not charged again; no fast:<run>.
    await complete("doc");
    expect(await fastCharges("doc")).toEqual([{ id: "fast:doc:doc-a", pages: 7, org: "o1" }, { id: "fast:doc:doc-b", pages: 4, org: "o1" }]);
    const [reported] = (await db.query<{ p: Record<string, number> }>(`select stats -> 'pageCharges' as p from project_runs where id = 'doc'`)).rows;
    expect(reported!.p).toMatchObject({ fastPages: 4, fastDocuments: 1 });
    // The reads stayed reads (this run has no OCR class pin, so its OCR reads bill Rich), never Fast as well.
    const { rows: reads } = await db.query<{ metric: string; n: string }>(`select metric, count(*)::text as n from usage_events where run_id = 'doc' and metric <> $1 and metadata ->> 'unitCharge' = 'true' group by metric order by metric`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(reads).toEqual([{ metric: BILLABLE_UNIT_METRICS.richPage, n: "3" }]);
  });

  it("documents that never became searchable bill nothing; an unmeasured one is logged and counted", { timeout: 60_000 }, async () => {
    warn.mockClear();
    await seedRun("unserved", [
      { id: "unserved-ok", pages: 2 },
      { id: "unserved-pii", pages: 5, status: "pii_blocked" },
      { id: "unserved-cancelled", pages: 5, status: "cancelled" },
      { id: "unserved-failed", pages: 5, status: "failed", failedStage: true },
      { id: "unserved-estimate", pages: 9, source: "assumed" },
    ]);
    await complete("unserved");
    expect(await fastCharges("unserved")).toEqual([{ id: "fast:unserved:unserved-ok", pages: 2, org: "o1" }]);
    const [reported] = (await db.query<{ p: Record<string, number> }>(`select stats -> 'pageCharges' as p from project_runs where id = 'unserved'`)).rows;
    expect(reported!.p).toMatchObject({ fastPages: 2, unmeasuredDocuments: 1 });
    expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringMatching(/run=unserved unmeasured-documents=1 billed-pages=0 documents=unserved-estimate/));
  });

  it("a first-pass shard charges only when the ordinary loop will not extract the document again", { timeout: 60_000 }, async () => {
    await seedRun("fp", [{ id: "fp-same", pages: 3 }, { id: "fp-vision", pages: 3 }, { id: "fp-skipped", pages: 2 }]);
    await indexDocument("fp", "fp-same", { firstPassShard: { differs: false } });
    await indexDocument("fp", "fp-vision", { firstPassShard: { differs: true } });
    await indexDocument("fp", "fp-skipped", { firstPassShard: { differs: true } });
    expect(await fastCharges("fp")).toEqual([{ id: "fast:fp:fp-same", pages: 3, org: "o1" }]);
    // The ordinary loop reads page 2 of fp-vision with a vision model and indexes it again: charged then, without that page.
    await indexDocument("fp", "fp-vision", { reads: [2] });
    // fp-skipped is not indexed again (its content did not change): the end of the index stage charges it.
    await withStore(async (store) => {
      const state = await loadRunState(store, "fp");
      await store.completeRunStage(state, "index", "", {});
    });
    expect(await fastCharges("fp")).toEqual([
      { id: "fast:fp:fp-same", pages: 3, org: "o1" }, { id: "fast:fp:fp-skipped", pages: 2, org: "o1" }, { id: "fast:fp:fp-vision", pages: 2, org: "o1" },
    ]);
  });
});

describe("every way a run can end leaves each searchable document charged exactly once (F1)", () => {
  it("pause and walk away: documents completed before the pause stay charged, with no terminal transaction", { timeout: 60_000 }, async () => {
    await seedRun("pause", [{ id: "pause-a", pages: 6 }, { id: "pause-b", pages: 3 }]);
    await indexDocument("pause", "pause-a");
    // POST /runs/:id/control {action: "pause"}: the workflow waits forever and finalizeRun refuses a paused run.
    await db.query(`update project_runs set control_state = 'paused' where id = 'pause'`);
    await expect(complete("pause")).rejects.toThrow();
    expect(await fastCharges("pause")).toEqual([{ id: "fast:pause:pause-a", pages: 6, org: "o1" }]);
  });

  it("a spend-paused run cancelled by the server keeps its completed documents' charges and bills nothing else", { timeout: 60_000 }, async () => {
    await seedRun("spendcancel", [{ id: "spendcancel-a", pages: 4 }, { id: "spendcancel-b", pages: 3 }]);
    await indexDocument("spendcancel", "spendcancel-a");
    // The worker's spend check paused the run; the server applies the cancel directly (run-lifecycle), no worker failRun.
    await db.query(`update project_runs set control_state = 'paused' where id = 'spendcancel'`);
    await db.query(`update project_runs set status = 'failed', control_state = 'cancelled' where id = 'spendcancel'`);
    await db.query(`update documents set status = 'cancelled' where run_id = 'spendcancel' and status <> 'completed'`);
    expect(await fastCharges("spendcancel")).toEqual([{ id: "fast:spendcancel:spendcancel-a", pages: 4, org: "o1" }]);
  });

  it("a server-side fail, a sweep or a project deletion writes the run terminal: the charges already stand", { timeout: 60_000 }, async () => {
    await seedRun("sweep", [{ id: "sweep-a", pages: 2 }, { id: "sweep-b", pages: 5 }]);
    await indexDocument("sweep", "sweep-a");
    await db.query(`update project_runs set status = 'failed' where id = 'sweep'`);
    expect(await fastCharges("sweep")).toEqual([{ id: "fast:sweep:sweep-a", pages: 2, org: "o1" }]);
  });

  it("a worker cancel bills nothing more, and a resume bills the documents it completes once", { timeout: 60_000 }, async () => {
    await seedRun("cancel", [{ id: "cancel-a", pages: 3 }, { id: "cancel-b", pages: 2 }], { control: "cancel_requested" });
    await indexDocument("cancel", "cancel-a");
    await fail("cancel");
    await fail("cancel");
    expect(await fastCharges("cancel")).toEqual([{ id: "fast:cancel:cancel-a", pages: 3, org: "o1" }]);
    await resume("cancel", "g2");
    await indexDocument("cancel", "cancel-b");
    await complete("cancel", "g2");
    await complete("cancel", "g2");
    expect(await totalFast("cancel")).toBe(5);
  });

  it("deleting a charged document lets no later document ride free (F2)", { timeout: 60_000 }, async () => {
    await seedRun("del", [{ id: "del-a", pages: 1000 }, { id: "del-b", pages: 1000 }], { control: "cancel_requested" });
    await indexDocument("del", "del-a");
    await fail("del");
    // Export, then hard-delete the charged document; its charge (and debit) stays.
    await db.query(`delete from documents where id = 'del-a'`);
    await resume("del", "g2");
    await indexDocument("del", "del-b");
    await complete("del", "g2");
    expect(await fastCharges("del")).toEqual([{ id: "fast:del:del-a", pages: 1000, org: "o1" }, { id: "fast:del:del-b", pages: 1000, org: "o1" }]);
  });

  it("an unfunded organization's run records the debt and pauses at its next spend check", { timeout: 60_000 }, async () => {
    await seedRun("broke", [{ id: "broke-a", pages: 50 }, { id: "broke-b", pages: 5 }], { org: "o2" });
    await indexDocument("broke", "broke-a");
    expect(await fastCharges("broke")).toEqual([{ id: "fast:broke:broke-a", pages: 50, org: "o2" }]);
    const { rows: owed } = await db.query<{ org_id: string }>(`select distinct org_id from credit_debits_pending where run_id = 'broke'`);
    expect(owed).toEqual([{ org_id: "o2" }]);
    expect(await withStore((store) => enforceRunSpend(sqlOf(store), { id: "broke", orgId: "o2", projectId: "w2", userId: "u1" }, "checkpoint-interval")))
      .toMatchObject({ blocked: true, paused: true });
  });

  it("a charge and its lookups never touch another organization's rows", { timeout: 60_000 }, async () => {
    await seedRun("tenant", [{ id: "tenant-a", pages: 4 }]);
    // Another organization's read rows that name this run's document and pages (forged ids) must not cancel any Fast page.
    await db.query(`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id, project_id)
      values ('rich:tenant:tenant-a:1', 'u1', null, $1, 'price-card', $2, 1, 'page', 0, 0, 0, '{"unitCharge": true, "documentId": "tenant-a", "pageNumber": 1}', 'o2', 'w2')`,
      [UNIT_CHARGE_PROVIDER, BILLABLE_UNIT_METRICS.richPage]);
    await indexDocument("tenant", "tenant-a");
    expect(await fastCharges("tenant")).toEqual([{ id: "fast:tenant:tenant-a", pages: 4, org: "o1" }]);
    expect((await db.query(`select 1 from credit_debits_pending where run_id = 'tenant' and org_id <> 'o1'`)).rows).toHaveLength(0);
  });

  it("the mid-run spend check counts a charged document's pages once (run_measured_pages)", { timeout: 60_000 }, async () => {
    await seedRun("measured", [{ id: "measured-a", pages: 8, intake: 2 }, { id: "measured-b", pages: 6, intake: 2 }]);
    const sum = async () => (await db.query<{ fast_pages: string }>(`select fast_pages::text from run_measured_pages('measured', $1::text[], null)`,
      [[BILLABLE_UNIT_METRICS.ocrPage, BILLABLE_UNIT_METRICS.richPage]])).rows[0]!.fast_pages;
    expect(await sum()).toBe("10");
    await indexDocument("measured", "measured-a");
    // measured-a's 6 pages above intake are in spent_cents now (its charge): only measured-b's 4 stay measured-and-uncharged.
    expect(await sum()).toBe("4");
  });
});

describe("deploy transition: no run is billed under both rules", () => {
  it("pins a run per document only on its first start and only when every live worker supports it", async () => {
    const ledger = (artifacts: Record<string, string> = {}) => ({ read: (key: string) => artifacts[key], record: (key: string, value: string | null | undefined) => { if (value) artifacts[key] = value; return value ?? undefined; } });
    const yes = async () => true;
    const off = { completedDocuments: false, env: {} };
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: {} } }, yes, off)).toBe(true);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: {} } }, async () => false, off)).toBe(false);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: {} } }, async () => { throw new Error("db down"); }, off)).toBe(false);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: {} } }, yes, { completedDocuments: false, env: { DOCSLURP_FAST_PER_DOCUMENT: "off" } })).toBe(false);
    // Started by an earlier release (its pins), completed and billed before (pageCharges), or with documents it completed.
    expect(await pinRunFastPerDocument({ artifactLedger: ledger({ [PAGE_BILLING_RULES_SLOT]: "v" }), run: { stats: {} } }, yes, off)).toBe(false);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: { pageCharges: { fastPages: 3 } } } }, yes, off)).toBe(false);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger(), run: { stats: {} } }, yes, { completedDocuments: true, env: {} })).toBe(false);
    // A retried start keeps the first decision, whatever the fleet says now.
    expect(await pinRunFastPerDocument({ artifactLedger: ledger({ [FAST_PER_DOCUMENT_SLOT]: "1" }), run: { stats: {} } }, async () => false, off)).toBe(true);
    expect(await pinRunFastPerDocument({ artifactLedger: ledger({ [FAST_PER_DOCUMENT_SLOT]: "0" }), run: { stats: {} } }, yes, off)).toBe(false);
  });

  it("old first, then new: a run started before the deploy keeps the one run-wide charge when a new worker completes it", { timeout: 60_000 }, async () => {
    await seedRun("before", [{ id: "before-a", pages: 3 }, { id: "before-b", pages: 2 }], { perDocument: null });
    await indexDocument("before", "before-a");
    // The run has no per-document pin: its index completions charge nothing.
    expect(await fastCharges("before")).toEqual([]);
    await complete("before");
    expect(await fastCharges("before")).toEqual([{ id: "fast:before", pages: 5, org: "o1" }]);
  });

  it("new first, then old: an older worker's run-wide charge on a per-document run is refused (and its retry by a new worker bills the rest)", { timeout: 60_000 }, async () => {
    await seedRun("rollback", [{ id: "rollback-a", pages: 3 }, { id: "rollback-b", pages: 2 }]);
    await indexDocument("rollback", "rollback-a");
    await expect(olderWorkerCharge("rollback", "fast:rollback", 5)).rejects.toThrow(/bills Fast per document/);
    await complete("rollback");
    expect(await fastCharges("rollback")).toEqual([{ id: "fast:rollback:rollback-a", pages: 3, org: "o1" }, { id: "fast:rollback:rollback-b", pages: 2, org: "o1" }]);
  });

  it("new cancel, then old completion (F3): the older worker is refused, a new worker completes and bills the remainder", { timeout: 60_000 }, async () => {
    await seedRun("f3", [{ id: "f3-a", pages: 4 }, { id: "f3-b", pages: 6 }], { control: "cancel_requested" });
    await indexDocument("f3", "f3-a");
    await fail("f3");
    await resume("f3", "g2");
    await expect(olderWorkerCharge("f3", "fast:f3", 10)).rejects.toThrow(/bills Fast per document/);
    await complete("f3", "g2");
    expect(await totalFast("f3")).toBe(10);
    expect((await fastCharges("f3")).map((row) => row.id)).toEqual(["fast:f3:f3-a", "fast:f3:f3-b"]);
  });

  it("a run billed entirely before the deploy, then retried after it, keeps the run-wide rule and is never billed twice", { timeout: 60_000 }, async () => {
    await seedRun("billed", [{ id: "billed-a", pages: 4, status: "completed" }, { id: "billed-b", pages: 2, status: "failed", failedStage: true }], { perDocument: null });
    await db.query(`update project_runs set status = 'completed', stats = '{"pageCharges": {"fastPages": 4}}' where id = 'billed'`);
    await olderWorkerCharge("billed", "fast:billed", 4);
    await resume("billed", "g2");
    // The retry's start pins it run-wide (it was completed and billed before).
    const pinned = await withStore(async (store) => {
      const state = await loadRunState(store, "billed");
      return await pinRunFastPerDocument(state, async () => true, { completedDocuments: true, env: {} });
    });
    expect(pinned).toBe(false);
    await indexDocument("billed", "billed-b");
    await complete("billed", "g2");
    // The run-wide rule as on main: its one id conflicts, so nothing is billed twice (the retried pages stay unbilled, as on main).
    expect(await fastCharges("billed")).toEqual([{ id: "fast:billed", pages: 4, org: "o1" }]);
  });

  it("the legacy completion charge (<runId>, page-base-fee): a retried run keeps the run-wide rule", { timeout: 60_000 }, async () => {
    await seedRun("legacy", [{ id: "legacy-a", pages: 4, status: "completed" }, { id: "legacy-b", pages: 1, status: "failed", failedStage: true }], { perDocument: null });
    await db.query(`update project_runs set status = 'completed' where id = 'legacy'`);
    await olderWorkerCharge("legacy", "legacy", 4, "page-base-fee", {});
    await resume("legacy", "g2");
    const pinned = await withStore(async (store) => {
      const state = await loadRunState(store, "legacy");
      // No pin and no report: the completed document alone keeps it run-wide.
      return await pinRunFastPerDocument(state, async () => true, { completedDocuments: state.documents.some((doc) => doc.status === "completed"), env: {} });
    });
    expect(pinned).toBe(false);
    expect((await fastCharges("legacy")).filter((row) => row.id.startsWith("fast:legacy:"))).toEqual([]);
  });

  it("with the guard off (a deliberate worker rollback), an older worker's charge is written", { timeout: 60_000 }, async () => {
    await seedRun("guardoff", [{ id: "guardoff-a", pages: 2 }]);
    await indexDocument("guardoff", "guardoff-a");
    await db.query(`set docslurp.page_rules_guard = 'off'`);
    try {
      await olderWorkerCharge("guardoff", "fast:guardoff", 2);
    } finally {
      await db.query(`reset docslurp.page_rules_guard`);
    }
    expect((await fastCharges("guardoff")).map((row) => row.id)).toEqual(["fast:guardoff", "fast:guardoff:guardoff-a"]);
  });
});

describe("run-wide runs (pinned 0) are unchanged", () => {
  it("bill once at completion and never at a cancel", { timeout: 60_000 }, async () => {
    await seedRun("wide", [{ id: "wide-a", pages: 3 }, { id: "wide-b", pages: 2 }], { perDocument: false, control: "cancel_requested" });
    await indexDocument("wide", "wide-a");
    await fail("wide");
    expect(await fastCharges("wide")).toEqual([]);
    await resume("wide", "g2");
    await complete("wide", "g2");
    expect(await fastCharges("wide")).toEqual([{ id: "fast:wide", pages: 5, org: "o1" }]);
  });
});

