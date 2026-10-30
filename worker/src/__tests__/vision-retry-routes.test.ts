import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHINA_PROVIDER_SLUGS, NON_CHINA_PROVIDER_SLUGS, providerRegion, visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { visionMaxPrice } from "../test/vision-max-price.js";
import { alternateRouteBody } from "../tools/vision-stream.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1" } as Config;
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const MIMO = "xiaomi/mimo-v2.6-flash";
const GLM = "z-ai/glm-5.3-flash";
const LUNA = "openai/gpt-6-luna";

describe("alternateRouteBody", () => {
  it("ignores the failing provider and keeps allow_fallbacks:true preferences intact", () => {
    const body = { provider: { order: ["relace", "deepinfra"], allow_fallbacks: true } };
    expect(alternateRouteBody(body, "Relace", "degenerate")).toEqual({ provider: { order: ["relace", "deepinfra"], allow_fallbacks: true, ignore: ["Relace"] } });
  });

  it("keeps an org's China-provider restriction when a refusal moves to the preferred retry route", () => {
    const body = { provider: { order: ["relace"], allow_fallbacks: true, ignore: ["Wafer", "z-ai", "deepseek"] } };
    expect(alternateRouteBody(body, "Relace", "refusal", { order: ["together"], allow_fallbacks: true })).toEqual({
      provider: { order: ["together"], allow_fallbacks: true, ignore: ["z-ai", "deepseek"] } });
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

/** Runs one vision request the way a run does: inside a provider scope (China-based providers allowed by default). */
async function run(model: string, responses: Response[], scope: { allowChinaProviders?: boolean } | null = { allowChinaProviders: true }) {
  return scope ? await runWithProviderRateScope({ orgId: "org", ...scope }, () => runUnscoped(model, responses)) : await runUnscoped(model, responses);
}

async function runUnscoped(model: string, responses: Response[]) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses.shift()!;
  }));
  const dir = await mkdtemp(join(tmpdir(), "vision-routes-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await executeVisionRuntime({
    imagePath, outputPath: `${imagePath}.json`, gate: null,
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
  it("DeepSeek-1017 goes to the cheapest measured host and retries without the failing one", async () => {
    const { bodies, result } = await run(DEEPSEEK, [
      filtered("StreamLake"),
      sse([{ id: "g", model: DEEPSEEK, provider: "Together", choices: [{ delta: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 20 } }]),
    ]);
    const only = ["together", "fireworks", "parasail"];
    expect(bodies[0]!.provider).toEqual({ only, sort: "price", allow_fallbacks: true, max_price: visionMaxPrice(DEEPSEEK) });
    expect(bodies[1]!.provider).toEqual({ only, sort: "price", allow_fallbacks: true, ignore: ["StreamLake"], max_price: visionMaxPrice(DEEPSEEK) });
    expect(result).toMatchObject({ text: "# Page", attempts: 2, inputTokens: 1400, outputTokens: 23 });
  });

  it("MiMo is refused before anything is sent (no serving-level image-token evidence)", async () => {
    await expect(run(MIMO, [])).rejects.toThrow(/is not admitted/);
  });

  it("Luna goes to its preferred retry route over SSE", async () => {
    const { bodies } = await run(LUNA, [
      filtered("OpenAI"),
      sse([{ id: "g", model: LUNA, provider: "Amazon Bedrock", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ]);
    expect(bodies[1]!.provider).toEqual({ order: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: false, max_price: visionMaxPrice(LUNA) });
  });
});

/** Asserts a restricted request body can reach only known non-China providers. */
function expectRestricted(provider: Record<string, any>) {
  expect(provider.only.length).toBeGreaterThan(0);
  for (const slug of provider.only) expect(providerRegion(slug), slug).toBe("other");
  for (const slug of provider.order ?? []) expect(providerRegion(slug), slug).toBe("other");
  expect(provider.ignore).toEqual(expect.arrayContaining([...CHINA_PROVIDER_SLUGS]));
}

describe("China-provider restriction (org or workspace opt-out)", () => {
  it("keeps China-based and unknown-region providers out of every attempt, retries included", async () => {
    const { bodies } = await run(GLM, [
      filtered("Wafer"),
      sse([{ id: "g", model: GLM, provider: "Friendli", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ], { allowChinaProviders: false });
    expect(bodies[0]!.provider).toEqual({ order: ["wafer/nvfp4", "friendli", "inference-net/fp4"], allow_fallbacks: false, only: [...NON_CHINA_PROVIDER_SLUGS], ignore: [...CHINA_PROVIDER_SLUGS], max_price: visionMaxPrice(GLM) });
    expect(bodies[1]!.provider).toMatchObject({ order: ["friendli", "inference-net/fp4"], ignore: ["Wafer", ...CHINA_PROVIDER_SLUGS] });
    for (const body of bodies) expectRestricted(body.provider);
  });

  it("narrows the DeepSeek route to its US hosts on the first try and on the alternate route", async () => {
    const { bodies } = await run(DEEPSEEK, [
      filtered("Together"),
      sse([{ id: "g", model: DEEPSEEK, provider: "Fireworks", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ], { allowChinaProviders: false });
    expect(bodies[0]!.provider).toEqual({ only: ["together", "fireworks", "parasail"], sort: "price", allow_fallbacks: true, ignore: [...CHINA_PROVIDER_SLUGS], max_price: visionMaxPrice(DEEPSEEK) });
    expect(bodies[1]!.provider).toMatchObject({ only: ["together", "fireworks", "parasail"], ignore: ["Together", ...CHINA_PROVIDER_SLUGS] });
    for (const body of bodies) expectRestricted(body.provider);
  });

  it("keeps the restriction on a content-filter retry that moves to a profile's preferred route", async () => {
    const { bodies } = await run(LUNA, [
      filtered("OpenAI"),
      sse([{ id: "g", model: LUNA, provider: "Amazon Bedrock", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ], { allowChinaProviders: false });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expectRestricted(body.provider);
    expect(bodies[1]!.provider.order).toEqual(["amazon-bedrock/us-east-1", "azure/us"]);
  });

  it("restricts a call made outside any run scope (unknown scope fails closed)", async () => {
    const { bodies } = await run(DEEPSEEK, [
      sse([{ id: "g", model: DEEPSEEK, provider: "Together", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ], null);
    expectRestricted(bodies[0]!.provider);
    // A scope without an explicit allow is restricted too.
    const { bodies: implicit } = await run(DEEPSEEK, [
      sse([{ id: "g", model: DEEPSEEK, provider: "Together", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ], {});
    expectRestricted(implicit[0]!.provider);
  });

  it("leaves an allowing org's routing unchanged", async () => {
    const { bodies } = await run(GLM, [
      sse([{ id: "g", model: GLM, provider: "Wafer", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]),
    ]);
    expect(bodies[0]!.provider).toEqual({ order: ["wafer/nvfp4", "friendli", "inference-net/fp4"], allow_fallbacks: false, max_price: visionMaxPrice(GLM) });
  });

  it("labels usage with the served host and its region", async () => {
    const { result } = await run(DEEPSEEK, [
      sse([{ id: "g", model: DEEPSEEK, provider: "StreamLake", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.00001 } }]),
    ]);
    expect(result.costMetadata).toMatchObject({ servedProvider: "StreamLake", servedProviderSlug: "streamlake", servedProviderRegion: "cn" });
  });
});

describe("served model and provider from a streamed result", () => {
  it("reads model from chunks and provider from the final usage chunk (string or {name})", async () => {
    for (const provider of ["DeepSeek", { name: "DeepSeek" }]) {
      const { result } = await run("deepseek/deepseek-v4.1-flash-1017", [sse([
        { id: "g", model: "deepseek/deepseek-v4.1-flash-0925", choices: [{ delta: { content: "hi" } }] },
        { id: "g", provider, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ])]);
      expect(result.servedModel).toBe("deepseek/deepseek-v4.1-flash-0925");
      expect(result.servedProvider).toBe("DeepSeek");
      expect(result.modelSwap).toMatchObject({ requested: "deepseek/deepseek-v4.1-flash-1017", served: "deepseek/deepseek-v4.1-flash-0925", provider: "DeepSeek" });
    }
  });
});

