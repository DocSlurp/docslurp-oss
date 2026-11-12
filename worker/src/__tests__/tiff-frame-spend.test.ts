import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { defaultPipelineFeatures, installTestPricing, OPEN_PRICING, pricing } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { enforceRunSpendForCharge, setSpendCheckConfig, SpendCheckUnavailableError } from "../db/spend-check.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { Store } from "../db/store.js";
import { affordableImageFrames, authorizeImageFrames } from "../ocr/image-frames.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/*
 * The frame-count spend check against a migrated database and the real spend check: a TIFF's counted frames are Rich pages
 * admission never priced (intake counted one), so the balance is checked for them before any is charged, summed over the
 * run's TIFFs so concurrent documents cannot each fit alone.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  // Balances above the 20-credit starter chat reserve: 5 and 10 spendable credits.
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents)
      values ('o-low', 'Low', 'low', 'u1', 8, 25), ('o-ten', 'Ten', 'ten', 'u1', 8, 30);
    insert into projects(id, org_id, user_id, name) values ('w-low', 'o-low', 'u1', 'L'), ('w-ten', 'o-ten', 'u1', 'T');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run-low', 'o-low', 'u1', 'w-low', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, 1),
             ('run-ten', 'o-ten', 'u1', 'w-ten', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 2);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source) values
      ('tiff-40', 'o-low', 'u1', 'w-low', 'run-low', 'deposition.tiff', 'image/tiff', 'raw/t40', 'processing', 1, 'assumed'),
      ('tiff-a', 'o-ten', 'u1', 'w-ten', 'run-ten', 'a.tiff', 'image/tiff', 'raw/ta', 'processing', 1, 'assumed'),
      ('tiff-b', 'o-ten', 'u1', 'w-ten', 'run-ten', 'b.tiff', 'image/tiff', 'raw/tb', 'processing', 1, 'assumed');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await store?.close();
  await server?.stop();
  await db?.close();
});

async function stateFor(runId: string, documentId: string): Promise<WorkflowState> {
  const state = WorkflowState.create(await store.loadRun(runId), [(await store.loadDocument(documentId))!]);
  state.store = store;
  state.usageLedger.runId = runId;
  return state;
}

const control = async (runId: string) =>
  (await db.query<{ control_state: string | null; pause_reason: string | null }>(`select control_state, pause_reason from project_runs where id = '${runId}'`)).rows[0];
const pageCount = async (documentId: string) =>
  (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${documentId}'`)).rows[0];

describe("charge spend check fails closed", () => {
  it("refuses with a retryable error when the balance read fails, and when the pause it decided on cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = { id: "run-x", orgId: "o-low", projectId: "w-low", userId: "u1" };
    const readFails = (async () => { throw new Error("connection reset"); }) as any;
    await expect(enforceRunSpendForCharge(readFails, run, 5)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    // The balance says no; the pause update then fails.
    let queries = 0;
    const pauseFails = (async () => {
      queries += 1;
      if (queries === 1) return [{ funded: true, available: 0, project_budget_paused: false, org_budget_paused: false, project_in_org: true }];
      throw new Error("deadlock detected");
    }) as any;
    await expect(enforceRunSpendForCharge(pauseFails, run, 5)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    // A run with no organization cannot be checked: refused, never let through.
    await expect(enforceRunSpendForCharge(readFails, { ...run, orgId: null }, 5)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    // Temporal retries it: an ordinary, retryable activity failure on early attempts, and never a document verdict.
    const { classifyActivityError } = await import("../temporal/failure-classification.js");
    const { toStageActivityFailure } = await import("../temporal/activities.js");
    const { isDocumentLevelFailure } = await import("../lib/document-failure.js");
    const refusal = new SpendCheckUnavailableError("spend check failed", { cause: new Error("connection reset") });
    const classification = classifyActivityError(refusal, { shuttingDown: () => false });
    const failure = toStageActivityFailure(refusal, { classification, attempt: 1, ordinaryFailures: 0, ordinaryAttemptLimit: 3 }) as { nonRetryable?: boolean };
    expect(failure.nonRetryable ?? false).toBe(false);
    expect(isDocumentLevelFailure(refusal)).toBe(false);
  });
});

describe("OCR VM provider cost on a refused image", () => {
  it("persists the VM's cost at the sandbox rate as providerCostCents, bills 0 credits, and a retried checkpoint writes it once", async () => {
    const state = await stateFor("run-low", "tiff-40");
    const cents = pricing().internalCost.sandboxCostCents({ provider: "modal", cores: 2, memoryGib: 2, seconds: 33.7 });
    state.usageLedger.enqueue({ provider: "modal", model: "ocr-vm", metric: "sandbox_compute", amount: cents, unit: "cent", costCents: cents,
      metadata: { costRole: "provider", costSource: "estimate", billable: false, documentId: "tiff-40" } });
    const batch = state.usageLedger.checkpoint();
    expect(state.usageLedger.pendingBillableCents).toBe(0);
    const sql = (store as unknown as { sql: Parameters<typeof persistRunUsageEvents>[0]["client"] }).sql;
    // The first write's commit was lost: the checkpoint retries the same batch.
    await persistRunUsageEvents({ client: sql, state, usageEvents: batch.events });
    await persistRunUsageEvents({ client: sql, state, usageEvents: batch.events });
    batch.commit();
    const { rows } = await db.query<{ n: number; cost_cents: string; provider_cost: string }>(
      `select count(*)::int as n, coalesce(sum(cost_cents), 0)::text as cost_cents, coalesce(sum((metadata ->> 'providerCostCents')::float8), 0)::text as provider_cost
       from usage_events where run_id = 'run-low' and metric = 'sandbox_compute'`);
    expect(rows[0]!.n).toBe(1);
    expect(Number(rows[0]!.cost_cents)).toBe(0);
    expect(Number(rows[0]!.provider_cost)).toBeCloseTo(cents, 9);
    expect(cents).toBeGreaterThan(0);
  }, 60_000);
});

describe("TIFF frame-count spend check", () => {
  it("sizes an image's OCR read to the frames the balance covers before the VM starts, without pausing the run", async () => {
    await db.exec(`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source)
      values ('tiff-size', 'o-low', 'u1', 'w-low', 'run-low', 'size.tiff', 'image/tiff', 'raw/ts', 'processing', 1, 'assumed')`);
    const state = await stateFor("run-low", "tiff-size");
    const frames = await affordableImageFrames(state, "tiff-size", 64);
    // 5 spendable credits; each Rich frame past intake's page is 0.25.
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(64);
    expect((frames - 1) * 0.25).toBeLessThanOrEqual(5);
    expect(frames * 0.25).toBeGreaterThan(5);
    expect((await control("run-low"))!.control_state).toBeNull();
  }, 60_000);

  it("pauses the run and refuses a 40-frame TIFF a 5-credit balance cannot cover, before any frame is charged", async () => {
    const state = await stateFor("run-low", "tiff-40");
    // 39 Rich frames beyond intake's page: 9.75 credits.
    await expect(authorizeImageFrames(state, "tiff-40", "extract-markdown", 40)).rejects.toMatchObject({ reason: "spend-paused" });
    expect(await control("run-low")).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    expect(await pageCount("tiff-40")).toEqual({ page_count: 40, page_count_source: "counted" });
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toEqual([]);
  }, 60_000);

  it("adds up the run's TIFFs: two 30-frame files that each fit a 10-credit balance cannot together overdraw it", async () => {
    // 29 extra frames each: 7.25 credits, under the balance alone, 14.5 for the two.
    await authorizeImageFrames(await stateFor("run-ten", "tiff-a"), "tiff-a", "extract-markdown", 30);
    expect((await control("run-ten"))!.control_state).toBeNull();
    // tiff-a's frames are counted but not yet charged (its activity has not checkpointed): tiff-b sees them.
    await expect(authorizeImageFrames(await stateFor("run-ten", "tiff-b"), "tiff-b", "extract-markdown", 30)).rejects.toMatchObject({ reason: "spend-paused" });
    expect((await control("run-ten"))!.control_state).toBe("paused");
    expect((await store.countedImageFrames("run-ten")).map((row) => [row.documentId, row.pageCount, row.chargedPages]).sort()).toEqual([["tiff-a", 30, 0], ["tiff-b", 30, 0]]);
    // Scoped to its run.
    expect((await store.countedImageFrames("run-low")).map((row) => row.documentId)).toEqual(["tiff-40"]);
  }, 60_000);
});
