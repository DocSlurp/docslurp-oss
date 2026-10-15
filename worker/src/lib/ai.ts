import { assertProviderAllowed, authorizePrivateModelCall, isPrivateModelUri, type PrivacyMode, createOpenRouterUsageCapture, createOpenRouterReasoningFetch, resolveOpenRouterUsage, resolvePipelineTextGenerationOptions, resolveSupportedModelIdWithWarning, type TextGenerationConfig, type TextGenerationProfile, type ProviderTextUsage, type PipelineTextOperation } from "@docslurp/shared";
import { withObservation, aiResultDetails } from "@docslurp/shared/observability";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type OutputInterface } from "ai";

import { noteWorkProgress, withRequestTimeout } from "./work-progress.js";
import { PRIVATE_ENDPOINT_API_KEY } from "./text-model-route.js";

export interface TextGenerationUsage extends ProviderTextUsage {}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type WorkerTextOperation = PipelineTextOperation;

function textMetadata(provider: string, args: { operation: WorkerTextOperation; model: string; maxOutputTokens: number }) {
  const separator = args.model.indexOf("/");
  const modelVendor = separator < 0 ? undefined : args.model.slice(0, separator);
  const modelSlug = separator < 0 ? args.model : args.model.slice(separator + 1);
  // These are ID components, not a model catalog or a claim about the routed
  // provider. Preserve the full ID and omit components we cannot parse.
  const parts = /^([a-z][a-z-]*?)(\d+(?:\.\d+)*)(?=$|[-_:])/i.exec(modelSlug);
  return {
    operation: args.operation,
    provider,
    modelId: args.model,
    modelVendor,
    modelSlug,
    modelFamily: parts?.[1]?.replace(/-$/, ""),
    modelVersion: parts?.[2],
    modelSuffix: parts ? modelSlug.slice(parts[0].length).replace(/^[-_:]/, "") || undefined : undefined,
    modelDetailsSource: "requested-model-id",
    maxOutputTokens: args.maxOutputTokens,
  };
}

/** JSON-schema structured output for an OpenAI-compatible chat request. */
export interface ResponseJsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

/**
 * Sends `response_format: json_schema` (vLLM/SGLang guided decoding) but
 * returns the raw text, so callers keep their own lenient JSON parsing.
 */
function jsonSchemaTextOutput(format: ResponseJsonSchema): OutputInterface<string, string, never> {
  return {
    name: "json-schema-text",
    responseFormat: Promise.resolve({ type: "json" as const, schema: format.schema as never, name: format.name }),
    parseCompleteOutput: async ({ text }) => text,
    parsePartialOutput: async () => undefined,
    createElementStreamTransform: () => undefined,
  };
}

async function generatePrivateText(args: {
  operation: WorkerTextOperation;
  system?: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
  textGeneration?: TextGenerationConfig;
  deploymentProfile?: TextGenerationProfile;
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  responseJsonSchema?: ResponseJsonSchema;
}): Promise<{ text: string; usage: TextGenerationUsage; finishReason: string }> {
  const operation = `worker.text.${args.operation}`;
  const call = await authorizePrivateModelCall({ privacyMode: args.privacyMode, modelUri: args.model, capability: "text", operation });
  const settings = resolvePipelineTextGenerationOptions({ operation: args.operation, config: args.textGeneration, deploymentProfile: args.deploymentProfile, maxOutputTokens: args.maxOutputTokens });
  const system = [args.system, settings.systemSuffix].filter(Boolean).join("\n\n") || undefined;
  return withObservation(
    {
      name: operation,
      type: "generation",
      model: call.model,
      input: { system, prompt: args.prompt },
      metadata: { ...textMetadata("private", { ...args, model: call.model, maxOutputTokens: settings.maxOutputTokens }), endpointAlias: call.route.alias, textGenerationProfile: settings.profile },
      result: aiResultDetails,
    },
    async () => {
      const provider = createOpenAI({ apiKey: PRIVATE_ENDPOINT_API_KEY, baseURL: call.baseUrl, fetch: call.fetch });
      const startedAt = Date.now();
      // Chat Completions is the OpenAI-compatible surface vLLM/SGLang/TGI all serve.
      const result = await generateText({
        model: provider.chat(call.model),
        system,
        prompt: args.prompt,
        maxOutputTokens: settings.maxOutputTokens,
        abortSignal: withRequestTimeout(args.signal),
        ...(args.responseJsonSchema ? { output: jsonSchemaTextOutput(args.responseJsonSchema) } : {}),
      });
      noteWorkProgress(`ai:${args.operation}`);
      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const cost = call.cost({ inputTokens, outputTokens, durationMs: Date.now() - startedAt });
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: {
          inputTokens,
          outputTokens,
          costCents: cost.costCents,
          metadata: { ...cost.metadata, provider: "private", servedModel: call.model, tokenUsageReported: result.usage.inputTokens !== undefined },
        },
      };
    },
  );
}

export async function generateOpenRouterText(args: {
  operation: WorkerTextOperation;
  apiKey: string;
  system?: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
  textGeneration?: TextGenerationConfig;
  deploymentProfile?: TextGenerationProfile;
  /** Workspace privacy mode; OpenRouter is hosted, so only `standard` may call it. */
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  /** Structured output schema; sent as `response_format: json_schema` to private endpoints only. */
  responseJsonSchema?: ResponseJsonSchema;
}): Promise<{ text: string; usage: TextGenerationUsage; finishReason: string }> {
  // `llm://private/<alias>/<model>` routes go to the operator-registered endpoint.
  if (isPrivateModelUri(args.model)) return await generatePrivateText(args);
  assertProviderAllowed(args.privacyMode, { provider: "openrouter", model: args.model, operation: `worker.text.${args.operation}`, target: "hosted" });
  args = { ...args, model: resolveSupportedModelIdWithWarning(args.model) };
  const settings = resolvePipelineTextGenerationOptions({ operation: args.operation, config: args.textGeneration, deploymentProfile: args.deploymentProfile, maxOutputTokens: args.maxOutputTokens });
  const system = [args.system, settings.systemSuffix].filter(Boolean).join("\n\n") || undefined;
  return withObservation(
    {
      name: `worker.text.${args.operation}`,
      type: "generation",
      model: args.model,
      input: { system, prompt: args.prompt },
      metadata: { ...textMetadata("openrouter", { ...args, maxOutputTokens: settings.maxOutputTokens }), textGenerationProfile: settings.profile, reasoningEffort: settings.reasoningEffort },
      result: (result) => ({
        ...aiResultDetails(result),
        metadata: {
          routedProvider: result.usage.metadata?.providerName,
          generationId: result.usage.metadata?.generationId,
        },
      }),
    },
    async () => {
      const accounting = createOpenRouterUsageCapture();
      const provider = createOpenAI({
        fetch: createOpenRouterReasoningFetch(accounting.fetch, settings.reasoningEffort),
        apiKey: args.apiKey,
        baseURL: OPENROUTER_BASE_URL,
      });
      const result = await generateText({
        model: provider(args.model),
        system,
        prompt: args.prompt,
        maxOutputTokens: settings.maxOutputTokens,
        providerOptions: settings.reasoningEffort ? { openai: { reasoningEffort: settings.reasoningEffort, forceReasoning: true } } : undefined,
        // Bounded per request (WORKER_AI_REQUEST_TIMEOUT_MS): a dead socket must not hold the stage for hours.
        abortSignal: withRequestTimeout(args.signal),
      });

      noteWorkProgress(`ai:${args.operation}`);
      return {
        text: result.text,
        finishReason: result.finishReason,
        usage: await resolveOpenRouterUsage({ apiKey: args.apiKey, model: args.model, providerName: accounting.providerName(), generationId: result.response.id, usage: { ...result.usage, raw: accounting.usage() ?? result.usage.raw } }),
      };
    },
  );
}

export async function generateAnthropicText(args: {
  operation: WorkerTextOperation;
  apiKey: string;
  system?: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
}): Promise<{ text: string; usage: TextGenerationUsage }> {
  assertProviderAllowed(args.privacyMode, { provider: "anthropic", model: args.model, operation: `worker.text.${args.operation}`, target: "hosted" });
  args = { ...args, model: resolveSupportedModelIdWithWarning(args.model) };
  return withObservation(
    {
      name: `worker.text.${args.operation}`,
      type: "generation",
      model: args.model,
      input: { system: args.system, prompt: args.prompt },
      metadata: textMetadata("anthropic", args),
      result: aiResultDetails,
    },
    async () => {
      const provider = createAnthropic({
        apiKey: args.apiKey,
      });
      const result = await generateText({
        model: provider(args.model),
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens,
        // Bounded per request (WORKER_AI_REQUEST_TIMEOUT_MS): a dead socket must not hold the stage for hours.
        abortSignal: withRequestTimeout(args.signal),
      });

      noteWorkProgress(`ai:${args.operation}`);
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  );
}
