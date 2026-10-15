import { readFileSync } from "node:fs";
import os from "node:os";

import { resolveEmbeddingRoute } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { JsonMap, PerformanceEvent, StageState } from "../models.js";
import type { WorkflowState } from "./pipeline.js";

export interface ResourceSnapshot {
  cpuCount: number;
  rssBytes: number;
  totalMemoryBytes: number;
}

export interface MemoryLimitReader {
  read(path: string): string | undefined;
  osTotalMemoryBytes: number;
  flyMachineMemoryMb?: string;
}

export interface AdaptiveStageTuning {
  enabled: boolean;
  stageName: string;
  docConcurrency: number;
  maxDocConcurrency: number;
  recommendedEmbeddingBatchSize: number;
  recommendedUnstructuredChunkPages: number;
  recommendedUnstructuredConcurrency: number;
  resource: {
    cpuCount: number;
    rssMb: number;
    totalMemoryMb: number;
    memoryHeadroomMb: number;
    memoryHeadroomRatio: number;
  };
  speed: {
    observedPagesPerMinute: number | null;
    observedMsPerPage: number | null;
    sourceStage: string | null;
  };
  reasons: string[];
}

const HEAVY_STAGE_NAMES = new Set([
  "extract-markdown",
  "render-images",
  "vision-extract",
  "structured-extract",
]);

const CPU_HEAVY_STAGE_NAMES = new Set([
  "format-detect",
  "format-tooling",
  "pdf-tooling",
  "extract-markdown",
  "render-images",
  "normalize",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function positiveRecommendation(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Math.max(1, Math.floor(fallback));
}

function parseMemoryBytes(
  raw: string | undefined,
  unit: "bytes" | "mb",
): number | null {
  const value = raw?.trim();
  if (!value || value === "max" || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9_000_000_000_000_000) {
    return null;
  }

  return unit === "mb" ? parsed * 1024 * 1024 : parsed;
}

export function captureResourceSnapshot(): ResourceSnapshot {
  return {
    cpuCount:
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length,
    rssBytes: process.memoryUsage().rss,
    totalMemoryBytes: detectMemoryLimitBytes(),
  };
}

export function detectMemoryLimitBytes(reader?: MemoryLimitReader): number {
  const source = reader ?? {
    read: (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    osTotalMemoryBytes: os.totalmem(),
    flyMachineMemoryMb: process.env.FLY_MACHINE_MEMORY_MB,
  };
  const flyMemoryBytes = parseMemoryBytes(source.flyMachineMemoryMb, "mb");
  if (flyMemoryBytes) {
    return flyMemoryBytes;
  }

  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    const memoryBytes = parseMemoryBytes(source.read(path), "bytes");
    if (memoryBytes) {
      return Math.min(memoryBytes, source.osTotalMemoryBytes);
    }
  }

  return source.osTotalMemoryBytes;
}

export function resolveAdaptiveStageTuning(args: {
  config: Config;
  state: WorkflowState;
  stageName: string;
  resources?: ResourceSnapshot;
}): AdaptiveStageTuning {
  const { config, state, stageName } = args;
  const resources = args.resources ?? captureResourceSnapshot();
  const maxDocConcurrency = Math.max(1, config.workerDocConcurrency);
  const cpuCount = positiveInt(resources.cpuCount, 1);
  const totalMemoryBytes = Math.max(1, resources.totalMemoryBytes);
  const rssBytes = Math.max(0, resources.rssBytes);
  const memoryHeadroomBytes = Math.max(0, totalMemoryBytes - rssBytes);
  const memoryHeadroomRatio = memoryHeadroomBytes / totalMemoryBytes;
  const totalPages = Math.max(
    1,
    state.documents.reduce((sum, document) => sum + Math.max(1, document.pageCount), 0),
  );
  const avgPagesPerDocument = totalPages / Math.max(1, state.documents.length);
  const speed = observedSpeed(state, stageName);
  const embeddingRoute = resolveEmbeddingRoute(state.run.pipeline.embedding);
  const reasons: string[] = [];

  let docConcurrency = maxDocConcurrency;

  if (!config.workerAdaptiveTuning) {
    reasons.push("adaptive tuning disabled");
    return buildTuning({
      config,
      stageName,
      docConcurrency,
      maxDocConcurrency,
      resources,
      memoryHeadroomBytes,
      memoryHeadroomRatio,
      speed,
      reasons,
      embeddingBatchSize: embeddingRoute.batchSize,
    });
  }

  const stageMemoryMb = estimatedMemoryMbPerDocument(
    stageName,
    config,
    embeddingRoute.runtime,
  );
  const memoryLimited = clamp(
    Math.floor(memoryHeadroomBytes / 1024 / 1024 / stageMemoryMb),
    1,
    maxDocConcurrency,
  );
  if (memoryLimited < docConcurrency) {
    reasons.push(`memory headroom limits concurrency to ${memoryLimited}`);
  }
  docConcurrency = Math.min(docConcurrency, memoryLimited);

  if (CPU_HEAVY_STAGE_NAMES.has(stageName)) {
    const cpuLimited = clamp(cpuCount, 1, maxDocConcurrency);
    if (cpuLimited < docConcurrency) {
      reasons.push(`cpu count limits concurrency to ${cpuLimited}`);
    }
    docConcurrency = Math.min(docConcurrency, cpuLimited);
  }

  if (HEAVY_STAGE_NAMES.has(stageName) && avgPagesPerDocument >= 80) {
    docConcurrency = Math.min(docConcurrency, 1);
    reasons.push("large documents use single-document heavy stage execution");
  } else if (HEAVY_STAGE_NAMES.has(stageName) && avgPagesPerDocument >= 30) {
    docConcurrency = Math.min(docConcurrency, 2);
    reasons.push("medium-large documents cap heavy stage concurrency at 2");
  }

  if (
    speed.observedPagesPerMinute !== null &&
    speed.observedPagesPerMinute < 12 &&
    memoryHeadroomRatio > 0.45 &&
    !HEAVY_STAGE_NAMES.has(stageName)
  ) {
    const boosted = Math.min(maxDocConcurrency, docConcurrency + 1);
    if (boosted > docConcurrency) {
      reasons.push("slow prior stage with memory headroom nudges concurrency up");
      docConcurrency = boosted;
    }
  }

  if (memoryHeadroomRatio < 0.2 && docConcurrency > 1) {
    docConcurrency = Math.max(1, docConcurrency - 1);
    reasons.push("low memory headroom backs off one concurrency slot");
  }

  if (reasons.length === 0) {
    reasons.push("using configured concurrency within resource limits");
  }

  return buildTuning({
    config,
    stageName,
    docConcurrency,
    maxDocConcurrency,
    resources,
    memoryHeadroomBytes,
    memoryHeadroomRatio,
    speed,
    reasons,
    embeddingBatchSize: embeddingRoute.batchSize,
  });
}

export function applyAdaptiveStageTuning(
  state: WorkflowState,
  tuning: AdaptiveStageTuning,
): void {
  state.docConcurrency = tuning.docConcurrency;
  const stats = state.run.stats as JsonMap;
  const previous = typeof stats.adaptiveTuning === "object" && stats.adaptiveTuning !== null
    ? (stats.adaptiveTuning as JsonMap)
    : {};
  const stages = typeof previous.stages === "object" && previous.stages !== null
    ? { ...(previous.stages as JsonMap) }
    : {};

  stages[tuning.stageName] = toJson(tuning);
  stats.adaptiveTuning = {
    ...previous,
    current: toJson(tuning),
    stages,
  };
}

export function adaptiveTuningPerformanceEvents(
  tuning: AdaptiveStageTuning,
): PerformanceEvent[] {
  const metadata: JsonMap = {
    maxDocConcurrency: tuning.maxDocConcurrency,
    reasons: tuning.reasons,
    speedSource: tuning.speed.sourceStage,
    observedPagesPerMinute: tuning.speed.observedPagesPerMinute,
    observedMsPerPage: tuning.speed.observedMsPerPage,
    cpuCount: tuning.resource.cpuCount,
    rssMb: tuning.resource.rssMb,
    totalMemoryMb: tuning.resource.totalMemoryMb,
    memoryHeadroomMb: tuning.resource.memoryHeadroomMb,
    memoryHeadroomRatio: tuning.resource.memoryHeadroomRatio,
  };

  return [
    {
      scope: "run",
      stageName: tuning.stageName,
      metric: "adaptive-doc-concurrency",
      value: tuning.docConcurrency,
      unit: "document",
      tags: ["run", "stage", "adaptive", "concurrency"],
      metadata,
    },
    {
      scope: "run",
      stageName: tuning.stageName,
      metric: "adaptive-embedding-batch-size",
      value: tuning.recommendedEmbeddingBatchSize,
      unit: "chunk",
      tags: ["run", "stage", "adaptive", "batch"],
      metadata,
    },
    {
      scope: "run",
      stageName: tuning.stageName,
      metric: "adaptive-unstructured-chunk-pages",
      value: tuning.recommendedUnstructuredChunkPages,
      unit: "page",
      tags: ["run", "stage", "adaptive", "slice"],
      metadata,
    },
    {
      scope: "run",
      stageName: tuning.stageName,
      metric: "adaptive-unstructured-concurrency",
      value: tuning.recommendedUnstructuredConcurrency,
      unit: "slice",
      tags: ["run", "stage", "adaptive", "concurrency"],
      metadata,
    },
    {
      scope: "run",
      stageName: tuning.stageName,
      metric: "adaptive-memory-headroom",
      value: tuning.resource.memoryHeadroomMb * 1024 * 1024,
      unit: "byte",
      tags: ["run", "stage", "adaptive", "memory", "rss"],
      metadata,
    },
  ];
}

export function adaptiveEmbeddingBatchSizeForStage(
  state: WorkflowState,
  stageName: string,
  fallback: number,
): number {
  const tuning = readPersistedStageTuning(state, stageName);
  if (!tuning || tuning.enabled === false) {
    return Math.max(1, Math.floor(fallback));
  }

  return positiveRecommendation(
    tuning.recommendedEmbeddingBatchSize,
    fallback,
  );
}

export function adaptiveUnstructuredSettingsForStage(
  state: WorkflowState,
  stageName: string,
  fallback: {
    initialChunkPages: number;
    maxChunkPages: number;
    maxConcurrency: number;
  },
): {
  initialChunkPages: number;
  maxChunkPages: number;
  maxConcurrency: number;
} {
  const tuning = readPersistedStageTuning(state, stageName);
  if (!tuning || tuning.enabled === false) {
    return fallback;
  }

  const initialChunkPages = positiveRecommendation(
    tuning.recommendedUnstructuredChunkPages,
    fallback.initialChunkPages,
  );

  return {
    initialChunkPages,
    maxChunkPages: Math.max(initialChunkPages, fallback.maxChunkPages),
    maxConcurrency: positiveRecommendation(
      tuning.recommendedUnstructuredConcurrency,
      fallback.maxConcurrency,
    ),
  };
}

function buildTuning(args: {
  config: Config;
  stageName: string;
  docConcurrency: number;
  maxDocConcurrency: number;
  resources: ResourceSnapshot;
  memoryHeadroomBytes: number;
  memoryHeadroomRatio: number;
  speed: AdaptiveStageTuning["speed"];
  reasons: string[];
  embeddingBatchSize: number;
}): AdaptiveStageTuning {
  const { config, stageName, resources } = args;
  const memoryHeadroomMb = Math.round(args.memoryHeadroomBytes / 1024 / 1024);
  const memoryHeadroomRatio = Number(args.memoryHeadroomRatio.toFixed(3));
  const recommendedEmbeddingBatchSize = tuneEmbeddingBatchSize(
    args.embeddingBatchSize,
    memoryHeadroomRatio,
    args.speed.observedPagesPerMinute,
  );
  const recommendedUnstructuredChunkPages = tuneUnstructuredChunkPages(
    config.unstructuredParserInitialChunkPages,
    config.unstructuredParserMaxChunkPages,
    memoryHeadroomRatio,
    args.speed.observedMsPerPage,
  );

  return {
    enabled: config.workerAdaptiveTuning,
    stageName,
    docConcurrency: clamp(args.docConcurrency, 1, args.maxDocConcurrency),
    maxDocConcurrency: args.maxDocConcurrency,
    recommendedEmbeddingBatchSize,
    recommendedUnstructuredChunkPages,
    recommendedUnstructuredConcurrency: clamp(
      Math.min(config.unstructuredParserMaxConcurrency, args.docConcurrency),
      1,
      Math.max(1, config.unstructuredParserMaxConcurrency),
    ),
    resource: {
      cpuCount: positiveInt(resources.cpuCount, 1),
      rssMb: Math.round(resources.rssBytes / 1024 / 1024),
      totalMemoryMb: Math.round(resources.totalMemoryBytes / 1024 / 1024),
      memoryHeadroomMb,
      memoryHeadroomRatio,
    },
    speed: args.speed,
    reasons: args.reasons,
  };
}

function estimatedMemoryMbPerDocument(
  stageName: string,
  config: Config,
  embeddingRuntime: "local" | "remote",
): number {
  if (stageName === "vision-extract") return 900;
  if (stageName === "extract-markdown") return config.serializePdfCandidateExtraction ? 650 : 900;
  if (stageName === "render-images") return 500;
  if (stageName === "embed") return embeddingRuntime === "local" ? 700 : 260;
  if (stageName === "index-vectors") return 350;
  if (stageName === "structured-extract") return 450;
  return 160;
}

function observedSpeed(
  state: WorkflowState,
  stageName: string,
): AdaptiveStageTuning["speed"] {
  const completed = Array.from(state.runStages.values())
    .filter((stage): stage is StageState => stage.status === "completed")
    .reverse();
  const pages = Math.max(1, state.run.pagesTotal || state.documents.reduce(
    (sum, document) => sum + Math.max(1, document.pageCount),
    0,
  ));

  for (const stage of completed) {
    const durationMs = typeof stage.stats.durationMs === "number" ? stage.stats.durationMs : null;
    if (!durationMs || durationMs <= 0) {
      continue;
    }
    const observedPagesPerMinute = pages / (durationMs / 60_000);
    return {
      observedPagesPerMinute: Number(observedPagesPerMinute.toFixed(2)),
      observedMsPerPage: Number((durationMs / pages).toFixed(2)),
      sourceStage: stage.stageName,
    };
  }

  const historical = historicalSpeedForStage(state, stageName, pages);
  if (historical) {
    return historical;
  }

  return {
    observedPagesPerMinute: null,
    observedMsPerPage: null,
    sourceStage: null,
  };
}

function historicalSpeedForStage(
  state: WorkflowState,
  stageName: string,
  pages: number,
): AdaptiveStageTuning["speed"] | null {
  const stats = objectValue(state.run.stats);
  const performance = objectValue(stats?.historicalStagePerformance);
  const stages = objectValue(performance?.stages);
  const stage = objectValue(stages?.[stageName]);
  const msPerPage =
    typeof stage?.p50MsPerPage === "number" && stage.p50MsPerPage > 0
      ? stage.p50MsPerPage
      : typeof stage?.p50Ms === "number" && stage.p50Ms > 0
        ? stage.p50Ms / Math.max(1, pages)
        : null;

  if (!msPerPage || msPerPage <= 0) {
    return null;
  }

  return {
    observedPagesPerMinute: Number((60_000 / msPerPage).toFixed(2)),
    observedMsPerPage: Number(msPerPage.toFixed(2)),
    sourceStage: `historical:${stageName}`,
  };
}

function tuneEmbeddingBatchSize(
  configured: number,
  memoryHeadroomRatio: number,
  pagesPerMinute: number | null,
): number {
  const base = Math.max(1, configured);
  if (memoryHeadroomRatio < 0.2) return Math.max(1, Math.floor(base / 2));
  if (memoryHeadroomRatio > 0.55 && pagesPerMinute !== null && pagesPerMinute < 20) {
    return Math.min(256, base * 2);
  }
  return base;
}

function tuneUnstructuredChunkPages(
  initialChunkPages: number,
  maxChunkPages: number,
  memoryHeadroomRatio: number,
  msPerPage: number | null,
): number {
  const initial = Math.max(1, initialChunkPages);
  const max = Math.max(initial, maxChunkPages);
  if (memoryHeadroomRatio < 0.25) return initial;
  if (msPerPage !== null && msPerPage < 2_000 && memoryHeadroomRatio > 0.45) {
    return Math.min(max, initial + 1);
  }
  return initial;
}

function toJson(tuning: AdaptiveStageTuning): JsonMap {
  return {
    enabled: tuning.enabled,
    stageName: tuning.stageName,
    docConcurrency: tuning.docConcurrency,
    maxDocConcurrency: tuning.maxDocConcurrency,
    recommendedEmbeddingBatchSize: tuning.recommendedEmbeddingBatchSize,
    recommendedUnstructuredChunkPages: tuning.recommendedUnstructuredChunkPages,
    recommendedUnstructuredConcurrency: tuning.recommendedUnstructuredConcurrency,
    resource: tuning.resource,
    speed: tuning.speed,
    reasons: tuning.reasons,
  };
}

function readPersistedStageTuning(
  state: WorkflowState,
  stageName: string,
): Partial<AdaptiveStageTuning> | null {
  const stats = objectValue(state.run.stats) ?? {};
  const adaptiveTuning = objectValue(stats.adaptiveTuning);
  const stages = objectValue(adaptiveTuning?.stages);
  const stageTuning = objectValue(stages?.[stageName]);
  if (stageTuning) {
    return stageTuning as Partial<AdaptiveStageTuning>;
  }

  const current = objectValue(adaptiveTuning?.current);
  return current?.stageName === stageName
    ? (current as Partial<AdaptiveStageTuning>)
    : null;
}

function objectValue(value: unknown): JsonMap | null {
  return typeof value === "object" && value !== null
    ? (value as JsonMap)
    : null;
}
