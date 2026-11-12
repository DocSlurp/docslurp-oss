import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHash } from "node:crypto";
import { BILLABLE_UNIT_METRICS, decodeTextBytes, defaultPipelineFeatures, pageCredits, textPageCount } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { recordMeasuredTextPageCount, TEXT_MEASURE_MAX_BYTES } from "../lib/text-page-count.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";

/**
 * The API counts a text file over 2 MB from a 2 MB sample scaled by size (`assumed`). The worker counts the whole decoded
 * text with the same rule, records it `counted`, and billing reads only that. This file's sample under-counts: its first
 * 2 MB is one long line (pages by characters), the rest is a million short lines (pages by lines).
 */
const SAMPLE_BYTES = 2_000_000;
const bytes = new Uint8Array(Buffer.concat([Buffer.alloc(SAMPLE_BYTES, "a"), Buffer.alloc(1_000_000, "\n"), Buffer.from("end")]));
const sha = createHash("sha256").update(bytes).digest("hex");
// What intake (server source-metadata.ts) stores: the text rule over the first 2 MB, scaled by the file's size.
const apiEstimate = Math.max(1, Math.ceil(textPageCount(decodeTextBytes(bytes.subarray(0, SAMPLE_BYTES), "utf-8")) * (bytes.length / SAMPLE_BYTES)));
const fullCount = Math.ceil(1_000_001 / 60);
const textFacts = { declaredMimeType: "text/plain", sniffedMimeType: null, mimeType: "text/plain", format: "plain-text", container: null, encoding: "utf-8", mismatch: "none" };

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 10000000), ('o2', 'Low', 'low', 'u1', 8, 101);
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, ${apiEstimate}),
             ('run2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, ${apiEstimate});
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, source_sha256, file_facts, parse_source_scan_version) values
      ('big', 'o1', 'u1', 'w1', 'run1', 'log.txt', 'text/plain', 'raw/big', 'processing', ${apiEstimate}, 'assumed', '${sha}', '${JSON.stringify(textFacts)}', 1),
      ('poor', 'o2', 'u1', 'w2', 'run2', 'log.txt', 'text/plain', 'raw/poor', 'processing', ${apiEstimate}, 'assumed', '${sha}', '${JSON.stringify(textFacts)}', 1),
      ('small', 'o1', 'u1', 'w1', 'run1', 'a.txt', 'text/plain', 'raw/small', 'processing', 2, 'counted', null, '${JSON.stringify(textFacts)}', 1);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);
afterEach(() => { setSpendCheckConfig(null); });
afterAll(async () => { await store?.close(); await server?.stop(); await db?.close(); });

async function stateFor(runId: string, documentId: string) {
  const document = (await store.loadDocument(documentId))!;
  const state = WorkflowState.create(await store.loadRun(runId), [document]);
  state.store = store;
  state.usageLedger.runId = runId;
  return { state, document };
}
const pageRow = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${id}'`)).rows[0];

describe("text pages are measured in full by the worker, and only that count bills", () => {
  it("the fixture's 2 MB sample under-counts the file", () => {
    expect(bytes.length).toBeGreaterThan(SAMPLE_BYTES);
    expect(apiEstimate).toBeLessThan(fullCount / 10);
  });

  it("an estimate is assumed and bills nothing until the worker measures it", async () => {
    const { state } = await stateFor("run1", "big");
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    // A dry read of what would bill: the assumed text file contributes no pages, the counted one its two.
    const before = await sql<{ id: string }[]>`select id from documents where run_id = 'run1' and (billing_pages is not null or page_count_source = 'counted')`;
    expect(before.map((row) => row.id)).toEqual(["small"]);
    expect(state.documents[0]!.pageCountSource).toBe("assumed");
  }, 60_000);

  it("counts the whole decoded text with the same rule, records it counted, and bills exactly that count", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run1", "big");
    const readSource = vi.fn(async (maxBytes: number) => { expect(maxBytes).toBe(TEXT_MEASURE_MAX_BYTES); return bytes; });
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource })).toEqual({ pages: fullCount, estimate: apiEstimate });
    expect(await pageRow("big")).toEqual({ page_count: fullCount, page_count_source: "counted" });
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    const charges = await recordPageBaseFee(sql, WorkflowState.create(await store.loadRun("run1"), [(await store.loadDocument("big"))!, (await store.loadDocument("small"))!]));
    expect(charges.fastPages).toBe(fullCount + 2);
    const { rows } = await db.query<{ amount: string; cost_cents: string }>(`select amount::text, cost_cents::text from usage_events where run_id = 'run1' and metric = $1`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(Number(rows[0]!.amount)).toBe(fullCount + 2);
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(pageCredits("fast", fullCount + 2));
  }, 60_000);

  it("leaves a count intake took from the whole text alone", async () => {
    const { state, document } = await stateFor("run1", "small");
    const readSource = vi.fn();
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource })).toBeNull();
    expect(readSource).not.toHaveBeenCalled();
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "poor");
    expect(await recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => bytes })).toMatchObject({ pages: fullCount });
    await expect(authorizeMeasuredPages(state, document)).rejects.toMatchObject({ name: "RunPolicyError" });
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run2'`);
    expect(rows[0]!.control_state).toBe("paused");
  }, 60_000);

  it("refuses a file too large to measure, or bytes that are not the uploaded source, instead of billing an estimate", async () => {
    await db.exec(`update documents set page_count = ${apiEstimate}, page_count_source = 'assumed' where id = 'poor'`);
    const { state, document } = await stateFor("run2", "poor");
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async (max) => { throw new StorageObjectTooLargeError("raw/poor", max + 1, max); } }))
      .rejects.toThrow(/too large to measure/);
    await expect(recordMeasuredTextPageCount({ state, document, format: "plain-text", readSource: async () => new TextEncoder().encode("swapped") }))
      .rejects.toMatchObject({ name: "SourceIntegrityError" });
    expect(await pageRow("poor")).toEqual({ page_count: apiEstimate, page_count_source: "assumed" });
  }, 60_000);

  it("Store.pauseRunForSpend pauses a processing run once; a second pause reports blocked, not paused", async () => {
    await db.exec(`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
      values ('run3', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract', '${pipeline}', 1)`);
    const run = { id: "run3", orgId: "o1", projectId: "w1", userId: "u1" };
    expect(await store.pauseRunForSpend(run, "credit_exhausted")).toEqual({ paused: true, blocked: true });
    const { rows } = await db.query<{ control_state: string; pause_reason: string }>(`select control_state, pause_reason from project_runs where id = 'run3'`);
    expect(rows[0]).toEqual({ control_state: "paused", pause_reason: "credit_exhausted" });
    expect(await store.pauseRunForSpend(run, "credit_exhausted")).toEqual({ paused: false, blocked: true });
  }, 60_000);
});
