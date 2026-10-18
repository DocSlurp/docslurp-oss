import { validateHostedEmbeddingVector } from "./embedding.js";

const models = new Map([["pplx-embed-v1-0.6b", 1024], ["pplx-embed-v1-4b", 2560]]);

/** Native endpoint returns signed INT8 vectors. Usage must settle before vector validation. */
export async function embedPerplexity(args: {
  model: string;
  dimensions?: number;
  apiKey: string;
  values: string[];
  normalize?: boolean;
  signal?: AbortSignal;
  onUsage: (tokens: number) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}): Promise<{ embeddings: number[][]; usage: { tokens: number } }> {
  const dimensions = models.get(args.model);
  if (!dimensions) throw new Error("Unregistered native Perplexity embedding model");
  if (args.dimensions !== undefined && args.dimensions !== dimensions) throw new Error("Native Perplexity embedding dimensions do not match the registered model");
  if (!args.apiKey) throw new Error("PERPLEXITY_API_KEY is required for native Perplexity embeddings");
  const encoder = new TextEncoder();
  if (!args.values.length || args.values.length > 128 || args.values.some(value => !value.trim())
    || args.values.reduce((sum, value) => sum + encoder.encode(value).length + 8, 0) > 120_000) {
    throw new Error("Native Perplexity embedding inputs exceed the request budget");
  }
  let response: Response;
  try {
    response = await (args.fetch ?? globalThis.fetch)("https://api.perplexity.ai/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: args.model, input: args.values, encoding_format: "base64_int8" }),
      signal: args.signal,
    });
  } catch (cause) {
    if (args.signal?.aborted) throw cause;
    throw Object.assign(new Error("Native Perplexity embedding transport failed", { cause }), { isRetryable: true });
  }
  type EmbeddingResponse = {
    usage?: { prompt_tokens?: number; input_tokens?: number };
    data?: Array<{ index: number; embedding: string }>;
  };
  let body: EmbeddingResponse;
  try {
    body = await response.json() as EmbeddingResponse;
  } catch (cause) {
    if (args.signal?.aborted) throw cause;
    throw Object.assign(new Error("Native Perplexity embedding response could not be decoded", { cause }), {
      statusCode: response.status,
      isRetryable: response.ok || response.status === 429 || response.status >= 500,
      responseHeaders: { "retry-after": response.headers.get("retry-after") ?? "" },
    });
  }
  const tokens = body.usage?.prompt_tokens ?? body.usage?.input_tokens;
  if (Number.isSafeInteger(tokens) && tokens! > 0) await args.onUsage(tokens!);
  if (!response.ok) {
    throw Object.assign(new Error(`Native Perplexity embedding request failed (HTTP ${response.status})`), {
      statusCode: response.status,
      responseHeaders: { "retry-after": response.headers.get("retry-after") ?? "" },
    });
  }
  if (!Number.isSafeInteger(tokens) || !(tokens! > 0)) throw new Error("Native Perplexity embedding response omitted actual usage");
  if (!Array.isArray(body.data) || body.data.length !== args.values.length) throw new Error("Native Perplexity embedding response omitted vectors");
  const embeddings = body.data.slice().sort((a, b) => a.index - b.index).map((item, index) => {
    if (item.index !== index || typeof item.embedding !== "string" || item.embedding.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.embedding)) throw new Error("Native Perplexity embedding returned invalid encoded vectors");
    const decoded = atob(item.embedding);
    const vector = Array.from(decoded, character => {
      const byte = character.charCodeAt(0);
      return byte > 127 ? byte - 256 : byte;
    });
    return validateHostedEmbeddingVector(vector, dimensions, args.normalize);
  });
  return { embeddings, usage: { tokens: tokens! } };
}
