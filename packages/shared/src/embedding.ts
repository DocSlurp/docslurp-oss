import { z } from "zod";
import { lookupPrivateModelRoute, parsePrivateModelUri, PRIVATE_MODEL_PROVIDER } from "./private-endpoints.js";

export const supportedEmbeddingModels = [
  "text-embedding-3-small",
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

const embeddingModelEntries = [
  ["llm://perplexity/pplx-embed-v1-0.6b", "Perplexity Embed 0.6B (native API)", "hosted", "remote", "perplexity", "pplx-embed-v1-0.6b", 1024, 128, false, ["hosted", "open-weights", "cost"]],
  ["llm://perplexity/pplx-embed-v1-4b", "Perplexity Embed 4B (native API)", "hosted", "remote", "perplexity", "pplx-embed-v1-4b", 2560, 128, false, ["hosted", "open-weights", "quality"]],
  ["llm://openrouter/perplexity/pplx-embed-v1-0.6b", "Perplexity Embed 0.6B (OpenRouter)", "hosted", "remote", "openrouter", "perplexity/pplx-embed-v1-0.6b", 1024, 128, false, ["hosted", "open-weights", "cost"]],
  ["llm://openrouter/perplexity/pplx-embed-v1-4b", "Perplexity Embed 4B (OpenRouter)", "hosted", "remote", "openrouter", "perplexity/pplx-embed-v1-4b", 2560, 128, false, ["hosted", "open-weights", "quality"]],
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
  const known = embeddingModelCatalogByUri[modelUri];
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
  const known = embeddingModelCatalogByUri[config.modelUri];
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
      baseUrl: known.provider === "openrouter" ? OPENROUTER_BASE_URL : parsed.params.get("baseUrl") ?? defaultBaseUrl,
    };
  }

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
export const DEFAULT_OPENROUTER_VISION_MODEL = "google/gemini-3.1-flash-lite";
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
  },
  {
    id: DEFAULT_OPENROUTER_VISION_MODEL,
    uri: `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`,
    label: "Gemini 3.1 Flash Lite",
    target: "hosted",
    tags: ["hosted", "speed", "quality"],
    runtime: "openai-compatible",
    description:
      "Default OpenRouter multimodal fallback for low-latency, high-volume page extraction.",
    estimatedCostPerPageCents: 0.5,
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

export const visionProfileKeySchema = z.enum([
  "cheapest-local",
  "fastest-local",
  "good-fast-local",
  "cheapest-hosted",
  "good-fast-hosted",
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
    description: "Default hosted Gemini route balancing extraction quality and latency.",
    tags: ["quality", "speed", "hosted"],
    config: {
      profile: "good-fast-hosted",
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

// Parser playbooks: opinionated presets that describe extraction/vision tradeoffs.
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
    // Hard cap on OCR pages per document.
    visionMaxPagesPerDocument?: number;
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
      visionMaxPagesPerDocument: 0,
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
      visionMaxPagesPerDocument: 4,
    },
  },
  "layout-aware": {
    label: "Dynamic",
    description:
      "Prefer docling/native-pdf; align blocks with parser geometry.",
    est: { costCentsPer100Pages: 10, latencySecPer100Pages: 180 },
    guidance: {
      preferLayoutMarkdown: true,
      multiStrategyVoting: true,
      visionDensityThreshold: 0.22,
      visionMaxPagesPerDocument: 6,
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
      visionMaxPagesPerDocument: 8,
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
      visionMaxPagesPerDocument: 12,
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
    if (parseLlmModelUri(modelUri).provider === "openrouter" && parseLlmModelUri(modelUri).params.has("baseUrl")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["modelUri"], message: "OpenRouter embedding routes use the fixed official endpoint" });
    }
    if (value.dimensions !== undefined) {
      const model = embeddingModelCatalogByUri[modelUri];
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

export const visionConfigSchema = z
  .object({
    profile: visionProfileKeySchema.default("good-fast-hosted"),
    target: modelTargetSchema.optional(),
    modelUri: llmModelUriSchema.optional(),
    prompt: z.string().trim().min(1).max(200).default("<OCR>"),
    maxPagesPerDocument: z.number().int().positive().max(32).default(4),
    forceAllPages: z.boolean().default(false),
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
      const { provider, params } = parseLlmModelUri(uri);
      const baseUrl = params.get("baseUrl");
      if (baseUrl && !["ollama", "vllm", "lmstudio"].includes(provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "baseUrl overrides are only supported for local model providers",
        });
      }
      if (baseUrl && !isLoopbackModelBaseUrl(baseUrl)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "Local model baseUrl must use a loopback host",
        });
      }
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
export type VisionConfig = z.infer<typeof visionConfigSchema>;

export const defaultVisionConfig: VisionConfig = {
  ...visionProfileCatalog["good-fast-hosted"].config,
  prompt: "<OCR>",
  maxPagesPerDocument: 4,
  forceAllPages: false,
  remoteFallbackModelUri: null,
  benchmarkProfile: "difficult-pages",
};

export type VisionExecutionConfig = {
  target: ModelTarget;
  modelUri: string;
  provider: string;
  runtime: VisionRuntime;
  model: string;
  baseUrl: string | null;
  prompt: string;
  maxPagesPerDocument: number;
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
      maxPagesPerDocument: config.maxPagesPerDocument,
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
    maxPagesPerDocument: config.maxPagesPerDocument,
    remoteFallbackModelUri: config.remoteFallbackModelUri,
    benchmarkProfile: config.benchmarkProfile,
  };
}

function isLoopbackModelBaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
