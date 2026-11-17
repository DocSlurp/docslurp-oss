import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryCheckpointStore } from "../pipeline/checkpoint-store-memory.js";
import { applyLadderLimits, defaultPipelineFeatures, documentLadderPolicy, type AdaptivePageRoutingEntry } from "@docslurp/shared";

import type { Document } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { VisionExtractStage, legacyPageHints } from "../stages/vision-extract.js";
import { selectLegacyVisionPages, TABLE_LEAK_ONLY_SIGNAL } from "../stages/classify-route.js";
import { LADDER_PLAN_KEY, ladderKeepsImageUnread, ladderNeeds, readLadderPin, recordExtractEscalatedPages, visionLadderSelection, inheritExtractEscalatedPages, extractEscalatedPages } from "../routing/auto-ladder.js";
import { recordOcrFailedPages } from "../ocr/mode.js";
import type { Config } from "../config.js";
import { RenderImagesStage } from "../stages/render-images.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { embedPageImages } from "../stages/page-embed.js";
import { DocumentMapStage } from "../stages/document-map.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SCAN = "ocr-authorized:no-native-text";

/** A triage entry: `scan` (no native text), `table` (table leak, has text), `figure` (chart page, has text). */
function page(pageNumber: number, kind: "scan" | "table" | "figure" | "text", confidence = 0.8): AdaptivePageRoutingEntry {
  const base = { pageNumber, confidence, textDensityScore: kind === "scan" ? 0 : 0.5, signals: [], extractorHint: "cheap-text" as const, specializedContent: [] };
  if (kind === "text") return { ...base, route: "straightforward-text", ocrDecision: { authorized: false, confidence: 0.9, signals: [] } };
  if (kind === "scan") return { ...base, route: "handwriting-or-degraded", ocrDecision: { authorized: true, confidence, signals: [SCAN] } };
  if (kind === "table") return { ...base, route: "table-heavy", ocrDecision: { authorized: true, confidence, signals: [TABLE_LEAK_ONLY_SIGNAL] } };
  return { ...base, route: "chart-or-figure", ocrDecision: { authorized: true, confidence, signals: ["ocr-authorized:figure-region"] } };
}

function pdf(pageCount: number, id = "doc-1"): Document {
  return { id, userId: "user-1", filename: `${id}.pdf`, mimeType: "application/pdf", pageCount, sourceKey: `${id}.pdf` } as Document;
}

function runState(document: Document, pipeline: Record<string, unknown> = {}): WorkflowState {
  // As the worker loads a run (db/run-ledger.ts): the ladder limits applied.
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", projectId: "proj-1", userId: "user-1", spentCents: 0, storagePrefix: "user-1/run-1",
    pipeline: applyLadderLimits({ ...defaultPipelineFeatures, privacyMode: "standard", ...pipeline } as typeof defaultPipelineFeatures),
  } as never, [document]);
  state.usageLedger.runId = "run-1";
  return state;
}

function stageFor(triage: AdaptivePageRoutingEntry[]) {
  const stage = new VisionExtractStage({} as CommandRunner, {} as ArtifactStore, {} as Config, {} as never);
  const internals = stage as unknown as {
    checkNeedsVision: (document: Document, pageCount: number, state: WorkflowState) => Promise<{
      needed: boolean; selectedPages: number[]; reason: string; hints: ReturnType<typeof legacyPageHints>; ladder?: { summary: Record<string, unknown>; decisions: Array<{ pageNumber: number; rung: string; need: string; cappedBy?: string }> };
    }>;
    loadAdaptiveRouting: (...args: unknown[]) => Promise<unknown>;
    loadRoutedExecution: (...args: unknown[]) => Promise<unknown>;
    visionAllowed: (...args: unknown[]) => Promise<boolean>;
  };
  vi.spyOn(internals, "loadAdaptiveRouting").mockResolvedValue({
    status: "ready", documentComplexity: "mixed", visionPolicy: "selective", dominantRoutes: [], pages: triage,
  });
  vi.spyOn(internals, "loadRoutedExecution").mockResolvedValue(null);
  vi.spyOn(internals, "visionAllowed").mockResolvedValue(true);
  return { stage, internals };
}

/** 10 pages: 3 scans, 2 table-rescue pages and 2 chart pages need a read; 3 are plain text. */
const MIXED: AdaptivePageRoutingEntry[] = [
  page(1, "text"), page(2, "scan", 0.6), page(3, "figure", 0.7), page(4, "table", 0.9), page(5, "text"),
  page(6, "scan", 0.95), page(7, "figure", 0.9), page(8, "table", 0.5), page(9, "scan", 0.4), page(10, "text"),
];

describe("Auto ladder in vision-extract", () => {
  it("changes nothing without limits", async () => {
    const document = pdf(10);
    const { internals } = stageFor(MIXED);
    const state = runState(document);
    const result = await internals.checkNeedsVision(document, 10, state);
    const legacy = selectLegacyVisionPages(MIXED, {});
    expect(result.selectedPages).toEqual(legacy);
    expect(result.hints).toEqual(legacyPageHints(MIXED));
    // Without a limit nothing new is recorded: the stats and manifest keep their shape.
    expect(result.ladder).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["hints", "needed", "reason", "routing", "score", "selectedPages"]);
    // No pin is written without a limit.
    expect(state.artifactLedger.readDocument(document.id, LADDER_PLAN_KEY)).toBeUndefined();
    // The explicit default object behaves identically.
    const explicit = await stageFor(MIXED).internals.checkNeedsVision(document, 10, runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: null } }));
    expect(explicit.selectedPages).toEqual(result.selectedPages);
    expect(explicit.hints).toEqual(result.hints);
  });

  it("maxRung ocr transcribes chart pages with the OCR engine in its VM", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const document = pdf(10);
    const { internals } = stageFor(MIXED);
    const result = await internals.checkNeedsVision(document, 10, runState(document, { ladder: { maxRung: "ocr" } }));
    expect(result.selectedPages).toEqual(selectLegacyVisionPages(MIXED, {}));
    expect([...result.hints.vmOcrPages ?? []].sort((a, b) => a - b)).toEqual([3, 7]);
    expect([...result.hints.figurePages ?? []]).toEqual([]);
    expect(result.ladder?.decisions.filter((decision) => decision.rung === "intelligent")).toEqual([]);
    expect(result.ladder?.summary).toMatchObject({ loweredReader: "ocr-vm" });
  });

  it("maxRung ocr without an OCR reader and with a task prompt leaves chart pages on their text layer", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "off");
    const document = pdf(10);
    const { internals } = stageFor(MIXED);
    const result = await internals.checkNeedsVision(document, 10, runState(document, {
      ladder: { maxRung: "ocr" }, outputSchema: { type: "object", properties: { total: { type: "number" } } },
    }));
    expect(result.selectedPages).not.toContain(3);
    expect(result.selectedPages).not.toContain(7);
    expect(result.selectedPages.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 9]);
  });

  it("an image the ladder keeps unread (multi-frame, under a share) is not read by vision either", async () => {
    const tiff = { ...pdf(1, "fax"), filename: "fax.tiff", mimeType: "image/tiff" } as Document;
    const { internals } = stageFor([page(1, "scan")]);
    const share = await internals.checkNeedsVision(tiff, 1, runState(tiff, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } } }));
    expect(share).toMatchObject({ needed: false, reason: "ladder-kept-image", selectedPages: [] });
    const jpeg = { ...tiff, filename: "photo.jpg", mimeType: "image/jpeg" } as Document;
    expect((await stageFor([page(1, "scan")]).internals.checkNeedsVision(jpeg, 1, runState(jpeg, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } } }))).selectedPages).toEqual([1]);
  });

  it("maxRung fast reads nothing (Fast)", async () => {
    const document = pdf(10);
    const state = runState(document, { ladder: { maxRung: "fast" } });
    expect(state.run.pipeline.quality).toBe("fast");
    const { stage } = stageFor(MIXED);
    expect(await stage.planPageTasks(state)).toEqual([]);
  });

  it("the above-fast share selects pages without text first and fans out only those", async () => {
    const document = pdf(10);
    const { stage, internals } = stageFor(MIXED);
    const state = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.3 } } });
    const result = await internals.checkNeedsVision(document, 10, state);
    expect(result.selectedPages.sort((a, b) => a - b)).toEqual([2, 6, 9]);
    const tasks = await stage.planPageTasks(state);
    expect(tasks.map((task) => task.pageNumber)).toEqual([2, 6, 9]);
    // Capped pages are recorded with the limit that lowered them.
    expect(result.ladder?.decisions.filter((decision) => decision.cappedBy === "share-above-fast").map((decision) => decision.pageNumber)).toEqual([3, 4, 7, 8]);
  });

  it("pages extraction already read count first", async () => {
    const document = pdf(10);
    const { internals } = stageFor(MIXED);
    const state = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.3 } } });
    recordExtractEscalatedPages(state.artifactLedger, document.id, "run-1", [2, 9]);
    const result = await internals.checkNeedsVision(document, 10, state);
    expect(result.selectedPages.sort((a, b) => a - b)).toEqual([2, 6, 9]);
    const state2 = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } } });
    recordExtractEscalatedPages(state2.artifactLedger, document.id, "run-1", [1, 5]);
    expect((await stageFor(MIXED).internals.checkNeedsVision(document, 10, state2)).needed).toBe(false);
  });

  it("holds the share across fan-out of a 20,000-page document, and page tasks outside the pinned plan are not read", async () => {
    const pages = 20_000;
    const triage = Array.from({ length: pages }, (_, index) => page(index + 1, index % 5 === 0 ? "figure" : "scan", (index % 13) / 13));
    const document = pdf(pages);
    const { stage } = stageFor(triage);
    const state = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.05, aboveOcr: 0.01 } } });
    const first = await stage.planPageTasks(state);
    expect(first).toHaveLength(1_000);
    // A second plan (another activity, a retry) is identical.
    const second = await stage.planPageTasks(state);
    expect(second.map((task) => task.pageNumber)).toEqual(first.map((task) => task.pageNumber));
    const pin = state.artifactLedger.readDocument(document.id, LADDER_PLAN_KEY)!;
    expect(JSON.parse(pin).escalated).toHaveLength(1_000);
    expect(JSON.parse(pin).intelligent.length).toBeLessThanOrEqual(200);
    const planned = new Set(first.map((task) => task.pageNumber));
    const outside = Array.from({ length: pages }, (_, index) => index + 1).find((pageNumber) => !planned.has(pageNumber))!;
    const skipped = await stage.runPageTask(state, { ...first[0]!, pageNumber: outside });
    expect(skipped).toMatchObject({ pageNumber: outside, outcome: "ladder-capped" });
    // A page task in a fresh state (no pin persisted by planning) re-plans and refuses the page: never fail-open.
    const fresh = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.05, aboveOcr: 0.01 } } });
    expect(await stage.runPageTask(fresh, { ...first[0]!, pageNumber: outside })).toMatchObject({ outcome: "ladder-capped" });
    // A pin seeded from another run (a reprocess) is ignored.
    const seeded = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.05 } } });
    seeded.artifactLedger.recordDocument(document.id, LADDER_PLAN_KEY, JSON.stringify({ runId: "older-run", escalated: [1], intelligent: [] }));
    expect(readLadderPin(seeded.artifactLedger, document.id, "run-1")).toBeNull();
    expect(await stage.planPageTasks(seeded)).toHaveLength(1_000);
    // A later plan under a looser limit cannot read past the pinned one.
    const looser = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } } });
    looser.artifactLedger.recordDocument(document.id, LADDER_PLAN_KEY, pin);
    expect((await stage.planPageTasks(looser)).map((task) => task.pageNumber)).toEqual(first.map((task) => task.pageNumber));
  });
});

describe("ladder helpers", () => {
  it("classifies needs from triage", () => {
    const needs = ladderNeeds([2, 3, 4], MIXED);
    expect(needs.map((entry) => [entry.pageNumber, entry.need, entry.reason, entry.lacksText])).toEqual([
      [2, "ocr", "no-native-text", true],
      [3, "intelligent", "figure:chart-or-figure", false],
      [4, "ocr", "table-rescue", false],
    ]);
    expect(ladderNeeds([1], [])[0]).toMatchObject({ need: "ocr", reason: "no-page-triage", lacksText: true });
  });

  it("keeps capped pages without native text as page images", () => {
    const state = runState(pdf(10), { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.1 } } });
    const selection = visionLadderSelection({ pipeline: state.run.pipeline, runId: "run-1", documentId: "doc-1", pageCount: 10, triage: MIXED, routingV2: false, ledger: state.artifactLedger });
    expect(selection.plan.escalated).toEqual([6]);
    expect(selection.keepAsImage).toEqual([2, 9]);
  });

  it("keeps multi-frame images unread under an above-fast share; a single-frame image is read", () => {
    const share = documentLadderPolicy({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.1 } } }, 1);
    expect(ladderKeepsImageUnread(share, { filename: "fax.tiff", mimeType: "image/tiff" })).toBe(true);
    expect(ladderKeepsImageUnread(share, { filename: "anim.gif", mimeType: "image/gif" })).toBe(true);
    expect(ladderKeepsImageUnread(share, { filename: "photo.jpg", mimeType: "image/jpeg" })).toBe(false);
    const noShare = documentLadderPolicy({ quality: "auto", ladder: { maxRung: "ocr" } }, 1);
    expect(ladderKeepsImageUnread(noShare, { filename: "fax.tiff", mimeType: "image/tiff" })).toBe(false);
  });

  it("pins, inherits and checks plans per run", () => {
    const state = runState(pdf(4));
    expect(readLadderPin(state.artifactLedger, "doc-1", "run-1")).toBeNull();
    state.artifactLedger.recordDocument("doc-1", LADDER_PLAN_KEY, "not json");
    expect(readLadderPin(state.artifactLedger, "doc-1", "run-1")).toBeNull();
    recordExtractEscalatedPages(state.artifactLedger, "doc-1", "run-1", [3, 1], "hash-1");
    inheritExtractEscalatedPages(state.artifactLedger, "doc-2", "hash-1");
    expect([...extractEscalatedPages(state.artifactLedger, "doc-2", "run-1")]).toEqual([1, 3]);
    // Another run's reads (seeded by a reprocess) do not count against this run.
    expect([...extractEscalatedPages(state.artifactLedger, "doc-2", "run-2")]).toEqual([]);
  });

  it("re-plans around pages whose OCR failed: the budget goes to the next page", async () => {
    const document = pdf(10);
    const state = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.3 } } });
    recordOcrFailedPages(state, document.id, [6]);
    const result = await stageFor(MIXED).internals.checkNeedsVision(document, 10, state);
    expect(result.selectedPages.sort((a, b) => a - b)).toEqual([2, 4, 9]);
  });
});

describe("render-images under the ladder", () => {
  /** MIXED with text on every page but the scans (2, 6, 9). */
  function setup(env: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const document = pdf(10);
    const text = Array.from({ length: 10 }, (_, index) => ([2, 6, 9].includes(index + 1) ? "" : `Page ${index + 1} text.`)).join("\f");
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: document.id, text, pageCount: 10, extractor: "native-pdf" });
    const objects = new Map<string, unknown>([
      ["canonical/doc.json", canonical],
      ["classification/doc.json", {
        status: "ready", documentId: document.id, label: "x", confidence: 1, signals: [], suggestedPlaybook: null,
        documentComplexity: "mixed", dominantRoutes: [], visionPolicy: "selective", specializedContentSummary: [],
        evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical/doc.json", characterCount: 1, pageCount: 10 },
        pages: MIXED,
      }],
    ]);
    const getJson = vi.fn(async (key: string) => structuredClone(objects.get(key)));
    const storage = { bucket: "bucket", uri: (key: string) => `s3://bucket/${key}`, getJson } as unknown as ArtifactStore;
    const state = runState(document, { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.1 } } });
    state.artifactLedger.recordDocument(document.id, "canonical-document", "s3://bucket/canonical/doc.json");
    state.artifactLedger.recordDocument(document.id, "classification", "s3://bucket/classification/doc.json");
    const stage = new RenderImagesStage({} as never, storage);
    const select = (stage as unknown as { selectPages: (s: WorkflowState, d: Document, o?: { shard?: boolean }) => Promise<{
      pageNumbers: number[]; keptAsImage: number[]; unreadPages: number[];
    }> }).selectPages.bind(stage);
    return { document, state, select, getJson };
  }

  it("keeps capped scans as page images under Fast's caps, renders no capped text page, and fails closed without a budget", async () => {
    const { document, state, select } = setup();
    const reserve = vi.fn(async ({ wanted }: { wanted: number }) => wanted);
    const store = memoryCheckpointStore();
    store.budgets.reserveFastPageImageRenders = reserve;
    state.store = store;
    const selected = await select(state, document);
    expect(selected.keptAsImage).toEqual([2, 9]);
    expect(selected.unreadPages).toEqual([]);
    expect(selected.pageNumbers).toEqual([2, 6, 9]);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ wanted: 2 }));
    // The per-run reservation grants one: the other stays unread.
    reserve.mockResolvedValueOnce(1);
    expect(await select(state, document)).toMatchObject({ keptAsImage: [2], unreadPages: [9] });
    // No store to reserve from: nothing is kept (fail closed).
    state.store = undefined;
    expect(await select(state, document)).toMatchObject({ keptAsImage: [], unreadPages: [2, 9], pageNumbers: [6] });
  });

  it("applies the per-document cap, and page-range shards choose no kept pages", async () => {
    const { document, state, select, getJson } = setup({ WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT: "1" });
    state.store = memoryCheckpointStore();
    expect(await select(state, document)).toMatchObject({ keptAsImage: [2], unreadPages: [9] });
    getJson.mockClear();
    const shard = await select(state, document, { shard: true });
    expect(shard.keptAsImage).toEqual([]);
    expect(getJson).not.toHaveBeenCalledWith("canonical/doc.json");
  });
});

describe("reads outside the plan", () => {
  it("page-image embedding refuses under a ladder limit (nothing rendered or charged)", async () => {
    const renderSelectedPages = vi.fn();
    const result = await embedPageImages(
      { rasters: { renderSelectedPages }, usage: { record: vi.fn() } } as never,
      { document: pdf(4), pages: [1, 2], run: { id: "run-1", projectId: "proj-1", pipeline: { ...defaultPipelineFeatures, ladder: { maxRung: "ocr" } } } } as never,
    );
    expect(result).toMatchObject({ embeddedPages: [], stoppedBy: "quality-fast" });
    expect(renderSelectedPages).not.toHaveBeenCalled();
  });

  it("the document map's siphon OCR reads no page under an above-fast share", async () => {
    const stage = new DocumentMapStage({} as never, {} as ArtifactStore, {} as CommandRunner, {} as Config);
    const renderSelectedPages = vi.fn();
    (stage as unknown as { rasters: unknown }).rasters = { renderSelectedPages };
    const state = runState(pdf(10), { ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } } });
    const ocr = await (stage as unknown as { ocrPages: (args: unknown) => Promise<{ pageTexts: string[]; costCents: number }> })
      .ocrPages({ document: pdf(10), first: 1, last: 3, state });
    expect(ocr).toEqual({ pageTexts: ["", "", ""], costCents: 0 });
    expect(renderSelectedPages).not.toHaveBeenCalled();
  });
});
