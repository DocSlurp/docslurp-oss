import { describe, expect, it } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";

import { applyPageImageReferences } from "../lib/page-image-references.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { PageIndexStage } from "../stages/page-index.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";
import type { Document, WorkspaceRun } from "../models.js";

/**
 * Page-level text (document_pages, which feeds page search and chat context) never carries a Fast page-image
 * reference: page-index reads the canonical document, so the reference page is stored with no text.
 */
describe("page-index: Fast page-image references", () => {
  it("stores the reference page with no text", async () => {
    const document = { id: "doc", userId: "user", filename: "scan.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "source.pdf" } as Document;
    const markdown = "# Intro\n\nBorn-digital text on page one.\f";
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: markdown, pageCount: 2, extractor: "native-pdf" });
    const contract = buildExtractionContract({
      documentId: "doc", markdown, extractor: "native-pdf", strategy: "native-pdf-only", extractionTimeMs: 1, pageCount: 2, canonicalDocument: canonical,
    });
    const objects = new Map<string, unknown>([["canonical/doc.json", canonical], ["contract/doc.json", contract]]);
    const storage = {
      bucket: "bucket",
      uri: (key: string) => `s3://bucket/${key}`,
      getJson: async (key: string) => structuredClone(objects.get(key)),
      putJson: async (key: string, value: unknown) => void objects.set(key, structuredClone(value)),
      putBytes: async (key: string, value: Uint8Array) => void objects.set(key, Buffer.from(value).toString("utf8")),
      getBytes: async (key: string) => Buffer.from(String(objects.get(key) ?? ""), "utf8"),
      deleteKeys: async () => undefined,
    } as unknown as ArtifactStore;
    const state = WorkflowState.create({
      id: "run", orgId: "org", userId: "user", workspaceId: "ws", spentCents: 0, stats: {}, artifacts: {},
      pipeline: normalizePipelineFeatures({ quality: "fast", pageIndex: true }),
    } as unknown as WorkspaceRun, [document]);
    state.artifactLedger.recordDocument("doc", "canonical-document", "s3://bucket/canonical/doc.json");
    state.artifactLedger.recordDocument("doc", "extraction-contract", "s3://bucket/contract/doc.json");
    await applyPageImageReferences({
      state, document, storage, manifestUri: "s3://bucket/images/manifest.json",
      pages: [{ pageNumber: 2, artifactUri: "s3://bucket/images/doc/page-2.png" }],
    });
    // The Markdown artifact itself carries the reference (that is what the export links resolve against).
    expect(String(objects.get(state.artifactLedger.readDocument("doc", "markdown")!.replace("s3://bucket/", "")))).toContain("images/page-0002.png");

    const inserted: Array<{ pageNumber: number; text: string }> = [];
    const known: Record<string, unknown> = {
      getCompletedPages: async () => new Set<number>(),
      insertPages: async (rows: Array<{ pageNumber: number; text: string }>) => void inserted.push(...rows),
    };
    (state as unknown as { store: unknown }).store = new Proxy(known, { get: (target, key: string) => target[key] ?? (async () => undefined) });

    await new PageIndexStage({} as CommandRunner, storage).run(state);

    expect(inserted.map((row) => row.pageNumber)).toEqual([1, 2]);
    expect(inserted[0]!.text).toContain("Born-digital text on page one.");
    expect(inserted[1]!.text.trim()).toBe("");
    expect(inserted.some((row) => row.text.includes("scanned page image") || row.text.includes("images/page-"))).toBe(false);
  });
});
