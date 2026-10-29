import { describe, expect, it, vi } from "vitest";
import {
  canonicalDocumentSchema,
  normalizePipelineFeatures,
  pageCredits,
  pageImageReferenceMarkdown,
  type CanonicalDocument,
} from "@docslurp/shared";

import { splitRemainingPages } from "../db/page-base-fee.js";
import { applyPageImageReferences, pagesKeptAsImage, reserveFastPageImageRenders } from "../lib/page-image-references.js";
import { artifactExportPath, documentExportEntries, type ExportDocumentRow, type ExportSource } from "../exports/build-document-export.js";
import { RenderImagesStage } from "../stages/render-images.js";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { visionAllowedForDocument } from "../lib/vision-page-budget.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { extractTextForEmbedding } from "../stages/embedding-runtime.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";
import type { Document, WorkspaceRun } from "../models.js";

const document = { id: "doc", userId: "user", filename: "scan.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "source.pdf" } as Document;

/** Page 1 has a text layer, page 2 is a scan with none (form feed separates pages). */
const markdown = "# Intro\n\nBorn-digital text on page one.\f";

function memoryStorage(initial: Record<string, unknown> = {}) {
  const objects = new Map<string, unknown>(Object.entries(initial));
  const storage = {
    bucket: "bucket",
    uri: (key: string) => `s3://bucket/${key}`,
    getJson: async (key: string) => structuredClone(objects.get(key)),
    putJson: async (key: string, value: unknown) => void objects.set(key, structuredClone(value)),
    putBytes: async (key: string, value: Uint8Array) => void objects.set(key, Buffer.from(value).toString("utf8")),
    getBytes: async (key: string) => Buffer.from(String(objects.get(key) ?? ""), "utf8"),
    deleteKeys: async () => undefined,
  };
  return { storage: storage as unknown as ArtifactStore, objects };
}

function fastState(): { state: WorkflowState; storage: ArtifactStore; objects: Map<string, unknown>; canonical: CanonicalDocument } {
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: markdown, pageCount: 2, extractor: "native-pdf" });
  const contract = buildExtractionContract({
    documentId: "doc", markdown, extractor: "native-pdf", strategy: "native-pdf-only", extractionTimeMs: 1, pageCount: 2, canonicalDocument: canonical,
  });
  const { storage, objects } = memoryStorage({ "canonical/doc.json": canonical, "contract/doc.json": contract });
  const state = WorkflowState.create({
    id: "run", orgId: "org", userId: "user", workspaceId: "ws", spentCents: 0, stats: {}, artifacts: {},
    pipeline: normalizePipelineFeatures({ quality: "fast" }),
  } as unknown as WorkspaceRun, [document]);
  state.artifactLedger.recordDocument("doc", "canonical-document", "s3://bucket/canonical/doc.json");
  state.artifactLedger.recordDocument("doc", "extraction-contract", "s3://bucket/contract/doc.json");
  return { state, storage, objects, canonical };
}

describe("quality fast: pages without a text layer", () => {
  it("never allows vision", () => {
    expect(visionAllowedForDocument({ quality: "fast" }, "review-grade")).toBe(false);
  });

  it("keeps the scanned page (no text) as an image, not the text page or a blank page", () => {
    const { canonical } = fastState();
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 2, isImage: false }).kept).toEqual([2]);
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 3, isImage: false, routing: {
      status: "ready", documentId: "doc", label: "x", confidence: 1, signals: [], suggestedPlaybook: null,
      documentComplexity: "simple", dominantRoutes: [], visionPolicy: "skip", specializedContentSummary: [],
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1, pageCount: 3 },
      pages: [{ pageNumber: 3, route: "straightforward-text", confidence: 1, textDensityScore: 0, signals: [], extractorHint: "cheap-text", specializedContent: [],
        ocrDecision: { authorized: false, confidence: 1, signals: ["ocr-not-authorized:blank-page"] } }],
    } })).toEqual({ kept: [2], unread: [3], reason: null });
    // An image file with no text is its single page.
    expect(pagesKeptAsImage({ canonicalDocument: null, pageCount: 1, isImage: true }).kept).toEqual([1]);
  });

  it("emits the page image reference with alt text naming the page", async () => {
    const { state, storage, objects } = fastState();
    const changed = await applyPageImageReferences({ state, document, storage, pages: [{ pageNumber: 2, artifactUri: "s3://bucket/images/doc/v2-150dpi/page-2.png" }], manifestUri: "s3://bucket/images/manifest.json" });
    expect(changed).toEqual([2]);

    const markdownUri = state.artifactLedger.readDocument("doc", "markdown")!;
    const written = String(objects.get(markdownUri.replace("s3://bucket/", "")));
    const pages = written.split("\f");
    expect(pages[0]).toContain("Born-digital text on page one.");
    expect(pages[1]).toBe("![Page 2: scanned page image, no text layer](images/page-0002.png)");
    expect(pages[1]).toBe(pageImageReferenceMarkdown(2));

    const canonical = canonicalDocumentSchema.parse(objects.get(state.artifactLedger.readDocument("doc", "canonical-document")!.replace("s3://bucket/", "")));
    const contract = objects.get(state.artifactLedger.readDocument("doc", "extraction-contract")!.replace("s3://bucket/", "")) as { rawText: string };
    // The raw text (search snippets, page text) carries no reference: page 2 has no extracted text.
    expect(contract.rawText.split("\f")[1]).toBe("");
    expect(canonical.blocks.find((block) => block.pageNumber === 2)?.metadata).toMatchObject({ extractor: "page-image" });

    // Re-applying (a retried stage) changes nothing.
    expect(await applyPageImageReferences({ state, document, storage, pages: [{ pageNumber: 2, artifactUri: "s3://bucket/images/doc/v2-150dpi/page-2.png" }], manifestUri: "s3://bucket/images/manifest.json" })).toEqual([]);
  });

  it("completes the document with no text chunks for the image page", async () => {
    const { state, storage } = fastState();
    await applyPageImageReferences({ state, document, storage, pages: [{ pageNumber: 2, artifactUri: "s3://bucket/images/doc/v2-150dpi/page-2.png" }], manifestUri: "s3://bucket/images/manifest.json" });
    const extracted = await extractTextForEmbedding(
      document, {} as CommandRunner, storage,
      state.artifactLedger.readDocument("doc", "markdown"), undefined,
      state.artifactLedger.readDocument("doc", "canonical-document"),
    );
    expect(extracted.text).not.toContain("scanned page image");
    const chunks = buildCanonicalChunksFromDocument(extracted.canonicalDocument!, document.filename);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => !chunk.text.includes("scanned page image"))).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.pageNumbers ?? [])).not.toContain(2);
  });

  it("treats an all-image document as a valid empty-text document without re-extracting", async () => {
    const reference = pageImageReferenceMarkdown(1);
    const built = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: reference, pageCount: 1, extractor: "page-image" });
    // As reconciliation writes it: the block is marked a reference by its adapter, not by its text.
    const canonical = { ...built, blocks: built.blocks.map((block) => ({ ...block, pageNumber: 1, metadata: { ...block.metadata, extractor: "page-image" } })) };
    const { storage } = memoryStorage({ "markdown/doc.md": reference, "canonical/doc.json": canonical });
    const runner = { extractText: () => { throw new Error("must not re-extract"); } } as unknown as CommandRunner;
    const extracted = await extractTextForEmbedding({ ...document, pageCount: 1 }, runner, storage, "s3://bucket/markdown/doc.md", undefined, "s3://bucket/canonical/doc.json");
    expect(extracted.text.trim()).toBe("");
    const chunks = buildCanonicalChunksFromDocument(extracted.canonicalDocument!, document.filename);
    // The filename fallback chunk keeps the document findable; no chunk carries page text.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.pageNumbers).toEqual([]);
  });

  it("bills a scanned page Fast only when Fast recorded it unread", () => {
    const scannedPdf = { image: false, pages: 2, richRead: 0, scanned: 1 };
    expect(splitRemainingPages({ ...scannedPdf, scannedRead: 0, fastUnread: 1 }, false)).toEqual({ fast: 2, rich: 0 });
    // The scan has no kept-as-image / not-read record: something read it, so it bills Rich.
    expect(splitRemainingPages({ ...scannedPdf, scannedRead: 1, fastUnread: 0 }, false)).toEqual({ fast: 1, rich: 1 });
    expect(splitRemainingPages({ image: true, pages: 1, richRead: 0, scanned: 0, fastUnread: 1 }, false)).toEqual({ fast: 1, rich: 0 });
    expect(splitRemainingPages({ image: true, pages: 1, richRead: 0, scanned: 0, fastUnread: 0 }, false)).toEqual({ fast: 0, rich: 1 });
    expect(pageCredits("fast", 2)).toBeCloseTo(0.01);
    // auto and good still bill an unread scan Rich.
    expect(splitRemainingPages(scannedPdf, true)).toEqual({ fast: 1, rich: 1 });
    expect(splitRemainingPages({ image: true, pages: 1, richRead: 0, scanned: 0 }, true)).toEqual({ fast: 0, rich: 1 });
  });
});

describe("quality fast: kept-as-image renders are bounded", () => {
  const manyPages = 50;
  const blankPdf = { ...document, id: "blank", pageCount: manyPages } as Document;

  function stage(storage: ArtifactStore) {
    const rendered: number[][] = [];
    const rasters = {
      renderSelectedPages: async (args: { document: Document; pageNumbers: number[] }) => {
        rendered.push(args.pageNumbers);
        return args.pageNumbers.map((pageNumber) => ({
          pageNumber, artifactKey: `images/${args.document.id}/page-${pageNumber}.png`,
          artifactUri: `s3://bucket/images/${args.document.id}/page-${pageNumber}.png`, mimeType: "image/png",
        }));
      },
    };
    return { stage: new RenderImagesStage(rasters as never, storage), rendered };
  }

  function blankState(withCanonical: boolean, runId: string) {
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "blank", text: "\f".repeat(manyPages - 1), pageCount: manyPages, extractor: "native-pdf" });
    const contract = buildExtractionContract({
      documentId: "blank", markdown: "", extractor: "native-pdf", strategy: "native-pdf-only", extractionTimeMs: 1, pageCount: manyPages, canonicalDocument: canonical,
    });
    const { storage, objects } = memoryStorage(withCanonical ? { "canonical/blank.json": canonical, "contract/blank.json": contract } : {});
    const facts: Array<{ pageNumber: number; visionStatus?: string }> = [];
    const state = WorkflowState.create({
      id: runId, orgId: "org", userId: "user", workspaceId: "ws", spentCents: 0, stats: {}, artifacts: {},
      pipeline: normalizePipelineFeatures({ quality: "fast" }),
    } as unknown as WorkspaceRun, [blankPdf]);
    // Every other store call is a no-op; page facts are captured.
    const known: Record<string, unknown> = {
      getCompletedPages: async () => new Set<number>(),
      upsertPageFacts: async (rows: typeof facts) => void facts.push(...rows),
    };
    (state as unknown as { store: unknown }).store = new Proxy(known, {
      get: (target, key: string) => target[key] ?? (async () => undefined),
    });
    if (withCanonical) {
      state.artifactLedger.recordDocument("blank", "canonical-document", "s3://bucket/canonical/blank.json");
      state.artifactLedger.recordDocument("blank", "extraction-contract", "s3://bucket/contract/blank.json");
    }
    return { state, storage, objects, facts };
  }

  it("caps a many-page blank PDF at the per-document limit and records the rest unread", async () => {
    vi.stubEnv("WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT", "10");
    vi.stubEnv("WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN", "1000");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, storage, facts } = blankState(true, "run-doc-cap");
      const { stage: render, rendered } = stage(storage);
      await render.run(state);
      expect(rendered.flat()).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
      expect(facts.filter((row) => row.visionStatus === "kept-as-image")).toHaveLength(10);
      expect(facts.filter((row) => row.visionStatus === "not-read")).toHaveLength(manyPages - 10);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps renders per run across documents", async () => {
    vi.stubEnv("WORKER_FAST_PAGE_IMAGE_MAX_PER_DOCUMENT", "1000");
    vi.stubEnv("WORKER_FAST_PAGE_IMAGE_MAX_PER_RUN", "7");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { state, storage } = blankState(true, "run-run-cap");
      const { stage: render, rendered } = stage(storage);
      await render.run(state);
      expect(rendered.flat()).toHaveLength(7);
      // The document's grant is remembered: a retry spends no more of the run budget.
      expect(reserveFastPageImageRenders("run-run-cap", "blank", 50, 7)).toBe(7);
      expect(reserveFastPageImageRenders("run-run-cap", "other", 50, 7)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders nothing when the canonical document is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { state, storage, facts } = blankState(false, "run-missing");
    const { stage: render, rendered } = stage(storage);
    await render.run(state);
    expect(rendered.flat()).toEqual([]);
    expect(facts.filter((row) => row.visionStatus === "kept-as-image")).toEqual([]);
    expect(pagesKeptAsImage({ canonicalDocument: null, pageCount: 50, isImage: false }))
      .toEqual({ kept: [], unread: [], reason: "canonical-document-missing" });
  });

  it("does not attribute unpaged text to page 1 in a multi-page document", () => {
    const canonical = canonicalDocumentSchema.parse({
      ...buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: "Some text.", pageCount: 3, extractor: "kreuzberg" }),
    });
    canonical.blocks = canonical.blocks.map((block) => ({ ...block, pageNumber: null }));
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 3, isImage: false }))
      .toEqual({ kept: [], unread: [], reason: "unpaged-text" });
  });
});

describe("quality fast: references follow the stored image format", () => {
  it.each(["jpg", "webp", "gif"])("round-trips a %s image file through the reference and the export path", async (extension) => {
    const imageDoc = { ...document, id: "img", filename: `photo.${extension}`, mimeType: `image/${extension === "jpg" ? "jpeg" : extension}`, pageCount: 1 } as Document;
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "img", text: "", pageCount: 1, extractor: "textless-image" });
    const contract = buildExtractionContract({
      documentId: "img", markdown: "", extractor: "textless-image", strategy: "textless", extractionTimeMs: 1, pageCount: 1, canonicalDocument: canonical,
    });
    const { storage, objects } = memoryStorage({ "canonical/img.json": canonical, "contract/img.json": contract });
    const state = WorkflowState.create({
      id: "run", orgId: "org", userId: "user", workspaceId: "ws", spentCents: 0, stats: {}, artifacts: {},
      pipeline: normalizePipelineFeatures({ quality: "fast" }),
    } as unknown as WorkspaceRun, [imageDoc]);
    state.artifactLedger.recordDocument("img", "canonical-document", "s3://bucket/canonical/img.json");
    state.artifactLedger.recordDocument("img", "extraction-contract", "s3://bucket/contract/img.json");
    const artifactUri = `s3://bucket/run/images/img/v2-150dpi/page-1.${extension}`;
    expect(await applyPageImageReferences({ state, document: imageDoc, storage, pages: [{ pageNumber: 1, artifactUri }], manifestUri: "s3://bucket/m.json" })).toEqual([1]);
    const written = String(objects.get(state.artifactLedger.readDocument("img", "markdown")!.replace("s3://bucket/", "")));
    const link = /\]\((images\/[^)]+)\)/.exec(written)?.[1];
    expect(link).toBe(`images/page-0001.${extension}`);
    expect(artifactExportPath("page-1", artifactUri)?.path).toBe(link);
  });

  it("ships the referenced page images in a Markdown-only export", async () => {
    const row = {
      id: "doc", workspace_id: "ws", run_id: "run", filename: "scan.pdf", mime_type: "application/pdf", source_key: "raw/doc",
      status: "completed", extraction_mode: "fast", page_count: 3, version_number: 1, metadata: {}, created_at: "2026-10-29", updated_at: "2026-10-29",
      tags: [], artifacts: {
        "doc:markdown": "s3://bucket/run/markdown/doc.md",
        "doc:page-2": "s3://bucket/run/images/doc/page-2.png",
        "doc:page-3": "s3://bucket/run/images/doc/page-3.png",
      },
    } satisfies ExportDocumentRow;
    const source: ExportSource = {
      bucket: "bucket",
      pages: async () => [],
      open: async () => ({ stream: (async function* () { yield new Uint8Array([1]); })(), size: 1 }),
      keptAsImagePages: async () => [2],
    };
    const paths: string[] = [];
    for await (const entry of documentExportEntries({ root: "export", scope: "document", content: "markdown", documents: [row], truncated: false }, source, [])) {
      paths.push(entry.path);
    }
    // Only the kept page's image: page 3 rendered for another reason stays an "all" export asset.
    expect(paths).toContain("export/images/page-0002.png");
    expect(paths).not.toContain("export/images/page-0003.png");
  });
});

describe("quality fast: spoofed reference text", () => {
  it("keeps a text layer containing the exact reference string searchable", async () => {
    const spoof = `${pageImageReferenceMarkdown(1)}\n\nQuarterly revenue grew.`;
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: pageImageReferenceMarkdown(1), pageCount: 1, extractor: "native-pdf" });
    const { storage } = memoryStorage({ "markdown/doc.md": spoof, "canonical/doc.json": canonical });
    const extracted = await extractTextForEmbedding({ ...document, pageCount: 1 }, {} as CommandRunner, storage, "s3://bucket/markdown/doc.md", undefined, "s3://bucket/canonical/doc.json");
    expect(extracted.text).toContain("scanned page image, no text layer");
    expect(extracted.text).toContain("Quarterly revenue grew.");
    const chunks = buildCanonicalChunksFromDocument(extracted.canonicalDocument!, document.filename);
    expect(chunks.some((chunk) => chunk.text.includes("scanned page image, no text layer"))).toBe(true);
    // Not a Fast candidate either: the page has text.
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 1, isImage: false }).kept).toEqual([]);
  });
});
