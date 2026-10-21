import { assertProviderAllowed, authorizePrivateModelCall, createOpenRouterReasoningFetch, createOpenRouterUsageCapture, isPrivateModelUri, PRIVATE_MODEL_PROVIDER, resolveOpenRouterUsage, resolveSupportedModelIdWithWarning, type PrivacyMode, type PrivateCallAuditScope, type ProviderTextUsage } from "@docslurp/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { withObservation, aiResultDetails, instrumentFetch } from "@docslurp/shared/observability";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultEmbeddingConfig, defaultPipelineFeatures, DEEPINFRA_EMBEDDING_BASE_URL, validateDeepInfraEmbedding, fitEmbeddingDimensions, parseLlmModelUri, openRouterEmbeddingRoute, validateHostedEmbeddingVector } from "@docslurp/shared";
import { embed, generateText, streamText } from "ai";
import { embedPerplexity } from "@docslurp/shared";

import {
  posthogAiTelemetry,
  type AiObservabilityContext,
} from "./posthog-ai-observability.js";
import { resolveApiTextModelDefault } from "./ai-model-config.js";

export const SEARCH_OPENROUTER_MODEL = resolveApiTextModelDefault();
export const SEARCH_EMBEDDING_MODEL = parseLlmModelUri(
  defaultEmbeddingConfig.modelUri,
).model;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE = "q8";
const OPENROUTER_DEEPSEEK_LOW_THINKING_OPTIONS = {
  openai: {
    reasoningEffort: "low" as const,
    forceReasoning: true,
  },
};
const localEmbeddingPipelineCache = new Map<
  string,
  Promise<LocalEmbeddingPipeline>
>();

export interface TextGenerationUsage extends ProviderTextUsage {}

export interface EmbeddingUsage {
  inputTokens: number;
  /** Set for private endpoint routes: operator-priced cost of this call. */
  costCents?: number;
  metadata?: Record<string, unknown>;
}

/** Placeholder SDK key for private routes; the bound fetch replaces it with operator auth. */
const PRIVATE_ENDPOINT_API_KEY = "private-endpoint";

/**
 * Text generation against an operator-registered private endpoint
 * (`llm://private/<alias>/<model>`): authorized and, under strict-privacy,
 * audited per call; usage carries actual token counts and the operator price.
 */
async function generatePrivateEndpointText(args: {
  operation: string;
  modelUri: string;
  system?: string;
  prompt: string;
  maxOutputTokens: number;
  privacyMode: PrivacyMode;
  auditScope?: PrivateCallAuditScope;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
  observability?: AiObservabilityContext;
}): Promise<{ text: string; usage: TextGenerationUsage; finishReason?: string }> {
  const call = await authorizePrivateModelCall({
    privacyMode: args.privacyMode,
    modelUri: args.modelUri,
    capability: "text",
    operation: args.operation,
    auditScope: args.auditScope,
  });
  return withObservation(
    {
      name: args.operation,
      type: "generation",
      model: call.model,
      input: { system: args.system, prompt: args.prompt },
      metadata: { provider: PRIVATE_MODEL_PROVIDER, endpointAlias: call.route.alias, maxOutputTokens: args.maxOutputTokens },
      result: aiResultDetails,
    },
    async () => {
      const provider = createOpenAI({ apiKey: PRIVATE_ENDPOINT_API_KEY, baseURL: call.baseUrl, fetch: instrumentFetch("private", "inference", call.fetch) });
      const startedAt = Date.now();
      const result = streamText({
        ...posthogAiTelemetry({ functionId: args.operation, provider: PRIVATE_MODEL_PROVIDER, context: args.observability }),
        model: provider.chat(call.model),
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: args.signal,
      });
      let text = "";
      for await (const delta of result.textStream) {
        text += delta;
        await args.onTextDelta?.(delta);
      }
      const [usage, finishReason] = await Promise.all([result.usage, result.finishReason]);
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const cost = call.cost({ inputTokens, outputTokens, durationMs: Date.now() - startedAt });
      return {
        text,
        finishReason,
        usage: { inputTokens, outputTokens, costCents: cost.costCents, metadata: { ...cost.metadata, servedModel: call.model } },
      };
    },
  );
}

export type TextDeltaHandler = (delta: string) => void | Promise<void>;

type LocalEmbeddingPipeline = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<{ tolist?: () => unknown; data?: ArrayLike<number> }>;
type LocalEmbeddingPipelineFactory = (
  task: "feature-extraction",
  model: string,
  options?: Record<string, unknown>,
) => Promise<LocalEmbeddingPipeline>;

export function resolveOpenRouterApiKey(): string | undefined {
  return (
    process.env.OPENROUTER_API_KEY ??
    process.env.OPENROUTER_KEY
  );
}

function resolveLocalTransformersJsDtype(): string {
  const value = (
    process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE ??
    DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE
  )
    .trim()
    .toLowerCase();

  const aliases: Record<string, string> = {
    auto: "auto",
    fp32: "fp32",
    float32: "fp32",
    fp16: "fp16",
    float16: "fp16",
    q8: "q8",
    int8: "q8",
    q4: "q4",
  };

  return aliases[value] ?? DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE;
}

function resolveOpenRouterProviderOptions(model: string) {
  return model.startsWith("deepseek/deepseek-v4")
    ? OPENROUTER_DEEPSEEK_LOW_THINKING_OPTIONS
    : undefined;
}

export async function generateOpenRouterText(args: {
  apiKey: string;
  operation?: string;
  prompt: string;
  model?: string;
  maxOutputTokens: number;
  /** Privacy mode of the workspace whose content or query is sent; only `standard` may reach OpenRouter. */
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  observability?: AiObservabilityContext;
  /** Workspace attribution for strict-privacy audit rows on private endpoint calls. */
  auditScope?: PrivateCallAuditScope;
}): Promise<{ text: string; usage: TextGenerationUsage }> {
  // `llm://private/<alias>/<model>` routes go to the operator-registered endpoint.
  if (isPrivateModelUri(args.model)) {
    const generated = await generatePrivateEndpointText({ ...args, operation: args.operation ?? "api.text.private", modelUri: args.model });
    return { text: generated.text, usage: generated.usage };
  }
  assertProviderAllowed(args.privacyMode, { provider: "openrouter", model: args.model ?? SEARCH_OPENROUTER_MODEL, operation: args.operation ?? "api.text.openrouter", target: "hosted" });
  args = { ...args, model: resolveSupportedModelIdWithWarning(args.model ?? SEARCH_OPENROUTER_MODEL) };
  return withObservation(
    {
      name: args.operation ?? "api.text.openrouter",
      type: "generation",
      model: args.model ?? SEARCH_OPENROUTER_MODEL,
      input: args.prompt,
      metadata: {
        provider: "openrouter",
        maxOutputTokens: args.maxOutputTokens,
      },
      result: aiResultDetails,
    },
    async () => {
      const accounting = createOpenRouterUsageCapture();
      const provider = createOpenAI({
        fetch: instrumentFetch("openrouter", "chat", createOpenRouterReasoningFetch(accounting.fetch)),
        apiKey: args.apiKey,
        baseURL: OPENROUTER_BASE_URL,
      });
      const model = args.model ?? SEARCH_OPENROUTER_MODEL;
      const result = await generateText({
        ...posthogAiTelemetry({
          functionId: args.operation ?? "api.text.openrouter",
          provider: "openrouter",
          context: args.observability,
        }),
        model: provider(model),
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: args.signal,
        providerOptions: resolveOpenRouterProviderOptions(model),
      });

      return {
        text: result.text,
        usage: await resolveOpenRouterUsage({ apiKey: args.apiKey, model: args.model ?? SEARCH_OPENROUTER_MODEL, generationId: result.response.id, usage: { ...result.usage, raw: accounting.usage() ?? result.usage.raw } }),
      };
    },
  );
}

export async function generateOpenRouterDocumentText(args: {
  apiKey: string;
  system?: string;
  prompt: string;
  documents: Array<{
    title: string;
    text: string;
    context?: string;
  }>;
  model?: string;
  maxOutputTokens: number;
  /** Strictest privacy mode across the workspaces whose documents are included. */
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  onTextDelta?: TextDeltaHandler;
  observability?: AiObservabilityContext;
  /** Workspace attribution for strict-privacy audit rows on private endpoint calls. */
  auditScope?: PrivateCallAuditScope;
}): Promise<{
  text: string;
  usage: TextGenerationUsage;
  sources: Array<Record<string, unknown>>;
  finishReason?: string;
}> {
  if (isPrivateModelUri(args.model)) {
    const inlineDocuments = args.documents
      .map((document, index) => [`[${index + 1}] ${document.title}`, document.context ? `Context:\n${document.context}` : "", document.text].filter(Boolean).join("\n\n"))
      .join("\n\n---\n\n");
    const generated = await generatePrivateEndpointText({
      operation: "api.chat.documents",
      modelUri: args.model,
      system: args.system,
      prompt: `${args.prompt}\n\nWorkspace evidence:\n\n${inlineDocuments}`,
      maxOutputTokens: args.maxOutputTokens,
      privacyMode: args.privacyMode,
      auditScope: args.auditScope,
      signal: args.signal,
      onTextDelta: args.onTextDelta,
      observability: args.observability,
    });
    return { ...generated, sources: [] };
  }
  assertProviderAllowed(args.privacyMode, { provider: "openrouter", model: args.model ?? SEARCH_OPENROUTER_MODEL, operation: "api.text.openrouter-documents", target: "hosted" });
  const accounting = createOpenRouterUsageCapture();
  const provider = createOpenAI({
    fetch: instrumentFetch("openrouter", "chat", createOpenRouterReasoningFetch(accounting.fetch)),
    apiKey: args.apiKey,
    baseURL: OPENROUTER_BASE_URL,
  });
  const model = resolveSupportedModelIdWithWarning(args.model ?? SEARCH_OPENROUTER_MODEL);
  const providerOptions = resolveOpenRouterProviderOptions(model);

  async function collectStreamResult(
    result: ReturnType<typeof streamText>,
  ): Promise<{
    text: string;
    usage: TextGenerationUsage;
    sources: Array<Record<string, unknown>>;
  finishReason?: string;
  }> {
    let text = "";

    for await (const delta of result.textStream) {
      text += delta;
      await args.onTextDelta?.(delta);
    }

    const [usage, sources, response, finishReason] = await Promise.all([result.usage, result.sources, result.response, result.finishReason]);

    return {
      text,
      finishReason,
      usage: await resolveOpenRouterUsage({ apiKey: args.apiKey, model, generationId: response.id, usage: { ...usage, raw: accounting.usage() ?? usage.raw } }),
      sources,
    };
  }

  async function streamInlineDocuments(): Promise<{
    text: string;
    usage: TextGenerationUsage;
    sources: Array<Record<string, unknown>>;
  finishReason?: string;
  }> {
    const inlineDocuments = args.documents
      .map((document, index) =>
        [
          `[${index + 1}] ${document.title}`,
          document.context ? `Context:\n${document.context}` : "",
          document.text,
        ]
          .filter(Boolean)
          .join("\n\n"),
      )
      .join("\n\n---\n\n");

    return withObservation(
      {
        name: "api.chat.documents",
        type: "generation",
        model,
        input: {
          system: args.system,
          prompt: args.prompt,
          documents: args.documents,
        },
        metadata: { provider: "openrouter" },
        result: aiResultDetails,
      },
      async () => {
        const result = streamText({
          ...posthogAiTelemetry({
            functionId: "api.chat.documents",
            provider: "openrouter",
            context: args.observability,
          }),
          model: provider(model),
          system: args.system,
          prompt: `${args.prompt}\n\nWorkspace evidence:\n\n${inlineDocuments}`,
          maxOutputTokens: args.maxOutputTokens,
          abortSignal: args.signal,
          providerOptions,
        });

        return {
          ...(await collectStreamResult(result)),
          sources: [],
        };
      },
    );
  }

  // Extracted document bodies are text, not file URLs or base64 attachments.
  return await streamInlineDocuments();
}

export async function embedOpenAiText(args: {
  apiKey: string;
  value: string;
  model?: string;
  dimensions?: number;
  maxRetries?: number;
  baseURL?: string;
  signal?: AbortSignal;
  observability?: AiObservabilityContext;
}): Promise<{ embedding: number[]; usage: EmbeddingUsage }> {
  return withObservation(
    {
      name: "api.embedding.openai",
      metadata: { provider: "openai" },
      type: "embedding",
      model: args.model ?? SEARCH_EMBEDDING_MODEL,
      input: args.value,
      result: aiResultDetails,
    },
    async () => {
      const provider = createOpenAI({
        fetch: instrumentFetch("openai", "embedding"),
        apiKey: args.apiKey,
        ...(args.baseURL && args.baseURL !== DEFAULT_OPENAI_BASE_URL
          ? { baseURL: args.baseURL }
          : {}),
      });

      const result = await embed({
        ...posthogAiTelemetry({
          functionId: "api.embedding.openai",
          provider: "openai",
          context: args.observability,
        }),
        model: provider.embedding(args.model ?? SEARCH_EMBEDDING_MODEL),
        value: args.value,
        abortSignal: args.signal,
        ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
        providerOptions:
          typeof args.dimensions === "number"
            ? { openai: { dimensions: args.dimensions } }
            : undefined,
      });

      return {
        embedding: result.embedding,
        usage: {
          inputTokens: result.usage.tokens ?? 0,
        },
      };
    },
  );
}

async function embedOpenAiCompatibleText(args: {
  apiKey?: string;
  value: string;
  model: string;
  dimensions?: number;
  requestedDimensions?: number;
  normalize?: boolean;
  baseURL: string;
  signal?: AbortSignal;
  provider: string;
  observability?: AiObservabilityContext;
}): Promise<{ embedding: number[]; usage: EmbeddingUsage }> {
  return withObservation(
    {
      name: "api.embedding.compatible",
      metadata: { provider: args.provider },
      type: "embedding",
      model: args.model,
      input: args.value,
      result: aiResultDetails,
    },
    async () => {
      const provider = createOpenAI({
        fetch: instrumentFetch(args.provider, "embedding"),
        apiKey: args.apiKey || "local",
        baseURL: args.baseURL,
      });
      const result = await embed({
        ...posthogAiTelemetry({
          functionId: "api.embedding.compatible",
          provider: args.provider,
          context: args.observability,
        }),
        model: provider.embedding(args.model),
        value: args.value,
        abortSignal: args.signal,
        // vLLM truncates Matryoshka models server-side; match the worker request.
        providerOptions:
          args.provider === "vllm" && typeof args.requestedDimensions === "number"
            ? { openai: { dimensions: args.requestedDimensions } }
            : undefined,
      });
      return {
        embedding: fitEmbeddingDimensions(result.embedding, args.dimensions, args.normalize),
        usage: { inputTokens: result.usage.tokens ?? 0 },
      };
    },
  );
}

export async function embedConfiguredText(args: {
  value: string;
  runtime: string;
  provider: string;
  model?: string;
  dimensions?: number;
  maxRetries?: number;
  /** Workspace-configured dimensions to request from servers that support them. */
  requestedDimensions?: number;
  normalize?: boolean;
  apiKey?: string;
  baseURL?: string;
  /** Workspace privacy mode; hosted embedding providers are refused outside `standard`. */
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  observability?: AiObservabilityContext;
  /** Receives actual usage before hosted vector validation, including malformed paid responses. */
  onUsage?: (usage: EmbeddingUsage) => Promise<void> | void;
  /** `llm://private/...` route; required when `provider` is `private`. */
  modelUri?: string;
  /** Workspace attribution for strict-privacy audit rows on private endpoint calls. */
  auditScope?: PrivateCallAuditScope;
}): Promise<{ embedding: number[]; usage: EmbeddingUsage }> {
  if (args.provider === PRIVATE_MODEL_PROVIDER) {
    return await embedPrivateEndpointText({ ...args, modelUri: args.modelUri ?? "" });
  }
  assertProviderAllowed(args.privacyMode, {
    provider: args.runtime === "local" ? "transformers.js" : args.provider,
    model: args.model ?? "",
    operation: "api.embedding",
  });
  if (args.runtime === "local") {
    return await embedLocalText(args);
  }

  if (args.provider === "deepinfra") {
    if (!args.apiKey) throw new Error("DEEPINFRA_API_KEY is required for DeepInfra embeddings");
    if (args.model !== "BAAI/bge-m3" || (args.dimensions !== undefined && args.dimensions !== 1024) || args.requestedDimensions !== undefined) throw new Error("DeepInfra BGE-M3 requires its native 1024 dimensions");
    return withObservation({ name: "api.embedding.deepinfra", metadata: { provider: "deepinfra" }, type: "embedding", model: args.model, input: args.value, result: aiResultDetails }, async () => {
      const provider = createOpenAI({ apiKey: args.apiKey, baseURL: DEEPINFRA_EMBEDDING_BASE_URL, fetch: instrumentFetch("deepinfra", "embedding") });
      const result = await embed({ model: provider.embedding(args.model!), value: args.value, abortSignal: args.signal, maxRetries: 0 });
      if (!Number.isSafeInteger(result.usage.tokens) || result.usage.tokens! < 0) throw new Error("DeepInfra embeddings require actual provider token usage");
      const usage = { inputTokens: result.usage.tokens! };
      await args.onUsage?.(usage);
      return { embedding: validateDeepInfraEmbedding(result.embedding, 1024, args.normalize ?? true), usage };
    });
  }

  if (args.provider === "perplexity") {
    const result = await withObservation({ name: "api.embedding.perplexity", metadata: { provider: "perplexity" }, type: "embedding", model: args.model, input: args.value, result: aiResultDetails }, () => embedPerplexity({
              fetch: instrumentFetch("perplexity", "embedding"),
      model: args.model ?? "",
      dimensions: args.dimensions,
      apiKey: args.apiKey ?? "",
      values: [args.value],
      normalize: args.normalize,
      signal: args.signal,
      onUsage: tokens => args.onUsage?.({ inputTokens: tokens }),
    }));
    return { embedding: result.embeddings[0]!, usage: { inputTokens: result.usage.tokens } };
  }
  if (args.provider === "openrouter") {
    const route = openRouterEmbeddingRoute(args.model ?? "");
    if (args.dimensions !== undefined && args.dimensions !== route.dimensions) throw new Error("OpenRouter embedding dimensions do not match the registered model");
    if (!args.apiKey) throw new Error("OPENROUTER_API_KEY is required for remote OpenRouter embeddings");
    const provider = createOpenAI({ apiKey: args.apiKey, baseURL: OPENROUTER_BASE_URL, fetch: instrumentFetch("openrouter", "embedding") });
    const result = await withObservation({ name: "api.embedding.openrouter", metadata: { provider: "openrouter" }, type: "embedding", model: route.model, input: args.value, result: aiResultDetails }, () => embed({
      model: provider.embedding(route.model), value: args.value, abortSignal: args.signal, maxRetries: 0,
      ...posthogAiTelemetry({ functionId: "api.embedding.openrouter", provider: "openrouter", context: args.observability }),
    }));
    const inputTokens = result.usage.tokens;
    if (!Number.isSafeInteger(inputTokens) || !(inputTokens! > 0)) throw new Error("OpenRouter embedding response omitted actual usage");
    const usage = { inputTokens: inputTokens! };
    await args.onUsage?.(usage);
    return { embedding: validateHostedEmbeddingVector(result.embedding, route.dimensions, args.normalize), usage };
  }

  if (args.provider === "openai") {
    if (!args.apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for remote OpenAI embeddings",
      );
    }

    return await embedOpenAiText({
      apiKey: args.apiKey,
      value: args.value,
      model: args.model,
      dimensions: args.dimensions,
      maxRetries: args.maxRetries,
      baseURL: args.baseURL,
      signal: args.signal,
      observability: args.observability,
    });
  }

  if (["ollama", "vllm", "lmstudio"].includes(args.provider)) {
    if (!args.baseURL || !args.model) {
      throw new Error(`${args.provider} embeddings require a model and base URL`);
    }
    return await embedOpenAiCompatibleText({
      apiKey: args.apiKey,
      value: args.value,
      model: args.model,
      dimensions: args.dimensions,
      requestedDimensions: args.requestedDimensions,
      normalize: args.normalize,
      baseURL: args.baseURL,
      signal: args.signal,
      provider: args.provider,
      observability: args.observability,
    });
  }

  throw new Error(
    `unsupported embedding runtime/provider for API search: ${args.runtime}/${args.provider}`,
  );
}

async function embedPrivateEndpointText(args: {
  value: string;
  modelUri: string;
  dimensions?: number;
  privacyMode: PrivacyMode;
  auditScope?: PrivateCallAuditScope;
  signal?: AbortSignal;
  observability?: AiObservabilityContext;
}): Promise<{ embedding: number[]; usage: EmbeddingUsage }> {
  const call = await authorizePrivateModelCall({
    privacyMode: args.privacyMode,
    modelUri: args.modelUri,
    capability: "embedding",
    operation: "api.embedding",
    auditScope: args.auditScope,
  });
  return withObservation(
    { name: "api.embedding.private", metadata: { provider: PRIVATE_MODEL_PROVIDER }, type: "embedding", model: call.model, input: args.value, result: aiResultDetails },
    async () => {
      const provider = createOpenAI({ apiKey: PRIVATE_ENDPOINT_API_KEY, baseURL: call.baseUrl, fetch: instrumentFetch("private", "inference", call.fetch) });
      const startedAt = Date.now();
      const result = await embed({
        ...posthogAiTelemetry({ functionId: "api.embedding.private", provider: PRIVATE_MODEL_PROVIDER, context: args.observability }),
        model: provider.embedding(call.model),
        value: args.value,
        abortSignal: args.signal,
      });
      const inputTokens = result.usage.tokens ?? 0;
      const cost = call.cost({ inputTokens, durationMs: Date.now() - startedAt });
      return {
        embedding: fitEmbeddingDimensions(result.embedding, args.dimensions, true),
        usage: { inputTokens, costCents: cost.costCents, metadata: { ...cost.metadata, servedModel: call.model, usageModel: call.usageModel } },
      };
    },
  );
}

async function embedLocalText(args: {
  value: string;
  model?: string;
  dimensions?: number;
  normalize?: boolean;
}): Promise<{ embedding: number[]; usage: EmbeddingUsage }> {
  return withObservation(
    {
      name: "api.embedding.local",
      type: "embedding",
      model: args.model ?? SEARCH_EMBEDDING_MODEL,
      input: args.value,
      metadata: { provider: "local", usageSource: "estimated" },
      result: (result) => ({
        metadata: { estimatedInputTokens: result.usage.inputTokens },
      }),
    },
    async () => {
      const pipeline = await getLocalEmbeddingPipeline(
        args.model ?? SEARCH_EMBEDDING_MODEL,
      );
      const output = await pipeline(args.value, {
        pooling: "mean",
        normalize: args.normalize ?? true,
      });
      const embedding = fitEmbeddingDimensions(
        readEmbeddingVector(output),
        args.dimensions,
        args.normalize ?? true,
      );

      return {
        embedding,
        usage: {
          inputTokens: estimateTokens(args.value),
        },
      };
    },
  );
}

/**
 * Load the default local query-embedding model ahead of the first search. A
 * cold load took ~29 s in production, so the first visitor after every deploy
 * or machine start waited that long. Opt out with LOCAL_EMBEDDING_WARMUP=false.
 */
export async function warmDefaultLocalEmbedding(): Promise<string | null> {
  const prefix = "llm://transformers.js/";
  const uri = defaultPipelineFeatures.embedding.modelUri ?? "";
  if (!uri.startsWith(prefix) || process.env.LOCAL_EMBEDDING_WARMUP === "false") return null;
  const model = uri.slice(prefix.length);
  const pipeline = await getLocalEmbeddingPipeline(model);
  await pipeline("warm up", { pooling: "mean", normalize: true });
  return model;
}

async function getLocalEmbeddingPipeline(
  model: string,
): Promise<LocalEmbeddingPipeline> {
  let cached = localEmbeddingPipelineCache.get(model);
  if (!cached) {
    cached = (async () => {
      const transformers = await import("@huggingface/transformers");
      // Auxiliary model files can be loaded without the pipeline cache_dir option.
      transformers.env.cacheDir = join(homedir(), ".cache", "docslurp", "transformers");
      const createPipeline =
        transformers.pipeline as unknown as LocalEmbeddingPipelineFactory;
      const preferredDtype = resolveLocalTransformersJsDtype();
      const triedDtypes: string[] = [];

      for (const dtype of [preferredDtype, "fp32"]) {
        if (triedDtypes.includes(dtype)) {
          continue;
        }
        triedDtypes.push(dtype);

        try {
          return await createPipeline("feature-extraction", model, {
            dtype,
            cache_dir: join(homedir(), ".cache", "docslurp", "transformers"),
          });
        } catch (error) {
          if (dtype === "fp32") {
            throw error;
          }
        }
      }

      throw new Error(
        `unable to load local transformers.js embedding pipeline for ${model}`,
      );
    })();
    cached.catch(() => {
      localEmbeddingPipelineCache.delete(model);
    });
    localEmbeddingPipelineCache.set(model, cached);
  }

  return await cached;
}

function readEmbeddingVector(output: {
  tolist?: () => unknown;
  data?: ArrayLike<number>;
}): number[] {
  if (typeof output.tolist === "function") {
    const rows = output.tolist();
    if (Array.isArray(rows) && Array.isArray(rows[0])) {
      return (rows[0] as unknown[]).map((value) => Number(value));
    }
    if (Array.isArray(rows)) {
      return rows.map((value) => Number(value));
    }
  }

  if (output.data) {
    return Array.from(output.data, (value) => Number(value));
  }

  throw new Error("local embedding pipeline returned an unexpected payload");
}

function estimateTokens(value: string): number {
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return words === 0 ? 0 : Math.floor(words * 1.3);
}
