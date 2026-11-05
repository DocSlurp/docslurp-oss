import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedPdfExtractorProvider } from "../extractors/plugins.js";
import { recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { SandboxRunError } from "../sandbox/types.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The API no longer parses PDFs: intake stores a size estimate (`assumed`). The worker measures the real count in the PDF
 * boundary (a VM, or customer-owned local pdfinfo), records it `counted`, and billing reads only that.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
const pipeline = JSON.stringify({ ...defaultPipelineFeatures });
const pdfFacts = { declaredMimeType: "application/pdf", sniffedMimeType: "application/pdf", mimeType: "application/pdf", format: "pdf", container: null, encoding: null, mismatch: "none" };

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 100000), ('o2', 'Low', 'low', 'u1', 8, 101);
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 4, 4),
             ('run2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts) values
      ('local', 'o1', 'u1', 'w1', 'run1', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}'),
      ('vm', 'o1', 'u1', 'w1', 'run1', 'b.pdf', 'application/pdf', 'raw/b', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}'),
      ('never', 'o1', 'u1', 'w1', 'run1', 'c.pdf', 'application/pdf', 'raw/c', 'completed', 5, 'assumed', '${JSON.stringify(pdfFacts)}'),
      ('big', 'o2', 'u1', 'w2', 'run2', 'd.pdf', 'application/pdf', 'raw/d', 'processing', 1, 'assumed', '${JSON.stringify(pdfFacts)}');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}, 120_000);
afterEach(() => { resetExtractorPluginsForTest(); setSpendCheckConfig(null); });
afterAll(async () => { await store?.close(); await server?.stop(); await db?.close(); });

async function stateFor(runId: string, documentId: string) {
  const document = (await store.loadDocument(documentId))!;
  const state = WorkflowState.create(await store.loadRun(runId), [document]);
  state.store = store;
  state.usageLedger.runId = runId;
  return { state, document };
}
const runner = (stdout: string) => ({
  pdfInfo: vi.fn(async (source: string) => ({ binary: "pdfinfo", args: [source], available: true })),
  run: vi.fn(async () => ({ stdout, stderr: "" })),
});
const pageRow = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${id}'`)).rows[0];

describe("PDF page counts are measured by the worker, never parsed by the API", () => {
  it("local mode: pdfinfo under the parser sandbox replaces intake's estimate", async () => {
    const { state, document } = await stateFor("run1", "local");
    const local = runner("Title: x\nPages:          7\n");
    const measured = await recordMeasuredPdfPageCount({ state, document, runner: local, sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } });
    expect(measured).toEqual({ pages: 7, method: "local", estimate: 3 });
    expect(await pageRow("local")).toEqual({ page_count: 7, page_count_source: "counted" });
    expect(document).toMatchObject({ pageCount: 7, pageCountSource: "counted" });
  }, 60_000);

  it("vm mode: the provider counts it in a VM, and no host parser runs", async () => {
    const pageCount = vi.fn(async () => ({ pages: 12 }));
    registerExtractorPlugin({ apiVersion: 1, name: "vm", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1, pageCount } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run1", "vm");
    const host = runner("Pages: 99\n");
    expect(await recordMeasuredPdfPageCount({ state, document, runner: host, sourcePath: async () => "/tmp/b.pdf", env: { DOCSLURP_PDF_MODE: "vm" } }))
      .toEqual({ pages: 12, method: "vm", estimate: 3 });
    expect(pageCount).toHaveBeenCalledWith({ input: "/tmp/b.pdf" }, undefined);
    expect(host.pdfInfo).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  }, 60_000);

  it("vm mode with a provider that cannot count: refused loudly, never measured on the host", async () => {
    registerExtractorPlugin({ apiVersion: 1, name: "old", sandboxedPdf: { id: "old-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1 } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run1", "never");
    const host = runner("Pages: 5\n");
    await expect(recordMeasuredPdfPageCount({ state, document, runner: host, sourcePath: async () => "/tmp/c.pdf", env: { DOCSLURP_PDF_MODE: "vm" } }))
      .rejects.toThrow(/VM PDF provider does not count pages/);
    expect(host.run).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses an unreadable PDF (no valid page count) instead of keeping the estimate", async () => {
    await db.exec(`update documents set page_count = 3, page_count_source = 'assumed' where id = 'local'`);
    const { state, document } = await stateFor("run1", "local");
    await expect(recordMeasuredPdfPageCount({ state, document, runner: runner("Syntax Error: no pages\n"), sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .rejects.toThrow(/no valid page count/);
    await db.exec(`update documents set page_count = 7, page_count_source = 'counted' where id = 'local'`);
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "big");
    await expect(recordMeasuredPdfPageCount({ state, document, runner: runner("Pages: 5000\n"), sourcePath: async () => "/tmp/d.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .rejects.toMatchObject({ name: "RunPolicyError" });
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from workspace_runs where id = 'run2'`);
    expect(rows[0]!.control_state).toBe("paused");
  }, 60_000);

  it("billing reads only measured counts: the measured PDFs bill their pages, the one still estimated bills nothing", async () => {
    const { state } = await stateFor("run1", "local");
    state.documents.push((await store.loadDocument("vm"))!, (await store.loadDocument("never"))!);
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    const charges = await recordPageBaseFee(sql, state);
    expect(charges.fastPages).toBe(7 + 12);
    const { rows } = await db.query<{ amount: string; cost_cents: string }>(`select amount::text, cost_cents::text from usage_events where run_id = 'run1' and metric = $1`, [BILLABLE_UNIT_METRICS.fastPage]);
    expect(Number(rows[0]!.amount)).toBe(19);
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(pageCredits("fast", 19));
  }, 60_000);

  it("a page-count VM that ran and failed records its provider cost (0 credits) before the refusal propagates", async () => {
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-fail', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 3);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
        values ('vm-fail', 'o1', 'u1', 'w1', 'run-fail', 'e.pdf', 'application/pdf', 'raw/e', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}');`);
    const usage = { provider: "modal", model: "doppler-vm", metric: "sandbox_compute", amount: 12, unit: "second", costCents: 0.42, inputTokens: 0, outputTokens: 0, metadata: { costRollup: "authoritative" } };
    const pageCount = vi.fn(async () => { throw new SandboxRunError("Document VM invalid page-count envelope", usage as never); });
    registerExtractorPlugin({ apiVersion: 1, name: "vm", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1, pageCount } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run-fail", "vm-fail");
    await runDocumentStage(state, document, "format-detect", "vm-fail:format-detect", "x", async () => {
      await recordMeasuredPdfPageCount({ state, document, runner: runner("Pages: 9\n"), sourcePath: async () => "/tmp/e.pdf", env: { DOCSLURP_PDF_MODE: "vm" } });
      return { stats: {} };
    }).catch(() => undefined);
    expect(state.documentStage("vm-fail", "format-detect")?.status).toBe("failed");
    const rows = (await db.query<{ metric: string; cost_cents: string; provider_cost: string | null }>(
      `select metric, cost_cents::text, (metadata ->> 'providerCostCents') as provider_cost from usage_events where run_id = 'run-fail'`)).rows;
    expect(rows).toEqual([expect.objectContaining({ metric: "sandbox_compute" })]);
    // Our cost is kept as providerCostCents; the customer is charged nothing for it (cost_cents 0).
    expect(Number(rows[0]!.provider_cost)).toBeCloseTo(0.42);
    expect(Number(rows[0]!.cost_cents)).toBe(0);
    // Customer credits: nothing billable for the run.
    const billable = await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'run-fail' and metric = any($1)`, [Object.values(BILLABLE_UNIT_METRICS)]);
    expect(billable.rows[0]!.n).toBe(0);
    expect(await pageRow("vm-fail")).toEqual({ page_count: 3, page_count_source: "assumed" });
  }, 60_000);
});
