/**
 * Unknown walker grids are never read as "no table" (app #530 council I1): with the job's Doppler page facts in hand, a
 * page the walker left at `grids: null` takes the facts' grids when they know them, and is routed down the table path when
 * they do not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptSandboxedPdfResult, sandboxedPdfGridSettlement, sandboxedPdfLayoutFacts, type SandboxedPdfJob } from "../extractors/plugins.js";
import { classifyAdaptivePage } from "../stages/classify-route.js";
import { docLine, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";
import { parseDopplerPageFacts } from "./doppler-page-facts.js";
import { settleUnknownGrids } from "./doppler-page-facts-layout.js";
import { parsePageLayoutFacts, type PageLayoutFacts } from "./page-layout-facts.js";

const NO_RULES = { paths: 4, filled: 0, stroked: 4, coverage: 0.01, uncoveredRatio: 0, hRules: 1, vRules: 0, ruleGridScore: 0, shadings: 0,
  patterns: 0, clips: 0, figureClusters: 0, clusters: [], clustersTruncated: false, limitHit: false, grids: [], gridsTruncated: false };
const TRUNCATED = { ...NO_RULES, hRules: 9, vRules: 6, grids: [], gridsTruncated: true };

function facts(pages: Array<Record<string, unknown>>) {
  return jsonl([docLine({ pageCount: pages.length }), ...pages, runLine({ pagesEmitted: pages.length })]);
}
function page(n: number, vectors: Record<string, unknown>) { return textPage(n, { vectors }); }
const walkerPage = (grids: PageLayoutFacts["grids"]): PageLayoutFacts => ({ images: null, tables: [], words: 40, grids, tableCoverage: null, widthPt: 612, heightPt: 792 });
const prose = "A plain paragraph of prose about quarterly results, with nothing laid out in columns.\n\nAnother paragraph follows here.";

describe("unknown walker grids settle from page facts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("takes the facts' grids where they know them and marks the rest", () => {
    const parsed = parseDopplerPageFacts(facts([page(1, NO_RULES), page(2, TRUNCATED), page(3, NO_RULES)]), { pageCount: 4 });
    if (!parsed.ok) throw new Error(parsed.reason);
    const walker = new Map<number, PageLayoutFacts>([
      [1, walkerPage(null)], [2, walkerPage(null)], [3, walkerPage([{ rows: 5, columns: 4, coverage: 0.3 }])], [4, walkerPage(null)],
    ]);
    const { layout, fromFacts, unknown } = settleUnknownGrids(walker, parsed.facts);
    expect(layout.get(1)).toMatchObject({ grids: [] });
    expect(layout.get(1)).not.toHaveProperty("gridsUnknown");
    expect(layout.get(2)).toMatchObject({ grids: null, gridsUnknown: true });          // truncated facts: unknown both ways
    expect(layout.get(3)?.grids).toEqual([{ rows: 5, columns: 4, coverage: 0.3 }]);   // the walker's known answer stands
    expect(layout.get(4)).toMatchObject({ grids: null, gridsUnknown: true });          // no facts line for the page
    expect({ fromFacts, unknown }).toEqual({ fromFacts: 1, unknown: 2 });
    expect(walker.get(2)).not.toHaveProperty("gridsUnknown");                          // the input is not changed
  });

  it("routes an unknown page down the table path, and a settled one as before", () => {
    const unknown = classifyAdaptivePage(1, prose, { layout: { ...walkerPage(null), gridsUnknown: true } });
    expect(unknown.route).toBe("table-heavy");
    expect(unknown.signals).toContain("grids-unknown");
    expect(classifyAdaptivePage(1, prose, { layout: walkerPage([]) }).route).not.toBe("table-heavy");
    expect(classifyAdaptivePage(1, prose, { layout: walkerPage(null) }).route).not.toBe("table-heavy");   // walker source: unchanged
  });

  it("keeps the mark through the stored artifact, and only beside unknown grids", () => {
    const stored = { version: "pdf-layout-facts@1", pages: [
      { pageNumber: 1, known: true, ...walkerPage(null), gridsUnknown: true },
      { pageNumber: 2, known: true, ...walkerPage([]), gridsUnknown: true },
      { pageNumber: 3, known: true, ...walkerPage(null), gridsUnknown: "yes" },
    ] };
    const pages = parsePageLayoutFacts(stored);
    expect(pages.get(1)?.gridsUnknown).toBe(true);
    expect(pages.get(2)).not.toHaveProperty("gridsUnknown");
    expect(pages.get(3)).not.toHaveProperty("gridsUnknown");
  });

  it("settles a provider result that carries page facts; a walker-only result is used as it is", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const layoutFacts = { version: "pdf-layout-facts@1", pages: [1, 2].map((n) => ({ pageNumber: n, known: true, ...walkerPage(null) })) };
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", layoutFacts, pageFacts: facts([page(1, NO_RULES), page(2, TRUNCATED)]) }, 2);
    expect(sandboxedPdfLayoutFacts(job)?.get(1)).toMatchObject({ grids: [] });
    expect(sandboxedPdfLayoutFacts(job)?.get(2)).toMatchObject({ gridsUnknown: true });
    expect(sandboxedPdfGridSettlement(job)).toEqual({ fromFacts: 1, unknown: 1, filled: 0, walker: 0 });
    const walkerOnly: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(walkerOnly, { exitCode: 0, stdout: "", stderr: "", layoutFacts }, 2);
    expect(sandboxedPdfLayoutFacts(walkerOnly)?.get(1)).not.toHaveProperty("gridsUnknown");
    expect(sandboxedPdfGridSettlement(walkerOnly)).toBeUndefined();
  });

  it("fills every page the walker left out: a flagged page dropped by a failed walk is never read as no table (council F1)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const RULED = { ...NO_RULES, hRules: 7, vRules: 5, grids: [{ bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29, hRules: 7, vRules: 5, outerSides: 4, connected: true }], unlistedRuledGrids: 0 };
    // The guest's real shape under selective with a lying page tree: the pages it did not walk are present (no table), the
    // flagged pages it walked are absent, and the walker's whole-file reason rides along.
    const unwalked = [1, 2, 4].map((n) => ({ pageNumber: n, known: true, ...walkerPage(null) }));
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "",
      layoutFacts: { version: "pdf-layout-facts@1", pages: unwalked, walkerUnknown: { reason: "page-tree-count", pages: 2 } },
      pageFacts: facts([page(1, NO_RULES), page(2, NO_RULES), page(3, RULED), page(4, NO_RULES), page(5, TRUNCATED)]) }, 6);
    const layout = sandboxedPdfLayoutFacts(job)!;
    expect([...layout.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(layout.get(3)?.grids).toEqual([{ rows: 6, columns: 4, coverage: null }]);   // the facts' walker-parity grid
    expect(layout.get(5)).toMatchObject({ grids: null, gridsUnknown: true });         // facts do not know either
    expect(layout.get(6)).toMatchObject({ grids: null, gridsUnknown: true, tables: null });   // no facts line at all
    expect(classifyAdaptivePage(3, prose, { layout: layout.get(3)! }).route).toBe("table-heavy");
    expect(classifyAdaptivePage(6, prose, { layout: layout.get(6)! }).route).toBe("table-heavy");
    expect(sandboxedPdfGridSettlement(job)).toEqual({ fromFacts: 4, unknown: 2, filled: 3, walker: 0 });
    // Computed once per accepted result.
    expect(sandboxedPdfLayoutFacts(job)).toBe(layout);
  });

  it("fills a partial layout without page facts too: missing pages are unknown, never no table (council #2 N1)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    const pages = [{ pageNumber: 1, known: true, ...walkerPage(null), gridsUnknown: true }, { pageNumber: 2, known: true, ...walkerPage([]) }];
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages } }, 4);
    const layout = sandboxedPdfLayoutFacts(job)!;
    expect([...layout.keys()]).toEqual([1, 2, 3, 4]);
    expect(layout.get(3)).toMatchObject({ gridsUnknown: true });
    expect(sandboxedPdfGridSettlement(job)).toEqual({ fromFacts: 0, unknown: 3, filled: 2, walker: 1 });
    // A complete walker layout without marks stays as it is (layout source walker).
    const plain: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(plain, { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages: [pages[1]] } }, 4);
    expect([...sandboxedPdfLayoutFacts(plain)!.keys()]).toEqual([2]);
  });

  it("lets page facts stand in when the walker could not walk the file at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "",
      layoutFacts: { version: "pdf-layout-facts@1", pages: [], walkerUnknown: { reason: "page-tree-count", pages: 2 } },
      pageFacts: facts([page(1, NO_RULES), page(2, TRUNCATED)]) }, 2);
    const layout = sandboxedPdfLayoutFacts(job);
    expect(layout?.get(1)).toMatchObject({ grids: [] });
    expect(layout?.get(2)).toMatchObject({ grids: null, gridsUnknown: true });
  });
});
