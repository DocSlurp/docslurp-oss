import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeStoredPipelineFeatures, normalizePipelineFeatures, readStoredPipelineSettings } from "../pipeline.js";

/**
 * A stored model setting whose endpoint the shared rule (model-endpoints.ts) now refuses never fails a project read:
 * it is dropped with a logged error (no URL user info in the log) and the read uses the local profile's model.
 */
const USERINFO = "http://operator:hunter2@127.0.0.1:8000/v1";
const uri = (provider: string, model: string, baseUrl: string) => `llm://${provider}/${model}?baseUrl=${encodeURIComponent(baseUrl)}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("stored model endpoints", () => {
  it.each([
    ["embedding.modelUri", { embedding: { target: "local", modelUri: uri("vllm", "nomic-embed-text-v1.5", USERINFO) } }],
    ["vision.modelUri", { vision: { target: "local", modelUri: uri("vllm", "acme/plain-vl", USERINFO) } }],
    ["vision.remoteFallbackModelUri", { vision: { remoteFallbackModelUri: uri("vllm", "acme/plain-vl", USERINFO) } }],
    ["embedding.modelUri", { embedding: { target: "local", modelUri: uri("ollama", "nomic-embed-text", "http://127.0.0.1:8000/v1?x=1") } }],
    ["vision.modelUri", { vision: { target: "local", modelUri: uri("lmstudio", "acme/vl", "http://127.0.0.1:1234/v1#frag") } }],
  ])("a stored %s the rule refuses is dropped and logged, and the read uses the default", (path, stored) => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const features = normalizeStoredPipelineFeatures(stored as never, `project:p-${path}-${JSON.stringify(stored).length}`);
    const [section, key] = path.split(".") as ["embedding" | "vision", string];
    const read = features[section] as Record<string, unknown>;
    if (key === "remoteFallbackModelUri") {
      // Only the fallback goes; the primary stays as stored.
      expect(read.remoteFallbackModelUri ?? null).toBeNull();
    } else {
      // A local-server setting falls back to the local profile's model, never a hosted one.
      const local = normalizePipelineFeatures({ [section]: { profile: "cheapest-local" } } as never)[section] as Record<string, unknown>;
      expect(read.modelUri).toBe(local.modelUri);
      expect(read.target).toBe("local");
    }
    const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain(path);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("operator:");
  });

  it("with the flag off, a stored loopback endpoint is kept (refused before each request, not rerouted)", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
    const modelUri = uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:8000/v1");
    expect(normalizeStoredPipelineFeatures({ embedding: { target: "local", modelUri } } as never, "project:off").embedding.modelUri).toBe(modelUri);
  });

  it("the stored-row reader used for project lists reads such a row too", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const read = readStoredPipelineSettings({ embedding: { target: "local", modelUri: uri("vllm", "nomic-embed-text-v1.5", USERINFO) } }, "project:list");
    expect(read.dropped).toContain("embedding.modelUri");
    expect(read.log ?? "").not.toContain("hunter2");
    expect(read.features.embedding.target).toBe("local");
  });

  it("a stored loopback endpoint the rule allows is kept", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const modelUri = uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:8000/v1");
    const features = normalizeStoredPipelineFeatures({ embedding: { target: "local", modelUri } } as never, "project:kept");
    expect(features.embedding.modelUri).toBe(modelUri);
  });

  it("a stored loopback endpoint on a port the operator does not allow is dropped", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const features = normalizeStoredPipelineFeatures({ embedding: { target: "local", modelUri: uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:6379/v1") } } as never, "project:port");
    expect(features.embedding.modelUri).toBe(normalizePipelineFeatures({ embedding: { profile: "cheapest-local" } } as never).embedding.modelUri);
  });
});
