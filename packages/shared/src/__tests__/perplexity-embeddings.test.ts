import { describe, expect, it, vi } from "vitest";
import { embedPerplexity } from "../perplexity-embeddings.js";
import { embeddingConfigSchema, resolveEmbeddingRoute } from "../embedding.js";

const encoded = () => Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 2 ? 255 : 1)).toString("base64");
const response = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status, headers: { "retry-after": "3" } }));

describe("native Perplexity embeddings", () => {
  it("resolves an explicit native route while preserving full dimensions", () => {
    const config = embeddingConfigSchema.parse({ modelUri: "llm://perplexity/pplx-embed-v1-0.6b", target: "hosted" });
    expect(resolveEmbeddingRoute(config)).toMatchObject({ provider: "perplexity", model: "pplx-embed-v1-0.6b", dimensions: 1024, runtime: "remote" });
    expect(() => embeddingConfigSchema.parse({ ...config, dimensions: 512 })).toThrow();
  });

  it("decodes signed INT8, restores input order and normalizes after metering actual tokens", async () => {
    const order: string[] = [];
    const fetch = response({ usage: { prompt_tokens: 73 }, data: [{ index: 1, embedding: encoded() }, { index: 0, embedding: encoded() }] });
    const result = await embedPerplexity({ model: "pplx-embed-v1-0.6b", apiKey: "test", values: ["first", "second"], fetch,
      onUsage: tokens => { order.push(`usage:${tokens}`); } });
    expect(order).toEqual(["usage:73"]);
    expect(result.usage.tokens).toBe(73);
    expect(result.embeddings[0]!.slice(0, 2)).toEqual([1 / 32, -1 / 32]);
    expect(Math.hypot(...result.embeddings[0]!)).toBeCloseTo(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.perplexity.ai/v1/embeddings");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ model: "pplx-embed-v1-0.6b", input: ["first", "second"], encoding_format: "base64_int8" });
  });

  it.each([
    { data: [] },
    { data: [{ index: 0, embedding: "invalid" }] },
    { data: [{ index: 0, embedding: Buffer.alloc(1024).toString("base64") }] },
    { data: [{ index: 1, embedding: encoded() }] },
  ])("meters malformed paid responses before rejecting vectors", async ({ data }) => {
    const onUsage = vi.fn();
    await expect(embedPerplexity({ model: "pplx-embed-v1-0.6b", apiKey: "test", values: ["first"], onUsage,
      fetch: response({ usage: { prompt_tokens: 19 }, data }) })).rejects.toThrow();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(19);
  });

  it("exposes status and retry delay without reflecting provider response content", async () => {
    const onUsage = vi.fn();
    await expect(embedPerplexity({ model: "pplx-embed-v1-0.6b", apiKey: "test", values: ["first"], onUsage,
      fetch: response({ error: "private response" }, 429) })).rejects.toMatchObject({ statusCode: 429, responseHeaders: { "retry-after": "3" } });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("preserves throttling metadata for a non-JSON error body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("upstream unavailable", { status: 429, headers: { "retry-after": "7" } }));
    await expect(embedPerplexity({ model: "pplx-embed-v1-0.6b", apiKey: "test", values: ["first"], onUsage: vi.fn(), fetch }))
      .rejects.toMatchObject({ statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "7" } });
  });

  it("rejects unsupported spaces and oversized inputs before making a paid request", async () => {
    const fetch = response({});
    for (const override of [{ dimensions: 512 }, { model: "unregistered" }, { values: ["x".repeat(120_001)] }, { values: [] }]) {
      await expect(embedPerplexity({ model: "pplx-embed-v1-0.6b", apiKey: "test", values: ["first"], onUsage: vi.fn(), fetch, ...override })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
