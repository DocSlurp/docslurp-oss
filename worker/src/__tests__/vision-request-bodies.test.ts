import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { inAllowingRun } from "../test/provider-scope.js";

// MiMo and Nemotron are refused (no serving-level image-token evidence): their bodies left the goldens with them.
const MODELS = [
  "google/gemini-3.1-flash-lite",
  "deepseek/deepseek-v4.1-flash-1017",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestBody(model: string, prompt?: string, reasoning?: { effort: "none" | "minimal" }) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-body-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await inAllowingRun(() => executeVisionRuntime({
    imagePath,
    outputPath: `${imagePath}.json`, gate: null,
    vision: visionConfigSchema.parse({ modelUri: `llm://openrouter/${model}`, ...(prompt ? { prompt } : {}) }),
    cfg: { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config,
    runner: new CommandRunner(),
    privacyMode: "standard",
    ...(reasoning ? { reasoning } : {}),
  }));
  const body = bodies[0]!;
  body.messages[1].content[0].image_url.url = "<image>";
  return body;
}

describe("vision request bodies", () => {
  // Golden bodies captured from the pre-registry-refactor HEAD (fake fetch, default and explicit `layout` prompts), moved
  // to the prompt-cache shape (2026-11-13): the template joins the fixed system line and the image follows alone.
  it("preserves full request bodies except the approved provider selection", async () => {
    const golden = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/vision-request-bodies.json"), "utf8")) as Record<string, unknown>;
    const actual: Record<string, unknown> = {};
    for (const model of MODELS) for (const prompt of [undefined, "layout"]) actual[`${model}|${prompt ?? ""}`] = await requestBody(model, prompt);
    expect(Object.keys(actual)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) {
      const expected = structuredClone(golden[key]) as Record<string, any>;
      if (key.startsWith("deepseek/deepseek-v4.1-flash-1017|")) {
        expect(expected.provider.sort).toBe("price");
        expected.provider.sort = "latency";
        expected.provider.only = ["fireworks", "parasail"];
      }
      expect(actual[key], key).toEqual(expected);
    }
  });

  // The pre-stream fixtures are the bodies captured before the stream guard; streaming must change nothing else.
  it.each(["vision-request-bodies", "vision-request-bodies-luna"])("%s: the streaming golden differs from the pre-stream golden only by stream and stream_options", async (name) => {
    const read = async (file: string) => JSON.parse(await readFile(join(import.meta.dirname, "fixtures", file), "utf8")) as Record<string, Record<string, unknown>>;
    const before = await read(`${name}.pre-stream.json`);
    const after = await read(`${name}.json`);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) {
      const { stream, stream_options: streamOptions, ...rest } = after[key]!;
      expect(stream, key).toBe(true);
      expect(streamOptions, key).toEqual({ include_usage: true });
      expect(rest, key).toEqual(before[key]);
      expect(before[key], key).not.toHaveProperty("stream");
    }
  });

  it("sends a per-call reasoning override (chart export) without changing page reads of the same model", async () => {
    const pageRead = await requestBody("google/gemini-3.1-flash-lite");
    const chartCall = await requestBody("google/gemini-3.1-flash-lite", undefined, { effort: "minimal" });
    expect(chartCall.reasoning).toEqual({ effort: "minimal" });
    expect(pageRead.reasoning).not.toEqual({ effort: "minimal" });
  });

  it("keeps effort none on the tuned DeepSeek vision request", async () => {
    expect((await requestBody("deepseek/deepseek-v4.1-flash-1017")).reasoning).toEqual({ effort: "none" });
  });
});
