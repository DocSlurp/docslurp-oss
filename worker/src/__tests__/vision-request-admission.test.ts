import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { MemoryVisionAttemptBackend, VisionGuardStopError, VisionRunGuard, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import { fetchWithProviderRetry, ProviderConcurrencyLimiter, ProviderRetryableError } from "../lib/provider-retry.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { findVisionBilledUsage, resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * Admission per HTTP request through the real request path (executeVisionRuntime -> stream guard ->
 * fetchWithProviderRetry) with only `fetch` stubbed: every request a provider can see is admitted.
 */
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const config: VisionGuardConfig = { pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 1_000, throttleAllowance: 5 };

let backend: MemoryVisionAttemptBackend;
let guard: VisionRunGuard;

beforeEach(() => {
  backend = new MemoryVisionAttemptBackend();
  guard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, backend);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Inline retries back off for at most 1 ms here.
  vi.stubEnv("AI_PROVIDER_MAX_INLINE_WAIT_MS", "1");
  resetStreamingSupportForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** One page read through a gate of the run's guard, settled afterwards like the stage does. */
async function read(pageNumber = 1) {
  const dir = await mkdtemp(join(tmpdir(), "vision-admission-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const gate = guard.call({ documentId: "doc", pageNumber, purpose: "page" });
  try {
    return await executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`, vision: visionConfigSchema.parse({ profile: "open-weights-hosted" }),
      cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
    });
  } finally {
    await gate.finish();
  }
}

const enc = new TextEncoder();
/** An SSE response that sends `chunks` and then breaks (or ends cleanly with `end`). */
function sse(chunks: Array<Record<string, unknown>>, end: "error" | "close" = "close"): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`));
      else if (end === "error") controller.error(new Error("socket hang up"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (content: string) => ({ id: "gen-1", model: "m", provider: "ProvA", choices: [{ delta: { content } }] });
const plain = () => new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  { headers: { "content-type": "application/json" } });

function stubFetch(responses: Array<() => Response>) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("vision request admission", () => {
  it("an interrupted stream consumes its admission and keeps its streamed output in the billed usage", async () => {
    const streamed = "# Heading\n\n" + "Readable streamed paragraph text. ".repeat(40);
    stubFetch([() => sse([delta(streamed.slice(0, 600)), delta(streamed.slice(600))], "error")]);
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // The request was admitted, failed, and stays uncharged for the org.
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 1, runFailures: 1, orgAttempts: 1, orgSettledAttempts: 1 });
    // Usage records the output that arrived before the break (estimated), not zero.
    const billed = findVisionBilledUsage(error);
    expect(billed?.outputTokens).toBeGreaterThanOrEqual(Math.floor(streamed.trim().length / 4));
    expect(billed?.inputTokens).toBeGreaterThan(0);
    expect(billed?.usageSource).toBe("estimated");
  });

  it("a 200 stream that breaks before its first chunk and its JSON fallback each consume an admission", async () => {
    const fetch = stubFetch([() => sse([], "error"), plain]);
    const result = await read();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("plain");
    // Two requests: the broken stream (failed) and the fallback (read).
    expect(backend.inspect("run-1", "org-1")).toMatchObject({ runAttempts: 2, runFailures: 1 });
    // The accepted stream's input is recorded with the fallback's usage instead of being dropped.
    expect(result.inputTokens).toBeGreaterThan(5);
    expect(result.usageSource).toBe("estimated");
    expect(result.attempts).toBe(1);
  });

  it("inline provider retries after a possibly accepted failure each consume an admission", async () => {
    const failed = () => new Response("internal error", { status: 500 });
    const fetch = stubFetch([failed, plain]);
    const result = await read();
    expect(result.text).toBe("plain");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(backend.inspect("run-1", "org-1")).toMatchObject({ runAttempts: 2, runFailures: 1, orgAttempts: 2 });
  });

  it("unbilled throttles (429, 503, 529) leave the page bound, the breaker and the org count", async () => {
    const throttled = () => new Response("slow down", { status: 429 });
    const overloaded = () => new Response("overloaded", { status: 503 });
    const busy = () => new Response("overloaded", { status: 529 });
    const fetch = stubFetch([throttled, overloaded, busy, throttled, plain]);
    const result = await read();
    expect(result.text).toBe("plain");
    expect(fetch).toHaveBeenCalledTimes(5);
    // Only the request the provider accepted is counted.
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 1, runFailures: 0, orgAttempts: 1, orgSettledAttempts: 1 });
  });

  it("past the throttle allowance the wait goes to Temporal with its Retry-After, and nothing is counted", async () => {
    vi.stubEnv("AI_PROVIDER_MAX_RETRIES", "20");
    const throttled = () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    const fetch = stubFetch(Array.from({ length: 6 }, () => throttled));
    const error = await read().catch((caught: unknown) => caught);
    // A retryable provider error (the activity retries), not a guard refusal of the page.
    expect(error).toBeInstanceOf(ProviderRetryableError);
    expect(error).not.toBeInstanceOf(VisionGuardStopError);
    expect((error as ProviderRetryableError).retryAfterMs).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 0, runFailures: 0, orgAttempts: 0, orgSettledAttempts: 0 });
  });

  it("a streaming request refused as unsupported is not a failure, and later calls skip streaming", async () => {
    const unsupported = () => new Response("stream not supported", { status: 400 });
    const fetch = stubFetch([unsupported, plain]);
    expect((await read()).text).toBe("plain");
    // The refused stream consumed nothing: one admission, no breaker failure.
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 1, runFailures: 0, orgAttempts: 1, orgSettledAttempts: 1 });
    // Memoized per endpoint and model: the next call goes straight to JSON.
    stubFetch([plain]);
    expect((await read(2)).text).toBe("plain");
    const body = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.stream).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a request rejected with and without streaming does not turn streaming off, and its JSON failure counts", async () => {
    const bad = () => new Response("bad image", { status: 400 });
    stubFetch([bad, bad]);
    await expect(read()).rejects.toThrow(/vision request failed: 400/);
    expect(backend.inspect("run-1", "org-1")).toMatchObject({ runAttempts: 1, runFailures: 1 });
    stubFetch([plain]);
    await read(2);
    const body = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.stream).toBe(true);
  });

  it("refuses the request past the page's bound before sending it, whatever path would send it", async () => {
    const unavailable = () => new Response("bad gateway", { status: 502 });
    // Two 502s use the page's two requests: the third (an inline retry) is never sent.
    const fetch = stubFetch([unavailable, unavailable, plain]);
    const error = await read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VisionGuardStopError);
    expect((error as VisionGuardStopError).stop).toMatchObject({ reason: "page-attempt-limit", pageAttempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(backend.inspect("run-1", "org-1")).toMatchObject({ runAttempts: 2, runFailures: 2, orgAttempts: 2 });
    // The next page keeps its own bound.
    stubFetch([plain]);
    expect((await read(2)).text).toBe("plain");
  });
});

describe("admission happens right before fetch, inside the limiter", () => {
  const gateOf = () => guard.call({ documentId: "doc", pageNumber: 1, purpose: "page" });

  it("a local concurrency limiter wait that is aborted sends nothing and consumes nothing", async () => {
    const limiter = new ProviderConcurrencyLimiter(() => 1);
    let release!: () => void;
    // Another request holds the provider's only slot.
    const holder = limiter.run("openrouter", () => new Promise<void>((resolve) => { release = resolve; }));
    const fetch = vi.fn(async () => plain());
    const controller = new AbortController();
    const gate = gateOf();
    const pending = fetchWithProviderRetry("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }, {
      provider: "openrouter", label: "vision request", fetchImpl: fetch, limiter, signal: controller.signal, gate,
    });
    controller.abort(new Error("activity cancelled"));
    await expect(pending).rejects.toThrow(/activity cancelled/);
    await gate.finish();
    release();
    await holder;
    expect(fetch).not.toHaveBeenCalled();
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 0, runFailures: 0, orgAttempts: 0, orgSettledAttempts: 0 });
  });

  it("an already aborted call with a free slot sends nothing, consumes nothing and takes no slot", async () => {
    const limiter = new ProviderConcurrencyLimiter(() => 4);
    const fetch = vi.fn(async () => plain());
    const controller = new AbortController();
    controller.abort(new Error("activity cancelled"));
    const gate = gateOf();
    const admit = vi.spyOn(gate, "admit");
    await expect(fetchWithProviderRetry("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }, {
      provider: "openrouter", label: "vision request", fetchImpl: fetch, limiter, signal: controller.signal, gate,
    })).rejects.toThrow(/activity cancelled/);
    await gate.finish();
    expect(admit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(limiter.inFlight("openrouter")).toBe(0);
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 0, runFailures: 0, orgAttempts: 0, orgSettledAttempts: 0 });
    // The limiter alone refuses an aborted caller even with free slots.
    await expect(limiter.run("openrouter", async () => "ran", controller.signal)).rejects.toThrow(/activity cancelled/);
    expect(limiter.inFlight("openrouter")).toBe(0);
  });

  it("a call aborted while its admission is in the database is handed back unsent", async () => {
    let admitted!: () => void;
    const inDb = new Promise<void>((resolve) => { admitted = resolve; });
    // The ledger's admission (a Postgres round trip) is still pending when the activity is cancelled.
    const slow = new (class extends MemoryVisionAttemptBackend {
      override async admit(...args: Parameters<MemoryVisionAttemptBackend["admit"]>) {
        const admission = await super.admit(...args);
        await inDb;
        return admission;
      }
    })();
    const slowGuard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, slow);
    const gate = slowGuard.call({ documentId: "doc", pageNumber: 1, purpose: "page" });
    const fetch = vi.fn(async () => plain());
    const controller = new AbortController();
    const pending = fetchWithProviderRetry("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }, {
      provider: "openrouter", label: "vision request", fetchImpl: fetch, limiter: new ProviderConcurrencyLimiter(() => 4), signal: controller.signal, gate,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("activity cancelled"));
    admitted();
    await expect(pending).rejects.toThrow(/activity cancelled/);
    await gate.finish();
    expect(fetch).not.toHaveBeenCalled();
    expect(gate.requests).toBe(0);
    expect(slow.inspect("run-1", "org-1")).toEqual({ runAttempts: 0, runFailures: 0, orgAttempts: 0, orgSettledAttempts: 0 });
    expect(vi.mocked(console.warn).mock.calls.some(([line]) => String(line).startsWith("[vision-throttle-handback] org=org-1 run=run-1 kind=cancelled"))).toBe(true);
  });

  it("logs each unbilled throttle hand-back with its org", async () => {
    stubFetch([() => new Response("slow down", { status: 429 }), plain]);
    await read();
    expect(vi.mocked(console.warn).mock.calls.some(([line]) => String(line).startsWith("[vision-throttle-handback] org=org-1 run=run-1 kind=throttle document=doc page=1"))).toBe(true);
  });

  it("a fleet rate limiter refusal sends nothing and consumes nothing", async () => {
    const fetch = vi.fn(async () => plain());
    const refusing = {
      acquire: vi.fn(async () => { throw new ProviderRetryableError("rate limit budget exhausted", "openrouter", 429, 5_000, 0); }),
      reportThrottle: vi.fn(async () => undefined),
    };
    const gate = gateOf();
    await expect(fetchWithProviderRetry("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }, {
      provider: "openrouter", label: "vision request", fetchImpl: fetch, gate,
      rateLimit: { model: "m", tokens: 100, limiter: refusing as never },
    })).rejects.toBeInstanceOf(ProviderRetryableError);
    await gate.finish();
    expect(fetch).not.toHaveBeenCalled();
    expect(backend.inspect("run-1", "org-1")).toEqual({ runAttempts: 0, runFailures: 0, orgAttempts: 0, orgSettledAttempts: 0 });
  });

  it("is admitted only once the limiter grants the slot", async () => {
    const limiter = new ProviderConcurrencyLimiter(() => 1);
    let release!: () => void;
    const holder = limiter.run("openrouter", () => new Promise<void>((resolve) => { release = resolve; }));
    const gate = gateOf();
    const pending = fetchWithProviderRetry("https://openrouter.ai/api/v1/chat/completions", { method: "POST" }, {
      provider: "openrouter", label: "vision request", fetchImpl: vi.fn(async () => plain()), limiter, gate,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.requests).toBe(0);
    release();
    await holder;
    await pending;
    expect(gate.requests).toBe(1);
    await gate.finish();
  });
});
