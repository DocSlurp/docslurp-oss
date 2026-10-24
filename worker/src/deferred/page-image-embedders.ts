import { instrumentFetch } from "@docslurp/shared/observability";
import {
  authorizePrivateModelCall,
  getPrivateModelEndpointRegistry,
  lookupPrivateModelRoute,
  privateEndpointCallCost,
  privacyModeAllowsHosted,
  formatPrivateModelUri,
  findJinaNanoUri,
  GEMINI_IMAGE_USD_PER_MTOK,
  JINA_NANO_MODEL_SUFFIX,
  PAGE_EMBED_ESTIMATED_PAGE_TOKENS,
  type PrivacyMode,
} from "@docslurp/shared";

/** Embeds page images (and optionally query text) into one vector space for Visual Pages. */
export interface PageImageEmbedder {
  /** Usage-ledger provider label. */
  readonly provider: string;
  readonly model: string;
  /** Rough per-page cost used to refuse a window that would exceed the cost cap before embedding it. */
  readonly estimatedCostCentsPerPage?: number;
  readonly dims: number;
  embedImages(
    images: Array<{ jpeg: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<{ vectors: Float32Array[]; inputTokens: number; costCents: number }>;
  embedQueryText?(text: string): Promise<Float32Array>;
}

export const GEMINI_PAGE_EMBED_MODEL = "gemini-embedding-2";
/**
 * Jina v5 omni retrieval prompts (from the model's config_sentence_transformers.json): documents
 * (here, page images) are embedded as "Document: " + image, queries as "Query: " + text. The vLLM
 * instance serving the model must run with `--hf-overrides '{"task":"retrieval"}'`.
 * Gemini needs no prompt (any task prefix hurts image retrieval).
 */
export const JINA_DOCUMENT_PROMPT = "Document: ";
export const JINA_QUERY_PROMPT = "Query: ";
export { JINA_NANO_MODEL_SUFFIX };
export { GEMINI_IMAGE_USD_PER_MTOK };
const GEMINI_BATCH = 8;
const PRIVATE_BATCH = 8;
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function toFloat32(values: unknown, label: string): Float32Array {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} returned an empty embedding`);
  return Float32Array.from(values as number[]);
}

export function createGeminiPageEmbedder(args: { apiKey: string; dims?: 3072; fetchImpl?: typeof fetch }): PageImageEmbedder {
  const dims = args.dims ?? 3072;
  const doFetch = instrumentFetch("google", "embedding", args.fetchImpl ?? fetch);
  const url = `${GEMINI_ENDPOINT}/models/${GEMINI_PAGE_EMBED_MODEL}:batchEmbedContents?key=${encodeURIComponent(args.apiKey)}`;

  async function post(parts: Array<Record<string, unknown>>, signal?: AbortSignal) {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: parts.map((part) => ({
          model: `models/${GEMINI_PAGE_EMBED_MODEL}`,
          content: { parts: [part] },
          ...(dims !== 3072 ? { outputDimensionality: dims } : {}),
        })),
      }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Gemini embedding request failed (${response.status}): ${detail}`);
    }
    const json = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
      usageMetadata?: { promptTokenCount?: number };
    };
    if (!json.embeddings || json.embeddings.length !== parts.length) {
      throw new Error(`Gemini embedding response returned ${json.embeddings?.length ?? 0} vectors for ${parts.length} inputs`);
    }
    return {
      vectors: json.embeddings.map((e) => toFloat32(e.values, "Gemini")),
      tokens: json.usageMetadata?.promptTokenCount ?? 0,
    };
  }

  return {
    provider: "google",
    model: GEMINI_PAGE_EMBED_MODEL,
    dims,
    estimatedCostCentsPerPage: (PAGE_EMBED_ESTIMATED_PAGE_TOKENS * GEMINI_IMAGE_USD_PER_MTOK) / 1e6 * 100,
    async embedImages(images, signal) {
      const vectors: Float32Array[] = [];
      let inputTokens = 0;
      for (let i = 0; i < images.length; i += GEMINI_BATCH) {
        const batch = images.slice(i, i + GEMINI_BATCH);
        const result = await post(
          batch.map((image) => ({ inline_data: { mime_type: "image/jpeg", data: toBase64(image.jpeg) } })),
          signal,
        );
        vectors.push(...result.vectors);
        inputTokens += result.tokens;
      }
      return { vectors, inputTokens, costCents: (inputTokens * GEMINI_IMAGE_USD_PER_MTOK) / 1e6 * 100 };
    },
    // Benchmarks: any task prefix hurts image retrieval, so the query is sent verbatim.
    async embedQueryText(text) {
      const { vectors } = await post([{ text }]);
      return vectors[0]!;
    },
  };
}

export function createPrivateEndpointPageEmbedder(args: { modelUri: string; privacyMode?: PrivacyMode | string | null }): PageImageEmbedder {
  const lookup = lookupPrivateModelRoute({ ref: args.modelUri, capability: "embedding" });
  if (!lookup.ok) throw new Error(`Private page embedder ${args.modelUri} is not usable: ${lookup.reason}`);
  const dims = lookup.route.model.dimensions ?? 768;

  async function call(input: unknown[], signal?: AbortSignal) {
    const privateCall = await authorizePrivateModelCall({
      privacyMode: args.privacyMode,
      modelUri: args.modelUri,
      capability: "embedding",
      operation: "worker.page-image-embedding",
    });
    const startedAt = Date.now();
    const response = await privateCall.fetch(`${privateCall.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: privateCall.model, input }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Private page embedding request failed (${response.status}): ${detail}`);
    }
    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (!json.data || json.data.length !== input.length) {
      throw new Error(`Private embedding response returned ${json.data?.length ?? 0} vectors for ${input.length} inputs`);
    }
    const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const tokens = json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0;
    const cost = privateCall.cost({ inputTokens: tokens, durationMs: Date.now() - startedAt });
    return { vectors: ordered.map((d) => toFloat32(d.embedding, "Private endpoint")), tokens, costCents: cost.costCents };
  }

  return {
    provider: "private",
    model: lookup.route.model.id,
    dims,
    estimatedCostCentsPerPage: privateEndpointCallCost({ route: lookup.route, inputTokens: PAGE_EMBED_ESTIMATED_PAGE_TOKENS, durationMs: 0 }).costCents,
    async embedImages(images, signal) {
      const vectors: Float32Array[] = [];
      let inputTokens = 0;
      let costCents = 0;
      for (let i = 0; i < images.length; i += PRIVATE_BATCH) {
        const batch = images.slice(i, i + PRIVATE_BATCH);
        const result = await call(
          batch.map((image) => ({
            content: [
              { type: "text", text: JINA_DOCUMENT_PROMPT },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${toBase64(image.jpeg)}` } },
            ],
          })),
          signal,
        );
        vectors.push(...result.vectors);
        inputTokens += result.tokens;
        costCents += result.costCents;
      }
      return { vectors, inputTokens, costCents };
    },
    async embedQueryText(text) {
      const { vectors } = await call([`${JINA_QUERY_PROMPT}${text}`]);
      return vectors[0]!;
    },
  };
}

/**
 * `auto` prefers a registered Jina nano private endpoint, then Gemini (when a key is set and the
 * privacy mode allows hosted providers). Returns null when nothing is usable.
 */
export function resolvePageImageEmbedder(args: {
  route: "auto" | "jina-private" | "gemini";
  privacyMode: PrivacyMode | string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): PageImageEmbedder | null {
  const env = args.env ?? process.env;
  const jinaUri = args.route === "gemini" ? null : findJinaNanoUri();
  if (jinaUri) return createPrivateEndpointPageEmbedder({ modelUri: jinaUri, privacyMode: args.privacyMode });
  if (args.route === "jina-private") return null;
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (apiKey && privacyModeAllowsHosted(args.privacyMode)) return createGeminiPageEmbedder({ apiKey });
  return null;
}
