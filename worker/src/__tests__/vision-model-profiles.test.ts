import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, visionModelCatalog } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { MARKDOWN_LATEX_VISION_PROMPT, VISION_MODEL_PROFILES, visionPromptKeyForModel } from "../tools/vision-model-profiles.js";
import { visionMaxPrice } from "../test/vision-max-price.js";
import { executeVisionRuntime, visionPromptTemplates } from "../tools/vision-runtime.js";
import { inAllowingRun } from "../test/provider-scope.js";

const SNAPSHOT = "deepseek/deepseek-v4.1-flash-1017";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function send(model: string, prompt?: string) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "# Page" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 500, cost: 0.0004 },
    }));
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-profile-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await inAllowingRun(() => executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`, gate: null,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
    runner: new CommandRunner(),
    privacyMode: "standard",
  }));
  const body = bodies[0]!;
  return { body, userText: body.messages[1].content[0].text as string };
}

describe("per-model vision profiles", () => {
  it("sends the DeepSeek V4.1 Flash 1017 snapshot the Markdown/LaTeX prompt, an 8k cap, no reasoning and its measured hosts", async () => {
    const { body, userText } = await send(SNAPSHOT);
    expect(body.model).toBe(SNAPSHOT);
    expect(userText).toBe(MARKDOWN_LATEX_VISION_PROMPT);
    expect(body.max_tokens).toBe(8_192);
    expect(body.temperature).toBe(0);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.provider).toEqual({ only: ["together", "fireworks", "parasail"], sort: "price", allow_fallbacks: true, max_price: visionMaxPrice(SNAPSHOT) });
  });

  it("sends a default org to the cheapest measured host, China-based ones included, under the route's max_price", async () => {
    const { body } = await send(SNAPSHOT);
    expect(body.provider.sort).toBe("price");
    expect(body.provider.only).toEqual(["together", "fireworks", "parasail"]);
    expect(body.provider.ignore).toBeUndefined();
  });

  it("keeps an explicit non-default template for the snapshot", async () => {
    const { userText } = await send(SNAPSHOT, "form-fields");
    expect(userText).toBe(visionPromptTemplates["form-fields"]);
  });

  it("refuses the uncataloged base DeepSeek alias: hosted vision is limited to the priced catalog", async () => {
    await expect(send("deepseek/deepseek-v4.1-flash")).rejects.toThrow(/not in the priced vision catalog/);
  });

  it("maps only an unset or <OCR> prompt to the profile default", () => {
    expect(visionPromptKeyForModel(undefined, SNAPSHOT)).toBe("markdown-latex");
    expect(visionPromptKeyForModel(" <OCR> ", SNAPSHOT)).toBe("markdown-latex");
    expect(visionPromptKeyForModel("layout", SNAPSHOT)).toBe("layout");
    expect(visionPromptKeyForModel("<OCR>", "google/gemini-3.1-flash-lite")).toBe("<OCR>");
    expect(visionPromptTemplates["markdown-latex"]).toBe(MARKDOWN_LATEX_VISION_PROMPT);
  });
});

describe("vision catalog route pricing", () => {
  it("prices a pinned-route catalog entry from exactly the providers its profile restricts it to", () => {
    const pinned = visionModelCatalog.filter((entry) => entry.tokenPricing && "basis" in entry.tokenPricing && entry.tokenPricing.basis === "pinned-route");
    expect(pinned.map((entry) => entry.id)).toContain(SNAPSHOT);
    for (const entry of pinned) {
      const route = VISION_MODEL_PROFILES[entry.id]?.openRouterProvider;
      expect(route, entry.id).toBeDefined();
      if (!entry.tokenPricing || !("providers" in entry.tokenPricing)) throw new Error(`Missing pinned providers: ${entry.id}`);
      // An `only` allowlist confines fallbacks to its hosts; a pinned `order` must turn fallbacks off.
      if ("only" in route!) expect(route.only, entry.id).toEqual(entry.tokenPricing.providers);
      else {
        expect(route!.allow_fallbacks, entry.id).toBe(false);
        expect(route!.order, entry.id).toEqual(entry.tokenPricing.providers);
      }
    }
  });
});
