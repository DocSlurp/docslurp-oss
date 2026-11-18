/**
 * Doppler's math and table encoding facts from the real converter (`pdftomarkdown --page-facts-include mathtables`, with and
 * without `--math`) on small fixtures, through the host's strict reader, the provider-result path and evidence routing.
 *
 * Runs where a Doppler build with the `mathtables` family is installed (DOCSLURP_DOPPLER_BIN_DIR, default
 * /usr/lib/doppler/bin; a local build may need LD_LIBRARY_PATH for its libpoppler); elsewhere it skips.
 */
import { spawnSync } from "node:child_process";
import { openSync, closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { acceptSandboxedPdfResult, sandboxedPdfLayoutFacts, type SandboxedPdfJob } from "../extractors/plugins.js";
import { acceptSandboxedPdfBatchEvent, batchFileJob, type SandboxedPdfBatchJob } from "../extractors/sandboxed-pdf-batch.js";
import { pageEncodingRoute } from "../lib/doppler-encoding-facts.js";
import { parseDopplerPageFacts } from "../lib/doppler-page-facts.js";
import { dopplerBinDir } from "../tools/doppler.js";
import { classifyAdaptivePage } from "../stages/classify-route.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../testdata/pdf-fixtures");
const converter = path.join(dopplerBinDir(), "pdftomarkdown");
const help = spawnSync(converter, ["--help"], { encoding: "utf8" });
const available = `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("mathtables");

const scratch = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "doppler-encodings-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Facts (doppler-page-facts/1 lines) and Markdown of one fixture, as a provider returns them. */
function convert(fixture: string, math: boolean): { facts: string; pages: number; markdown: string } {
  const factsPath = path.join(scratch, `${fixture}.${math ? "math" : "plain"}.jsonl`);
  let markdown = "";
  const fd = openSync(factsPath, "w");
  try {
    const run = spawnSync(converter, ["--stream", "--html", ...(math ? ["--math"] : []), "--page-facts-include", "mathtables", "--page-facts-fd", "3", path.join(FIXTURES, fixture)],
      { stdio: ["ignore", "pipe", "pipe", fd], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    expect(run.status, String(run.stderr)).toBe(0);
    markdown = String(run.stdout);
  } finally {
    closeSync(fd);
  }
  const facts = readFileSync(factsPath, "utf8");
  return { facts, pages: facts.split("\n").filter((line) => line.includes("\"type\":\"page\"")).length, markdown };
}

function routes(fixture: string, math = false) {
  const { facts, pages } = convert(fixture, math);
  const parsed = parseDopplerPageFacts(facts, { pageCount: pages });
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.facts.doc.include).toContain("mathtables");
  // Wherever Doppler wrote a structure family (ActualText counts only, at `full`), the reader keeps it, never drops it.
  for (const line of facts.split("\n").filter((l) => l.includes("\"structure\""))) {
    const raw = JSON.parse(line) as { page?: number; structure?: unknown };
    if (raw.page !== undefined && raw.structure !== undefined) expect(parsed.facts.pages.get(raw.page)?.structure, `page ${raw.page}`).toEqual(raw.structure);
  }
  return { parsed: parsed.facts, routes: [...parsed.facts.pages.values()].map((page) => pageEncodingRoute(page, { mathRead: math })) };
}

describe.skipIf(!available)("Doppler math and table encodings (real converter)", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("names a booktabs table, a matrix that is not a table, text math and a prose page", () => {
    const { routes: pages } = routes("encoding-tables-math.pdf");
    expect(pages.map((page) => page.status)).toEqual(["known", "known", "known", "known"]);
    const [table, growth, matrix, prose] = pages.map((page) => page.status === "known" ? page.route : null);
    expect(table).toMatchObject({ table: "text-layer", tableFlags: ["booktabs"], math: "none" });
    expect(growth?.math).not.toBe("none");
    // Display formulas set in aligned columns: since the released d317bea (DocSlurp/doppler#51) the facts name the
    // whitespace table the default converter writes there (its Markdown is unchanged from 0cf2981); a text-layer route,
    // never a read, and never a math grid. With --math the converter writes the formulas, not a table.
    expect(growth).toMatchObject({ table: "text-layer", tableFlags: ["whitespace"], mathGrid: false });
    expect(matrix).toMatchObject({ table: "none", mathGrid: true });
    expect(matrix?.mathFlags).toContain("math-matrix");
    expect(prose).toMatchObject({ table: "none", math: "none", mathFlags: [], tableFlags: [] });
  });

  it("names ruled, open and whitespace tables in the routing fixtures", () => {
    expect(routes("routing-table-4-rows.pdf").routes[0]).toMatchObject({ status: "known", route: { table: "text-layer", tableFlags: ["rule-grid"] } });
    expect(routes("kreuzberg-tables-invoice.pdf").routes[0]).toMatchObject({ status: "known", route: { table: "text-layer", tableFlags: ["hrule-open"] } });
    expect(routes("routing-table-two-line-header.pdf").routes[0]).toMatchObject({ status: "known", route: { table: "text-layer", tableFlags: ["whitespace"] } });
  });

  it("keeps the words under --math, and the math reader takes the unmapped glyphs", () => {
    const plain = routes("encoding-tables-math.pdf");
    const math = routes("encoding-tables-math.pdf", true);
    // The words describe the PDF, not the conversion: the same with or without the math reader.
    expect([...math.parsed.pages.values()].map((page) => [page.mathBits, page.tableBits])).toEqual([...plain.parsed.pages.values()].map((page) => [page.mathBits, page.tableBits]));
    for (const verdict of math.routes) {
      if (verdict.status !== "known") throw new Error("unknown encodings under --math");
      if (verdict.route.mathFlags.includes("math-font-no-unicode")) expect(verdict.route.math).not.toBe("vision");
    }
  });

  it("routes the fixture's pages through the provider-result path", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const { facts, pages } = convert("encoding-tables-math.pdf", true);
    const job: SandboxedPdfJob = { input: "/in.pdf", output: "/out.md" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", pageFacts: facts }, pages, { glyphs: true });
    const layout = sandboxedPdfLayoutFacts(job)!;
    expect(layout.get(1)?.encodings?.table).toBe("text-layer");
    expect(layout.get(3)?.encodings?.mathGrid).toBe(true);
    const prose = "Customers move between plans each quarter with these probabilities.";
    const off = classifyAdaptivePage(3, prose, { routingV2: true, layout: layout.get(3)! });
    const matrix = classifyAdaptivePage(3, prose, { routingV2: true, layout: layout.get(3)!, encodings: layout.get(3)!.encodings });
    // Encodings only add: the matrix page keeps whatever route its grids gave it, with the math grid as a signal.
    expect(matrix.route).toBe(off.route);
    expect(matrix.signals).toContain("encoding-math-grid");
    // The booktabs page gets a table route from its encodings.
    expect(classifyAdaptivePage(1, "Region Q1 Q2 Q3", { routingV2: true, layout: layout.get(1)!, encodings: layout.get(1)!.encodings }).route).toBe("table-heavy");
  });

  it("keeps the released structure family at `full` (ActualText counts only)", () => {
    const factsPath = path.join(scratch, "structure-full.jsonl");
    const fd = openSync(factsPath, "w");
    try {
      const run = spawnSync(converter, ["--stream", "--html", "--page-facts-level", "full", "--page-facts-fd", "3", path.join(FIXTURES, "encoding-tables-math.pdf")],
        { stdio: ["ignore", "pipe", "pipe", fd], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      expect(run.status, String(run.stderr)).toBe(0);
    } finally {
      closeSync(fd);
    }
    const facts = readFileSync(factsPath, "utf8");
    const parsed = parseDopplerPageFacts(facts, { pageCount: 4 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect([...parsed.facts.pages.values()].map((page) => page.structure)).toEqual(Array(4).fill({ actualText: 0, actualTextTexLike: 0, truncated: false }));
  });

  // DOCSLURP_FIRST_PASS_MATH stays off (first-pass.ts) while the `it.fails` below fails: on the invoice, `--math` moves the
  // header row out of the table as italic text and writes `$12.00` as `\$12.00`, as Doppler did before #51. When a Doppler
  // build passes it, the `it.fails` fails: drop `.fails`, then decide on the gate. The conversions run in an ordinary test
  // first, so a crash, a non-zero exit or a timeout fails there and is never taken for the expected failure.
  const invoice: { plain?: string; math?: string } = {};
  it("converts the invoice with and without --math (both exit 0) and the default keeps `$` in cells", () => {
    invoice.plain = convert("kreuzberg-tables-invoice.pdf", false).markdown;
    invoice.math = convert("kreuzberg-tables-invoice.pdf", true).markdown;
    expect(invoice.plain).toContain("<td>$12.00</td>");
    expect(invoice.plain).toContain("<thead>");
    expect(invoice.math.length).toBeGreaterThan(0);
  });

  it.fails("--math leaves the invoice table as the default writes it: header row in the table, `$` in cells as written", () => {
    // Only the math output's own assertions: missing output (the conversion test failed) fails this test outright.
    if (invoice.math === undefined) throw new TypeError("invoice conversion did not run");
    expect(invoice.math).toContain("<td>$12.00</td>");
    expect(invoice.math).not.toContain("\\$");
    expect(invoice.math).toContain("<thead>");
  });

  it("a --math batch never costs a ruled table its table route (council #467)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const routesOf = (fixture: string, math: boolean, text: string[]) => {
      const { facts, pages } = convert(fixture, math);
      const job: SandboxedPdfBatchJob = {
        scope: { orgId: "org-a", runId: "run-1" }, options: { math, figures: false },
        files: [{ index: 0, documentId: "doc-0", input: "/w/in/0.pdf", output: "/w/out/0.md", bytes: 100, estimatedPages: pages }],
      };
      acceptSandboxedPdfBatchEvent(job, { index: 0, phase: "text", pages, result: { exitCode: 0, stdout: "", stderr: "", pageFacts: facts } });
      const layout = sandboxedPdfLayoutFacts(batchFileJob(job, 0)!)!;
      return Array.from({ length: pages }, (_, i) => {
        const page = layout.get(i + 1)!;
        return { grids: page.grids, route: classifyAdaptivePage(i + 1, text[i] ?? "", { routingV2: true, layout: page, encodings: page.encodings ?? null }).route };
      });
    };
    const fixtures = ["encoding-prose-table.pdf", "encoding-math-table.pdf", "routing-table-4-rows.pdf", "routing-table-6-rows.pdf",
      "routing-table-clean-financial.pdf", "tables-multipage-financials.pdf", "kreuzberg-tables-invoice.pdf", "encoding-tables-math.pdf"];
    for (const fixture of fixtures) {
      // The same page text for both runs: only the facts differ.
      const text = convert(fixture, false).markdown.split("\f");
      const plain = routesOf(fixture, false, text);
      const math = routesOf(fixture, true, text);
      math.forEach((page, i) => {
        // A math run's grid list is unknown, never an older build's "no table": wherever the plain run had a grid or a
        // table route, the math run keeps the table path open.
        if (plain[i]!.route === "table-heavy") expect(page.route, `${fixture} p${i + 1}`).toBe("table-heavy");
        if (plain[i]!.grids?.length) expect(page.grids === null || page.grids.length > 0, `${fixture} p${i + 1} grids`).toBe(true);
        if (page.grids !== null && page.grids.length === 0) expect(plain[i]!.grids, `${fixture} p${i + 1}`).toEqual([]);
      });
    }
    // The prose-cell table: a 4-row walker grid without --math; unknown (the table path) with it, never [].
    const prose = routesOf("encoding-prose-table.pdf", true, [""]);
    expect(prose[0]!.grids).toBeNull();
    expect(prose[0]!.route).toBe("table-heavy");
  });
});
