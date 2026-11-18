import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyDefaultVisionOverride,
  applyPrivateModelMode,
  assertProviderAllowed,
  hostedModelsAllowed,
  indexConfigHash,
  indexConfigOf,
  isProviderCallAllowed,
  modelMode,
  modelRecordUri,
  normalizePipelineFeatures,
  PrivacyModeViolationError,
  privacyModeAllowsHosted,
  privateServiceModel,
  privateServiceModelFor,
  PrivateModelModeConfigError,
  resetPrivateModelModeReportsForTests,
  resetPrivateModelPipelineReportsForTests,
  effectiveModelMode,
  lookupPrivateServiceModel,
  parsePrivateModelEndpointRegistry,
  runModelModeStamp,
  stampRunModelMode,
  resolveEmbeddingRoute,
  setPrivateModelEndpointRegistryForTests,
  validatePrivateModelModeAtStartup,
  withModelProvenance,
} from "../index.js";

const BASE_URL = "https://gpu-mode.example.com/v1";
const endpoint = {
  alias: "gpu",
  baseUrl: BASE_URL,
  auth: { tokenEnv: "TEST_MODE_GPU_TOKEN" },
  models: [
    { id: "acme/text-llm", capability: "text" },
    { id: "acme/vision-vlm", capability: "vision" },
    { id: "acme/embed", capability: "embedding", dimensions: 768 },
    { id: "acme/rerank", capability: "rerank" },
    { id: "acme/stt", capability: "stt" },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "self", region: "us-east" },
};
const TEXT = "llm://private/gpu/acme/text-llm";
const VISION = "llm://private/gpu/acme/vision-vlm";
const EMBED = "llm://private/gpu/acme/embed";
const RERANK = "llm://private/gpu/acme/rerank";
const STT = "llm://private/gpu/acme/stt";

const fullMap = {
  DOCSLURP_PRIVATE_TEXT_MODEL: TEXT,
  DOCSLURP_PRIVATE_VISION_MODEL: VISION,
  DOCSLURP_PRIVATE_EMBEDDING_MODEL: EMBED,
  DOCSLURP_PRIVATE_RERANK_MODEL: RERANK,
  DOCSLURP_PRIVATE_ROUTER_MODEL: TEXT,
  DOCSLURP_PRIVATE_STT_MODEL: STT,
};

beforeEach(() => {
  setPrivateModelEndpointRegistryForTests([endpoint]);
  resetPrivateModelModeReportsForTests();
  resetPrivateModelPipelineReportsForTests();
});

const parsedEndpoint = () => parsePrivateModelEndpointRegistry(JSON.stringify([endpoint])).endpoints[0]!;

afterEach(() => {
  setPrivateModelEndpointRegistryForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

describe("model mode", () => {
  it("defaults to hosted and fails closed on an unreadable value", () => {
    expect(modelMode({})).toBe("hosted");
    expect(modelMode({ DOCSLURP_MODEL_MODE: "Private" })).toBe("private");
    expect(modelMode({ DOCSLURP_MODEL_MODE: "hybrid" })).toBe("private");
    expect(() => validatePrivateModelModeAtStartup({ DOCSLURP_MODEL_MODE: "hybrid" })).toThrow(PrivateModelModeConfigError);
  });

  it("private mode allows no hosted call for any project, while private and local calls stay allowed", () => {
    expect(privacyModeAllowsHosted("standard")).toBe(true);
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    expect(privacyModeAllowsHosted("standard")).toBe(false);
    expect(hostedModelsAllowed(undefined)).toBe(false);
    expect(() => assertProviderAllowed("standard", { provider: "openrouter", model: "x/y", operation: "test", target: "hosted" }))
      .toThrow(PrivacyModeViolationError);
    expect(isProviderCallAllowed("standard", { provider: "private", model: TEXT, modelUri: TEXT, capability: "text" })).toBe(true);
    expect(isProviderCallAllowed("standard", { provider: "transformers.js", target: "local" })).toBe(true);
  });
});

describe("service map", () => {
  it("resolves each service against the registry with the matching capability", () => {
    stubEnv(fullMap);
    expect(privateServiceModel("text")?.modelUri).toBe(TEXT);
    expect(privateServiceModel("embedding")?.route.model.dimensions).toBe(768);
    expect(privateServiceModel("router")?.capability).toBe("text");
    vi.stubEnv("DOCSLURP_PRIVATE_ROUTER_MODEL", VISION);
    expect(privateServiceModel("router")?.capability).toBe("vision");
  });

  it.each([
    ["text", "DOCSLURP_PRIVATE_TEXT_MODEL", VISION],
    ["vision", "DOCSLURP_PRIVATE_VISION_MODEL", TEXT],
    ["embedding", "DOCSLURP_PRIVATE_EMBEDDING_MODEL", "llm://private/gpu9/acme/embed"],
    ["rerank", "DOCSLURP_PRIVATE_RERANK_MODEL", "llm://openrouter/acme/rerank"],
    ["router", "DOCSLURP_PRIVATE_ROUTER_MODEL", EMBED],
    ["stt", "DOCSLURP_PRIVATE_STT_MODEL", "llm://private/gpu/acme/missing"],
  ] as const)("an invalid %s mapping fails startup in private mode, warns in hosted mode, and reads as unmapped", (service, name, value) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => validatePrivateModelModeAtStartup({ DOCSLURP_MODEL_MODE: "private", [name]: value })).toThrow(PrivateModelModeConfigError);
    // An existing hosted deployment keeps starting: the service is unmapped, with a warning.
    expect(validatePrivateModelModeAtStartup({ [name]: value }).warnings.join("\n")).toMatch(/invalid mapping ignored/);
    vi.stubEnv(name, value);
    expect(privateServiceModel(service)).toBeUndefined();
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    expect(privateServiceModelFor(service, "standard")).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("hosted mode maps only restricted projects; private mode maps every project", () => {
    stubEnv(fullMap);
    for (const service of ["text", "vision", "embedding", "rerank", "stt"] as const) {
      expect(privateServiceModelFor(service, "standard")).toBeUndefined();
      expect(privateServiceModelFor(service, "local-only")).toBeDefined();
      expect(privateServiceModelFor(service, "strict-privacy")).toBeDefined();
    }
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    for (const service of ["text", "vision", "embedding", "rerank", "stt"] as const) {
      expect(privateServiceModelFor(service, "standard")).toBeDefined();
    }
  });

  it("startup lists unmapped services in private mode and refuses hosted provider keys", () => {
    const env = { DOCSLURP_MODEL_MODE: "private", DOCSLURP_PRIVATE_TEXT_MODEL: TEXT };
    const result = validatePrivateModelModeAtStartup(env);
    expect(result.info[0]).toMatch(new RegExp(`map_digest=[0-9a-f]{8} mapped=text=${TEXT.replace(/[/.]/g, "\\$&")}`));
    expect(result.warnings[0]).toMatch(/vision \(DOCSLURP_PRIVATE_VISION_MODEL\).*embedding.*rerank.*stt/);
    expect(result.warnings.join("\n")).toMatch(/DOCSLURP_PRIVATE_ROUTER_MODEL is reserved/);
    for (const key of ["OPENROUTER_API_KEY", "HF_TOKEN", "TAVILY_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY"]) {
      expect(() => validatePrivateModelModeAtStartup({ ...env, [key]: "secret-value" })).toThrow(new RegExp(`unset ${key}`));
    }
    expect(() => validatePrivateModelModeAtStartup({ ...env, OPENROUTER_API_KEY: "sk-or-secret" })).not.toThrow(/sk-or-secret/);
    // An explicit operator opt-out keeps a key for a non-model use, with a warning.
    const allowed = validatePrivateModelModeAtStartup({ ...env, DEEPINFRA_API_KEY: "k", DOCSLURP_PRIVATE_MODE_ALLOW_KEYS: "DEEPINFRA_API_KEY" });
    expect(allowed.warnings.join("\n")).toMatch(/keeps hosted credentials DEEPINFRA_API_KEY/);
    // A registered endpoint may not borrow a hosted provider's key name for its token.
    setPrivateModelEndpointRegistryForTests([{ ...endpoint, auth: { tokenEnv: "OPENAI_API_KEY" } }]);
    expect(() => validatePrivateModelModeAtStartup({ ...env, OPENAI_API_KEY: "vllm-token" })).toThrow(/must not reuse a hosted provider key name/);
    // Hosted mode keeps hosted keys and warns about nothing.
    expect(validatePrivateModelModeAtStartup({ OPENROUTER_API_KEY: "k" }).warnings).toEqual([]);
  });

  it("the map digest differs between modes and maps", () => {
    const hosted = validatePrivateModelModeAtStartup({ DOCSLURP_PRIVATE_TEXT_MODEL: TEXT }).info[0];
    const privateMode = validatePrivateModelModeAtStartup({ DOCSLURP_MODEL_MODE: "private", DOCSLURP_PRIVATE_TEXT_MODEL: TEXT }).info[0];
    expect(hosted!.match(/map_digest=(\w+)/)![1]).not.toBe(privateMode!.match(/map_digest=(\w+)/)![1]);
  });
});

describe("applyPrivateModelMode", () => {
  const standard = () => normalizePipelineFeatures({ privacyMode: "standard" });

  it("leaves a standard project unchanged in hosted mode", () => {
    stubEnv(fullMap);
    const pipeline = standard();
    expect(applyPrivateModelMode(pipeline)).toBe(pipeline);
  });

  it("routes every service of a standard project to the mapped models in private mode", () => {
    stubEnv({ ...fullMap, DOCSLURP_MODEL_MODE: "private" });
    const pipeline = { ...standard(), textGeneration: { model: "openai/gpt-5-mini", models: { "document-summary": "x/y" } } };
    const next = applyPrivateModelMode(pipeline);
    expect(next.textGeneration).toMatchObject({ model: TEXT, models: {} });
    expect(next.structuredExtraction.model).toBe(TEXT);
    expect(next.vision).toMatchObject({ modelUri: VISION, target: "private" });
    expect(next.embedding).toMatchObject({ modelUri: EMBED, target: "private" });
    expect(resolveEmbeddingRoute(next.embedding).dimensions).toBe(768);
    // The stored pipeline is untouched: projects keep their level only.
    expect(pipeline.textGeneration.model).toBe("openai/gpt-5-mini");
  });

  it("restricted projects take the mapped models in hosted mode but keep a local route", () => {
    stubEnv(fullMap);
    const local = normalizePipelineFeatures({ privacyMode: "local-only" });
    const next = applyPrivateModelMode(local);
    expect(next.textGeneration.model).toBe(TEXT);
    // A local embedding stays local: swapping it for a remote endpoint would widen egress.
    expect(next.embedding.modelUri).toBe(local.embedding.modelUri);
  });

  it("unmapped services are left for the guard to refuse, never pointed at another model", () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const pipeline = standard();
    const next = applyPrivateModelMode(pipeline);
    expect(next.embedding.modelUri).toBe(pipeline.embedding.modelUri);
    expect(() => assertProviderAllowed(next.privacyMode, { provider: "openrouter", model: "m", modelUri: next.embedding.modelUri, operation: "worker.embedding", target: "hosted" }))
      .toThrow(PrivacyModeViolationError);
  });

  it("a stored private route is kept only when it is the service's mapped URI", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPrivateModelEndpointRegistryForTests([endpoint, { ...endpoint, alias: "other" }]);
    stubEnv({ DOCSLURP_MODEL_MODE: "private", DOCSLURP_PRIVATE_TEXT_MODEL: TEXT });
    const other = "llm://private/other/acme/text-llm";
    const base = standard();
    const pipeline = {
      ...base,
      textGeneration: { model: other, models: { "document-summary": other } },
      structuredExtraction: { ...base.structuredExtraction, model: other },
      vision: { ...base.vision, modelUri: "llm://private/other/acme/vision-vlm", target: "private" as const },
      embedding: { ...base.embedding, modelUri: "llm://private/other/acme/embed", target: "private" as const },
    };
    const next = applyPrivateModelMode(pipeline);
    // Text is mapped: the other alias is replaced by the mapped model.
    expect(next.textGeneration).toMatchObject({ model: TEXT, models: {} });
    expect(next.structuredExtraction.model).toBe(TEXT);
    // Vision and embedding are unmapped: the other alias is dropped back to the profile's route, which the guard refuses.
    expect(next.vision.modelUri).not.toContain("private/other");
    expect(next.embedding.modelUri).not.toContain("private/other");
    expect(warn).toHaveBeenCalled();
    // The mapped URI itself is kept.
    vi.stubEnv("DOCSLURP_PRIVATE_VISION_MODEL", VISION);
    expect(applyPrivateModelMode({ ...pipeline, vision: { ...pipeline.vision, modelUri: VISION } }).vision.modelUri).toBe(VISION);
  });

  it("unmapped text keeps a hosted route (refused by the guard) and drops another private alias", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const base = standard();
    expect(applyPrivateModelMode({ ...base, textGeneration: { model: "openai/gpt-5-mini", models: {} } }).textGeneration.model).toBe("openai/gpt-5-mini");
    expect(applyPrivateModelMode({ ...base, textGeneration: { model: TEXT, models: {} } }).textGeneration.model).toBeNull();
  });

  it("the private embedding drops the hosted profile's settings", () => {
    stubEnv({ ...fullMap, DOCSLURP_MODEL_MODE: "private" });
    const base = standard();
    const next = applyPrivateModelMode({ ...base, embedding: { ...base.embedding, normalize: false, lateChunking: true, task: "query" as const } });
    expect(next.embedding).toMatchObject({ modelUri: EMBED, target: "private", normalize: true, lateChunking: false });
    expect(next.embedding).not.toHaveProperty("task");
    expect(next.embedding).not.toHaveProperty("dimensions");
  });

  it("an embedding mapping without dimensions is refused", () => {
    const lookup = lookupPrivateServiceModel("embedding", {
      env: { DOCSLURP_PRIVATE_EMBEDDING_MODEL: EMBED },
      registry: { endpoints: [{ ...parsedEndpoint(), models: [{ id: "acme/embed", capability: "embedding" } as never] }] },
    });
    expect(lookup).toMatchObject({ ok: false, unmapped: false, reason: expect.stringMatching(/declares no dimensions/) });
  });

  it("a run stamped private is private in a worker whose env says hosted", () => {
    stubEnv({ DOCSLURP_MODEL_MODE: "private" });
    const stamped = stampRunModelMode(standard());
    expect(stamped.modelMode).toBe("private");
    expect(runModelModeStamp(JSON.parse(JSON.stringify(stamped)))).toEqual({ modelMode: "private" });
    vi.stubEnv("DOCSLURP_MODEL_MODE", "hosted");
    expect(stampRunModelMode(standard())).not.toHaveProperty("modelMode");
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    const next = applyPrivateModelMode(stamped);
    expect(next.privacyMode).toBe("local-only");
    expect(next.textGeneration.model).toBe(TEXT);
    expect(() => assertProviderAllowed(next.privacyMode, { provider: "openrouter", model: "x/y", operation: "t", target: "hosted" })).toThrow(PrivacyModeViolationError);
    expect(effectiveModelMode(stamped)).toBe("private");
    // An unstamped standard run in hosted mode is unchanged.
    const plain = standard();
    expect(applyPrivateModelMode(plain)).toBe(plain);
  });

  it("refusals in private mode name the deployment mode", () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    expect(() => assertProviderAllowed("standard", { provider: "openrouter", model: "x/y", operation: "t", target: "hosted" }))
      .toThrow(/Deployment model mode 'private'/);
  });

  it("does not apply the hosted DOCSLURP_VISION_MODEL_URI default in private mode", () => {
    const pipeline = standard();
    const env = { DOCSLURP_VISION_MODEL_URI: "llm://openrouter/qwen/qwen3-vl-8b-instruct", DOCSLURP_MODEL_MODE: "private" };
    expect(applyDefaultVisionOverride(pipeline, env)).toBe(pipeline);
  });
});

describe("index identity and provenance", () => {
  it("a private embedding model never shares an index config with a hosted one", () => {
    stubEnv({ ...fullMap, DOCSLURP_MODEL_MODE: "private" });
    const hosted = normalizePipelineFeatures({ privacyMode: "standard" });
    const privateIndex = indexConfigOf(applyPrivateModelMode(hosted));
    expect(privateIndex).toMatchObject({ embeddingModel: EMBED, normalize: true });
    expect(privateIndex.chunking.lateChunking).toBe(false);
    expect(indexConfigHash(privateIndex)).not.toBe(indexConfigHash(indexConfigOf(hosted)));
  });

  it("usage provenance names the private route by alias, never by URL or token", () => {
    vi.stubEnv("TEST_MODE_GPU_TOKEN", "tok-secret");
    const event = withModelProvenance<{ provider: string; model: string; metadata: Record<string, unknown> }>({
      provider: "private",
      model: "gpu/acme/text-llm",
      metadata: { endpointAlias: "gpu", baseUrl: BASE_URL, modelConfig: { operation: "chat", endpoint: BASE_URL, apiKey: "tok-secret" } },
    });
    expect(event.metadata?.modelUri).toBe("llm://private/gpu/acme/text-llm?operation=chat");
    expect(JSON.stringify(event.metadata?.modelUri)).not.toContain("example.com");
    expect(JSON.stringify(event.metadata?.modelConfig)).not.toMatch(/example\.com|tok-secret/);
    expect(modelRecordUri({ provider: "private", model: TEXT })).toBe(TEXT);
  });
});
