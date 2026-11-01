import { z } from "zod";
import { lookupPrivateModelRoute, parsePrivateModelUri, PRIVATE_MODEL_PROVIDER } from "./private-endpoints.js";

export const supportedEmbeddingModels = [
  "text-embedding-3-small",
  "BAAI/bge-m3",
  "perplexity/pplx-embed-v1-0.6b",
  "perplexity/pplx-embed-v1-4b",
  "onnx-community/embeddinggemma-300m-ONNX",
  "jinaai/jina-embeddings-v2-base-code",
  "Xenova/jina-embeddings-v2-base-en",
  "nomic-ai/nomic-embed-text-v1.5",
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  "Xenova/all-MiniLM-L6-v2",
  "Xenova/all-MiniLM-L12-v2",
  "Xenova/gte-small",
  "Xenova/e5-small-v2",
  "Xenova/e5-base-v2",
  "Xenova/multilingual-e5-small",
  "Xenova/multilingual-e5-base",
  "mixedbread-ai/mxbai-embed-large-v1",
  "Xenova/bge-base-en-v1.5",
  "Xenova/bge-small-en-v1.5",
  "Xenova/bge-large-en-v1.5",
  "Xenova/bge-m3",
  "Xenova/all-mpnet-base-v2",
] as const;

/**
 * `local`: runs in-process or on a loopback server. `private`: an
 * operator-registered single-tenant endpoint (`llm://private/<alias>/<model>`,
 * see private-endpoints.ts). `hosted`: any other remote provider.
 */
export const modelTargetSchema = z.enum(["hosted", "local", "private"]);
export type ModelTarget = z.infer<typeof modelTargetSchema>;
export const modelTargetOptions = modelTargetSchema.options;

export const llmModelUriSchema = z.string().trim().superRefine((value, ctx) => {
  if (!value.startsWith("llm://")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Model routes must use llm://provider/model connection strings",
    });
    return;
  }

  try {
    const parsed = new URL(value);
    if (!parsed.hostname || parsed.pathname === "/") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Model routes must include both a provider and model",
      });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Model routes must not contain credentials",
      });
    }
    if (parsed.hostname.toLowerCase() === PRIVATE_MODEL_PROVIDER) {
      if (parsed.search || parsed.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Private endpoint routes take no parameters; the operator registry supplies the URL and credentials",
        });
      } else if (!parsePrivateModelUri(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Private endpoint routes must be llm://private/<alias>/<model>",
        });
      }
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid llm:// model route",
    });
  }
});
export type LlmModelUri = z.infer<typeof llmModelUriSchema>;

export function parseLlmModelUri(uri: string): {
  provider: string;
  model: string;
  params: URLSearchParams;
} {
  const parsed = new URL(llmModelUriSchema.parse(uri));
  return {
    provider: parsed.hostname.toLowerCase(),
    model: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    params: parsed.searchParams,
  };
}

const localModelProviders = new Set([
  "transformers.js",
  "onnx",
  "huggingface",
  "ollama",
  "vllm",
  "lmstudio",
  "local-cli",
]);

/** True for runtimes that execute on the worker/app host or a loopback server. */
export function isLocalModelProvider(provider: string): boolean {
  return localModelProviders.has(provider.trim().toLowerCase());
}

export function inferModelTarget(uri: string): ModelTarget {
  const provider = parseLlmModelUri(uri).provider;
  if (provider === PRIVATE_MODEL_PROVIDER) return "private";
  return localModelProviders.has(provider) ? "local" : "hosted";
}

export const embeddingRuntimeSchema = z.enum(["remote", "local"]);
export type EmbeddingRuntime = z.infer<typeof embeddingRuntimeSchema>;
export const embeddingModelSchema = z.enum(supportedEmbeddingModels);
export type EmbeddingModel = z.infer<typeof embeddingModelSchema>;
export const embeddingTaskSchema = z.enum([
  "document",
  "query",
  "code",
  "multilingual",
]);
export type EmbeddingTask = z.infer<typeof embeddingTaskSchema>;

export const embeddingProviderSchema = z.enum([
  "openai",
  "deepinfra",
  "openrouter",
  "ollama",
  "vllm",
  "lmstudio",
  "onnx",
  "transformers.js",
  "jina",
  "mixedbread",
  "nomic",
  "huggingface",
]);
export type EmbeddingProvider = z.infer<typeof embeddingProviderSchema>;

export const vectorBackendSchema = z.enum([
  "lancedb",
  "orama",
  "chroma",
  "milvus",
]);
export type VectorBackend = z.infer<typeof vectorBackendSchema>;
export const inferenceLaneSchema = z.enum(["realtime", "standard", "backfill"]);
export type InferenceLane = z.infer<typeof inferenceLaneSchema>;
export const inferenceLaneOptions = inferenceLaneSchema.options;

export const embeddingProfileKeySchema = z.enum([
  "cheapest-local",
  "fastest-local",
  "good-fast-local",
  "multilingual-local",
  "code-local",
  "cheapest-hosted",
]);
export type EmbeddingProfileKey = z.infer<typeof embeddingProfileKeySchema>;
export const embeddingProfileOptions = embeddingProfileKeySchema.options;

type EmbeddingProfilePresetConfig = {
  profile: EmbeddingProfileKey;
  target: ModelTarget;
  modelUri: string;
  task: EmbeddingTask;
  normalize: boolean;
};

type EmbeddingProfilePreset = {
  label: string;
  description: string;
  tags: readonly string[];
  config: EmbeddingProfilePresetConfig;
};

export const embeddingProfileCatalog: Record<
  EmbeddingProfileKey,
  EmbeddingProfilePreset
> = {
  "cheapest-local": {
    label: "Cheapest local",
    description:
      "Small local Transformers.js model with no per-token API cost.",
    tags: ["cost", "local", "smallest"],
    config: {
      profile: "cheapest-local",
      target: "local",
      modelUri: "llm://transformers.js/Xenova/all-MiniLM-L6-v2",
      task: "document",
      normalize: true,
    },
  },
  "fastest-local": {
    label: "Fastest local",
    description:
      "Low-latency local English embeddings for interactive ingestion.",
    tags: ["speed", "local", "small"],
    config: {
      profile: "fastest-local",
      target: "local",
      modelUri: "llm://transformers.js/Xenova/gte-small",
      task: "document",
      normalize: true,
    },
  },
  "good-fast-local": {
    label: "Good + fast local",
    description:
      "Strong multilingual BGE-M3 retrieval with local execution and balanced throughput.",
    tags: ["quality", "speed", "local", "multilingual"],
    config: {
      profile: "good-fast-local",
      target: "local",
      modelUri: "llm://transformers.js/Xenova/bge-m3",
      task: "document",
      normalize: true,
    },
  },
  "multilingual-local": {
    label: "Multilingual local",
    description:
      "Compact cross-language retrieval for OCR-heavy and globally mixed corpora.",
    tags: ["multilingual", "local", "small"],
    config: {
      profile: "multilingual-local",
      target: "local",
      modelUri: "llm://transformers.js/Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      task: "multilingual",
      normalize: true,
    },
  },
  "code-local": {
    label: "Code search local",
    description:
      "Code-oriented local embeddings for engineering docs, APIs, and snippets.",
    tags: ["code", "quality", "local"],
    config: {
      profile: "code-local",
      target: "local",
      modelUri: "llm://huggingface/jinaai/jina-embeddings-v2-base-code",
      task: "code",
      normalize: true,
    },
  },
  "cheapest-hosted": {
    label: "Cheapest hosted",
    description:
      "Fast, low-cost Perplexity 0.6B embeddings through OpenRouter.",
    tags: ["cost", "hosted", "managed"],
    config: {
      profile: "cheapest-hosted",
      target: "hosted",
      modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b",
      task: "document",
      normalize: true,
    },
  },
};

export type EmbeddingModelRouteSpec = {
  label: string;
  tags: readonly string[];
  capabilities: readonly ["embedding"];
  target: ModelTarget;
  runtime: EmbeddingRuntime;
  provider: string;
  model: string;
  dimensions: number;
  batchSize: number;
  supportsCustomDimensions: boolean;
};

export const DEEPINFRA_EMBEDDING_BASE_URL = "https://api.deepinfra.com/v1/openai";

/** BGE-M3 is fixed-size, not Matryoshka; reject malformed output instead of cutting it. */
export function validateDeepInfraEmbedding(vector: number[], dimensions = 1024, normalize = true): number[] {
  if (dimensions !== 1024 || vector.length !== 1024 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("DeepInfra BGE-M3 requires exactly 1024 finite embedding values");
  }
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("DeepInfra BGE-M3 returned an invalid zero embedding");
  return normalize ? vector.map((value) => value / norm) : vector;
}

const embeddingModelEntries = [
  ["llm://perplexity/pplx-embed-v1-0.6b", "Perplexity Embed 0.6B (native API)", "hosted", "remote", "perplexity", "pplx-embed-v1-0.6b", 1024, 128, false, ["hosted", "open-weights", "cost"]],
  ["llm://perplexity/pplx-embed-v1-4b", "Perplexity Embed 4B (native API)", "hosted", "remote", "perplexity", "pplx-embed-v1-4b", 2560, 128, false, ["hosted", "open-weights", "quality"]],
  ["llm://openrouter/perplexity/pplx-embed-v1-0.6b", "Perplexity Embed 0.6B (OpenRouter)", "hosted", "remote", "openrouter", "perplexity/pplx-embed-v1-0.6b", 1024, 128, false, ["hosted", "open-weights", "cost"]],
  ["llm://openrouter/perplexity/pplx-embed-v1-4b", "Perplexity Embed 4B (OpenRouter)", "hosted", "remote", "openrouter", "perplexity/pplx-embed-v1-4b", 2560, 128, false, ["hosted", "open-weights", "quality"]],
  ["llm://deepinfra/BAAI/bge-m3", "DeepInfra BGE-M3", "hosted", "remote", "deepinfra", "BAAI/bge-m3", 1024, 64, false, ["hosted", "multilingual", "quality"]],
  ["llm://openai/text-embedding-3-small", "OpenAI text-embedding-3-small", "hosted", "remote", "openai", "text-embedding-3-small", 1536, 64, true, ["hosted", "managed", "cost"]],
  ["llm://onnx/onnx-community/embeddinggemma-300m-ONNX", "EmbeddingGemma 300M ONNX", "local", "local", "onnx", "onnx-community/embeddinggemma-300m-ONNX", 768, 16, false, ["local", "onnx", "small"]],
  ["llm://huggingface/jinaai/jina-embeddings-v2-base-code", "Jina v2 Code", "local", "local", "huggingface", "jinaai/jina-embeddings-v2-base-code", 768, 16, false, ["local", "code"]],
  ["llm://transformers.js/Xenova/jina-embeddings-v2-base-en", "Jina v2 English", "local", "local", "transformers.js", "Xenova/jina-embeddings-v2-base-en", 768, 16, false, ["local", "english"]],
  ["llm://huggingface/nomic-ai/nomic-embed-text-v1.5", "Nomic Embed Text v1.5", "local", "local", "huggingface", "nomic-ai/nomic-embed-text-v1.5", 768, 16, false, ["local", "quality"]],
  ["llm://transformers.js/Xenova/paraphrase-multilingual-MiniLM-L12-v2", "Multilingual MiniLM L12", "local", "local", "transformers.js", "Xenova/paraphrase-multilingual-MiniLM-L12-v2", 384, 24, false, ["local", "multilingual", "small"]],
  ["llm://transformers.js/Xenova/all-MiniLM-L6-v2", "MiniLM L6", "local", "local", "transformers.js", "Xenova/all-MiniLM-L6-v2", 384, 32, false, ["local", "small", "cost"]],
  ["llm://transformers.js/Xenova/all-MiniLM-L12-v2", "MiniLM L12", "local", "local", "transformers.js", "Xenova/all-MiniLM-L12-v2", 384, 24, false, ["local", "small"]],
  ["llm://transformers.js/Xenova/gte-small", "GTE Small", "local", "local", "transformers.js", "Xenova/gte-small", 384, 32, false, ["local", "small", "speed"]],
  ["llm://transformers.js/Xenova/e5-small-v2", "E5 Small v2", "local", "local", "transformers.js", "Xenova/e5-small-v2", 384, 32, false, ["local", "small"]],
  ["llm://transformers.js/Xenova/e5-base-v2", "E5 Base v2", "local", "local", "transformers.js", "Xenova/e5-base-v2", 768, 16, false, ["local"]],
  ["llm://transformers.js/Xenova/multilingual-e5-small", "Multilingual E5 Small", "local", "local", "transformers.js", "Xenova/multilingual-e5-small", 384, 24, false, ["local", "multilingual", "small"]],
  ["llm://transformers.js/Xenova/multilingual-e5-base", "Multilingual E5 Base", "local", "local", "transformers.js", "Xenova/multilingual-e5-base", 768, 16, false, ["local", "multilingual"]],
  ["llm://huggingface/mixedbread-ai/mxbai-embed-large-v1", "Mixedbread Embed Large", "local", "local", "huggingface", "mixedbread-ai/mxbai-embed-large-v1", 1024, 16, false, ["local", "quality"]],
  ["llm://transformers.js/Xenova/bge-base-en-v1.5", "BGE Base English", "local", "local", "transformers.js", "Xenova/bge-base-en-v1.5", 768, 16, false, ["local", "english"]],
  ["llm://transformers.js/Xenova/bge-small-en-v1.5", "BGE Small English", "local", "local", "transformers.js", "Xenova/bge-small-en-v1.5", 384, 32, false, ["local", "english", "small"]],
  ["llm://transformers.js/Xenova/bge-large-en-v1.5", "BGE Large English", "local", "local", "transformers.js", "Xenova/bge-large-en-v1.5", 1024, 16, false, ["local", "english", "quality"]],
  ["llm://transformers.js/Xenova/bge-m3", "BGE-M3", "local", "local", "transformers.js", "Xenova/bge-m3", 1024, 16, false, ["local", "multilingual", "quality"]],
  ["llm://transformers.js/Xenova/all-mpnet-base-v2", "MPNet Base v2", "local", "local", "transformers.js", "Xenova/all-mpnet-base-v2", 768, 16, false, ["local", "quality"]],
] as const;

/**
 * How token vectors become one embedding. `mean` averages them (the
 * historical default for every local model); `cls` takes the first token, which
 * is how BGE models (bge-m3, bge-*-en-v1.5) are trained and what hosted bge-m3
 * returns. Local routes choose with `?pooling=`; hosted routes return their
 * provider's pooling and accept only that value.
 */
export const embeddingPoolingSchema = z.enum(["mean", "cls"]);
export type EmbeddingPooling = z.infer<typeof embeddingPoolingSchema>;

/** Pooling hosted providers apply (they ignore any pooling option): DeepInfra serves bge-m3 CLS-pooled. */
const HOSTED_EMBEDDING_POOLING: Record<string, EmbeddingPooling> = {
  "llm://deepinfra/BAAI/bge-m3": "cls",
};

/** The catalog key of an embedding route: the URI without its query (`?pooling=cls`). */
export function embeddingModelBaseUri(modelUri: string): string {
  const query = modelUri.indexOf("?");
  return query === -1 ? modelUri : modelUri.slice(0, query);
}

/** Pooling a local route runs with: `?pooling=` when given, else mean (the vectors existing indexes hold). */
export function localEmbeddingPooling(modelUri: string): EmbeddingPooling {
  const query = modelUri.indexOf("?");
  const value = query === -1 ? null : new URLSearchParams(modelUri.slice(query + 1)).get("pooling");
  return value === "cls" ? "cls" : "mean";
}

/** Why a route's `?pooling=` cannot be honoured, or null. */
export function embeddingPoolingProblem(modelUri: string): string | null {
  const query = modelUri.indexOf("?");
  if (query === -1) return null;
  const value = new URLSearchParams(modelUri.slice(query + 1)).get("pooling");
  if (value === null) return null;
  if (!embeddingPoolingSchema.safeParse(value).success) return `Unknown pooling "${value}": use mean or cls`;
  const base = embeddingModelBaseUri(modelUri);
  const provider = base.slice("llm://".length).split("/")[0]?.toLowerCase() ?? "";
  if (provider === "transformers.js") return null;
  if (isLocalModelProvider(provider)) return `${base} pools on its server; remove ?pooling=`;
  const native = HOSTED_EMBEDDING_POOLING[base];
  if (!native) return `${base} returns its provider's pooling; remove ?pooling=`;
  if (native !== value) return `${base} is ${native}-pooled by the provider; ?pooling=${value} cannot be honoured`;
  return null;
}

export const embeddingModelCatalogByUri = Object.fromEntries(
  embeddingModelEntries.map(([
    uri,
    label,
    target,
    runtime,
    provider,
    model,
    dimensions,
    batchSize,
    supportsCustomDimensions,
    tags,
  ]) => [uri, {
    label,
    tags,
    capabilities: ["embedding"] as const,
    target,
    runtime,
    provider,
    model,
    dimensions,
    batchSize,
    supportsCustomDimensions,
  }]),
) as Record<string, EmbeddingModelRouteSpec>;

/** Providers whose embeddings may be reduced to explicit Matryoshka `dimensions`. */
const reducedDimensionLocalProviders = new Set(["vllm", "ollama", "lmstudio", "transformers.js"]);

export function supportsReducedEmbeddingDimensions(modelUri: string): boolean {
  const known = embeddingModelCatalogByUri[embeddingModelBaseUri(modelUri)];
  if (known) {
    return (known.provider === "openai" && known.supportsCustomDimensions) || known.runtime === "local";
  }
  return reducedDimensionLocalProviders.has(parseLlmModelUri(modelUri).provider);
}

/**
 * Cut an embedding to `dimensions` (Matryoshka-style) and, when the vector is
 * meant to be unit length, L2-renormalize the prefix so cosine/dot scores stay
 * comparable. Vectors already at or below the requested length are untouched.
 */
export function fitEmbeddingDimensions(
  vector: number[],
  dimensions: number | undefined,
  normalize: boolean | undefined,
): number[] {
  if (typeof dimensions !== "number" || dimensions <= 0 || vector.length <= dimensions) {
    return vector;
  }
  const sliced = vector.slice(0, dimensions);
  if (!normalize) return sliced;
  let sumSquares = 0;
  for (const value of sliced) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  return norm > 0 ? sliced.map((value) => value / norm) : sliced;
}

/** Hosted provider vectors must preserve the registered space; never pad or truncate them. */
export function validateHostedEmbeddingVector(vector: number[], dimensions: number, normalize = true): number[] {
  if (vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) {
    throw new Error("Hosted embedding returned invalid dimensions or values");
  }
  const norm = Math.hypot(...vector);
  if (!(norm > 0) || !Number.isFinite(norm)) throw new Error("Hosted embedding returned a zero or invalid vector");
  return normalize ? vector.map(value => value / norm) : vector;
}

export function openRouterEmbeddingRoute(model: string) {
  const route = embeddingModelCatalogByUri[`llm://openrouter/${model}`];
  if (!route || route.provider !== "openrouter") throw new Error("Unregistered OpenRouter embedding model");
  return route;
}

export function resolveEmbeddingRoute(config: EmbeddingConfig) {
  const parsed = parseLlmModelUri(config.modelUri);
  if (parsed.provider === PRIVATE_MODEL_PROVIDER) {
    // URL and dimensions come from the operator registry. An unregistered
    // route resolves with no URL; the embedding client then fails closed.
    const lookup = lookupPrivateModelRoute({ ref: config.modelUri, capability: "embedding" });
    return {
      label: parsed.model,
      tags: ["private", "custom"],
      capabilities: ["embedding"] as const,
      modelUri: config.modelUri,
      target: "private" as const,
      runtime: "remote" as const,
      provider: PRIVATE_MODEL_PROVIDER,
      model: parsed.model,
      dimensions: lookup.ok ? lookup.route.model.dimensions ?? 0 : 0,
      // Registry routes fix their own dimensions; nothing is requested per call.
      requestedDimensions: undefined as number | undefined,
      batchSize: 32,
      supportsCustomDimensions: false,
      baseUrl: lookup.ok ? lookup.route.baseUrl : null,
    };
  }
  const known = embeddingModelCatalogByUri[embeddingModelBaseUri(config.modelUri)];
  const openAiCompatibleLocal = ["ollama", "vllm", "lmstudio"].includes(parsed.provider);
  const defaultBaseUrl =
    parsed.provider === "ollama" ? "http://127.0.0.1:11434/v1" :
      parsed.provider === "vllm" ? "http://127.0.0.1:8000/v1" :
        parsed.provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : null;
  // Explicit workspace dimensions; only these are sent as a request parameter to
  // OpenAI-compatible servers that support Matryoshka truncation (e.g. vLLM).
  const requestedDimensions = config.dimensions;
  if (known) {
    return {
      ...known,
      dimensions: config.dimensions ?? known.dimensions,
      requestedDimensions,
      modelUri: config.modelUri,
      baseUrl: known.provider === "openrouter" ? OPENROUTER_BASE_URL
        : known.provider === "deepinfra" ? DEEPINFRA_EMBEDDING_BASE_URL
          : parsed.params.get("baseUrl") ?? defaultBaseUrl,
    };
  }

  if (parsed.provider === "deepinfra") throw new Error("Unsupported DeepInfra embedding model");

  return {
    label: parsed.model,
    tags: [config.target, "custom"],
    capabilities: ["embedding"] as const,
    modelUri: config.modelUri,
    target: config.target,
    runtime: openAiCompatibleLocal || config.target === "hosted"
      ? "remote" as const
      : "local" as const,
    provider: parsed.provider,
    model: parsed.model,
    dimensions: config.dimensions ?? 1536,
    requestedDimensions,
    batchSize: config.target === "local" ? 16 : 64,
    supportsCustomDimensions: true,
    baseUrl: parsed.params.get("baseUrl") ?? defaultBaseUrl,
  };
}

export const visionRuntimeSchema = z.enum([
  "local-cli",
  "openai-compatible",
  "remote-openai",
]);
export type VisionRuntime = z.infer<typeof visionRuntimeSchema>;
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * The hosted vision model behind the default profile (`good-fast-hosted`). Switching the default is a one-line
 * change here: the profile label and description, the default config and the default-derived values follow.
 * It must be a hosted `visionModelCatalog` id (checked by the catalog tests).
 */
// Tuned DeepSeek V4.1 Flash 1017 (US-hosted routes): best quality tier, fastest and cheaper per page than Gemini 3.1
// Flash Lite on the 2026-10-22 vision holdout. Roll back without a deploy via DOCSLURP_VISION_MODEL_URI (app and worker).
export const DEFAULT_OPENROUTER_VISION_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** Opt-in hosted vision route; OpenRouter list price verified 2026-10-20 ($0.15/M input, $0.50/M output). */
export const NEMOTRON_SUPER_VL_VISION_MODEL = "nvidia/nemotron-3.5-super-vl";
export const DEFAULT_LOCAL_OCR_MODEL = "microsoft/Florence-2-base-ft";
export const DEFAULT_IMAGE_CLASSIFICATION_MODEL = "Xenova/clip-vit-base-patch32";
export const visionBenchmarkProfileSchema = z.enum([
  "difficult-pages",
  "ocr-heavy",
  "layout-heavy",
]);
export type VisionBenchmarkProfile = z.infer<
  typeof visionBenchmarkProfileSchema
>;

/**
 * Why a cataloged hosted vision model is not admitted (`refusedReason` on its entry): no request is admitted, priced or
 * sent on it, and config validation rejects it, until serving-level evidence of its per-image token maximum exists.
 */
const UNPROVEN_IMAGE_TOKEN_BOUND =
  "its per-image token maximum is not proven at the serving level (providers can raise the processor limits), so no request can be weighed; refused until serving evidence exists";

export const visionModelCatalog = [
  {
    id: "microsoft/Florence-2-small-ft",
    uri: "llm://local-cli/microsoft/Florence-2-small-ft",
    label: "Florence-2 Small",
    target: "local",
    tags: ["local", "cost", "smallest"],
    runtime: "local-cli",
    description:
      "Lowest-cost local OCR-style VLM for quick page rescue on CPU/GPU worker nodes.",
    estimatedCostPerPageCents: 0.2,
    tokenPricing: null,
    imageTokens: null,
  },
  {
    id: DEFAULT_LOCAL_OCR_MODEL,
    uri: `llm://local-cli/${DEFAULT_LOCAL_OCR_MODEL}`,
    label: "Florence-2 Base",
    target: "local",
    tags: ["local", "quality"],
    runtime: "local-cli",
    description:
      "Stronger local Florence baseline for OCR and caption extraction when quality matters.",
    estimatedCostPerPageCents: 0.35,
    tokenPricing: null,
    imageTokens: null,
  },
  {
    id: "Qwen/Qwen2-VL-2B-Instruct",
    uri: "llm://vllm/Qwen/Qwen2-VL-2B-Instruct",
    label: "Qwen2-VL 2B",
    target: "local",
    tags: ["local", "speed", "small"],
    runtime: "openai-compatible",
    description:
      "Compact local VLM suited to OpenAI-compatible runtimes such as vLLM or Ollama gateways.",
    estimatedCostPerPageCents: 0.45,
    tokenPricing: null,
    imageTokens: null,
  },
  {
    id: "Qwen/Qwen2.5-VL-3B-Instruct",
    uri: "llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct",
    label: "Qwen2.5-VL 3B",
    target: "local",
    tags: ["local", "quality"],
    runtime: "openai-compatible",
    description:
      "Slightly larger local VLM with better layout fidelity on complex pages.",
    estimatedCostPerPageCents: 0.6,
    tokenPricing: null,
    imageTokens: null,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    uri: "llm://openrouter/google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    target: "hosted",
    tags: ["hosted", "speed", "quality"],
    runtime: "openai-compatible",
    description:
      "OpenRouter multimodal model for low-latency, high-volume page extraction.",
    estimatedCostPerPageCents: 0.5,
    tokenPricing: { inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5, checked: "2026-10-25" },
    imageTokens: { kind: "fixed", tokens: 2_240, basis: "gemini-media-resolution" },
  },
  {
    id: "google/gemini-2.5-flash-lite",
    uri: "llm://openrouter/google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    target: "hosted",
    tags: ["hosted", "cost", "speed"],
    runtime: "openai-compatible",
    description:
      "Ultra-low-cost OpenRouter multimodal option for lightweight page rescue.",
    estimatedCostPerPageCents: 0.25,
    tokenPricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4, checked: "2026-10-25" },
    imageTokens: { kind: "patch", patchPx: 256, tokensPerPatch: 258, basis: "gemini-tiles" },
  },
  {
    id: NEMOTRON_SUPER_VL_VISION_MODEL,
    uri: `llm://openrouter/${NEMOTRON_SUPER_VL_VISION_MODEL}`,
    label: "Nemotron 3.5 Super VL",
    target: "hosted",
    tags: ["hosted", "cost", "open-weights"],
    runtime: "openai-compatible",
    description:
      "Open-weights NVIDIA multimodal MoE (12B active of 120B) on OpenRouter; opt-in low-cost page extraction.",
    // Conservative like the Gemini entry. A 3-page smoke measured 0.02-0.07 cents per page (1.2k-3.2k input
    // tokens: images tile by resolution) against 0.09-0.16 for Gemini 3.1 Flash Lite; refine after the slice run.
    estimatedCostPerPageCents: 0.2,
    tokenPricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.5, checked: "2026-10-25" },
    // Refused (council round 8, M3): 3,330 is the published processor's maximum (processor-max:nemotron-h-omni), but
    // neither the image framing nor any provider's serving configuration could be verified, and a raster ceiling is
    // not a proven serving maximum either. No image-token bound, so the guard cannot weigh it: not admitted.
    imageTokens: null,
    refusedReason: UNPROVEN_IMAGE_TOKEN_BOUND,
  },
  // Opt-in tuned candidates (see worker/src/tools/vision-model-profiles.ts for their per-model prompt, routing and
  // reasoning settings). List prices from OpenRouter's /api/v1/models, checked 2026-10-22; per-page costs are measured.
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    uri: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017",
    label: "DeepSeek V4.1 Flash 1017",
    target: "hosted",
    tags: ["hosted", "cost", "open-weights"],
    runtime: "openai-compatible",
    description:
      "Open-weights (MIT) DeepSeek multimodal snapshot via the cheapest allowed US host (Together, Fireworks or Parasail); Markdown/LaTeX page transcription.",
    // Measured 0.103 cents per page on the US route (2026-10-22 select split, docs/model-configuration.md). The token
    // prices are the route's most expensive allowed host ($0.30/$1.20 per 1M: Together, Fireworks, Parasail, and
    // DeepSeek's own endpoint at weekday peak; StreamLake lists $0.15/$0.60; docs/evals/vision-route-prices-2026-10-29.json),
    // so the guard weight and max_price hold on every host. Billing uses the served host's reported charge. At list
    // price the SELF_HOSTED_PAGE_TOKENS formula gave 0.0705 cents, 32% under the measurement (the 2026-10-26 margin
    // audit); at the route price it gives 0.141 cents, a conservative bound for flat-tier eligibility.
    estimatedCostPerPageCents: 0.103,
    tokenPricing: {
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 1.2,
      checked: "2026-10-26",
      basis: "pinned-route",
      providers: ["together", "fireworks", "parasail"],
    },
    // StreamLake and DeepSeek billed the same input tokens per page as Together on the 2026-10-29 tune/select
    // pages (difference -2 to 0, maximum 1,158), so they serve the same image limit.
    imageTokens: { kind: "fixed", tokens: 1_024, basis: "processor-max:deepseek-v4.1" },
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    uri: "llm://openrouter/xiaomi/mimo-v2.6-flash",
    label: "MiMo V2.6 Flash",
    target: "hosted",
    tags: ["hosted", "cost", "open-weights"],
    runtime: "openai-compatible",
    description:
      "Open-weights (MIT) Xiaomi MiMo multimodal model on OpenRouter; opt-in low-cost page extraction with pinned fast routing.",
    estimatedCostPerPageCents: 0.056,
    tokenPricing: { inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28, checked: "2026-10-25" },
    // Refused (council round 8, M3): 8,194 is the published processor's maximum (processor-max:qwen2-vl), but no
    // provider's serving configuration (`max_pixels` can be raised at serve time) could be verified, and a raster
    // ceiling is not a proven serving maximum either. No image-token bound, so the guard cannot weigh it: not admitted.
    imageTokens: null,
    refusedReason: UNPROVEN_IMAGE_TOKEN_BOUND,
  },
  {
    id: "openai/gpt-6-luna",
    uri: "llm://openrouter/openai/gpt-6-luna",
    label: "GPT-6 Luna",
    target: "hosted",
    tags: ["hosted", "cost", "quality"],
    runtime: "openai-compatible",
    description:
      "OpenAI GPT-6 Luna on OpenRouter; opt-in low-cost page extraction with high-detail images and a content-filter retry route.",
    estimatedCostPerPageCents: 0.061,
    tokenPricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, checked: "2026-10-25" },
    imageTokens: { kind: "patch", patchPx: 32, tokensPerPatch: 2.46, basis: "openai-patch-max-multiplier" },
  },
  {
    id: "z-ai/glm-5.3-flash",
    uri: "llm://openrouter/z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    target: "hosted",
    tags: ["hosted", "cost", "open-weights"],
    runtime: "openai-compatible",
    description:
      "Open-weights (MIT) Z.ai GLM multimodal model on OpenRouter; opt-in page extraction.",
    // Computed, not measured: ~3,000 input + 560 output tokens at current list price = 0.073 cents.
    estimatedCostPerPageCents: 0.073,
    tokenPricing: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.5, checked: "2026-10-25" },
    imageTokens: { kind: "fixed", tokens: 8_002, basis: "processor-max:glm5-next" },
  },
  {
    id: "gpt-4.1-mini",
    uri: "llm://openai/gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    target: "hosted",
    tags: ["hosted", "quality"],
    runtime: "remote-openai",
    description:
      "Hosted remote fallback for difficult pages when local models miss the quality bar.",
    estimatedCostPerPageCents: 3,
    tokenPricing: { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6, checked: "2026-10-25" },
    imageTokens: { kind: "patch", patchPx: 32, tokensPerPatch: 1.62, basis: "openai-patch" },
  },
] as const;

export const supportedVisionModels = visionModelCatalog.map(
  (entry) => entry.id,
);
export const visionRuntimeOptions = visionRuntimeSchema.options;
export const visionBenchmarkProfileOptions =
  visionBenchmarkProfileSchema.options;
export const visionModelSchema = z.enum(
  supportedVisionModels as [
    (typeof supportedVisionModels)[number],
    ...(typeof supportedVisionModels)[number][],
  ],
);
export type VisionModel = z.infer<typeof visionModelSchema>;

type VisionModelPreset = (typeof visionModelCatalog)[number];

export const visionModelCatalogById = visionModelCatalog.reduce<
  Record<VisionModel, VisionModelPreset>
>(
  (acc, entry) => {
    acc[entry.id] = entry;
    return acc;
  },
  {} as Record<VisionModel, VisionModelPreset>,
);

export const visionModelCatalogByUri = Object.fromEntries(
  visionModelCatalog.map((entry) => [entry.uri, entry]),
) as Record<string, VisionModelPreset>;

export type VisionTokenPricing = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  checked: string;
  /**
   * `pinned-route`: the highest price among the OpenRouter providers the model's vision profile restricts it to
   * (`providers`: its pinned `order` with fallbacks off, or its `only` allowlist), used when that route costs more than
   * the model's list price. Absent: the OpenRouter list price.
   */
  basis?: "pinned-route";
  providers?: readonly string[];
};

/** List token price of a cataloged hosted vision model (by id or `llm://` URI); null for local or unknown models. */
export function visionModelTokenPricing(idOrUri: string): VisionTokenPricing | null {
  const entry = visionModelCatalogByUri[idOrUri] ?? visionModelCatalog.find((spec) => spec.id === idOrUri);
  return entry?.tokenPricing ?? null;
}

/** Fractional USD cents for a vision call priced from catalog list prices; null when the model has none. */
export function visionListPriceCents(
  idOrUri: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const pricing = visionModelTokenPricing(idOrUri);
  if (!pricing) return null;
  return (usage.inputTokens * pricing.inputUsdPerMillion + usage.outputTokens * pricing.outputUsdPerMillion) / 1e4;
}

/**
 * Upper bound on the input tokens one image costs on a hosted vision model (`imageTokens` in the catalog). Every
 * priced catalog model must carry one: the vision guard weighs requests with it and refuses a model without it.
 *
 * - `patch`: ceil(width / patchPx) × ceil(height / patchPx) × tokensPerPatch, with no credit for the provider's
 *   own downscaling, so it bounds any resize.
 * - `fixed`: a constant per image, the family's largest documented per-image count.
 *
 * A hosted entry with `refusedReason` (MiMo V2.6 Flash: processor maximum 8,194, `qwen2-vl`; Nemotron 3.5 Super VL:
 * 3,330, `nemotron-h-omni`) has no bound: its processor maximum is not a proven serving maximum, so it is refused.
 *
 * Bases (checked 2026-10-29):
 * - `openai-patch`: OpenAI's patch formula (32-px patches, model multiplier; gpt-4.1-mini 1.62), images-vision guide.
 * - `openai-patch-max-multiplier`: the same formula at the largest multiplier OpenAI lists (2.46, gpt-4.1-nano),
 *   for an OpenAI model with no listed multiplier.
 * - `gemini-media-resolution`: Gemini 3's largest per-image count (`ultra_high`, 2,240; the default is 1,120).
 * - `gemini-tiles`: Gemini 2.x's 258 tokens per tile, counted per 256-px square rather than its documented 768-px
 *   tile (9x), which covers its crop-unit rescaling.
 * - `processor-max:<processor>`: the most tokens the model's published Hugging Face image processor can give one
 *   image at any size, after its minimum-size upscaling, resizing, tiling and patch merging, plus the image's
 *   framing tokens (start/end markers, row separators). Open-weights models only; read from the model repository's
 *   `preprocessor_config.json` / `processor_config.json` and processor code (checked 2026-10-29):
 *   - `deepseek-v4.1` (deepseek-ai/DeepSeek-V4.1-Flash-1017, `inference/image_processor.py`): the resize plan keeps
 *     the full image span (start, rows with their new-line tokens, end) at or below `vision_max_n_token` 1,024,
 *     after `vision_min_pixels` upscaling. The bound holds only while every pinned provider serves the published
 *     `vision_max_n_token`; a provider that raises it bills above the bound, which the vision guard's per-route
 *     weight correction absorbs (worker/src/lib/vision-attempt-guard.ts).
 *   - `glm5-next` (zai-org/GLM-5.3-Flash, `Glm5NextImageProcessor`): `smart_resize` to at most `max_image_tokens`
 *     8,000 merged 28-px tokens, plus the image start and end tokens: 8,002.
 */
export type VisionImageTokenBound =
  | { kind: "patch"; patchPx: number; tokensPerPatch: number; basis: string }
  | { kind: "fixed"; tokens: number; basis: string };

/** Why a cataloged vision model is refused (no request is admitted on it), or null. */
export function visionModelRefusal(idOrUri: string): string | null {
  const entry = visionModelCatalogByUri[idOrUri] ?? visionModelCatalog.find((spec) => spec.id === idOrUri);
  return entry && "refusedReason" in entry ? entry.refusedReason : null;
}

/** Largest raster edge the worker renders (lib/raster-bounds.ts caps it at 4,095 px): the bound for an unknown size. */
export const VISION_MAX_IMAGE_EDGE_PX = 4_096;

/** The catalog image-token bound of a vision model (by id or `llm://` URI); null for local or unknown models. */
export function visionModelImageTokenBound(idOrUri: string): VisionImageTokenBound | null {
  const entry = visionModelCatalogByUri[idOrUri] ?? visionModelCatalog.find((spec) => spec.id === idOrUri);
  return (entry?.imageTokens as VisionImageTokenBound | null | undefined) ?? null;
}

/**
 * Upper bound on one image's input tokens on `idOrUri`, at its pixel size (unknown: the largest raster).
 * Null when the model has no catalog bound.
 */
export function visionImageTokens(idOrUri: string, image: { widthPx: number | null; heightPx: number | null } | null): number | null {
  const bound = visionModelImageTokenBound(idOrUri);
  if (!bound) return null;
  if (bound.kind === "fixed") return bound.tokens;
  const known = Boolean(image?.widthPx && image.heightPx && image.widthPx > 0 && image.heightPx > 0);
  const width = known ? image!.widthPx! : VISION_MAX_IMAGE_EDGE_PX;
  const height = known ? image!.heightPx! : VISION_MAX_IMAGE_EDGE_PX;
  return Math.ceil(Math.ceil(width / bound.patchPx) * Math.ceil(height / bound.patchPx) * bound.tokensPerPatch);
}

/** Output price at or above which a model is never offered or called (repository model-cost rule). */
export const VISION_MAX_OUTPUT_USD_PER_MILLION = 50;

/** Hosted providers a vision route may use: both bill per token and are priced from the catalog. */
export const HOSTED_VISION_PROVIDERS = ["openai", "openrouter"] as const;
/** Local providers a vision route may use: in-process, or a loopback OpenAI-compatible server. */
export const LOCAL_VISION_PROVIDERS = ["local-cli", "ollama", "vllm", "lmstudio"] as const;
/** Local providers whose server address a `baseUrl` parameter may set (loopback hosts only). */
export const LOCAL_BASE_URL_PROVIDERS = ["ollama", "vllm", "lmstudio"] as const;

/** OpenAI "Pro" / "Ultra" tiers (`o3-pro`, `gpt-5-pro-2025-10-06`, `…-ultra`): never offered or called. */
export function isProhibitedPremiumModelId(model: string): boolean {
  return /-(pro|ultra)(?=$|[-_.:/@])/i.test(model);
}

/**
 * Why `uri` cannot be a vision route, or null. Hosted vision is limited to the priced catalog: an `openai` or
 * `openrouter` route must be a catalog entry with a token price and an image-token bound, so every hosted request
 * is priced, capped and billed. Other providers are `private` (operator registry) or local (`LOCAL_VISION_PROVIDERS`);
 * any other provider would resolve to an OpenAI-compatible route with no base URL, which is api.openai.com.
 * Pro/Ultra ids and models at or above `VISION_MAX_OUTPUT_USD_PER_MILLION` output are refused on every provider.
 */
export function visionModelUriProblem(uri: string): string | null {
  const { provider, model, params } = parseLlmModelUri(uri);
  if (isProhibitedPremiumModelId(model)) return `Vision model ${model} is a Pro/Ultra tier, which is never used`;
  // A baseUrl moves the request's destination (and so its billing and key): only a local server on a loopback host.
  const baseUrl = params.get("baseUrl");
  if (baseUrl !== null) {
    if (!(LOCAL_BASE_URL_PROVIDERS as readonly string[]).includes(provider)) return "baseUrl overrides are only supported for local model providers";
    if (!isLoopbackModelBaseUrl(baseUrl)) return "Local model baseUrl must use a loopback host";
  }
  if (provider === PRIVATE_MODEL_PROVIDER) return null;
  if ((LOCAL_VISION_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (!(HOSTED_VISION_PROVIDERS as readonly string[]).includes(provider)) {
    return `Vision provider ${provider} is not supported: use openai, openrouter, private or a local provider (${LOCAL_VISION_PROVIDERS.join(", ")})`;
  }
  const entry = visionModelCatalogByUri[uri];
  const refusal = visionModelRefusal(uri);
  if (refusal) return `Hosted vision model ${model} is not admitted: ${refusal}`;
  const pricing = entry?.tokenPricing ?? null;
  if (!entry || !pricing || !visionModelImageTokenBound(uri)) {
    return `Hosted vision model ${model} is not in the priced vision catalog: use one of ${
      visionModelCatalog.filter((spec) => spec.tokenPricing && !("refusedReason" in spec)).map((spec) => spec.uri).join(", ")
    }`;
  }
  if (pricing.outputUsdPerMillion >= VISION_MAX_OUTPUT_USD_PER_MILLION) {
    return `Vision model ${model} costs $${pricing.outputUsdPerMillion}/M output tokens, at or above the $${VISION_MAX_OUTPUT_USD_PER_MILLION}/M limit`;
  }
  return null;
}

/** The profile a workspace gets when it picks no vision model or profile. */
export const DEFAULT_VISION_PROFILE = "good-fast-hosted" satisfies VisionProfileKey;

export const visionProfileKeySchema = z.enum([
  "cheapest-local",
  "fastest-local",
  "good-fast-local",
  "cheapest-hosted",
  "good-fast-hosted",
  "open-weights-hosted",
]);
export type VisionProfileKey = z.infer<typeof visionProfileKeySchema>;

export const visionProfileCatalog = {
  "cheapest-local": {
    label: "Cheapest local",
    description: "Small Florence model with no hosted inference charge.",
    tags: ["cost", "local", "smallest"],
    config: {
      profile: "cheapest-local",
      target: "local",
      modelUri: "llm://local-cli/microsoft/Florence-2-small-ft",
    },
  },
  "fastest-local": {
    label: "Fastest local",
    description: "Compact Qwen vision route for a local vLLM runtime.",
    tags: ["speed", "local", "small"],
    config: {
      profile: "fastest-local",
      target: "local",
      modelUri: "llm://vllm/Qwen/Qwen2-VL-2B-Instruct",
    },
  },
  "good-fast-local": {
    label: "Good + fast local",
    description: "Higher-fidelity local Qwen vision route with moderate resource use.",
    tags: ["quality", "speed", "local"],
    config: {
      profile: "good-fast-local",
      target: "local",
      modelUri: "llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct",
    },
  },
  "cheapest-hosted": {
    label: "Cheapest hosted",
    description: "Low-cost hosted Gemini Flash Lite route through OpenRouter.",
    tags: ["cost", "speed", "hosted"],
    config: {
      profile: "cheapest-hosted",
      target: "hosted",
      modelUri: "llm://openrouter/google/gemini-2.5-flash-lite",
    },
  },
  "good-fast-hosted": {
    label: "Good + fast hosted",
    // Derived from the default model's catalog entry so switching DEFAULT_OPENROUTER_VISION_MODEL needs no copy edits.
    description: `Default hosted route (${visionModelCatalogById[DEFAULT_OPENROUTER_VISION_MODEL].label}) balancing extraction quality and latency.`,
    tags: ["quality", "speed", "hosted"],
    config: {
      profile: "good-fast-hosted",
      target: "hosted",
      modelUri: `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`,
    },
  },
  "open-weights-hosted": {
    label: "Open-weights hosted",
    // Was Nemotron 3.5 Super VL, refused until its image-token bound has serving evidence (`refusedReason`).
    description: `Open-weights (MIT) hosted route (${visionModelCatalogById[DEFAULT_OPENROUTER_VISION_MODEL].label}) through OpenRouter's US providers.`,
    tags: ["cost", "hosted", "open-weights"],
    config: {
      profile: "open-weights-hosted",
      target: "hosted",
      modelUri: `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`,
    },
  },
} as const satisfies Record<VisionProfileKey, {
  label: string;
  description: string;
  tags: readonly string[];
  config: { profile: VisionProfileKey; target: ModelTarget; modelUri: string };
}>;

// Parser playbooks: internal presets that describe extraction/vision tradeoffs. Not a public setting: the worker
// derives the playbook from `pipeline.quality` (parserPlaybookForQuality), and classify-route may suggest one per
// document inside `auto`.
export const parserPlaybookKeySchema = z.enum([
  "fast",
  "balanced",
  "layout-aware",
  "agentic",
  "review-grade",
]);
export type ParserPlaybookKey = z.infer<typeof parserPlaybookKeySchema>;

export type ParserPlaybookPreset = {
  label: string;
  description: string;
  // Estimated envelope hints for UI/cost forecasting.
  est: { costCentsPer100Pages: number; latencySecPer100Pages: number };
  // Parser/vision guidance used by the worker.
  guidance: {
    // Prefer table/layout-aware markdown extractors when available.
    preferLayoutMarkdown: boolean;
    // Try multiple extractors and do voting when true.
    multiStrategyVoting: boolean;
    // Page-level OCR escalation density threshold override (0..1). Lower = escalate more.
    visionDensityThreshold?: number;
    // False: this playbook never sends pages to vision (text layer only). Vision reads every page the
    // routing selects otherwise; there is no per-document page count (spend is bounded by maxCostCents).
    visionAllowed?: boolean;
  };
};

export const adaptivePageRouteSchema = z.enum([
  "straightforward-text",
  "formula-heavy",
  "code-heavy",
  "chemical-notation-heavy",
  "table-heavy",
  "form",
  "chart-or-figure",
  "handwriting-or-degraded",
  "image-heavy",
]);
export type AdaptivePageRoute = z.infer<typeof adaptivePageRouteSchema>;

export const adaptiveDocumentComplexitySchema = z.enum([
  "simple",
  "mixed",
  "complex",
]);
export type AdaptiveDocumentComplexity = z.infer<
  typeof adaptiveDocumentComplexitySchema
>;

export const adaptiveVisionPolicySchema = z.enum([
  "skip",
  "selective",
  "aggressive",
]);
export type AdaptiveVisionPolicy = z.infer<typeof adaptiveVisionPolicySchema>;

export const adaptiveSpecializedContentKindSchema = z.enum([
  "formula",
  "source-code",
  "chemical-notation",
]);
export type AdaptiveSpecializedContentKind = z.infer<
  typeof adaptiveSpecializedContentKindSchema
>;

export const adaptiveExtractorHintSchema = z.enum([
  "cheap-text",
  "layout-aware",
  "vision-rescue",
  "syntax-preserving",
]);
export type AdaptiveExtractorHint = z.infer<typeof adaptiveExtractorHintSchema>;

export const adaptiveSpecializedContentEntrySchema = z.object({
  kind: adaptiveSpecializedContentKindSchema,
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()).default([]),
});
export type AdaptiveSpecializedContentEntry = z.infer<
  typeof adaptiveSpecializedContentEntrySchema
>;

export const adaptiveSpecializedContentSummarySchema = z.object({
  kind: adaptiveSpecializedContentKindSchema,
  pageCount: z.number().int().positive(),
  pageNumbers: z.array(z.number().int().positive()).default([]),
  maxConfidence: z.number().min(0).max(1),
});
export type AdaptiveSpecializedContentSummary = z.infer<
  typeof adaptiveSpecializedContentSummarySchema
>;

export const adaptiveOcrDecisionSchema = z.object({
  authorized: z.boolean(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()).default([]),
});
export type AdaptiveOcrDecision = z.infer<typeof adaptiveOcrDecisionSchema>;

export const adaptivePageRoutingEntrySchema = z.object({
  pageNumber: z.number().int().positive(),
  route: adaptivePageRouteSchema,
  confidence: z.number().min(0).max(1),
  textDensityScore: z.number().min(0).max(1),
  signals: z.array(z.string()).default([]),
  extractorHint: adaptiveExtractorHintSchema,
  specializedContent: z
    .array(adaptiveSpecializedContentEntrySchema)
    .default([]),
  ocrDecision: adaptiveOcrDecisionSchema.optional(),
});
export type AdaptivePageRoutingEntry = z.infer<
  typeof adaptivePageRoutingEntrySchema
>;

export const adaptiveRoutingArtifactSchema = z.object({
  documentId: z.string(),
  label: z.string(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()).default([]),
  suggestedPlaybook: parserPlaybookKeySchema.nullable().default(null),
  documentComplexity: adaptiveDocumentComplexitySchema,
  dominantRoutes: z.array(adaptivePageRouteSchema).default([]),
  visionPolicy: adaptiveVisionPolicySchema,
  specializedContentSummary: z
    .array(adaptiveSpecializedContentSummarySchema)
    .default([]),
  pages: z.array(adaptivePageRoutingEntrySchema).default([]),
});
export type AdaptiveRoutingArtifact = z.infer<
  typeof adaptiveRoutingArtifactSchema
>;

export const adaptiveRoutingEvidenceSchema = z.object({
  source: z.enum([
    "canonical-document",
    "markdown-manifest",
    "extraction-contract",
    "liteparse-structured",
    "page-image-evidence",
  ]),
  artifactUri: z.string(),
  characterCount: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
});

export const adaptiveRoutingReadySurfaceSchema = adaptiveRoutingArtifactSchema.extend({
  status: z.literal("ready"),
  evidence: adaptiveRoutingEvidenceSchema,
});

export const adaptiveRoutingDeferredSurfaceSchema = z.object({
  status: z.literal("deferred"),
  documentId: z.string(),
  reason: z.literal("extraction-evidence-unavailable"),
  pages: z.array(adaptivePageRoutingEntrySchema).length(0),
});

export const adaptiveRoutingDecisionSurfaceSchema = z.discriminatedUnion("status", [
  adaptiveRoutingReadySurfaceSchema,
  adaptiveRoutingDeferredSurfaceSchema,
]);
export type AdaptiveRoutingDecisionSurface = z.infer<
  typeof adaptiveRoutingDecisionSurfaceSchema
>;
export type AdaptiveRoutingReadySurface = z.infer<
  typeof adaptiveRoutingReadySurfaceSchema
>;

export const parserPlaybookCatalog: Record<
  ParserPlaybookKey,
  ParserPlaybookPreset
> = {
  fast: {
    label: "Fast",
    description:
      "Cheapest and fastest. Text-layer only; minimal layout fidelity.",
    est: { costCentsPer100Pages: 5, latencySecPer100Pages: 30 },
    guidance: {
      preferLayoutMarkdown: false,
      multiStrategyVoting: false,
      visionDensityThreshold: 0.12,
      visionAllowed: false,
    },
  },
  balanced: {
    label: "Balanced",
    description:
      "Default. Cheap text path with table-aware markdown when useful; OCR on hard pages.",
    est: { costCentsPer100Pages: 5.71, latencySecPer100Pages: 90 },
    guidance: {
      preferLayoutMarkdown: true,
      multiStrategyVoting: true,
      visionDensityThreshold: 0.25,
    },
  },
  "layout-aware": {
    label: "Dynamic",
    description:
      "Prefer kreuzberg/native-pdf; align blocks with parser geometry.",
    est: { costCentsPer100Pages: 10, latencySecPer100Pages: 180 },
    guidance: {
      preferLayoutMarkdown: true,
      multiStrategyVoting: true,
      visionDensityThreshold: 0.22,
    },
  },
  agentic: {
    label: "Smart",
    description:
      "Richer reasoning/cleanup later; extraction still favors accuracy over speed.",
    est: { costCentsPer100Pages: 13.33, latencySecPer100Pages: 300 },
    guidance: {
      preferLayoutMarkdown: true,
      multiStrategyVoting: true,
      visionDensityThreshold: 0.2,
    },
  },
  "review-grade": {
    label: "Review Grade",
    description:
      "Highest fidelity. Always run layout markdown + parser alignment; aggressive OCR.",
    est: { costCentsPer100Pages: 120, latencySecPer100Pages: 600 },
    guidance: {
      preferLayoutMarkdown: true,
      multiStrategyVoting: true,
      visionDensityThreshold: 0.3,
    },
  },
};

export const embeddingConfigSchema = z
  .object({
    profile: embeddingProfileKeySchema.default("cheapest-hosted"),
    dimensions: z.number().int().min(128).max(3072).optional(),
    target: modelTargetSchema.optional(),
    modelUri: llmModelUriSchema.optional(),
    task: embeddingTaskSchema.optional(),
    normalize: z.boolean().optional(),
    lateChunking: z.boolean().default(false),
    lateChunkingWindow: z.number().int().min(1).max(6).default(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaults = embeddingProfileCatalog[value.profile].config;
    const modelUri = value.modelUri ?? defaults.modelUri;
    if (!llmModelUriSchema.safeParse(modelUri).success) return;
    const poolingProblem = embeddingPoolingProblem(modelUri);
    if (poolingProblem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["modelUri"], message: poolingProblem });
    if (parseLlmModelUri(modelUri).provider === "openrouter" && parseLlmModelUri(modelUri).params.has("baseUrl")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["modelUri"], message: "OpenRouter embedding routes use the fixed official endpoint" });
    }
    if (value.dimensions !== undefined) {
      const model = embeddingModelCatalogByUri[embeddingModelBaseUri(modelUri)];
      if (!supportsReducedEmbeddingDimensions(modelUri) || (model && value.dimensions > model.dimensions)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dimensions"], message: "Custom dimensions require a supported OpenAI embedding model, a local transformers.js model, or a local OpenAI-compatible server (vLLM, Ollama, LM Studio), and cannot exceed the model's native dimensions" });
      }
    }
    const inferredTarget = inferModelTarget(modelUri);
    if (value.target && value.target !== inferredTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `Target must be ${inferredTarget} for this model URI`,
      });
    }
    const { provider, params } = parseLlmModelUri(modelUri);
    const baseUrl = params.get("baseUrl");
    if (baseUrl && !["ollama", "vllm", "lmstudio"].includes(provider)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelUri"],
        message: "baseUrl overrides are only supported for local model providers",
      });
    }
    if (baseUrl && !isLoopbackModelBaseUrl(baseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelUri"],
        message: "Local model baseUrl must use a loopback host",
      });
    }
  })
  .transform((value) => {
    const defaults = embeddingProfileCatalog[value.profile].config;
    const modelUri = value.modelUri ?? defaults.modelUri;
    return {
      ...defaults,
      ...value,
      profile: value.profile,
      modelUri,
      target: value.target ?? inferModelTarget(modelUri),
    };
  });
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

export const defaultEmbeddingConfig: EmbeddingConfig = {
  ...embeddingProfileCatalog["cheapest-hosted"].config,
  lateChunking: false,
  lateChunkingWindow: 2,
};

// Retired keys that stored pipelines still carry, accepted and dropped instead of failing the strict schema:
// `maxPagesPerDocument` (a per-document vision page cap, removed 2026-10-29) and `forceAllPages` (vision on every
// page, now `pipeline.quality: "good"`; the pipeline schema maps it before this runs).
const LEGACY_VISION_KEYS = ["maxPagesPerDocument", "forceAllPages"] as const;
const dropLegacyVisionKeys = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (!LEGACY_VISION_KEYS.some((key) => key in value)) return value;
  const rest = { ...(value as Record<string, unknown>) };
  for (const key of LEGACY_VISION_KEYS) delete rest[key];
  return rest;
};

const visionConfigObjectSchema = z
  .object({
    profile: visionProfileKeySchema.default(DEFAULT_VISION_PROFILE),
    target: modelTargetSchema.optional(),
    modelUri: llmModelUriSchema.optional(),
    prompt: z.string().trim().min(1).max(200).default("<OCR>"),
    remoteFallbackModelUri: llmModelUriSchema.nullable().default(null),
    benchmarkProfile: visionBenchmarkProfileSchema.default("difficult-pages"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaults = visionProfileCatalog[value.profile].config;
    const modelUri = value.modelUri ?? defaults.modelUri;
    if (!llmModelUriSchema.safeParse(modelUri).success) return;
    const inferredTarget = inferModelTarget(modelUri);
    if (value.target && value.target !== inferredTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `Target must be ${inferredTarget} for this model URI`,
      });
    }
    for (const [path, uri] of [
      ["modelUri", modelUri],
      ["remoteFallbackModelUri", value.remoteFallbackModelUri],
    ] as const) {
      if (!uri) continue;
      if (!llmModelUriSchema.safeParse(uri).success) continue;
      const problem = visionModelUriProblem(uri);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: problem });
    }
  })
  .transform((value) => {
    const defaults = visionProfileCatalog[value.profile].config;
    const modelUri = value.modelUri ?? defaults.modelUri;
    return {
      ...value,
      profile: value.profile,
      modelUri,
      target: value.target ?? inferModelTarget(modelUri),
    };
  });
export const visionConfigSchema = z.preprocess(dropLegacyVisionKeys, visionConfigObjectSchema);
export type VisionConfig = z.output<typeof visionConfigObjectSchema>;

export const defaultVisionConfig: VisionConfig = {
  ...visionProfileCatalog[DEFAULT_VISION_PROFILE].config,
  prompt: "<OCR>",
  remoteFallbackModelUri: null,
  benchmarkProfile: "difficult-pages",
};

/** Env var that replaces the default hosted vision model (a global switch and kill switch). */
export const VISION_MODEL_URI_ENV = "DOCSLURP_VISION_MODEL_URI";

const reportedVisionOverrideErrors = new Set<string>();

/**
 * The validated `DOCSLURP_VISION_MODEL_URI` value, or null when unset or invalid. It must be an `llm://` URI of a
 * hosted model in `visionModelCatalog`: uncataloged models would be priced at the generic fallback rates and
 * under-count spend. An invalid value is reported once and ignored, so a typo never breaks ingestion.
 */
export function readVisionModelUriOverride(
  env: Record<string, string | undefined> = process.env,
  onError: (message: string) => void = (message) => console.error(message),
): string | null {
  const raw = env[VISION_MODEL_URI_ENV]?.trim();
  if (!raw) return null;
  const entry = llmModelUriSchema.safeParse(raw).success ? visionModelCatalogByUri[raw] : undefined;
  if (entry?.target === "hosted") return entry.uri;
  if (!reportedVisionOverrideErrors.has(raw)) {
    reportedVisionOverrideErrors.add(raw);
    onError(
      `[config] ${VISION_MODEL_URI_ENV}=${raw} ignored: expected one of ${
        visionModelCatalog.filter((model) => model.target === "hosted").map((model) => model.uri).join(", ")
      }`,
    );
  }
  return null;
}

export function resetVisionModelUriOverrideReports(): void {
  reportedVisionOverrideErrors.clear();
}

/**
 * Applies `DOCSLURP_VISION_MODEL_URI` to a pipeline whose vision config is still the built-in default (default
 * profile, its own model URI). A non-default profile or any other model URI is an explicit choice and wins, and
 * non-standard privacy modes are left untouched. Call where a run or preview consumes a stored pipeline; never
 * before persisting one, or the override would be saved as if the workspace had chosen it.
 */
export function applyDefaultVisionOverride<T extends { vision: VisionConfig; privacyMode?: string }>(
  pipeline: T,
  env: Record<string, string | undefined> = process.env,
  onError?: (message: string) => void,
): T {
  const override = readVisionModelUriOverride(env, onError);
  if (!override) return pipeline;
  if (pipeline.privacyMode && pipeline.privacyMode !== "standard") return pipeline;
  const defaults = visionProfileCatalog[DEFAULT_VISION_PROFILE].config;
  const { vision } = pipeline;
  if (vision.profile !== DEFAULT_VISION_PROFILE || vision.modelUri !== defaults.modelUri) return pipeline;
  if (override === vision.modelUri) return pipeline;
  return { ...pipeline, vision: { ...vision, modelUri: override, target: "hosted" } };
}

export type VisionExecutionConfig = {
  target: ModelTarget;
  modelUri: string;
  provider: string;
  runtime: VisionRuntime;
  model: string;
  baseUrl: string | null;
  prompt: string;
  remoteFallbackModelUri: string | null;
  benchmarkProfile: VisionBenchmarkProfile;
};

export function resolveVisionRoute(config: VisionConfig): VisionExecutionConfig {
  const parsed = parseLlmModelUri(config.modelUri);
  const preset = visionModelCatalogByUri[config.modelUri];
  const provider = parsed.provider;
  const runtime: VisionRuntime = preset?.runtime ?? (
    provider === "local-cli" ? "local-cli" :
      provider === "openai" ? "remote-openai" : "openai-compatible"
  );
  if (provider === PRIVATE_MODEL_PROVIDER) {
    const lookup = lookupPrivateModelRoute({ ref: config.modelUri, capability: "vision" });
    return {
      target: "private",
      modelUri: config.modelUri,
      provider,
      runtime: "openai-compatible",
      model: parsed.model,
      baseUrl: lookup.ok ? lookup.route.baseUrl : null,
      prompt: config.prompt,
      remoteFallbackModelUri: config.remoteFallbackModelUri,
      benchmarkProfile: config.benchmarkProfile,
    };
  }
  const defaultBaseUrl =
    provider === "openrouter" ? OPENROUTER_BASE_URL :
      provider === "ollama" ? "http://127.0.0.1:11434/v1" :
        provider === "vllm" ? "http://127.0.0.1:8000/v1" :
          provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : null;

  return {
    target: config.target,
    modelUri: config.modelUri,
    provider,
    runtime,
    model: preset?.id ?? parsed.model,
    baseUrl: parsed.params.get("baseUrl") ?? defaultBaseUrl,
    prompt: config.prompt,
    remoteFallbackModelUri: config.remoteFallbackModelUri,
    benchmarkProfile: config.benchmarkProfile,
  };
}

/** True when `value` is a URL on a loopback host (`localhost`, `127.0.0.1`, `[::1]`). */
export function isLoopbackModelBaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
