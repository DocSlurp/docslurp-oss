import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { MemoryVisionAttemptBackend, VisionGuardStopError, VisionRunGuard, type VisionGuardConfig } from "../lib/vision-attempt-guard.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { findVisionBilledUsage } from "../tools/vision-stream.js";

/**
 * Admission per HTTP request through the real request path (executeVisionRuntime -> stream guard ->
 * fetchWithProviderRetry) with only `fetch` stubbed: every request a provider can see is admitted.
 */
const cfg = { openRouterApiKey: "or-key", openAiApiKey: "", openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const config: VisionGuardConfig = { pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgAttemptLimit: 1_000 };

let backend: MemoryVisionAttemptBackend;
let guard: VisionRunGuard;

beforeEach(() => {
  backend = new MemoryVisionAttemptBackend();
  guard = new VisionRunGuard({ id: "run-1", orgId: "org-1" }, config, backend);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Inline retries back off for at most 1 ms here.
  vi.stubEnv("AI_PROVIDER_MAX_INLINE_WAIT_MS", "1");
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

  it("inline provider retries each consume an admission", async () => {
    const unavailable = () => new Response("upstream unavailable", { status: 503 });
    const fetch = stubFetch([unavailable, plain]);
    const result = await read();
    expect(result.text).toBe("plain");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(backend.inspect("run-1", "org-1")).toMatchObject({ runAttempts: 2, runFailures: 1, orgAttempts: 2 });
  });

  it("refuses the request past the page's bound before sending it, whatever path would send it", async () => {
    const unavailable = () => new Response("upstream unavailable", { status: 503 });
    // Two 503s use the page's two requests: the third (an inline retry) is never sent.
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
