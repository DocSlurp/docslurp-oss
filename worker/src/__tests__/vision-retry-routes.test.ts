import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { alternateRouteBody } from "../tools/vision-stream.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const MIMO = "xiaomi/mimo-v2.6-flash";
const LUNA = "openai/gpt-6-luna";

describe("alternateRouteBody", () => {
  it("ignores the failing provider and keeps allow_fallbacks:true preferences intact", () => {
    const body = { provider: { order: ["relace", "deepinfra"], allow_fallbacks: true } };
    expect(alternateRouteBody(body, "Relace", "degenerate")).toEqual({ provider: { order: ["relace", "deepinfra"], allow_fallbacks: true, ignore: ["Relace"] } });
  });

  it("when fallbacks are forbidden, keeps only the remaining order entries", () => {
    const body = { provider: { order: ["deepseek", "together"], allow_fallbacks: false } };
    expect(alternateRouteBody(body, "DeepSeek", "degenerate")).toEqual({ provider: { order: ["together"], allow_fallbacks: false, ignore: ["DeepSeek"] } });
  });

  it("when fallbacks are forbidden and ignore exhausts the order there is no alternate route", () => {
    const body = { provider: { order: ["deepseek"], allow_fallbacks: false } };
    expect(alternateRouteBody(body, "DeepSeek", "degenerate")).toBeNull();
    expect(alternateRouteBody(body, "DeepSeek", "refusal")).toBeNull();
    // A transient provider error is worth one repeat on the same route.
    expect(alternateRouteBody(body, "DeepSeek", "provider-error")).toBe(body);
  });

  it("uses the preferred route for a refusal, minus the failing provider, and plain ignore otherwise", () => {
    const preferred = { order: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: false };
    expect(alternateRouteBody({}, "OpenAI", "refusal", preferred)).toEqual({ provider: preferred });
    expect(alternateRouteBody({}, "Azure", "refusal", preferred)).toEqual({ provider: { order: ["amazon-bedrock/us-east-1"], allow_fallbacks: false } });
    expect(alternateRouteBody({}, "OpenAI", "degenerate", preferred)).toEqual({ provider: { ignore: ["OpenAI"] } });
  });

  it("leaves the body alone when the failing provider is unknown", () => {
    const body = { provider: { order: ["a"], allow_fallbacks: false } };
    expect(alternateRouteBody(body, null, "refusal")).toBe(body);
  });
});

const enc = new TextEncoder();
function sse(chunks: Array<Record<string, unknown>>): Response {
  const events = chunks.map((c) => enc.encode(`data: ${JSON.stringify(c)}\n\n`));
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (i < events.length) controller.enqueue(events[i++]!); else controller.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(model: string, responses: Response[]) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses.shift()!;
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-routes-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await executeVisionRuntime({
    imagePath, outputPath: `${imagePath}.json`,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}` }),
    cfg, runner: new CommandRunner(), privacyMode: "standard",
  });
  return { bodies, result };
}

const filtered = (provider: string) => sse([
  { id: "g", model: "m", provider, choices: [{ delta: { content: "Par" } }] },
  { id: "g", model: "m", provider, choices: [{ delta: { content: "" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 400, completion_tokens: 3 } },
]);

describe("per-model provider preferences survive the generic retry", () => {
  it("DeepSeek-1017 retries on the remaining order entry only", async () => {
    const { bodies, result } = await run(DEEPSEEK, [
      filtered("DeepSeek"),
      sse([{ id: "g", model: DEEPSEEK, provider: "Together", choices: [{ delta: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 20 } }]),
    ]);
    expect(bodies[0]!.provider).toEqual({ order: ["deepseek", "together"], allow_fallbacks: false });
    expect(bodies[1]!.provider).toEqual({ order: ["together"], allow_fallbacks: false, ignore: ["DeepSeek"] });
    expect(result).toMatchObject({ text: "# Page", attempts: 2, inputTokens: 1400, outputTokens: 23 });
  });

  it("MiMo keeps its order and fallbacks and adds the failing provider to ignore", async () => {
    const { bodies } = await run(MIMO, [
      filtered("Relace"),
      sse([{ id: "g", model: MIMO, provider: "DeepInfra", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ]);
    expect(bodies[1]!.provider).toEqual({ order: ["relace", "deepinfra"], allow_fallbacks: true, ignore: ["Relace"] });
  });

  it("Luna goes to its preferred retry route over SSE", async () => {
    const { bodies } = await run(LUNA, [
      filtered("OpenAI"),
      sse([{ id: "g", model: LUNA, provider: "Amazon Bedrock", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ]);
    expect(bodies[1]!.provider).toEqual({ order: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: false });
  });
});

describe("served model and provider from a streamed result", () => {
  it("reads model from chunks and provider from the final usage chunk (string or {name})", async () => {
    for (const provider of ["DeepSeek", { name: "DeepSeek" }]) {
      const { result } = await run("deepseek/deepseek-v4.1-flash", [sse([
        { id: "g", model: "deepseek/deepseek-v4.1-flash-0925", choices: [{ delta: { content: "hi" } }] },
        { id: "g", provider, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ])]);
      expect(result.servedModel).toBe("deepseek/deepseek-v4.1-flash-0925");
      expect(result.servedProvider).toBe("DeepSeek");
      expect(result.modelSwap).toMatchObject({ requested: "deepseek/deepseek-v4.1-flash", served: "deepseek/deepseek-v4.1-flash-0925", provider: "DeepSeek" });
    }
  });
});

