import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fromEnv } from "../config.js";
import { createConcurrencyLimiter } from "../lib/bounded-concurrency.js";
import type { EmbeddingProfile } from "../models.js";
import {
  contextualizeChunksForEmbedding,
  embedTextChunks,
  remoteEmbeddingProviderOptions,
} from "../stages/embedding-runtime.js";
import {
  MemoryProviderRateStore,
  ProviderRateLimiter,
  readProviderRateLimitConfig,
  setProviderRateLimiterForTests,
} from "../lib/provider-rate-limit.js";

const transformersMock = vi.hoisted(() => ({
  env: { cacheDir: "read-only-package-cache" },
  pipeline: vi.fn(async () => async (input: string | string[]) => {
    const texts = Array.isArray(input) ? input : [input];
    return {
      tolist: () =>
        texts.map((text) =>
          Array.from({ length: 8 }, (_, index) =>
            (text.charCodeAt(index % text.length) || index) / 255,
          ),
        ),
    };
  }),
}));

const aiMock = vi.hoisted(() => ({
  embedMany: vi.fn(async (args: { values: string[] }) => ({
    embeddings: args.values.map((value) =>
      Array.from({ length: 8 }, (_, index) => value.length + index),
    ),
    usage: { tokens: args.values.length * 10 },
  })),
}));
const openAiMock = vi.hoisted(() => ({
  createOpenAI: vi.fn(() => ({
    embedding: (model: string) => ({ model }),
  })),
}));

vi.mock("@huggingface/transformers", () => transformersMock);
vi.mock("ai", () => aiMock);
const textMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: textMock }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: openAiMock.createOpenAI,
  openai: {
    embedding: (model: string) => ({ model }),
  },
}));

const originalDtype = process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE;

describe("embedTextChunks", () => {
  afterEach(() => {
    transformersMock.pipeline.mockClear();
    aiMock.embedMany.mockClear();
    openAiMock.createOpenAI.mockClear();

    if (originalDtype === undefined) {
      delete process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE;
    } else {
      process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE = originalDtype;
    }
  });

  it("uses the cached JS transformers pipeline for local embeddings", async () => {
    const profile: EmbeddingProfile = {
      profile: "good-fast-local",
      target: "local",
      modelUri: "llm://transformers.js/Xenova/bge-m3",
      runtime: "local",
      provider: "transformers.js",
      model: "Xenova/bge-m3",
      baseUrl: null,
      dimensions: 8,
      task: "document",
      normalize: true,
      batchSize: 2,
      lateChunking: false,
      lateChunkingWindow: 2,
    };

    const first = await embedTextChunks({ privacyMode: "standard",
      chunks: ["alpha chunk", "beta chunk"],
      profile,
      config: fromEnv(),
    });
    const second = await embedTextChunks({ privacyMode: "standard",
      chunks: ["gamma chunk"],
      profile,
      config: fromEnv(),
    });

    expect(transformersMock.env.cacheDir).toBe(join(homedir(), ".cache", "docslurp", "transformers"));
    expect(transformersMock.pipeline).toHaveBeenCalledTimes(1);
    expect(transformersMock.pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/bge-m3",
      { dtype: "q8", cache_dir: join(homedir(), ".cache", "docslurp", "transformers") },
    );

    expect(first.vectors).toHaveLength(2);
    expect(first.vectors[0]).toHaveLength(8);
    expect(first.usage.runtime).toBe("local");
    expect(first.usage.provider).toBe("transformers.js");
    expect(first.usage.cache_hit).toBe(false);
    expect(first.totalTokens).toBeGreaterThan(0);

    expect(second.vectors).toHaveLength(1);
    expect(second.vectors[0]).toHaveLength(8);
    expect(second.usage.cache_hit).toBe(true);
  });

  it("batches remote embeddings with the tuned profile batch size", async () => {
    const profile: EmbeddingProfile = {
      profile: "cheapest-hosted",
      target: "hosted",
      modelUri: "llm://openai/text-embedding-3-small",
      runtime: "remote",
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: null,
      dimensions: 8,
      task: "document",
      normalize: true,
      batchSize: 2,
      lateChunking: false,
      lateChunkingWindow: 2,
      supportsCustomDimensions: true,
    };

    const persisted: Array<{ inputTokens: number; chunks: number; requests: number }> = [];
    const result = await embedTextChunks({ privacyMode: "standard",
      onRemoteUsage: async (usage) => { persisted.push({ ...usage, requests: aiMock.embedMany.mock.calls.length }); },
      chunks: ["a", "bb", "ccc", "dddd", "eeeee"],
      profile,
      config: fromEnv(),
    });

    expect(aiMock.embedMany).toHaveBeenCalledTimes(3);
    expect(aiMock.embedMany.mock.calls.map(([args]) => args.values)).toEqual([
      ["a", "bb"],
      ["ccc", "dddd"],
      ["eeeee"],
    ]);
    expect(result.vectors).toHaveLength(5);
    expect(result.totalTokens).toBe(50);
    expect(persisted).toEqual([
      { inputTokens: 20, chunks: 2, requests: 1 },
      { inputTokens: 20, chunks: 2, requests: 2 },
      { inputTokens: 10, chunks: 1, requests: 3 },
    ]);
    aiMock.embedMany.mockClear();
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["a", "b", "c"], profile, config: fromEnv(),
      onRemoteUsage: async () => { throw new Error("ledger unavailable"); },
    })).rejects.toThrow("ledger unavailable");
    expect(aiMock.embedMany).toHaveBeenCalledTimes(1);
    expect(result.usage).toMatchObject({
      runtime: "remote",
      provider: "openai",
      batchSize: 2,
      tokens: 50,
    });
  });

  it("overlaps remote batches up to batchConcurrency, keeps vector order and stops after a refused usage write", async () => {
    const profile: EmbeddingProfile = {
      profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small", runtime: "remote",
      provider: "openai", model: "text-embedding-3-small", baseUrl: null, dimensions: 8, task: "document", normalize: false,
      batchSize: 1, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true,
    };
    let inFlight = 0;
    let peak = 0;
    const slowEmbed = async (args: { values: string[] }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later batches finish first, so completion order differs from input order.
      await new Promise((resolve) => setTimeout(resolve, 40 - args.values[0]!.length * 5));
      inFlight--;
      return { embeddings: args.values.map((value) => Array.from({ length: 8 }, () => value.length)), usage: { tokens: 10 } };
    };
    aiMock.embedMany.mockImplementation(slowEmbed as never);
    try {
      const chunks = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
      const usageCalls: number[] = [];
      const result = await embedTextChunks({ privacyMode: "standard", chunks, profile, config: fromEnv(), batchConcurrency: 3,
        onRemoteUsage: async () => { usageCalls.push(inFlight); } });
      expect(peak).toBe(3);
      expect(result.vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result.totalTokens).toBe(60);
      expect(usageCalls).toHaveLength(6);
      expect((result.usage.batches as Array<{ batchIndex: number }>).map((batch) => batch.batchIndex)).toEqual([1, 2, 3, 4, 5, 6]);

      aiMock.embedMany.mockClear();
      let recorded = 0;
      await expect(embedTextChunks({ privacyMode: "standard", chunks, profile, config: fromEnv(), batchConcurrency: 2,
        onRemoteUsage: async () => { recorded++; throw new Error("cost cap reached"); } })).rejects.toThrow("cost cap reached");
      // The two batches already in flight are paid for and recorded; no third batch starts.
      expect(aiMock.embedMany).toHaveBeenCalledTimes(2);
      expect(recorded).toBe(2);
    } finally {
      aiMock.embedMany.mockReset();
      aiMock.embedMany.mockImplementation((async (args: { values: string[] }) => ({
        embeddings: args.values.map((value) => Array.from({ length: 8 }, (_, index) => value.length + index)),
        usage: { tokens: args.values.length * 10 },
      })) as never);
    }
  });

  it("runs beforeBatch inside the shared slot, so queued batches of sibling callers are never sent after a stop", async () => {
    const profile: EmbeddingProfile = {
      profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small", runtime: "remote",
      provider: "openai", model: "text-embedding-3-small", baseUrl: null, dimensions: 8, task: "document", normalize: false,
      batchSize: 1, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true,
    };
    aiMock.embedMany.mockImplementation((async (args: { values: string[] }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { embeddings: args.values.map(() => Array.from({ length: 8 }, () => 1)), usage: { tokens: 10 } };
    }) as never);
    try {
      // Two "windows" share a 2-slot pool, each with 4 batches queued on it.
      const limiter = createConcurrencyLimiter(2);
      let capped = false;
      let recorded = 0;
      const call = (prefix: string) => embedTextChunks({
        privacyMode: "standard", chunks: [1, 2, 3, 4].map((n) => `${prefix}${n}`), profile, config: fromEnv(),
        batchConcurrency: 4, batchLimiter: limiter,
        beforeBatch: () => { if (capped) throw new Error("cost cap reached before sending"); },
        onRemoteUsage: async () => { recorded++; capped = true; },
      });
      const results = await Promise.allSettled([call("a"), call("b")]);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      // Only the two requests already holding slots were sent, and both were billed.
      expect(aiMock.embedMany).toHaveBeenCalledTimes(2);
      expect(recorded).toBe(2);
    } finally {
      aiMock.embedMany.mockReset();
      aiMock.embedMany.mockImplementation((async (args: { values: string[] }) => ({
        embeddings: args.values.map((value) => Array.from({ length: 8 }, (_, index) => value.length + index)),
        usage: { tokens: args.values.length * 10 },
      })) as never);
    }
  });

  it("retries a 429 under the fleet limiter instead of the AI SDK and feeds it to AIMD", async () => {
    const store = new MemoryProviderRateStore();
    const limiter = new ProviderRateLimiter(store, readProviderRateLimitConfig({ AI_RATE_LIMITS: "openai:text-embedding-*=tpm:6000000" }));
    setProviderRateLimiterForTests(limiter);
    const throttled = Object.assign(new Error("Rate limit reached"), {
      statusCode: 429, responseBody: "rate_limit_exceeded", responseHeaders: { "retry-after-ms": "5" }, isRetryable: true,
    });
    aiMock.embedMany.mockRejectedValueOnce(throttled);
    try {
      const result = await embedTextChunks({ privacyMode: "standard",
        chunks: ["alpha", "beta"],
        profile: {
          profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small", runtime: "remote", provider: "openai", model: "text-embedding-3-small",
          baseUrl: null, dimensions: 8, task: "document", normalize: true, batchSize: 8, lateChunking: false, lateChunkingWindow: 2,
          supportsCustomDimensions: true,
        },
        config: fromEnv(),
      });
      expect(result.vectors).toHaveLength(2);
      expect(aiMock.embedMany).toHaveBeenCalledTimes(2);
      expect(aiMock.embedMany.mock.calls.every(([args]) => (args as { maxRetries?: number }).maxRetries === 0)).toBe(true);
      const probe = await store.consume({ metaKey: "ai-rl:{openai:text-embedding-3-small}:meta", activeOrgsKey: "probe", orgId: null,
        now: Date.now(), maxReserveMs: 0, burstMs: 1_000, orgShareFactor: 1, activeOrgWindowMs: 1_000, recoverPerMs: 0, buckets: [] });
      expect(probe.factor).toBeLessThan(1);
    } finally {
      setProviderRateLimiterForTests(null);
    }
  });

  it("routes local-service URIs through their OpenAI-compatible endpoint", async () => {
    const profile: EmbeddingProfile = {
      profile: "good-fast-local",
      target: "local",
      modelUri: "llm://ollama/nomic-embed-text",
      runtime: "remote",
      provider: "ollama",
      model: "nomic-embed-text",
      baseUrl: "http://127.0.0.1:11434/v1",
      dimensions: 8,
      task: "document",
      normalize: true,
      batchSize: 2,
      lateChunking: false,
      lateChunkingWindow: 2,
    };

    await embedTextChunks({ privacyMode: "standard",
      chunks: ["local service"],
      profile,
      config: fromEnv(),
    });

    expect(transformersMock.pipeline).not.toHaveBeenCalled();
    expect(openAiMock.createOpenAI).toHaveBeenCalledWith({
      apiKey: "local",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    expect(aiMock.embedMany).toHaveBeenCalledOnce();
    expect(aiMock.embedMany.mock.calls[0]?.[0]).toMatchObject({ providerOptions: undefined });
  });

  it("requests explicit dimensions from vLLM and stores unit-length vectors of that size", async () => {
    const profile: EmbeddingProfile = {
      profile: "good-fast-local",
      target: "local",
      modelUri: "llm://vllm/nomic-embed-text-v1.5?baseUrl=http://127.0.0.1:18100/v1",
      runtime: "remote",
      provider: "vllm",
      model: "nomic-embed-text-v1.5",
      baseUrl: "http://127.0.0.1:18100/v1",
      dimensions: 4,
      requestedDimensions: 4,
      task: "document",
      normalize: true,
      batchSize: 8,
      lateChunking: false,
      lateChunkingWindow: 2,
      supportsCustomDimensions: true,
    };

    // The mock server ignores `dimensions` and returns 8 values, forcing a client-side cut.
    const result = await embedTextChunks({ privacyMode: "standard", chunks: ["matryoshka"], profile, config: fromEnv() });

    expect(aiMock.embedMany.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: { openai: { dimensions: 4 } },
    });
    expect(result.vectors[0]).toHaveLength(4);
    expect(Math.hypot(...result.vectors[0]!)).toBeCloseTo(1, 12);
    expect(remoteEmbeddingProviderOptions({ ...profile, requestedDimensions: undefined, dimensions: 1536 })).toBeUndefined();
  });

  it("renormalizes local transformers.js vectors after a Matryoshka cut", async () => {
    const result = await embedTextChunks({ privacyMode: "standard",
      chunks: ["local matryoshka"],
      profile: {
        profile: "good-fast-local", target: "local", modelUri: "llm://transformers.js/Xenova/bge-m3", runtime: "local",
        provider: "transformers.js", model: "Xenova/bge-m3", baseUrl: null, dimensions: 3, requestedDimensions: 3,
        task: "document", normalize: true, batchSize: 2, lateChunking: false, lateChunkingWindow: 2,
      },
      config: fromEnv(),
    });
    expect(result.vectors[0]).toHaveLength(3);
    expect(Math.hypot(...result.vectors[0]!)).toBeCloseTo(1, 12);
    expect(aiMock.embedMany).not.toHaveBeenCalled();
  });
});

describe("contextualizeChunksForEmbedding", () => {
  it("sends the configured task model and attributes usage to that model", async () => {
    textMock.mockClear();
    textMock.mockResolvedValue({ text: "A short document summary.", usage: { inputTokens: 10, outputTokens: 5 } });
    const result = await contextualizeChunksForEmbedding({ privacyMode: "standard",
      documentTitle: "document", documentText: "Some document content", chunks: [{ text: "Some content" }],
      config: { ...fromEnv(), openRouterApiKey: "test", textGenerationModel: "vendor/deployment" },
      textGeneration: { model: "vendor/workspace", models: { "contextual-chunk-preamble": "vendor/task" } },
    });
    expect(textMock).toHaveBeenCalledWith(expect.objectContaining({ model: "vendor/task" }));
    expect(result.usage?.model).toBe("vendor/task");
  });

  it("discards an overlong reasoning response but retains actual billed usage", async () => {
    textMock.mockResolvedValue({ text: "Thinking Process: " + "Analyze the request. ".repeat(30),
      usage: { inputTokens: 90, outputTokens: 96, costCents: 0.0048, metadata: { costSource: "provider", generationId: "test-generation" } } });
    const config = fromEnv();
    config.openRouterApiKey = "test-key";
    const result = await contextualizeChunksForEmbedding({ privacyMode: "standard",
      documentTitle: "handbook.pdf", documentText: "Employee benefits and leave policies.",
      chunks: [{ text: "Leave accrues monthly." }], config,
    });
    expect(result.chunks[0].text).not.toContain("Thinking Process");
    expect(result.chunks[0].contextPreamble).toContain("Employee benefits");
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 96, costCents: 0.0048, metadata: { costSource: "provider", generationId: "test-generation" } });
  });
  it("builds a local contextual preamble without an LLM key and preserves raw chunk text", async () => {
    const config = fromEnv();
    config.openRouterApiKey = "";

    const result = await contextualizeChunksForEmbedding({ privacyMode: "standard",
      documentTitle: "handbook.pdf",
      documentText:
        "Acme employee handbook for benefits, leave policy, and payroll support.",
      chunks: [
        {
          text: "Paid time off accrues monthly for full-time employees.",
          headingPath: ["Benefits", "Time Off"],
          pageNumber: 4,
          pageNumbers: [4],
        },
      ],
      config,
    });

    expect(result.usage).toMatchObject({
      provider: "heuristic",
      source: "heuristic",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.rawText).toBe(
      "Paid time off accrues monthly for full-time employees.",
    );
    expect(result.chunks[0]?.contextPreamble).toContain("handbook.pdf");
    expect(result.chunks[0]?.contextPreamble).toContain("Time Off");
    expect(result.chunks[0]?.text).toContain(
      "Paid time off accrues monthly for full-time employees.",
    );
  });
});
