import { createHash } from "node:crypto";
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
import { assertPopplerAcceptsPdf, countPdfPages, MAX_MEASURED_PDF_PAGES, PDF_STRUCTURE_REJECTED, PDF_WALKED_PAGES_SLOT, parsePdfPageCount, PDF_PAGE_COUNT_LIMITS, PdfPageCountError, processedPdfPages, reconcileProcessedPdfPages, recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { classifyIngestFailure } from "@docslurp/shared";
import { HungWorkError } from "../lib/hung-work.js";
import { CommandExitError, CommandRunner, pdfPageRangeArgs } from "../tools/runner.js";
import { cyclicTreePdf, deepTreePdf, encryptedPdf, flatTreePdf, memoryBombPdf, zeroPagePdf } from "../test/page-tree-pdf.js";
import { dopplerBinDir } from "../tools/doppler.js";
import { mkdir, readdir } from "node:fs/promises";
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
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'L');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('run1', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 4, 4),
             ('run2', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256) values
      ('local', 'o1', 'u1', 'w1', 'run1', 'a.pdf', 'application/pdf', 'raw/a', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64)),
      ('vm', 'o1', 'u1', 'w1', 'run1', 'b.pdf', 'application/pdf', 'raw/b', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64)),
      ('never', 'o1', 'u1', 'w1', 'run1', 'c.pdf', 'application/pdf', 'raw/c', 'completed', 5, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64)),
      ('big', 'o2', 'u1', 'w2', 'run2', 'd.pdf', 'application/pdf', 'raw/d', 'processing', 1, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));
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
/** A runner whose pdfpagecount reports `pages` (0: the tool refuses the file as malformed, exit 4). */
const runner = (pages: number, popplerExit = 0) => ({
  pdfPageCount: vi.fn(async (source: string) => ({ binary: "prlimit", args: [source], available: true })),
  // Poppler's acceptance check after the walk (pdftotext on page 1): exit 0 accepts, 99 sees no pages.
  pdfPopplerAcceptance: vi.fn(async (source: string) => ({ binary: "pdftotext", args: [source], available: true })),
  run: vi.fn(async (plan: { binary: string }) => {
    if (plan.binary === "pdftotext") {
      if (popplerExit === 0) return { stdout: "", stderr: "" };
      throw new CommandExitError(`pdftotext (${popplerExit}): Command Line Error: Wrong page range given`, popplerExit);
    }
    if (pages >= 1) return { stdout: `${pages}\n`, stderr: "" };
    throw new CommandExitError("prlimit (4): pdfpagecount: malformed page tree: no pages", 4);
  }),
});
const pageRow = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = '${id}'`)).rows[0];

describe("countPdfPages: one Doppler pdfpagecount run, every exit code mapped", () => {
  const stub = (result: { stdout?: string; exit?: number | null; error?: Error }, available = true) => ({
    pdfPageCount: vi.fn(async () => ({ binary: "prlimit", args: [], available })),
    run: vi.fn(async () => {
      if (result.error) throw result.error;
      if (result.exit !== undefined) throw new CommandExitError(`prlimit (${result.exit}): pdfpagecount: fixed message`, result.exit);
      return { stdout: result.stdout ?? "", stderr: "" };
    }),
  });

  it("reads exactly one integer and a newline", async () => {
    expect(await countPdfPages(stub({ stdout: "7\n" }), "/x.pdf")).toBe(7);
    for (const stdout of ["7", "7\n\n", " 7\n", "07\n", "0\n", "-3\n", "7\r\n", "7\n8\n", "abc\n", "", `${MAX_MEASURED_PDF_PAGES + 1}\n`, "1e3\n"]) {
      expect(parsePdfPageCount(stdout), JSON.stringify(stdout)).toBeNull();
      await expect(countPdfPages(stub({ stdout }), "/x.pdf")).rejects.toMatchObject({ outcome: "unavailable", name: "PdfPageCountUnavailableError" });
    }
  });

  it("maps every exit code to a distinct outcome: refusals fail the document, a broken tool retries", async () => {
    const cases: Array<[number | null, string]> = [[1, "open-failed"], [2, "encrypted"], [3, "limit"], [4, "malformed"], [99, "unavailable"], [134, "killed"], [139, "killed"], [5, "killed"], [null, "killed"]];
    for (const [exit, outcome] of cases) {
      const error = await countPdfPages(stub({ exit }), "/x.pdf").catch((caught: unknown) => caught);
      expect(error, `exit ${exit}`).toBeInstanceOf(PdfPageCountError);
      expect((error as PdfPageCountError).outcome).toBe(outcome);
      // Refused outcomes are the document's; a usage error or a missing tool is the platform's and retries.
      expect(isDocumentLevelFailure(error)).toBe(outcome !== "unavailable");
      // The tool's stderr never reaches the message.
      expect((error as Error).message).not.toContain("fixed message");
    }
    const timeout = await countPdfPages(stub({ error: new HungWorkError("command-timeout", "prlimit exceeded its 60 s wall-clock budget") }), "/x.pdf").catch((caught: unknown) => caught);
    expect(timeout).toMatchObject({ outcome: "killed" });
    await expect(countPdfPages(stub({ stdout: "3\n" }, false), "/x.pdf")).rejects.toMatchObject({ outcome: "unavailable" });
    // Other errors (a teardown, an abort) are not reinterpreted.
    const teardown = Object.assign(new Error("teardown"), { name: "CommandTeardownError" });
    await expect(countPdfPages(stub({ error: teardown }), "/x.pdf")).rejects.toBe(teardown);
  });

  it("fails closed when Doppler's pdfpagecount is not installed: no count, no other tool, a retried platform error", async () => {
    const bin = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "no-doppler-"));
    vi.stubEnv("DOCSLURP_DOPPLER_BIN_DIR", bin);
    try {
      const runner = new CommandRunner();
      expect((await runner.pdfPageCount("/tmp/in.pdf", PDF_PAGE_COUNT_LIMITS)).available).toBe(false);
      const run = vi.spyOn(runner, "run");
      const error = await countPdfPages(runner, "/tmp/in.pdf").catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "PdfPageCountUnavailableError", outcome: "unavailable" });
      expect(isDocumentLevelFailure(error)).toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs the tool under prlimit with explicit page, depth and memory budgets, a CPU cap and a wall clock", async () => {
    const plan = await new CommandRunner().pdfPageCount("/tmp/in.pdf", PDF_PAGE_COUNT_LIMITS);
    const tool = `${dopplerBinDir()}/pdfpagecount`;
    expect(plan.binary).toBe("prlimit");
    expect(plan.args).toEqual([`--as=${768 * 1024 * 1024}`, "--cpu=30", "--", tool, "-max-pages", "100000", "-max-depth", "64", "-max-memory", "512", "--", "/tmp/in.pdf"]);
    expect(plan.timeoutMs).toBe(60_000);
    expect(PDF_PAGE_COUNT_LIMITS.addressSpaceMiB).toBeGreaterThan(PDF_PAGE_COUNT_LIMITS.toolMemoryMiB);
  });
});

describe("page-range utilities stop at the billed count", () => {
  it("never plans an open or zero range", async () => {
    expect(pdfPageRangeArgs(1, 3)).toEqual(["-f", "1", "-l", "3"]);
    for (const [first, last] of [[1, 0], [0, 3], [2, 1], [1, Number.NaN], [1, 2.5], [1, -1]]) expect(() => pdfPageRangeArgs(first!, last!)).toThrow(/invalid PDF page range/);
    const runner = new CommandRunner();
    const plans = await Promise.all([
      runner.extractText("/s.pdf", 3), runner.extractText("/s.pdf", 3, true), runner.extractHtml("/s.pdf", 3), runner.extractImages("/s.pdf", "/o/p", 3),
      runner.splitPages("/s.pdf", "/o/p-%d.pdf", 3), runner.renderPageImages("/s.pdf", "/o/p", 3), runner.listImages("/s.pdf", 3),
      runner.pageText("/s.pdf", 3), runner.dopplerMarkdown("/s.pdf", 3), runner.listPdfImages("/s.pdf", 1, 3), runner.pdfPageSizes("/s.pdf", 1, 3),
      runner.renderPdfPageRange("/s.pdf", "/o/p", 1, 3), runner.splitPdfPageRange("/s.pdf", "/o/p-%d.pdf", 1, 3), runner.pdfWordBoxes("/s.pdf", 1, 3, "/o/w.xhtml"),
    ]);
    for (const plan of plans) {
      const f = plan.args.indexOf("-f");
      expect(plan.args.slice(f, f + 4), `${plan.binary} ${plan.args.join(" ")}`).toEqual(["-f", "1", "-l", "3"]);
      // The range comes before the file, and the file after "--".
      expect(plan.args.indexOf("/s.pdf")).toBeGreaterThan(plan.args.indexOf("--"));
      expect(plan.args.indexOf("--")).toBeGreaterThan(f);
    }
    for (const call of [() => runner.extractText("/s.pdf", 0), () => runner.renderPageImages("/s.pdf", "/o/p", 0), () => runner.pageText("/s.pdf", 0), () => runner.listImages("/s.pdf", 0)]) {
      await expect(call()).rejects.toThrow(/invalid PDF page range/);
    }
  });
});

// The real tool, as local mode runs it (prlimit + Doppler pdfpagecount). Runs where Doppler's utilities are installed (the
// worker images, the CI "Doppler page count" job); elsewhere it skips.
const dopplerBin = dopplerBinDir();
const realTool = spawnSync(`${dopplerBin}/pdfpagecount`, ["-v"]).status === 0 && spawnSync("prlimit", ["--version"]).status === 0;

// The CI "Doppler page count" job sets DOCSLURP_REQUIRE_DOPPLER_TOOLS=1: there these tests must run, never skip.
it.runIf(process.env.DOCSLURP_REQUIRE_DOPPLER_TOOLS === "1")("has Doppler's pdfpagecount and prlimit where they are required", () => {
  expect(realTool).toBe(true);
});

describe.skipIf(!realTool)("pdfpagecount on hostile page trees (real tool)", () => {
  const tool = new CommandRunner();
  const file = async (name: string, bytes: Buffer) => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "pdfpagecount-"));
    const target = path.join(dir, name);
    await writeFile(target, bytes);
    return target;
  };
  const count = async (bytes: Buffer, limits = PDF_PAGE_COUNT_LIMITS) => await countPdfPages(tool, await file("in.pdf", bytes), undefined, limits);
  const outcome = async (bytes: Buffer, limits = PDF_PAGE_COUNT_LIMITS) => await count(bytes, limits).then(() => null, (error: PdfPageCountError) => error.outcome);

  it.each([
    ["a forged Title with a raw newline", flatTreePdf(5, { title: "Report\nPages: 1" })],
    ["a forged Title with U+2028", flatTreePdf(5, { title: "Report Pages: 1" })],
    ["XMP claiming 1 page", flatTreePdf(5, { xmpPages: 1 })],
  ])("counts the 5 pages of the tree despite %s", async (_name, bytes) => {
    expect(await count(bytes)).toBe(5);
  });

  it("counts the kids, never /Count: /Count 1 over 50 kids is 50, /Count 1000 over 3 kids is 3", async () => {
    expect(await count(flatTreePdf(50, { claimedCount: 1 }))).toBe(50);
    expect(await count(flatTreePdf(3, { claimedCount: 1000 }))).toBe(3);
  });

  it("refuses a cycle, nesting past the depth limit and a tree with no pages", async () => {
    expect(await outcome(cyclicTreePdf())).toBe("malformed");
    expect(await outcome(deepTreePdf(PDF_PAGE_COUNT_LIMITS.maxDepth + 16))).toBe("limit");
    expect(await count(deepTreePdf(10))).toBe(1);
    expect(await outcome(zeroPagePdf())).toBe("malformed");
  });

  it("counts an encrypted PDF with an empty user password; refuses one that needs a password or an unknown handler", async () => {
    expect(await count(await encryptedPdf(""))).toBe(3);
    expect(await outcome(await encryptedPdf("letmein"))).toBe("encrypted");
    expect(await outcome(await encryptedPdf("", "AcmeSecure"))).toBe("encrypted");
  });

  it("refuses a truncated file and a file that is not a PDF", async () => {
    expect(await outcome(flatTreePdf(5).subarray(0, 40))).toBe("open-failed");
    expect(await outcome(Buffer.from("not a pdf at all"))).toBe("open-failed");
  });

  it("stops a memory bomb at the external limit when the tool's own limit is off", async () => {
    const bomb = memoryBombPdf(4_000_000);
    const unbounded = { ...PDF_PAGE_COUNT_LIMITS, maxPages: 10_000_000, toolMemoryMiB: 0 };
    // Only prlimit's address-space cap stands between the walk and the bomb, and it stops it.
    expect(await outcome(bomb, { ...unbounded, addressSpaceMiB: 96 })).toMatch(/^(limit|killed)$/);
    // The default budgets refuse it before memory matters (kid entries are capped at twice the page limit).
    expect(await outcome(bomb)).toBe("limit");
  }, 120_000);
});

describe.skipIf(!realTool)("walked vs extracted with the real tools (owner decisions 2026-11-05)", () => {
  it("/Count 1 over 50 kids: the walk counts 50, extraction reads 1 page, and the file bills 1 with a partial-extraction flag", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "partial-"));
    const source = path.join(dir, "in.pdf");
    await writeFile(source, flatTreePdf(50, { claimedCount: 1 }));
    const runner = new CommandRunner();
    expect(await countPdfPages(runner, source)).toBe(50);
    await assertPopplerAcceptsPdf(runner, source); // Poppler opens it (it sees one page)
    const text = (await runner.run({ ...(await runner.extractText(source, 50, true)), binary: `${dopplerBin}/pdftotext` })).stdout;
    const processed = processedPdfPages(text, "poppler-text");
    expect(processed).toBe(1);
    await db.exec(`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-p', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 1, 50);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('partial', 'o1', 'u1', 'w1', 'run-p', 'p.pdf', 'application/pdf', 'raw/p', 'processing', 50, 'counted', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
    const { state, document } = await stateFor("run-p", "partial");
    expect(await reconcileProcessedPdfPages(state, document, processed)).toEqual({ measured: 50, processed: 1, mismatch: "processed-below-measured" });
    expect(await pageRow("partial")).toEqual({ page_count: 1, page_count_source: "counted" });
  }, 120_000);

  it("a claimed /Count beyond the file's objects: the walk counts the real pages, Poppler refuses the tree: structure-rejected", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "rejected-"));
    const source = path.join(dir, "in.pdf");
    await writeFile(source, flatTreePdf(3, { claimedCount: 1000 }));
    const runner = new CommandRunner();
    expect(await countPdfPages(runner, source)).toBe(3);
    await expect(assertPopplerAcceptsPdf(runner, source)).rejects.toMatchObject({ outcome: "structure-rejected" });
  }, 120_000);
});

describe.skipIf(!realTool)("an inflated /Count: no utility processes more than the walked count (real tools)", () => {
  it("pdftoppm renders /Count's 8 pages without a range; every planned utility stops at the walked 3", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "inflated-count-"));
    const source = path.join(dir, "in.pdf");
    await writeFile(source, flatTreePdf(3, { claimedCount: 8 }));
    const runner = new CommandRunner();
    const pages = await countPdfPages(runner, source);
    expect(pages).toBe(3);
    // The hazard: with no -l, pdftoppm renders up to the claimed /Count.
    const open = path.join(dir, "open");
    await mkdir(open);
    spawnSync(`${dopplerBin}/pdftoppm`, ["-r", "10", "-png", source, path.join(open, "p")]);
    expect((await readdir(open)).length).toBe(8);
    // Every page-range plan, run for real with the billed count, stops at it.
    const out = async (name: string) => { const target = path.join(dir, name); await mkdir(target); return target; };
    const tool = (name: string) => `${dopplerBin}/${name}`;
    const rendered = await out("render");
    await runner.run({ ...(await runner.renderPageImages(source, path.join(rendered, "p"), pages)), binary: tool("pdftoppm") });
    expect((await readdir(rendered)).length).toBe(3);
    const ranged = await out("ranged");
    await runner.run({ ...(await runner.renderPdfPageRange(source, path.join(ranged, "p"), 1, pages, 10, 200)), binary: tool("pdftoppm") });
    expect((await readdir(ranged)).length).toBe(3);
    const split = await out("split");
    await runner.run({ ...(await runner.splitPages(source, path.join(split, "p-%d.pdf"), pages)), binary: tool("pdfseparate") });
    expect((await readdir(split)).length).toBe(3);
    expect(processedPdfPages((await runner.run({ ...(await runner.extractText(source, pages, true)), binary: tool("pdftotext") })).stdout, "poppler-text")).toBe(3);
    expect(processedPdfPages((await runner.run({ ...(await runner.pageText(source, pages)), binary: tool("pdftotext") })).stdout, "poppler-text")).toBe(3);
    const sizes = (await runner.run({ ...(await runner.pdfPageSizes(source, 1, pages)), binary: tool("pdfinfo") })).stdout;
    expect(sizes.match(/^Page +\d+ size:/gm)?.length).toBe(3);
  }, 120_000);
});

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
    expect(host.pdfPageCount).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
  }, 60_000);

  it("local mode: a PDF whose tree walks but which Poppler refuses (it sees no pages) fails as structure-rejected, nothing persisted", async () => {
    await db.exec(`update documents set page_count = 3, page_count_source = 'assumed' where id = 'local'`);
    const { state, document } = await stateFor("run1", "local");
    const error = await recordMeasuredPdfPageCount({ state, document, runner: runner(9, 99), sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: "structure-rejected" });
    expect((error as Error).message).toContain(PDF_STRUCTURE_REJECTED);
    expect(isDocumentLevelFailure(error)).toBe(true);
    expect(classifyIngestFailure((error as Error).message)).toMatchObject({ reason: "pdf-structure-rejected", retryable: false });
    expect(await pageRow("local")).toEqual({ page_count: 3, page_count_source: "assumed" });
    // Another exit of the check is left to extraction (it reports its own failure); the count stands.
    expect(await recordMeasuredPdfPageCount({ state, document, runner: runner(7, 1), sourcePath: async () => "/tmp/a.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .toMatchObject({ pages: 7 });
    await db.exec(`update documents set page_count = 7, page_count_source = 'counted' where id = 'local'`);
  }, 60_000);

  it("vm mode: the VM's pdfpagecount outcome becomes the same refusal or retry as local mode, its cost still recorded", async () => {
    for (const [outcome, documentLevel] of [["encrypted", true], ["malformed", true], ["limit", true], ["killed", true], ["structure-rejected", true], ["unavailable", false]] as const) {
      const usage = { provider: "modal", model: "doppler-document-vm", metric: "sandbox_compute", amount: 1, unit: "cent", costCents: 1 };
      const pageCount = vi.fn(async () => { throw Object.assign(new Error(`Document VM page count refused: ${outcome}`), { usage, pageCountOutcome: outcome }); });
      registerExtractorPlugin({ apiVersion: 1, name: "vm", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1, pageCount } as unknown as SandboxedPdfExtractorProvider });
      await db.exec(`update documents set page_count = 3, page_count_source = 'assumed' where id = 'vm'`);
      const { state, document } = await stateFor("run1", "vm");
      const error = await recordMeasuredPdfPageCount({ state, document, runner: runner(9), sourcePath: async () => "/tmp/b.pdf", env: { DOCSLURP_PDF_MODE: "vm" } }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ outcome });
      expect(isDocumentLevelFailure(error)).toBe(documentLevel);
      expect(state.usageLedger.snapshot().some((event) => event.model === "doppler-document-vm")).toBe(true);
      resetExtractorPluginsForTest();
    }
    // An unknown outcome is not trusted as one: the original error propagates.
    const odd = Object.assign(new Error("odd"), { pageCountOutcome: "fine-actually" });
    registerExtractorPlugin({ apiVersion: 1, name: "vm", sandboxedPdf: { id: "test-vm", maxSourceBytes: 1e9, assertConfigured() {}, run: vi.fn(), timeoutMs: () => 1, pageCount: async () => { throw odd; } } as unknown as SandboxedPdfExtractorProvider });
    const { state, document } = await stateFor("run1", "vm");
    await expect(recordMeasuredPdfPageCount({ state, document, runner: runner(9), sourcePath: async () => "/tmp/b.pdf", env: { DOCSLURP_PDF_MODE: "vm" } })).rejects.toBe(odd);
    // Leave the row as the earlier vm-mode test measured it; later tests bill it.
    await db.exec(`update documents set page_count = 12, page_count_source = 'counted' where id = 'vm'`);
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
      .rejects.toMatchObject({ outcome: "malformed" });
    await db.exec(`update documents set page_count = 7, page_count_source = 'counted' where id = 'local'`);
  }, 60_000);

  it("pauses the run when the measured pages above the estimate no longer fit the balance", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const { state, document } = await stateFor("run2", "big");
    // Measuring only records the count; authorization is its own step.
    expect(await recordMeasuredPdfPageCount({ state, document, runner: runner(5000), sourcePath: async () => "/tmp/d.pdf", env: { DOCSLURP_PDF_MODE: "local" } }))
      .toMatchObject({ pages: 5000 });
    await expect(authorizeMeasuredPages(state, document)).rejects.toMatchObject({ name: "RunPolicyError" });
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run2'`);
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
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-fail', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 3);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('vm-fail', 'o1', 'u1', 'w1', 'run-fail', 'e.pdf', 'application/pdf', 'raw/e', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
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
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-retry', 'o2', 'u1', 'w2', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 3);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('retry', 'o2', 'u1', 'w2', 'run-retry', 'r.pdf', 'application/pdf', 'raw/r', 'processing', 3, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
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
    // Measured once, on attempt 1 (one pdfpagecount run); the retry measures nothing.
    const probes = host.pdfPageCount.mock.calls.length;
    expect(probes).toBe(1);
    expect(await recordMeasuredPdfPageCount({ state: retry.state, document: retry.document, runner: host, sourcePath: async () => "/tmp/r.pdf", env: { DOCSLURP_PDF_MODE: "local" } })).toBeNull();
    expect(host.pdfPageCount.mock.calls.length).toBe(probes);
    await expect(authorizeMeasuredPages(retry.state, retry.document)).rejects.toMatchObject({ name: "RunPolicyError" });
    failing.mockRestore();
    const { rows } = await db.query<{ control_state: string | null }>(`select control_state from project_runs where id = 'run-retry'`);
    expect(rows[0]!.control_state).toBe("paused");
    const billable = await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'run-retry' and metric = any($1)`, [Object.values(BILLABLE_UNIT_METRICS)]);
    expect(billable.rows[0]!.n).toBe(0);
  }, 60_000);

  it("a real upload bills its measured pages: intake's assumed PDF and counted text through format-detect, then the page fee", async () => {
    vi.stubEnv("DOCSLURP_PDF_MODE", "local");
    const textFacts = { declaredMimeType: "text/plain", sniffedMimeType: null, mimeType: "text/plain", format: "plain-text", container: null, encoding: "utf-8", mismatch: "none" };
    // Quarantine scanned the staged bytes: the decision binds parsers to them (PR #339 R8-L1).
    const STAGED_SHA = createHash("sha256").update("%PDF-1.7\n").digest("hex");
    // As run creation writes them: the PDF's size estimate is assumed, the small text file was counted from its bytes.
    await db.exec(`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-e2e', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 2, 4);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('e2e-pdf', 'o1', 'u1', 'w1', 'run-e2e', 'f.pdf', 'application/pdf', 'raw/f', 'processing', 2, 'assumed', '${JSON.stringify(pdfFacts)}', 1, '${STAGED_SHA}'),
               ('e2e-txt', 'o1', 'u1', 'w1', 'run-e2e', 'g.txt', 'text/plain', 'raw/g', 'processing', 2, 'counted', '${JSON.stringify(textFacts)}', 1, '${STAGED_SHA}');`);
    const storage = {
      putJson: vi.fn(async () => undefined), uri: (key: string) => `s3://b/${key}`,
      // As the real store does: a private docslurp-* directory per download, which format-detect removes afterwards. Read
      // through hash-bound staging (sandbox/source-integrity.ts stageSourceFile, council R7-L2).
      downloadToTempFile: vi.fn(async () => {
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
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-off', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'format-detect', '${pipeline}', 1, 2);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('off-pdf', 'o1', 'u1', 'w1', 'run-off', 'h.pdf', 'application/pdf', 'raw/h', 'processing', 2, 'assumed', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
    const storage = { putJson: vi.fn(async () => undefined), uri: (key: string) => `s3://b/${key}`, downloadSourceToTempFile: vi.fn(), downloadToTempFile: vi.fn(), getBytes: vi.fn() } as unknown as ArtifactStore;
    const host = runner(2);
    const state = WorkflowState.create(await store.loadRun("run-off"), [(await store.loadDocument("off-pdf"))!]);
    state.store = store;
    await new FormatDetectStage(storage, host).run(state);
    expect(state.documentStage("off-pdf", "format-detect")?.status).toBe("failed");
    expect(host.pdfPageCount).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect((storage as unknown as { downloadSourceToTempFile: ReturnType<typeof vi.fn> }).downloadSourceToTempFile).not.toHaveBeenCalled();
    expect((storage as unknown as { downloadToTempFile: ReturnType<typeof vi.fn> }).downloadToTempFile).not.toHaveBeenCalled();
  }, 60_000);

  it("bills what was processed: raised when extraction processed more than the tree, lowered (and flagged) when fewer", async () => {
    await db.exec(`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-x', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 13);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('x-more', 'o1', 'u1', 'w1', 'run-x', 'm.pdf', 'application/pdf', 'raw/m', 'processing', 3, 'counted', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64)),
               ('x-less', 'o1', 'u1', 'w1', 'run-x', 'l.pdf', 'application/pdf', 'raw/l', 'processing', 10, 'counted', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
    expect(processedPdfPages("a\fb\fc\fd\fe\f", "poppler-text")).toBe(5);
    // Blank pages count, trailing ones included (pdftotext ends every page with a form feed).
    expect(processedPdfPages("text one\f\ftext three\f\f", "poppler-text")).toBe(4);
    expect(processedPdfPages("a\f\f\f\n", "poppler-text")).toBe(3);
    expect(processedPdfPages("a\fb", "poppler-text")).toBe(2);
    // Separator style (doppler-md, vm-pdf, native-pdf): N pages are N-1 form feeds, so a trailing one is a blank last page.
    expect(processedPdfPages("a\fb", "doppler-md")).toBe(2);
    expect(processedPdfPages("a\fb\f", "vm-pdf")).toBe(3);
    const more = await stateFor("run-x", "x-more");
    expect(await reconcileProcessedPdfPages(more.state, more.document, processedPdfPages("a\fb\fc\fd\fe", "doppler-md"))).toEqual({ measured: 3, processed: 5, mismatch: "processed-above-measured" });
    expect(await pageRow("x-more")).toEqual({ page_count: 5, page_count_source: "counted" });
    const less = await stateFor("run-x", "x-less");
    expect(await reconcileProcessedPdfPages(less.state, less.document, 1)).toEqual({ measured: 10, processed: 1, mismatch: "processed-below-measured" });
    // Owner decision 2026-11-05: pages not extracted are not billed; the walked count is kept for the report's N of M.
    expect(await pageRow("x-less")).toEqual({ page_count: 1, page_count_source: "counted" });
    expect(less.document.pageCount).toBe(1);
    expect(less.state.artifactLedger.readDocument("x-less", PDF_WALKED_PAGES_SLOT)).toBe("10");
    // A retried stage (the row already lowered) reports the same 1 of 10 and changes nothing.
    const retry = WorkflowState.create(await store.loadRun("run-x"), [(await store.loadDocument("x-less"))!]);
    retry.store = store;
    retry.artifactLedger.recordDocument("x-less", PDF_WALKED_PAGES_SLOT, "10");
    expect(await reconcileProcessedPdfPages(retry, retry.documents[0]!, 1)).toEqual({ measured: 10, processed: 1, mismatch: "processed-below-measured" });
    expect(await pageRow("x-less")).toEqual({ page_count: 1, page_count_source: "counted" });
  }, 60_000);

  it("a blank last page counts N under both form-feed conventions, with no false partial-extraction flag (council E #4)", async () => {
    await db.exec(`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('run-blank', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'extract-markdown', '${pipeline}', 2, 6);
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_facts, parse_source_scan_version, parse_source_sha256)
        values ('blank-term', 'o1', 'u1', 'w1', 'run-blank', 't.pdf', 'application/pdf', 'raw/t', 'processing', 3, 'counted', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64)),
               ('blank-sep', 'o1', 'u1', 'w1', 'run-blank', 's.pdf', 'application/pdf', 'raw/s', 'processing', 3, 'counted', '${JSON.stringify(pdfFacts)}', 1, repeat('0', 64));`);
    // Three pages, the third blank: pdftotext terminates each page; Doppler, vm-pdf and native-pdf separate them.
    const outputs: Array<[string, string, string]> = [["blank-term", "poppler-text", "one\ftwo\f\f"], ["blank-sep", "doppler-md", "one\ftwo\f"]];
    for (const [id, extractor, markdown] of outputs) {
      expect(processedPdfPages(markdown, extractor), extractor).toBe(3);
      const { state, document } = await stateFor("run-blank", id);
      expect(await reconcileProcessedPdfPages(state, document, processedPdfPages(markdown, extractor))).toEqual({ measured: 3, processed: 3, mismatch: "none" });
      expect(state.artifactLedger.readDocument(id, PDF_WALKED_PAGES_SLOT)).toBeUndefined();
      expect(await pageRow(id)).toEqual({ page_count: 3, page_count_source: "counted" });
    }
    // The old single rule read Doppler's blank last page as a terminator: 2 of 3, a false partial extraction.
    expect("one\ftwo\f".replace(/\f[ \t\r\n]*$/, "").split("\f").length).toBe(2);
  }, 60_000);
});
