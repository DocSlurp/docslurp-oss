import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, visionModelCatalog, visionModelTokenPricing } from "@docslurp/shared";

import type { Config } from "../config.js";
import { MemoryVisionAttemptBackend, VisionRunGuard, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import {
  maxCatalogVisionTokenPricing,
  UnpricedVisionRouteError,
  VISION_MAX_PROMPT_BYTES,
  visionInputTokenBound,
  visionRequestPricing,
} from "../lib/vision-pricing.js";
import { CommandRunner } from "../tools/runner.js";
import {
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

async function read(args: { modelUri: string; prompt?: string; outputSchema?: Record<string, unknown>; image?: Buffer }) {
  const dir = await mkdtemp(join(tmpdir(), "vision-pricing-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, args.image ?? Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const guard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, backend);
  const gate = guard.call({ documentId: "doc", pageNumber: 1, purpose: "page" });
  const admit = vi.spyOn(gate, "admit");
  const bodies: Array<Record<string, any>> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return ok();
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const result = await executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`,
      vision: visionConfigSchema.parse({ modelUri: args.modelUri, ...(args.prompt ? { prompt: args.prompt } : {}) }),
      outputSchema: args.outputSchema ?? null, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
    }).catch((error: unknown) => error);
    return { result, fetch, bodies, weights: admit.mock.calls.map(([request]) => request?.weightCents) };
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
      model: MODEL, runtime: "openai-compatible", billable: true, openRouter: true, inputTokens: visionInputTokenBound(null, sentPrompt),
    }).weightCents;
    expect(labelled.weights).toEqual([expected]);
    expect(labelled.weights[0]!).toBeGreaterThan(template.weights[0]!);
    expect(backend.orgCents("org-1")).toBeCloseTo(template.weights[0]! + expected, 3);
  });

  it("weighs a small page image by its size and an unreadable one at the largest raster", async () => {
    const small = await read({ modelUri: `llm://openrouter/${MODEL}`, image: pngHeader(1_000, 1_400) });
    const unknown = await read({ modelUri: `llm://openrouter/${MODEL}` });
    const prompt = small.bodies[0]!.messages[1].content[0].text as string;
    const at = (image: { widthPx: number; heightPx: number } | null) => visionRequestPricing({
      model: MODEL, runtime: "openai-compatible", billable: true, openRouter: true, inputTokens: visionInputTokenBound(image, prompt),
    }).weightCents;
    expect(small.weights).toEqual([at({ widthPx: 1_000, heightPx: 1_400 })]);
    expect(unknown.weights).toEqual([at(null)]);
    expect(small.weights[0]!).toBeLessThan(unknown.weights[0]!);
  });
});

describe("max_price on OpenRouter bodies", () => {
  it("sends the price the weight assumes, in USD per million prompt and completion tokens", async () => {
    const { bodies, weights } = await read({ modelUri: `llm://openrouter/${MODEL}` });
    const pricing = visionModelTokenPricing(MODEL)!;
    expect(bodies[0]!.provider.max_price).toEqual({ prompt: pricing.inputUsdPerMillion, completion: pricing.outputUsdPerMillion });
    // The weight is exactly those prices applied to the request's bound.
    const prompt = bodies[0]!.messages[1].content[0].text as string;
    const bound = visionInputTokenBound(null, prompt);
    expect(weights[0]).toBeCloseTo((bound * pricing.inputUsdPerMillion + visionMaxOutputTokens(MODEL) * pricing.outputUsdPerMillion) / 1e4, 10);
  });

  it("is never sent to non-OpenRouter routes", async () => {
    const { bodies } = await read({ modelUri: "llm://openai/gpt-4.1-mini" });
    expect(bodies[0]!.provider).toBeUndefined();
  });
});

describe("unpriced paid routes fail closed", () => {
  it("refuses an uncataloged model on a direct billed route before admitting or sending", async () => {
    expect(() => visionRequestPricing({ model: "gpt-unlisted-vision", runtime: "remote-openai", billable: true, openRouter: false, inputTokens: 3_000 }))
      .toThrow(UnpricedVisionRouteError);
    const { result, fetch, weights } = await read({ modelUri: "llm://openai/gpt-unlisted-vision" });
    expect(result).toBeInstanceOf(UnpricedVisionRouteError);
    expect(fetch).not.toHaveBeenCalled();
    expect(weights).toEqual([]);
    expect(backend.orgCents("org-1")).toBe(0);
  });

  it("caps an uncataloged OpenRouter model at prices above every catalog model, and weighs it at that cap", async () => {
    const ceiling = maxCatalogVisionTokenPricing();
    for (const spec of visionModelCatalog) {
      const pricing = visionModelTokenPricing(spec.id);
      if (!pricing) continue;
      expect(ceiling.inputUsdPerMillion).toBeGreaterThanOrEqual(pricing.inputUsdPerMillion);
      expect(ceiling.outputUsdPerMillion).toBeGreaterThanOrEqual(pricing.outputUsdPerMillion);
    }
    const { bodies, weights } = await read({ modelUri: "llm://openrouter/someone/unlisted-vl" });
    expect(bodies[0]!.provider.max_price).toEqual({ prompt: ceiling.inputUsdPerMillion, completion: ceiling.outputUsdPerMillion });
    expect(bodies[0]!.provider.max_price).toEqual(visionMaxPrice("someone/unlisted-vl"));
    const prompt = bodies[0]!.messages[1].content[0].text as string;
    expect(weights[0]).toBeGreaterThanOrEqual(
      (visionInputTokenBound(null, prompt) * ceiling.inputUsdPerMillion + visionMaxOutputTokens("someone/unlisted-vl") * ceiling.outputUsdPerMillion) / 1e4 - 1e-9,
    );
  });

  it("keeps a local runtime cheap", () => {
    expect(visionRequestPricing({ model: "microsoft/Florence-2-base-ft", runtime: "local-cli", billable: false, openRouter: false, inputTokens: 1e6 }))
      .toEqual({ weightCents: 2, maxPrice: null });
  });
});
