import { expect, it, vi } from "vitest";

const embedConfiguredText = vi.hoisted(() => vi.fn());
vi.mock("../lib/ai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai.js")>()),
  embedConfiguredText,
}));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getProjectAccess: vi.fn() }));

import { defaultEmbeddingConfig } from "@docslurp/shared";

it("tries the configured provider URIs in order after a retryable primary failure", async () => {
  const { APICallError } = await import("ai");
  const { embedQuery, queryEmbeddingPool } = await import("../search/session-planner.js");
  const embedding = { ...defaultEmbeddingConfig, modelUri: "llm://deepinfra/BAAI/bge-m3", dimensions: undefined };
  const usage = { record: vi.fn(), recordDiagnostic: vi.fn() } as unknown as Parameters<typeof embedQuery>[2];
  const failure = new APICallError({ message: "unavailable", url: "https://example.invalid", requestBodyValues: {}, statusCode: 503 });
  const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
  vi.stubEnv("DEEPINFRA_API_KEY", "test");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter");
  vi.stubEnv("SEARCH_EMBEDDING", "llm://openrouter.ai/baai/bge-m3,llm://deepinfra.com/BAAI/bge-m3");
  try {
    embedConfiguredText.mockReset().mockRejectedValueOnce(failure).mockResolvedValueOnce({ embedding: vector, usage: { inputTokens: 1 } });
    await expect(embedQuery("test query", embedding, usage, "standard")).resolves.toEqual(vector);
    expect(embedConfiguredText.mock.calls.map(([args]) => args.provider)).toEqual(["openrouter", "deepinfra"]);
    expect(embedConfiguredText.mock.calls[1]?.[0]).toMatchObject({ modelUri: "llm://deepinfra/BAAI/bge-m3", apiKey: "test" });
    expect(queryEmbeddingPool({ ...embedding, normalize: false }, "standard")).toEqual([]);
    expect(queryEmbeddingPool(embedding, "strict-privacy")).toEqual([]);
    const local = { ...embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/bge-m3?pooling=cls" };
    expect(queryEmbeddingPool(local, "standard")).toEqual([]);
    embedConfiguredText.mockReset().mockResolvedValueOnce({ embedding: vector, usage: { inputTokens: 1 } });
    await expect(embedQuery("local query", local, usage, "standard")).resolves.toEqual(vector);
    expect(embedConfiguredText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "transformers.js", apiKey: undefined }));
    embedConfiguredText.mockReset().mockRejectedValueOnce(new Error("invalid response"));
    await expect(embedQuery("test query", embedding, usage, "standard")).rejects.toThrow("invalid response");
    expect(embedConfiguredText).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
