import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";
import { fromEnv } from "../config.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { DocumentSummaryStage } from "../stages/document-summary.js";
import { PropositionIndexStage } from "../stages/proposition-index.js";

const { generate, record, extract } = vi.hoisted(() => ({ generate: vi.fn(), record: vi.fn(), extract: vi.fn() }));
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: generate }));
vi.mock("../pipeline/checkpoints.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../pipeline/checkpoints.js")>(),
  runDocumentStage: async (_state: unknown, _document: unknown, _stage: string, _slot: string, _message: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../stages/summary-source.js", () => ({ readSummarySource: extract }));
vi.mock("../stages/embedding-runtime.js", () => ({
  extractTextForEmbedding: extract,
  embedTextChunks: async () => ({ vectors: [[0.1, 0.2]], totalTokens: 5 }),
  estimateTokens: () => 5,
  embeddingCallCostCents: (_profile: unknown, embedded: { costCents?: number }) => embedded.costCents ?? 0,
}));
vi.mock("../embeddings/resolver.js", () => ({
  detectLanguage: () => "en",
  resolveEmbeddingModel: () => ({ model: "local-embedding", provider: "local", runtime: "local", dimensions: 2 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  extract.mockResolvedValue({ text: "This document describes a useful system and its behavior in enough detail for proposition extraction. ".repeat(3), sourceBytes: 300, readBytes: 300, sampled: false });
  generate.mockResolvedValue({ text: "A useful proposition.", usage: { inputTokens: 10, outputTokens: 5 } });
});

describe("configured text models reach worker stages and usage records", () => {
  it("bounds a thousand-document batch to four concurrent summary calls", async () => {
    let active = 0;
    let peak = 0;
    generate.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { text: "Summary.", usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const state = {
      run: { id: "run", pipeline: normalizePipelineFeatures({ summarize: true }) },
      documents: Array.from({ length: 1000 }, (_, index) => ({ id: `doc-${index}`, userId: "user", filename: "short.pdf", pageCount: 2 })),
      docConcurrency: 1000, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const storage = { putJson: vi.fn(), uri: (key: string) => key } as unknown as ArtifactStore;
    await new DocumentSummaryStage({} as CommandRunner, storage, { ...fromEnv(), openRouterApiKey: "test" }).run(state);
    expect(generate).toHaveBeenCalledTimes(1000);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("skips generation when the run's cost cap is exhausted or extracted text is unavailable", async () => {
    const state = {
      run: { id: "run", spentCents: 100, pipeline: normalizePipelineFeatures({ summarize: true, maxCostCents: 100 }) },
      documents: [{ id: "doc", userId: "user", filename: "large.pdf" }],
      docConcurrency: 1, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record, pendingBillableCents: 0 }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const storage = { putJson: vi.fn(), uri: (key: string) => key } as unknown as ArtifactStore;
    const stage = new DocumentSummaryStage({} as CommandRunner, storage, { ...fromEnv(), openRouterApiKey: "test" });
    await stage.run(state);
    expect(extract).not.toHaveBeenCalled();
    state.run.spentCents = 0;
    extract.mockResolvedValue(null);
    await stage.run(state);
    expect(generate).not.toHaveBeenCalled();
    expect(storage.putJson).not.toHaveBeenCalled();
  });

  it("makes one bounded document-summary call for a long document, and none when disabled", async () => {
    extract.mockResolvedValue({ text: "# Beginning\n" + "Source detail. ".repeat(30_000) + "\n# Conclusion\nFinal findings." });
    const state = {
      run: { id: "run", pipeline: normalizePipelineFeatures({ summarize: false }) },
      documents: [{ id: "document", userId: "user", filename: "document", pageCount: 100_000 }],
      docConcurrency: 1, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const putJson = vi.fn();
    const storage = { putJson, uri: (key: string) => key } as unknown as ArtifactStore;
    const stage = new DocumentSummaryStage({} as CommandRunner, storage, { ...fromEnv(), openRouterApiKey: "test" });
    await stage.run(state);
    expect(extract).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    state.run.pipeline.summarize = true;
    state.run.pipeline.textGeneration.maxOutputTokens = { "document-summary": 16_384 };
    await stage.run(state);
    expect(generate).toHaveBeenCalledOnce();
    const call = generate.mock.calls[0]![0];
    expect(call.maxOutputTokens).toBe(256);
    expect(call.textGeneration.reasoningEfforts["document-summary"]).toBe("none");
    expect(call.textGeneration.maxOutputTokens["document-summary"]).toBe(256);
    expect(call.prompt.length).toBeLessThan(26_000);
    expect(call.prompt).toContain("Final findings.");
    expect(call.system).toContain("representative excerpts");
    expect(putJson).toHaveBeenCalledOnce();
    expect(putJson).toHaveBeenCalledWith(expect.stringContaining("/summaries/document.json"), expect.objectContaining({ documentId: "document" }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ metric: "summary-generation", amount: 1, unit: "document" }));
  });

  it("records truncated generation usage but never embeds or saves it, and preserves explicit reasoning overrides", async () => {
    generate.mockResolvedValue({ text: "Thinking Process: unfinished", finishReason: "length", usage: { inputTokens: 10, outputTokens: 256 } });
    const state = {
      run: { id: "run", pipeline: normalizePipelineFeatures({ summarize: true,
        textGeneration: { reasoningEfforts: { "document-summary": "high" } } }) },
      documents: [{ id: "document", userId: "user", filename: "document" }],
      docConcurrency: 1, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const putJson = vi.fn();
    const stage = new DocumentSummaryStage({} as CommandRunner,
      { putJson, uri: (key: string) => key } as unknown as ArtifactStore,
      { ...fromEnv(), openRouterApiKey: "test" });
    await stage.run(state);
    expect(putJson).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ metric: "summary-generation", outputTokens: 256 }));
    expect(generate.mock.calls[0]![0].textGeneration.reasoningEfforts["document-summary"]).toBe("high");
  });

  it("prefixes sampled summaries with deterministic coverage even when the model omits it", async () => {
    extract.mockResolvedValue({ text: "Evidence", sampled: true, sourceBytes: 100_000, readBytes: 100,
      coverage: { totalPages: 5000, pages: [{ pageNumber: 1, clipped: true }, { pageNumber: 5000, clipped: false }], pageReferences: "verified" } });
    const state = {
      run: { id: "run", pipeline: normalizePipelineFeatures({ summarize: true }) },
      documents: [{ id: "document", userId: "user", filename: "document" }],
      docConcurrency: 1, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const putJson = vi.fn();
    await new DocumentSummaryStage({} as CommandRunner,
      { putJson, uri: (key: string) => key } as unknown as ArtifactStore,
      { ...fromEnv(), openRouterApiKey: "test" }).run(state);
    expect(putJson.mock.calls[0]![1].summary).toMatch(/^Sampled document overview \(2 of 5000 pages/);
    expect(putJson.mock.calls[0]![1].sourceSelection.coverage.pages[1].pageNumber).toBe(5000);
  });

  it.each([
    [DocumentSummaryStage, "document-summary", "summary-generation"],
    [PropositionIndexStage, "proposition-extraction", "proposition-generation"],
  ] as const)("%s respects a task override", async (StageClass, operation, metric) => {
    const state = {
      run: { id: "run", pipeline: normalizePipelineFeatures({ summarize: true, propositionIndex: true,
        textGeneration: { model: "vendor/workspace", models: { [operation]: "vendor/task" } } }) },
      documents: [{ id: "document", userId: "user", filename: "document" }],
      docConcurrency: 1, artifactLedger: { readDocument: () => undefined },
      usageLedger: { record }, pendingPerformance: [],
    } as unknown as WorkflowState;
    const storage = { putJson: vi.fn(), uri: (key: string) => key } as unknown as ArtifactStore;
    const stage = new StageClass({} as CommandRunner, storage, { ...fromEnv(), openRouterApiKey: "test", textGenerationModel: "vendor/deployment" });
    await stage.run(state);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ operation, model: "vendor/task" }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ metric, model: "vendor/task", inputTokens: 10, outputTokens: 5 }));
  });
});
