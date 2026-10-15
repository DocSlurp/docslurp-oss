import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePrivateModelCall,
  configurePrivateCallAudit,
  embeddingConfigSchema,
  isProviderCallAllowed,
  isPrivateNetworkHost,
  parsePrivateModelEndpointRegistry,
  pipelineFeaturesSchema,
  privateEndpointCallCost,
  PrivacyModeViolationError,
  probePrivateModelEndpoints,
  resolveEmbeddingRoute,
  resolveProviderTarget,
  resolveVisionRoute,
  setPrivateModelEndpointRegistryForTests,
  textModelCallDescriptor,
  visionConfigSchema,
  type PrivacyAuditEntry,
} from "../index.js";

const endpoint = {
  alias: "gpu1",
  baseUrl: "https://gpu1.example.com/v1/",
  auth: { tokenEnv: "TEST_PRIVATE_GPU1_TOKEN" },
  models: [
    { id: "Qwen/Qwen3.6-35B-A3B-FP8", capability: "text" },
    { id: "lightonai/LightOnOCR-3-0.8B", capability: "vision" },
    { id: "Qwen/Qwen3-Embedding-0.6B", capability: "embedding", dimensions: 1024 },
    { id: "CohereLabs/cohere-transcribe-03-2026", capability: "stt" },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east", note: "pilot" },
  pricing: { usdPerHour: 1.8 },
};

function registry(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([{ ...endpoint, ...overrides }]);
}

afterEach(() => {
  setPrivateModelEndpointRegistryForTests(undefined);
  configurePrivateCallAudit(undefined);
  delete process.env.TEST_PRIVATE_GPU1_TOKEN;
});

describe("private endpoint registry", () => {
  it("parses a valid registry and normalizes the base URL", () => {
    const parsed = parsePrivateModelEndpointRegistry(registry());
    expect(parsed.endpoints[0]!.baseUrl).toBe("https://gpu1.example.com/v1");
    expect(parsed.endpoints[0]!.auth).toEqual({ header: "Authorization", scheme: "Bearer", tokenEnv: "TEST_PRIVATE_GPU1_TOKEN" });
    expect(parsePrivateModelEndpointRegistry("").endpoints).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["public http URL", registry({ baseUrl: "http://gpu1.example.com/v1" })],
    ["credentials in URL", registry({ baseUrl: "https://user:pw@gpu1.example.com/v1" })],
    ["query in URL", registry({ baseUrl: "https://gpu1.example.com/v1?x=1" })],
    ["inline token", registry({ auth: { tokenEnv: "TEST_PRIVATE_GPU1_TOKEN", token: "sk-123" } })],
    ["lowercase token env", registry({ auth: { tokenEnv: "not-an-env" } })],
    ["bad alias", registry({ alias: "GPU 1" })],
    ["multi-tenant", registry({ attestation: { tenancy: "shared", hostProvider: "x", region: "y" } })],
    ["missing attestation", registry({ attestation: undefined })],
    ["embedding without dimensions", registry({ models: [{ id: "e", capability: "embedding" }] })],
    ["dimensions on text", registry({ models: [{ id: "t", capability: "text", dimensions: 512 }] })],
    ["unknown capability", registry({ models: [{ id: "t", capability: "image-gen" }] })],
    ["duplicate model", registry({ models: [{ id: "t", capability: "text" }, { id: "t", capability: "text" }] })],
    ["duplicate alias", JSON.stringify([endpoint, endpoint])],
  ])("rejects %s", (_label, raw) => {
    expect(() => parsePrivateModelEndpointRegistry(raw)).toThrow();
  });

  it("allows http only on private networks", () => {
    for (const host of ["10.0.0.5", "172.20.1.1", "192.168.1.9", "100.101.102.103", "127.0.0.1", "localhost", "gpu.internal", "box.tail1234.ts.net", "fd12::1"]) {
      expect(isPrivateNetworkHost(host)).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "gpu.example.com", "2001:db8::1"]) {
      expect(isPrivateNetworkHost(host)).toBe(false);
    }
    expect(() => parsePrivateModelEndpointRegistry(registry({ baseUrl: "http://10.1.2.3:8000/v1" }))).not.toThrow();
  });
});

describe("private endpoint privacy classification", () => {
  it("classifies registered routes as private and fails closed otherwise", () => {
    setPrivateModelEndpointRegistryForTests(JSON.parse(registry()));
    const uri = "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8";
    expect(resolveProviderTarget({ provider: "private", modelUri: uri, capability: "text" })).toBe("private");
    expect(isProviderCallAllowed("strict-privacy", textModelCallDescriptor("x", uri))).toBe(true);
    expect(isProviderCallAllowed("local-only", textModelCallDescriptor("x", uri))).toBe(true);
    // Unregistered alias, unlisted model, wrong capability, URL mismatch, missing capability.
    expect(isProviderCallAllowed("strict-privacy", textModelCallDescriptor("x", "llm://private/gpu9/Qwen/Qwen3.6-35B-A3B-FP8"))).toBe(false);
    expect(isProviderCallAllowed("strict-privacy", textModelCallDescriptor("x", "llm://private/gpu1/other/model"))).toBe(false);
    expect(resolveProviderTarget({ provider: "private", modelUri: uri, capability: "embedding" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "private", modelUri: uri, capability: "text", baseUrl: "https://evil.example.com/v1" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "private", modelUri: uri, capability: "text", baseUrl: "https://gpu1.example.com/v1/" })).toBe("private");
    expect(resolveProviderTarget({ provider: "private", modelUri: uri })).toBe("hosted");
    // A non-private provider cannot claim the private target.
    expect(resolveProviderTarget({ provider: "openrouter", target: "private" })).toBe("hosted");
    // Standard mode is unchanged.
    expect(isProviderCallAllowed("standard", textModelCallDescriptor("x", "qwen/qwen3.5-flash-02-23"))).toBe(true);
    expect(isProviderCallAllowed("strict-privacy", textModelCallDescriptor("x", "qwen/qwen3.5-flash-02-23"))).toBe(false);
  });

  it("fails closed when the registry env is invalid", () => {
    const previous = process.env.DOCSLURP_PRIVATE_MODEL_ENDPOINTS;
    process.env.DOCSLURP_PRIVATE_MODEL_ENDPOINTS = "{broken";
    try {
      expect(resolveProviderTarget({ provider: "private", modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text" })).toBe("hosted");
    } finally {
      if (previous === undefined) delete process.env.DOCSLURP_PRIVATE_MODEL_ENDPOINTS;
      else process.env.DOCSLURP_PRIVATE_MODEL_ENDPOINTS = previous;
    }
  });

  it("accepts private routes in strict-privacy pipelines and rejects URL overrides", () => {
    setPrivateModelEndpointRegistryForTests(JSON.parse(registry()));
    const pipeline = pipelineFeaturesSchema.parse({
      privacyMode: "strict-privacy",
      embedding: { modelUri: "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B" },
      vision: { modelUri: "llm://private/gpu1/lightonai/LightOnOCR-3-0.8B" },
      textGeneration: { model: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8" },
    });
    expect(pipeline.embedding.target).toBe("private");
    expect(pipeline.vision.target).toBe("private");
    expect(resolveEmbeddingRoute(pipeline.embedding)).toMatchObject({
      provider: "private", runtime: "remote", dimensions: 1024, baseUrl: "https://gpu1.example.com/v1", model: "gpu1/Qwen/Qwen3-Embedding-0.6B",
    });
    expect(resolveVisionRoute(pipeline.vision)).toMatchObject({ provider: "private", runtime: "openai-compatible", baseUrl: "https://gpu1.example.com/v1" });
    expect(embeddingConfigSchema.safeParse({ modelUri: "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B?baseUrl=https://evil.example.com" }).success).toBe(false);
    expect(visionConfigSchema.safeParse({ modelUri: "llm://private/gpu1" }).success).toBe(false);
    expect(pipelineFeaturesSchema.safeParse({ textGeneration: { model: "llm://openai/gpt-x" } }).success).toBe(false);
    expect(pipelineFeaturesSchema.safeParse({ privacyMode: "strict-privacy", embedding: { profile: "cheapest-hosted" } }).success).toBe(false);
  });
});

describe("authorizePrivateModelCall", () => {
  it("writes an audit row for allowed strict-privacy calls and injects auth", async () => {
    setPrivateModelEndpointRegistryForTests(JSON.parse(registry()));
    process.env.TEST_PRIVATE_GPU1_TOKEN = "secret-token";
    const written: PrivacyAuditEntry[] = [];
    configurePrivateCallAudit({ write: async (entries) => { written.push(...entries); } });
    const baseFetch = vi.fn(async () => new Response("{}"));
    const call = await authorizePrivateModelCall({
      privacyMode: "strict-privacy",
      modelUri: "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B",
      capability: "embedding",
      operation: "worker.embedding",
      auditScope: { workspaceId: "ws-1", runId: "run-1" },
      baseFetch,
    });
    expect(written).toEqual([{
      workspaceId: "ws-1", runId: "run-1", documentId: null,
      modelId: "private/gpu1/Qwen/Qwen3-Embedding-0.6B", endpoint: "private:gpu1:worker.embedding", privacyMode: "strict-privacy",
    }]);
    expect(call.model).toBe("Qwen/Qwen3-Embedding-0.6B");
    await call.fetch("https://gpu1.example.com/v1/embeddings", { method: "POST", headers: { authorization: "Bearer placeholder" } });
    const headers = new Headers((baseFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    await expect(call.fetch("https://evil.example.com/v1/embeddings")).rejects.toThrow();
  });

  it("does not audit local-only calls and refuses strict calls without an audit sink or scope", async () => {
    setPrivateModelEndpointRegistryForTests(JSON.parse(registry()));
    process.env.TEST_PRIVATE_GPU1_TOKEN = "secret-token";
    const write = vi.fn(async () => {});
    configurePrivateCallAudit({ write });
    await authorizePrivateModelCall({ privacyMode: "local-only", modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", operation: "t" });
    expect(write).not.toHaveBeenCalled();
    await expect(authorizePrivateModelCall({ privacyMode: "strict-privacy", modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", operation: "t" }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
    configurePrivateCallAudit(undefined);
    await expect(authorizePrivateModelCall({ privacyMode: "strict-privacy", modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", operation: "t", auditScope: { workspaceId: "ws" } }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
  });

  it("blocks unregistered aliases and missing tokens", async () => {
    setPrivateModelEndpointRegistryForTests(JSON.parse(registry()));
    const write = vi.fn(async () => {});
    configurePrivateCallAudit({ write });
    await expect(authorizePrivateModelCall({ privacyMode: "strict-privacy", modelUri: "llm://private/nope/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", operation: "t", auditScope: { workspaceId: "ws" } }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
    await expect(authorizePrivateModelCall({ privacyMode: "strict-privacy", modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", operation: "t", auditScope: { workspaceId: "ws" } }))
      .rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("private endpoint cost and health", () => {
  it("prices by tokens, then by GPU-hour, else 0 with a note", () => {
    const parsed = parsePrivateModelEndpointRegistry(registry()).endpoints[0]!;
    const model = parsed.models[0]!;
    expect(privateEndpointCallCost({ route: { endpoint: parsed, model, alias: "gpu1" }, durationMs: 3_600_000 }).costCents).toBeCloseTo(180);
    const tokenPriced = { ...parsed, pricing: { usdPerMTokInput: 0.1, usdPerMTokOutput: 0.4 } };
    expect(privateEndpointCallCost({ route: { endpoint: tokenPriced, model, alias: "gpu1" }, inputTokens: 1_000_000, outputTokens: 1_000_000 }).costCents).toBeCloseTo(50);
    const unpriced = privateEndpointCallCost({ route: { endpoint: { ...parsed, pricing: undefined }, model, alias: "gpu1" }, inputTokens: 10 });
    expect(unpriced).toMatchObject({ costCents: 0, metadata: { costSource: "private-endpoint-unpriced" } });
  });

  it("probes /models and reports missing models without throwing", async () => {
    process.env.TEST_PRIVATE_GPU1_TOKEN = "secret-token";
    const reg = parsePrivateModelEndpointRegistry(registry());
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: "Qwen/Qwen3.6-35B-A3B-FP8" }, { id: "Qwen/Qwen3-Embedding-0.6B" }] }));
    const [result] = await probePrivateModelEndpoints({ registry: reg, fetch: fetchMock as unknown as typeof fetch });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://gpu1.example.com/v1/models");
    expect(result).toMatchObject({ alias: "gpu1", ok: false, missing: ["lightonai/LightOnOCR-3-0.8B", "CohereLabs/cohere-transcribe-03-2026"] });
    const failing = await probePrivateModelEndpoints({ registry: reg, fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect(failing[0]).toMatchObject({ ok: false, error: "down" });
  });
});
