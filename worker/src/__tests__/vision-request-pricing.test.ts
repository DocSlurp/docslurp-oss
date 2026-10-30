import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultVisionConfig,
  visionConfigSchema,
  visionImageTokens,
  visionModelCatalog,
  visionModelTokenPricing,
  type VisionConfig,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import { MemoryVisionAttemptBackend, VisionRunGuard, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import {
  isOpenRouterBaseUrl,
  UnpricedVisionRouteError,
  VISION_MAX_PROMPT_BYTES,
  visionImageTokenBound,
  visionInputTokenBound,
  visionRequestPricing,
  visionRouteBilling,
} from "../lib/vision-pricing.js";
import { CommandRunner } from "../tools/runner.js";
import {
  assertVisionPromptSize,
  buildSchemaAwareVisionPrompt,
  executeVisionRuntime,
  SCHEMA_LABEL_MAX_CHARS,
  SCHEMA_LABEL_TOTAL_BYTES,
  visionMaxOutputTokens,
  visionPromptTemplates,
} from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";
import { visionMaxPrice } from "../test/vision-max-price.js";

/**
 * A request's guard weight is priced from what it actually sends (prompt bytes, image size, enforced
 * output cap) and OpenRouter is told not to bill above it.
 */
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const config: VisionGuardConfig = { pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 100_000, throttleAllowance: 5 };
const MODEL = "google/gemini-3.1-flash-lite";

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "Name: x" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  { headers: { "content-type": "application/json" } });

let backend: MemoryVisionAttemptBackend;

beforeEach(() => {
  backend = new MemoryVisionAttemptBackend();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  resetStreamingSupportForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A PNG with only its signature and IHDR (all the weight reads). */
function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** A vision config built without `visionConfigSchema`, as a caller bypassing validation would. */
function unvalidated(modelUri: string, extra: Partial<VisionConfig> = {}): VisionConfig {
  return { ...defaultVisionConfig, modelUri, target: "hosted", ...extra } as VisionConfig;
}

async function read(args: { modelUri: string; prompt?: string; outputSchema?: Record<string, unknown>; image?: Buffer; vision?: VisionConfig }) {
  const dir = await mkdtemp(join(tmpdir(), "vision-pricing-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, args.image ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const guard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, backend);
  const gate = guard.call({ documentId: "doc", pageNumber: 1, purpose: "page" });
  const admit = vi.spyOn(gate, "admit");
  const bodies: Array<Record<string, any>> = [];
  const sends: Array<{ url: string; authorization: string | null }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    sends.push({ url, authorization: new Headers(init.headers).get("authorization") });
    bodies.push(JSON.parse(String(init.body)));
    return ok();
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const result = await executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`,
      vision: args.vision ?? visionConfigSchema.parse({ modelUri: args.modelUri, ...(args.prompt ? { prompt: args.prompt } : {}) }),
      outputSchema: args.outputSchema ?? null, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
    }).catch((error: unknown) => error);
    return { result, fetch, bodies, sends, weights: admit.mock.calls.map(([request]) => request?.weightCents) };
  } finally {
    await gate.finish();
  }
}

const schemaOf = (labels: string[]) => ({ type: "object", properties: Object.fromEntries(labels.map((label) => [label, { type: "string" }])) });

describe("schema labels in the vision prompt", () => {
  it("bounds a hostile label set by count, length and total bytes", () => {
    const labels = Array.from({ length: 1_000 }, (_, index) => `${index}-${"x".repeat(5_000)}`);
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", schemaOf(labels));
    const sent = JSON.parse(prompt.slice(prompt.indexOf("["), prompt.lastIndexOf("]") + 1)) as string[];
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(100);
    for (const label of sent) expect(Array.from(label).length).toBeLessThanOrEqual(SCHEMA_LABEL_MAX_CHARS);
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThanOrEqual(SCHEMA_LABEL_TOTAL_BYTES + 2);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(VISION_MAX_PROMPT_BYTES);
  });

  it("cuts labels by character, never inside a multi-byte character", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", schemaOf(["請求書番号".repeat(40), "😀".repeat(200)]));
    const sent = JSON.parse(prompt.slice(prompt.indexOf("["), prompt.lastIndexOf("]") + 1)) as string[];
    expect(sent.map((label) => Array.from(label).length)).toEqual([80, 80]);
    expect(sent[1]).toBe("😀".repeat(80));
  });

  it("keeps a normal schema intact", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", schemaOf(["invoice_number", "total"]));
    expect(prompt).toContain('["invoice_number","total"]');
  });
});

describe("request weight from the actual prompt and image", () => {
  it("prices prompt tokens by UTF-8 bytes, so CJK text is not undercounted", () => {
    const cjk = "請求書の合計金額を記入してください。".repeat(100);
    const extra = visionInputTokenBound(null, cjk) - visionInputTokenBound(null, "");
    expect(extra).toBe(Buffer.byteLength(cjk, "utf8"));
    // Three bytes per character: at least one token per character, never chars/3.
    expect(extra).toBeGreaterThanOrEqual(Array.from(cjk).length * 3);
  });

  it("weighs a large label set's request by its real prompt, above the template-only weight", async () => {
    const labels = Array.from({ length: 100 }, (_, index) => `field_${index}_${"y".repeat(60)}`);
    const template = await read({ modelUri: `llm://openrouter/${MODEL}`, prompt: "schema-form-fields" });
    const labelled = await read({ modelUri: `llm://openrouter/${MODEL}`, prompt: "schema-form-fields", outputSchema: schemaOf(labels) });
    const sentPrompt = labelled.bodies[0]!.messages[1].content[0].text as string;
    expect(sentPrompt.length).toBeGreaterThan(visionPromptTemplates["schema-form-fields"].length + 3_000);
    const expected = visionRequestPricing({
      model: MODEL, runtime: "openai-compatible", billing: "openrouter", inputTokens: visionInputTokenBound(null, sentPrompt, MODEL),
    }).weightCents;
    expect(labelled.weights).toEqual([expected]);
    expect(labelled.weights[0]!).toBeGreaterThan(template.weights[0]!);
    expect(backend.orgCents("org-1")).toBeCloseTo(template.weights[0]! + expected, 3);
  });

  it("weighs a small page image by its size and an unreadable one at the largest raster", async () => {
    // A patch-counted model (Gemini 3 counts a fixed number of tokens per image).
    const MODEL = "deepseek/deepseek-v4.1-flash-1017";
    const small = await read({ modelUri: `llm://openrouter/${MODEL}`, image: pngHeader(1_000, 1_400) });
    const unknown = await read({ modelUri: `llm://openrouter/${MODEL}` });
    const prompt = small.bodies[0]!.messages[1].content[0].text as string;
    const at = (image: { widthPx: number; heightPx: number } | null) => visionRequestPricing({
      model: MODEL, runtime: "openai-compatible", billing: "openrouter", inputTokens: visionInputTokenBound(image, prompt, MODEL),
      imageTokens: visionImageTokenBound(image, MODEL),
    }).weightCents;
    expect(small.weights).toEqual([at({ widthPx: 1_000, heightPx: 1_400 })]);
    expect(unknown.weights).toEqual([at(null)]);
    expect(small.weights[0]!).toBeLessThan(unknown.weights[0]!);
  });
});

describe("max_price on OpenRouter bodies", () => {
  it("sends the token prices the weight assumes plus per-image and per-request fee caps", async () => {
    const { bodies, weights } = await read({ modelUri: `llm://openrouter/${MODEL}` });
    const pricing = visionModelTokenPricing(MODEL)!;
    // Gemini 3's largest documented per-image count (ultra_high media resolution).
    const imageUsd = (2_240 * pricing.inputUsdPerMillion) / 1e6;
    expect(bodies[0]!.provider.max_price).toEqual({ prompt: pricing.inputUsdPerMillion, completion: pricing.outputUsdPerMillion, image: imageUsd, request: 0 });
    // The weight is those prices applied to the request's bound, plus one image fee at its cap.
    const prompt = bodies[0]!.messages[1].content[0].text as string;
    const bound = visionInputTokenBound(null, prompt, MODEL);
    expect(weights[0]).toBeCloseTo((bound * pricing.inputUsdPerMillion + visionMaxOutputTokens(MODEL) * pricing.outputUsdPerMillion) / 1e4 + imageUsd * 100, 10);
  });

  it("caps a separate per-request fee at 0 and a per-image fee at the image's token bound", () => {
    // A route that bills $0.01 per request or a per-image fee above the catalog bound is excluded by OpenRouter.
    for (const spec of visionModelCatalog) {
      if (!spec.tokenPricing || !spec.uri.startsWith("llm://openrouter/")) continue;
      const cap = visionMaxPrice(spec.id);
      expect(cap.request).toBe(0);
      expect(cap.image).toBeGreaterThan(0);
      expect(cap.image).toBeCloseTo((visionImageTokens(spec.id, null)! * spec.tokenPricing.inputUsdPerMillion) / 1e6, 12);
    }
  });

  it("is never sent to non-OpenRouter routes", async () => {
    const { bodies } = await read({ modelUri: "llm://openai/gpt-4.1-mini" });
    expect(bodies[0]!.provider).toBeUndefined();
  });
});

describe("image-token bounds from each provider's own formula", () => {
  it("gpt-4.1-mini: OpenAI 32-px patches times 1.62, a 2048x2048 page at least 6,636 tokens", () => {
    const patches = (2_048 / 32) * (2_048 / 32);
    expect(Math.ceil(patches * 1.62)).toBe(6_636);
    expect(visionImageTokenBound({ widthPx: 2_048, heightPx: 2_048 }, "gpt-4.1-mini")).toBeGreaterThanOrEqual(6_636);
    // The request's input bound covers the image and the prompt.
    expect(visionInputTokenBound({ widthPx: 2_048, heightPx: 2_048 }, "x".repeat(500), "gpt-4.1-mini")).toBeGreaterThanOrEqual(6_636 + 500);
    // Odd sizes round each side up to whole patches: 1000x1400 is 32 x 44 patches.
    expect(visionImageTokenBound({ widthPx: 1_000, heightPx: 1_400 }, "gpt-4.1-mini")).toBeGreaterThanOrEqual(Math.ceil(32 * 44 * 1.62));
  });

  it("Gemini 3.1 Flash Lite: at least the default 1,120 tokens per image, up to ultra_high's 2,240", () => {
    expect(visionImageTokenBound({ widthPx: 1_000, heightPx: 1_400 }, "google/gemini-3.1-flash-lite")).toBeGreaterThanOrEqual(2_240);
  });

  it("Gemini 2.5 Flash Lite: at least 258 tokens per 768-px tile", () => {
    const tiles = Math.ceil(2_048 / 768) * Math.ceil(2_048 / 768);
    expect(visionImageTokenBound({ widthPx: 2_048, heightPx: 2_048 }, "google/gemini-2.5-flash-lite")).toBeGreaterThanOrEqual(tiles * 258);
  });

  it("open-weights models: at least one token per 28-px merged ViT patch (Qwen2.5-VL family)", () => {
    for (const model of ["deepseek/deepseek-v4.1-flash-1017", "xiaomi/mimo-v2.6-flash", "z-ai/glm-5.3-flash", "nvidia/nemotron-3.5-super-vl"]) {
      expect(visionImageTokenBound({ widthPx: 2_048, heightPx: 2_048 }, model)).toBeGreaterThanOrEqual(Math.ceil(2_048 / 28) ** 2);
    }
  });

  it("every priced catalog model has a bound, and an unknown size takes the largest raster", () => {
    for (const spec of visionModelCatalog) {
      if (!spec.tokenPricing) continue;
      const unknown = visionImageTokens(spec.id, null);
      expect(unknown, spec.id).not.toBeNull();
      expect(unknown!).toBeGreaterThanOrEqual(visionImageTokens(spec.id, { widthPx: 4_000, heightPx: 4_000 })!);
    }
  });
});

describe("hosted vision is limited to the priced catalog", () => {
  const refusedAtValidation = [
    "llm://acme/o3-pro",
    "llm://acme/plain-vl",
    "llm://anthropic/gpt-5-pro",
    "llm://huggingface/Qwen/Qwen2.5-VL-7B-Instruct",
    "llm://transformers.js/Xenova/vit",
    "llm://openai/gpt-unlisted-vision",
    "llm://openrouter/someone/unlisted-vl",
    "llm://openrouter/openai/o3-pro",
    "llm://openrouter/openai/gpt-5-pro-2025-10-06",
    "llm://vllm/acme/vision-ultra",
  ];

  it.each(refusedAtValidation)("refuses %s as a model and as a fallback at config validation", (uri) => {
    expect(visionConfigSchema.safeParse({ modelUri: uri }).success).toBe(false);
    expect(visionConfigSchema.safeParse({ modelUri: "llm://local-cli/microsoft/Florence-2-base-ft", remoteFallbackModelUri: uri }).success).toBe(false);
  });

  it("accepts every priced catalog model, local servers and private routes", () => {
    for (const spec of visionModelCatalog) expect(visionConfigSchema.safeParse({ modelUri: spec.uri }).success, spec.uri).toBe(true);
    expect(visionConfigSchema.safeParse({ modelUri: "llm://vllm/acme/plain-vl" }).success).toBe(true);
    expect(visionConfigSchema.safeParse({ modelUri: "llm://ollama/llava?baseUrl=http://127.0.0.1:11434/v1" }).success).toBe(true);
    expect(visionConfigSchema.safeParse({ modelUri: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8" }).success).toBe(true);
  });

  it.each(["llm://acme/o3-pro", "llm://anthropic/gpt-5-pro", "llm://huggingface/Qwen/Qwen2.5-VL-7B-Instruct", "llm://openrouter/someone/unlisted-vl", "llm://openai/gpt-unlisted-vision"])(
    "refuses an unvalidated %s config at run time: zero sends, zero weight",
    async (uri) => {
      const { result, fetch, weights } = await read({ modelUri: uri, vision: unvalidated(uri) });
      expect(result).toBeInstanceOf(UnpricedVisionRouteError);
      expect(fetch).not.toHaveBeenCalled();
      expect(weights).toEqual([]);
      expect(backend.orgCents("org-1")).toBe(0);
    },
  );

  it.each(["llm://acme/o3-pro", "llm://anthropic/gpt-5-pro", "llm://openrouter/someone/unlisted-vl"])(
    "refuses an unvalidated fallback %s before the primary route sends",
    async (uri) => {
      const vision = unvalidated("llm://vllm/acme/plain-vl", { remoteFallbackModelUri: uri, target: "local" });
      const { result, fetch, weights } = await read({ modelUri: vision.modelUri, vision });
      expect(result).toBeInstanceOf(UnpricedVisionRouteError);
      expect(fetch).not.toHaveBeenCalled();
      expect(weights).toEqual([]);
    },
  );

  it("decides billing from the effective destination, never a substring or the provider name", () => {
    const at = (baseUrl: string | null, runtime = "openai-compatible") => visionRouteBilling({ runtime, baseUrl }, cfg);
    // No base URL is api.openai.com: billed, never "self-hosted".
    expect(at(null)).toBe("openai");
    expect(visionRouteBilling({ runtime: "openai-compatible", baseUrl: null }, { openAiBaseUrl: "https://gateway.example/v1" })).toBe("unknown-hosted");
    expect(at("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(at("https://openrouter.ai.evil.example/api/v1")).toBe("unknown-hosted");
    expect(at("https://evil.example/openrouter.ai/v1")).toBe("unknown-hosted");
    expect(isOpenRouterBaseUrl("https://evil.example/?h=openrouter.ai")).toBe(false);
    expect(at("http://127.0.0.1:8000/v1")).toBe("loopback");
    expect(at("http://[::1]:8000/v1")).toBe("loopback");
    expect(at(null, "local-cli")).toBe("local");
    expect(visionRouteBilling({ runtime: "openai-compatible", baseUrl: "https://gpu1.internal/v1", provider: "private" }, cfg)).toBe("private");
    expect(() => visionRequestPricing({ model: "x/y", runtime: "openai-compatible", billing: "unknown-hosted", inputTokens: 1 })).toThrow(UnpricedVisionRouteError);
  });

  it("sends the OpenAI key only to the OpenAI base URL: a loopback server gets no key", async () => {
    const local = await read({ modelUri: "llm://vllm/acme/plain-vl" });
    expect(local.sends).toHaveLength(1);
    expect(local.sends[0]!.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(local.sends[0]!.authorization).toBeNull();
  });

  it("sends the OpenAI key to the OpenAI base URL and the OpenRouter key to OpenRouter", async () => {
    const openai = await read({ modelUri: "llm://openai/gpt-4.1-mini" });
    expect(openai.sends[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(openai.sends[0]!.authorization).toBe("Bearer sk-test");
    backend = new MemoryVisionAttemptBackend();
    const openrouter = await read({ modelUri: `llm://openrouter/${MODEL}` });
    expect(openrouter.sends[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(openrouter.sends[0]!.authorization).toBe("Bearer or-key");
  });

  it("refuses an uncataloged model on any billed route in the pricing itself", () => {
    for (const billing of ["openai", "openrouter"] as const) {
      expect(() => visionRequestPricing({ model: "someone/unlisted-vl", runtime: "openai-compatible", billing, inputTokens: 3_000 }))
        .toThrow(UnpricedVisionRouteError);
    }
  });

  it("keeps a local runtime cheap", () => {
    expect(visionRequestPricing({ model: "microsoft/Florence-2-base-ft", runtime: "local-cli", billing: "local", inputTokens: 1e6 }))
      .toEqual({ weightCents: 2, maxPrice: null });
  });
});

describe("oversized prompts", () => {
  it("refuses a prompt over 16 KB before admission", () => {
    expect(() => assertVisionPromptSize("x".repeat(VISION_MAX_PROMPT_BYTES))).not.toThrow();
    expect(() => assertVisionPromptSize("x".repeat(VISION_MAX_PROMPT_BYTES + 1))).toThrow(/over the 16384-byte limit/);
    // Measured in UTF-8 bytes: 5,462 three-byte characters are over the limit.
    expect(() => assertVisionPromptSize("請".repeat(5_462))).toThrow(/refusing to send/);
  });
});
