import { instrumentFetch } from "@docslurp/shared/observability";
import {
  authorizePrivateModelCall,
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
 * Embed a text query into the same space as stored page-image vectors. The
 * model must match `document_page_vectors.model`: Gemini Embedding 2 takes the
 * raw text (no task prefix), the Jina v5 omni nano private endpoint takes
 * `"Query: " + text`. Any failure or unsupported model returns null so the
 * caller degrades to text-only search instead of blocking.
 */
export async function embedPageQuery(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode },
  deps: PageQueryEmbedderDeps = {},
): Promise<Float32Array | null> {
  try {
    if (args.model.endsWith("jina-embeddings-v5-omni-nano") && isPrivateModelUri(args.model)) {
      return await embedWithJina(args, deps);
    }
    if (args.model.includes("gemini-embedding-2")) {
      return await embedWithGemini(args, deps);
    }
    return null;
  } catch (error) {
    console.warn(`[page-query-embedder] model=${args.model} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function embedWithJina(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode },
  deps: PageQueryEmbedderDeps,
): Promise<Float32Array | null> {
  const call = await authorizePrivateModelCall({
    privacyMode: args.privacyMode,
    modelUri: args.model,
    capability: "embedding",
    operation: "api.search.page-query-embedding",
    baseFetch: deps.fetchImpl,
  });
  const startedAt = Date.now();
  const response = await call.fetch(`${call.baseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: call.model, input: `${JINA_QUERY_PREFIX}${args.query}` }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`jina embeddings ${response.status}`);
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
    metadata: { ...cost.metadata, servedModel: call.model, embedding: true },
  });
  return l2Normalize(embedding);
}

async function embedWithGemini(
  args: { model: string; query: string; journal: UsageRecorder; privacyMode: PrivacyMode },
  deps: PageQueryEmbedderDeps,
): Promise<Float32Array | null> {
  // Hosted: only `standard` workspaces may send query text to Google.
  if (!privacyModeAllowsHosted(args.privacyMode)) return null;
  const apiKey = deps.geminiApiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return null;
  const modelId = args.model.split("/").pop() ?? "gemini-embedding-2";
  // One batch request: its response carries usageMetadata (token counts) for text too.
  const response = await instrumentFetch("google", "embedding", deps.fetchImpl ?? fetch)(`${GEMINI_ENDPOINT}/${modelId}:batchEmbedContents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    // No task prefix: Gemini Embedding 2 query text is embedded as-is.
    body: JSON.stringify({ requests: [{ model: `models/${modelId}`, content: { parts: [{ text: args.query }] } }] }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
    inputTokens: reported ?? Math.ceil(args.query.length / 4),
    metadata: { embedding: true, usageSource: reported === undefined ? "estimated" : "provider" },
  });
  return l2Normalize(values);
}
