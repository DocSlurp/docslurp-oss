import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures, PrivacyModeViolationError, type PipelineFeatureOverrides } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { DocumentSummaryStage } from "../stages/document-summary.js";
import { StructuredExtractStage } from "../stages/structured-extract.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { embedTextChunks } from "../stages/embedding-runtime.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";

const { generateText, providerFetch } = vi.hoisted(() => ({ generateText: vi.fn(), providerFetch: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateText, embedMany: generateText }));
vi.mock("../lib/provider-retry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-retry.js")>()),
  fetchWithProviderRetry: providerFetch,
}));

function stateFor(pipeline: PipelineFeatureOverrides) {
  const audit = vi.fn(async () => {});
  const state = {
    run: { id: "run-1", workspaceId: "ws-1", pipeline: normalizePipelineFeatures(pipeline) },
    documents: [{ id: "doc-1", userId: "user", filename: "a.pdf", mimeType: "application/pdf", pageCount: 2 }],
    documentStages: new Map(),
    docConcurrency: 1,
    artifactLedger: { readDocument: () => undefined },
    usageLedger: { record: vi.fn(), enqueue: vi.fn() },
    pendingPerformance: [],
    store: { recordPrivacyAudit: audit },
  } as unknown as WorkflowState;
  return { state, audit };
}

const storage = { putJson: vi.fn(), uri: (key: string) => key } as unknown as ArtifactStore;
const config = { ...fromEnv(), openRouterApiKey: "test-key", openAiApiKey: "test-key" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("privacyMode enforcement in worker clients", () => {
  it("the hosted text client refuses to call out under local-only", async () => {
    await expect(generateOpenRouterText({
      operation: "document-summary", apiKey: "k", model: "vendor/model", prompt: "secret", maxOutputTokens: 10, privacyMode: "local-only",
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("the vision runtime refuses hosted routes under strict-privacy", async () => {
    await expect(executeVisionRuntime({
      imagePath: "/nonexistent.png",
      outputPath: "/nonexistent.json",
      vision: normalizePipelineFeatures({}).vision,
      cfg: config,
      runner: {} as CommandRunner,
      privacyMode: "strict-privacy",
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("hosted embeddings fail closed", async () => {
    await expect(embedTextChunks({
      chunks: ["secret"],
      profile: { profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small", runtime: "remote", provider: "openai", model: "text-embedding-3-small", baseUrl: null, dimensions: 1536, task: "document", normalize: true, batchSize: 8, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true },
      config,
      privacyMode: "local-only",
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe("privacyMode enforcement in worker stages", () => {
  it("skips document summaries under local-only without auditing", async () => {
    const { state, audit } = stateFor({ summarize: true, privacyMode: "local-only" });
    await new DocumentSummaryStage({} as CommandRunner, storage, config).run(state);
    expect(generateText).not.toHaveBeenCalled();
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("skips structured extraction under strict-privacy and audits the blocked attempt", async () => {
    const { state, audit } = stateFor({
      privacyMode: "strict-privacy",
      outputSchema: { type: "object", properties: { total: { type: "number" } } },
    });
    await new StructuredExtractStage(storage, config).run(state);
    expect(generateText).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith([
      expect.objectContaining({
        workspaceId: "ws-1",
        runId: "run-1",
        documentId: "doc-1",
        endpoint: "blocked:worker.text.structured-extraction",
        privacyMode: "strict-privacy",
      }),
    ]);
  });

  it("skips hosted vision fallback under strict-privacy and audits it", async () => {
    const { state, audit } = stateFor({ privacyMode: "strict-privacy", visionFallback: true, vision: { profile: "good-fast-hosted" } });
    await new VisionExtractStage({} as CommandRunner, storage, config, {} as PdfRasterCache).run(state);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith([expect.objectContaining({ endpoint: "blocked:worker.vision", documentId: "doc-1" })]);
  });
});
