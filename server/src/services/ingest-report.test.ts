import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENROUTER_VISION_MODEL, defaultPipelineFeatures, visionModelCatalogById, ingestReportSchema, mergePipelineFeatures, requestsIngestReport, ingestReportFocusPages, type PipelineFeatures } from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("./usage-attribution.js", () => ({ workspaceRunsUsageCost: vi.fn(async () => ({ costCents: 0, billedCostCents: 0, computeEstimated: false })) }));

const {
  INGEST_RECOMMENDATION_CATALOG,
  applyRecommendationPatch,
  buildIngestReport,
  playbookAllowsVision,
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
    expect(rec.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true } });
    // Default vision model's catalog price per page.
    const perPage = visionModelCatalogById[DEFAULT_OPENROUTER_VISION_MODEL].estimatedCostPerPageCents;
    expect(rec.cost.centsPer100Pages).toBeCloseTo(perPage * 100, 2);
    // Observed 2¢ / 3 pages for the re-run plus 3 vision pages at the catalog price (every page; no cap).
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
    expect(vision.reason).toMatch(/Page triage did not send them to vision\./);
    expect(vision.reason).not.toMatch(/at most \d+ vision pages/);
    expect(vision.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true } });
    expect(report.focus).toEqual([expect.objectContaining({ pageNumber: 4, searchable: false, reason: "scanned-no-vision", imageCount: 1 })]);
    expect(summarizeIngestReport(report)).toMatch(/Page 4 of mixed\.pdf: not searchable \(looks scanned and was not read with vision\)/);
  });

  it("historical over-cap pages (former per-file limit) are still reported and fixed by reading every page", () => {
    const specs: PageSpec[] = Array.from({ length: 40 }, (_, index) => ({ text: 0, images: 1, vision: index < 4 ? "extracted" : "over-cap", chunks: index < 4 ? 1 : 0 }));
    const report = build({ documents: [doc("long", { pageCount: 40 })], pages: pages("long", specs) });
    expect(report.extraction).toMatchObject({ visionPages: 4, visionOverCapPages: 36 });
    expect(report.searchability.byReason).toEqual([{ reason: "vision-page-limit", pages: 36 }]);
    const rec = report.recommendations[0]!;
    expect(rec.id).toBe("vision-all-pages");
    expect(rec.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true } });
    // These pages also look scanned, so the evidence names them as scans; nothing mentions a page limit.
    expect(rec.reason).not.toMatch(/at most \d+ vision pages|Vision stops after/);
    expect(rec.effect).not.toMatch(/first \d+ pages only/);
    // The reprocess estimate covers all 40 pages, not a 32-page maximum.
    expect(rec.cost.reprocessCents).toBeGreaterThan(0);
  });

  it("offers only a reprocess when vision already reads every page", () => {
    const report = build({
      pipeline: pipeline({ vision: { forceAllPages: true } }),
      documents: [doc("old-scan", { pageCount: 2 })],
      pages: pages("old-scan", [{ text: 0, images: 1, vision: "not-selected" }, { text: 0, images: 1, vision: "not-selected" }]),
      stages: [{ documentId: "old-scan", stage: "vision-extract", status: "completed", skipped: false, reason: null, selectedPages: 0, pages: 0, costCents: 0.4, tablePages: null, durationSeconds: null }],
    });
    const rec = report.recommendations[0]!;
    expect(rec).toMatchObject({ id: "reprocess-with-vision", patch: null, reprocessDocumentIds: ["old-scan"] });
    const higher = build({
      pipeline: pipeline({ visionFallback: false }),
      documents: [doc("scan", { pageCount: 2 })],
      pages: pages("scan", [{ text: 0, images: 1 }, { text: 0, images: 1 }]),
    });
    expect(higher.recommendations[0]!.patch).toEqual({ visionFallback: true, vision: { forceAllPages: true } });
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

describe("ingest report: failed files", () => {
  const OCR_CRASH = "no extractor produced output: kreuzberg=Error: Error opening data file /app/node_modules/.pnpm/kreuzberg/tessdata/eng.traineddata";
  const failedImage = () => build({
    documents: [doc("shot", { filename: "shot.png", mimeType: "image/png", status: "failed", pageCount: 1 })],
    pages: pages("shot", [{ text: 0, images: 1, vision: "not-selected" }]),
    stages: [
      { documentId: "shot", stage: "extract-markdown", status: "failed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: null, durationSeconds: null, error: OCR_CRASH },
      { documentId: "shot", stage: "vision-extract", status: "skipped", skipped: true, reason: "page-triage-skip", selectedPages: 0, pages: 1, costCents: null, tablePages: null, durationSeconds: null },
    ],
  });

  it("surfaces the real failure: reason, stage and a sanitized detail with no paths", () => {
    const report = failedImage();
    expect(report.failures).toMatchObject({ total: 1, byReason: [{ reason: "ocr_unavailable", documents: 1 }] });
    const [failure] = report.failures.examples;
    expect(failure).toMatchObject({ documentId: "shot", filename: "shot.png", stage: "extract-markdown", reason: "ocr_unavailable", retryable: false });
    expect(failure?.detail).toContain("Error opening data file <path>");
    expect(JSON.stringify(report)).not.toMatch(/node_modules|\/app\//);
  });

  it("does not blame page triage or recommend vision for a file that crashed in extraction", () => {
    const report = failedImage();
    expect(report.images.scannedLookingPages).toBe(0);
    expect(report.recommendations.map((rec) => rec.id)).toEqual(["retry-failed-files"]);
    const retry = report.recommendations[0]!;
    expect(retry.reason).toMatch(/OCR/);
    expect(retry.effect).toMatch(/fail the same way/);
    const summary = summarizeIngestReport(report);
    expect(summary).toMatch(/1 file failed/);
    expect(summary).toMatch(/shot\.png/);
    expect(summary).toMatch(/OCR/);
    expect(summary).not.toMatch(/scanned|triage|vision/i);
  });

  it("reports a failed file with no recorded stage error as unknown", () => {
    const report = build({ documents: [doc("lost", { status: "failed", pageCount: 2 })] });
    expect(report.failures.examples).toEqual([expect.objectContaining({ reason: "unknown", stage: null, detail: null, retryable: true })]);
    expect(report.recommendations[0]?.effect).toMatch(/runs them again/);
  });

  it("keeps vision recommendations for scanned pages of files that did not fail", () => {
    const report = build({
      documents: [doc("ok", { pageCount: 1 }), doc("bad", { status: "failed", pageCount: 1 })],
      pages: [...pages("ok", [{ text: 0, images: 1, vision: "not-selected" }]), ...pages("bad", [{ text: 0, images: 1, vision: "not-selected" }])],
    });
    expect(report.images.scannedLookingPages).toBe(1);
    expect(report.recommendations.find((rec) => rec.id === "vision-all-pages")).toMatchObject({ affectedPages: 1, reprocessDocumentIds: ["ok"] });
  });
});

describe("ingest report: singular and plural agreement", () => {
  const scanned = (n: number) => build({
    documents: [doc("scan", { pageCount: n })],
    pages: pages("scan", Array.from({ length: n }, () => ({ text: 0, images: 1, vision: "not-selected" }))),
  });

  it("agrees verbs with one scanned page", () => {
    const report = scanned(1);
    const rec = report.recommendations.find((entry) => entry.id === "vision-all-pages")!;
    expect(rec.reason).toContain("1 page of 1 measured has images and almost no text layer (it looks scanned) and no searchable text");
    expect(rec.effect).toContain("reprocess the 1 affected file to fix existing pages");
    const summary = summarizeIngestReport(report);
    expect(summary).toContain("1 page looks scanned (images, almost no text layer); vision read 0 pages");
    expect(summary).toContain("0 of 1 checked page searchable");
  });

  it("agrees verbs with several scanned pages", () => {
    const report = scanned(3);
    const rec = report.recommendations.find((entry) => entry.id === "vision-all-pages")!;
    expect(rec.reason).toContain("3 pages of 3 measured have images and almost no text layer (they look scanned) and no searchable text");
    expect(summarizeIngestReport(report)).toContain("3 pages look scanned (images, almost no text layer); vision read 0 pages");
    expect(summarizeIngestReport(report)).toContain("0 of 3 checked pages searchable");
  });

  it("agrees verbs across the other recommendations", () => {
    const one = build({
      pipeline: pipeline({ preserveTables: false, embed: false, indexVectors: false, embedding: { profile: "cheapest-hosted" }, mediaVideo: { enabled: false } }),
      documents: [
        doc("tables", { language: "de" }),
        doc("clip", { filename: "clip.mp4", mimeType: "video/mp4", pageCount: 1 }),
        doc("broken", { status: "failed", pageCount: 1 }),
      ],
      pages: pages("tables", [{ text: 3000, images: 0, chunks: 1 }, { text: 0, images: 1, vision: "failed" }, { text: 120, images: 0 }]),
      stages: [{ documentId: "tables", stage: "classify-route", status: "completed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: 1, durationSeconds: null }],
    });
    const reasons = Object.fromEntries(one.recommendations.map((rec) => [rec.id, rec.reason]));
    expect(reasons["preserve-tables"]).toContain("1 page in 1 file looks table-heavy");
    expect(reasons["retry-vision-failures"]).toContain("1 page in 1 file was sent to vision");
    expect(reasons["turn-on-video"]).toContain("1 video file has video frame reading disabled");
    expect(reasons["reindex-pages-with-text"]).toContain("1 page in 1 file has a text layer but no chunks, so search cannot return it");
    expect(reasons["retry-failed-files"]).toMatch(/^1 file failed during processing and is not searchable/);
    expect(reasons["multilingual-embeddings"]).toContain("1 file is in de");

    const many = build({
      pipeline: pipeline({ preserveTables: false, mediaVideo: { enabled: false } }),
      documents: [doc("a", { status: "failed" }), doc("b", { status: "failed" }), doc("v1", { filename: "1.mp4", mimeType: "video/mp4" }), doc("v2", { filename: "2.mp4", mimeType: "video/mp4" })],
      pages: pages("a", [{ text: 3000, images: 0, chunks: 1 }, { text: 3000, images: 0, chunks: 1 }]),
      stages: [{ documentId: "a", stage: "classify-route", status: "completed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: 2, durationSeconds: null }],
    });
    const manyReasons = Object.fromEntries(many.recommendations.map((rec) => [rec.id, rec.reason]));
    expect(manyReasons["preserve-tables"]).toContain("2 pages in 1 file look table-heavy");
    expect(manyReasons["turn-on-video"]).toContain("2 video files have video frame reading disabled");
    expect(manyReasons["retry-failed-files"]).toMatch(/^2 files failed during processing and are not searchable/);
  });

  it("agrees verbs when scanned pages were all handled", () => {
    const one = build({ documents: [doc("done", { pageCount: 1 })], pages: pages("done", [{ text: 0, images: 1, vision: "extracted", chunks: 1 }]), stages: [{ documentId: "done", stage: "vision-extract", status: "completed", skipped: false, reason: null, selectedPages: 1, pages: 1, costCents: 1, tablePages: null, durationSeconds: null }] });
    expect(one.recommendations.find((rec) => rec.id === "scans-handled")?.reason).toBe("1 page looks scanned and it has searchable text.");
  });
});

describe("ingest report: recommendations reach the settings proposal tool", () => {
  const stage = (documentId: string, name: string, extra: Partial<Input["stages"][number]> = {}): Input["stages"][number] => ({
    documentId, stage: name, status: "completed", skipped: false, reason: null, selectedPages: null, pages: null, costCents: null, tablePages: null, durationSeconds: null, ...extra,
  });
  const scenarios = (): Array<ReturnType<typeof build>> => [
    build({ pipeline: pipeline({ visionFallback: false }), documents: [doc("scan", { pageCount: 2 })], pages: pages("scan", [{ text: 0, images: 1 }, { text: 0, images: 1 }]) }),
    build({
      documents: [doc("mixed", { pageCount: 4 })],
      pages: pages("mixed", [{ text: 1800, images: 0, vision: "not-selected", chunks: 2 }, { text: 0, images: 1, vision: "not-selected" }, { text: 2000, images: 0, vision: "not-selected" }, { text: 0, images: 0, vision: "not-selected" }]),
    }),
    build({
      pipeline: pipeline({ vision: { forceAllPages: true } }),
      documents: [doc("old", { pageCount: 1 })], pages: pages("old", [{ text: 0, images: 1, vision: "not-selected" }]),
    }),
    build({
      pipeline: pipeline({ preserveTables: false, embed: false, indexVectors: false, embedding: { profile: "cheapest-hosted" }, mediaVideo: { enabled: false }, maxCostCents: 5 }),
      documents: [
        doc("tables", { language: "de" }), doc("broken", { status: "failed", pageCount: 2 }),
        doc("call", { filename: "call.mp3", mimeType: "audio/mpeg", pageCount: 1 }), doc("clip", { filename: "clip.mp4", mimeType: "video/mp4", pageCount: 1, chunkTotal: 2, chunkUnattributed: 2 }),
      ],
      pages: pages("tables", [{ text: 3000, images: 0, chunks: 1 }, { text: 0, images: 1, vision: "failed" }, { text: 0, images: 1, vision: "cost-cap" }, { text: 2000, images: 0 }]),
      stages: [stage("tables", "classify-route", { tablePages: 2 })],
    }),
    build({ documents: [doc("done", { pageCount: 1 })], pages: pages("done", [{ text: 0, images: 1, vision: "extracted", chunks: 1 }]), stages: [stage("done", "vision-extract", { selectedPages: 1, pages: 1, costCents: 1 })] }),
  ];

  it("accounts for every recommendation id the report can emit", () => {
    const emitted = new Set(scenarios().flatMap((report) => report.recommendations.map((rec) => rec.id)));
    expect([...emitted].sort()).toEqual(Object.keys(INGEST_RECOMMENDATION_CATALOG).sort());
  });

  it("every pipeline patch passes the settings proposal schema; every other recommendation is explicitly not proposable", async () => {
    const { workspaceSettingsProposalInputSchema } = await import("./workspace-settings-proposal-input.js");
    for (const rec of scenarios().flatMap((report) => report.recommendations)) {
      const entry = INGEST_RECOMMENDATION_CATALOG[rec.id as keyof typeof INGEST_RECOMMENDATION_CATALOG];
      expect(entry, `${rec.id} is missing from INGEST_RECOMMENDATION_CATALOG`).toBeDefined();
      if (entry.proposal === "pipeline-patch") {
        expect(rec.patch, rec.id).not.toBeNull();
        const parsed = workspaceSettingsProposalInputSchema.safeParse({ changes: { pipeline: rec.patch } });
        expect(parsed.success, `${rec.id}: ${JSON.stringify(rec.patch)}`).toBe(true);
      } else {
        expect(rec.patch, rec.id).toBeNull();
      }
    }
  });

  it("accepts the vision page-selection settings and rejects malformed ones", async () => {
    const { workspaceSettingsProposalInputSchema } = await import("./workspace-settings-proposal-input.js");
    const parse = (vision: unknown) => workspaceSettingsProposalInputSchema.safeParse({ changes: { pipeline: { vision } } }).success;
    expect(parse({ forceAllPages: true })).toBe(true);
    expect(parse({ forceAllPages: false })).toBe(true);
    // The per-file vision page limit no longer exists, so it is not a proposable setting.
    expect(parse({ forceAllPages: true, maxPagesPerDocument: 32 })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ modelUri: "llm://anything" })).toBe(false);
  });
});

const INDEX_1K_TO_4K = 4;

describe("ingest report: helpers", () => {
  it("reports whether the playbook allows vision; there is no per-file page count", () => {
    expect(playbookAllowsVision(pipeline())).toBe(true);
    expect(playbookAllowsVision(pipeline({ parserPlaybook: "fast" }))).toBe(false);
    expect(playbookAllowsVision(pipeline({ parserPlaybook: "fast", vision: { forceAllPages: true } }))).toBe(true);
  });

  it("merges a patch onto the stored pipeline without resetting other settings", () => {
    const base = pipeline({ summarize: true, vision: { benchmarkProfile: "ocr-heavy" } });
    const next = applyRecommendationPatch(base, { visionFallback: true, vision: { forceAllPages: true } });
    expect(next.summarize).toBe(true);
    expect(next.vision).toMatchObject({ forceAllPages: true, benchmarkProfile: "ocr-heavy", profile: base.vision.profile });
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

describe("ingest report: run-scoped file items", () => {
  const base = (runId: string | null, documents: Input["documents"], extra: Partial<Input> = {}) => {
    const report = buildIngestReport({
      workspace: { id: "ws-1", name: "Contracts", pipeline: pipeline() },
      scope: { runId, documentIds: null, matchedDocuments: documents.length },
      documents,
      pageDetailDocumentIds: documents.map((entry) => entry.id),
      pages: [], stages: [],
      runs: [{ id: "run-1", status: "completed", pagesProcessed: 4, durationMs: 61_234.6 }],
      costCents: 1, canEdit: true, now: new Date("2026-10-14T12:00:00.000Z"),
      ...extra,
    });
    expect(ingestReportSchema.parse(report)).toEqual(report);
    return report;
  };

  it("omits items and run without a runId", () => {
    const report = base(null, [doc("a")]);
    expect(report.files.items).toBeUndefined();
    expect(report.run).toBeUndefined();
  });

  it("lists per-file status, pages, searchable pages and a safe failure summary", () => {
    const report = base("run-1", [
      doc("ok"),
      doc("queued", { status: "queued", pageCount: 0 }),
      doc("busy", { status: "processing" }),
      doc("bad", { status: "failed", pageCount: 0 }),
    ], {
      pages: pages("ok", [{ text: 2000, images: 0, chunks: 1 }, { text: 2000, images: 0, chunks: 1 }]),
      stages: [{ documentId: "bad", stage: "parse", status: "failed", skipped: false, reason: "s3://bucket/secret-key", selectedPages: null, pages: null, costCents: null, tablePages: null, durationSeconds: null }],
    });
    const byId = Object.fromEntries(report.files.items!.map((item) => [item.documentId, item]));
    expect(byId.ok).toMatchObject({ status: "completed", pages: 4, searchablePages: 2, error: null, filename: "ok.pdf" });
    expect(byId.queued).toMatchObject({ status: "queued", pages: null });
    expect(byId.busy.status).toBe("processing");
    expect(byId.bad).toMatchObject({ status: "failed", error: "Failed during parse" });
    expect(JSON.stringify(report.files.items)).not.toContain("secret-key");
    expect(report.run).toEqual({ id: "run-1", status: "completed", durationMs: 61_235 });
  });

  it("bounds items to 50 and reports a null run when not found or still running", () => {
    const many = Array.from({ length: 60 }, (_, i) => doc(`d${i}`));
    expect(base("run-1", many).files.items).toHaveLength(50);
    expect(base("run-x", [doc("a")]).run).toBeNull();
    const running = base("run-1", [doc("a")], { runs: [{ id: "run-1", status: "processing", pagesProcessed: 0, durationMs: 5000 }] });
    expect(running.run).toEqual({ id: "run-1", status: "processing", durationMs: null });
  });
});
