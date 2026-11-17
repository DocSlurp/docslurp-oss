import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISTINCT_TEST_PRICING, installTestPricing, resetActiveCapabilityPoolsForTests, resetPricingProviderForTests, visionConfigSchema, visionModelUriProblem, visionProfileCatalog } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import { MemoryVisionAttemptBackend } from "../lib/vision-attempt-guard.js";
import { isVisionModelRefusal, shouldFailOpenVisionError } from "../stages/vision-extract.js";
import { VISION_MODEL_PROFILES } from "../tools/vision-model-profiles.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, VisionRouteRegionError } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";
import { visionStatusForOutcome } from "../pipeline/page-facts.js";

const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", deepInfraApiKey: "di-key", openAiBaseUrl: "https://api.openai.com/v1", visionStreaming: false } as Config;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

let bodies: Array<Record<string, any>>;
beforeEach(() => {
  resetStreamingSupportForTest();
  resetActiveCapabilityPoolsForTests();
  bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(JSON.stringify({ model: body.model, provider: "Wafer", choices: [{ message: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 3_000, completion_tokens: 300 } }),
      { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPricingProviderForTests();
});

/** One in-run vision call (a gate), shaped like each caller of the runtime. */
async function call(modelUri: string, shape: Record<string, unknown>, remoteFallbackModelUri?: string, scope?: { speedBoost?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "pool-region-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, PNG);
  const vision = { ...visionConfigSchema.parse({ modelUri: "llm://openrouter/openai/gpt-6-luna" }), modelUri, remoteFallbackModelUri: remoteFallbackModelUri ?? null };
  const host = { run: { id: "run-1", orgId: "org-a" }, visionAttempts: new MemoryVisionAttemptBackend() };
  const run = () => guardedVisionCall({
    host, vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" }, record: () => null,
    call: (gate) => executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate, ...shape }),
  }).catch((error: unknown) => error);
  return await runWithProviderRateScope({ orgId: "org-a", allowChinaProviders: true, speedBoost: scope?.speedBoost === true }, run);
}

/** Haiku's region allowlist removed for the duration of `fn` (an unproven route that still passes the catalog). */
async function withoutHaikuAllowlist<T>(fn: () => Promise<T>): Promise<T> {
  const profiles = VISION_MODEL_PROFILES as Record<string, unknown>;
  const saved = profiles["anthropic/claude-haiku-5.5"];
  delete profiles["anthropic/claude-haiku-5.5"];
  try {
    return await fn();
  } finally {
    profiles["anthropic/claude-haiku-5.5"] = saved;
  }
}

const HAIKU = "llm://openrouter/anthropic/claude-haiku-5.5";
const PATHS: Array<[string, Record<string, unknown>]> = [
  ["page read (vision-extract)", { pageRead: true }],
  ["chart export", { promptText: "Read this chart as a spec." }],
  ["self-critique", { promptText: "Correct this transcription." }],
  ["document-map OCR", {}],
  ["materialize-pages", {}],
];

describe("every in-run vision call is region-checked, page read or not", () => {
  it.each(PATHS)("%s: refuses a primary route that can reach an unproven host, before sending", async (_label, shape) => {
    const error = await withoutHaikuAllowlist(() => call(HAIKU, shape));
    expect(error).toBeInstanceOf(VisionRouteRegionError);
    expect(bodies).toEqual([]);
  });

  it.each(PATHS)("%s: never fails over to a fallback route that can reach an unproven host", async (_label, shape) => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      // An unbilled routing refusal: the pool's and the project's fallbacks would both fail over on it.
      return new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy and max_price" } }), { status: 404 });
    }));
    const error = await withoutHaikuAllowlist(() => call("llm://openrouter/z-ai/glm-5.3-flash", shape, HAIKU));
    expect(error).toBeInstanceOf(Error);
    expect(bodies.every((body) => body.model === "z-ai/glm-5.3-flash")).toBe(true);
  });

  it("sends a proven route with its evidenced allowlist", async () => {
    await call(HAIKU, { promptText: "Read this chart." });
    expect(bodies[0]!.provider.only).toEqual(["amazon-bedrock/us-east-1", "google-vertex/us"]);
  });
});

describe("speed boost keeps the evidenced allowlist", () => {
  it("a speedBoost run sends `only` = the profile's stated US hosts with the nitro variant", async () => {
    await call("llm://openrouter/z-ai/glm-5.3-flash", { pageRead: true }, undefined, { speedBoost: true });
    // The nitro route is sent as the base model with the speed-boost preferences (throughput ranking, price sort)...
    expect(bodies[0]!.provider).toHaveProperty("preferred_min_throughput");
    // ...but only among the evidenced hosts.
    expect(bodies[0]!.provider.only).toEqual(["wafer/us", "friendli", "inference-net/us"]);
  });
});

describe("models with no evidenced US/EU host", () => {
  it("are refused at validation with a clear reason, and no preset names them", () => {
    for (const uri of ["llm://openrouter/google/gemini-2.5-flash-lite", "llm://openai/gpt-4.1-mini"]) {
      expect(visionModelUriProblem(uri), uri).toMatch(/no endpoint with a stated US or EU hosting region.*choose another vision model/);
    }
    expect(visionProfileCatalog["cheapest-hosted"].config.modelUri).toBe("llm://openrouter/z-ai/glm-5.3-flash");
    for (const preset of Object.values(visionProfileCatalog)) expect(visionModelUriProblem(preset.config.modelUri), preset.label).toBeNull();
  });

  it("a run still carrying one fails open: the page keeps its own text and is recorded as model-refused (guarded)", async () => {
    // A run created before the refusal still names the model: the runtime refuses it before sending.
    const error = await call("llm://openrouter/google/gemini-2.5-flash-lite", { pageRead: true });
    expect(bodies).toEqual([]);
    expect(isVisionModelRefusal(error)).toBe(true);
    expect(shouldFailOpenVisionError(error)).toBe(true);
    expect(shouldFailOpenVisionError(new VisionRouteRegionError("x"))).toBe(true);
    expect(visionStatusForOutcome({ outcome: "model-refused", fallbackText: true })).toBe("guarded");
  });
});

describe("fallback value", () => {
  it("tells the pricing provider whether the caller bills the page (page reads only)", async () => {
    vi.stubEnv("DOCSLURP_VISION_POOL_FALLBACK", "on");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.model === "openai/gpt-6-luna") return new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy and max_price" } }), { status: 404 });
      return new Response(JSON.stringify({ model: body.model, provider: "Wafer", choices: [{ message: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 3_000, completion_tokens: 300 } }),
        { headers: { "content-type": "application/json" } });
    }));
    const values: Array<Record<string, unknown>> = [];
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: (input) => { values.push(input as never); return 1; } });
    await call("llm://openrouter/openai/gpt-6-luna", { pageRead: true });
    expect(values).toEqual([expect.objectContaining({ role: "fallback", primaryBilled: false, billsPage: true })]);
    // A project fallback on a call that does not bill a page (critique): billsPage false.
    values.length = 0;
    await call("llm://openrouter/openai/gpt-6-luna", { promptText: "Correct this." }, "llm://openrouter/z-ai/glm-5.3-flash");
    expect(values).toEqual([expect.objectContaining({ role: "fallback", billsPage: false })]);
  });
});
