import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";
import { fromEnv } from "../config.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { DocumentSummaryStage } from "../stages/document-summary.js";
import { PropositionIndexStage } from "../stages/proposition-index.js";

const { generate, record } = vi.hoisted(() => ({ generate: vi.fn(), record: vi.fn() }));
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: generate }));
vi.mock("../pipeline/checkpoints.js", () => ({
  runDocuments: async (documents: unknown[], _limit: number, run: (document: unknown) => Promise<void>) => {
    for (const document of documents) await run(document);
  },
  runDocumentStage: async (_state: unknown, _document: unknown, _stage: string, _slot: string, _message: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../stages/embedding-runtime.js", () => ({
  extractTextForEmbedding: async () => ({ text: "This document describes a useful system and its behavior in enough detail for proposition extraction. ".repeat(3) }),
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
  generate.mockResolvedValue({ text: "A useful proposition.", usage: { inputTokens: 10, outputTokens: 5 } });
});

describe("configured text models reach worker stages and usage records", () => {
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
