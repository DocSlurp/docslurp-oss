import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { postProcessVisionText, prepareVisionImage, profileVisionPromptKey, visionModelProfile } from "../tools/vision-model-profiles.js";
import { executeVisionRuntime, visionPromptTemplates } from "../tools/vision-runtime.js";

const LUNA = "openai/gpt-6-luna";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pngPage(width: number, height: number) {
  const dir = await mkdtemp(join(tmpdir(), "vision-profile-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, await sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer());
  return imagePath;
}

async function sendPage(model: string, prompt?: string) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "# Page" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2000, completion_tokens: 300, cost: 0.0004 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const imagePath = await pngPage(1530, 1980);
  await executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
    runner: new CommandRunner(),
    privacyMode: "standard",
  });
  const parts = bodies[0]!.messages[1].content as Array<Record<string, any>>;
  const image = Buffer.from(String(parts[1]!.image_url.url).split(",")[1]!, "base64");
  return { body: bodies[0]!, text: parts[0]!.text as string, imageUrl: parts[1]!.image_url, meta: await sharp(image).metadata() };
}

describe("vision model profiles", () => {
  it("replaces only the generic default template for profiled models", () => {
    expect(profileVisionPromptKey("<OCR>", LUNA)).toBe("page-markdown-latex");
    expect(profileVisionPromptKey(undefined, LUNA)).toBe("page-markdown-latex");
    expect(profileVisionPromptKey("layout", LUNA)).toBe("layout");
    expect(profileVisionPromptKey("<OCR>", "google/gemini-3.1-flash-lite")).toBe("<OCR>");
    expect(visionModelProfile(LUNA)!.defaultPrompt! in visionPromptTemplates).toBe(true);
  });

  it("downscales oversized PNG and JPEG pages and leaves small or unreadable images untouched", async () => {
    const profile = { maxImageLongSide: 1600 };
    const big = await sharp({ create: { width: 1530, height: 1980, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const meta = await sharp(await prepareVisionImage(big, "image/jpeg", profile)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1236, 1600]);
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#fff" } }).png().toBuffer();
    expect(await prepareVisionImage(small, "image/png", profile)).toBe(small);
    const junk = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(await prepareVisionImage(junk, "image/png", profile)).toBe(junk);
    expect(await prepareVisionImage(big, "image/jpeg", undefined)).toBe(big);
  });

  it("unwraps only a Markdown-tagged fence around the whole transcription", () => {
    const profile = { unwrapMarkdownFence: true };
    expect(postProcessVisionText("```markdown\n# Receipt\n\n| A | B |\n|---|---|\n```", profile)).toBe("# Receipt\n\n| A | B |\n|---|---|");
    const listing = "```\nint main() {}\n```";
    expect(postProcessVisionText(listing, profile)).toBe(listing);
    const nested = "```md\nIntro\n```js\nx()\n```\n```";
    expect(postProcessVisionText(nested, profile)).toBe(nested);
    expect(postProcessVisionText("# Page\n\n```js\nx()\n```", profile)).toBe("# Page\n\n```js\nx()\n```");
    expect(postProcessVisionText("```markdown\n# Page\n```", undefined)).toBe("```markdown\n# Page\n```");
  });

  it("sends GPT-6 Luna its template, reasoning floor, high detail and a 1,600 px page", async () => {
    const { body, text, imageUrl, meta } = await sendPage(LUNA);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(text).toBe(visionPromptTemplates["page-markdown-latex"]);
    expect(imageUrl.detail).toBe("high");
    expect([meta.width, meta.height]).toEqual([1236, 1600]);
  });

  it("keeps an explicitly chosen template for GPT-6 Luna", async () => {
    const { text } = await sendPage(LUNA, "layout");
    expect(text).toBe(visionPromptTemplates.layout);
  });

  it("leaves unprofiled models on the generic request shape", async () => {
    const { text, imageUrl, meta } = await sendPage("google/gemini-3.1-flash-lite");
    expect(text).toBe(visionPromptTemplates["<OCR>"]);
    expect(imageUrl.detail).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([1530, 1980]);
  });

  it("resends a content-filtered GPT-6 Luna page to the pinned retry endpoints and bills both calls", async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const filtered = bodies.length === 1;
      return new Response(JSON.stringify(filtered
        ? { provider: "OpenAI", choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 0, cost: 0.00004 } }
        : { provider: "Amazon Bedrock", choices: [{ message: { content: "# Full page" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 600, cost: 0.00055 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    }));
    const imagePath = await pngPage(800, 1000);
    const result = await executeVisionRuntime({
      imagePath,
      outputPath: `${imagePath}.json`,
      vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${LUNA}` }),
      cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
      runner: new CommandRunner(),
      privacyMode: "standard",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.provider).toBeUndefined();
    expect(bodies[1]!.provider).toEqual({ order: visionModelProfile(LUNA)!.contentFilterRetryProviders, allow_fallbacks: false });
    expect(result).toMatchObject({ text: "# Full page", finishReason: "stop", inputTokens: 2400, outputTokens: 600 });
    expect(result.costCents).toBeCloseTo(0.059, 10);
  });

  it("does not resend content-filtered pages for unprofiled models", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 0, cost: 0.00004 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const imagePath = await pngPage(800, 1000);
    const result = await executeVisionRuntime({
      imagePath,
      outputPath: `${imagePath}.json`,
      vision: visionConfigSchema.parse({ modelUri: "llm://openrouter/google/gemini-3.1-flash-lite" }),
      cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
      runner: new CommandRunner(),
      privacyMode: "standard",
    });
    expect(calls).toBe(1);
    expect(result.finishReason).toBe("content_filter");
  });
});
