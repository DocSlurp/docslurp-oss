import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import type { PageImageEvidenceArtifact } from "../lib/page-image-evidence.js";
import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";

// OCR-shaped text: dense enough that v1 (extracted word count) never calls the page sparse.
const OCR_PROSE = Array.from({ length: 12 }, (_, index) =>
  `Line ${index + 1} of recovered text where the reader moved along the page and noted what was seen there today.`,
).join("\n");

const HEADER = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n" +
  "--------------------------------------------------------------------------------------------\n";
const imageRow = (page: number, object: number, size: string) =>
  `   ${page}     0 image    1700  2200  rgb     3   8  jpeg   no       ${object}  0   200   200  ${size} 1.2%`;

type Listing = { lastPage: number; stdout: Promise<string | null> };

function setup(version: "v1" | "v2", options: { visionFallback?: boolean; pageCount?: number } = {}) {
  const written: Array<{ key: string; value: PageImageEvidenceArtifact }> = [];
  const runner = {
    listPdfImages: vi.fn(async () => ({ available: true, binary: "pdfimages", args: [] })),
    pdfPageSizes: vi.fn(async () => ({ available: false })),
    run: vi.fn(async () => ({ stdout: HEADER, stderr: "", exitCode: 0 })),
  };
  const storage = {
    bucket: "bucket",
    putJson: vi.fn(async (key: string, value: PageImageEvidenceArtifact) => { written.push({ key, value }); }),
    uri: (key: string) => `s3://bucket/${key}`,
  };
  const stage = new ExtractMarkdownStage(runner as never, storage as never, {} as Config);
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "user-1", stats: {}, stage: "extract-markdown",
    artifacts: { [VISION_ROUTING_VERSION_SLOT]: version },
    pipeline: { visionFallback: options.visionFallback ?? true },
  } as unknown as WorkspaceRun, []);
  const document = {
    id: "doc-1", userId: "user-1", filename: "scan.pdf", mimeType: "application/pdf", pageCount: options.pageCount ?? 1,
  } as Document;
  const internals = stage as unknown as {
    imageListings: Map<string, Listing>;
    textLayerListings: Map<string, Listing>;
  };
  const key = `${state.run.id}:${document.id}`;
  return {
    stage, state, document, runner, written,
    shareImages: (listing: Listing) => internals.imageListings.set(key, listing),
    shareTextLayer: (listing: Listing) => internals.textLayerListings.set(key, listing),
  };
}

describe("extract-markdown page image evidence wiring", () => {
  let dir: string;
  let source: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "image-evidence-"));
    source = path.join(dir, "scan.pdf");
    await writeFile(source, Buffer.alloc(300 * 1024, 0x20));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("v2 counts native words from page facts' text layer, so an OCR'd scan stays sparse", async () => {
    const harness = setup("v2");
    harness.shareTextLayer({ lastPage: 1, stdout: Promise.resolve("\f") });
    harness.shareImages({ lastPage: 1, stdout: Promise.resolve(HEADER + imageRow(1, 7, "280K")) });
    const uri = await harness.stage.recordDocumentImageEvidence(harness.document, source, OCR_PROSE, harness.state,
      { isPdf: true, format: "pdf" });
    expect(uri).toMatch(/page-image-evidence\/doc-1\.json$/);
    expect(harness.written).toHaveLength(1);
    expect(harness.written[0]!.value).toMatchObject({ source: "pdfimages", pages: [{ pageNumber: 1, wordCount: 0 }] });
    // The shared listing was reused; no second pdfimages run.
    expect(harness.runner.listPdfImages).not.toHaveBeenCalled();
    // 300 KB file minus a 280 KB image on its one page: 20 KB of drawn bytes.
    expect(harness.written[0]!.value.drawnBytesPerPage).toBe(20 * 1024);
  });

  it("falls back to the v1 word count when pdftotext failed", async () => {
    const harness = setup("v2");
    harness.shareTextLayer({ lastPage: 1, stdout: Promise.resolve(null) });
    expect(await harness.stage.recordDocumentImageEvidence(harness.document, source, OCR_PROSE, harness.state,
      { isPdf: true, format: "pdf" })).toBeNull();
    const rejected = setup("v2");
    rejected.shareTextLayer({ lastPage: 1, stdout: Promise.reject(new Error("pdftotext crashed")) });
    expect(await rejected.stage.recordDocumentImageEvidence(rejected.document, source, OCR_PROSE, rejected.state,
      { isPdf: true, format: "pdf" })).toBeNull();
    expect([...harness.written, ...rejected.written]).toEqual([]);
  });

  it("falls back to the v1 word count when the text layer does not line up with the pages", async () => {
    const harness = setup("v2");
    // Three form-feed pages for a one-page document: never pair a page with another page's text.
    harness.shareTextLayer({ lastPage: 1, stdout: Promise.resolve("\fa\fb\f") });
    expect(await harness.stage.recordDocumentImageEvidence(harness.document, source, OCR_PROSE, harness.state,
      { isPdf: true, format: "pdf" })).toBeNull();
    expect(harness.written).toEqual([]);
  });

  it("v1 ignores the text layer", async () => {
    const harness = setup("v1");
    harness.shareTextLayer({ lastPage: 1, stdout: Promise.resolve("\f") });
    expect(await harness.stage.recordDocumentImageEvidence(harness.document, source, OCR_PROSE, harness.state,
      { isPdf: true, format: "pdf" })).toBeNull();
  });

  it("drawn bytes stay unknown unless the image listing covers every page", async () => {
    const harness = setup("v2", { pageCount: 2 });
    harness.shareTextLayer({ lastPage: 2, stdout: Promise.resolve("\f\f") });
    // Page facts probed only page 1 of 2: page 2's images are unlisted.
    harness.shareImages({ lastPage: 1, stdout: Promise.resolve(HEADER + imageRow(1, 7, "10K")) });
    await harness.stage.recordDocumentImageEvidence(harness.document, source, "\f", harness.state, { isPdf: true, format: "pdf" });
    expect(harness.written[0]!.value.drawnBytesPerPage).toBeNull();
  });

  it("an uploaded image gets full-page raster evidence with v2 only", async () => {
    const image = { isPdf: false, format: "image" };
    const v2 = setup("v2");
    expect(await v2.stage.recordDocumentImageEvidence(v2.document, source, OCR_PROSE, v2.state, image)).toMatch(/doc-1\.json$/);
    expect(v2.written[0]!.value).toMatchObject({
      source: "image-file", pages: [{ pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1 }],
    });
    const v1 = setup("v1");
    expect(await v1.stage.recordDocumentImageEvidence(v1.document, source, OCR_PROSE, v1.state, image)).toBeNull();
    const off = setup("v2", { visionFallback: false });
    expect(await off.stage.recordDocumentImageEvidence(off.document, source, OCR_PROSE, off.state, image)).toBeNull();
    expect(await off.stage.recordDocumentImageEvidence(off.document, source, OCR_PROSE, off.state, { isPdf: true, format: "pdf" }))
      .toBeNull();
    expect([...v1.written, ...off.written]).toEqual([]);
  });
});
