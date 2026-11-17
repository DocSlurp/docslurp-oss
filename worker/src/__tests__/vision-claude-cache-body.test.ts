import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, withPromptCacheBreakpoints } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, VISION_SYSTEM_INSTRUCTION, visionCacheOrdered, visionPromptMessages, visionPromptTemplates } from "../tools/vision-runtime.js";
import { inAllowingRun } from "../test/provider-scope.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } };
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;
afterEach(() => vi.unstubAllGlobals());

async function body(model: string, prompt?: string, promptText?: string): Promise<Record<string, any>> {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 30, cost: 0.0003 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-claude-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await inAllowingRun(() => executeVisionRuntime({
    imagePath, outputPath: `${imagePath}.json`, gate: null, cfg, runner: new CommandRunner(), privacyMode: "standard",
    // The schema admits only priced page-read models; chart export swaps the model into a parsed config the same way.
    vision: { ...visionConfigSchema.parse({ modelUri: "llm://openrouter/openai/gpt-6-luna", ...(prompt ? { prompt } : {}) }), modelUri: `llm://openrouter/${model}` },
    ...(promptText ? { promptText } : {}),
  }));
  return bodies[0]!;
}

describe("Claude page reads are cache-ordered; other models keep the original shape", () => {
  // Claude is not in the priced page-read catalog yet, so this shape has no production traffic; chart reads never use
  // it. The runtime composes a Claude page read exactly like this.
  it("composes Claude's body as a marked fixed system message and the image alone after it", () => {
    const sent = withPromptCacheBreakpoints({ model: "anthropic/claude-haiku-5.5",
      messages: visionPromptMessages(visionPromptTemplates.layout, undefined, image, { cacheOrdered: true }) }) as Record<string, any>;
    expect(sent.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: `${VISION_SYSTEM_INSTRUCTION}\n\n${visionPromptTemplates.layout}`, cache_control: { type: "ephemeral" } }] });
    expect(sent.messages[1].content).toEqual([image]);
  });

  it("sends a Claude page read cache-ordered with the marker, and a Claude chart read in the original order without one", async () => {
    const page = await body("anthropic/claude-haiku-5.5", "layout");
    expect(page.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: `${VISION_SYSTEM_INSTRUCTION}\n\n${visionPromptTemplates.layout}`, cache_control: { type: "ephemeral" } }] });
    expect(page.messages[1].content).toHaveLength(1);
    expect(page.messages[1].content[0].type).toBe("image_url");

    const chartPrompt = "Return one JSON object of this shape: {...}";
    const chart = await body("anthropic/claude-haiku-5.5", "layout", chartPrompt);
    expect(chart.messages[0]).toEqual({ role: "system", content: VISION_SYSTEM_INSTRUCTION });
    expect(chart.messages[1].content[0]).toEqual({ type: "text", text: chartPrompt });
    expect(chart.messages[1].content[1].type).toBe("image_url");
    expect(JSON.stringify(chart)).not.toContain("cache_control");
  });

  it("keeps GPT-6 Luna on the original shape", async () => {
    const sent = await body("openai/gpt-6-luna", "layout");
    expect(sent.messages[0]).toEqual({ role: "system", content: VISION_SYSTEM_INSTRUCTION });
    expect(sent.messages[1].content[0]).toEqual({ type: "text", text: visionPromptTemplates.layout });
    expect(sent.messages[1].content[1].type).toBe("image_url");
  });

  it("cache-orders Claude page reads only: never chart reads, other models or private routes", () => {
    expect(visionCacheOrdered({ pageRead: true, openRouter: true, model: "anthropic/claude-haiku-5.5" })).toBe(true);
    expect(visionCacheOrdered({ pageRead: false, openRouter: true, model: "anthropic/claude-haiku-5.5" })).toBe(false);
    expect(visionCacheOrdered({ pageRead: true, openRouter: false, model: "anthropic/claude-haiku-5.5" })).toBe(false);
    for (const model of ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash", "xiaomi/mimo-v2.6-flash", "Qwen/Qwen3-VL-30B-A3B-Instruct"]) {
      expect(visionCacheOrdered({ pageRead: true, openRouter: true, model }), model).toBe(false);
    }
  });
});
