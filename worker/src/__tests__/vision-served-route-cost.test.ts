import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema, visionListPriceCents, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { guardedVisionCall, priceVisionResult } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, VisionRunGuard, findVisionGuardStop } from "../lib/vision-attempt-guard.js";
import { visionRouteBilling } from "../lib/vision-pricing.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { executeVisionRuntime, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { findVisionOutputRejected, resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * Vision usage is priced and labelled on the route that actually served (or billed) each request: a fallback's
 * model and provider, the configured OpenAI base URL, never the workspace's configured primary route.
 */
const baseCfg = {
  openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;

const LOOPBACK = "llm://vllm/acme/plain-vl";
const OPENAI = "llm://openai/gpt-4.1-mini";
const OPENROUTER = "llm://openrouter/google/gemini-3.1-flash-lite";

const answer = (finishReason: "stop" | "length", usage = { prompt_tokens: 1_200, completion_tokens: 300 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: "Total: 42" }, finish_reason: finishReason }], usage }),
    { headers: { "content-type": "application/json" } });
const badRequest = () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "content-type": "application/json" } });

type Route = "loopback" | "openai" | "openrouter" | "gateway";
function routeOf(url: string): Route {
  const host = new URL(url).host;
  if (host.startsWith("127.0.0.1")) return "loopback";
  if (host === "api.openai.com") return "openai";
  if (host === "openrouter.ai") return "openrouter";
  return "gateway";
}

let sends: Array<{ route: Route; url: string; authorization: string | null }>;

beforeEach(() => {
  sends = [];
  resetStreamingSupportForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (route: Route) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const route = routeOf(url);
    sends.push({ route, url, authorization: new Headers(init.headers).get("authorization") });
    return handler(route);
  }));
}

async function guardedRead(vision: VisionConfig, cfg: Config = baseCfg) {
  const dir = await mkdtemp(join(tmpdir(), "vision-served-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const recorded: WorkerAiUsageInput[] = [];
  const host = { run: { id: "run-1", orgId: "org-1" }, visionAttempts: new MemoryVisionAttemptBackend() };
  const outcome = await guardedVisionCall({
    host, vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" },
    record: (input) => {
      recorded.push(input);
      return null;
    },
    call: (gate) => executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
    }),
  }).catch((error: unknown) => error);
  return { outcome, recorded };
}

const vision = (modelUri: string, remoteFallbackModelUri?: string) =>
  visionConfigSchema.parse({ modelUri, ...(remoteFallbackModelUri ? { remoteFallbackModelUri } : {}) });

describe("vision usage priced on the served route", () => {
  it("a loopback primary whose OpenAI fallback is billed and rejected records the spend under the fallback model", async () => {
    stubFetch((route) => (route === "loopback" ? badRequest() : answer("length")));
    const { outcome, recorded } = await guardedRead(vision(LOOPBACK, OPENAI));
    expect(outcome).toBeInstanceOf(Error);
    expect(sends.some((send) => send.route === "loopback")).toBe(true);
    expect(sends.filter((send) => send.route === "openai").length).toBeGreaterThanOrEqual(1);
    expect(recorded).toHaveLength(1);
    const [event] = recorded;
    expect(event).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", metric: "page-analysis-attempt", metadata: { outcome: "rejected", billable: false } });
    // The OpenAI fallback billed every attempt at gpt-4.1-mini's list price; the loopback primary billed nothing.
    expect(event!.costCents!).toBeGreaterThan(0);
    expect(event!.costCents!).toBeCloseTo(visionListPriceCents("gpt-4.1-mini", { inputTokens: event!.inputTokens!, outputTokens: event!.outputTokens! })!, 10);
  });

  it("a local-to-hosted fallback success is priced and labelled on the hosted route", async () => {
    stubFetch((route) => (route === "loopback" ? badRequest() : answer("stop")));
    const { outcome, recorded } = await guardedRead(vision(LOOPBACK, OPENAI));
    const result = (outcome as { admitted: true; result: VisionExecutionResult }).result;
    expect(result.fallbackUsed).toBe(true);
    expect(result.route).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", billing: "openai", baseUrl: "https://api.openai.com/v1" });
    expect(priceVisionResult(result, baseCfg)).toBeCloseTo(visionListPriceCents("gpt-4.1-mini", { inputTokens: 1_200, outputTokens: 300 })!, 10);
    // The loopback failure was never billed: nothing recorded for it.
    expect(recorded).toEqual([]);
  });

  it("a billed, rejected OpenRouter primary before a successful fallback is recorded on the primary's own route", async () => {
    stubFetch((route) => (route === "openrouter" ? answer("length") : answer("stop")));
    const { outcome, recorded } = await guardedRead(vision(OPENROUTER, OPENAI));
    const result = (outcome as { admitted: true; result: VisionExecutionResult }).result;
    expect(result.route).toMatchObject({ provider: "openai", model: "gpt-4.1-mini" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "openrouter", model: "google/gemini-3.1-flash-lite", metadata: { outcome: "rejected", fallbackPrimary: true } });
    expect(recorded[0]!.costCents!).toBeGreaterThan(0);
  });

  describe("a loopback OPENAI_BASE_URL", () => {
    const cfg = { ...baseCfg, openAiBaseUrl: "http://127.0.0.1:9000/v1" } as Config;

    it("is unbilled when it serves: 0 cents, no OpenAI key", async () => {
      stubFetch(() => answer("stop"));
      const { outcome } = await guardedRead(vision(OPENAI), cfg);
      const result = (outcome as { admitted: true; result: VisionExecutionResult }).result;
      expect(sends.map((send) => send.url)).toEqual(["http://127.0.0.1:9000/v1/chat/completions"]);
      expect(sends[0]!.authorization).toBeNull();
      expect(result.route).toMatchObject({ billing: "loopback", provider: "vision-runtime", baseUrl: "http://127.0.0.1:9000/v1" });
      expect(priceVisionResult(result, cfg)).toBe(0);
    });

    it("records a rejected read at 0 cents too, in the guarded call and in vision-extract", async () => {
      stubFetch(() => answer("length"));
      const { outcome, recorded } = await guardedRead(vision(OPENAI), cfg);
      expect(outcome).toBeInstanceOf(Error);
      expect(sends.every((send) => send.route === "loopback")).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ costCents: 0, provider: "vision-runtime", metadata: { outcome: "rejected" } });

      // vision-extract's own recorder prices the same error on the same route.
      const stage = new VisionExtractStage({} as CommandRunner, {} as ArtifactStore, cfg, {} as never);
      const record = (stage as unknown as { recordFailedVisionAttempt(...args: unknown[]): { providerCostCents: number } })
        .recordFailedVisionAttempt.bind(stage);
      stubFetch(() => answer("length"));
      const imagePath = join(await mkdtemp(join(tmpdir(), "vision-served-")), "page.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const error = await executeVisionRuntime({
        imagePath, outputPath: `${imagePath}.json`,
        vision: vision(OPENAI), cfg, runner: new CommandRunner(), privacyMode: "standard", gate: null,
      }).catch((caught: unknown) => caught);
      expect(findVisionOutputRejected(error)).not.toBeNull();
      const state = { usageLedger: new PipelineUsageEventLedger(), pendingPerformance: [] } as unknown as WorkflowState;
      const { providerCostCents } = record(state, { id: "doc" }, vision(OPENAI), { pageNumber: 1, artifactUri: "x" }, "rejected", error);
      expect(providerCostCents).toBe(0);
      expect(state.usageLedger.snapshot()).toMatchObject([{ costCents: 0, provider: "vision-runtime", model: "gpt-4.1-mini", metadata: { outcome: "rejected" } }]);
    });
  });

  it("sends a route with no base URL of its own to OPENAI_BASE_URL, with the OpenAI key, billed as OpenAI", async () => {
    const cfg = { ...baseCfg, openAiBaseUrl: "https://gateway.example/v1" } as Config;
    expect(visionRouteBilling({ runtime: "remote-openai", baseUrl: null }, cfg)).toBe("openai");
    stubFetch(() => answer("stop"));
    const { outcome } = await guardedRead(vision(OPENAI), cfg);
    const result = (outcome as { admitted: true; result: VisionExecutionResult }).result;
    expect(sends.map((send) => send.url)).toEqual(["https://gateway.example/v1/chat/completions"]);
    expect(sends[0]!.authorization).toBe("Bearer sk-test");
    expect(result.route).toMatchObject({ billing: "openai", provider: "openai", baseUrl: "https://gateway.example/v1" });
    expect(priceVisionResult(result, cfg)).toBeGreaterThan(0);
  });

  it("an empty OPENAI_BASE_URL sends to api.openai.com and bills it", async () => {
    const cfg = { ...baseCfg, openAiBaseUrl: "" } as Config;
    stubFetch(() => answer("stop"));
    const { outcome } = await guardedRead(vision(OPENAI), cfg);
    const result = (outcome as { admitted: true; result: VisionExecutionResult }).result;
    expect(sends.map((send) => send.url)).toEqual(["https://api.openai.com/v1/chat/completions"]);
    expect(result.route.billing).toBe("openai");
  });

  describe("interrupted streams are priced on the route that served them", () => {
    const streamingCfg = { ...baseCfg, visionStreaming: true } as Config;
    const enc = new TextEncoder();
    /** A 200 SSE stream that sends `chunks` and then breaks. */
    const broken = (chunks: Array<Record<string, unknown>>) => {
      let index = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`));
          else controller.error(new Error("socket hang up"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const delta = (content: string, extra: Record<string, unknown> = {}) => ({ id: "gen-1", provider: "ProvA", choices: [{ delta: { content } }], ...extra });
    const text = "Readable streamed paragraph text. ".repeat(40);

    it("a loopback stream cut off mid-response records 0 cents, never the configured rates", async () => {
      stubFetch(() => broken([delta(text)]));
      const { outcome, recorded } = await guardedRead(vision(LOOPBACK), streamingCfg);
      expect(outcome).toBeInstanceOf(Error);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ provider: "vision-runtime", costCents: 0, metadata: { outcome: "failure", usageSource: "estimated" } });
      expect(recorded[0]!.outputTokens!).toBeGreaterThan(0);
    });

    it("a hosted stream cut off mid-response is priced at the served model's list price", async () => {
      stubFetch(() => broken([delta(text)]));
      const { recorded } = await guardedRead(vision(OPENAI), streamingCfg);
      expect(recorded).toHaveLength(1);
      const [event] = recorded;
      expect(event).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", metadata: { outcome: "failure" } });
      const listPrice = visionListPriceCents("gpt-4.1-mini", { inputTokens: event!.inputTokens!, outputTokens: event!.outputTokens! })!;
      const configuredRate = (event!.inputTokens! / 1000) * baseCfg.costPer1kInputTokens + (event!.outputTokens! / 1000) * baseCfg.costPer1kOutputTokens;
      expect(listPrice).not.toBeCloseTo(configuredRate, 6);
      expect(event!.costCents!).toBeCloseTo(listPrice, 10);
    });

    it("a stream cut off after a usage chunk with a reported cost records that cost", async () => {
      stubFetch(() => broken([delta(text, { usage: { prompt_tokens: 1_500, completion_tokens: 400, cost: 0.0042 } })]));
      const { recorded } = await guardedRead(vision(OPENROUTER), streamingCfg);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ provider: "openrouter", inputTokens: 1_500, outputTokens: 400, metadata: { usageSource: "provider" } });
      expect(recorded[0]!.costCents!).toBeCloseTo(0.42, 10);
    });
  });

  it("vision-extract records a billed, rejected primary once when the guard refuses its fallback", async () => {
    // Both OpenRouter attempts are rejected (truncated); the page's bound of two requests then refuses the fallback.
    const rejected = () => new Response(JSON.stringify({ provider: "ProvA", choices: [{ message: { content: "Total: 42" }, finish_reason: "length" }], usage: { prompt_tokens: 1_200, completion_tokens: 300 } }),
      { headers: { "content-type": "application/json" } });
    stubFetch((route) => (route === "openrouter" ? rejected() : answer("stop")));
    const imagePath = join(await mkdtemp(join(tmpdir(), "vision-served-")), "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const stage = new VisionExtractStage(new CommandRunner(), {} as ArtifactStore, baseCfg, {} as never);
    const runVisionCall = (stage as unknown as { runVisionCall(...args: unknown[]): Promise<unknown> }).runVisionCall.bind(stage);
    const state = {
      run: { id: "run-1", orgId: "org-1", pipeline: { privacyMode: "standard", outputSchema: null } },
      usageLedger: new PipelineUsageEventLedger(),
      pendingPerformance: [],
    } as unknown as WorkflowState;
    const guard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, {
      pageAttempts: 2, regionAttempts: 12, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 100_000, throttleAllowance: 5, routeOverrunLimit: 3,
    }, new MemoryVisionAttemptBackend());
    const gate = guard.call({ documentId: "doc", pageNumber: 1, purpose: "page" });
    const error = await runVisionCall(state, { id: "doc" }, vision(OPENROUTER, OPENAI), { imagePath, outputPath: `${imagePath}.json` },
      { mimeType: "image/png", pageNumber: 1, artifactUri: "raster://1" }, gate).catch((caught: unknown) => caught);
    await gate.finish();
    expect(findVisionGuardStop(error)?.reason).toBe("page-attempt-limit");
    expect(sends.map((send) => send.route)).toEqual(["openrouter", "openrouter"]);
    const events = state.usageLedger.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis-attempt", inputTokens: 2_400, outputTokens: 600,
      metadata: { outcome: "rejected", fallbackPrimary: true, documentId: "doc", pageNumber: 1 },
    });
    // Not charged to the customer (billable false); our provider spend is kept as providerCostCents.
    expect(events[0]!.metadata!.providerCostCents as number).toBeCloseTo(visionListPriceCents("google/gemini-3.1-flash-lite", { inputTokens: 2_400, outputTokens: 600 })!, 10);
    expect(events[0]!.metadata!.providerCostCents as number).toBeGreaterThan(0);
  });
});
