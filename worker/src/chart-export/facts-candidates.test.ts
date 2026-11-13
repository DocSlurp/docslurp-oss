import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultChartExportConfig, expectedBillableVisuals, type BBox, type ChartExportConfig } from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { parseDopplerPageFacts, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { testCatalog } from "../routing/testing.js";
import { docLine, figurePage, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";
import { chartExportCharges } from "./billing.js";
import { annotateImageObjects, candidatesFromPageFacts, CHART_FACTS_FORMAT, CHART_FACTS_SLOT, FACTS_CANDIDATE_RULES, loadChartFacts } from "./facts-candidates.js";
import { ChartExportSession } from "./session.js";
import { runChartExportPass, type PageImage } from "./stage.js";
import { setDeterministicVisualExtractor, type ChartModelClient, type ChartModelRequest, type VisualCandidate } from "./types.js";

const BAR_SPEC = {
  kind: "chart",
  chartType: "bar",
  title: "Quarterly revenue",
  yAxis: { label: "Revenue", unit: "USD m", scale: "linear", min: null, max: null },
  series: [{ name: "Revenue", points: [{ x: "Q1", y: 10 }, { x: "Q2", y: 12.5 }, { x: "Q3", y: 15 }] }],
  summary: "Revenue grows every quarter, from 10 to 15.",
};

const config = (extra: Partial<ChartExportConfig> = {}): ChartExportConfig => ({ ...defaultChartExportConfig, enabled: true, formats: ["description", "csv"], ...extra });

function fakeClient(answers: Array<string | Error>): ChartModelClient & { requests: ChartModelRequest[] } {
  const requests: ChartModelRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error("no scripted answer");
      if (next instanceof Error) throw next;
      return { text: next, model: "test/model", provider: "test", inputTokens: 1000, outputTokens: 200, costCents: 0.05, latencyMs: 10, finishReason: "stop" };
    },
  };
}

function parse(lines: Array<Record<string, unknown>>, pageCount: number): DopplerPageFactsDocument {
  const result = parseDopplerPageFacts(jsonl([docLine({ pageCount }), ...lines, runLine({ pagesEmitted: pageCount })]), { pageCount });
  if (!result.ok) throw new Error(result.reason);
  return result.facts;
}

const LOGO_BOX = [36, 36, 236, 136];
/** A text page carrying one mid-size image (`obj`), no figure drawing. */
function imagePage(page: number, obj: number, box = LOGO_BOX): Record<string, unknown> {
  const base = textPage(page);
  return {
    ...base,
    images: {
      ...(base.images as object), imageCount: 1,
      items: [{ index: 1, bbox: box, coverage: 0.05, px: [400, 200], dpi: [144, 144], filter: "flate", bpc: 8, colorSpace: "rgb",
        imageMask: false, softMask: false, mask: false, decode: false, inline: false, obj, copy: "decode" }],
    },
  };
}

/** A page of decorative rules: a thin swoosh cluster and many rules, mostly away from words. */
function rulesPage(page: number): Record<string, unknown> {
  const base = textPage(page);
  return {
    ...base,
    vectors: {
      paths: 60, filled: 0, stroked: 60, coverage: 0.08, uncoveredRatio: 0.9, hRules: 40, vRules: 0, ruleGridScore: 0, shadings: 0, patterns: 0,
      clips: 0, figureClusters: 1, clusters: [{ bbox: [36, 700, 576, 706], paths: 12, curves: 6, segments: 30 }], clustersTruncated: false, limitHit: false,
    },
  };
}

describe("candidatesFromPageFacts", () => {
  it("nominates a vector chart as a crop of its cluster, without a keyword vote", () => {
    const facts = parse([figurePage(1)], 1);
    const { candidates, counts } = candidatesFromPageFacts(facts, new Set());
    expect(candidates).toEqual([{ id: "p1-v0", pageNumber: 1, imageIndex: null, bbox: { x: 72, y: 100, width: 468, height: 400 }, kind: null, detectedBy: "page-facts-vector" }]);
    expect(counts.vectorStrong).toBe(1);
  });

  it("never nominates decorative rules or a ruled text page, keyword vote or not", () => {
    const facts = parse([rulesPage(1), textPage(2)], 2);
    expect(candidatesFromPageFacts(facts, new Set([1, 2])).candidates).toEqual([]);
  });

  it("never nominates a scan page", () => {
    const facts = parse([scanPage(1)], 1);
    const { candidates, counts } = candidatesFromPageFacts(facts, new Set([1]));
    expect(candidates).toEqual([]);
    expect(counts.scanPages).toBe(1);
  });

  it("nominates an image region only with the keyword vote, carrying its object number", () => {
    const facts = parse([imagePage(1, 7)], 1);
    expect(candidatesFromPageFacts(facts, new Set()).candidates).toEqual([]);
    expect(candidatesFromPageFacts(facts, new Set([1])).candidates).toEqual([
      { id: "p1-f1", pageNumber: 1, imageIndex: null, bbox: { x: 36, y: 36, width: 200, height: 100 }, kind: null, detectedBy: "page-facts-image", asset: { obj: 7, clean: true } },
    ]);
  });

  it("treats an image object on many pages as furniture (a logo), never a candidate", () => {
    const facts = parse(Array.from({ length: 20 }, (_, i) => imagePage(i + 1, 99)), 20);
    const keyword = new Set(Array.from({ length: 20 }, (_, i) => i + 1));
    const { candidates, counts } = candidatesFromPageFacts(facts, keyword);
    expect(candidates).toEqual([]);
    expect(counts.furniture).toBe(20);
  });

  it("needs the keyword vote for a cluster on a page with a middling uncovered ratio", () => {
    const weak = figurePage(1, { vectors: { ...(figurePage().vectors as object), uncoveredRatio: 0.4, coverage: 0.2 } });
    const facts = parse([weak], 1);
    expect(candidatesFromPageFacts(facts, new Set()).candidates).toEqual([]);
    expect(candidatesFromPageFacts(facts, new Set([1])).counts.vectorVoted).toBe(1);
    expect(0.4).toBeLessThan(FACTS_CANDIDATE_RULES.strongUncoveredRatio);
  });
});

// ---- Document pass -----------------------------------------------------------------------------------------------

function memoryStorage() {
  const objects = new Map<string, unknown>();
  const bucket = "test-bucket";
  return {
    objects, bucket,
    uri: (key: string) => `s3://${bucket}/${key}`,
    async getJson(key: string) {
      if (!objects.has(key)) throw new Error(`missing ${key}`);
      return structuredClone(objects.get(key));
    },
    async putJson(key: string, value: unknown) { objects.set(key, structuredClone(value)); },
    async putBytes(key: string, bytes: Buffer) { objects.set(key, bytes.toString("utf8")); },
    async deleteKeys() { /* unused */ },
  };
}

function seed(storage: ReturnType<typeof memoryStorage>, pageCount: number, factsLines?: Array<Record<string, unknown>>) {
  const markdown = Array.from({ length: pageCount }, (_, i) => `Page ${i + 1} text.`).join("\f");
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text: markdown, pageCount, extractor: "test" });
  const contract = buildExtractionContract({ documentId: "doc-1", markdown, extractor: "test", strategy: "test", extractionTimeMs: 1, pageCount, canonicalDocument: canonical });
  storage.objects.set("u/run/canonical.json", canonical);
  storage.objects.set("u/run/contract.json", contract);
  const ledger = DocumentArtifactLedger.create({});
  ledger.recordDocument("doc-1", "canonical-document", storage.uri("u/run/canonical.json"));
  ledger.recordDocument("doc-1", "extraction-contract", storage.uri("u/run/contract.json"));
  if (factsLines) {
    storage.objects.set("u/run/facts.json", { format: CHART_FACTS_FORMAT, jsonl: jsonl([docLine({ pageCount }), ...factsLines, runLine({ pagesEmitted: pageCount })]) });
    ledger.recordDocument("doc-1", CHART_FACTS_SLOT, storage.uri("u/run/facts.json"));
  }
  return ledger;
}

function rasters() {
  const pages: number[] = [];
  const crops: BBox[] = [];
  return {
    pages, crops,
    pageImage: async (page: number): Promise<PageImage> => { pages.push(page); return { path: `/p${page}.png`, mimeType: "image/png", release: async () => undefined }; },
    cropImage: async (image: PageImage, bbox: BBox): Promise<PageImage> => { crops.push(bbox); return { ...image, path: `${image.path}.crop`, release: async () => undefined }; },
  };
}

describe("chart export with page facts", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    restore?.();
    restore = null;
  });
  const noExtractor = () => { const previous = setDeterministicVisualExtractor(async () => ({ partials: [] })); restore = () => setDeterministicVisualExtractor(previous); };

  it("without facts, behaves as before: a keyword-only page is low confidence and nothing is read", async () => {
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    noExtractor();
    const storage = memoryStorage();
    const client = fakeClient([]);
    const r = rasters();
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const result = await runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
      storage: storage as never, ledger: seed(storage, 3), routedPlan: null, legacyPages: [{ pageNumber: 3, route: "chart-or-figure" }], ...r,
    });
    expect(result.lowConfidence).toBe(1);
    expect(result.facts).toBeUndefined();
    expect(client.requests).toHaveLength(0);
    expect(r.pages).toEqual([]);
  });

  it("refuses facts that do not fit the host's page count or format: today's behaviour", async () => {
    const storage = memoryStorage();
    const ledger = seed(storage, 1, [figurePage(1)]);
    expect(await loadChartFacts(storage as never, ledger, { id: "doc-1", pageCount: 1 })).not.toBeNull();
    storage.objects.set("u/run/facts.json", { format: "other", jsonl: "" });
    expect(await loadChartFacts(storage as never, ledger, { id: "doc-1", pageCount: 1 })).toBeNull();
    storage.objects.set("u/run/facts.json", { format: CHART_FACTS_FORMAT, jsonl: "x".repeat(10_000_000) });
    expect(await loadChartFacts(storage as never, ledger, { id: "doc-1", pageCount: 1 })).toBeNull();
  });

  it("in `store` mode facts nominate nothing (routing needs `use`)", async () => {
    noExtractor();
    const storage = memoryStorage();
    const client = fakeClient([]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const result = await runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 1 }, run: { id: "run", storagePrefix: "u/run" },
      storage: storage as never, ledger: seed(storage, 1, [figurePage(1)]), routedPlan: null, legacyPages: [], ...rasters(),
    });
    expect(result.stats.charts).toBe(0);
    expect(client.requests).toHaveLength(0);
  });

  it("reads a vector chart as a crop of its cluster, never the whole page, and charges that one read", async () => {
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    noExtractor();
    const storage = memoryStorage();
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const r = rasters();
    const cfg = config();
    const session = new ChartExportSession({ documentId: "doc-1", config: cfg, catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const result = await runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
      storage: storage as never, ledger: seed(storage, 3, [textPage(1), scanPage(2), figurePage(3)]), routedPlan: null, legacyPages: [], ...r,
    });
    expect(r.crops).toEqual([{ x: 72, y: 100, width: 468, height: 400 }]);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.image.path).toBe("/p3.png.crop");
    expect(session.pageExportsLeft()).toBe(true);
    expect(result.facts).toMatchObject({ vectorStrong: 1, scanPages: 1 });
    expect(result.stats).toMatchObject({ charts: 1, exported: 1 });
    const charges = chartExportCharges({ attempts: [...session.modelReads.values()], calls: session.calls, config: cfg });
    expect(charges.map((c) => c.visualId)).toEqual(["p3-v0"]);
  });

  it("reads a repeated image once across 20 pages: one call, one charge, 20 placements, estimate of one", async () => {
    noExtractor();
    const storage = memoryStorage();
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const r = rasters();
    const cfg = config();
    const session = new ChartExportSession({ documentId: "doc-1", config: cfg, catalog: () => testCatalog(), client, recordUsage: () => undefined });
    // Image routing lists the same picture on every page (no hash in common here: the facts' object ties them).
    session.addCandidates(Array.from({ length: 20 }, (_, i): VisualCandidate => ({
      id: `p${i + 1}-o0`, pageNumber: i + 1, imageIndex: null, occurrence: 0, bbox: { x: 36, y: 36, width: 200, height: 100 }, kind: null, detectedBy: "image-routing",
    })));
    const result = await runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 20 }, run: { id: "run", storagePrefix: "u/run" },
      storage: storage as never, ledger: seed(storage, 20, Array.from({ length: 20 }, (_, i) => imagePage(i + 1, 99))), routedPlan: null, legacyPages: [], ...r,
    });
    expect(client.requests).toHaveLength(1);
    expect(r.pages).toEqual([1]);
    expect(session.visuals).toHaveLength(20);
    expect(new Set(session.visuals.map((v) => v.pageNumber)).size).toBe(20);
    expect(session.modelReads.size).toBe(1);
    expect(chartExportCharges({ attempts: [...session.modelReads.values()], calls: session.calls, config: cfg })).toHaveLength(1);
    expect(result.dedupe).toEqual({ groups: 1, placements: 20, readsAvoided: 19 });
    expect(result.stats).toMatchObject({ charts: 1, exported: 20, bySource: { vision: 1 } });
    expect(expectedBillableVisuals({ config: cfg, pages: 20, documents: 1, stats: result.stats })).toMatchObject({ low: 1, high: 1, basis: "measured" });
  });

  it("groups by content hash, and a read the provider never answered does not stand for the group", async () => {
    const client = fakeClient([new Error("provider down"), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const sha256 = "b".repeat(64);
    const placements = [1, 2, 3].map((page): VisualCandidate => ({
      id: `p${page}-o0`, pageNumber: page, imageIndex: null, occurrence: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, kind: "chart", detectedBy: "image-routing", asset: { sha256, clean: true },
    }));
    session.addCandidates(placements);
    const image = { path: "/x.png", mimeType: "image/png" };
    for (const candidate of session.candidates) await session.exportWithImage(candidate, image);
    // Page 1's call failed before any answer: page 2 reads for itself, page 3 reuses page 2's read.
    expect(client.requests).toHaveLength(2);
    expect([...session.modelReads.keys()]).toEqual(["p2-o0"]);
    expect(session.visuals.map((v) => v.id)).toEqual(["p2-o0", "p3-o0"]);
    expect(session.dedupeStats()).toEqual({ groups: 1, placements: 3, readsAvoided: 1 });
  });

  it("a reused read whose answer was not a visual exports nothing for its placements and charges only the read made", async () => {
    const client = fakeClient([`{"kind":"none"}`]);
    const cfg = config();
    const session = new ChartExportSession({ documentId: "doc-1", config: cfg, catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates([1, 2].map((page): VisualCandidate => ({
      id: `p${page}-f1`, pageNumber: page, imageIndex: null, bbox: { x: 0, y: 0, width: 100, height: 100 }, kind: null, detectedBy: "page-facts-image", asset: { obj: 5, clean: true },
    })));
    const image = { path: "/x.png", mimeType: "image/png" };
    for (const candidate of session.candidates) await session.exportWithImage(candidate, image);
    expect(client.requests).toHaveLength(1);
    expect(session.visuals).toEqual([]);
    expect(chartExportCharges({ attempts: [...session.modelReads.values()], calls: session.calls, config: cfg })).toHaveLength(1);
  });

  const placed = (page: number, extra: Partial<VisualCandidate> = {}): VisualCandidate => ({
    id: `p${page}-o0`, pageNumber: page, imageIndex: null, occurrence: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, kind: "chart", detectedBy: "image-routing", asset: { sha256: "c".repeat(64), clean: true }, ...extra,
  });
  const image = { path: "/x.png", mimeType: "image/png" };

  it("never ties a chart to a background image under it: vector clusters, regions and loose matches take no obj", () => {
    // A full-bleed background (same obj on every page) behind a chart on each page.
    const background = (page: number) => imagePage(page, 500, [0, 0, 612, 792]);
    const facts = parse([background(1), background(2)], 2);
    const candidates: VisualCandidate[] = [
      { id: "p1-v0", pageNumber: 1, imageIndex: null, bbox: { x: 40, y: 40, width: 560, height: 700 }, kind: null, detectedBy: "page-facts-vector" },
      { id: "p2-a0", pageNumber: 2, imageIndex: null, bbox: { x: 0, y: 0, width: 612, height: 792 }, kind: "chart", detectedBy: "router-region" },
      { id: "p2-o0", pageNumber: 2, imageIndex: null, occurrence: 0, bbox: { x: 40, y: 40, width: 560, height: 700 }, kind: null, detectedBy: "image-routing" },
      { id: "p1-o0", pageNumber: 1, imageIndex: null, occurrence: 0, bbox: { x: 0, y: 0, width: 612, height: 790 }, kind: null, detectedBy: "image-routing" },
    ];
    annotateImageObjects(candidates, facts);
    expect(candidates.map((c) => c.asset?.obj)).toEqual([undefined, undefined, undefined, 500]);
  });

  it("a whole-page read (a crop that failed) never stands for the picture", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates([placed(1), placed(2)]);
    await session.exportWithImage(session.candidates[0]!, image, undefined, { wholePage: true });
    await session.exportWithImage(session.candidates[1]!, image);
    expect(client.requests).toHaveLength(2);
    expect(session.dedupeStats().readsAvoided).toBe(0);
  });

  it("concurrent placements wait for the group's read; after an unanswered read one reads again within the cap", async () => {
    const client = fakeClient([new Error("provider down"), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined, limits: { maxModelReads: 1 } });
    session.addCandidates([1, 2, 3, 4].map((page) => placed(page)));
    await Promise.all(session.candidates.map((c) => session.exportWithImage(c, image)));
    expect(client.requests).toHaveLength(2);
    expect(session.modelReads.size).toBe(1);
    expect(session.visuals).toHaveLength(3);
    expect(session.dedupeStats()).toMatchObject({ readsAvoided: 2 });
  });

  it("with page facts off, repeated pictures are read as before (no reuse)", async () => {
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "off");
    const client = fakeClient([JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates([placed(1), placed(2)]);
    for (const c of session.candidates) await session.exportWithImage(c, image);
    expect(client.requests).toHaveLength(2);
    expect(session.stats().charts).toBe(2);
  });

  it("without the facts' word that nothing is drawn over it, a repeated hash is read per placement (unchanged)", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates([placed(1, { asset: { sha256: "d".repeat(64) } }), placed(2, { asset: { sha256: "d".repeat(64) } })]);
    for (const c of session.candidates) await session.exportWithImage(c, image);
    expect(client.requests).toHaveLength(2);
  });

  it("one image under different overlays (a cluster drawn over it) is not one picture", () => {
    const overlay = (page: number) => {
      const p = imagePage(page, 77);
      return { ...p, vectors: { ...(p.vectors as object), clusters: [{ bbox: [50, 50, 200, 120], paths: 30, curves: 10, segments: 40 }], figureClusters: 1 } };
    };
    const facts = parse([overlay(1), imagePage(2, 77)], 2);
    const candidates = [1, 2].map((page): VisualCandidate => ({
      id: `p${page}-o0`, pageNumber: page, imageIndex: null, occurrence: 0, bbox: { x: 36, y: 36, width: 200, height: 100 }, kind: null, detectedBy: "image-routing", asset: { sha256: "e".repeat(64) },
    }));
    annotateImageObjects(candidates, facts);
    expect(candidates.map((c) => c.asset)).toEqual([
      { sha256: "e".repeat(64), obj: 77, clean: false },
      { sha256: "e".repeat(64), obj: 77, clean: true },
    ]);
  });

  it("does not place facts boxes on a page whose CropBox differs from its MediaBox", () => {
    const shifted = figurePage(1, { geometry: { widthPt: 612, heightPt: 792, rotation: 0, userUnit: 1, mediaBox: [0, 0, 612, 792], cropBox: [36, 36, 576, 756] } });
    expect(candidatesFromPageFacts(parse([shifted], 1), new Set()).candidates).toEqual([]);
  });
});
