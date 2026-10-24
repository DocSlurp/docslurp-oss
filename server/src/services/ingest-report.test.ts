import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENROUTER_VISION_MODEL, defaultPipelineFeatures, visionModelCatalogById, ingestReportSchema, mergePipelineFeatures, requestsIngestReport, ingestReportFocusPages, type PipelineFeatures } from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("./usage-attribution.js", () => ({ workspaceRunsUsageCost: vi.fn(async () => ({ costCents: 0, billedCostCents: 0, computeEstimated: false })) }));

const {
  applyRecommendationPatch,
  buildIngestReport,
  effectiveVisionPageCap,
  patchHolds,
  summarizeIngestReport,
} = await import("./ingest-report.js");
type Input = Parameters<typeof buildIngestReport>[0];

const pipeline = (overrides: Record<string, unknown> = {}): PipelineFeatures =>
  mergePipelineFeatures(defaultPipelineFeatures, overrides);

function doc(id: string, overrides: Partial<Input["documents"][number]> = {}): Input["documents"][number] {
  return {
    id, filename: `${id}.pdf`, mimeType: "application/pdf", status: "completed", pageCount: 4, fileSize: 400_000,
    runId: "run-1", createdAt: "2026-10-14T00:00:00.000Z", chunkTotal: 0, chunkUnattributed: 0, language: null,
    ...overrides,
  };
}

type PageSpec = { text: number | null; images: number | null; vision?: string | null; chunks?: number };
function pages(documentId: string, specs: PageSpec[]): Input["pages"] {
  return specs.map((spec, index) => ({
    documentId, pageNumber: index + 1, hasFacts: spec.text !== null || spec.images !== null,
    textBytes: spec.text, imageCount: spec.images, visionStatus: spec.vision ?? null,
    chunkCount: spec.chunks ?? 0, chunkBytes: (spec.chunks ?? 0) * 1500,
  }));
}

function build(args: {
  documents: Input["documents"];
  pages?: Input["pages"];
  stages?: Input["stages"];
  pipeline?: PipelineFeatures;
  costCents?: number | null;
  canEdit?: boolean;
  focusPages?: number[];
}) {
  const docs = args.documents.map((entry) => {
    const own = (args.pages ?? []).filter((page) => page.documentId === entry.id);
    return { ...entry, chunkTotal: entry.chunkTotal || own.reduce((sum, page) => sum + page.chunkCount, 0) };
  });
  const report = buildIngestReport({
    workspace: { id: "ws-1", name: "Contracts", pipeline: args.pipeline ?? pipeline() },
    scope: { runId: null, documentIds: null, matchedDocuments: docs.length },
    documents: docs,
    pageDetailDocumentIds: docs.map((entry) => entry.id),
    pages: args.pages ?? [],
    stages: args.stages ?? [],
    runs: [{ id: "run-1", status: "completed", pagesProcessed: docs.reduce((sum, entry) => sum + entry.pageCount, 0), durationMs: 60_000 }],
    costCents: args.costCents ?? 2,
    canEdit: args.canEdit ?? true,
    focusPages: args.focusPages,
    now: new Date("2026-10-14T12:00:00.000Z"),
  });
  // Every report must satisfy the public schema (API, SDK and chat data part).
  expect(ingestReportSchema.parse(report)).toEqual(report);
  return report;
}

describe("ingest report: observed content", () => {
  it("text-only PDF: everything searchable, no recommendations to act on", () => {
    const report = build({
      documents: [doc("text")],
      pages: pages("text", [{ text: 2100, images: 0, chunks: 2 }, { text: 1900, images: 0, chunks: 1 }, { text: 2400, images: 1, chunks: 2 }, { text: 1600, images: 0, chunks: 1 }]),
    });
    expect(report.pages.total).toBe(4);
    expect(report.bytes.avgPerPage).toBe(100_000);
    expect(report.text.avgBytesPerPage).toBe(2000);
    expect(report.text.zeroTextPages).toBe(0);
    expect(report.images.avgPerPage).toBe(0.25);
    expect(report.images.scannedLookingPages).toBe(0);
    expect(report.searchability).toMatchObject({ searchablePages: 4, unsearchablePages: 0 });
    expect(report.extraction.nativeTextPages).toBe(4);
    expect(report.recommendations.filter((rec) => rec.patch)).toEqual([]);
    expect(report.performance.pagesPerMinute).toBe(4);
    expect(report.performance.pagesPerDollar).toBe(200);
    expect(report.text.perPage.counts[INDEX_1K_TO_4K]).toBe(4);
  });

  it("scanned-only PDF with vision off: recommends turning vision on with a cost estimate", () => {
    const report = build({
      pipeline: pipeline({ visionFallback: false }),
      documents: [doc("scan", { pageCount: 3 })],
      pages: pages("scan", [{ text: 0, images: 1 }, { text: 12, images: 1 }, { text: 0, images: 1 }]),
    });
    expect(report.text.zeroTextPages).toBe(2);
    expect(report.text.nearZeroTextPages).toBe(1);
    expect(report.images.scannedLookingPages).toBe(3);
    expect(report.searchability.byReason).toEqual([{ reason: "scanned-no-vision", pages: 3 }]);
    const rec = report.recommendations[0]!;
    expect(rec).toMatchObject({ id: "turn-on-vision", severity: "high", affectedPages: 3, affectedDocuments: 1, reprocessDocumentIds: ["scan"] });
    expect(rec.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: 4 } });
    // Default vision model's catalog price per page.
    const perPage = visionModelCatalogById[DEFAULT_OPENROUTER_VISION_MODEL].estimatedCostPerPageCents;
    expect(rec.cost.centsPer100Pages).toBeCloseTo(perPage * 100, 2);
    // Observed 2¢ / 3 pages for the re-run plus 3 vision pages at the catalog price.
    expect(rec.cost.reprocessCents).toBeCloseTo(2 + 3 * perPage, 2);
    expect(report.config.find((item) => item.key === "visionFallback")?.value).toBe("Off");
  });

  it("mixed PDF where page triage skipped the scans (the time-to-searchable case)", () => {
    const report = build({
      documents: [doc("mixed", { pageCount: 6 })],
      pages: pages("mixed", [
        { text: 1800, images: 0, vision: "not-selected", chunks: 2 },
        { text: 0, images: 1, vision: "not-selected" },
        { text: 2000, images: 0, vision: "not-selected", chunks: 2 },
        { text: 0, images: 1, vision: "not-selected" },
        { text: 0, images: 0, vision: "not-selected" },
        { text: 1700, images: 0, vision: "not-selected" },
      ]),
      stages: [{ documentId: "mixed", stage: "vision-extract", status: "completed", skipped: true, reason: "page-triage-skip", selectedPages: 0, pages: 6, costCents: null, tablePages: null, durationSeconds: null }],
      focusPages: [4],
    });
    expect(report.searchability.byReason).toEqual([
      { reason: "scanned-no-vision", pages: 2 },
      { reason: "not-indexed", pages: 1 },
      { reason: "no-text", pages: 1 },
    ]);
    expect(report.stages.skipped).toEqual([{ stage: "vision-extract", reason: "page-triage-skip", documents: 1 }]);
    const ids = report.recommendations.map((rec) => rec.id);
    expect(ids).toContain("vision-all-pages");
    expect(ids).toContain("reindex-pages-with-text");
    const vision = report.recommendations.find((rec) => rec.id === "vision-all-pages")!;
    expect(vision.reason).toMatch(/2 pages of 6 measured have images and almost no text layer/);
    expect(vision.reason).toMatch(/"balanced" playbook reads at most 4 vision pages/);
    expect(vision.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: 6 } });
    expect(report.focus).toEqual([expect.objectContaining({ pageNumber: 4, searchable: false, reason: "scanned-no-vision", imageCount: 1 })]);
    expect(summarizeIngestReport(report)).toMatch(/Page 4 of mixed\.pdf: not searchable \(looks scanned and was not read with vision\)/);
  });

  it("vision page limit: selected pages past the cap are reported, cap capped at 32", () => {
    const specs: PageSpec[] = Array.from({ length: 40 }, (_, index) => ({ text: 0, images: 1, vision: index < 4 ? "extracted" : "over-cap", chunks: index < 4 ? 1 : 0 }));
    const report = build({ documents: [doc("long", { pageCount: 40 })], pages: pages("long", specs) });
    expect(report.extraction).toMatchObject({ visionPages: 4, visionOverCapPages: 36 });
    expect(report.searchability.byReason).toEqual([{ reason: "vision-page-limit", pages: 36 }]);
    const rec = report.recommendations[0]!;
    expect(rec.id).toBe("vision-all-pages");
    expect(rec.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: 32 } });
    expect(rec.effect).toMatch(/first 32 pages only/);
  });

  it("offers only a reprocess when vision already reads every page", () => {
    const report = build({
      pipeline: pipeline({ vision: { forceAllPages: true, maxPagesPerDocument: 32 } }),
      documents: [doc("old-scan", { pageCount: 2 })],
      pages: pages("old-scan", [{ text: 0, images: 1, vision: "not-selected" }, { text: 0, images: 1, vision: "not-selected" }]),
      stages: [{ documentId: "old-scan", stage: "vision-extract", status: "completed", skipped: false, reason: null, selectedPages: 0, pages: 0, costCents: 0.4, tablePages: null, durationSeconds: null }],
    });
    const rec = report.recommendations[0]!;
    expect(rec).toMatchObject({ id: "reprocess-with-vision", patch: null, reprocessDocumentIds: ["old-scan"] });
    // A higher existing limit is never lowered by the patch.
    const higher = build({
      pipeline: pipeline({ visionFallback: false }),
      documents: [doc("scan", { pageCount: 2 })],
      pages: pages("scan", [{ text: 0, images: 1 }, { text: 0, images: 1 }]),
    });
    expect(higher.recommendations[0]!.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: 4 } });
  });

  it("never proposes reprocessing a superseded version", () => {
    const report = build({
      pipeline: pipeline({ visionFallback: false }),
      documents: [doc("old", { pageCount: 1, superseded: true }), doc("new", { pageCount: 1 })],
      pages: [...pages("old", [{ text: 0, images: 1 }]), ...pages("new", [{ text: 0, images: 1 }])],
    });
    expect(report.recommendations[0]!.reprocessDocumentIds).toEqual(["new"]);
  });

  it("defaults video workspace policy on without claiming frames were processed", () => {
    const report = build({ documents: [doc("video", { filename: "video.mp4", mimeType: "video/mp4" })] });
    const setting = report.config.find((item) => item.key === "mediaVideo.enabled");
    expect(setting?.value).toBe("On");
    expect(setting?.note).toContain("not evidence that frames were processed");
    expect(report.recommendations.some((item) => item.id === "turn-on-video")).toBe(false);
  });

  it("audio: counts media, flags a recording without a transcript", () => {
    const report = build({
      pipeline: pipeline({ mediaVideo: { enabled: false } }),
      documents: [
        doc("call", { filename: "call.mp3", mimeType: "audio/mpeg", pageCount: 1, chunkTotal: 0 }),
        doc("talk", { filename: "talk.mp4", mimeType: "video/mp4", pageCount: 1, chunkTotal: 3, chunkUnattributed: 3 }),
      ],
      stages: [{ documentId: "talk", stage: "extract-markdown", status: "completed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: null, durationSeconds: 600 }],
    });
    expect(report.media).toEqual({ audioFiles: 1, videoFiles: 1, mediaSeconds: 600, mediaFilesWithoutText: 1 });
    const ids = report.recommendations.map((rec) => rec.id);
    expect(ids).toEqual(expect.arrayContaining(["turn-on-video", "media-without-transcript"]));
    expect(report.recommendations.find((rec) => rec.id === "media-without-transcript")!.patch).toBeNull();
    expect(report.config.some((item) => item.key === "mediaVideo.enabled")).toBe(true);
    // No PDF settings for a media-only workspace.
    expect(report.config.some((item) => item.key === "visionFallback")).toBe(false);
  });

  it("files processed before page facts existed degrade to 'not recorded'", () => {
    const report = build({
      documents: [doc("old", { pageCount: 2, chunkTotal: 4 })],
      pages: pages("old", [{ text: null, images: null, chunks: 2 }, { text: null, images: null, chunks: 2 }]),
    });
    expect(report.text.recordedPages).toBe(0);
    expect(report.text.avgBytesPerPage).toBeNull();
    expect(report.images.avgPerPage).toBeNull();
    expect(report.coverage.documentsWithoutFacts).toBe(1);
    expect(report.coverage.note).toMatch(/not recorded for 1 file \(processed before 2026-10-14/);
    expect(report.searchability.searchablePages).toBe(2);
  });

  it("rules: tables, embeddings, failed files, vision failures, multilingual", () => {
    const report = build({
      pipeline: pipeline({ preserveTables: false, embed: false, indexVectors: false, embedding: { profile: "cheapest-hosted" } }),
      documents: [
        doc("tables", { language: "de" }),
        doc("broken", { status: "failed", pageCount: 2 }),
      ],
      pages: [
        ...pages("tables", [{ text: 3000, images: 0, chunks: 1 }, { text: 0, images: 1, vision: "failed" }, { text: 2000, images: 0, chunks: 1 }, { text: 2000, images: 0, chunks: 1 }]),
        ...pages("broken", [{ text: null, images: null }, { text: null, images: null }]),
      ],
      stages: [{ documentId: "tables", stage: "classify-route", status: "completed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: 3, durationSeconds: null }],
    });
    const byId = Object.fromEntries(report.recommendations.map((rec) => [rec.id, rec]));
    expect(byId["preserve-tables"]?.patch).toEqual({ preserveTables: true });
    expect(byId["turn-on-embeddings"]?.patch).toEqual({ embed: true, indexVectors: true });
    expect(byId["retry-failed-files"]?.reprocessDocumentIds).toEqual(["broken"]);
    expect(byId["retry-vision-failures"]?.affectedPages).toBe(1);
    expect(byId["multilingual-embeddings"]?.patch).toBeNull();
    expect(report.searchability.byReason.find((entry) => entry.reason === "document-failed")?.pages).toBe(2);
  });

  it("viewers see recommendations but cannot act", () => {
    const report = build({ pipeline: pipeline({ visionFallback: false }), documents: [doc("scan", { pageCount: 1 })], pages: pages("scan", [{ text: 0, images: 1 }]), canEdit: false });
    expect(report.permissions.canEdit).toBe(false);
    expect(report.recommendations[0]?.id).toBe("turn-on-vision");
  });

  it("an empty workspace reports zero files", () => {
    const report = build({ documents: [] });
    expect(report.files.total).toBe(0);
    expect(summarizeIngestReport(report)).toMatch(/no files yet/);
  });
});

const INDEX_1K_TO_4K = 4;

describe("ingest report: helpers", () => {
  it("uses the playbook vision cap unless every page is forced", () => {
    expect(effectiveVisionPageCap(pipeline())).toBe(4);
    expect(effectiveVisionPageCap(pipeline({ parserPlaybook: "fast" }))).toBe(0);
    expect(effectiveVisionPageCap(pipeline({ vision: { forceAllPages: true, maxPagesPerDocument: 20 } }))).toBe(20);
  });

  it("merges a patch onto the stored pipeline without resetting other settings", () => {
    const base = pipeline({ summarize: true, vision: { maxPagesPerDocument: 8 } });
    const next = applyRecommendationPatch(base, { visionFallback: true, vision: { forceAllPages: true, maxPagesPerDocument: 12 } });
    expect(next.summarize).toBe(true);
    expect(next.vision).toMatchObject({ forceAllPages: true, maxPagesPerDocument: 12, profile: base.vision.profile });
    expect(patchHolds(next, { vision: { forceAllPages: true } })).toBe(true);
    expect(patchHolds(base, { vision: { forceAllPages: true } })).toBe(false);
  });
});

describe("ingest report: chat intent", () => {
  it.each([
    "/status", "/report", " /ingest-report", "how did my files process?", "How were my documents processed",
    "why can't it find page 4?", "Why doesn't search find anything in contract.pdf", "show me the ingest report",
    "ingestion status", "page 4 is not searchable",
  ])("routes %j to the report", (query) => {
    expect(requestsIngestReport(query)).toBe(true);
  });

  it.each([
    "how did the company process refunds in 2023?", "summarize page 4", "what is the status of the merger?",
    "why can't tenants find the portal login page?", "/statusquo is a word",
    "Which page says the bond is not indexed to inflation?", "Does the document say the tenant is not found liable?",
    "What is the processing status of claim 123?", "How were the documents indexed in the archive?",
  ])("leaves %j to the model", (query) => {
    expect(requestsIngestReport(query)).toBe(false);
  });

  it("accepts only slash commands when natural intents are off", () => {
    expect(requestsIngestReport("/status", { natural: false })).toBe(true);
    expect(requestsIngestReport("how did my files process?", { natural: false })).toBe(false);
  });

  it("extracts focus pages", () => {
    expect(ingestReportFocusPages("why can't it find page 4 or p. 12?")).toEqual([4, 12]);
  });
});

describe("ingest report: summary escaping", () => {
  it("keeps user-controlled names from becoming links, images or HTML", async () => {
    const { escapeMarkdown } = await import("./ingest-report.js");
    expect(escapeMarkdown("[click](javascript:alert(1)) <img src=x> **bold** `code`")).toBe("\\[click\\](javascript:alert(1)) \\<img src=x\\> \\*\\*bold\\*\\* \\`code\\`");
    expect(escapeMarkdown("inspection-2025.pdf")).toBe("inspection-2025.pdf");
  });
});
