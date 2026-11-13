import type { Attributes } from "@opentelemetry/api";

/** Request bodies above this size (inline images, long prompts) are not parsed for span attributes. */
const MAX_PARSED_REQUEST_BYTES = 1_000_000;
/** Response bytes inspected for the upstream provider, served model and generation id. */
const HEAD_LIMIT = 16_384;
/** Trailing response bytes kept to read the final usage block. */
const TAIL_LIMIT = 4_096;

const stringField = (text: string, key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]{1,200})"`).exec(text)?.[1];
const numberField = (text: string, key: string) => {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?[0-9][0-9.eE+-]*)`).exec(text)?.[1];
  const value = match === undefined ? undefined : Number(match);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
};

/** Model and routing preferences of an OpenRouter generation request, for its dependency span. */
export function llmRequestAttributes(body: unknown): Attributes {
  if (typeof body !== "string" || body.length > MAX_PARSED_REQUEST_BYTES) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const provider = record.provider && typeof record.provider === "object" ? record.provider as Record<string, unknown> : undefined;
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item) => typeof item === "string").join(",") : undefined;
  const attributes: Attributes = {
    "gen_ai.system": "openrouter",
    "gen_ai.request.model": typeof record.model === "string" ? record.model : undefined,
    "gen_ai.request.max_tokens": typeof record.max_tokens === "number" ? record.max_tokens : undefined,
    "docslurp.llm.stream": record.stream === true,
    "docslurp.llm.route.sort": typeof provider?.sort === "string" ? provider.sort : undefined,
    "docslurp.llm.route.quantizations": list(provider?.quantizations),
    "docslurp.llm.route.only": list(provider?.only),
  };
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as Attributes;
}

/**
 * Reads the upstream provider, served model, generation id and token usage
 * from an OpenRouter response (JSON or SSE) as it streams past, with bounded
 * memory: a head prefix until the identity fields are found, and a rolling
 * tail for the final usage block.
 */
export class LlmResponseScanner {
  private head = "";
  private tail = "";
  private headDone = false;

  push(fragment: string): void {
    if (!this.headDone) {
      this.head += fragment.slice(0, HEAD_LIMIT - this.head.length);
      if (this.head.length >= HEAD_LIMIT || stringField(this.head, "provider")) this.headDone = true;
    }
    this.tail = (this.tail + fragment).slice(-TAIL_LIMIT);
  }

  /** Identity attributes, available as soon as the first chunk names the provider. */
  identity(): Attributes {
    const attributes: Attributes = {};
    const provider = stringField(this.head, "provider");
    const model = stringField(this.head, "model");
    const id = stringField(this.head, "id");
    if (provider) attributes["docslurp.llm.upstream_provider"] = provider;
    if (model) attributes["gen_ai.response.model"] = model;
    if (id) attributes["gen_ai.response.id"] = id;
    return attributes;
  }

  /** Identity plus usage, read once the body is complete. */
  final(): Attributes {
    const attributes = this.identity();
    const usage = this.tail.lastIndexOf('"usage"') >= 0 ? this.tail.slice(this.tail.lastIndexOf('"usage"')) : "";
    const input = numberField(usage, "prompt_tokens");
    const output = numberField(usage, "completion_tokens");
    const cost = numberField(usage, "cost");
    if (input !== undefined) attributes["gen_ai.usage.input_tokens"] = input;
    if (output !== undefined) attributes["gen_ai.usage.output_tokens"] = output;
    if (cost !== undefined) attributes["docslurp.llm.cost_usd"] = cost;
    // Prompt-cache reads and writes (prompt_tokens_details / input_tokens_details), which SigNoz prices separately.
    const cacheRead = numberField(usage, "cached_tokens");
    const cacheWrite = numberField(usage, "cache_write_tokens");
    if (cacheRead !== undefined && cacheRead > 0) attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
    if (cacheWrite !== undefined && cacheWrite > 0) attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
    if (!attributes["docslurp.llm.upstream_provider"]) {
      const provider = stringField(this.tail, "provider");
      if (provider) attributes["docslurp.llm.upstream_provider"] = provider;
    }
    return attributes;
  }
}
