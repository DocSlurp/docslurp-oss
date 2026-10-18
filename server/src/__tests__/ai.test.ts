import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transformersEnv = { cacheDir: "read-only-package-cache" };
const extractorMock = vi.fn();
const pipelineMock = vi.fn();
const embedMock = vi.fn();
const streamTextMock = vi.fn();
const createOpenAIMock = vi.fn(() => Object.assign((model: string) => ({ model }), {
  embedding: (model: string) => ({ model }),
}));

vi.mock("@huggingface/transformers", () => ({
  env: transformersEnv,
  pipeline: pipelineMock
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  embed: embedMock,
  streamText: streamTextMock,
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

const { embedConfiguredText, generateOpenRouterDocumentText, resolveOpenRouterApiKey } = await import("../lib/ai.js");

it("streams extracted evidence as text without interpreting document prefixes as URLs", async () => {
  streamTextMock.mockReturnValue({
    textStream: (async function* () { yield "Grounded answer [1]"; })(),
    usage: Promise.resolve({ inputTokens: 42, outputTokens: 7, raw: { cost: 0.0001 } }),
    response: Promise.resolve({ id: "gen-test" }),
    sources: Promise.resolve([]),
  });
  const result = await generateOpenRouterDocumentText({
    apiKey: "test", privacyMode: "standard", prompt: "Summarize", maxOutputTokens: 100,
    documents: [{ title: "Example", text: "Document: example.pdf\nSource evidence." }],
  });
  expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
    prompt: expect.stringContaining("Document: example.pdf\nSource evidence."),
  }));
  expect(streamTextMock.mock.calls.at(-1)?.[0].messages).toBeUndefined();
  expect(result).toMatchObject({ text: "Grounded answer [1]", usage: { inputTokens: 42, outputTokens: 7 } });
});

describe("embedConfiguredText", () => {
  beforeEach(() => {
    extractorMock.mockReset();
    pipelineMock.mockReset();
    embedMock.mockReset();
    createOpenAIMock.mockClear();
  });

  it("uses a cached local transformers pipeline for query embeddings", async () => {
    extractorMock.mockResolvedValue({ tolist: () => [[0.1, 0.2, 0.3, 0.4]] });
    pipelineMock.mockResolvedValue(extractorMock);

    const first = await embedConfiguredText({
      privacyMode: "standard",
      value: "hello local embeddings",
      runtime: "local",
      provider: "transformers.js",
      model: "Xenova/bge-m3",
      dimensions: 3,
      normalize: true
    });
    const second = await embedConfiguredText({
      privacyMode: "standard",
      value: "another local query",
      runtime: "local",
      provider: "transformers.js",
      model: "Xenova/bge-m3",
      dimensions: 3,
      normalize: true
    });

    expect(transformersEnv.cacheDir).toBe(join(homedir(), ".cache", "docslurp", "transformers"));
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "Xenova/bge-m3", {
      dtype: "q8",
      cache_dir: join(homedir(), ".cache", "docslurp", "transformers"),
    });
    expect(extractorMock).toHaveBeenCalledTimes(2);
    expect(extractorMock).toHaveBeenNthCalledWith(1, "hello local embeddings", {
      pooling: "mean",
      normalize: true
    });
    const norm = Math.hypot(0.1, 0.2, 0.3);
    expect(first.embedding).toEqual([0.1 / norm, 0.2 / norm, 0.3 / norm]);
    expect(Math.hypot(...first.embedding)).toBeCloseTo(1, 12);
    expect(first.usage.inputTokens).toBe(3);
    expect(second.embedding).toEqual(first.embedding);
  });

  it("uses the official OpenRouter route and records actual usage before rejecting malformed vectors", async () => {
    const onUsage = vi.fn();
    const args = { value: "How many batteries are required?", runtime: "remote", provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b", dimensions: 1024, normalize: true, apiKey: "router-key", baseURL: "https://ignored.invalid", privacyMode: "standard" as const, onUsage };
    embedMock.mockResolvedValueOnce({ embedding: Array.from({ length: 1024 }, () => 1), usage: { tokens: 9 } });
    const result = await embedConfiguredText(args);
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "router-key", baseURL: "https://openrouter.ai/api/v1", fetch: expect.any(Function) });
    expect(result.usage.inputTokens).toBe(9);
    expect(Math.hypot(...result.embedding)).toBeCloseTo(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 9 });
    embedMock.mockResolvedValueOnce({ embedding: [1, 2], usage: { tokens: 11 } });
    await expect(embedConfiguredText(args)).rejects.toThrow("invalid dimensions");
    expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 11 });
    embedMock.mockResolvedValueOnce({ embedding: Array.from({ length: 1024 }, () => 1), usage: {} });
    await expect(embedConfiguredText(args)).rejects.toThrow("actual usage");
    await expect(embedConfiguredText({ ...args, apiKey: undefined })).rejects.toThrow("OPENROUTER_API_KEY");
    await expect(embedConfiguredText({ ...args, privacyMode: "local-only" })).rejects.toThrow();
  });

  it("uses native signed INT8 query vectors and records paid malformed responses", async () => {
    const onUsage = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ usage: { prompt_tokens: 7 }, data: [{ index: 0, embedding: Buffer.alloc(1024, 1).toString("base64") }] }))
      .mockResolvedValueOnce(Response.json({ usage: { prompt_tokens: 11 }, data: [] }));
    vi.stubGlobal("fetch", fetch);
    const args = { value: "How many batteries?", runtime: "remote", provider: "perplexity", model: "pplx-embed-v1-0.6b", dimensions: 1024,
      normalize: true, apiKey: "native-key", baseURL: "https://ignored.invalid", privacyMode: "standard" as const, onUsage };
    try {
      const result = await embedConfiguredText(args);
      expect(result.embedding).toHaveLength(1024);
      expect(Math.hypot(...result.embedding)).toBeCloseTo(1);
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 7 });
      await expect(embedConfiguredText(args)).rejects.toThrow("omitted vectors");
      expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 11 });
      await expect(embedConfiguredText({ ...args, privacyMode: "local-only" })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses the URI-selected local OpenAI-compatible service", async () => {
    embedMock.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      usage: { tokens: 4 },
    });

    const result = await embedConfiguredText({
      privacyMode: "standard",
      value: "hello ollama",
      runtime: "remote",
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 2,
      baseURL: "http://127.0.0.1:11434/v1",
    });

    expect(createOpenAIMock).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      apiKey: "local",
      baseURL: "http://127.0.0.1:11434/v1",
    });
    expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { model: "nomic-embed-text" },
      value: "hello ollama",
    }));
    expect(result).toEqual({
      embedding: [0.1, 0.2],
      usage: { inputTokens: 4 },
    });
    expect(embedMock.mock.calls[0]?.[0].providerOptions).toBeUndefined();
  });

  it("requests configured Matryoshka dimensions from vLLM and renormalizes any client-side cut", async () => {
    embedMock.mockResolvedValueOnce({ embedding: [0.6, 0.8], usage: { tokens: 3 } });
    const exact = await embedConfiguredText({
      value: "hello vllm",
      runtime: "remote",
      provider: "vllm",
      model: "nomic-embed-text-v1.5",
      dimensions: 2,
      requestedDimensions: 2,
      normalize: true,
      baseURL: "http://127.0.0.1:18100/v1",
      privacyMode: "standard",
    });
    expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { openai: { dimensions: 2 } },
    }));
    expect(exact.embedding).toEqual([0.6, 0.8]);

    // A server that ignores `dimensions` still yields the configured, unit-length size.
    embedMock.mockResolvedValueOnce({ embedding: [0.3, 0.4, 0.5, 0.7], usage: { tokens: 3 } });
    const cut = await embedConfiguredText({
      value: "hello vllm",
      runtime: "remote",
      provider: "vllm",
      model: "nomic-embed-text-v1.5",
      dimensions: 2,
      requestedDimensions: 2,
      normalize: true,
      baseURL: "http://127.0.0.1:18100/v1",
      privacyMode: "standard",
    });
    expect(cut.embedding[0]).toBeCloseTo(0.6, 12);
    expect(cut.embedding[1]).toBeCloseTo(0.8, 12);
  });
});


describe("OpenRouter credential isolation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never sends another provider's credential to OpenRouter", () => {
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    vi.stubEnv("OPENROUTER_KEY", undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-only-test-key");
    expect(resolveOpenRouterApiKey()).toBeUndefined();
  });

  it("accepts OpenRouter credentials and its legacy alias", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-primary-test-key");
    vi.stubEnv("OPENROUTER_KEY", "router-alias-test-key");
    expect(resolveOpenRouterApiKey()).toBe("router-primary-test-key");
    vi.stubEnv("OPENROUTER_API_KEY", undefined);
    expect(resolveOpenRouterApiKey()).toBe("router-alias-test-key");
  });
});
