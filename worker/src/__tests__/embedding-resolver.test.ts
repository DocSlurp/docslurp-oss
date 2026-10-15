import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { Config } from "../config.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { parseLanceDbUri, parseStorageUri } from "@docslurp/shared";

const baseConfig: Config = {
  databaseUrl: "postgres://docslurp:docslurp@localhost:5432/docslurp",
  storage: parseStorageUri("s3://minioadmin:minioadmin@docslurp-files?endpoint=http://localhost:9000"),
  s3Bucket: "docslurp-files",
  lancedb: parseLanceDbUri(undefined),
  openAiApiKey: "",
  openAiBaseUrl: "https://api.openai.com/v1",
  defaultInferenceLane: "standard",
  vectorBackends: ["lancedb"],
  lancedbReindexPages: 20,
  lancedbMaintenanceEnabled: true,
  lancedbVectorIndexMinRows: 5_000,
  workerLeaseTtlMs: 45_000,
  workerMaxRuntimeMs: 0,
  workerDocConcurrency: 1,
  workerActivityConcurrency: 1,
  workerAdaptiveTuning: true,
  serializePdfCandidateExtraction: false,
  visionDensityThreshold: 0.25,
  pythonPoolSize: 2,
  parserArtifactTimeoutMs: 30_000,
  unstructuredParserChunkTimeoutMs: 20_000,
  unstructuredParserInitialChunkPages: 1,
  unstructuredParserMaxChunkPages: 2,
  unstructuredParserMaxConcurrency: 3,
  costPer1kInputTokens: 0.01,
  costPer1kOutputTokens: 0.03,
  openRouterApiKey: "",
  plausibilityWarningThreshold: 0.3,
  budgetSweepIntervalMs: 3_600_000,
  retentionSweepIntervalMs: 21_600_000,
  retentionSweepBatchSize: 25,
  apiKeyUsageRetentionDays: 30,
  perfLogRetentionDays: 90,
  storageIntegritySweepMaxKeys: 500,
  storageIntegritySweepPrefix: null,
  quarantineEnabled: true,
  quarantineFailOpenOnToolMissing: true,
  quarantineMaxArchiveEntries: 2_000,
  quarantineMaxArchiveDepth: 12,
  quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024,
  quarantineMaxSingleEntryBytes: 128 * 1024 * 1024,
  quarantineMaxExpansionRatio: 250,
  workerDbPoolMax: 10,
  workerRunMaintenance: "auto",
  workerShutdownGraceMs: 240_000,
  temporalActivityTaskQueue: null,
  poisonRunFailureThreshold: 3,
  temporalAddress: "localhost:7233",
  temporalNamespace: "default",
  temporalTaskQueue: "docslurp-pipeline",
  temporalTlsEnabled: false,
  temporalTlsServerName: null,
  temporalTlsCaCertPem: null,
  temporalTlsCaCertPath: null,
  temporalTlsClientCertPem: null,
  temporalTlsClientCertPath: null,
  temporalTlsClientKeyPem: null,
  temporalTlsClientKeyPath: null,
};

describe("resolveEmbeddingModel", () => {
  it("uses the run pipeline instead of env-style embedding overrides", () => {
    const result = resolveEmbeddingModel(
      baseConfig,
      defaultPipelineFeatures,
      "en",
    );

    expect(result.modelUri).toBe(defaultPipelineFeatures.embedding.modelUri);
    expect(result.model).toBe("Xenova/bge-m3");
    expect(result.provider).toBe("transformers.js");
    expect(result.runtime).toBe("local");
    expect(result.dimensions).toBe(1024);
  });

  it("respects workspace-selected remote models while keeping workspace dimensions", () => {
    const pipeline = {
      ...defaultPipelineFeatures,
      embedding: {
        ...defaultPipelineFeatures.embedding,
        profile: "cheapest-hosted" as const,
        target: "hosted" as const,
        modelUri: "llm://openai/text-embedding-3-small",
      },
    };

    const result = resolveEmbeddingModel(baseConfig, pipeline, "en");

    expect(result.model).toBe("text-embedding-3-small");
    expect(result.provider).toBe("openai");
    expect(result.runtime).toBe("remote");
    expect(result.modelUri).toBe("llm://openai/text-embedding-3-small");
    expect(result.dimensions).toBe(1536);
  });

  it("derives custom local routes without exposing adapter knobs in workspace config", () => {
    const pipeline = {
      ...defaultPipelineFeatures,
      embedding: {
        ...defaultPipelineFeatures.embedding,
        target: "local" as const,
        modelUri: "llm://ollama/nomic-embed-text",
      },
    };

    const result = resolveEmbeddingModel(baseConfig, pipeline, "en");

    expect(result.target).toBe("local");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("nomic-embed-text");
    expect(result.runtime).toBe("remote");
    expect(result.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });
});
