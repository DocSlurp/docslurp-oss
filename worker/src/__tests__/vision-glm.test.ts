import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openRouterReasoningParams, visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { insertMissingTableDelimiters } from "../tools/vision-table-delimiter.js";
import { openRouterProviderParams, postProcessVisionText, visionModelProfile, visionOutputCapForModel, visionPromptKeyForModel, visionReasoningParams } from "../tools/vision-model-profiles.js";
import { executeVisionRuntime, visionPromptTemplates, type VisionPriceCeiling } from "../tools/vision-runtime.js";
import { ProviderRoutingExclusionError } from "../lib/provider-retry.js";
import { visionMaxPrice } from "../test/vision-max-price.js";
import { inAllowingRun } from "../test/provider-scope.js";

const GLM = "z-ai/glm-5.3-flash";
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestBody(model: string, prompt?: string, extra: { priceCeiling?: VisionPriceCeiling; response?: () => Response } = {}) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (extra.response) return extra.response();
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-glm-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await inAllowingRun(() => executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`, gate: null,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg,
    runner: new CommandRunner(),
    privacyMode: "standard",
    ...(extra.priceCeiling ? { priceCeiling: extra.priceCeiling } : {}),
  }));
  const body = bodies[0]!;
  body.messages[1].content[1].image_url.url = "<image>";
  // The per-organization salt line (organization isolation) follows the fixed instruction; the golden bodies omit it.
  if (typeof body.messages[0].content === "string") {
    if (!/\nWorkspace [0-9a-f]{16}\.$/.test(body.messages[0].content)) throw new Error("vision system message lacks the org salt line");
    body.messages[0].content = body.messages[0].content.replace(/\nWorkspace [0-9a-f]{16}\.$/, "");
  }
  return body;
}

describe("GLM 5.3 Flash vision profile", () => {
  it("replaces only an unset or <OCR> prompt with the transcription template", () => {
    expect(visionPromptKeyForModel(undefined, GLM)).toBe("markdown-transcription");
    expect(visionPromptKeyForModel("<OCR>", GLM)).toBe("markdown-transcription");
    expect(visionPromptKeyForModel("layout", GLM)).toBe("layout");
    expect(visionModelProfile(GLM)!.defaultPrompt! in visionPromptTemplates).toBe(true);
  });

  it("keeps the chat reasoning floor unchanged and pins the same minimal effort for vision", () => {
    expect(openRouterReasoningParams(GLM)).toEqual({ reasoning: { effort: "minimal" } });
    expect(visionReasoningParams(GLM)).toEqual({ reasoning: { effort: "minimal" } });
  });

  it("routes only to endpoints measured to read the image, with failover confined to those endpoints", () => {
    expect(openRouterProviderParams(GLM)).toEqual({ provider: { only: ["wafer/nvfp4", "friendli", "inference-net/fp4"], sort: "price", allow_fallbacks: true } });
  });

  it("caps output at 8k and never raises a smaller shared cap", () => {
    expect(visionOutputCapForModel(GLM, { value: 16_384, configured: false })).toBe(8_192);
    expect(visionOutputCapForModel(GLM, { value: 16_384, configured: true })).toBe(8_192);
    expect(visionOutputCapForModel(GLM, { value: 4_096, configured: true })).toBe(4_096);
  });

  it("inserts a missing delimiter row after the first row of a pipe-table run", () => {
    expect(insertMissingTableDelimiters("Prices\n\n| Wheat | 82c |\n| Corn | 34c |\n\nEnd")).toBe("Prices\n\n| Wheat | 82c |\n| --- | --- |\n| Corn | 34c |\n\nEnd");
    expect(insertMissingTableDelimiters("| A \\| B | C | D |\n| 1 | 2 | 3 |")).toBe("| A \\| B | C | D |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
  });

  it("leaves complete tables, single pipe lines, fenced code and prose unchanged", () => {
    for (const text of [
      "| A | B |\n|---|---|\n| 1 | 2 |",
      "| A | B |\n| :-- | --: |\n| 1 | 2 |",
      "| only one row |",
      "```\n| a | b |\n| c | d |\n```",
      "a | b\nc | d",
      "A = $x^2$\n\n    indented",
    ]) expect(insertMissingTableDelimiters(text)).toBe(text);
  });

  it("applies the delimiter repair to GLM only", () => {
    const text = "| a | b |\n| c | d |";
    expect(postProcessVisionText(GLM, text)).toBe("| a | b |\n| --- | --- |\n| c | d |");
    expect(postProcessVisionText("google/gemini-3.1-flash-lite", text)).toBe(text);
  });

  it("matches the golden default-prompt request body", async () => {
    const golden = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/vision-request-bodies-glm.json"), "utf8")) as Record<string, unknown>;
    expect(await requestBody(GLM)).toEqual(golden[`${GLM}|`]);
  });

  it("keeps an explicitly chosen template but still sends the profile routing, reasoning and cap", async () => {
    const body = await requestBody(GLM, "layout");
    expect(body.messages[1].content[0].text).toBe(visionPromptTemplates.layout);
    expect(body.provider).toEqual({ only: ["wafer/nvfp4", "friendli", "inference-net/fp4"], sort: "price", allow_fallbacks: true, max_price: visionMaxPrice(GLM) });
    expect(body.reasoning).toEqual({ effort: "minimal" });
    expect(body.max_tokens).toBe(8_192);
  });

  it("a price-ceiling request sends max_price at the ceiling and is restricted to the ceiling's hosts", async () => {
    const ceiling = { inputUsdPerMillion: 0.065, outputUsdPerMillion: 0.24, imageUsd: 0, hosts: ["wafer/nvfp4", "wafer/us"] };
    const body = await requestBody(GLM, undefined, { priceCeiling: ceiling });
    expect(body.provider).toMatchObject({ only: ["wafer/nvfp4", "wafer/us"], sort: "price", allow_fallbacks: true,
      max_price: { prompt: 0.065, completion: 0.24, image: 0 } });
  });

  it("a request no host can serve under its ceiling fails as a routing exclusion, not a model failure", async () => {
    const ceiling = { inputUsdPerMillion: 0.001, outputUsdPerMillion: 0.001, imageUsd: 0, hosts: ["wafer/nvfp4", "wafer/us"] };
    await expect(requestBody(GLM, undefined, { priceCeiling: ceiling, response: () => new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy and max_price" } }), { status: 404 }) }))
      .rejects.toSatisfy((error: unknown) => {
        for (let current = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth += 1) {
          if (current instanceof ProviderRoutingExclusionError) return true;
        }
        return false;
      });
  });

  it("refuses a price-ceiling request on a route that cannot carry it, sending nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dir = await mkdtemp(join(tmpdir(), "vision-glm-"));
    const imagePath = join(dir, "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const ceiling = { inputUsdPerMillion: 0.065, outputUsdPerMillion: 0.24, imageUsd: 0, hosts: ["wafer/nvfp4", "wafer/us"] };
    // DeepInfra's own API takes no max_price or host allowlist.
    await expect(inAllowingRun(() => executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`, gate: null,
      vision: visionConfigSchema.parse({ modelUri: "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct" }),
      cfg: { ...cfg, deepInfraApiKey: "di-key" } as Config, runner: new CommandRunner(), privacyMode: "standard", priceCeiling: ceiling,
    }))).rejects.toThrow(/cannot carry the request's price ceiling/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
