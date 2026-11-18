import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPrivateModelMode,
  normalizePipelineFeatures,
  normalizeStoredPipelineFeatures,
  resolvePipelineTextModel,
  runModelModeStamp,
  stampRunModelMode,
  resolveVisionRoute,
  setPrivateModelEndpointRegistryForTests,
} from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
import { buildRuntimeCatalog } from "../routing/runtime.js";

const registry = [{
  alias: "gpu",
  baseUrl: "https://gpu-mode.example.com/v1",
  auth: { tokenEnv: "TEST_MODE_WORKER_TOKEN" },
  models: [
    { id: "acme/text-llm", capability: "text" },
    { id: "acme/vision-vlm", capability: "vision" },
    { id: "acme/embed", capability: "embedding", dimensions: 768 },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "self", region: "us-east" },
}];
const TEXT = "llm://private/gpu/acme/text-llm";
const VISION = "llm://private/gpu/acme/vision-vlm";

beforeEach(() => setPrivateModelEndpointRegistryForTests(registry));
afterEach(() => {
  setPrivateModelEndpointRegistryForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("worker private model mode", () => {
  it("a run of a standard project uses the mapped text and vision models in private mode", () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    vi.stubEnv("DOCSLURP_PRIVATE_VISION_MODEL", VISION);
    const pipeline = applyPrivateModelMode(normalizePipelineFeatures({ privacyMode: "standard" }));
    expect(resolvePipelineTextModel(pipeline, "document-summary", "openai/gpt-5-mini")).toBe(TEXT);
    expect(resolveVisionRoute(pipeline.vision)).toMatchObject({ target: "private", baseUrl: "https://gpu-mode.example.com/v1" });
  });

  it("a restricted project uses the mapped text model in hosted mode", () => {
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    const pipeline = applyPrivateModelMode(normalizePipelineFeatures({ privacyMode: "strict-privacy" }));
    expect(resolvePipelineTextModel(pipeline, "document-summary")).toBe(TEXT);
    const standard = applyPrivateModelMode(normalizePipelineFeatures({ privacyMode: "standard" }));
    expect(resolvePipelineTextModel(standard, "document-summary")).not.toBe(TEXT);
  });

  it("private mode with no text mapping refuses the hosted call without sending it", async () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const http = vi.fn();
    vi.stubGlobal("fetch", http);
    const pipeline = applyPrivateModelMode(normalizePipelineFeatures({ privacyMode: "standard" }));
    await expect(generateOpenRouterText({
      operation: "document-summary", apiKey: "sk-or-test", prompt: "x", maxOutputTokens: 8,
      model: resolvePipelineTextModel(pipeline, "document-summary"), privacyMode: pipeline.privacyMode,
    })).rejects.toMatchObject({ code: "PRIVACY_MODE_VIOLATION" });
    expect(http).not.toHaveBeenCalled();
  });

  it("a run stamped private by the API stays private in a worker whose env says hosted (as run-ledger loads it)", () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const stored = JSON.parse(JSON.stringify(stampRunModelMode(normalizePipelineFeatures({ privacyMode: "standard" }))));
    vi.stubEnv("DOCSLURP_MODEL_MODE", "hosted");
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    const pipeline = applyPrivateModelMode({ ...normalizeStoredPipelineFeatures(stored, "run r"), ...runModelModeStamp(stored) });
    expect(pipeline.privacyMode).toBe("local-only");
    expect(resolvePipelineTextModel(pipeline, "document-summary")).toBe(TEXT);
    expect(buildRuntimeCatalog({ env: { OPENROUTER_API_KEY: "x" }, privacyMode: pipeline.privacyMode }).decisionModels
      .filter((m) => m.availability.privacyClass === "hosted")).toEqual([]);
  });

  it("the page router admits no hosted target or decision model in private mode", () => {
    const env = { OPENROUTER_API_KEY: "x", PERPLEXITYAI_API_KEY: "x", LIQUID_API_KEY: "x" };
    expect(buildRuntimeCatalog({ env, privacyMode: "standard" }).decisionModels.some((m) => m.availability.privacyClass === "hosted")).toBe(true);
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const catalog = buildRuntimeCatalog({ env, privacyMode: "standard" });
    expect(catalog.decisionModels.filter((m) => m.availability.privacyClass === "hosted")).toEqual([]);
    expect(catalog.targets.filter((t) => t.availability.privacyClass === "hosted")).toEqual([]);
  });
});
