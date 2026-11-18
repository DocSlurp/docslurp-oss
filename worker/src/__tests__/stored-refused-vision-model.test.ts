import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVisionConfig, normalizeStoredPipelineFeatures, type VisionConfig } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { UnpricedVisionRouteError } from "../lib/vision-pricing.js";
import type { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";

const { providerFetch } = vi.hoisted(() => ({ providerFetch: vi.fn() }));
vi.mock("../lib/provider-retry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/provider-retry.js")>()),
  fetchWithProviderRetry: providerFetch,
}));

/** A catalog vision model that is refused today (no stated US or EU hosting region). */
const REFUSED = "llm://openai/gpt-4.1-mini";
const config = { ...fromEnv(), openRouterApiKey: "test-key", openAiApiKey: "test-key" };

afterEach(() => vi.restoreAllMocks());

describe("a run whose stored pipeline names a refused vision model", () => {
  it("reads with the default model, so the run never selects the refused one", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The run-row read used by the worker (db/store.ts): same shared reader as the server.
    for (const vision of [
      { modelUri: REFUSED, remoteFallbackModelUri: REFUSED },
      { model: "gpt-4.1-mini", runtime: "remote-openai", baseUrl: null, remoteFallbackModel: "gpt-4.1-mini" },
    ]) {
      const pipeline = normalizeStoredPipelineFeatures({ vision } as never, "run r1");
      expect(pipeline.vision.modelUri).toBe(defaultVisionConfig.modelUri);
      expect(pipeline.vision.remoteFallbackModelUri).toBeNull();
    }
  });

  it("is still refused at call time when a config reaches the runtime without the schema, and nothing is sent", async () => {
    for (const vision of [
      { ...defaultVisionConfig, modelUri: REFUSED, target: "hosted" },
      { ...defaultVisionConfig, remoteFallbackModelUri: REFUSED },
    ] as VisionConfig[]) {
      await expect(executeVisionRuntime({
        imagePath: "/nonexistent.png",
        outputPath: "/nonexistent.json",
        gate: null,
        vision,
        cfg: config,
        runner: {} as CommandRunner,
        privacyMode: "standard",
      })).rejects.toBeInstanceOf(UnpricedVisionRouteError);
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
