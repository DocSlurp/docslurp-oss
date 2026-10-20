import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";

const ORDER = ["kreuzberg", "poppler-text"];

function createRun(): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 2, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

function createDocument(): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "catalog.pdf", mimeType: "application/pdf",
    sourceKey: "raw/doc-1.pdf", status: "processing", extractionMode: "hybrid", pageCount: 2,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/**
 * The stage's real control flow (planning, candidate collection, strategy
 * escalation, runDocumentStage) with each extractor replaced by `extract`.
 */
function stageWith(extract: (label: string) => Promise<never>) {
  const attempted: string[] = [];
  const stage = new ExtractMarkdownStage({} as any, {} as any, {} as any);
  const internals = stage as any;
  internals.sources = { get: async () => ({ path: "/nonexistent/source.pdf", sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.tryResolveExtractorOrder = () => [...ORDER];
  internals.describeExtractorOrder = () => ORDER.join(">");
  internals.planExtractors = async ({ attemptLedger }: { attemptLedger: ExtractorAttemptLedger }) => {
    const reserved = new Set(attemptLedger.snapshot().attempted);
    const label = ORDER.find((candidate) => !reserved.has(candidate));
    return label ? { primary: { label }, secondary: null, tableAware: false } : null;
  };
  internals.extractCandidate = async (extractor: { label: string }) => {
    attempted.push(extractor.label);
    return await extract(extractor.label);
  };
  const state = WorkflowState.create(createRun(), [createDocument()]);
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", "pdf");
  return { stage, state, attempted };
}

describe("extract-markdown interruptions", () => {
  it("rethrows an activity cancellation as an interruption instead of 'no extractor produced output'", async () => {
    const controller = new AbortController();
    const { stage, state, attempted } = stageWith(async () => {
      // Worker shutdown / activity cancellation lands while the primary extractor runs.
      controller.abort(abortError());
      throw abortError();
    });

    const failure = await stage.run(state, controller.signal).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    expect((failure as Error).message).not.toMatch(/no extractor produced output/);
    expect(attempted).toEqual(["kreuzberg"]);
    expect(state.documentStage("doc-1", "extract-markdown")?.status).not.toBe("failed");
  });

  it("falls through to the next extractor when an extractor's own timeout aborts it", async () => {
    const controller = new AbortController();
    const { stage, state, attempted } = stageWith(async (label) => {
      // The extractor's derived per-tool timeout signal fired; the activity signal did not.
      if (label === "kreuzberg") throw abortError();
      throw new Error("pdftotext: unreadable cross-reference table");
    });

    await stage.run(state, controller.signal);

    expect(controller.signal.aborted).toBe(false);
    expect(attempted).toEqual(["kreuzberg", "poppler-text"]);
    const checkpoint = state.documentStage("doc-1", "extract-markdown");
    expect(checkpoint?.status).toBe("failed");
    expect(checkpoint?.error).toMatch(/no extractor produced output: poppler-text=Error: pdftotext/);
  });
});
