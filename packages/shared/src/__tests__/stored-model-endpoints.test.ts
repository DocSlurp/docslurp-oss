import { afterEach, describe, expect, it, vi } from "vitest";

import { tenantModelEndpointProblem } from "../model-endpoints.js";
import { normalizeStoredPipelineFeatures, normalizePipelineFeatures, readStoredPipelineSettings } from "../pipeline.js";

/**
 * A stored model setting whose endpoint the shared rule (model-endpoints.ts) refuses for its own shape never fails a
 * project read: the URI is dropped with a logged error (no URL user info in the log), and the profile is never
 * rewritten. A setting refused only by an operator setting (the flag, the port list) is kept as written and refused
 * at call time with its code.
 */
const USERINFO = "http://operator:hunter2@127.0.0.1:8000/v1";
const uri = (provider: string, model: string, baseUrl: string) => `llm://${provider}/${model}?baseUrl=${encodeURIComponent(baseUrl)}`;
const defaults = normalizePipelineFeatures({} as never);
const profileModel = (section: "embedding" | "vision", profile: string) =>
  (normalizePipelineFeatures({ [section]: { profile } } as never)[section] as { modelUri: string }).modelUri;

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
  ])("a stored %s refused for its shape, with no profile, is dropped and logged and reads the product default", (path, stored) => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const features = normalizeStoredPipelineFeatures(stored as never, `project:p-${path}-${JSON.stringify(stored).length}`);
    const [section, key] = path.split(".") as ["embedding" | "vision", string];
    const read = features[section] as Record<string, unknown>;
    if (key === "remoteFallbackModelUri") {
      // Only the fallback goes; the primary stays as stored.
      expect(read.remoteFallbackModelUri ?? null).toBeNull();
    } else {
      const fallback = defaults[section] as Record<string, unknown>;
      expect(read.profile).toBe(fallback.profile);
      expect(read.modelUri).toBe(fallback.modelUri);
    }
    const logged = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain(path);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("operator:");
  });

  it("keeps an explicit local profile when its model URI is dropped (no switch to another profile)", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const features = normalizeStoredPipelineFeatures({
      embedding: { profile: "good-fast-local", target: "local", dimensions: 512, modelUri: uri("vllm", "bge-m3", "http://10.0.0.5:8000/v1") },
    } as never, "project:explicit-local");
    expect(features.embedding.profile).toBe("good-fast-local");
    expect(features.embedding.modelUri).toBe(profileModel("embedding", "good-fast-local"));
    // The dimensions described the dropped model, not the profile's.
    expect(features.embedding.dimensions).toBeUndefined();
  });

  // (b) A legacy hosted row with a stale baseUrl keeps its hosted profile; it is never rewritten to a local one.
  it.each([
    ["embedding", { embedding: { profile: "cheapest-hosted", modelUri: uri("openai", "text-embedding-3-small", "https://gateway.example/v1") } }],
    ["vision", { vision: { profile: "good-fast-hosted", modelUri: uri("openrouter", "acme/vl", "https://gateway.example/v1") } }],
  ])("keeps the hosted %s profile of a row whose stale modelUri carries a baseUrl", (section, stored) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const features = normalizeStoredPipelineFeatures(stored as never, `project:hosted-${section}`);
    const read = features[section as "embedding" | "vision"] as Record<string, unknown>;
    const profile = (stored as Record<string, { profile: string }>)[section]!.profile;
    expect(read.profile).toBe(profile);
    expect(read.modelUri).toBe(profileModel(section as "embedding" | "vision", profile));
    expect(String(read.modelUri)).not.toContain("gateway.example");
  });

  // (a) A self-hoster with a local server on a port the list leaves out: the row stays, and the call is refused.
  it("keeps a stored loopback endpoint on a port the operator does not allow, refused at call time with its code", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const modelUri = uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:8100/v1");
    const features = normalizeStoredPipelineFeatures({ embedding: { profile: "good-fast-local", target: "local", dimensions: 768, modelUri } } as never, "project:port");
    expect(features.embedding.modelUri).toBe(modelUri);
    expect(features.embedding.profile).toBe("good-fast-local");
    expect(features.embedding.dimensions).toBe(768);
    expect(errors).not.toHaveBeenCalled();
    expect(tenantModelEndpointProblem(modelUri)).toBe("tenant-base-url-port-not-allowed");
  });

  // (c) Only the spelling the resolver reads counts: a key it ignores is inert and does not drop the setting.
  it("does not drop a URI whose only baseUrl-like key is one the resolver ignores", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const modelUri = "llm://openai/text-embedding-3-small?BaseURL=https%3A%2F%2Fgateway.example%2Fv1";
    const features = normalizeStoredPipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri } } as never, "project:spelling");
    expect(features.embedding.modelUri).toBe(modelUri);
    expect(errors.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("model-endpoint-refused");
  });

  it("with the flag off, a stored loopback endpoint is kept (refused before each request, not rerouted)", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
    const modelUri = uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:8000/v1");
    expect(normalizeStoredPipelineFeatures({ embedding: { target: "local", modelUri } } as never, "project:off").embedding.modelUri).toBe(modelUri);
  });

  it("the stored-row reader used for project lists reads such a row too", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const read = readStoredPipelineSettings({ embedding: { profile: "good-fast-local", target: "local", modelUri: uri("vllm", "nomic-embed-text-v1.5", USERINFO) } }, "project:list");
    expect(read.dropped).toContain("embedding.modelUri");
    expect(read.log ?? "").not.toContain("hunter2");
    expect(read.features.embedding.profile).toBe("good-fast-local");
  });

  it("a stored loopback endpoint the rule allows is kept", () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const modelUri = uri("vllm", "nomic-embed-text-v1.5", "http://127.0.0.1:8000/v1");
    const features = normalizeStoredPipelineFeatures({ embedding: { target: "local", modelUri } } as never, "project:kept");
    expect(features.embedding.modelUri).toBe(modelUri);
  });
});
