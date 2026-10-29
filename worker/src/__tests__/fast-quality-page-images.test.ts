import { describe, expect, it } from "vitest";
import {
  canonicalDocumentSchema,
  normalizePipelineFeatures,
  pageCredits,
  pageImageReferenceMarkdown,
  type CanonicalDocument,
} from "@docslurp/shared";

import { splitRemainingPages } from "../db/page-base-fee.js";
import { applyPageImageReferences, pagesKeptAsImage } from "../lib/page-image-references.js";
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
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 2, isImage: false })).toEqual([2]);
    expect(pagesKeptAsImage({ canonicalDocument: canonical, pageCount: 3, isImage: false, routing: {
      status: "ready", documentId: "doc", label: "x", confidence: 1, signals: [], suggestedPlaybook: null,
      documentComplexity: "simple", dominantRoutes: [], visionPolicy: "skip", specializedContentSummary: [],
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/c.json", characterCount: 1, pageCount: 3 },
      pages: [{ pageNumber: 3, route: "straightforward-text", confidence: 1, textDensityScore: 0, signals: [], extractorHint: "cheap-text", specializedContent: [],
        ocrDecision: { authorized: false, confidence: 1, signals: ["ocr-not-authorized:blank-page"] } }],
    } })).toEqual([2]);
    // An image file with no text is its single page.
    expect(pagesKeptAsImage({ canonicalDocument: null, pageCount: 1, isImage: true })).toEqual([1]);
  });

  it("emits the page image reference with alt text naming the page", async () => {
    const { state, storage, objects } = fastState();
    const changed = await applyPageImageReferences({ state, document, storage, pages: [2], manifestUri: "s3://bucket/images/manifest.json" });
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
    expect(await applyPageImageReferences({ state, document, storage, pages: [2], manifestUri: "s3://bucket/images/manifest.json" })).toEqual([]);
  });

  it("completes the document with no text chunks for the image page", async () => {
    const { state, storage } = fastState();
    await applyPageImageReferences({ state, document, storage, pages: [2], manifestUri: "s3://bucket/images/manifest.json" });
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
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: reference, pageCount: 1, extractor: "page-image" });
    const { storage } = memoryStorage({ "markdown/doc.md": reference, "canonical/doc.json": canonical });
    const runner = { extractText: () => { throw new Error("must not re-extract"); } } as unknown as CommandRunner;
    const extracted = await extractTextForEmbedding({ ...document, pageCount: 1 }, runner, storage, "s3://bucket/markdown/doc.md", undefined, "s3://bucket/canonical/doc.json");
    expect(extracted.text.trim()).toBe("");
    const chunks = buildCanonicalChunksFromDocument(extracted.canonicalDocument!, document.filename);
    // The filename fallback chunk keeps the document findable; no chunk carries page text.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.pageNumbers).toEqual([]);
  });

  it("bills the scanned page Fast", () => {
    const scannedPdf = { image: false, pages: 2, richRead: 0, scanned: 1 };
    expect(splitRemainingPages(scannedPdf, false)).toEqual({ fast: 2, rich: 0 });
    expect(splitRemainingPages({ image: true, pages: 1, richRead: 0, scanned: 0 }, false)).toEqual({ fast: 1, rich: 0 });
    expect(pageCredits("fast", 2)).toBeCloseTo(0.01);
    // auto and good still bill an unread scan Rich.
    expect(splitRemainingPages(scannedPdf, true)).toEqual({ fast: 1, rich: 1 });
    expect(splitRemainingPages({ image: true, pages: 1, richRead: 0, scanned: 0 }, true)).toEqual({ fast: 0, rich: 1 });
  });
});
