import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { recordPageBaseFee } from "../db/page-base-fee.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedPdfExtractorProvider } from "../extractors/plugins.js";
import { parsePdfInfoPages, recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import { SpendCheckUnavailableError } from "../db/spend-check.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { FormatDetectStage } from "../stages/format-detect.js";
import type { ArtifactStore } from "../tools/storage.js";
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

describe("parsePdfInfoPages: a PDF's metadata cannot forge its page count", () => {
  it("reads the one Pages line", () => {
    expect(parsePdfInfoPages("Title:          Report\nProducer:       x\nPages:          50\nEncrypted:      no\n")).toBe(50);
    expect(parsePdfInfoPages("Pages: 7\r\n")).toBe(7);
  });
  it.each([
    ["a Title with a raw newline", "Title:          Report\nPages: 1\nProducer:       x\nPages:          50\n"],
    ["a Title after Pages", "Pages:          50\nTitle: x\nPages: 1\n"],
    ["no Pages line", "Title: Report\n"],
    ["an out-of-range count", "Pages: 0\n"],
    ["a huge count", "Pages: 99999999999\n"],
  ])("refuses %s", (_name, stdout) => {
    expect(parsePdfInfoPages(stdout)).toBeNull();
  });
  it("does not treat U+2028 or U+2029 in a Title as a line break", () => {
    expect(parsePdfInfoPages("Title:          Report\u2028Pages: 1\nPages:          50\n")).toBe(50);
    expect(parsePdfInfoPages("Title:          Report\u2029Pages: 1\nPages:          50\n")).toBe(50);
    // The old multiline regex took the first match, so this read 1.
    expect("Title: Report\u2028Pages: 1\nPages: 50\n".match(/^Pages:\s+(\d+)\s*$/m)?.[1]).toBe("1");
  });
});

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
    // Measuring only records the count; authorization is its own step.
    expect(await recordMeasuredPdfPageCount({ state, document, runner: runner("Pages: 5000\n"), sourcePath: async () => "/tmp/d.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .toMatchObject({ pages: 5000 });
    await expect(authorizeMeasuredPages(state, document)).rejects.toMatchObject({ name: "RunPolicyError" });
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

  it("a retry after a failed balance check re-authorizes the persisted measurement from durable state, and charges nothing", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-retry', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 3);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
        values ('retry', 'o2', 'u1', 'w2', 'run-retry', 'r.pdf', 'application/pdf', 'raw/r', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}');`);
    // Attempt 1: the count is measured and persisted, then the balance query fails (a dropped connection).
    const first = await stateFor("run-retry", "retry");
    const host = runner("Pages: 5000\n");
    await recordMeasuredPdfPageCount({ state: first.state, document: first.document, runner: host, sourcePath: async () => "/tmp/r.pdf", env: { DOCSLURP_PDF_MODE: "local" } });
    const real = store.enforceSpendForCharge.bind(store);
    const failing = vi.spyOn(store, "enforceSpendForCharge").mockRejectedValueOnce(new SpendCheckUnavailableError("connection terminated"));
    await expect(authorizeMeasuredPages(first.state, first.document)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
    failing.mockImplementation(real);
    expect(await pageRow("retry")).toEqual({ page_count: 5000, page_count_source: "counted" });
    // Attempt 2 (a retried activity): it loads the persisted, counted measurement and skips measuring, but still authorizes.
    const retry = await stateFor("run-retry", "retry");
    expect(retry.document).toMatchObject({ pageCount: 5000, pageCountSource: "counted", intakePageCount: 3 });
    expect(await recordMeasuredPdfPageCount({ state: retry.state, document: retry.document, runner: host, sourcePath: async () => "/tmp/r.pdf", env: { DOCSLURP_PDF_MODE: "local" } })).toBeNull();
    expect(host.run).toHaveBeenCalledTimes(1);
    await expect(authorizeMeasuredPages(retry.state, retry.document)).rejects.toMatchObject({ name: "RunPolicyError" });
    failing.mockRestore();
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from workspace_runs where id = 'run-retry'`);
    expect(rows[0]!.control_state).toBe("paused");
    const billable = await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'run-retry' and metric = any($1)`, [Object.values(BILLABLE_UNIT_METRICS)]);
    expect(billable.rows[0]!.n).toBe(0);
  }, 60_000);

  it("a real upload bills its measured pages: intake's assumed PDF and counted text through format-detect, then the page fee", async () => {
    vi.stubEnv("DOCSLURP_PDF_MODE", "local");
    const textFacts = { declaredMimeType: "text/plain", sniffedMimeType: null, mimeType: "text/plain", format: "plain-text", container: null, encoding: "utf-8", mismatch: "none" };
    // As run creation writes them: the PDF's size estimate is assumed, the small text file was counted from its bytes.
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-e2e', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 2, 4);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
        values ('e2e-pdf', 'o1', 'u1', 'w1', 'run-e2e', 'f.pdf', 'application/pdf', 'raw/f', 'processing', 2, 'assumed', '${JSON.stringify(pdfFacts)}'),
               ('e2e-txt', 'o1', 'u1', 'w1', 'run-e2e', 'g.txt', 'text/plain', 'raw/g', 'processing', 2, 'counted', '${JSON.stringify(textFacts)}');`);
    const storage = {
      putJson: vi.fn(async () => undefined), uri: (key: string) => `s3://b/${key}`,
      // As the real store does: a private docslurp-* directory per download, which format-detect removes afterwards.
      downloadSourceToTempFile: vi.fn(async () => {
        const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-"));
        await writeFile(path.join(dir, "f.pdf"), "%PDF-1.7\n");
        return path.join(dir, "f.pdf");
      }),
      getBytes: vi.fn(),
    } as unknown as ArtifactStore;
    const state = WorkflowState.create(await store.loadRun("run-e2e"), [(await store.loadDocument("e2e-pdf"))!, (await store.loadDocument("e2e-txt"))!]);
    state.store = store;
    await new FormatDetectStage(storage, runner("Pages: 9\n")).run(state);
    expect(await pageRow("e2e-pdf")).toEqual({ page_count: 9, page_count_source: "counted" });
    expect(await pageRow("e2e-txt")).toEqual({ page_count: 2, page_count_source: "counted" });
    const sql = (store as unknown as { sql: Parameters<typeof recordPageBaseFee>[0] }).sql;
    const billing = WorkflowState.create(await store.loadRun("run-e2e"), [(await store.loadDocument("e2e-pdf"))!, (await store.loadDocument("e2e-txt"))!]);
    expect((await recordPageBaseFee(sql, billing)).fastPages).toBe(9 + 2);
  }, 60_000);

  it("with no PDF mode, a PDF fails at format-detect before any parser or download runs", async () => {
    vi.stubEnv("DOCSLURP_PDF_MODE", "");
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "");
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-off', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 2);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
        values ('off-pdf', 'o1', 'u1', 'w1', 'run-off', 'h.pdf', 'application/pdf', 'raw/h', 'processing', 2, 'assumed', '${JSON.stringify(pdfFacts)}');`);
    const storage = { putJson: vi.fn(async () => undefined), uri: (key: string) => `s3://b/${key}`, downloadSourceToTempFile: vi.fn(), getBytes: vi.fn() } as unknown as ArtifactStore;
    const host = runner("Pages: 2\n");
    const state = WorkflowState.create(await store.loadRun("run-off"), [(await store.loadDocument("off-pdf"))!]);
    state.store = store;
    await new FormatDetectStage(storage, host).run(state);
    expect(state.documentStage("off-pdf", "format-detect")?.status).toBe("failed");
    expect(host.pdfInfo).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect((storage as unknown as { downloadSourceToTempFile: ReturnType<typeof vi.fn> }).downloadSourceToTempFile).not.toHaveBeenCalled();
  }, 60_000);
});
