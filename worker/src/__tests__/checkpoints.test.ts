import { describe, expect, it, vi } from "vitest";

import {
  DocumentStageError,
  completeDocumentPages,
  hashContent,
  isCostCapExceeded,
  runSpentCents,
  runDocumentStage,
  skipCompletedPages,
} from "../pipeline/checkpoints.js";
import { WorkflowState, type CheckpointStore } from "../pipeline/pipeline.js";
import { defaultPipelineFeatures } from "@docslurp/shared";
import type { Document, StageState, WorkspaceRun } from "../models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "run-1",
    orgId: "org-1",
    userId: "user-1",
    kind: "bulk-upload",
    status: "processing",
    stage: "embed",
    totalDocuments: 1,
    processedDocuments: 0,
    pagesTotal: 10,
    pagesProcessed: 0,
    spentCents: 0,
    pipeline: { ...defaultPipelineFeatures },
    error: null,
    stats: {},
    artifacts: {},
    claimId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeState(runOverrides: Partial<WorkspaceRun> = {}): WorkflowState {
  return WorkflowState.create(makeRun(runOverrides), []);
}

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc-1",
    userId: "user-1",
    runId: "run-1",
    filename: "sample.pdf",
    mimeType: "application/pdf",
    sourceKey: "user-1/run-1/raw/sample.pdf",
    status: "queued",
    extractionMode: "hybrid",
    pageCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCheckpointStore(overrides: Partial<CheckpointStore> = {}): CheckpointStore {
  return {
    startDocumentStage: vi.fn(async () => undefined),
    completeDocumentStage: vi.fn(async () => undefined),
    failDocumentStage: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    startRunStage: vi.fn(async () => undefined),
    completeRunStage: vi.fn(async () => undefined),
    failRunStage: vi.fn(async () => undefined),
    appendEvent: vi.fn(async () => undefined),
    setPageStageComplete: vi.fn(async () => undefined),
    getCompletedPages: vi.fn(async () => new Set<number>()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns a 64-character hex string for a string input", () => {
    const hash = hashContent("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same content always produces the same hash", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
  });

  it("different content produces different hashes", () => {
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });

  it("accepts a Buffer input", () => {
    const hash = hashContent(Buffer.from("hello"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("string 'hello' and Buffer.from('hello') produce the same hash", () => {
    expect(hashContent("hello")).toBe(hashContent(Buffer.from("hello")));
  });

  it("empty string has a stable hash", () => {
    const h1 = hashContent("");
    const h2 = hashContent("");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// skipCompletedPages
// ---------------------------------------------------------------------------

describe("skipCompletedPages", () => {
  it("returns all pages when the completed set is empty", () => {
    expect(skipCompletedPages(new Set(), [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("filters out completed page numbers", () => {
    expect(skipCompletedPages(new Set([1, 3, 5]), [1, 2, 3, 4, 5])).toEqual([2, 4]);
  });

  it("returns an empty array when all pages are completed", () => {
    expect(skipCompletedPages(new Set([1, 2, 3]), [1, 2, 3])).toEqual([]);
  });

  it("returns an empty array when the page list is empty", () => {
    expect(skipCompletedPages(new Set([1, 2]), [])).toEqual([]);
  });

  it("handles pages not present in the completed set", () => {
    expect(skipCompletedPages(new Set([99]), [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// isCostCapExceeded
// ---------------------------------------------------------------------------

describe("isCostCapExceeded", () => {
  it("returns false when maxCostCents is null (no cap)", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: null },
    });
    expect(isCostCapExceeded(state)).toBe(false);
  });

  it("returns false when maxCostCents is 0 (cap disabled)", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 0 },
      spentCents: 20,
    });
    expect(isCostCapExceeded(state)).toBe(false);
  });

  it("returns false when total cost is below the cap", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 100 },
      spentCents: 50,
    });
    expect(isCostCapExceeded(state)).toBe(false);
  });

  it("returns true when total cost exactly meets the cap", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 50 },
      spentCents: 50,
    });
    expect(isCostCapExceeded(state)).toBe(true);
  });

  it("returns true when total cost exceeds the cap", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 10 },
      spentCents: 50,
    });
    expect(isCostCapExceeded(state)).toBe(true);
  });

  it("returns false when costs are zero and cap is positive", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 50 },
      spentCents: 0,
    });
    expect(isCostCapExceeded(state)).toBe(false);
  });

  it("adds billable events still buffered in the ledger to the committed spend", () => {
    const state = makeState({
      pipeline: { ...defaultPipelineFeatures, maxCostCents: 50 },
      spentCents: 40,
    });
    // Unbilled compute estimates persist at 0 and never count toward the cap.
    state.usageLedger.enqueue({ provider: "local-compute", model: "w", metric: "worker-stage", amount: 1, unit: "cent",
      costCents: 25, metadata: { billable: false, effectiveCostCents: 25 } });
    expect(runSpentCents(state)).toBe(40);
    expect(isCostCapExceeded(state)).toBe(false);
    state.usageLedger.enqueue({ provider: "docslurp", model: "page-base-fee", metric: "page-base-fee", amount: 10, unit: "page",
      costCents: 10, metadata: {} });
    expect(runSpentCents(state)).toBe(50);
    expect(isCostCapExceeded(state)).toBe(true);
    // A committed checkpoint moves the events from pending into spent_cents.
    const batch = state.usageLedger.checkpoint();
    expect(runSpentCents(state)).toBe(50);
    batch.commit();
    state.run.spentCents = 50;
    expect(state.usageLedger.pendingBillableCents).toBe(0);
    expect(runSpentCents(state)).toBe(50);
  });
});

describe("runDocumentStage", () => {
  it("preserves failure artifact details from DocumentStageError", async () => {
    const state = makeState();
    const document = makeDocument();
    const failDocumentStage = vi.fn(async () => undefined);
    state.store = makeCheckpointStore({ failDocumentStage });

    await expect(
      runDocumentStage(
        state,
        document,
        "quarantine",
        "doc-1:quarantine",
        "quarantine failed",
        async () => {
          throw new DocumentStageError("quarantined: mime mismatch", {
            artifactUri: "s3://docslurp/quarantine/doc-1.json",
            stats: { decision: "quarantined", reasonCodes: ["mime-mismatch"] }
          });
        }
      )
    ).rejects.toThrow("quarantined: mime mismatch");

    expect(state.artifacts["doc-1:quarantine"]).toBe("s3://docslurp/quarantine/doc-1.json");
    expect(failDocumentStage).toHaveBeenCalledWith(
      state,
      "doc-1",
      "quarantine",
      "quarantined: mime mismatch",
      "s3://docslurp/quarantine/doc-1.json",
      { decision: "quarantined", reasonCodes: ["mime-mismatch"] }
    );
  });

  it("retries with the next strategy after a failed attempt", async () => {
    const state = makeState();
    const document = makeDocument();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("default extractor failed"))
      .mockResolvedValueOnce({
        artifactUri: "s3://docslurp/doc-1/markdown.json",
        stats: { plausibilityScore: 0.91 },
      });

    await runDocumentStage(
      state,
      document,
      "extract-markdown",
      "doc-1:markdown",
      "markdown extracted",
      run,
      undefined,
      { retryStrategies: ["docling"] },
    );

    expect(run).toHaveBeenNthCalledWith(1, undefined);
    expect(run).toHaveBeenNthCalledWith(2, "docling");
    expect(state.artifacts["doc-1:markdown"]).toBe("s3://docslurp/doc-1/markdown.json");
    expect(state.artifacts["doc-1:retryCount"]).toBe("2");
    expect(state.documentStage("doc-1", "extract-markdown")).toMatchObject({
      status: "completed",
      attempts: 2,
      artifactUri: "s3://docslurp/doc-1/markdown.json",
    });
    expect(state.pendingPerformance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "stage-retry",
          value: 1,
          tags: ["document", "retry", "error"],
        }),
      ]),
    );
  });

  it("escalates to the next strategy when plausibility is below threshold", async () => {
    const state = makeState();
    const document = makeDocument();
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        artifactUri: "s3://docslurp/doc-1/low-plausibility.md",
        stats: { plausibilityScore: 0.12 },
      })
      .mockResolvedValueOnce({
        artifactUri: "s3://docslurp/doc-1/high-plausibility.md",
        stats: { plausibilityScore: 0.82 },
      });

    await runDocumentStage(
      state,
      document,
      "extract-markdown",
      "doc-1:markdown",
      "markdown extracted",
      run,
      undefined,
      { retryStrategies: ["poppler-text"] },
    );

    expect(run).toHaveBeenNthCalledWith(1, undefined);
    expect(run).toHaveBeenNthCalledWith(2, "poppler-text");
    expect(state.artifacts["doc-1:markdown"]).toBe("s3://docslurp/doc-1/high-plausibility.md");
    expect(state.artifacts["doc-1:retryCount"]).toBe("2");
    expect(state.pendingPerformance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "stage-retry",
          value: 1,
          tags: ["document", "retry", "low-plausibility"],
          metadata: expect.objectContaining({
            strategy: "default",
            plausibilityScore: 0.12,
          }),
        }),
      ]),
    );
  });

  it("keeps a partial artifact from a failed attempt when a retry later succeeds without an artifact", async () => {
    const state = makeState();
    const document = makeDocument();
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new DocumentStageError("partial manifest saved before timeout", {
          artifactUri: "s3://docslurp/doc-1/partial.json",
          stats: { partial: true },
        }),
      )
      .mockResolvedValueOnce({
        stats: { plausibilityScore: 0.75, recovered: true },
      });

    await runDocumentStage(
      state,
      document,
      "vision-extract",
      "doc-1:vision",
      "vision extracted",
      run,
      undefined,
      { retryStrategies: ["fallback"] },
    );

    expect(state.artifacts["doc-1:vision"]).toBe("s3://docslurp/doc-1/partial.json");
    expect(state.documentStage("doc-1", "vision-extract")).toMatchObject({
      status: "completed",
      attempts: 2,
      artifactUri: "s3://docslurp/doc-1/partial.json",
      stats: { plausibilityScore: 0.75, recovered: true },
    });
  });

  it("restores completed checkpoint artifacts and skips the stage body", async () => {
    const state = makeState();
    const document = makeDocument();
    const run = vi.fn(async () => ({
      artifactUri: "s3://docslurp/doc-1/new.json",
      stats: {},
    }));
    const completedStage: StageState = {
      runId: "run-1",
      documentId: "doc-1",
      stageName: "extract-markdown",
      status: "completed",
      attempts: 2,
      artifactUri: "s3://docslurp/doc-1/checkpoint.json",
      stats: { plausibilityScore: 0.9 },
      error: "",
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    };
    state.setDocumentStage(completedStage);
    state.store = makeCheckpointStore();

    await runDocumentStage(
      state,
      document,
      "extract-markdown",
      "doc-1:markdown",
      "markdown extracted",
      run,
    );

    expect(run).not.toHaveBeenCalled();
    expect(state.artifacts["doc-1:markdown"]).toBe("s3://docslurp/doc-1/checkpoint.json");
    expect(state.store.startDocumentStage).not.toHaveBeenCalled();
  });
});


describe("completed page batches", () => {
  it("checkpoints every page with bounded writes and incremental progress", async () => {
    const state = makeState({ pagesTotal: 250 });
    const store = makeCheckpointStore({ setPagesStageComplete: vi.fn(async () => undefined) });
    state.store = store;
    await completeDocumentPages(state, makeDocument({ pageCount: 250 }), "extract-markdown", Array.from({ length: 250 }, (_, i) => i + 1), 250);
    expect(store.setPagesStageComplete).toHaveBeenCalledTimes(3);
    expect(vi.mocked(store.setPagesStageComplete!).mock.calls.flatMap(call => call[3])).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect(store.setPageStageComplete).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledTimes(3);
    expect(state.run.pagesProcessed).toBe(250);
  });
  it("does not report completed extraction for virtual or raster page manifests", async () => {
    const state = makeState();
    state.store = makeCheckpointStore({ setPagesStageComplete: vi.fn(async () => undefined) });
    await completeDocumentPages(state, makeDocument(), "split-pages", [1], 1, false);
    expect(state.run.pagesProcessed).toBe(0);
    expect(state.store.appendEvent).not.toHaveBeenCalled();
  });
  it("does not emit success when persistence fails", async () => {
    const state = makeState();
    state.store = makeCheckpointStore({ setPagesStageComplete: vi.fn(async () => { throw new Error("database unavailable"); }) });
    await expect(completeDocumentPages(state, makeDocument(), "extract-markdown", [1], 1)).rejects.toThrow("database unavailable");
    expect(state.run.pagesProcessed).toBe(0);
    expect(state.store.appendEvent).not.toHaveBeenCalled();
  });
});
