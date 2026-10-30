import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { visionConfigSchema } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import {
  MemoryVisionAttemptBackend,
  resetVisionPendingOverrunsForTest,
  setVisionOverrunRetryDelaysForTest,
  type VisionAttemptBackend,
  type VisionGuardHost,
  type VisionOverrunRequest,
} from "../lib/vision-attempt-guard.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { findVisionBilledUsage, resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * A billed overrun is reconciled, or nothing more runs for its org: a top-up write that fails (after retries) stops
 * the run stickily and refuses the org in this process until a retry persists it, and a write whose commit was not
 * acknowledged is retried without counting twice (the ticket is the key). Streams that end without a usage chunk
 * are reconciled from OpenRouter's generation receipt, or recorded as estimates.
 */
const OPENROUTER = "llm://openrouter/google/gemini-3.1-flash-lite";

const cfgFor = (visionStreaming: boolean) => ({
  openRouterApiKey: "or-key", openAiApiKey: "sk-test", openAiBaseUrl: "https://api.openai.com/v1",
  costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming,
} as Config);

const answer = (usage: Record<string, unknown>) =>
  new Response(JSON.stringify({ id: "gen-1", provider: "ProvA", choices: [{ message: { content: "Total: 42" }, finish_reason: "stop" }], usage }),
    { headers: { "content-type": "application/json" } });

/** A memory ledger whose overrun writes fail, or commit and then fail (the acknowledgement lost), on demand. */
class FlakyLedger implements VisionAttemptBackend {
  readonly inner = new MemoryVisionAttemptBackend();
  mode: "ok" | "fail" | "commit-then-fail" = "ok";
  writes = 0;
  admit = this.inner.admit.bind(this.inner);
  release = this.inner.release.bind(this.inner);
  settle = this.inner.settle.bind(this.inner);
  async recordOverrun(request: VisionOverrunRequest) {
    this.writes += 1;
    if (this.mode === "fail") throw new Error("connection reset");
    const result = await this.inner.recordOverrun(request);
    if (this.mode === "commit-then-fail") {
      this.mode = "ok";
      throw new Error("connection reset after commit");
    }
    return result;
  }
}

let sends: string[];
let errors: string[];
let warnings: string[];

beforeEach(() => {
  sends = [];
  errors = [];
  warnings = [];
  resetStreamingSupportForTest();
  resetVisionPendingOverrunsForTest();
  setVisionOverrunRetryDelaysForTest([1, 1]);
  vi.stubEnv("VISION_ORG_UNCHARGED_LIMIT_CENTS", "50");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { warnings.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
});

afterEach(() => {
  setVisionOverrunRetryDelaysForTest(null);
  resetVisionPendingOverrunsForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: URL) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const parsed = new URL(url);
    sends.push(parsed.pathname);
    return handler(parsed);
  }));
}

async function imageFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vision-reconcile-"));
  const imagePath = join(dir, "page.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return imagePath;
}

async function guardedRead(host: VisionGuardHost, pageNumber = 1, streaming = false) {
  const imagePath = await imageFile();
  const vision = visionConfigSchema.parse({ modelUri: OPENROUTER });
  const cfg = cfgFor(streaming);
  return await guardedVisionCall({
    host, vision, cfg, target: { documentId: "doc", pageNumber, purpose: "region" },
    record: () => null,
    call: async (gate) => await executeVisionRuntime({
      imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate,
    }),
  });
}

const host = (ledger: VisionAttemptBackend, runId: string, orgId = "org-1"): VisionGuardHost => ({ run: { id: runId, orgId }, visionAttempts: ledger });

describe("overrun reconciliation fails closed", () => {
  it("a top-up that cannot be written stops the run and refuses the org until a retry persists it", async () => {
    const ledger = new FlakyLedger();
    // Reported at 30 cents, against a weight of about 2.6 cents: the org bound is 50 cents.
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300, cost: 0.3 }));
    ledger.mode = "fail";
    const runA = host(ledger, "run-a");
    expect((await guardedRead(runA, 1)).admitted).toBe(true);
    expect(ledger.writes).toBe(3);
    expect(errors.some((line) => line.includes("overrun reconciliation pending") && line.includes("run=run-a"))).toBe(true);
    // Before this fix the org count stayed at the admitted weight and the next ~18 requests were admitted.
    expect(ledger.inner.orgCents("org-1")).toBeLessThan(5);

    // Nothing more is sent for the org, from this run or another, while the write keeps failing.
    sends = [];
    expect(await guardedRead(runA, 2)).toMatchObject({ admitted: false, stop: { reason: "overrun-unreconciled", sticky: true } });
    expect(await guardedRead(host(ledger, "run-b"), 1)).toMatchObject({ admitted: false, stop: { reason: "overrun-unreconciled", sticky: true } });
    expect(sends).toEqual([]);
    // Another org is unaffected.
    expect((await guardedRead(host(ledger, "run-c", "org-2"), 1)).admitted).toBe(true);

    // The ledger recovers: the next admission of the org persists the top-up first, then proceeds; run A stays stopped.
    ledger.mode = "ok";
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    expect((await guardedRead(host(ledger, "run-d"), 1)).admitted).toBe(true);
    expect(ledger.inner.orgCents("org-1")).toBeGreaterThanOrEqual(30);
    expect(await guardedRead(runA, 3)).toMatchObject({ admitted: false, stop: { reason: "overrun-unreconciled" } });
  });

  it("a write whose commit was not acknowledged is retried without counting the overrun twice", async () => {
    const ledger = new FlakyLedger();
    ledger.mode = "commit-then-fail";
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300, cost: 0.3 }));
    expect((await guardedRead(host(ledger, "run-a"), 1)).admitted).toBe(true);
    expect(ledger.writes).toBe(2);
    // The admitted weight plus one top-up: exactly the 30 billed cents.
    expect(ledger.inner.orgCents("org-1")).toBeCloseTo(30, 3);
    expect(errors.some((line) => line.includes("overrun reconciliation pending"))).toBe(false);
    stubFetch(() => answer({ prompt_tokens: 1_200, completion_tokens: 300 }));
    expect((await guardedRead(host(ledger, "run-b"), 1)).admitted).toBe(true);
  });
});

/** An SSE response of `chunks`, then the end of the stream or (`cut`) a network error. */
function sse(chunks: Array<Record<string, unknown>>, cut = false): Response {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  // One chunk per read, so a cut lands after the chunks were consumed (an error in `start` would discard them).
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else if (cut) controller.error(new Error("socket hang up"));
      else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const textChunk = (text: string, finish: string | null = null) =>
  ({ id: "gen-42", model: "google/gemini-3.1-flash-lite", provider: "ProvA", choices: [{ delta: { content: text }, finish_reason: finish }] });

const receipt = (totalCostUsd: number) =>
  new Response(JSON.stringify({ data: { total_cost: totalCostUsd, native_tokens_prompt: 1_500, native_tokens_completion: 200, provider_name: "ProvA" } }),
    { headers: { "content-type": "application/json" } });

describe("streams without a usage chunk", () => {
  it("a stream that ends without usage is reconciled and recorded from the generation receipt", async () => {
    const ledger = new MemoryVisionAttemptBackend();
    stubFetch((url) => url.pathname.endsWith("/generation") ? receipt(0.3) : sse([textChunk("Total: "), textChunk("42", "stop")]));
    const outcome = await guardedRead(host(ledger, "run-a"), 1, true);
    expect(outcome.admitted).toBe(true);
    expect(sends).toContain("/api/v1/generation");
    const result = (outcome as { result: VisionExecutionResult }).result;
    expect(result).toMatchObject({ inputTokens: 1_500, outputTokens: 200, costCents: 30, usageSource: "provider" });
    expect(warnings.some((line) => line.startsWith("[vision-weight] overrun") && line.includes("reported=30.0000"))).toBe(true);
    expect(ledger.orgCents("org-1")).toBeCloseTo(30, 3);
  });

  it("a stream cut off before its usage chunk is reconciled from the receipt and its failure carries the charge", async () => {
    const ledger = new MemoryVisionAttemptBackend();
    stubFetch((url) => url.pathname.endsWith("/generation") ? receipt(0.3) : sse([textChunk("Total: ")], true));
    const error = await guardedRead(host(ledger, "run-a"), 1, true).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(findVisionBilledUsage(error)).toMatchObject({ inputTokens: 1_500, outputTokens: 200, costCents: 30, usageSource: "provider" });
    expect(ledger.orgCents("org-1")).toBeCloseTo(30, 3);
  });

  it("without a receipt the usage is recorded as an estimate, labelled", async () => {
    const ledger = new MemoryVisionAttemptBackend();
    stubFetch((url) => url.pathname.endsWith("/generation") ? new Response("not found", { status: 404 })
      : url.pathname.endsWith("/models") ? new Response("{}", { status: 503 })
      : sse([textChunk("Total: "), textChunk("42", "stop")]));
    const outcome = await guardedRead(host(ledger, "run-a"), 1, true);
    const result = (outcome as { result: VisionExecutionResult }).result;
    expect(result.usageSource).toBe("estimated");
    expect(result.costCents).toBeUndefined();
    expect(warnings.some((line) => line.includes("generation=gen-42 no usage and no receipt; recording estimated usage"))).toBe(true);
  });
});
