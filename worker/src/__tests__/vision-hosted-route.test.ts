import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OPENROUTER_VISION_MODEL, NEMOTRON_SUPER_VL_VISION_MODEL, OPENROUTER_BASE_URL, visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { visionReasoningParams } from "../tools/vision-model-profiles.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pageImage() {
  const dir = await mkdtemp(join(tmpdir(), "hosted-vision-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

describe("hosted OpenRouter vision request shape", () => {
  it("sends the opt-in Nemotron route one image part with reasoning off and keeps the router charge", async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-key");
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "# Page\n\nText" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1800, completion_tokens: 400, cost: 0.00047 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const imagePath = await pageImage();
    const result = await executeVisionRuntime({
      imagePath,
      outputPath: `${imagePath}.json`, gate: null,
      vision: visionConfigSchema.parse({ profile: "open-weights-hosted" }),
      cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
      runner: new CommandRunner(),
      privacyMode: "standard",
    });

    const body = bodies[0]!;
    expect(body.model).toBe(NEMOTRON_SUPER_VL_VISION_MODEL);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(16_384);
    expect(body.response_format).toBeUndefined();
    const parts = body.messages[1].content as Array<Record<string, any>>;
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts[1]!.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result).toMatchObject({ model: NEMOTRON_SUPER_VL_VISION_MODEL, inputTokens: 1800, outputTokens: 400, usageSource: "provider" });
    expect(result.costCents).toBeCloseTo(0.047, 10);
  });

  it("sends the default route with its catalog reasoning params", async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }));
    const imagePath = await pageImage();
    await executeVisionRuntime({
      imagePath,
      outputPath: `${imagePath}.json`, gate: null,
      vision: visionConfigSchema.parse({}),
      cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
      runner: new CommandRunner(),
      privacyMode: "standard",
    });
    expect(bodies[0]!.model).toBe(DEFAULT_OPENROUTER_VISION_MODEL);
    expect(bodies[0]!.reasoning).toEqual(visionReasoningParams(DEFAULT_OPENROUTER_VISION_MODEL).reasoning);
  });
});
