import {
  embeddingProfileCatalog,
  resolveEmbeddingRoute,
  type EmbeddingProfileKey,
  type InferenceLane,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { EmbeddingProfile } from "../models.js";

const supportedVectorBackends = new Set(["lancedb", "orama", "chroma", "milvus"]);

export function detectLanguage(text: string): string {
  const sample = text.slice(0, 2000);
  if (!sample) return "en";
  const nonAsciiRatio = (sample.match(/[^\x00-\x7F]/g) ?? []).length / sample.length;
  if (nonAsciiRatio > 0.15) {
    return "mul";
  }
  return "en";
}

export function resolveEmbeddingModel(cfg: Config, pipeline: PipelineFeatures, detectedLanguage?: string): EmbeddingProfile {
  const pipelineProfileKey = pipeline.embedding.profile;
  const pipelineProfileDefaults = embeddingProfileCatalog[pipelineProfileKey].config;

  const pipelineModelOverride = differsFromProfileDefault(pipeline.embedding.modelUri, pipelineProfileDefaults.modelUri)
    ? pipeline.embedding.modelUri
    : undefined;
  const effectiveProfileKey = shouldUseMultilingualProfile(
    detectedLanguage,
    pipelineProfileKey,
    pipelineModelOverride,
    undefined
  )
    ? "multilingual-local"
    : pipelineProfileKey;
  const effectiveProfileDefaults = embeddingProfileCatalog[effectiveProfileKey].config;

  const modelUri = firstNonEmpty(
    pipelineModelOverride,
    effectiveProfileDefaults.modelUri,
    "llm://openai/text-embedding-3-small",
  );
  const target = pipelineModelOverride
    ? pipeline.embedding.target
    : effectiveProfileDefaults.target;
  const sharedRoute = resolveEmbeddingRoute({
    ...pipeline.embedding,
    modelUri,
    target,
  });

  const lane = pipeline.inferenceLane ?? cfg.defaultInferenceLane;
  const laneBatchSize = defaultBatchSizeForLane(
    lane,
    sharedRoute.batchSize,
  );

  return {
    profile: effectiveProfileKey,
    target,
    modelUri,
    runtime: sharedRoute.runtime as EmbeddingProfile["runtime"],
    provider: sharedRoute.provider,
    model: sharedRoute.model,
    baseUrl: sharedRoute.baseUrl,
    dimensions: sharedRoute.dimensions,
    requestedDimensions: sharedRoute.requestedDimensions,
    task: firstNonEmpty(
      differsFromProfileDefault(pipeline.embedding.task, pipelineProfileDefaults.task) ? pipeline.embedding.task : undefined,
      effectiveProfileDefaults.task
    ) as EmbeddingProfile["task"],
    normalize: differsFromProfileDefault(pipeline.embedding.normalize, pipelineProfileDefaults.normalize)
      ? pipeline.embedding.normalize
      : effectiveProfileDefaults.normalize,
    batchSize: laneBatchSize,
    lateChunking: pipeline.embedding.lateChunking,
    lateChunkingWindow: pipeline.embedding.lateChunkingWindow,
    supportsCustomDimensions: sharedRoute.supportsCustomDimensions
  };
}

export function resolveVectorBackends(cfg: Config, pipeline: PipelineFeatures): string[] {
  const raw = pipeline.vectorBackends.length > 0 ? pipeline.vectorBackends : cfg.vectorBackends;
  const seen = new Set<string>();
  const backends = raw
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => supportedVectorBackends.has(item))
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });

  return backends.length > 0 ? backends : ["lancedb"];
}

export function backendRuntime(backend: string): string {
  switch (backend) {
    case "lancedb":
      return "object-layout";
    case "orama":
    case "chroma":
    case "milvus":
      return "service";
    default:
      return "custom";
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim()) {
      return value;
    }
  }
  return "";
}

function differsFromProfileDefault<T>(value: T, defaultValue: T): boolean {
  return value !== defaultValue;
}

function shouldUseMultilingualProfile(
  detectedLanguage: string | undefined,
  profileKey: EmbeddingProfileKey,
  pipelineModelOverride: string | undefined,
  configModelOverride: string | undefined
): boolean {
  return detectedLanguage === "mul"
    && !pipelineModelOverride
    && !configModelOverride
    && (profileKey === "good-fast-local" || profileKey === "cheapest-hosted");
}

function defaultBatchSizeForLane(lane: InferenceLane, profileBatchSize: number): number {
  switch (lane) {
    case "realtime":
      return Math.min(profileBatchSize, 8);
    case "backfill":
      return Math.max(profileBatchSize, 64);
    case "standard":
    default:
      return profileBatchSize;
  }
}
