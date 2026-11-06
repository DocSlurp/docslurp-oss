import { defaultPipelineFeatures } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

import type { Document, ProjectRun } from "../models.js";
import { checkDedup, registerHash, runDocumentStage } from "../pipeline/checkpoints.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { extractorFailureReason, extractorFallbackFor, recordExtractorFallback } from "../lib/extractor-fallback.js";

/**
 * A low-plausibility attempt (empty text on a scanned page) escalates to the next extractor. Its output was registered under
 * the source's content hash; the retry must not find it and come back as `extractor=dedup` (reproduced 3 of 3 on a scanned
 * page), and a copy of the same file must not inherit the rejected output.
 */
function document(id: string): Document {
  return { id, userId: "u", runId: "run-1", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: `raw/${id}`, status: "queued",
    extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date() } as Document;
}
const run = { id: "run-1", orgId: "o", userId: "u", kind: "bulk-upload", status: "processing", stage: "extract-markdown", pipeline: { ...defaultPipelineFeatures },
  stats: {}, artifacts: {}, totalDocuments: 2, processedDocuments: 0, pagesTotal: 2, pagesProcessed: 0, spentCents: 0 } as unknown as ProjectRun;

/** extract-markdown's dedup use, with `extractors` tried in order: plausibility 0 for empty text. */
function extractStage(state: WorkflowState, doc: Document, outputs: Record<string, string>, seen: string[]) {
  return async (strategy?: string) => {
    const existing = checkDedup(state, "sha-scan", `${doc.id}:markdown`, doc.id);
    if (existing) {
      seen.push("dedup");
      return { artifactUri: existing, stats: { deduplicated: true, extractor: "dedup" } };
    }
    const extractor = strategy ?? "poppler-text";
    seen.push(extractor);
    const uri = `s3://b/${doc.id}/${extractor}.md`;
    registerHash(state, "sha-scan", uri, doc.id);
    return { artifactUri: uri, stats: { extractor, plausibilityScore: outputs[extractor]!.trim() ? 0.9 : 0 } };
  };
}

describe("dedup never serves a document its own rejected attempt", () => {
  it("retries with the next extractor instead of reusing the low-quality output it just registered", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const doc = document("doc-a");
    const state = WorkflowState.create(run, [doc, document("doc-b")]);
    const seen: string[] = [];
    await runDocumentStage(state, doc, "extract-markdown", "doc-a:markdown", "markdown extracted",
      extractStage(state, doc, { "poppler-text": "", ocr: "Scanned page text." }, seen), undefined, { retryStrategies: ["ocr"] });
    expect(seen).toEqual(["poppler-text", "ocr"]);
    // The rejected extractor is a fallback the ingest report shows.
    expect(extractorFallbackFor(state.artifactLedger, "doc-a", "ocr", ["poppler-text", "ocr"])).toEqual({
      wanted: "poppler-text", served: "ocr", reasons: [{ extractor: "poppler-text", reason: "low-quality" }],
    });
    expect(state.documentStage("doc-a", "extract-markdown")).toMatchObject({ status: "completed", stats: { extractor: "ocr" } });

    // A copy of the same bytes reuses the accepted output, never the rejected one.
    expect(checkDedup(state, "sha-scan", "doc-b:markdown", "doc-b")).toBe("s3://b/doc-a/ocr.md");
  });

  it("withdraws a rejected attempt's entry so a copy processed meanwhile cannot inherit it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const doc = document("doc-a");
    const state = WorkflowState.create(run, [doc]);
    let copySaw: string | undefined = "unset";
    await runDocumentStage(state, doc, "extract-markdown", "doc-a:markdown", "markdown extracted", async (strategy?: string) => {
      if (strategy) {
        copySaw = checkDedup(state, "sha-scan", "doc-b:markdown", "doc-b");
        return { artifactUri: "s3://b/doc-a/ocr.md", stats: { plausibilityScore: 0.9 } };
      }
      registerHash(state, "sha-scan", "s3://b/doc-a/poppler-text.md", "doc-a");
      return { artifactUri: "s3://b/doc-a/poppler-text.md", stats: { plausibilityScore: 0 } };
    }, undefined, { retryStrategies: ["ocr"] });
    expect(copySaw).toBeUndefined();
  });
});

describe("extractor fallbacks", () => {
  const ledger = () => {
    const values = new Map<string, string>();
    return { read: (key: string) => values.get(key), record: (key: string, value: string | null | undefined) => { if (value) values.set(key, value); return value ?? undefined; } };
  };

  it("names the wanted extractor, the one that served, and public reasons only", () => {
    const l = ledger();
    recordExtractorFallback(l, "d", "doppler-md", extractorFailureReason(new Error("pdftomarkdown crashed: SIGSEGV at /usr/local/bin")));
    recordExtractorFallback(l, "d", "native-pdf", extractorFailureReason(Object.assign(new Error("aborted"), { name: "AbortError" })));
    expect(extractorFallbackFor(l, "d", "poppler-text", ["doppler-md", "native-pdf", "poppler-text"])).toEqual({
      wanted: "doppler-md", served: "poppler-text",
      reasons: [{ extractor: "doppler-md", reason: "failed" }, { extractor: "native-pdf", reason: "timeout" }],
    });
    expect(l.read("extractor-fallbacks:d")).not.toMatch(/SIGSEGV|usr/);
  });

  it("is not a fallback when the extractor that failed comes after the one that served (a voting secondary)", () => {
    const l = ledger();
    recordExtractorFallback(l, "d", "poppler-text", "failed");
    expect(extractorFallbackFor(l, "d", "native-pdf", ["native-pdf", "poppler-text"])).toBeNull();
    expect(extractorFallbackFor(l, "other", "native-pdf", ["native-pdf", "poppler-text"])).toBeNull();
  });

  it("drops ids that are not extractor ids", () => {
    const l = ledger();
    recordExtractorFallback(l, "d", "/bin/sh -c x", "failed");
    recordExtractorFallback(l, "d", undefined, "low-quality");
    expect(extractorFallbackFor(l, "d", "poppler-text", ["poppler-text"])).toBeNull();
  });
});
