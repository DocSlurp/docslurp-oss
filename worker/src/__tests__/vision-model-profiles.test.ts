import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { MARKDOWN_LATEX_VISION_PROMPT, visionPromptKeyForModel } from "../tools/vision-model-profiles.js";
import { executeVisionRuntime, visionPromptTemplates } from "../tools/vision-runtime.js";

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
  await executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
    runner: new CommandRunner(),
    privacyMode: "standard",
  });
  const body = bodies[0]!;
  return { body, userText: body.messages[1].content[0].text as string };
}

describe("per-model vision profiles", () => {
  it("sends the DeepSeek V4.1 Flash 1017 snapshot the Markdown/LaTeX prompt, an 8k cap, no reasoning and pinned providers", async () => {
    const { body, userText } = await send(SNAPSHOT);
    expect(body.model).toBe(SNAPSHOT);
    expect(userText).toBe(MARKDOWN_LATEX_VISION_PROMPT);
    expect(body.max_tokens).toBe(8_192);
    expect(body.temperature).toBe(0);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.provider).toEqual({ order: ["together", "fireworks", "parasail"], allow_fallbacks: false });
  });

  it("keeps an explicit non-default template for the snapshot", async () => {
    const { userText } = await send(SNAPSHOT, "form-fields");
    expect(userText).toBe(visionPromptTemplates["form-fields"]);
  });

  it("leaves the base DeepSeek alias on the generic defaults", async () => {
    const { body, userText } = await send("deepseek/deepseek-v4.1-flash");
    expect(userText).toBe(visionPromptTemplates["<OCR>"]);
    expect(body.max_tokens).toBe(16_384);
    expect(body.provider).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("maps only an unset or <OCR> prompt to the profile default", () => {
    expect(visionPromptKeyForModel(undefined, SNAPSHOT)).toBe("markdown-latex");
    expect(visionPromptKeyForModel(" <OCR> ", SNAPSHOT)).toBe("markdown-latex");
    expect(visionPromptKeyForModel("layout", SNAPSHOT)).toBe("layout");
    expect(visionPromptKeyForModel("<OCR>", "google/gemini-3.1-flash-lite")).toBe("<OCR>");
    expect(visionPromptTemplates["markdown-latex"]).toBe(MARKDOWN_LATEX_VISION_PROMPT);
  });
});
