import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { unwrapWholeMarkdownFence } from "../tools/vision-markdown-fence.js";
import { postProcessVisionText, visionModelProfile, visionPromptKeyForModel, visionReasoningParams } from "../tools/vision-model-profiles.js";
import { executeVisionRuntime, visionPromptTemplates } from "../tools/vision-runtime.js";

const LUNA = "openai/gpt-6-luna";
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function page() {
  const dir = await mkdtemp(join(tmpdir(), "vision-luna-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

async function run(model: string, prompt: string | undefined, responses: Array<Record<string, unknown>>) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(responses[Math.min(bodies.length, responses.length) - 1]), { status: 200, headers: { "content-type": "application/json" } });
  }));
  const imagePath = await page();
  const result = await executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg,
    runner: new CommandRunner(),
    privacyMode: "standard",
  });
  return { bodies, result };
}

const ok = { choices: [{ message: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 300, cost: 0.0004 } };

describe("GPT-6 Luna vision profile", () => {
  it("replaces only an unset or <OCR> prompt with its template", () => {
    expect(visionPromptKeyForModel("<OCR>", LUNA)).toBe("page-markdown-latex");
    expect(visionPromptKeyForModel(undefined, LUNA)).toBe("page-markdown-latex");
    expect(visionPromptKeyForModel("layout", LUNA)).toBe("layout");
    expect(visionPromptKeyForModel("<OCR>", "google/gemini-3.1-flash-lite")).toBe("<OCR>");
    expect(visionModelProfile(LUNA)!.defaultPrompt! in visionPromptTemplates).toBe(true);
  });

  it("unwraps only a Markdown-tagged fence around the whole transcription", () => {
    expect(unwrapWholeMarkdownFence("```markdown\n# Receipt\n\n| A | B |\n|---|---|\n```")).toBe("# Receipt\n\n| A | B |\n|---|---|");
    expect(unwrapWholeMarkdownFence("```gfm\n# Page\n```")).toBe("# Page");
    const listing = "```\nint main() {}\n```";
    expect(unwrapWholeMarkdownFence(listing)).toBe(listing);
    const nested = "```md\nIntro\n```js\nx()\n```\n```";
    expect(unwrapWholeMarkdownFence(nested)).toBe(nested);
    expect(unwrapWholeMarkdownFence("# Page\n\n```js\nx()\n```")).toBe("# Page\n\n```js\nx()\n```");
  });

  it("attaches the fence unwrap to Luna only", () => {
    expect(postProcessVisionText(LUNA, "```markdown\n# Page\n```")).toBe("# Page");
    expect(postProcessVisionText("google/gemini-3.1-flash-lite", "```markdown\n# Page\n```")).toBe("```markdown\n# Page\n```");
  });

  it("uses a vision-only reasoning floor of effort none", () => {
    expect(visionReasoningParams(LUNA)).toEqual({ reasoning: { effort: "none" } });
  });

  it("sends its template, effort none, high image detail, 16k cap, temperature 0 and no other params", async () => {
    const { bodies } = await run(LUNA, undefined, [ok]);
    const body = bodies[0]!;
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.messages[1].content[0].text).toBe(visionPromptTemplates["page-markdown-latex"]);
    expect(body.messages[1].content[1].image_url.detail).toBe("high");
    expect(body.max_tokens).toBe(16384);
    expect(body.temperature).toBe(0);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning", "temperature"]);
  });

  it("matches the golden default-prompt request body", async () => {
    const golden = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/vision-request-bodies-luna.json"), "utf8")) as Record<string, unknown>;
    const { bodies } = await run(LUNA, undefined, [ok]);
    bodies[0]!.messages[1].content[1].image_url.url = "<image>";
    expect(bodies[0]).toEqual(golden[`${LUNA}|`]);
  });

  it("keeps an explicitly chosen template but still sends detail and reasoning", async () => {
    const { bodies } = await run(LUNA, "layout", [ok]);
    expect(bodies[0]!.messages[1].content[0].text).toBe(visionPromptTemplates.layout);
    expect(bodies[0]!.messages[1].content[1].image_url.detail).toBe("high");
  });

  it("unwraps a whole-page markdown fence in the result", async () => {
    const { result } = await run(LUNA, undefined, [{ ...ok, choices: [{ message: { content: "```markdown\n# Page\n```" }, finish_reason: "stop" }] }]);
    expect(result.text).toBe("# Page");
  });

  it("leaves unprofiled models without detail", async () => {
    const { bodies } = await run("google/gemini-3.1-flash-lite", undefined, [ok]);
    expect(bodies[0]!.messages[1].content[1].image_url.detail).toBeUndefined();
  });

  it("resends a content-filtered page once to the pinned endpoints, keeps the retry text and sums both calls", async () => {
    const { bodies, result } = await run(LUNA, undefined, [
      { provider: "OpenAI", choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 0, cost: 0.00004 } },
      { provider: "Amazon Bedrock", choices: [{ message: { content: "# Full page" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 600, cost: 0.00055 } },
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.provider).toBeUndefined();
    expect(bodies[1]!.provider).toEqual({ order: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: false });
    expect(result).toMatchObject({ text: "# Full page", finishReason: "stop", inputTokens: 2400, outputTokens: 600 });
    expect(result.costCents).toBeCloseTo(0.059, 10);
  });

  it("does not retry a second content filter, or other finish reasons", async () => {
    const filtered = { choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 0, cost: 0.00004 } };
    expect((await run(LUNA, undefined, [filtered, filtered])).bodies).toHaveLength(2);
    expect((await run(LUNA, undefined, [{ ...ok, choices: [{ message: { content: "x" }, finish_reason: "length" }] }])).bodies).toHaveLength(1);
  });

  it("does not resend content-filtered pages for unprofiled models", async () => {
    const { bodies, result } = await run("google/gemini-3.1-flash-lite", undefined, [
      { choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 0 } },
    ]);
    expect(bodies).toHaveLength(1);
    expect(result.finishReason).toBe("content_filter");
  });
});
