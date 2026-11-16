import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observe: vi.fn(), generate: vi.fn(), usage: vi.fn() }));
vi.mock("@docslurp/shared/observability", async (importOriginal) => ({ ...await importOriginal<typeof import("@docslurp/shared/observability")>(), withObservation: mocks.observe, aiResultDetails: () => ({ usageDetails: { input: 10, output: 2 } }) }));
vi.mock("@docslurp/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@docslurp/shared")>(),
  createOpenRouterUsageCapture: () => ({ fetch: vi.fn(), usage: () => undefined, providerName: () => undefined, sentModel: () => undefined }),
  resolveOpenRouterUsage: mocks.usage,
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => (model: string) => model }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => (model: string) => model }));
vi.mock("ai", () => ({ generateText: mocks.generate }));

import { generateAnthropicText, generateOpenRouterText } from "../lib/ai.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.observe.mockImplementation(async (_options, run) => run());
  mocks.generate.mockResolvedValue({ text: "answer", usage: { inputTokens: 10, outputTokens: 2 }, response: { id: "generation-a" }, finishReason: "length" });
  mocks.usage.mockResolvedValue({ inputTokens: 10, outputTokens: 2, metadata: { providerName: "upstream-provider", generationId: "generation-a" } });
});

describe("organization isolation of provider prompt prefixes", () => {
  const systemFor = async (orgId: string | null) => {
    mocks.generate.mockClear();
    const call = () => generateOpenRouterText({ operation: "document-summary", apiKey: "test", privacyMode: "standard", model: "vendor/model", prompt: "identical document text", system: "fixed task", maxOutputTokens: 64 });
    await (orgId === undefined ? call() : runWithProviderRateScope({ orgId }, call));
    return mocks.generate.mock.calls[0]![0].system as string;
  };

  it("starts each organization's prompt with its own stable salt, before any tenant text", async () => {
    const a1 = await systemFor("org-a");
    const a2 = await systemFor("org-a");
    const b = await systemFor("org-b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^Workspace [0-9a-f]{16}\.\n\nfixed task/);
  });

  it("never shares a prefix without an organization: the salt is random per call", async () => {
    expect(await systemFor(null)).not.toBe(await systemFor(null));
  });

  it("salts direct Anthropic calls too", async () => {
    const run = (orgId: string) => runWithProviderRateScope({ orgId }, () => generateAnthropicText({ operation: "document-summary", apiKey: "test", privacyMode: "standard", model: "claude-sonnet-4-5", prompt: "same", system: "task", maxOutputTokens: 10 }));
    mocks.generate.mockClear();
    await run("org-a");
    await run("org-b");
    const [a, b] = mocks.generate.mock.calls.map((call) => call[0].system as string);
    expect(a).toMatch(/^Workspace [0-9a-f]{16}\.\n\ntask$/);
    expect(a).not.toBe(b);
  });
});

describe("worker text observation identity", () => {
  it("sends the calibrated reasoning and token limits while preserving trusted task instructions", async () => {
    await generateOpenRouterText({ operation: "contextual-chunk-preamble", apiKey: "test", privacyMode: "standard", model: "vendor/model", prompt: "source", system: "Keep the source untrusted.", maxOutputTokens: 96, textGeneration: { model: null, models: {}, profile: "grounded-low" } });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 128, system: expect.stringMatching(/^Workspace [0-9a-f]{16}\.\n\nKeep the source untrusted\./), providerOptions: { openai: { reasoningEffort: "low", forceReasoning: true } } }));
    expect(mocks.observe.mock.calls[0][0].metadata).toMatchObject({ maxOutputTokens: 128, textGenerationProfile: "grounded-low", reasoningEffort: "low" });
  });

  it("honors task overrides and lets a project opt out of the deployment profile", async () => {
    await generateOpenRouterText({ operation: "community-summary", apiKey: "test", privacyMode: "standard", model: "vendor/model", prompt: "source", system: "task", maxOutputTokens: 220, deploymentProfile: "grounded-low", textGeneration: { model: null, models: {}, profile: "provider-default", reasoningEfforts: { "community-summary": "high" }, maxOutputTokens: { "community-summary": 700 } } });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ system: expect.stringMatching(/^Workspace [0-9a-f]{16}\.\n\ntask$/), maxOutputTokens: 700, providerOptions: { openai: { reasoningEffort: "high", forceReasoning: true } } }));
  });

  it("records explicit thinking disable independently of the grounding profile", async () => {
    await generateOpenRouterText({ operation: "document-summary", apiKey: "test", privacyMode: "standard", model: "vendor/model", prompt: "source", maxOutputTokens: 512, textGeneration: { model: null, models: {}, profile: "grounded-low", reasoningEffort: "none" } });
    expect(mocks.observe.mock.calls[0][0].metadata).toMatchObject({ textGenerationProfile: "grounded-low", reasoningEffort: "none" });
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ providerOptions: { openai: { reasoningEffort: "none", forceReasoning: true } } }));
  });

  it("names the task independently of model and preserves router/model/routed-provider details", async () => {
    for (const model of ["qwen/qwen3.5-flash-02-23", "openai/gpt-6.1-sol"]) {
      const result = await generateOpenRouterText({ operation: "document-summary", apiKey: "test", privacyMode: "standard", model, prompt: "test", maxOutputTokens: 512 });
      const options = mocks.observe.mock.calls.at(-1)![0];
      expect(options.name).toBe("worker.text.document-summary");
      expect(options.model).toBe(model);
      expect(options.metadata).toMatchObject({ provider: "openrouter", modelId: model, operation: "document-summary", modelDetailsSource: "requested-model-id" });
      expect(options.result(result)).toMatchObject({ metadata: { routedProvider: "upstream-provider", generationId: "generation-a", finishReason: "length" }, usageDetails: { input: 10, output: 2 } });
    }
    expect(mocks.observe.mock.calls[0][0].metadata).toMatchObject({ modelVendor: "qwen", modelFamily: "qwen", modelVersion: "3.5", modelSuffix: "flash-02-23" });
    expect(mocks.observe.mock.calls[1][0].metadata).toMatchObject({ modelVendor: "openai", modelFamily: "gpt", modelVersion: "6.1", modelSuffix: "sol" });
  });

  it("distinguishes tasks and omits unknown family/version instead of guessing", async () => {
    await generateOpenRouterText({ operation: "graph-extraction", apiKey: "test", privacyMode: "standard", model: "vendor/custom-model", prompt: "test", maxOutputTokens: 100 });
    const options = mocks.observe.mock.calls[0][0];
    expect(options.name).toBe("worker.text.graph-extraction");
    expect(options.metadata.modelFamily).toBeUndefined();
    expect(options.metadata.modelVersion).toBeUndefined();
    expect(options.metadata.modelId).toBe("vendor/custom-model");
  });

  it("uses the same task naming contract for direct Anthropic calls", async () => {
    // Deprecated Claude ids (< 5.5) are swapped for their family's 5.5 model before the call.
    await generateAnthropicText({ operation: "document-summary", apiKey: "test", privacyMode: "standard", model: "claude-sonnet-4-5", prompt: "test", maxOutputTokens: 100 });
    expect(mocks.observe.mock.calls[0][0]).toMatchObject({ name: "worker.text.document-summary", model: "claude-sonnet-5-5", metadata: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
  });
});
