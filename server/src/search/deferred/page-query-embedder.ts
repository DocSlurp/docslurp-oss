import { instrumentFetch } from "@docslurp/shared/observability";
import { estimateTextTokens } from "../token-estimate.js";
import {
  attestedRegion,
  authorizePrivateModelCall,
  embeddingSpaceUri,
  formatPrivateModelUri,
  getPrivateModelEndpointRegistry,
  isPrivateModelUri,
  l2Normalize,
  privacyModeAllowsHosted,
  type PrivacyMode,
} from "@docslurp/shared";

import type { UsageRecorder } from "../../lib/ai-usage.js";

const JINA_QUERY_PREFIX = "Query: ";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBED_TIMEOUT_MS = 4000;

export interface PageQueryEmbedderDeps {
  fetchImpl?: typeof fetch;
  geminiApiKey?: string | undefined;
}

/**
 * The space a query vector from `embedPageQuery` is in, as the worker's page embedders record it on
 * `document_page_vectors.model_uri`: the hosted Gemini model under `google`, any other (a private route's model id,
 * or its own `llm://private/...` URI) under `private`.
 */
export function pageQuerySpaceUri(model: string, dimensions: number): string | null {
  // The Gemini embedder records `google`; the private one records `private` with the route's model id (or a URI).
  return String(model).includes("gemini-embedding-2")
    ? embeddingSpaceUri({ provider: "google", model, dimensions })
    : embeddingSpaceUri({ provider: "private", model, dimensions });
}

/**
 * Embed a text query into the same space as stored page-image vectors. The
 * model must match `document_page_vectors.model`: Gemini Embedding 2 takes the
 * raw text (no task prefix), a private endpoint (stored as its model id or URI) takes
 * `"Query: " + text` for Jina v5 models. Any failure or unsupported model returns null so the
 * caller degrades to text-only search instead of blocking.
 */
export async function embedPageQuery(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode; signal?: AbortSignal },
  deps: PageQueryEmbedderDeps = {},
): Promise<Float32Array | null> {
  try {
    args.signal?.throwIfAborted();
    const privateModel = privatePageQueryModel(args.model);
    if (privateModel) {
      return await embedWithPrivateEndpoint({ ...args, model: privateModel }, deps);
    }
    if (args.model.includes("gemini-embedding-2")) {
      return await embedWithGemini(args, deps);
    }
    return null;
  } catch (error) {
    args.signal?.throwIfAborted();
    console.warn(`[page-query-embedder] model=${args.model} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The private route that embeds queries for page vectors stored under `model`, or null. The worker's private page
 * embedder records the served model id (`jinaai/...`), not the `llm://private/<alias>/<id>` URI, so a bare id resolves
 * to the first registered endpoint serving that id as an embedding model: one model id gives one vector space,
 * whichever endpoint serves it. A full private URI is used as given (the call is still checked against the registry).
 */
export function privatePageQueryModel(model: string): string | null {
  if (isPrivateModelUri(model)) return model;
  for (const endpoint of getPrivateModelEndpointRegistry().endpoints) {
    const served = endpoint.models.find((candidate) => candidate.capability === "embedding" && candidate.id === model);
    if (served) return formatPrivateModelUri({ alias: endpoint.alias, model: served.id });
  }
  return null;
}

/** Jina v5 page models expect the `"Query: "` task prefix on query text; other private embedders take it verbatim. */
function privateQueryPrefix(modelUri: string): string {
  return /jina-embeddings-v5/i.test(modelUri) ? JINA_QUERY_PREFIX : "";
}

async function embedWithPrivateEndpoint(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode; signal?: AbortSignal },
  deps: PageQueryEmbedderDeps,
): Promise<Float32Array | null> {
  const call = await authorizePrivateModelCall({
    privacyMode: args.privacyMode,
    modelUri: args.model,
    capability: "embedding",
    operation: "api.search.page-query-embedding",
    baseFetch: deps.fetchImpl,
  });
  // Query text is customer content: only to an endpoint that attests a US or EU region (fail closed).
  if (!attestedRegion(call.route.endpoint.attestation.region)) {
    console.warn(`[page-query-embedding] refused: private endpoint ${call.route.alias} attests region ${JSON.stringify(call.route.endpoint.attestation.region)}, not US or EU`);
    return null;
  }
  args.signal?.throwIfAborted();
  const startedAt = Date.now();
  const response = await call.fetch(`${call.baseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: call.model, input: `${privateQueryPrefix(args.model)}${args.query}` }),
    signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)]) : AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`private page-query embeddings ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } };
  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  const inputTokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0;
  const cost = call.cost({ inputTokens, durationMs: Date.now() - startedAt });
  args.journal.record({
    provider: call.provider,
    model: call.usageModel,
    metric: "page-query-embedding",
    inputTokens,
    costCents: cost.costCents,
    metadata: { ...cost.metadata, servedModel: call.model, embedding: true,
      modelConfig: { inputType: "query", queryPrefix: privateQueryPrefix(args.model) !== "", dimensions: embedding.length, normalize: true, timeoutMs: EMBED_TIMEOUT_MS } },
  });
  return l2Normalize(embedding);
}

/** No Gemini embedding endpoint states a US or EU hosting region (AI Studio may process anywhere). */
const GEMINI_QUERY_EMBEDDING_REGION_PROVEN = false;

async function embedWithGemini(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode; signal?: AbortSignal },
  deps: PageQueryEmbedderDeps,
): Promise<Float32Array | null> {
  // Hosted: only `standard` projects may send query text to Google, and never through Google AI Studio, which states no
  // US or EU hosting region (2026-11-17): Gemini query embedding is refused (fail closed).
  if (!privacyModeAllowsHosted(args.privacyMode)) return null;
  if (!GEMINI_QUERY_EMBEDDING_REGION_PROVEN) {
    console.warn("[page-query-embedding] refused: Gemini embedding is served only by Google AI Studio, which states no US or EU hosting region");
    return null;
  }
  const apiKey = deps.geminiApiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return null;
  const modelId = args.model.split("/").pop() ?? "gemini-embedding-2";
  // One batch request: its response carries usageMetadata (token counts) for text too.
  args.signal?.throwIfAborted();
  const response = await instrumentFetch("google", "embedding", deps.fetchImpl ?? fetch)(`${GEMINI_ENDPOINT}/${modelId}:batchEmbedContents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    // No task prefix: Gemini Embedding 2 query text is embedded as-is.
    body: JSON.stringify({ requests: [{ model: `models/${modelId}`, content: { parts: [{ text: args.query }] } }] }),
    signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(EMBED_TIMEOUT_MS)]) : AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`gemini batchEmbedContents ${response.status}`);
  const body = (await response.json()) as { embeddings?: Array<{ values?: number[] }>; usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number } };
  const values = body.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const reported = body.usageMetadata?.promptTokenCount ?? body.usageMetadata?.totalTokenCount;
  args.journal.record({
    provider: "google",
    model: modelId,
    metric: "page-query-embedding",
    // Actual provider usage; only a response without any usage falls back to an estimate, labelled as such.
    inputTokens: reported ?? estimateTextTokens(args.query),
    metadata: { embedding: true, usageSource: reported === undefined ? "estimated" : "provider",
      modelConfig: { inputType: "query", queryPrefix: false, dimensions: values.length, normalize: true, timeoutMs: EMBED_TIMEOUT_MS } },
  });
  return l2Normalize(values);
}
