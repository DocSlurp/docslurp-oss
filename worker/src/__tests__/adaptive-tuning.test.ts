import { describe, expect, it } from "vitest";

import { normalizePipelineFeatures } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";
import {
  adaptiveEmbeddingBatchSizeForStage,
  adaptiveTuningPerformanceEvents,
  adaptiveUnstructuredSettingsForStage,
  applyAdaptiveStageTuning,
  detectMemoryLimitBytes,
  resolveAdaptiveStageTuning,
  type ResourceSnapshot,
} from "../pipeline/adaptive-tuning.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { parseLanceDbUri, parseStorageUri } from "@docslurp/shared";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
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
    workerDocConcurrency: 4,
    workerActivityConcurrency: 1,
    workerAdaptiveTuning: true,
    serializePdfCandidateExtraction: false,
    visionDensityThreshold: 0.25,
    pythonPoolSize: 2,
    parserArtifactTimeoutMs: 30_000,
    unstructuredParserChunkTimeoutMs: 20_000,
    unstructuredParserInitialChunkPages: 1,
    unstructuredParserMaxChunkPages: 3,
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
    storageIntegritySweepMaxKeys: 20_000,
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
    temporalMaterializeTaskQueue: null,
    materializeConcurrency: 4,
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
    ...overrides,
  };
}

function makeDocument(id: string, pageCount: number): Document {
  return {
    id,
    userId: "user-1",
    runId: "run-1",
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    sourceKey: `source/${id}.pdf`,
    status: "queued",
    extractionMode: "auto",
    pageCount,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeState(documents: Document[]): WorkflowState {
  const run: WorkspaceRun = {
    id: "run-1",
    orgId: "org-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    kind: "ingest",
    status: "processing",
    stage: "queued",
    totalDocuments: documents.length,
    processedDocuments: 0,
    pagesTotal: documents.reduce((sum, document) => sum + document.pageCount, 0),
    pagesProcessed: 0,
    spentCents: 0,
    pipeline: normalizePipelineFeatures({
      embedding: { profile: "good-fast-local" },
      markdownExtraction: true,
      embed: true,
      maxCostCents: null,
    }),
    error: null,
    stats: {},
    artifacts: {},
    claimId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return WorkflowState.create(run, documents);
}

function resources(args: {
  cpuCount?: number;
  rssMb: number;
  totalMemoryMb: number;
}): ResourceSnapshot {
  return {
    cpuCount: args.cpuCount ?? 4,
    rssBytes: args.rssMb * 1024 * 1024,
    totalMemoryBytes: args.totalMemoryMb * 1024 * 1024,
  };
}

function memoryReader(args: {
  files?: Record<string, string>;
  osMb?: number;
  flyMachineMemoryMb?: string;
}) {
  return {
    read: (path: string) => args.files?.[path],
    osTotalMemoryBytes: (args.osMb ?? 8192) * 1024 * 1024,
    flyMachineMemoryMb: args.flyMachineMemoryMb,
  };
}

describe("memory limit detection", () => {
  it("prefers explicit Fly machine memory when provided", () => {
    expect(
      detectMemoryLimitBytes(memoryReader({ flyMachineMemoryMb: "3072", osMb: 8192 })),
    ).toBe(3072 * 1024 * 1024);
  });

  it("uses cgroup v2 memory limits before host memory", () => {
    expect(
      detectMemoryLimitBytes(memoryReader({
        files: { "/sys/fs/cgroup/memory.max": String(2048 * 1024 * 1024) },
        osMb: 8192,
      })),
    ).toBe(2048 * 1024 * 1024);
  });

  it("falls back to cgroup v1 memory limits", () => {
    expect(
      detectMemoryLimitBytes(memoryReader({
        files: {
          "/sys/fs/cgroup/memory.max": "max",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(1536 * 1024 * 1024),
        },
        osMb: 8192,
      })),
    ).toBe(1536 * 1024 * 1024);
  });

  it("ignores unlimited cgroup sentinel values and falls back to host memory", () => {
    expect(
      detectMemoryLimitBytes(memoryReader({
        files: {
          "/sys/fs/cgroup/memory.max": "max",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        },
        osMb: 8192,
      })),
    ).toBe(8192 * 1024 * 1024);
  });
});

describe("adaptive stage tuning", () => {
  it("backs heavy document concurrency down when memory headroom is tight", () => {
    const state = makeState([makeDocument("doc-1", 10), makeDocument("doc-2", 12)]);

    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig({ workerDocConcurrency: 4 }),
      state,
      stageName: "extract-markdown",
      resources: resources({ rssMb: 3500, totalMemoryMb: 4096 }),
    });

    expect(tuning.docConcurrency).toBe(1);
    expect(tuning.resource.memoryHeadroomMb).toBe(596);
    expect(tuning.reasons.join(" ")).toContain("memory headroom");
  });

  it("caps heavy stages for very large average document page counts", () => {
    const state = makeState([makeDocument("doc-1", 120), makeDocument("doc-2", 95)]);

    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig({ workerDocConcurrency: 4 }),
      state,
      stageName: "extract-markdown",
      resources: resources({ rssMb: 512, totalMemoryMb: 8192 }),
    });

    expect(tuning.docConcurrency).toBe(1);
  });

  it("uses prior stage speed to recommend larger batch and slice sizes when resources are open", () => {
    const state = makeState([makeDocument("doc-1", 10), makeDocument("doc-2", 10)]);
    state.setRunStage({
      runId: "run-1",
      stageName: "format-detect",
      status: "completed",
      attempts: 1,
      artifactUri: "",
      stats: { durationMs: 3_000 },
      error: "",
      startedAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });

    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig(),
      state,
      stageName: "embed",
      resources: resources({ rssMb: 512, totalMemoryMb: 8192 }),
    });

    expect(tuning.speed.sourceStage).toBe("format-detect");
    expect(tuning.speed.observedPagesPerMinute).toBe(400);
    expect(tuning.recommendedEmbeddingBatchSize).toBe(16);
    expect(tuning.recommendedUnstructuredChunkPages).toBe(2);
  });

  it("uses historical stage speed before the current run has completed stages", () => {
    const state = makeState([makeDocument("doc-1", 10), makeDocument("doc-2", 10)]);
    state.run.stats.historicalStagePerformance = {
      scope: "workspace",
      lookbackDays: 14,
      stages: {
        embed: {
          samples: 5,
          p50Ms: 80_000,
          p95Ms: 120_000,
          p50MsPerPage: 4_000,
        },
      },
    };

    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig(),
      state,
      stageName: "embed",
      resources: resources({ rssMb: 512, totalMemoryMb: 8192 }),
    });

    expect(tuning.speed.sourceStage).toBe("historical:embed");
    expect(tuning.speed.observedPagesPerMinute).toBe(15);
    expect(tuning.recommendedEmbeddingBatchSize).toBe(32);
  });

  it("uses historical fast slice speed to seed larger unstructured page slices", () => {
    const state = makeState([makeDocument("doc-1", 12)]);
    state.run.stats.historicalStagePerformance = {
      scope: "workspace",
      lookbackDays: 14,
      stages: {
        "extract-markdown": {
          samples: 4,
          p50Ms: 18_000,
          p95Ms: 30_000,
          p50MsPerPage: 1_500,
        },
      },
    };

    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig({
        unstructuredParserInitialChunkPages: 1,
        unstructuredParserMaxChunkPages: 3,
      }),
      state,
      stageName: "extract-markdown",
      resources: resources({ rssMb: 512, totalMemoryMb: 8192 }),
    });

    expect(tuning.speed.sourceStage).toBe("historical:extract-markdown");
    expect(tuning.recommendedUnstructuredChunkPages).toBe(2);
  });

  it("persists the decision into run stats and updates state concurrency", () => {
    const state = makeState([makeDocument("doc-1", 8)]);
    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig({ workerDocConcurrency: 3 }),
      state,
      stageName: "embed",
      resources: resources({ rssMb: 512, totalMemoryMb: 4096 }),
    });

    applyAdaptiveStageTuning(state, tuning);

    expect(state.docConcurrency).toBe(tuning.docConcurrency);
    const adaptiveTuning = state.run.stats.adaptiveTuning as {
      current: { stageName: string; docConcurrency: number };
      stages: Record<string, { docConcurrency: number }>;
    };
    expect(adaptiveTuning.current.stageName).toBe("embed");
    expect(adaptiveTuning.stages.embed.docConcurrency).toBe(tuning.docConcurrency);
  });

  it("turns tuning decisions into queryable performance events", () => {
    const state = makeState([makeDocument("doc-1", 8)]);
    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig({ workerDocConcurrency: 3 }),
      state,
      stageName: "embed",
      resources: resources({ rssMb: 512, totalMemoryMb: 4096 }),
    });

    const events = adaptiveTuningPerformanceEvents(tuning);

    expect(events.map((event) => event.metric)).toEqual([
      "adaptive-doc-concurrency",
      "adaptive-embedding-batch-size",
      "adaptive-unstructured-chunk-pages",
      "adaptive-unstructured-concurrency",
      "adaptive-memory-headroom",
    ]);
    expect(events[0]).toMatchObject({
      scope: "run",
      stageName: "embed",
      value: tuning.docConcurrency,
      unit: "document",
      tags: ["run", "stage", "adaptive", "concurrency"],
    });
    expect(events[0]?.metadata).toMatchObject({
      maxDocConcurrency: tuning.maxDocConcurrency,
      memoryHeadroomMb: tuning.resource.memoryHeadroomMb,
    });
  });

  it("reads persisted embedding batch recommendations for stage execution", () => {
    const state = makeState([makeDocument("doc-1", 8)]);
    const tuning = resolveAdaptiveStageTuning({
      config: baseConfig(),
      state,
      stageName: "embed",
      resources: resources({ rssMb: 3900, totalMemoryMb: 4096 }),
    });
    applyAdaptiveStageTuning(state, tuning);

    expect(adaptiveEmbeddingBatchSizeForStage(state, "embed", 24)).toBe(8);
    expect(adaptiveEmbeddingBatchSizeForStage(state, "extract-markdown", 24)).toBe(24);
  });

  it("reads persisted unstructured slice recommendations for markdown extraction", () => {
    const state = makeState([makeDocument("doc-1", 20)]);
    state.run.stats.adaptiveTuning = {
      stages: {
        "extract-markdown": {
          enabled: true,
          stageName: "extract-markdown",
          recommendedUnstructuredChunkPages: 3,
          recommendedUnstructuredConcurrency: 2,
        },
      },
    };

    expect(
      adaptiveUnstructuredSettingsForStage(state, "extract-markdown", {
        initialChunkPages: 1,
        maxChunkPages: 2,
        maxConcurrency: 3,
      }),
    ).toEqual({
      initialChunkPages: 3,
      maxChunkPages: 3,
      maxConcurrency: 2,
    });
  });

  it("ignores persisted recommendations when tuning was disabled", () => {
    const state = makeState([makeDocument("doc-1", 20)]);
    state.run.stats.adaptiveTuning = {
      current: {
        enabled: false,
        stageName: "embed",
        recommendedEmbeddingBatchSize: 128,
      },
    };

    expect(adaptiveEmbeddingBatchSizeForStage(state, "embed", 16)).toBe(16);
  });
});
