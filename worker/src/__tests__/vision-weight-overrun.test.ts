import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, visionListPriceCents, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, resetVisionPendingOverrunsForTest, type VisionGuardStop } from "../lib/vision-attempt-guard.js";
import { visionImageTokenBound, visionInputTokenBound, visionRequestPricing } from "../lib/vision-pricing.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * The org bound holds on what providers bill, not only on what was admitted: a response whose provider usage (or
 * reported cost) prices above its request's admitted weight is logged, topped up on the org's uncharged count and
 * counted against its route for the org; after `VISION_ROUTE_OVERRUN_LIMIT` (default 3) overruns the route is refused
 * for that org only. Every other org keeps the route, at a weight raised by the route's billed/bound correction.
 */
const cfg = {
  openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;

const OPENAI = "llm://openai/gpt-4.1-mini";
const OPENROUTER = "llm://openrouter/google/gemini-3.1-flash-lite";

const answer = (usage: Record<string, unknown>) =>
  new Response(JSON.stringify({ provider: "ProvA", choices: [{ message: { content: "Total: 42" }, finish_reason: "stop" }], usage }),
    { headers: { "content-type": "application/json" } });

/** The admitted weight of one request on `model` for the 4-byte (size unknown) test image. */
function weightOf(model: string, billing: "openai" | "openrouter"): number {
  return visionRequestPricing({
    model, runtime: "openai-compatible", billing, inputTokens: visionInputTokenBound(null, visionPrompt(), model), imageTokens: visionImageTokenBound(null, model),
  }).weightCents;
}
let promptForWeight = "";
const visionPrompt = () => promptForWeight;

let sends: string[];
let warnings: string[];
let errors: string[];

beforeEach(() => {
  sends = [];
  warnings = [];
  errors = [];
  resetVisionPendingOverrunsForTest();
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  resetStreamingSupportForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (host: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const host = new URL(url).host;
    sends.push(host);
    return handler(host);
  }));
}

async function guardedRead(backend: MemoryVisionAttemptBackend, vision: VisionConfig, pageNumber = 1, orgId = "org-1") {
  const dir = await mkdtemp(join(tmpdir(), "vision-overrun-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let prompt = "";
  const outcome = await guardedVisionCall({
    host: { run: { id: `run-${orgId}`, orgId }, visionAttempts: backend },
    vision, cfg, target: { documentId: "doc", pageNumber, purpose: "region" },
    record: () => null,
    call: async (gate) => {
      const result = await executeVisionRuntime({
        imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
      });
      prompt = result.prompt;
      return result;
    },
  });
  return { outcome, prompt };
}

const vision = (modelUri: string, remoteFallbackModelUri?: string) =>
  visionConfigSchema.parse({ modelUri, ...(remoteFallbackModelUri ? { remoteFallbackModelUri } : {}) });

describe("billed usage above the admitted weight", () => {
  it("logs the overrun and tops the org's uncharged count up to what was billed", async () => {
    const backend = new MemoryVisionAttemptBackend();
    // Far more prompt tokens than the catalog's image bound allows: a provider counting more image tokens.
    const usage = { prompt_tokens: 400_000, completion_tokens: 300 };
    stubFetch(() => answer(usage));
    const { outcome, prompt } = await guardedRead(backend, vision(OPENAI));
    expect(outcome.admitted).toBe(true);
    promptForWeight = prompt;
    const bound = weightOf("gpt-4.1-mini", "openai");
    const billed = visionListPriceCents("gpt-4.1-mini", { inputTokens: 400_000, outputTokens: 300 })!;
    expect(billed).toBeGreaterThan(bound);
    const line = warnings.find((warning) => warning.startsWith("[vision-weight] overrun"));
    expect(line).toContain("model=gpt-4.1-mini provider=openai upstream=ProvA");
    expect(line).toContain(`billed=${billed.toFixed(4)} bound=${bound.toFixed(4)}`);
    // The request's own weight plus the top-up: the org count now equals the billed cost.
    expect(backend.orgCents("org-1")).toBeCloseTo(billed, 3);
    expect(backend.inspect("run-org-1", "org-1")).toMatchObject({ orgAttempts: 2, orgSettledAttempts: 2 });
  });

  it("does nothing for usage within the bound", async () => {
    const backend = new MemoryVisionAttemptBackend();
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    const { prompt } = await guardedRead(backend, vision(OPENAI));
    promptForWeight = prompt;
    expect(warnings.filter((warning) => warning.startsWith("[vision-weight] overrun"))).toEqual([]);
    expect(backend.orgCents("org-1")).toBeCloseTo(weightOf("gpt-4.1-mini", "openai"), 3);
  });

  it("counts a reported OpenRouter cost above the bound even when the token counts are within it", async () => {
    const backend = new MemoryVisionAttemptBackend();
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300, cost: 1 }));
    const { prompt } = await guardedRead(backend, vision(OPENROUTER));
    promptForWeight = prompt;
    expect(warnings.find((warning) => warning.startsWith("[vision-weight] overrun"))).toContain("billed=100.0000");
    expect(backend.orgCents("org-1")).toBeCloseTo(100, 3);
  });

  it("refuses the route for the overrunning org after three overruns in 24 hours, before sending; the fallback route still serves", async () => {
    const backend = new MemoryVisionAttemptBackend();
    stubFetch((host) => answer(host === "openrouter.ai" ? { prompt_tokens: 400_000, completion_tokens: 300 } : { prompt_tokens: 1_200, completion_tokens: 300 }));
    for (let page = 1; page <= 3; page += 1) {
      const { outcome } = await guardedRead(backend, vision(OPENROUTER), page);
      expect(outcome.admitted).toBe(true);
    }
    expect(sends).toEqual(["openrouter.ai", "openrouter.ai", "openrouter.ai"]);
    // Without a fallback: refused before anything is sent, logged with the route's count.
    const refused = await guardedRead(backend, vision(OPENROUTER), 4);
    expect(refused.outcome).toMatchObject({ admitted: false, stop: { reason: "route-overrun", sticky: false, routeOverruns: 3 } satisfies Partial<VisionGuardStop> });
    expect(sends).toHaveLength(3);
    expect(warnings.some((warning) => warning.includes("refused=route-overrun") && warning.includes("route=openrouter/google/gemini-3.1-flash-lite routeOverruns=3/3"))).toBe(true);
    // With a fallback on another route: the fallback serves.
    const served = await guardedRead(backend, vision(OPENROUTER, OPENAI), 5);
    expect(served.outcome.admitted).toBe(true);
    const result = (served.outcome as { result: VisionExecutionResult }).result;
    expect(result).toMatchObject({ fallbackUsed: true, route: { provider: "openai", model: "gpt-4.1-mini" } });
    expect(sends).toEqual(["openrouter.ai", "openrouter.ai", "openrouter.ai", "api.openai.com"]);
  });

  it("one org's overruns never refuse another org: the route's weight correction raises its weight, and it still runs", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const overrun = { prompt_tokens: 1_000_000, completion_tokens: 300 };
    stubFetch(() => answer(overrun));
    for (let page = 1; page <= 3; page += 1) await guardedRead(backend, vision(OPENROUTER), page, "org-a");
    expect((await guardedRead(backend, vision(OPENROUTER), 4, "org-a")).outcome).toMatchObject({ admitted: false, stop: { reason: "route-overrun" } });

    // The ratio is far above the cap: logged at error level, once, when it first raised the correction.
    const corrections = errors.filter((line) => line.startsWith("[vision-weight] correction"));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toContain("provider=openrouter model=google/gemini-3.1-flash-lite");
    expect(corrections[0]).toContain("factor=4.000 cap=4 capped=true org=org-a");

    // Org B on the same route: admitted (and sent), at four times the catalog bound.
    sends = [];
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    const { outcome, prompt } = await guardedRead(backend, vision(OPENROUTER), 1, "org-b");
    expect(outcome.admitted).toBe(true);
    expect(sends).toEqual(["openrouter.ai"]);
    promptForWeight = prompt;
    expect(backend.orgCents("org-b")).toBeCloseTo(4 * weightOf("google/gemini-3.1-flash-lite", "openrouter"), 3);
    expect(warnings.some((line) => line.includes("refused=") && line.includes("org=org-b"))).toBe(false);
  });

  it("a correction below the cap weighs the route at its highest billed/bound ratio", async () => {
    const backend = new MemoryVisionAttemptBackend();
    // Within the tokens, reported at 2.5 times the bound.
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    const { prompt } = await guardedRead(backend, vision(OPENROUTER), 1, "org-probe");
    promptForWeight = prompt;
    const bound = weightOf("google/gemini-3.1-flash-lite", "openrouter");
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300, cost: (2.5 * bound) / 100 }));
    await guardedRead(backend, vision(OPENROUTER), 1, "org-a");
    expect(errors.find((line) => line.startsWith("[vision-weight] correction"))).toContain("ratio=2.500 previous=1.000 factor=2.500 cap=4 capped=false");
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    await guardedRead(backend, vision(OPENROUTER), 1, "org-b");
    expect(backend.orgCents("org-b")).toBeCloseTo(2.5 * bound, 3);
  });
});
