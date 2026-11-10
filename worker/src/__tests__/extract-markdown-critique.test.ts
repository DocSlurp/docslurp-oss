import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { visionConfigSchema, visionListPriceCents } from "@docslurp/shared";

import type { Config } from "../config.js";
import { priceVisionResult } from "../lib/guarded-vision-call.js";
import type { VisionServedRoute } from "../lib/vision-pricing.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { budgetCritiquePages, buildPerPageHeatmap, mergeCritiquedPages, recordCritiqueUsage, selectCritiquePages } from "../stages/extract-markdown.js";
import { CommandRunner } from "../tools/runner.js";
import { configuredVisionServedRoute, executeVisionRuntime } from "../tools/vision-runtime.js";
import { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";

describe("budgetCritiquePages", () => {
  it("never launches more paid pages than the preflight ceiling permits", () => {
    expect(budgetCritiquePages([2, 3, 4], 5, 2)).toEqual([2, 3]);
    expect(budgetCritiquePages([2, 3], 1, 2)).toEqual([]);
  });
});

describe("selectCritiquePages", () => {
  it("picks the lowest-plausibility pages first", () => {
    const pages = selectCritiquePages([
      { pageNumber: 1, plausibilityScore: 0.6, strategy: "base", charCount: 800, tokenEstimate: 200 },
      { pageNumber: 2, plausibilityScore: 0.21, strategy: "base", charCount: 40, tokenEstimate: 10 },
      { pageNumber: 3, plausibilityScore: 0.31, strategy: "base", charCount: 90, tokenEstimate: 22 },
      { pageNumber: 4, plausibilityScore: 0.5, strategy: "base", charCount: 600, tokenEstimate: 160 }
    ]);

    expect(pages).toEqual([2, 3]);
  });
});

describe("mergeCritiquedPages", () => {
  it("replaces only the corrected page slices", () => {
    const merged = mergeCritiquedPages(
      "first page\fsecond page\fthird page",
      3,
      [{ pageNumber: 2, text: "second page corrected" }]
    );

    expect(merged).toBe("first page\fsecond page corrected\fthird page");
  });

  it("keeps an empty page in place so page N stays page N", () => {
    expect(mergeCritiquedPages("one\f\fthree", 3, [{ pageNumber: 3, text: "three corrected" }])).toBe("one\f\fthree corrected");
  });

  it("never invents page breaks: text whose breaks do not match the page count comes back unchanged", () => {
    const sentences = "Alpha beta gamma. ".repeat(40);
    const corrections = [{ pageNumber: 2, text: "corrected" }];
    // No form feed at all (equal-length slicing would have cut it into three and joined them with form feeds).
    expect(mergeCritiquedPages(sentences, 3, corrections)).toBe(sentences);
    // Markdown rules are not page breaks.
    const ruled = "first\n\n---\n\nsecond\n\n---\n\nthird";
    expect(mergeCritiquedPages(ruled, 3, corrections)).toBe(ruled);
    // Form feeds for two pages in a three-page document.
    expect(mergeCritiquedPages("one\ftwo", 3, corrections)).toBe("one\ftwo");
    // Nothing to merge into.
    expect(mergeCritiquedPages("", 3, corrections)).toBe("");
  });
});

describe("buildPerPageHeatmap", () => {
  it("scores only pages the text says exist, never equal-length slices", () => {
    const paged = buildPerPageHeatmap("One page of text.\fAnother page of text.\fA third page.", 3, "base");
    expect(paged.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(buildPerPageHeatmap("Alpha beta gamma. ".repeat(40), 3, "base")).toEqual([]);
    expect(buildPerPageHeatmap("one\ftwo", 3, "base")).toEqual([]);
    expect(buildPerPageHeatmap("Just one page.", 1, "base")).toHaveLength(1);
  });
});

describe("scoreExtractionPlausibility", () => {
  it("rewards fuller corrected markdown", () => {
    const original = "Name: ___";
    const corrected = "Name: Jane Example\nAddress: 123 Market Street\nSignature: Jane Example";

    expect(
      scoreExtractionPlausibility(corrected, 1).plausibilityScore,
    ).toBeGreaterThan(
      scoreExtractionPlausibility(original, 1).plausibilityScore,
    );
  });
});

describe("recordCritiqueUsage", () => {
  it("records critique usage per served route when some pages were served by the primary and some by the fallback", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cfg = {
      openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
      costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
    } as Config;
    const vision = visionConfigSchema.parse({ modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", remoteFallbackModelUri: "llm://openai/gpt-4.1-mini" });
    // Page 2's critique fails on OpenRouter (rejected twice) and is served by the OpenAI fallback; pages 1 and 3 by OpenRouter.
    let page = 0;
    const answer = (finishReason: string, usage: Record<string, number>) => new Response(JSON.stringify({ choices: [{ message: { content: "Corrected page text" }, finish_reason: finishReason }], usage }),
      { headers: { "content-type": "application/json" } });
    try {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        const host = new URL(url).host;
        if (host === "api.openai.com") return answer("stop", { prompt_tokens: 900, completion_tokens: 200 });
        return page === 2 ? answer("length", { prompt_tokens: 1, completion_tokens: 1 }) : answer("stop", { prompt_tokens: 1_000, completion_tokens: 100 });
      }));
      const dir = await mkdtemp(join(tmpdir(), "critique-routes-"));
      const imagePath = join(dir, "page.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const routes = new Map<number, VisionServedRoute>();
      const corrections = [];
      for (page = 1; page <= 3; page += 1) {
        const result = await executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate: null });
        routes.set(page, result.route);
        corrections.push({ pageNumber: page, accepted: page !== 3, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents: priceVisionResult(result, cfg) });
      }
      // Page 4's critique failed: zero usage, counted under the configured route.
      corrections.push({ pageNumber: 4, accepted: false, inputTokens: 0, outputTokens: 0, costCents: 0 });
      const ledger = new PipelineUsageEventLedger();
      recordCritiqueUsage({ ledger, corrections, routes, configuredRoute: configuredVisionServedRoute(vision, cfg), metadata: { documentId: "doc" } });
      const events = ledger.snapshot();
      expect(events).toHaveLength(2);
      const openRouter = events.find((event) => event.provider === "openrouter")!;
      const openAi = events.find((event) => event.provider === "openai")!;
      expect(openRouter).toMatchObject({ model: "google/gemini-3.1-flash-lite", metric: "page-critique", amount: 3, inputTokens: 2_000, outputTokens: 200,
        metadata: { documentId: "doc", reviewedPages: [1, 3, 4], acceptedPages: [1], billing: "openrouter" } });
      expect(openAi).toMatchObject({ model: "gpt-4.1-mini", metric: "page-critique", amount: 1, inputTokens: 900, outputTokens: 200,
        metadata: { reviewedPages: [2], acceptedPages: [2], billing: "openai" } });
      expect(openAi.metadata!.providerCostCents as number ?? openAi.costCents).toBeCloseTo(visionListPriceCents("gpt-4.1-mini", { inputTokens: 900, outputTokens: 200 })!, 10);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
