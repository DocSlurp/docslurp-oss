import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTestPricing, DISTINCT_TEST_PRICING, resetActiveCapabilityPoolsForTests, resetPricingProviderForTests, VISION_GLM_HOSTS, visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, visionGuardFor } from "../lib/vision-attempt-guard.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

const LUNA = "llm://openrouter/openai/gpt-6-luna";
const cfg = {
  openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;

// A 1x1 PNG with a real header, so the runtime can read its size.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

let bodies: Array<Record<string, any>>;
/** What Luna answers: a routing refusal (default), a 400 bad request, or a content-filtered page. */
let lunaAnswer: "routing" | "bad-request" | "filtered" = "routing";
beforeEach(() => {
  lunaAnswer = "routing";
  vi.stubEnv("DOCSLURP_VISION_POOL_FALLBACK", "on");
  resetStreamingSupportForTest();
  resetActiveCapabilityPoolsForTests();
  bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Luna: no host can serve the request (a routing refusal, nothing billed). GLM: a page.
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.model === "openai/gpt-6-luna") {
      if (lunaAnswer === "bad-request") return new Response(JSON.stringify({ error: { message: "invalid image" } }), { status: 400 });
      if (lunaAnswer === "filtered") {
        return new Response(JSON.stringify({ model: body.model, provider: "Azure", choices: [{ message: { content: "Partial" }, finish_reason: "content_filter" }], usage: { prompt_tokens: 3_000, completion_tokens: 10 } }),
          { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "No endpoints found matching your data policy and max_price" } }), { status: 404 });
    }
    return new Response(JSON.stringify({ model: body.model, provider: "Wafer", choices: [{ message: { content: "# Page" }, finish_reason: "stop" }], usage: { prompt_tokens: 3_000, completion_tokens: 300 } }),
      { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPricingProviderForTests();
});

async function readPage(options: { pageRead?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pool-vision-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, PNG);
  const vision = visionConfigSchema.parse({ modelUri: LUNA });
  const host = { run: { id: "run-1", orgId: "org-a" }, visionAttempts: new MemoryVisionAttemptBackend() };
  const result = await guardedVisionCall({
    host, vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "page" }, record: () => null,
    call: (gate) => executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate, ...options }),
  }).catch((error: unknown) => error);
  return { result, host };
}

describe("vision capability pool: the deployment's default fallback", () => {
  it("fails a page read over from Luna to GLM on Luna's routing refusal, on GLM's stated-US hosts, and stamps the member", async () => {
    const { result } = await readPage({ pageRead: true });
    expect((result as { result: unknown }).result).toMatchObject({ fallbackUsed: true, poolMemberId: "vision.llm.glm-5.3-flash.us", text: "# Page" });
    expect(bodies.map((body) => body.model)).toEqual(["openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(bodies[0]!.provider.only).toEqual(["amazon-bedrock/us-east-1", "azure/us"]);
    // The fallback is sent on its pool member's route: the second read's GLM hosts under their price ceiling.
    expect(bodies[1]!.provider.only).toEqual(["wafer/us", "morph/fp8"]);
    expect(VISION_GLM_HOSTS).not.toContain("morph/fp8");
  });

  it("is off unless DOCSLURP_VISION_POOL_FALLBACK is on", async () => {
    vi.stubEnv("DOCSLURP_VISION_POOL_FALLBACK", "");
    const { result } = await readPage({ pageRead: true });
    expect(result).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
  });

  it("never fails over a refused input (400) or a content-filtered answer: those are the page's answer, not an outage", async () => {
    lunaAnswer = "bad-request";
    expect((await readPage({ pageRead: true })).result).toBeInstanceOf(Error);
    expect(bodies.map((body) => body.model)).toEqual(["openai/gpt-6-luna"]);
    bodies = [];
    lunaAnswer = "filtered";
    expect((await readPage({ pageRead: true })).result).toBeInstanceOf(Error);
    expect(bodies.every((body) => body.model === "openai/gpt-6-luna")).toBe(true);
  });

  it("values the failover of an unbilled primary as the page's only billed read (primaryBilled false)", async () => {
    const calls: unknown[] = [];
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: (call) => { calls.push(call); return 1; } });
    await readPage({ pageRead: true });
    expect(calls).toEqual([expect.objectContaining({ kind: "page-transcription", role: "fallback", primaryBilled: false })]);
  });

  it("an unbilled routing refusal never counts toward the breaker", async () => {
    const { host } = await readPage({ pageRead: true });
    expect(visionGuardFor(host as never).stop).toBeNull();
  });

  it("never falls back for a call that is not a page read (chart reads, OCR second reads)", async () => {
    const { result } = await readPage();
    expect(result).toBeInstanceOf(Error);
    expect(bodies.map((body) => body.model)).toEqual(["openai/gpt-6-luna"]);
  });

  it("DOCSLURP_VISION_FALLBACK_MODEL=off turns the default fallback off", async () => {
    vi.stubEnv("DOCSLURP_VISION_FALLBACK_MODEL", "off");
    const { result } = await readPage({ pageRead: true });
    expect(result).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
  });

  it("admits the fallback member only through the margin gate: a value that does not cover it refuses the failover", async () => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: () => 0.000_001 });
    const { result } = await readPage({ pageRead: true });
    expect(result).toBeInstanceOf(Error);
    expect(bodies.map((body) => body.model)).toEqual(["openai/gpt-6-luna"]);
  });
});
