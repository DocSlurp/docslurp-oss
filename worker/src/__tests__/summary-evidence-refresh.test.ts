import { describe, expect, it, vi } from "vitest";

import { normalizePipelineFeatures } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import type { Document, WorkspaceRun } from "../models.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { buildSummaryEvidence } from "../stages/summary-evidence.js";
import { refreshSummaryEvidence } from "../stages/summary-evidence-refresh.js";
import { readSummarySource } from "../stages/summary-source.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

const BUCKET = "b";

class MemoryStore {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, Buffer>();
  uri(key: string) { return `s3://${BUCKET}/${key}`; }
  async getJson<T>(key: string): Promise<T> { return JSON.parse(this.text(key)) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, Buffer.from(JSON.stringify(value))); }
  async putBytes(key: string, data: Uint8Array) { this.objects.set(key, Buffer.from(data)); }
  async deleteKeys(keys: string[]) { for (const key of keys) this.objects.delete(key); }
  async objectSize(key: string) { return this.objects.get(key)?.length ?? null; }
  async getByteRange(key: string, start: number, end: number) { return this.objects.get(key)!.subarray(start, end + 1); }
  text(key: string) { const value = this.objects.get(key); if (!value) throw new Error(`missing ${key}`); return value.toString("utf8"); }
}

function setup() {
  const storage = new MemoryStore();
  const document: Document = {
    id: "doc-1", userId: "u1", runId: "run-1", filename: "scan.pdf", mimeType: "application/pdf",
    sourceKey: "u1/run-1/source/doc-1", status: "processing", extractionMode: "hybrid", pageCount: 2,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const run = { id: "run-1", userId: "u1", orgId: "o1", workspaceId: "w1", stage: "vision-extract", status: "processing",
    pipeline: normalizePipelineFeatures({ summarize: true, vision: { forceAllPages: true } }), stats: {}, artifacts: {} } as unknown as WorkspaceRun;
  const state = WorkflowState.create(run, [document]);
  return { storage, document, state };
}

/** Extraction output as extract-markdown leaves it: markdown, canonical, contract and evidence bound to the markdown. */
function seedExtraction({ storage, document, state }: ReturnType<typeof setup>) {
  const markdown = "# Intake\n\nweak scan one\f# Notes\n\nkeep this page";
  const canonicalDocument = buildCanonicalDocumentFromMarkdown({ documentId: document.id, text: markdown, pageCount: 2, extractor: "baseline" });
  const contract = buildExtractionContract({ documentId: document.id, markdown, extractor: "baseline", strategy: "fast",
    extractionTimeMs: 1, pageCount: 2, canonicalDocument });
  const markdownKey = "u1/run-1/markdown/doc-1.md";
  const evidenceKey = "u1/run-1/summary-evidence/doc-1.json";
  storage.objects.set(markdownKey, Buffer.from(markdown));
  storage.objects.set("u1/run-1/canonical/doc-1.json", Buffer.from(JSON.stringify(canonicalDocument)));
  storage.objects.set("u1/run-1/extraction/doc-1.contract.json", Buffer.from(JSON.stringify(contract)));
  storage.objects.set(evidenceKey, Buffer.from(JSON.stringify(buildSummaryEvidence({
    text: markdown, pageCount: 2, documentId: document.id, sourceUri: storage.uri(markdownKey) }))));
  const ledger = state.artifactLedger;
  ledger.recordDocument(document.id, "markdown", storage.uri(markdownKey));
  ledger.recordDocument(document.id, "canonical-document", storage.uri("u1/run-1/canonical/doc-1.json"));
  ledger.recordDocument(document.id, "extraction-contract", storage.uri("u1/run-1/extraction/doc-1.contract.json"));
  ledger.recordDocument(document.id, "summary-evidence", storage.uri(evidenceKey));
  return { evidenceKey };
}

const summarySource = (ctx: ReturnType<typeof setup>) => readSummarySource(ctx.storage, ctx.document,
  ctx.state.artifactLedger.readDocument(ctx.document.id, "markdown"), undefined,
  ctx.state.artifactLedger.readDocument(ctx.document.id, "summary-evidence"));

describe("summary evidence follows the current markdown", () => {
  it("vision reconciliation rebuilds the evidence from the reconciled markdown", async () => {
    const ctx = setup();
    const { evidenceKey } = seedExtraction(ctx);
    const stage = new VisionExtractStage({} as CommandRunner, ctx.storage as unknown as ArtifactStore, fromEnv(), {} as PdfRasterCache);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await (stage as unknown as { reconcileExtractionArtifacts: (...args: unknown[]) => Promise<{ changedPages: number[] }> })
      .reconcileExtractionArtifacts(ctx.state, ctx.document, { model: "vision-test" },
        [{ pageNumber: 1, text: "# Intake\n\nRecovered handwritten intake form", model: "vision-test" }], ctx.storage.uri("u1/run-1/vision/doc-1.json"));

    expect(result.changedPages).toEqual([1]);
    const markdownUri = ctx.state.artifactLedger.readDocument(ctx.document.id, "markdown");
    expect(markdownUri).toContain("markdown-reconciled");
    expect(JSON.parse(ctx.storage.text(evidenceKey))).toMatchObject({ sourceUri: markdownUri });
    // Before the fix this threw "Summary evidence does not match the current document artifact".
    const source = await summarySource(ctx);
    expect(source?.text).toContain("Recovered handwritten intake form");
    expect(source?.text).not.toContain("weak scan one");
    expect(source?.coverage?.pageReferences).toBe("verified");
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("stale_summary_evidence"));
    warn.mockRestore();
  });

  it("is a no-op when no evidence was recorded", async () => {
    const ctx = setup();
    expect(await refreshSummaryEvidence({ storage: ctx.storage, ledger: ctx.state.artifactLedger, document: ctx.document,
      text: "anything", sourceUri: "s3://b/x.md" })).toBe("absent");
    expect(ctx.storage.objects.size).toBe(0);
  });

  it("overwrites the evidence in place, or deletes it when there is no text to rebuild from", async () => {
    const ctx = setup();
    const { evidenceKey } = seedExtraction(ctx);
    const args = { storage: ctx.storage, ledger: ctx.state.artifactLedger, document: ctx.document };
    expect(await refreshSummaryEvidence({ ...args, text: "new text", sourceUri: "s3://b/new.md" })).toBe("rebuilt");
    expect(JSON.parse(ctx.storage.text(evidenceKey))).toMatchObject({ text: "new text", sourceUri: "s3://b/new.md" });
    expect(await refreshSummaryEvidence({ ...args, text: null, sourceUri: "s3://b/new.md" })).toBe("deleted");
    expect(ctx.storage.objects.has(evidenceKey)).toBe(false);
  });

  it("rejects evidence outside the configured bucket", async () => {
    const ctx = setup();
    ctx.state.artifactLedger.recordDocument(ctx.document.id, "summary-evidence", "s3://other/evidence.json");
    await expect(refreshSummaryEvidence({ storage: ctx.storage, ledger: ctx.state.artifactLedger, document: ctx.document,
      text: "x", sourceUri: "s3://b/x.md" })).rejects.toThrow("configured bucket");
  });
});
