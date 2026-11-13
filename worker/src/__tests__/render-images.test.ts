import { describe, expect, it, vi } from "vitest";
import { RenderImagesStage, selectRasterPagesFromClassification } from "../stages/render-images.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";
import type { ArtifactStore } from "../tools/storage.js";

vi.mock("../pipeline/checkpoints.js", () => ({
  runDocuments: async (documents: unknown[], _concurrency: number, run: (doc: unknown) => Promise<void>) => {
    for (const document of documents) await run(document);
  },
  runDocumentStage: async (...args: unknown[]) => (args[5] as () => Promise<unknown>)(),
  completeDocumentPages: vi.fn(async () => undefined),
  skipCompletedPages: (_completed: Set<number>, pages: number[]) => pages,
}));

it("publishes raster cache pages in the document artifact ledger for the viewer", async () => {
  const artifactLedger = DocumentArtifactLedger.create({});
  const state = { artifactLedger, documents: [{ id: "doc", userId: "user", pageCount: 1 }],
    docConcurrency: 1, run: { id: "run", pipeline: { preserveImages: true, visionFallback: false } } } as unknown as WorkflowState;
  const rasters = { renderSelectedPages: async () => [{ pageNumber: 1, artifactUri: "s3://bucket/raster.png", cacheHit: true }] } as unknown as PdfRasterCache;
  const storage = { putJson: vi.fn(), uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore;
  await new RenderImagesStage(rasters, storage).run(state);
  expect(artifactLedger.readDocument("doc", "page-1")).toBe("s3://bucket/raster.png");
});

it("keeps text-only previews on demand even when classification suggests rasterization", async () => {
  const artifactLedger = DocumentArtifactLedger.create({});
  const state = { artifactLedger, documents: [{ id: "doc", userId: "user", pageCount: 5000 }],
    docConcurrency: 1, run: { id: "run", pipeline: { preserveImages: false, visionFallback: false } } } as unknown as WorkflowState;
  const renderSelectedPages = vi.fn(async () => []);
  const stage = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache,
    { putJson: vi.fn(), uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore);
  const classification = {
    status: "ready", documentId: "doc", label: "mixed", confidence: 0.8, signals: [],
    suggestedPlaybook: "balanced", documentComplexity: "mixed", dominantRoutes: ["image-heavy"],
    visionPolicy: "selective", specializedContentSummary: [],
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json", characterCount: 1000, pageCount: 5000 },
    pages: [{ pageNumber: 1, route: "image-heavy", confidence: 0.8, textDensityScore: 0.1, signals: [], extractorHint: "vision-rescue", specializedContent: [] }],
  };
  expect(selectRasterPagesFromClassification(classification)).toEqual([1]);
  vi.spyOn(stage as any, "loadRasterRequest").mockResolvedValue(classification);
  await stage.run(state);
  expect(renderSelectedPages).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [] }));
});

it("never asks the raster cache for pages of documents without a raster form (HTML)", async () => {
  const artifactLedger = DocumentArtifactLedger.create({});
  const state = { artifactLedger, documents: [{ id: "doc", userId: "user", pageCount: 6, mimeType: "text/html" }],
    docConcurrency: 1, run: { id: "run", pipeline: { preserveImages: true, visionFallback: true } } } as unknown as WorkflowState;
  const renderSelectedPages = vi.fn(async () => []);
  const stage = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache,
    { putJson: vi.fn(), uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore);
  vi.spyOn(stage as any, "loadRasterRequest").mockResolvedValue({
    status: "ready", documentId: "doc", label: "mixed", confidence: 0.8, signals: [], suggestedPlaybook: "balanced",
    documentComplexity: "mixed", dominantRoutes: ["image-heavy"], visionPolicy: "selective", specializedContentSummary: [],
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1000, pageCount: 6 },
    pages: [1, 4].map(pageNumber => ({ pageNumber, route: "image-heavy", confidence: 0.8, textDensityScore: 0.1, signals: [], extractorHint: "vision-rescue", specializedContent: [] })),
  });
  await stage.run(state);
  expect(renderSelectedPages).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [] }));
});

it("writes an extract run's page manifest under the extract prefix, not <user>/<run>", async () => {
  const artifactLedger = DocumentArtifactLedger.create({});
  const state = { artifactLedger, documents: [{ id: "doc", userId: "user", runId: "run", pageCount: 1, artifactRoot: "extracts/org/ext_1" }],
    docConcurrency: 1, run: { id: "run", storagePrefix: "extracts/org/ext_1", pipeline: { preserveImages: true, visionFallback: false } } } as unknown as WorkflowState;
  const rasters = { renderSelectedPages: async () => [{ pageNumber: 1, artifactUri: "s3://bucket/extracts/org/ext_1/images/doc/page-1.png", cacheHit: false }] } as unknown as PdfRasterCache;
  const putJson = vi.fn();
  await new RenderImagesStage(rasters, { putJson, uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore).run(state);
  const keys = putJson.mock.calls.map((call) => call[0] as string);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((key) => key.startsWith("extracts/org/ext_1/"))).toBe(true);
  expect(keys.some((key) => key.startsWith("user/"))).toBe(false);
});

describe("page-range shards", () => {
  const classification = (pages: number[]) => ({
    status: "ready", documentId: "doc", label: "mixed", confidence: 0.8, signals: [], suggestedPlaybook: "balanced",
    documentComplexity: "mixed", dominantRoutes: ["image-heavy"], visionPolicy: "selective", specializedContentSummary: [],
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1000, pageCount: 100 },
    pages: pages.map(pageNumber => ({ pageNumber, route: "image-heavy", confidence: 0.8, textDensityScore: 0.1, signals: [], extractorHint: "vision-rescue", specializedContent: [] })),
  });
  const setup = (status?: string) => {
    const artifactLedger = DocumentArtifactLedger.create({});
    const state = { artifactLedger, documents: [{ id: "doc", userId: "user", pageCount: 100, mimeType: "application/pdf" }],
      documentStages: new Map(status ? [["doc", new Map([["render-images", { status }]])]] : []),
      docConcurrency: 1, run: { id: "run", pipeline: { preserveImages: true, visionFallback: false } } } as unknown as WorkflowState;
    const renderSelectedPages = vi.fn(async (args: { pageNumbers: number[] }) => args.pageNumbers.map(pageNumber =>
      ({ pageNumber, artifactUri: `s3://bucket/page-${pageNumber}.png`, cacheHit: false })));
    const putJson = vi.fn();
    const stage = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache,
      { putJson, uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore);
    vi.spyOn(stage as any, "loadRasterRequest").mockResolvedValue(classification([3, 40, 41, 90]));
    return { state, stage, renderSelectedPages, putJson, artifactLedger };
  };

  it("renders only the selected pages inside the range and leaves manifest, ledger and checkpoints to the stage pass", async () => {
    const { state, stage, renderSelectedPages, putJson, artifactLedger } = setup();
    await stage.runPageRanges(state, new Map([["doc", [{ first: 33, last: 64 }]]]));
    expect(renderSelectedPages).toHaveBeenCalledTimes(1);
    expect(renderSelectedPages).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [40, 41] }));
    expect(putJson).not.toHaveBeenCalled();
    expect(artifactLedger.readDocument("doc", "page-40")).toBeUndefined();
  });

  it("does nothing for ranges without selected pages, other documents or completed documents", async () => {
    const empty = setup();
    await empty.stage.runPageRanges(empty.state, new Map([["doc", [{ first: 50, last: 60 }]]]));
    expect(empty.renderSelectedPages).not.toHaveBeenCalled();
    const other = setup();
    await other.stage.runPageRanges(other.state, new Map([["someone-elses-doc", [{ first: 1, last: 100 }]]]));
    expect(other.renderSelectedPages).not.toHaveBeenCalled();
    const done = setup("completed");
    await done.stage.runPageRanges(done.state, new Map([["doc", [{ first: 1, last: 100 }]]]));
    expect(done.renderSelectedPages).not.toHaveBeenCalled();
  });

  it("selects the same pages for shards and the stage pass, so shards plus the pass render each page once", async () => {
    const { state, stage, renderSelectedPages } = setup();
    for (const range of [{ first: 1, last: 50 }, { first: 51, last: 100 }]) await stage.runPageRanges(state, new Map([["doc", [range]]]));
    await stage.run(state);
    const calls = renderSelectedPages.mock.calls.map((call) => call[0].pageNumbers);
    expect(calls).toEqual([[3, 40, 41], [90], [3, 40, 41, 90]]);
    // The stage pass asks for every page again; the raster cache (keyed per page) serves the sharded ones as hits.
  });
});

describe("free chart candidate stats", () => {
  const classification = {
    status: "ready", documentId: "doc", label: "mixed", confidence: 0.8, signals: [], suggestedPlaybook: "balanced",
    documentComplexity: "mixed", dominantRoutes: ["chart-or-figure"], visionPolicy: "selective", specializedContentSummary: [],
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1000, pageCount: 2 },
    pages: [{ pageNumber: 2, route: "chart-or-figure", confidence: 0.8, textDensityScore: 0.1, signals: [], extractorHint: "vision-rescue", specializedContent: [] }],
  };

  it("records them whenever chart export is not active (vision on or off), reusing the classification it read, and leaves them to vision-extract when export is on", async () => {
    const getJson = vi.fn(async () => { throw new Error("no read expected"); });
    const stage = new RenderImagesStage({} as PdfRasterCache, { bucket: "bucket", getJson, putJson: vi.fn(), uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore);
    const document = { id: "doc", userId: "user", pageCount: 2, mimeType: "application/pdf" };
    const stateWith = (pipeline: Record<string, unknown>) => ({ artifactLedger: DocumentArtifactLedger.create({}), run: { id: "run", pipeline } }) as unknown as WorkflowState;
    const free = (stage as unknown as { freeVisualCandidates: (s: WorkflowState, d: unknown, c: unknown) => Promise<unknown> }).freeVisualCandidates.bind(stage);
    // Keyword-only chart page: counted as low confidence, not as a priced candidate. No storage read (no slots).
    expect(await free(stateWith({ visionFallback: true, chartExport: { tier: "models", formats: ["description"], diagrams: true } }), document, classification))
      .toEqual({ stats: { charts: 0, diagrams: 0, pagesWithUnexportedVisuals: [], exported: 0, bySource: {} }, lowConfidence: 1 });
    expect(getJson).not.toHaveBeenCalled();
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    try {
      expect(await free(stateWith({ visionFallback: true, chartExport: { tier: "models", formats: ["description"], diagrams: true } }), document, classification)).toBeNull();
      // The free tier is active too: vision-extract records the stats. An unstamped run resolves as machine (off): render-images does.
      expect(await free(stateWith({ visionFallback: false, chartExport: { tier: "free", formats: ["description"], diagrams: true } }), document, classification)).toBeNull();
      expect(await free(stateWith({ visionFallback: false, chartExport: { formats: ["description"], diagrams: true } }), document, classification)).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pages Doppler left to the host's page image (--scan-pages copy)", () => {
  const classification = {
    status: "ready", documentId: "doc", label: "mixed", confidence: 0.8, signals: [], suggestedPlaybook: "balanced",
    documentComplexity: "mixed", dominantRoutes: ["image-heavy"], visionPolicy: "selective", specializedContentSummary: [],
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1000, pageCount: 6 },
    pages: [{ pageNumber: 4, route: "image-heavy", confidence: 0.8, textDensityScore: 0.1, signals: [], extractorHint: "vision-rescue", specializedContent: [] }],
  };
  const row = (pageNumber: number, fate: string, status: string, reason: string | null) => ({ assetId: `p${pageNumber}.1`, pageNumber, fate, status, reason });
  async function render(options: { preserveImages?: boolean; mimeType?: string; orgId?: string | null; pending?: unknown[]; stored?: number[]; storeFails?: boolean }) {
    const listHostPageImagePages = vi.fn(async (scope: { orgId: string; documentId: string }) => {
      if (options.storeFails) throw new Error("db down");
      return scope.orgId === "org-a" && scope.documentId === "doc" ? options.stored ?? [] : [];
    });
    const pendingAssetLedger = new Map(options.pending ? [["doc", { level: {}, assets: options.pending }]] : []);
    const state = {
      artifactLedger: DocumentArtifactLedger.create({}), pendingAssetLedger, store: { getCompletedPages: async () => new Set(), listHostPageImagePages },
      documents: [{ id: "doc", userId: "user", pageCount: 6, mimeType: options.mimeType ?? "application/pdf" }],
      docConcurrency: 1, run: { id: "run", orgId: options.orgId === undefined ? "org-a" : options.orgId, pipeline: { preserveImages: options.preserveImages ?? true, visionFallback: true } },
    } as unknown as WorkflowState;
    const renderSelectedPages = vi.fn(async () => []);
    const stage = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache,
      { putJson: vi.fn(), uri: (key: string) => `s3://bucket/${key}` } as unknown as ArtifactStore);
    vi.spyOn(stage as any, "loadRasterRequest").mockResolvedValue(classification);
    await stage.run(state);
    return { pages: (renderSelectedPages.mock.calls[0] as unknown as [{ pageNumbers: number[] }])[0].pageNumbers, listHostPageImagePages };
  }

  it("renders the stored ledger's scan-not-copyable and failed-copy pages beside the classification's, scoped to the document's organization", async () => {
    const { pages, listHostPageImagePages } = await render({ stored: [2, 5] });
    expect(pages).toEqual([2, 4, 5]);
    expect(listHostPageImagePages).toHaveBeenCalledWith({ orgId: "org-a", documentId: "doc" });
  });

  it("prefers the write still waiting for its checkpoint, and selects only the two host-image cases from it", async () => {
    const { pages, listHostPageImagePages } = await render({
      stored: [1],
      pending: [
        row(1, "page-scan", "extracted", null), row(2, "background", "unlinked", "scan-not-copyable"),
        row(3, "page-scan", "not-extracted", "copy"), row(5, "block", "not-extracted", "copy"), row(6, "furniture", "unlinked", null),
        row(6, "page-scan", "not-extracted", "budget"),
      ],
    });
    expect(pages).toEqual([2, 3, 4]);
    expect(listHostPageImagePages).not.toHaveBeenCalled();
  });

  it("leaves other pages and other projects alone: page images off, not a PDF, no organization, a page past the end, a failed read", async () => {
    expect((await render({ preserveImages: false, stored: [2] })).pages).toEqual([4]);
    expect((await render({ mimeType: "image/png", stored: [2] })).pages).toEqual([]);
    const orphan = await render({ orgId: null, stored: [2] });
    expect(orphan.pages).toEqual([4]);
    expect(orphan.listHostPageImagePages).not.toHaveBeenCalled();
    expect((await render({ stored: [7, 0, 2] })).pages).toEqual([2, 4]);
    expect((await render({ storeFails: true })).pages).toEqual([4]);
  });
});
