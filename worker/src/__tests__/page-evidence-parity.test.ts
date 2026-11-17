/**
 * Decision parity harness for page evidence: one corpus of synthetic pages (Doppler page facts, layout-walker payloads and
 * native probe rows covering the edge cases routing cares about), run through every consumer that decides something from
 * them, with the decisions written to a committed snapshot (`__snapshots__/page-evidence-parity.json`):
 * - classify-route evidence routing (route, hint, read, signals), with Doppler's encodings on and off;
 * - the v2 page router (its page input's table/math/image features, the free trust verdict, needs, roles, triage);
 * - document cost stats (each page's cost route);
 * - page-image evidence, the ingest report's page rows and the stored routing facts built from page facts;
 * - chart-export candidates from page facts.
 * A refactor that keeps behaviour leaves the snapshot unchanged; any decision it changes shows up as a snapshot diff to
 * justify in review. Inputs go through the production entry points (the provider-result path for layout facts, the facts
 * probe runner for the router), so the harness does not depend on how those are built inside.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageInput } from "@docslurp/shared";

import { acceptSandboxedPdfResult, sandboxedPdfLayoutFacts, type SandboxedPdfJob } from "../extractors/plugins.js";
import { documentCostStats } from "../lib/document-cost-stats.js";
import { DOPPLER_MATH_FLAGS, DOPPLER_TABLE_FLAGS, DOPPLER_ENCODING_COUNTS, dopplerFlagBit, type DopplerMathFlag, type DopplerTableFlag } from "../lib/doppler-encoding-facts.js";
import { parseDopplerPageFacts } from "../lib/doppler-page-facts.js";
import { pageFactRowsFromDopplerFacts, pageImageEvidenceFromDopplerFacts } from "../lib/doppler-page-facts-evidence.js";
import { routingFactsWithDopplerFacts } from "../lib/page-evidence-doppler.js";
import { candidatesFromPageFacts } from "../chart-export/facts-candidates.js";
import { assessAttention } from "../routing/attention.js";
import { pageInputFromProbeRow, pageInputsFromEvidence, type ProbeRow } from "../routing/page-input.js";
import { DEFAULT_PLANNER_CONFIG, needsFromFeatures, rolesForPage } from "../routing/planner.js";
import { createDopplerFactsProbeRunner } from "../routing/probe/doppler-facts-runner.js";
import { shouldTriage } from "../routing/triage.js";
import { freeTrustVerdict, insetGateCandidates } from "../routing/trust.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { docLine, figurePage, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";

// ── Corpus ──

type Line = Record<string, unknown>;
interface FactsCase {
  name: string;
  pages: Line[];
  doc?: Line;
  /** Page texts as the extractor wrote them (page-aligned); default: prose sized by each page's word count. */
  texts?: string[];
  /** A pdf-layout-facts@1 payload the walker returned beside the facts. */
  walker?: unknown;
  /** The run read math (`--math`, so `-glyphs`). */
  glyphs?: boolean;
}

const base = textPage(1);
const vectors = base.vectors as Line;
const images = base.images as Line;
const item = (images.items as Line[])[0]!;
const text = base.text as Line;
const prose = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");

const mathWord = (...flags: DopplerMathFlag[]) => flags.reduce((sum, flag) => sum + dopplerFlagBit(DOPPLER_MATH_FLAGS, flag), 0);
const tableWord = (...flags: DopplerTableFlag[]) => flags.reduce((sum, flag) => sum + dopplerFlagBit(DOPPLER_TABLE_FLAGS, flag), 0);
const counts = (nibbles: Partial<Record<(typeof DOPPLER_ENCODING_COUNTS)[number], number>> = {}) =>
  DOPPLER_ENCODING_COUNTS.reduce((sum, name, i) => sum + (nibbles[name] ?? 0) * 16 ** i, 0);

/** Page `n` of a text page with overrides of its families. */
function page(n: number, over: { vectors?: Line; item?: Line; images?: Line; text?: Line; extra?: Line } = {}): Line {
  return textPage(n, {
    vectors: { ...vectors, ...over.vectors },
    images: { ...images, items: [{ ...item, ...over.item }], ...over.images },
    text: { ...text, ...over.text },
    ...over.extra,
  });
}

const THIN_TABLE = { bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29, hRules: 7, vRules: 5, outerSides: 4, connected: true };
const OLD_TABLE = { bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29 };
const SCAN_ITEM = { index: 2, bbox: [67, 302, 535, 602], coverage: 0.29, px: [1950, 1250], dpi: [300, 300], filter: "ccitt", bpc: 1, colorSpace: "gray",
  imageMask: false, softMask: false, mask: false, decode: false, inline: false, obj: 50, copy: "bilevel", bytesPerPixel: 0.02 };

const CASES: FactsCase[] = [
  { name: "full fixture (text, scan, figure)", pages: [textPage(1), scanPage(2), figurePage(3)] },
  { name: "thin-rule build: walker table", pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 } })] },
  { name: "thin-rule build: no walker grid", pages: [page(1, { vectors: { grids: [{ ...THIN_TABLE, connected: false }], gridsTruncated: false, unlistedRuledGrids: 0 } })] },
  { name: "thin-rule build: unlisted walker grid", pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 1 } })] },
  { name: "older build: grid list absent, rules enough", pages: [page(1)] },
  { name: "older build: grid list absent, too few rules", pages: [page(1, { vectors: { hRules: 1, vRules: 0 } })] },
  { name: "older build: two-column grid found", pages: [page(1, { vectors: { grids: [OLD_TABLE], gridsTruncated: false } })] },
  { name: "older build: one-column grid only", pages: [page(1, { vectors: { grids: [{ ...OLD_TABLE, columns: 1 }], gridsTruncated: false } })] },
  { name: "truncated grids", pages: [page(1, { vectors: { grids: [], gridsTruncated: true } })] },
  { name: "drawing limit", pages: [page(1, { vectors: { grids: [], gridsTruncated: false, limitHit: true } })] },
  { name: "no vectors family", pages: [page(1, { extra: { vectors: undefined } })] },
  { name: "truncated grids, few rules", pages: [page(1, { vectors: { hRules: 1, vRules: 1, grids: [], gridsTruncated: true } })] },
  { name: "drawing limit, few rules", pages: [page(1, { vectors: { hRules: 1, vRules: 2, grids: [], gridsTruncated: false, limitHit: true } })] },
  { name: "no vectors family, rules unknown, prose", pages: [page(1, { text: { mathGlyphRatio: 0 }, images: { imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, items: [] }, extra: { vectors: undefined } })] },
  {
    // A prose document whose cross-reference table the reader had to rebuild: every page low confidence but the first
    // (xref-repaired). The router's table paths from unknown grids are capped per document (tableLeakPageCap).
    name: "prose only, unreadable xref (20 pages)",
    pages: Array.from({ length: 20 }, (_, i) => page(i + 1, {
      vectors: { hRules: 0, vRules: 0 }, text: { mathGlyphRatio: 0 }, images: { imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, items: [] },
      extra: { parseWarnings: i === 0 ? ["internal-error", "xref-repaired"] : ["xref-repaired-earlier"], unusualFeatures: [] },
    })),
  },
  {
    name: "low confidence (xref-repaired-earlier): table rules, a large image, math glyphs",
    pages: [page(1, {
      vectors: { hRules: 12, vRules: 9, grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 },
      images: { imageCount: 1, imageCoverage: 0.35, largestImageCoverage: 0.35 },
      item: { bbox: [72, 200, 540, 560], coverage: 0.35, px: [1950, 1500] },
      text: { mathGlyphRatio: 0.05 },
      extra: { parseWarnings: ["xref-repaired-earlier"] },
    })],
  },
  {
    name: "low confidence sparse scan page",
    pages: [scanPage(1, { parseWarnings: ["xref-repaired-earlier"] })],
    texts: [""],
  },
  { name: "xref-repaired thin-rule build", pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 }, extra: { parseWarnings: ["xref-repaired"] } })] },
  { name: "failed page beside a text page", pages: [{ schema: "doppler-page-facts/1", type: "page", page: 1, error: "failed", parseWarnings: ["page-failed"], unusualFeatures: [] }, textPage(2)] },
  { name: "locked document", pages: [], doc: { locked: true, encryption: "user-password-required" } },
  { name: "math run (-glyphs): thin-rule table", glyphs: true, pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 } })] },
  { name: "math run (-glyphs): too few rules", glyphs: true, pages: [page(1, { vectors: { hRules: 1, vRules: 1 } })] },
  { name: "garbled: unmapped glyphs", pages: [page(1, { text: { replacementCharRatio: 0.15 } })] },
  { name: "garbled: control characters", pages: [page(1, { text: { controlCharRatio: 0.5 } })] },
  { name: "garbled: font unmapped ratio", pages: [page(1, { extra: { fonts: { ...(base.fonts as Line), unmappedGlyphRatio: 0.2 } } })] },
  { name: "math glyphs below the gate", pages: [page(1, { text: { mathGlyphRatio: 0.005 }, vectors: { hRules: 0, vRules: 0 } })] },
  { name: "math glyphs above the gate", pages: [page(1, { text: { mathGlyphRatio: 0.05 }, vectors: { hRules: 0, vRules: 0 } })] },
  { name: "mixed scan beside text (centred words)", pages: [page(1, {
    images: { imageCount: 2, imageCoverage: 0.3, largestImageCoverage: 0.29 },
    extra: { images: { ...images, imageCount: 2, imageCoverage: 0.3, largestImageCoverage: 0.29, items: [item, { ...SCAN_ITEM, visibleWordsInside: 0, invisibleWordsInside: 0, visibleWordsCentredInside: 0, invisibleWordsCentredInside: 0 }] } },
  })] },
  { name: "image list truncated", pages: [page(1, { images: { itemsTruncated: true } })] },
  {
    name: "encodings: booktabs table without a grid",
    pages: [page(1, { vectors: { hRules: 3, vRules: 0 }, extra: { mathBits: 0, tableBits: tableWord("booktabs"), encodingCounts: counts({ ruleTables: 1 }) } })],
  },
  {
    name: "encodings: outlined text grid (vision table)",
    pages: [page(1, { vectors: { hRules: 0, vRules: 0 }, extra: { mathBits: 0, tableBits: tableWord("outlined-text-grid"), encodingCounts: counts() } })],
  },
  {
    name: "encodings: raster math strips",
    pages: [page(1, { vectors: { hRules: 0, vRules: 0 }, images: { mathStrips: 3 }, extra: { mathBits: mathWord("raster-strips"), tableBits: 0, encodingCounts: counts({ mathStrips: 2 }) } })],
  },
  {
    name: "encodings: math grid on a ruled page",
    pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 }, extra: { mathBits: mathWord("math-matrix"), tableBits: tableWord("math-grid"), encodingCounts: counts() } })],
  },
  {
    name: "encodings: analysis truncated",
    pages: [page(1, { extra: { mathBits: 0, tableBits: tableWord("analysis-truncated"), encodingCounts: counts() } })],
  },
  {
    name: "encodings on a low-confidence page",
    pages: [page(1, { vectors: { hRules: 0, vRules: 0 }, extra: { parseWarnings: ["xref-repaired-earlier"], mathBits: 0, tableBits: tableWord("outlined-text-grid"), encodingCounts: counts() } })],
  },
  {
    name: "furniture: a logo on 3 of 15 pages",
    pages: Array.from({ length: 15 }, (_, i) => page(i + 1, {
      vectors: { hRules: 0, vRules: 0 },
      item: { obj: i < 3 ? 42 : 100 + i, bbox: [36, 36, 236, 186], coverage: 0.062, px: [800, 600] },
    })),
  },
  {
    name: "walker grids unknown, settled from facts",
    pages: [page(1, { vectors: { grids: [THIN_TABLE], gridsTruncated: false, unlistedRuledGrids: 0 } }), page(2, { vectors: { grids: [], gridsTruncated: true } })],
    walker: { version: "pdf-layout-facts@1", pages: [
      { pageNumber: 1, known: true, images: [], tables: [], words: 410, grids: null, tableCoverage: null },
      { pageNumber: 2, known: true, images: [], tables: [], words: 410, grids: null, tableCoverage: null },
    ] },
  },
  {
    name: "walker grids known beside facts",
    pages: [page(1, { vectors: { grids: [], gridsTruncated: false } })],
    walker: { version: "pdf-layout-facts@1", pages: [{ pageNumber: 1, known: true, images: [], tables: [], words: 410, grids: [{ rows: 7, columns: 3, coverage: 0.3 }], tableCoverage: 0.3 }] },
  },
];

/** Native probe rows (the router's host probe), for the router-only parity. */
function probeRow(pageNumber: number, extra: Partial<ProbeRow> = {}): ProbeRow {
  return {
    pageNumber, pageCount: 1, charCount: 2000, wordCount: 330, textCoverage: 0.4, fontCount: 2, unmappedGlyphRatio: 0, mathGlyphRatio: 0,
    tableRuleScore: 0, imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false, vectorDrawingCount: 4, uncoveredVectorRatio: 0,
    garbled: false, textLayerStatus: "ok", imageCount: 0, textFacts: { wordCount: 330, imageCount: 0, imageCoverage: 0, textLayerStatus: "ok" },
    images: [], smallestFontPt: 9, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 4, probeEngine: "native-pdf@test",
    ...extra,
  };
}
const PROBE_ROWS: Array<{ name: string; row: ProbeRow }> = [
  { name: "probe: healthy text", row: probeRow(1) },
  { name: "probe: ruled table", row: probeRow(1, { tableRuleScore: 6 }) },
  { name: "probe: weak rules", row: probeRow(1, { tableRuleScore: 1 }) },
  { name: "probe: math glyphs", row: probeRow(1, { mathGlyphRatio: 0.02 }) },
  { name: "probe: garbled", row: probeRow(1, { garbled: true, unmappedGlyphRatio: 0.2, textLayerStatus: "suspect" }) },
  { name: "probe: unmapped only", row: probeRow(1, { unmappedGlyphRatio: 0.12 }) },
  { name: "probe: inset image", row: probeRow(1, { imageCount: 1, imageCoverage: 0.3, largestImageCoverage: 0.3, images: [{ bbox: [72, 300, 540, 600], coverage: 0.3 }], textFacts: { wordCount: 330, imageCount: 1, imageCoverage: 0.3, textLayerStatus: "ok" } }) },
  { name: "probe: OCR layer verified", row: probeRow(1, { textLayerStatus: "ocr-layer", fullPageImage: true, imageCoverage: 1, largestImageCoverage: 1, imageCount: 1,
    images: [{ bbox: [0, 0, 612, 792], coverage: 1 }], textFacts: { wordCount: 330, imageCount: 1, imageCoverage: 1, textLayerStatus: "ocr-layer" }, ocrLayerCheck: { agreement: 0.97, tokens: 40, cpuMs: 900, wallMs: 950 } }) },
  { name: "probe: locked", row: { ...probeRow(1), locked: true, pageNumber: 0, pageCount: 0, textLayerStatus: "unknown", unusualFeatures: ["encrypted-user-password"], needsAttention: true } },
];

// ── Decisions ──

const round = (n: number) => Math.round(n * 1000) / 1000;

function routerDecisions(input: PageInput) {
  const verdict = freeTrustVerdict(input);
  const needs = needsFromFeatures(input);
  return {
    input: {
      status: input.textFacts.textLayerStatus, words: input.features.native.wordCount, tableRuleScore: input.features.native.tableRuleScore,
      mathGlyphRatio: input.features.native.mathGlyphRatio, garbled: input.features.native.garbled, unmapped: input.features.native.unmappedGlyphRatio,
      imageCoverage: input.features.raster.imageCoverage, fullPageImage: input.features.raster.fullPageImage, images: input.images.length,
      size: [input.features.geometry.widthPt, input.features.geometry.heightPt], features: input.unusualFeatures ?? [],
    },
    trust: verdict,
    needs: { trust: round(needs.pTrustTextLayer), math: round(needs.pNeedsMath), tables: round(needs.pNeedsTables), scanned: round(needs.pScanned), blank: needs.blank },
    roles: rolesForPage(needs, DEFAULT_PLANNER_CONFIG).map((role) => `${role.role}:${role.scope.kind}`),
    triage: shouldTriage([input]).reason,
    insetCandidates: insetGateCandidates(input).length,
    renderNeeded: assessAttention(input).renderNeeded,
  };
}

async function routerFromFacts(jsonlText: string, pageCount: number) {
  const runner = createDopplerFactsProbeRunner(async () => new TextEncoder().encode(jsonlText));
  const result = await runner({ documentId: "doc", pageCount });
  if (result.status !== "ok") return { unavailable: result.reason };
  // The router's own path (route-pages): page evidence from the facts, then its page input.
  const inputs = await pageInputsFromEvidence(result.pages, null, "pdf", { pageCount });
  return Object.fromEntries(inputs.map((input) => [input.features.pageNumber, routerDecisions(input)]));
}

function classify(layout: ReturnType<typeof sandboxedPdfLayoutFacts>, texts: string[], pageCount: number, encodingRouting: boolean) {
  const surface = buildAdaptiveRoutingDecisionSurface({
    documentId: "doc", filename: "doc.pdf", text: texts.map((t, i) => `<!-- page ${i + 1} -->\n${t}`).join("\n\n"), pageCount,
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/doc.json" }, routingV2: true, encodingRouting,
    ...(layout ? { pageLayout: layout } : {}),
  });
  return Object.fromEntries(surface.pages.map((p) => [p.pageNumber, {
    route: p.route, hint: p.extractorHint, read: p.ocrDecision?.authorized ?? false, signals: [...p.signals].sort(),
  }]));
}

async function factsCase(c: FactsCase, mode: "use" | "store") {
  vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
  const pageCount = Math.max(1, c.pages.length);
  const facts = jsonl([docLine({ pageCount, ...c.doc }), ...c.pages, runLine({ pagesEmitted: c.pages.length })]);
  const texts = c.texts ?? c.pages.map((p) => prose(Math.min(400, ((p.text as Line | undefined)?.wordCount as number | undefined) ?? 0)));
  while (texts.length < pageCount) texts.push("");
  const job: SandboxedPdfJob = { input: "/in.pdf", output: "/out.md" };
  acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", pageFacts: facts, ...(c.walker ? { layoutFacts: c.walker } : {}) }, pageCount, { glyphs: c.glyphs === true });
  const layout = sandboxedPdfLayoutFacts(job);
  const parsed = parseDopplerPageFacts(facts, { pageCount });
  const doc = parsed.ok ? parsed.facts : undefined;
  const lexical = new Map(texts.map((t, i) => [i + 1, /\w/.test(t)]));
  const out: Record<string, unknown> = {
    layout: layout ? Object.fromEntries([...layout].map(([n, p]) => [n, {
      words: p.words, grids: p.grids, gridsUnknown: p.gridsUnknown ?? false, tableCoverage: p.tableCoverage,
      images: p.images?.map((image) => ({ coverage: image.coverage, repeated: image.repeated, wordsInside: image.wordsInside })) ?? null,
      textLayer: p.textLayer ?? null, size: p.widthPt ? [p.widthPt, p.heightPt] : null, encodings: p.encodings ? { table: p.encodings.table, math: p.encodings.math } : null,
    }])) : null,
    classify: classify(layout, texts, pageCount, false),
    classifyEncodings: classify(layout, texts, pageCount, true),
    costRoutes: documentCostStats(layout, pageCount).routes,
    costRoutesLexical: documentCostStats(layout, pageCount, undefined, lexical).routes,
  };
  if (mode === "use") {
    out.router = await routerFromFacts(facts, pageCount);
    out.pageImageEvidence = pageImageEvidenceFromDopplerFacts({ facts: doc, pageCount, pageTexts: texts });
    out.pageFactRows = pageFactRowsFromDopplerFacts({ facts: doc, pageCount, pageTexts: texts, documentId: "doc", runId: "run" })
      .map((row) => ({ page: row.pageNumber, words: row.wordCount, images: row.imageCount, textBytes: row.textBytes }));
    out.routingFacts = doc ? Object.fromEntries(routingFactsWithDopplerFacts(layout, doc) ?? []) : null;
    out.chartCandidates = doc ? candidatesFromPageFacts(doc, new Set()).counts : null;
  }
  return out;
}

describe("page evidence decision parity", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("matches the committed decision snapshot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result: Record<string, unknown> = {};
    for (const c of CASES) {
      result[c.name] = { use: await factsCase(c, "use"), store: await factsCase(c, "store") };
    }
    for (const { name, row } of PROBE_ROWS) result[name] = routerDecisions(await pageInputFromProbeRow(row, null, "pdf"));
    // Walker-only layout (no page facts): a null grid there is the walker's own answer.
    const walkerJob: SandboxedPdfJob = { input: "/in.pdf", output: "/out.md" };
    acceptSandboxedPdfResult(walkerJob, { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages: [
      { pageNumber: 1, known: true, images: [], tables: [], words: 300, grids: null, tableCoverage: null },
      { pageNumber: 2, known: true, images: [], tables: [], words: 300, grids: [{ rows: 7, columns: 3, coverage: 0.2 }], tableCoverage: 0.2 },
      { pageNumber: 3, known: true, images: null, tables: null, words: null, grids: null, tableCoverage: null },
    ] } }, 3);
    const walker = sandboxedPdfLayoutFacts(walkerJob);
    const texts = [prose(300), prose(300), prose(300)];
    result["walker only"] = { classify: classify(walker, texts, 3, false), costRoutes: documentCostStats(walker, 3).routes };
    await expect(JSON.stringify(result, null, 1) + "\n").toMatchFileSnapshot("./__snapshots__/page-evidence-parity.json");
  });
});
