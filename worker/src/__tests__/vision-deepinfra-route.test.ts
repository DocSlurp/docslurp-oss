import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEEPINFRA_VISION_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN3_VL_30B_DEEPINFRA_VISION_MODEL,
  resolveVisionRoute,
  visionConfigSchema,
  visionImageTokens,
  visionListPriceCents,
  visionModelUriProblem,
  type VisionConfig,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, resetVisionPendingOverrunsForTest } from "../lib/vision-attempt-guard.js";
import {
  isBilledVisionRoute,
  isDeepInfraVisionBaseUrl,
  priceVisionServedUsage,
  readDeepInfraVisionCharge,
  UnpricedVisionRouteError,
  visionImageTokenBound,
  visionInputTokenBound,
  visionLedgerProvider,
  visionRequestPricing,
  visionRouteBilling,
} from "../lib/vision-pricing.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, resolveVisionApiKey, visionMaxOutputTokens } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

const MODEL = QWEN3_VL_30B_DEEPINFRA_VISION_MODEL;
const URI = `llm://deepinfra/${MODEL}`;
const cfg = {
  openRouterApiKey: "or-key", openAiApiKey: "sk-test", deepInfraApiKey: "di-key", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;
const route = (baseUrl: string) => ({ runtime: "openai-compatible", baseUrl, provider: "deepinfra" });

let warnings: string[];
let calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }>;

beforeEach(() => {
  warnings = [];
  calls = [];
  resetVisionPendingOverrunsForTest();
  resetStreamingSupportForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(usage: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({
      model: MODEL, choices: [{ message: { content: "# Page\n\nText" }, finish_reason: "stop" }], usage,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

async function pageImage() {
  const dir = await mkdtemp(join(tmpdir(), "deepinfra-vision-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

async function read(vision: VisionConfig, privacyMode: "standard" | "local-only" = "standard") {
  const imagePath = await pageImage();
  return executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, gate: null, vision, cfg, runner: new CommandRunner(), privacyMode });
}

describe("DeepInfra vision route billing classification", () => {
  it("classifies exactly DeepInfra's official endpoint as the billed `deepinfra` route", () => {
    expect(DEEPINFRA_VISION_BASE_URL).toBe("https://api.deepinfra.com/v1/openai");
    for (const url of [DEEPINFRA_VISION_BASE_URL, `${DEEPINFRA_VISION_BASE_URL}/`, "https://API.DeepInfra.com/v1/openai", "https://api.deepinfra.com:443/v1/openai"]) {
      expect(isDeepInfraVisionBaseUrl(url), url).toBe(true);
      expect(visionRouteBilling(route(url), cfg), url).toBe("deepinfra");
    }
    expect(isBilledVisionRoute("deepinfra")).toBe(true);
    expect(visionLedgerProvider("deepinfra")).toBe("deepinfra");
  });

  it("never classifies a look-alike destination as DeepInfra, and gives it no key", () => {
    for (const url of [
      "https://api.deepinfra.com.evil.test/v1/openai",
      "http://api.deepinfra.com/v1/openai",
      "https://api.deepinfra.com/v1/inference",
      "https://api.deepinfra.com/v1/openai/../../evil",
      "https://api.deepinfra.com:8443/v1/openai",
      "https://user:pw@api.deepinfra.com/v1/openai",
      "https://api.deepinfra.com/v1/openai?x=1",
      "https://evil.test/api.deepinfra.com/v1/openai",
      "https://deepinfra.com/v1/openai",
    ]) {
      expect(isDeepInfraVisionBaseUrl(url), url).toBe(false);
      const billing = visionRouteBilling(route(url), cfg);
      expect(billing, url).toBe("unknown-hosted");
      expect(resolveVisionApiKey(billing, url, cfg), url).toBe("");
    }
  });

  it("attaches the DeepInfra key only to DeepInfra, and the OpenRouter key never to DeepInfra (and vice versa)", () => {
    expect(resolveVisionApiKey("deepinfra", DEEPINFRA_VISION_BASE_URL, cfg)).toBe("di-key");
    expect(resolveVisionApiKey("deepinfra", `${DEEPINFRA_VISION_BASE_URL}/`, cfg)).toBe("di-key");
    // Billing and destination must agree: a mismatched pair gets no key.
    expect(resolveVisionApiKey("deepinfra", OPENROUTER_BASE_URL, cfg)).toBe("");
    expect(resolveVisionApiKey("openrouter", DEEPINFRA_VISION_BASE_URL, cfg)).toBe("");
    expect(resolveVisionApiKey("openrouter", OPENROUTER_BASE_URL, cfg)).toBe("or-key");
    expect(resolveVisionApiKey("deepinfra", DEEPINFRA_VISION_BASE_URL, { ...cfg, deepInfraApiKey: undefined })).toBe("");
  });
});

describe("DeepInfra vision route resolution", () => {
  it("resolves the cataloged URI to the fixed DeepInfra endpoint as a hosted route", () => {
    expect(visionModelUriProblem(URI)).toBeNull();
    const config = visionConfigSchema.parse({ modelUri: URI });
    expect(config.target).toBe("hosted");
    expect(resolveVisionRoute(config)).toMatchObject({ provider: "deepinfra", runtime: "openai-compatible", model: MODEL, baseUrl: DEEPINFRA_VISION_BASE_URL });
  });

  it("refuses a project baseUrl on a deepinfra URI, and ignores it if one reaches the resolver", () => {
    const evil = `${URI}?baseUrl=${encodeURIComponent("https://evil.test/v1")}`;
    expect(visionModelUriProblem(evil)).toMatch(/baseUrl overrides are only supported for local model providers/);
    expect(visionConfigSchema.safeParse({ modelUri: evil }).success).toBe(false);
    const forced = resolveVisionRoute({ ...visionConfigSchema.parse({ modelUri: URI }), modelUri: evil });
    expect(forced.baseUrl).toBe(DEEPINFRA_VISION_BASE_URL);
  });

  it("refuses uncataloged DeepInfra models", () => {
    expect(visionModelUriProblem("llm://deepinfra/Qwen/Qwen3-VL-235B-A22B-Instruct")).toMatch(/priced vision catalog/);
    expect(visionModelUriProblem("llm://deepinfra/acme/vl-pro")).toMatch(/Pro\/Ultra/);
  });
});

describe("DeepInfra vision pricing", () => {
  it("prices tokens at the verified DeepInfra list price ($0.15/M input, $0.60/M output)", () => {
    // The benchmark page: 2,179 input + 746 output tokens = 0.0775 cents (0.77 dollars per 1,000 pages).
    expect(visionListPriceCents(MODEL, { inputTokens: 2_179, outputTokens: 746 })).toBeCloseTo((2_179 * 0.15 + 746 * 0.6) / 1e4, 12);
    const served = { billing: "deepinfra" as const, model: MODEL };
    expect(priceVisionServedUsage(served, cfg, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(75, 9);
  });

  it("weighs a request by tokens alone, with no OpenRouter max_price, and refuses an unpriced model", () => {
    const inputTokens = visionInputTokenBound(null, "", MODEL);
    const pricing = visionRequestPricing({ model: MODEL, runtime: "openai-compatible", billing: "deepinfra", inputTokens, imageTokens: visionImageTokenBound(null, MODEL) });
    expect(pricing.maxPrice).toBeNull();
    expect(pricing.weightCents).toBeCloseTo((inputTokens * 0.15 + visionMaxOutputTokens(MODEL) * 0.6) / 1e4, 12);
    expect(() => visionRequestPricing({ model: "acme/uncataloged-vl", runtime: "openai-compatible", billing: "deepinfra", inputTokens: 1_000 })).toThrow(UnpricedVisionRouteError);
  });

  it("bounds image tokens at one per 32-px cell plus framing, and the largest raster when the size is unknown", () => {
    expect(visionImageTokens(MODEL, { widthPx: 1_700, heightPx: 2_200 })).toBe(54 * 69 + 2);
    expect(visionImageTokens(MODEL, { widthPx: 10, heightPx: 10 })).toBe(180 + 2);
    expect(visionImageTokens(MODEL, null)).toBe(128 * 128 + 2);
  });

  it("honours DeepInfra's reported estimated_cost within the dispute tolerance, never usage.cost", () => {
    const tokens = { prompt_tokens: 2_179, completion_tokens: 746 };
    const list = visionListPriceCents(MODEL, { inputTokens: 2_179, outputTokens: 746 })!;
    const charge = readDeepInfraVisionCharge(MODEL, { ...tokens, estimated_cost: 0.000770 });
    expect(charge.costCents).toBeCloseTo(0.077, 10);
    expect(charge.metadata).toMatchObject({ costSource: "provider", reportedField: "estimated_cost" });
    // An OpenRouter-style `cost` is not DeepInfra's charge field.
    expect(readDeepInfraVisionCharge(MODEL, { ...tokens, cost: 5 })).toEqual({});
    expect(readDeepInfraVisionCharge(MODEL, { ...tokens, estimated_cost: -1 })).toEqual({});
    expect(readDeepInfraVisionCharge(MODEL, null)).toEqual({});
    // Disputed (far from list): not recorded; the tokens are priced at list instead.
    expect(readDeepInfraVisionCharge(MODEL, { ...tokens, estimated_cost: (list * 3) / 100 })).toEqual({});
    expect(readDeepInfraVisionCharge(MODEL, { ...tokens, estimated_cost: 0 })).toEqual({});
    expect(warnings.filter((line) => line.includes("disputed provider charge model=Qwen/Qwen3-VL-30B-A3B-Instruct provider=deepinfra"))).toHaveLength(2);
    expect(readDeepInfraVisionCharge("acme/unpriced", { ...tokens, estimated_cost: 0.001 })).toEqual({});
  });
});

describe("DeepInfra vision requests", () => {
  it("sends to DeepInfra with only the DeepInfra key and no OpenRouter fields, and records its reported charge", async () => {
    stubFetch({ prompt_tokens: 2_179, completion_tokens: 746, estimated_cost: 0.00077 });
    const result = await read(visionConfigSchema.parse({ modelUri: URI }));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(call.headers.authorization).toBe("Bearer di-key");
    expect(JSON.stringify(call.headers)).not.toContain("or-key");
    expect(JSON.stringify(call.headers)).not.toContain("sk-test");
    expect(call.body.model).toBe(MODEL);
    for (const key of ["provider", "max_price", "reasoning", "transforms", "models"]) expect(call.body, key).not.toHaveProperty(key);
    expect(result).toMatchObject({ inputTokens: 2_179, outputTokens: 746, usageSource: "provider", route: { provider: "deepinfra", model: MODEL, billing: "deepinfra", baseUrl: DEEPINFRA_VISION_BASE_URL } });
    expect(result.costCents).toBeCloseTo(0.077, 10);
  });

  it("without a reported charge, leaves the tokens to be priced at list on the served route", async () => {
    stubFetch({ prompt_tokens: 2_179, completion_tokens: 746 });
    const result = await read(visionConfigSchema.parse({ modelUri: URI }));
    expect(result.costCents).toBeUndefined();
    expect(priceVisionServedUsage(result.route, cfg, result)).toBeCloseTo(visionListPriceCents(MODEL, { inputTokens: 2_179, outputTokens: 746 })!, 12);
  });

  it("is refused outside the standard privacy mode before anything is sent", async () => {
    stubFetch({ prompt_tokens: 1, completion_tokens: 1 });
    await expect(read(visionConfigSchema.parse({ modelUri: URI }), "local-only")).rejects.toThrow(/privacy mode/i);
    expect(calls).toHaveLength(0);
  });

  it("logs and tops up an over-bound DeepInfra response through the guard's overrun path", async () => {
    const backend = new MemoryVisionAttemptBackend();
    stubFetch({ prompt_tokens: 400_000, completion_tokens: 300 });
    const vision = visionConfigSchema.parse({ modelUri: URI });
    const imagePath = await pageImage();
    const outcome = await guardedVisionCall({
      host: { run: { id: "run-org-1", orgId: "org-1" }, visionAttempts: backend },
      vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" },
      record: () => null,
      call: (gate) => executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate }),
    });
    expect(outcome.admitted).toBe(true);
    const billed = visionListPriceCents(MODEL, { inputTokens: 400_000, outputTokens: 300 })!;
    const line = warnings.find((warning) => warning.startsWith("[vision-weight] overrun"));
    expect(line).toContain(`model=${MODEL} provider=deepinfra`);
    expect(line).toContain(`billed=${billed.toFixed(4)}`);
    expect(backend.orgCents("org-1")).toBeCloseTo(billed, 3);
  });
});
