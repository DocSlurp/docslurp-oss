/**
 * Page evidence (lib/page-evidence.ts): one fixture page per edge case, asserted once against the evidence's decisions, and
 * the cross-path parity the module exists for: classify-route and the v2 router read the same page the same way on table,
 * unknown and low confidence.
 */
import { describe, expect, it } from "vitest";
import type { PageTable } from "@docslurp/shared";

import { DOPPLER_TABLE_FLAGS, dopplerFlagBit, encodingRouteFromFlags } from "./doppler-encoding-facts.js";
import { parseDopplerPageFacts, withoutWalkerParityFacts, type DopplerPageFactsDocument } from "./doppler-page-facts.js";
import {
  PAGE_EVIDENCE, furnitureFloor, isFurnitureShare, mathGlyphNeed, mathGlyphsNeedTriage, mathGlyphsWithholdTrust, pageCostRouteOf,
  pageEvidenceFromLayout, pageEvidenceFromProbeRow, pageLayoutFactsFromEvidence, pageSize, pageTableDecision, readImageBoxes,
  routerTablePaths, routerTableRuleScore, settleGrids, textLayerGarbled, textLayerUnreliable, type PageEvidence,
} from "./page-evidence.js";
import { documentEvidenceFromDoppler, settleUnknownGrids } from "./page-evidence-doppler.js";
import { pageInputFromEvidence, pageInputsFromEvidence } from "../routing/page-input.js";
import { assessAttention } from "../routing/attention.js";
import { DEFAULT_PLANNER_CONFIG, needsFromFeatures, rolesForPage } from "../routing/planner.js";
import { freeTrustVerdict, insetGateCandidates } from "../routing/trust.js";
import { classifyAdaptivePage } from "../stages/classify-route.js";
import { docLine, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";

type Line = Record<string, unknown>;
const base = textPage(1);
const vectors = base.vectors as Line;
const images = base.images as Line;
const item = (images.items as Line[])[0]!;

function page(n: number, over: { vectors?: Line; item?: Line; images?: Line; text?: Line; extra?: Line } = {}): Line {
  return textPage(n, {
    vectors: { ...vectors, ...over.vectors },
    images: { ...images, items: [{ ...item, ...over.item }], ...over.images },
    text: { ...(base.text as Line), ...over.text },
    ...over.extra,
  });
}
function parse(lines: Line[], doc: Line = {}): DopplerPageFactsDocument {
  const pageCount = Math.max(1, lines.length);
  const result = parseDopplerPageFacts(jsonl([docLine({ pageCount, ...doc }), ...lines, runLine({ pagesEmitted: lines.length })]), { pageCount });
  if (!result.ok) throw new Error(result.reason);
  return result.facts;
}
const evidenceOf = (line: Line, doc: Line = {}) => documentEvidenceFromDoppler(parse([line], doc))[0]!;

const THIN_TABLE = { bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29, hRules: 7, vRules: 5, outerSides: 4, connected: true };
const WALKER_TABLE = { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 };
const LARGE_IMAGE = { bbox: [72, 200, 540, 560], coverage: 0.35, px: [1950, 1500] };

// ── One fixture page per edge case ──

const EDGE: Record<string, { evidence: () => PageEvidence; state: PageEvidence["state"]; grids: PageEvidence["grids"]["state"]; table: "table" | "no-table" | "unknown"; imagesReadable: boolean }> = {
  "thin-rule build, walker table": { evidence: () => evidenceOf(page(1, { vectors: WALKER_TABLE })), state: "known", grids: "known", table: "table", imagesReadable: true },
  "thin-rule build, no walker grid": { evidence: () => evidenceOf(page(1, { vectors: { ...WALKER_TABLE, grids: [{ ...THIN_TABLE, connected: false }] } })), state: "known", grids: "known", table: "no-table", imagesReadable: true },
  "low confidence (xref-repaired-earlier)": {
    evidence: () => evidenceOf(page(1, { vectors: { ...WALKER_TABLE, hRules: 12, vRules: 9 }, item: LARGE_IMAGE, images: { imageCoverage: 0.35, largestImageCoverage: 0.35 }, text: { mathGlyphRatio: 0.05 }, extra: { parseWarnings: ["xref-repaired-earlier"] } })),
    state: "low-confidence", grids: "unknown", table: "unknown", imagesReadable: false,
  },
  "truncated grids": { evidence: () => evidenceOf(page(1, { vectors: { grids: [], gridsTruncated: true } })), state: "known", grids: "unknown", table: "unknown", imagesReadable: true },
  "drawing cap": { evidence: () => evidenceOf(page(1, { vectors: { grids: [], gridsTruncated: false, limitHit: true } })), state: "known", grids: "unknown", table: "unknown", imagesReadable: true },
  "older build: list absent, rules enough": { evidence: () => evidenceOf(page(1)), state: "known", grids: "unknown", table: "unknown", imagesReadable: true },
  "older build: list absent, too few rules": { evidence: () => evidenceOf(page(1, { vectors: { hRules: 1 } })), state: "known", grids: "known", table: "no-table", imagesReadable: true },
  "older build: a two-column grid it cannot place": { evidence: () => evidenceOf(page(1, { vectors: { grids: [{ bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29 }], gridsTruncated: false } })), state: "known", grids: "unknown", table: "unknown", imagesReadable: true },
  "no vectors family": { evidence: () => { const { vectors: _v, ...line } = page(1); return evidenceOf(line); }, state: "known", grids: "unknown", table: "unknown", imagesReadable: true },
  "math run without walker parity (-glyphs)": {
    evidence: () => documentEvidenceFromDoppler(withoutWalkerParityFacts(parse([page(1, { vectors: WALKER_TABLE })])), { mathRead: true })[0]!,
    state: "known", grids: "unknown", table: "unknown", imagesReadable: true,
  },
  "failed page": { evidence: () => evidenceOf({ schema: "doppler-page-facts/1", type: "page", page: 1, error: "failed", parseWarnings: ["page-failed"], unusualFeatures: [] }), state: "failed", grids: "unknown", table: "unknown", imagesReadable: false },
  "locked document": { evidence: () => documentEvidenceFromDoppler(parse([], { locked: true, encryption: "user-password-required" }))[0]!, state: "locked", grids: "unknown", table: "unknown", imagesReadable: false },
};

describe("page evidence: one fixture page per edge case", () => {
  it.each(Object.entries(EDGE))("%s", (_name, edge) => {
    const evidence = edge.evidence();
    expect(evidence.state).toBe(edge.state);
    expect(evidence.grids.state).toBe(edge.grids);
    expect(pageTableDecision(evidence).decision).toBe(edge.table);
    expect(readImageBoxes(evidence).length > 0).toBe(edge.imagesReadable);
    if (evidence.state !== "known") {
      // Nothing about the page is known but (for low confidence) its size: never a count, a layer, an image or a grid.
      expect(evidence.text).toMatchObject({ words: null, chars: null, mathGlyphRatio: null, status: "unknown" });
      expect([evidence.images, evidence.placements, evidence.vectors, evidence.encodings]).toEqual([null, null, null, null]);
    }
  });

  it("low confidence keeps only the page size, in every form a consumer reads", () => {
    const low = EDGE["low confidence (xref-repaired-earlier)"]!.evidence();
    expect(low.size).toEqual({ widthPt: 612, heightPt: 792 });
    // Its features stay (they only add caution: an appearance-only form still needs a render), with the low-confidence mark.
    expect(low.features).toEqual(["acroform-filled", "facts-low-confidence", "link-internal", "link-uri", "ocg-visible"]);
    expect(pageLayoutFactsFromEvidence(low)).toEqual({ images: null, tables: null, words: null, grids: null, tableCoverage: null, widthPt: 612, heightPt: 792 });
    expect(routerTableRuleScore(low)).toBe(PAGE_EVIDENCE.fullTableRuleScore);
  });

  it("a failed page and a locked document have no layout form (unknown, left out)", () => {
    expect(pageLayoutFactsFromEvidence(EDGE["failed page"]!.evidence())).toBeNull();
    expect(pageLayoutFactsFromEvidence(EDGE["locked document"]!.evidence())).toBeNull();
    expect(EDGE["failed page"]!.evidence().features).toContain("probe-error");
    expect(EDGE["locked document"]!.evidence().features).toContain("encrypted-user-password");
  });

  it("the walker's layout round-trips, unknown and unmeasured grids kept apart", () => {
    const known = { images: [], tables: [], words: 300, grids: [{ rows: 7, columns: 3, coverage: 0.2 }], tableCoverage: 0.2, widthPt: 612, heightPt: 792 };
    expect(pageLayoutFactsFromEvidence(pageEvidenceFromLayout(1, known))).toEqual(known);
    expect(pageEvidenceFromLayout(1, { ...known, grids: null, gridsUnknown: true }).grids.state).toBe("unknown");
    // The walker alone (no facts to settle it): its own "no ruling line", never the table path.
    const unmeasured = pageEvidenceFromLayout(1, { ...known, grids: null, tableCoverage: null });
    expect(unmeasured.grids.state).toBe("unmeasured");
    expect(pageTableDecision(unmeasured).decision).toBe("no-table");
  });
});

// ── Decisions ──

describe("page evidence decisions", () => {
  it("grid precedence: the walker's known grids, else the facts' known grids, else unknown", () => {
    const walker = { state: "known" as const, grids: [{ rows: 7, columns: 3, coverage: null }] };
    const facts = { state: "known" as const, grids: [] as PageTable[] };
    expect(settleGrids(walker, facts)).toBe(walker);
    expect(settleGrids({ state: "unknown" }, facts)).toBe(facts);
    expect(settleGrids({ state: "unmeasured" }, { state: "unknown" })).toEqual({ state: "unknown" });
    expect(settleGrids({ state: "unknown" }, null)).toEqual({ state: "unknown" });
  });

  it("encodings only add a table: never settle unknown grids as no table, never remove a grid's table", () => {
    const outlined = encodingRouteFromFlags([], ["outlined-text-grid"], false);
    const booktabs = encodingRouteFromFlags([], ["booktabs"], false);
    const none = encodingRouteFromFlags([], [], false);
    const mathGrid = encodingRouteFromFlags(["math-matrix"], ["math-grid"], false);
    const prose = EDGE["thin-rule build, no walker grid"]!.evidence();
    const unknown = EDGE["truncated grids"]!.evidence();
    const table = EDGE["thin-rule build, walker table"]!.evidence();
    expect(pageTableDecision(prose, { encodings: outlined })).toEqual({ decision: "table", reason: "encoding-vision" });
    expect(pageTableDecision(prose, { encodings: booktabs })).toEqual({ decision: "table", reason: "encoding-text-layer" });
    for (const encodings of [none, mathGrid, booktabs]) {
      expect(pageTableDecision(unknown, { encodings }).decision, JSON.stringify(encodings.tableFlags)).toBe("unknown");
      expect(pageTableDecision(table, { encodings }).decision, JSON.stringify(encodings.tableFlags)).toBe("table");
    }
    expect(pageTableDecision(prose, { encodings: none }).decision).toBe("no-table");
    expect(dopplerFlagBit(DOPPLER_TABLE_FLAGS, "math-grid")).toBe(256);
  });

  it("text tables count where the extractor lists none of its own", () => {
    const rows = (n: number): PageTable[] => [{ rows: n, columns: 3, coverage: null }];
    const prose = EDGE["thin-rule build, no walker grid"]!.evidence();
    expect(pageTableDecision(prose, { markdownTables: rows(6) }).decision).toBe("table");
    expect(pageTableDecision(prose, { textRows: rows(6) }).decision).toBe("table");
    expect(pageTableDecision(prose, { markdownTables: rows(2) }).decision).toBe("no-table");
    // The walker's own tables (with geometry) replace the Markdown count.
    const walker = pageEvidenceFromLayout(1, { images: [], tables: [], words: 300, grids: [], tableCoverage: 0 });
    expect(pageTableDecision(walker, { markdownTables: rows(6) }).decision).toBe("no-table");
  });

  it("the router's table rule score is never lowered, and full on the table path", () => {
    expect(routerTableRuleScore(EDGE["thin-rule build, walker table"]!.evidence())).toBe(5);
    // Known no table leaves the source's own score (the router's rule may still say table): never a removed table route.
    expect(routerTableRuleScore(EDGE["thin-rule build, no walker grid"]!.evidence())).toBe(5);
    expect(routerTableRuleScore(EDGE["no vectors family"]!.evidence())).toBe(4);
    expect(routerTableRuleScore(EDGE["failed page"]!.evidence())).toBe(0);
  });

  it("text layer rules: garbled, unreliable, and page size bounds", () => {
    expect(textLayerGarbled(19, 0.5, 0)).toBe(false);
    expect(textLayerGarbled(20, 0.11, 0)).toBe(true);
    expect(textLayerGarbled(20, 0.1, 0.4)).toBe(false);
    expect(textLayerGarbled(20, 0, 0.41)).toBe(true);
    expect(textLayerUnreliable({ garbled: false, unmappedGlyphRatio: 0.11 })).toBe(true);
    expect(textLayerUnreliable({ garbled: false, unmappedGlyphRatio: 0.1 })).toBe(false);
    expect(pageSize(612, 792)).toEqual({ widthPt: 612, heightPt: 792 });
    expect([pageSize(0.5, 792), pageSize(612, 14_401), pageSize(Number.NaN, 792), pageSize(null, 792)]).toEqual([null, null, null, null]);
  });

  it("one math-glyph gate, three purposes", () => {
    for (const ratio of [0, 0.0099]) expect([mathGlyphsWithholdTrust(ratio), mathGlyphsNeedTriage(ratio)]).toEqual([false, false]);
    for (const ratio of [0.01, 0.05]) expect([mathGlyphsWithholdTrust(ratio), mathGlyphsNeedTriage(ratio)]).toEqual([true, true]);
    expect(mathGlyphNeed(0.04)).toBe(0.5);
    expect(mathGlyphNeed(0.5)).toBe(1);
  });

  it("furniture: the walker's floor and the probe's share are one rule for every page count the facts allow", () => {
    expect(furnitureFloor(10)).toBe(3);
    expect(furnitureFloor(15)).toBe(3);
    expect(furnitureFloor(100)).toBe(20);
    for (let scope = 1; scope <= 100_000; scope += 1) {
      const floor = furnitureFloor(scope);
      if (!isFurnitureShare(floor, scope) || (floor > 3 && isFurnitureShare(floor - 1, scope))) throw new Error(`furniture rules disagree at ${scope}`);
    }
  });

  it("cost route: unknown grids take the table path only for a page whose source text has letters", () => {
    const unknown = EDGE["truncated grids"]!.evidence();
    expect(pageCostRouteOf(unknown, { lexicalText: true, vectorPaths: null })).toBe("table");
    expect(pageCostRouteOf(unknown, { lexicalText: null, vectorPaths: null })).toBe("unknown");
    expect(pageCostRouteOf(unknown, { lexicalText: false, vectorPaths: 0 })).toBe("ocr-read");
    expect(pageCostRouteOf(EDGE["thin-rule build, walker table"]!.evidence(), { lexicalText: null, vectorPaths: null })).toBe("table");
    expect(pageCostRouteOf(undefined, { lexicalText: null, vectorPaths: null })).toBe("unknown");
  });
});

// ── Cross-path parity ──

/** classify-route's reading of the page: the job's settled layout (facts-only, settled against itself), then the classifier. */
function classifyRoute(evidence: PageEvidence, facts: DopplerPageFactsDocument) {
  const layout = pageLayoutFactsFromEvidence(evidence);
  if (!layout) return { tablePath: true, readsImage: false, route: "unknown" };
  const settled = settleUnknownGrids(new Map([[evidence.page, layout]]), facts).layout.get(evidence.page)!;
  const entry = classifyAdaptivePage(evidence.page, "word ".repeat(300), { routingV2: true, layout: settled });
  return { tablePath: entry.route === "table-heavy", readsImage: settled.images !== null, route: entry.route };
}

async function routerRoute(evidence: PageEvidence) {
  const input = await pageInputFromEvidence(evidence, null, "pdf", { pageCount: 1 });
  const needs = needsFromFeatures(input);
  const roles = rolesForPage(needs, DEFAULT_PLANNER_CONFIG).map((role) => role.role);
  return { tablePath: roles.includes("table"), insetQuestions: insetGateCandidates(input).length, images: input.images.length, roles, trust: freeTrustVerdict(input) };
}

describe("cross-path parity: classify-route and the v2 router read a page the same way", () => {
  const cases: Array<[string, Line]> = [
    ["walker table", page(1, { vectors: WALKER_TABLE })],
    ["truncated grids", page(1, { vectors: { grids: [], gridsTruncated: true } })],
    ["older build, rules enough", page(1)],
    ["older build, a grid it cannot place", page(1, { vectors: { grids: [{ bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29 }], gridsTruncated: false } })],
    ["no vectors family", (() => { const { vectors: _v, ...line } = page(1); return line; })()],
    ["low confidence", page(1, { vectors: { ...WALKER_TABLE, hRules: 12, vRules: 9 }, item: LARGE_IMAGE, images: { imageCoverage: 0.35, largestImageCoverage: 0.35 }, text: { mathGlyphRatio: 0.05 }, extra: { parseWarnings: ["xref-repaired-earlier"] } })],
    ["low confidence scan", scanPage(1, { parseWarnings: ["xref-repaired-earlier"] })],
    ["prose, too few rules", page(1, { vectors: { hRules: 0, vRules: 0 } })],
  ];

  it.each(cases)("%s: a table or unknown grid in classify-route is a table in the router", async (_name, line) => {
    const facts = parse([line]);
    const evidence = documentEvidenceFromDoppler(facts)[0]!;
    const classify = classifyRoute(evidence, facts);
    const router = await routerRoute(evidence);
    const decision = pageTableDecision(evidence).decision;
    expect(classify.tablePath).toBe(decision !== "no-table");
    if (decision !== "no-table") expect(router.tablePath).toBe(true);
    // Only a known page's images reach either path's reads.
    if (evidence.state !== "known") {
      expect(classify.readsImage).toBe(false);
      expect([router.images, router.insetQuestions]).toEqual([0, 0]);
    }
  });

  it("low confidence: the router no longer reads the page's leaked images, rules, math or features (the leak this module closed)", async () => {
    const facts = parse([cases.find(([name]) => name === "low confidence")![1]]);
    const evidence = documentEvidenceFromDoppler(facts)[0]!;
    const router = await routerRoute(evidence);
    const input = await pageInputFromEvidence(evidence, null, "pdf", { pageCount: 1 });
    expect(input.images).toEqual([]);
    expect(input.features.raster.imageCoverage).toBe(0);
    expect(input.features.native).toMatchObject({ mathGlyphRatio: 0, wordCount: 0, tableRuleScore: PAGE_EVIDENCE.fullTableRuleScore });
    expect(input.textFacts.textLayerStatus).toBe("unknown");
    expect(input.unusualFeatures).toContain("facts-low-confidence");
    // The table path, as classify-route, with a render (OCR) role beside it; no math or image role, no inset question.
    expect(router.roles).toEqual(["table", "ocr"]);
    expect(router.trust).toMatchObject({ trusted: false, mathGated: false });
  });

  it("a page whose text layer is unread is never text-layer-only: a low-confidence scan and a failed page get an OCR role", async () => {
    for (const line of [scanPage(1, { parseWarnings: ["xref-repaired-earlier"] }), { schema: "doppler-page-facts/1", type: "page", page: 1, error: "failed", parseWarnings: [], unusualFeatures: [] }]) {
      const router = await routerRoute(documentEvidenceFromDoppler(parse([line]))[0]!);
      expect(router.roles).toContain("ocr");
      expect(router.roles.filter((role) => role === "accept-text" || role === "extract-text")).toEqual([]);
    }
    // An appearance-only form on a low-confidence page still needs a render (its features are kept).
    const form = await pageInputFromEvidence(documentEvidenceFromDoppler(parse([page(1, { extra: { parseWarnings: ["xref-repaired-earlier"] } })]))[0]!, null, "pdf", { pageCount: 1 });
    expect(assessAttention(form).renderNeeded).toBe(true);
  });

  it("table paths from unknown grids alone are capped per document (classify-route's table-leak cap), strongest evidence first", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => page(i + 1, {
      // Page 8 is known, with truncated grids and one rule each way: the strongest unknown-grid evidence of the document.
      vectors: i === 7 ? { hRules: 1, vRules: 1, grids: [], gridsTruncated: true } : { hRules: 0, vRules: 0 }, text: { mathGlyphRatio: 0 },
      images: { imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, items: [] },
      extra: { parseWarnings: i === 7 ? [] : ["xref-repaired-earlier"], unusualFeatures: [] },
    }));
    const pages = documentEvidenceFromDoppler(parse(lines));
    expect(routerTablePaths(pages, 20, 2)).toMatchObject({ kept: new Set([8, 1, 2, 3]) });
    const inputs = await pageInputsFromEvidence(pages, null, "pdf", { pageCount: 20 });
    const tables = inputs.filter((input) => rolesForPage(needsFromFeatures(input), DEFAULT_PLANNER_CONFIG).some((role) => role.role === "table"));
    expect(tables.map((input) => input.features.pageNumber)).toEqual([1, 2, 3, 8]);
    const capped = inputs.filter((input) => input.unusualFeatures?.includes("table-path-capped"));
    expect(capped).toHaveLength(16);
    // Capped pages keep their own (non-table) role, which for an unread layer is still a render.
    for (const input of capped) expect(rolesForPage(needsFromFeatures(input), DEFAULT_PLANNER_CONFIG).map((role) => role.role)).toEqual(["ocr"]);
  });

  it("a native probe row reaches the router through the same evidence, unchanged (no grids: its own rule score)", async () => {
    const row = {
      pageNumber: 1, pageCount: 1, charCount: 2000, wordCount: 330, textCoverage: 0.4, fontCount: 2, unmappedGlyphRatio: 0, mathGlyphRatio: 0,
      tableRuleScore: 3, imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false, vectorDrawingCount: 4, uncoveredVectorRatio: 0,
      garbled: false, textLayerStatus: "ok" as const, imageCount: 0, textFacts: { wordCount: 330, imageCount: 0, imageCoverage: 0, textLayerStatus: "ok" as const },
      images: [], smallestFontPt: 9, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 4,
    };
    const evidence = pageEvidenceFromProbeRow(row);
    expect(evidence.grids.state).toBe("unmeasured");
    expect(routerTableRuleScore(evidence)).toBe(3);
  });
});
