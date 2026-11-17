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

/** Facts (doppler-page-facts/1 lines) of one fixture, as a provider returns them beside the Markdown. */
function convert(fixture: string, math: boolean): { facts: string; pages: number } {
  const factsPath = path.join(scratch, `${fixture}.${math ? "math" : "plain"}.jsonl`);
  const fd = openSync(factsPath, "w");
  try {
    const run = spawnSync(converter, ["--stream", "--html", ...(math ? ["--math"] : []), "--page-facts-include", "mathtables", "--page-facts-fd", "3", path.join(FIXTURES, fixture)],
      { stdio: ["ignore", "ignore", "pipe", fd], timeout: 60_000 });
    expect(run.status, String(run.stderr)).toBe(0);
  } finally {
    closeSync(fd);
  }
  const facts = readFileSync(factsPath, "utf8");
  return { facts, pages: facts.split("\n").filter((line) => line.includes("\"type\":\"page\"")).length };
}

function routes(fixture: string, math = false) {
  const { facts, pages } = convert(fixture, math);
  const parsed = parseDopplerPageFacts(facts, { pageCount: pages });
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.facts.doc.include).toContain("mathtables");
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
    expect(growth?.table).toBe("none");
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
});
