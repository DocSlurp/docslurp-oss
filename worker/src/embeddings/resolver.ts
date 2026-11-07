import {
  assertSupportedVectorBackends,
  embeddingProfileCatalog,
  resolveEmbeddingRoute,
  type InferenceLane,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { EmbeddingProfile } from "../models.js";


/**
 * Dominant script of a text sample: `latin`, `cjk`, `cyrillic`, `arabic`, ... or
 * `und` when there are too few letters to tell. It is metadata (and may pick a
 * tokenizer); it never selects an embedding model, because one index config
 * means one vector space.
 */
export function detectScript(text: string): string {
  const counts = new Map<string, number>();
  let letters = 0;
  for (const char of text.slice(0, 4000)) {
    if (!/\p{L}/u.test(char)) continue;
    letters++;
    const script = SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "other";
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (letters < 8) return "und";
  let best = "und";
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Coarse language code implied by the dominant script, for metadata. Scripts
 * shared by many languages (Latin, Cyrillic, Arabic, Devanagari) stay `und-<Script>`
 * rather than guessing a language from a letter ratio.
 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000);
  switch (detectScript(sample)) {
    case "cjk": return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sample) ? "ja" : "zh";
    case "hangul": return "ko";
    case "greek": return "el";
    case "hebrew": return "he";
    case "thai": return "th";
    case "latin": return "und-Latn";
    case "cyrillic": return "und-Cyrl";
    case "arabic": return "und-Arab";
    case "devanagari": return "und-Deva";
    default: return "und";
  }
}

const SCRIPTS: Array<[string, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
];

/**
 * The embedding route of a run. It depends on the pipeline config alone: every
 * document of an index config is embedded with the same model, so every vector
 * has the dimension the config records and the server can search them together.
 */
export function resolveEmbeddingModel(cfg: Config, pipeline: PipelineFeatures): EmbeddingProfile {
  const profileKey = pipeline.embedding.profile;
  const profileDefaults = embeddingProfileCatalog[profileKey].config;

  const modelOverride = differsFromProfileDefault(pipeline.embedding.modelUri, profileDefaults.modelUri)
    ? pipeline.embedding.modelUri
    : undefined;

  const modelUri = firstNonEmpty(
    modelOverride,
    profileDefaults.modelUri,
    "llm://openrouter/perplexity/pplx-embed-v1-0.6b",
  );
  const target = modelOverride
    ? pipeline.embedding.target
    : profileDefaults.target;
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
    profile: profileKey,
    target,
    modelUri,
    runtime: sharedRoute.runtime as EmbeddingProfile["runtime"],
    provider: sharedRoute.provider,
    model: sharedRoute.model,
    baseUrl: sharedRoute.baseUrl,
    dimensions: sharedRoute.dimensions,
    requestedDimensions: sharedRoute.requestedDimensions,
    task: firstNonEmpty(
      differsFromProfileDefault(pipeline.embedding.task, profileDefaults.task) ? pipeline.embedding.task : undefined,
      profileDefaults.task
    ) as EmbeddingProfile["task"],
    normalize: differsFromProfileDefault(pipeline.embedding.normalize, profileDefaults.normalize)
      ? pipeline.embedding.normalize
      : profileDefaults.normalize,
    batchSize: laneBatchSize,
    lateChunking: pipeline.embedding.lateChunking,
    lateChunkingWindow: pipeline.embedding.lateChunkingWindow,
    supportsCustomDimensions: sharedRoute.supportsCustomDimensions
  };
}

/**
 * The run's vector backends: the pipeline's, else VECTOR_BACKENDS, else lancedb. A backend this build does not write (Chroma,
 * removed, or any unknown name) is refused (UnsupportedVectorBackendError), never filtered out or replaced by another.
 */
export function resolveVectorBackends(cfg: Config, pipeline: PipelineFeatures): string[] {
  const fromPipeline = pipeline.vectorBackends.length > 0;
  const backends = assertSupportedVectorBackends(fromPipeline ? pipeline.vectorBackends : cfg.vectorBackends, fromPipeline ? "pipeline.vectorBackends" : "VECTOR_BACKENDS");
  return backends.length > 0 ? backends : ["lancedb"];
}

export function backendRuntime(backend: string): string {
  switch (backend) {
    case "lancedb":
      return "object-layout";
    case "orama":
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
