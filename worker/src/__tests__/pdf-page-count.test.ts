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
import { MAX_MEASURED_PDF_PAGES, pastLastPage, PdfPageCountError, pdfPageTreeCount, processedPdfPages, reconcileProcessedPdfPages, recordMeasuredPdfPageCount, sandboxedPageProbe, type PageProbe } from "../lib/pdf-page-count.js";
import { CommandExitError } from "../tools/runner.js";
import { spawnSync } from "node:child_process";
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
/** A sandboxed page probe over a PDF of `pages` pages: page k exists for k <= pages, else pdftotext's exit 99. */
const runner = (pages: number) => ({
  pdfPageProbe: vi.fn(async (source: string, page: number) => ({ binary: "pdftotext", args: [String(page), source], available: true })),
  run: vi.fn(async (plan: { args: string[] }) => {
    const page = Number(plan.args[0]);
    if (page <= pages) return { stdout: "", stderr: "" };
    throw new CommandExitError(`pdftotext (99): Command Line Error: Wrong page range given: the first page (${page}) can not be after the last page (${pages}).`, 99);
  }),
});
const pageRow = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${id}'`)).rows[0];

describe("pdfPageTreeCount: the page tree as Poppler walks it, never text the author controls", () => {
  const tree = (pages: number) => async (page: number): Promise<PageProbe> => page <= pages ? { exists: true } : { exists: false, lastPage: pages };

  it("finds the last existing page by binary search, and refuses an empty or oversized tree", async () => {
    for (const pages of [1, 2, 7, 1_000, 99_999, MAX_MEASURED_PDF_PAGES]) {
      const asked: number[] = [];
      expect(await pdfPageTreeCount(async (page) => { asked.push(page); return await tree(pages)(page); })).toBe(pages);
      expect(asked.length).toBeLessThanOrEqual(20);
    }
    expect(await pdfPageTreeCount(async () => ({ exists: false, lastPage: 0 }))).toBeNull();
    await expect(pdfPageTreeCount(async () => ({ exists: true }))).rejects.toThrow(/more than/);
  });

  it("refuses answers that disagree with Poppler's own last-page count instead of shortening the count", async () => {
    // A 50-page file whose page 49 (on the search's path) claims to be past the end (lastPage 48): without the check the search
    // would settle on 48; the probes and Poppler's own reports disagree, so the count is refused.
    const asked: number[] = [];
    await expect(pdfPageTreeCount(async (page) => { asked.push(page); return page === 49 ? { exists: false, lastPage: 48 } : await tree(50)(page); }))
      .rejects.toMatchObject({ name: "PdfPageCountError" });
    expect(asked).toContain(49);
  });

  it("reads past-the-end only from Poppler's own line for the probed page; any other failure fails closed", async () => {
    const line = (first: number, last: number) => `Command Line Error: Wrong page range given: the first page (${first}) can not be after the last page (${last}).`;
    expect(pastLastPage(`pdftotext (99): ${line(9, 5)}`, 9)).toBe(5);
    expect(pastLastPage(`/usr/bin/pdftotext (99): Syntax Error (12): x\n${line(9, 5)}`, 9)).toBe(5);
    expect(pastLastPage(`pdftotext (99): ${line(8, 5)}`, 9)).toBeNull();      // another page's message
    expect(pastLastPage(`pdftotext (99): ${line(9, 9)}`, 9)).toBeNull();      // not past the end
    expect(pastLastPage("pdftotext (99): Syntax Error: Internal: page 9 failed", 9)).toBeNull();
    expect(pastLastPage(`pdftotext (99): Syntax Error: font 'x ${line(9, 1)}'`, 9)).toBeNull(); // not a whole line
    // In the sandbox probe: page 7 of a 20-page file errors with 99 and no range line, mid-search.
    const failing = {
      pdfPageProbe: vi.fn(async (source: string, page: number) => ({ binary: "pdftotext", args: [String(page), source], available: true })),
      run: vi.fn(async (plan: { args: string[] }) => {
        const page = Number(plan.args[0]);
        if (page === 7) throw new CommandExitError("pdftotext (99): Syntax Error: Couldn't read page 7", 99);
        if (page <= 20) return { stdout: "", stderr: "" };
        throw new CommandExitError(`pdftotext (99): ${line(page, 20)}`, 99);
      }),
    };
    // The search probes 1, 100001, then halves down, reaching page 7 only if the count is below it, so ask it directly too.
    const probe = sandboxedPageProbe(failing as never, "/tmp/x.pdf");
    await expect(probe(7)).rejects.toMatchObject({ name: "PdfPageCountError" });
    expect(await probe(21)).toEqual({ exists: false, lastPage: 20 });
    expect(await probe(3)).toEqual({ exists: true });
    // A crash or an unreadable file (exit 1) never reads as a count either.
    const broken = { ...failing, run: vi.fn(async () => { throw new CommandExitError("pdftotext (1): Syntax Error: Couldn't find trailer dictionary", 1); }) };
    await expect(pdfPageTreeCount(sandboxedPageProbe(broken as never, "/tmp/x.pdf"))).rejects.toMatchObject({ name: "PdfPageCountError" });
  });

  // A real Poppler pdftotext, as local mode runs it. Skipped on hosts without poppler-utils.
  const pdftotext = spawnSync("pdftotext", ["-v"]).error ? null : "pdftotext";
  const realProbe = (file: string) => async (page: number): Promise<PageProbe> => {
    const result = spawnSync(pdftotext!, ["-f", String(page), "-l", String(page), file, "/dev/null"], { encoding: "utf8" });
    if (result.status === 0) return { exists: true };
    const lastPage = result.status === 99 ? pastLastPage(result.stderr, page) : null;
    if (lastPage === null) throw new PdfPageCountError(`page ${page}: exit ${result.status}`);
    return { exists: false, lastPage };
  };
  it.skipIf(!pdftotext).each([
    ["a Title with a raw newline", { title: "Report\nPages: 1" }],
    ["a Title with U+2028", { title: "Report\u2028Pages: 1" }],
    ["XMP saying one page", { xmpPages: 1 }],
    ["page text saying Page 1 of 1", {}],
  ])("counts the real 5 pages despite %s", async (_name, forged) => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "pdf-tree-"));
    const file = path.join(dir, "forged.pdf");
    await writeFile(file, forgedPdf(5, forged));
    expect(await pdfPageTreeCount(realProbe(file))).toBe(5);
  });

  it.skipIf(!pdftotext)("a truncated PDF is refused (Poppler cannot open it: exit 1), never counted as some number of pages", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "pdf-tree-"));
    const whole = forgedPdf(5, {});
    // Cut before the xref and trailer: Poppler cannot read the file at all.
    const cut = path.join(dir, "cut.pdf");
    await writeFile(cut, whole.subarray(0, whole.indexOf(Buffer.from("xref"))));
    await expect(pdfPageTreeCount(realProbe(cut))).rejects.toMatchObject({ name: "PdfPageCountError" });
    // Cut inside the header: nothing to walk; refused, not counted as some number of pages.
    const stub = path.join(dir, "stub.pdf");
    await writeFile(stub, whole.subarray(0, 40));
    await expect(pdfPageTreeCount(realProbe(stub))).rejects.toMatchObject({ name: "PdfPageCountError" });
  });
});

/** A PDF of `pages` pages, each reading "Page 1 of 1", with an optional forged Info Title and XMP page count. */
function forgedPdf(pages: number, forged: { title?: string; xmpPages?: number }): Buffer {
  const objects: Buffer[] = [];
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index * 2} 0 R`).join(" ");
  const font = 3 + pages * 2;
  const xmp = forged.xmpPages === undefined ? null : `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpTPg="http://ns.adobe.com/xap/1.0/t/pg/"><xmpTPg:NPages>${forged.xmpPages}</xmpTPg:NPages></rdf:Description></rdf:RDF></x:xmpmeta>`;
  objects.push(Buffer.from(`<< /Type /Catalog /Pages 2 0 R${xmp ? ` /Metadata ${font + 2} 0 R` : ""} >>`));
  objects.push(Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`));
  for (let index = 0; index < pages; index += 1) {
    const content = "BT /F1 12 Tf 72 700 Td (Page 1 of 1) Tj ET";
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  }
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const title = forged.title === undefined ? "Report" : forged.title;
  objects.push(Buffer.concat([Buffer.from("<< /Title <FEFF"), Buffer.from(Buffer.from(title, "utf16le").swap16().toString("hex").toUpperCase()), Buffer.from("> >>")]));
  if (xmp) objects.push(Buffer.from(`<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream`));
  const info = font + 1;
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part);
    length += part.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref)]);
}

describe("PDF page counts are measured by the worker, never parsed by the API", () => {
  it("local mode: the page tree walked under the parser sandbox replaces intake's estimate", async () => {
    const { state, document } = await stateFor("run1", "local");
    const local = runner(7);
    const measured = await recordMeasuredPdfPageCount({ state, document, runner: local, sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } });
    expect(measured).toEqual({ pages: 7, method: "local", estimate: 3 });
    expect(await pageRow("local")).toEqual({ page_count: 7, page_count_source: "counted" });
    expect(document).toMatchObject({ pageCount: 7, pageCountSource: "counted" });
  }, 60_000);

  it("vm mode: the provider counts it in a VM, and no host parser runs", async () => {
    const pageCount = vi.fn(async () => ({ pages: 12 }));
    registerExtractorPlugin({ apiVersion: 1, name: "vm", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1, pageCount } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run1", "vm");
    const host = runner(99);
    expect(await recordMeasuredPdfPageCount({ state, document, runner: host, sourcePath: async () => "/tmp/b.pdf", env: { DOCSLURP_PDF_MODE: "vm" } }))
      .toEqual({ pages: 12, method: "vm", estimate: 3 });
    expect(pageCount).toHaveBeenCalledWith({ input: "/tmp/b.pdf" }, undefined);
    expect(host.pdfPageProbe).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  }, 60_000);

  it("vm mode with a provider that cannot count: refused loudly, never measured on the host", async () => {
    registerExtractorPlugin({ apiVersion: 1, name: "old", sandboxedPdf: { id: "old-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1 } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run1", "never");
    const host = runner(5);
    await expect(recordMeasuredPdfPageCount({ state, document, runner: host, sourcePath: async () => "/tmp/c.pdf", env: { DOCSLURP_PDF_MODE: "vm" } }))
      .rejects.toThrow(/VM PDF provider does not count pages/);
    expect(host.run).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses an unreadable PDF (no valid page count) instead of keeping the estimate", async () => {
    await db.exec(`update documents set page_count = 3, page_count_source = 'assumed' where id = 'local'`);
    const { state, document } = await stateFor("run1", "local");
    await expect(recordMeasuredPdfPageCount({ state, document, runner: runner(0), sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .rejects.toThrow(/no valid page count/);
    await db.exec(`update documents set page_count = 7, page_count_source = 'counted' where id = 'local'`);
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "big");
    // Measuring only records the count; authorization is its own step.
    expect(await recordMeasuredPdfPageCount({ state, document, runner: runner(5000), sourcePath: async () => "/tmp/d.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
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
      await recordMeasuredPdfPageCount({ state, document, runner: runner(9), sourcePath: async () => "/tmp/e.pdf", env: { DOCSLURP_PDF_MODE: "vm" } });
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
    const host = runner(5000);
    await recordMeasuredPdfPageCount({ state: first.state, document: first.document, runner: host, sourcePath: async () => "/tmp/r.pdf", env: { DOCSLURP_PDF_MODE: "local" } });
    const real = store.enforceSpendForCharge.bind(store);
    const failing = vi.spyOn(store, "enforceSpendForCharge").mockRejectedValueOnce(new SpendCheckUnavailableError("connection terminated"));
    await expect(authorizeMeasuredPages(first.state, first.document)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
    failing.mockImplementation(real);
    expect(await pageRow("retry")).toEqual({ page_count: 5000, page_count_source: "counted" });
    // Attempt 2 (a retried activity): it loads the persisted, counted measurement and skips measuring, but still authorizes.
    const retry = await stateFor("run-retry", "retry");
    expect(retry.document).toMatchObject({ pageCount: 5000, pageCountSource: "counted", intakePageCount: 3 });
    // Measured once, on attempt 1 (a page-tree walk of a few probes); the retry probes nothing.
    const probes = host.pdfPageProbe.mock.calls.length;
    expect(probes).toBeGreaterThan(1);
    expect(await recordMeasuredPdfPageCount({ state: retry.state, document: retry.document, runner: host, sourcePath: async () => "/tmp/r.pdf", env: { DOCSLURP_PDF_MODE: "local" } })).toBeNull();
    expect(host.pdfPageProbe.mock.calls.length).toBe(probes);
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
    await new FormatDetectStage(storage, runner(9)).run(state);
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
    const host = runner(2);
    const state = WorkflowState.create(await store.loadRun("run-off"), [(await store.loadDocument("off-pdf"))!]);
    state.store = store;
    await new FormatDetectStage(storage, host).run(state);
    expect(state.documentStage("off-pdf", "format-detect")?.status).toBe("failed");
    expect(host.pdfPageProbe).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect((storage as unknown as { downloadSourceToTempFile: ReturnType<typeof vi.fn> }).downloadSourceToTempFile).not.toHaveBeenCalled();
  }, 60_000);

  it("bills and authorizes the larger of the page-tree count and the pages extraction processed, and flags a disagreement", async () => {
    await db.exec(`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-x', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 13);
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts)
        values ('x-more', 'o1', 'u1', 'w1', 'run-x', 'm.pdf', 'application/pdf', 'raw/m', 'processing', 3, 'counted', '${JSON.stringify(pdfFacts)}'),
               ('x-less', 'o1', 'u1', 'w1', 'run-x', 'l.pdf', 'application/pdf', 'raw/l', 'processing', 10, 'counted', '${JSON.stringify(pdfFacts)}');`);
    expect(processedPdfPages("a\fb\fc\fd\fe\f")).toBe(5);
    const more = await stateFor("run-x", "x-more");
    expect(await reconcileProcessedPdfPages(more.state, more.document, processedPdfPages("a\fb\fc\fd\fe"))).toEqual({ measured: 3, processed: 5, mismatch: "processed-above-measured" });
    expect(await pageRow("x-more")).toEqual({ page_count: 5, page_count_source: "counted" });
    const less = await stateFor("run-x", "x-less");
    expect(await reconcileProcessedPdfPages(less.state, less.document, 1)).toEqual({ measured: 10, processed: 1, mismatch: "processed-below-measured" });
    // Never lowered: the larger count stands.
    expect(await pageRow("x-less")).toEqual({ page_count: 10, page_count_source: "counted" });
  }, 60_000);
});
