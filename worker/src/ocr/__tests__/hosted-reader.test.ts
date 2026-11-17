import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { priceVisionResult } from "../../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, visionGuardFor, withVisionCall, type VisionRequestGate } from "../../lib/vision-attempt-guard.js";
import { attachVisionBilledUsage, findVisionBilledUsage } from "../../tools/vision-stream.js";
import type { ProjectRun } from "../../models.js";
import { WorkflowState } from "../../pipeline/pipeline.js";
import { pngHeader } from "../../test/fake-ocr.js";
import type { CommandRunner } from "../../tools/runner.js";
import type { executeVisionRuntime, VisionExecutionResult } from "../../tools/vision-runtime.js";
import type { OcrPageRead, OcrReadOutcome } from "../engine.js";
import { escalateOcrPages } from "../escalation.js";
import { ocrEscalationStageStats } from "../escalation-stats.js";
import { SpendCheckUnavailableError } from "../../db/spend-check.js";
import { createHostedOcrReader, DEFAULT_OCR_ESCALATION_MODEL, HOSTED_OCR_MAX_BYTES, HostedOcrSkipped, ocrEscalationModel } from "../hosted-reader.js";
import { DISTINCT_TEST_PRICING, installTestPricing, isAutomaticSelectionDenied, OCR_ESCALATION_GLM_MODEL, OCR_ESCALATION_QWEN_MODEL, OCR_ESCALATION_ROUTES, resetPricingProviderForTests, TEST_PAGE_CREDITS } from "@docslurp/shared";
import { ProviderRoutingExclusionError } from "../../lib/provider-retry.js";
import { ocrDocument } from "../read-document.js";

const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const ROUTE = { runtime: "openai-compatible", baseUrl: "https://api.deepinfra.com/v1/openai", provider: "deepinfra", model: MODEL, billing: "deepinfra" } as const;

function runState(pipeline: Record<string, unknown> = {}, run: Record<string, unknown> = {}): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", projectId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "extract-markdown", spentCents: 0,
    pipeline: { vision: { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", maxPagesPerDocument: 1_000 }, privacyMode: "standard", visionFallback: true, ...pipeline },
    ...run,
  } as unknown as ProjectRun, []);
  state.visionAttempts = new MemoryVisionAttemptBackend();
  state.usageLedger.runId = "run-1";
  // A funded organization: escalation reads check the balance first and skip without a store to check with.
  (state as unknown as { store: unknown }).store = { largestFundedCharge: async (_run: unknown, max: number) => max };
  return state;
}

type ExecuteArgs = Parameters<typeof executeVisionRuntime>[0];

function stubExecute(read: (args: ExecuteArgs) => string | Error = () => "Hosted transcription") {
  return vi.fn(async (args: ExecuteArgs): Promise<VisionExecutionResult> => {
    await (args.gate as VisionRequestGate | null | undefined)?.admit();
    const text = read(args);
    // As the runtime does: a routing refusal (nothing billed) is handed back to the guard before it is thrown.
    if (text instanceof ProviderRoutingExclusionError && !findVisionBilledUsage(text)) await (args.gate as VisionRequestGate | null | undefined)?.unbilled("routing", { provider: "openrouter", status: text.status });
    if (text instanceof Error) throw text;
    return {
      runtime: "openai-compatible", provider: "deepinfra", model: MODEL, prompt: "p", text, raw: "", latencyMs: 5,
      inputTokens: 1_234, outputTokens: 321, usageSource: "provider", costCents: 0.42, baseUrl: ROUTE.baseUrl,
      fallbackUsed: false, route: { ...ROUTE },
    } as unknown as VisionExecutionResult;
  });
}

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-hosted-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

/** An outcome as the engine returns it, with a boundary PNG for each page that qualifies. */
async function outcomeWith(pages: Array<{ pageNumber: number; text: string; escalate: boolean }>): Promise<OcrReadOutcome> {
  const reads: OcrPageRead[] = [];
  for (const page of pages) {
    let escalation: OcrPageRead["escalation"] = null;
    if (page.escalate) {
      const imagePath = path.join(scratch, `frame-${String(page.pageNumber).padStart(4, "0")}.png`);
      await writeFile(imagePath, pngHeader(100, 50));
      escalation = { reason: "low-confidence", imagePath, width: 100, height: 50 };
    }
    reads.push({ pageNumber: page.pageNumber, text: page.text, meanConfidence: 0.5, recogniser: "multi", chars: page.text.length, elapsedMs: 1, escalation });
  }
  return {
    mode: "vm", engine: "test-vm-ocr", language: { recognisers: ["multi"], unsupportedScript: false, setting: "auto" },
    pages: reads, truncatedFrames: false, unreadPages: [], wallMs: 1, cpuMs: 1, peakRssKb: 1, dispose: async () => undefined,
  };
}

const ON = { DOCSLURP_OCR_ESCALATION: "on" } as NodeJS.ProcessEnv;

describe("OCR escalation reads", () => {
  it("replaces the recogniser's text and records the provider's actual tokens and priced cost", async () => {
    const state = runState();
    const execute = stubExecute();
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "b1urry", escalate: true }, { pageNumber: 2, text: "crisp", escalate: false }]);
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary).toEqual({ attempted: 1, replaced: 1, skipped: {}, failed: 0, capped: 0 });
    expect(outcome.pages[0]).toMatchObject({ text: "Hosted transcription", recogniser: `escalated:${MODEL}` });
    expect(outcome.pages[1]!.text).toBe("crisp");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ imagePath: outcome.pages[0]!.escalation!.imagePath, mimeType: "image/png", outputSchema: null });
    expect(execute.mock.calls[0]![0].vision.modelUri).toBe(DEFAULT_OCR_ESCALATION_MODEL);
    const events = state.usageLedger.snapshot().filter((event) => event.metric === "ocr-escalation");
    expect(events).toHaveLength(1);
    const expectedCost = priceVisionResult({ route: { ...ROUTE }, inputTokens: 1_234, outputTokens: 321, costCents: 0.42 } as never, CFG);
    expect(expectedCost).toBeGreaterThan(0);
    // Provider spend rides in metadata (the customer is charged the Rich page, not the provider's cost): escalation upgrades the page to Rich.
    expect(events[0]).toMatchObject({ provider: "deepinfra", model: MODEL, inputTokens: 1_234, outputTokens: 321, costCents: 0 });
    expect(events[0]!.metadata).toMatchObject({ documentId: "doc-1", pageNumber: 1, purpose: "ocr-escalation", outcome: "completed", providerCostCents: expectedCost, costRole: "provider" });
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id)).toEqual(["rich:run-1:doc-1:1"]);
  });

  it("stops at the per-document budget and keeps the recogniser's text on the rest", async () => {
    const state = runState();
    const execute = stubExecute();
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: { ...ON, DOCSLURP_OCR_ESCALATION_MAX_PAGES: "2" }, execute });
    const outcome = await outcomeWith([1, 2, 3].map((pageNumber) => ({ pageNumber, text: `ocr ${pageNumber}`, escalate: true })));
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary).toMatchObject({ attempted: 3, replaced: 2, skipped: { budget: 1 }, capped: 1 });
    // The document's record for the ingest report: two pages read a second time, one left on its first OCR read by the cap.
    expect(ocrEscalationStageStats(state.artifactLedger, "doc-1")).toMatchObject({ escalatedPages: 2, cappedPages: 1, capped: [3] });
    // The third read is refused at its first request's admission: nothing was sent and nothing is recorded for it.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ocr-escalation")).toHaveLength(2);
    expect(outcome.pages.map((page) => page.text)).toEqual(["Hosted transcription", "Hosted transcription", "ocr 3"]);
    // The budget is per document: another document of the run still gets its reads, and a re-read of a page already read is free.
    await expect(reader.read({ documentId: "doc-2", pageNumber: 1, imagePath: outcome.pages[0]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).resolves.toMatchObject({ text: "Hosted transcription" });
    await expect(reader.read({ documentId: "doc-1", pageNumber: 2, imagePath: outcome.pages[1]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).resolves.toBeDefined();
    await expect(reader.read({ documentId: "doc-1", pageNumber: 3, imagePath: outcome.pages[2]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).rejects.toMatchObject({ reason: "budget" });
  });

  it("checks the balance for the OCR-to-Rich upgrade before each escalation read: an org funded for OCR only never overdraws, and the run is not paused", async () => {
    const state = runState();
    const execute = stubExecute();
    const checks: number[] = [];
    // Enough for the pages' OCR charges, not for an upgrade to Rich. Read-only: nothing here can pause the run.
    const balance = 2 * TEST_PAGE_CREDITS.ocr;
    const enforceSpendForCharge = vi.fn();
    (state as unknown as { store: unknown }).store = {
      enforceSpendForCharge,
      largestFundedCharge: async (_run: unknown, max: number, creditsFor: (n: number) => number) => { checks.push(creditsFor(1)); return creditsFor(1) > balance ? 0 : max; },
    };
    state.usageLedger.chargeOcrPage({ documentId: "doc-1", pageNumber: 1, readBy: "page-ocr" });
    state.usageLedger.chargeOcrPage({ documentId: "doc-1", pageNumber: 2, readBy: "page-ocr" });
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([1, 2].map((pageNumber) => ({ pageNumber, text: `ocr ${pageNumber}`, escalate: true })));
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary).toMatchObject({ attempted: 1, replaced: 0, skipped: { unfunded: 1 }, capped: 0 });
    // The check covered the upgrade plus the OCR charges still buffered; no provider call, no Rich charge, OCR text kept.
    expect(checks).toHaveLength(1);
    expect(checks[0]).toBeCloseTo(TEST_PAGE_CREDITS.rich - TEST_PAGE_CREDITS.ocr + 2 * TEST_PAGE_CREDITS.ocr);
    expect(execute).not.toHaveBeenCalled();
    expect(enforceSpendForCharge).not.toHaveBeenCalled();
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toEqual([]);
    expect(outcome.pages.map((page) => page.text)).toEqual(["ocr 1", "ocr 2"]);
    // Both pages are recorded as skipped for funds, for the ingest report.
    expect(ocrEscalationStageStats(state.artifactLedger, "doc-1")).toMatchObject({ escalatedPages: 0, skippedPages: { unfunded: 2 } });
    // Fail closed: no store to check with, or no organization, skips the read too.
    for (const strip of [(s: WorkflowState) => { (s as unknown as { store: unknown }).store = undefined; }, (s: WorkflowState) => { s.run.orgId = null as never; }]) {
      const bare = runState();
      strip(bare);
      const bareExecute = stubExecute();
      const bareOutcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]);
      expect(await escalateOcrPages(bareOutcome, createHostedOcrReader({ state: bare, cfg: CFG, runner: {} as CommandRunner, env: ON, execute: bareExecute }), "doc-1")).toMatchObject({ skipped: { unfunded: 1 } });
      expect(bareExecute).not.toHaveBeenCalled();
    }
    // A check that cannot decide is retried: the error propagates.
    const broken = runState();
    (broken as unknown as { store: unknown }).store = { largestFundedCharge: async () => { throw new SpendCheckUnavailableError("balance read failed"); } };
    await expect(escalateOcrPages(await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]), createHostedOcrReader({ state: broken, cfg: CFG, runner: {} as CommandRunner, env: ON, execute: stubExecute() }), "doc-1")).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    // Funded: the read goes ahead.
    const funded = runState();
    const fundedExecute = stubExecute();
    const fundedOutcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]);
    expect(await escalateOcrPages(fundedOutcome, createHostedOcrReader({ state: funded, cfg: CFG, runner: {} as CommandRunner, env: ON, execute: fundedExecute }), "doc-1")).toMatchObject({ replaced: 1 });
    expect(fundedExecute).toHaveBeenCalledTimes(1);
  });

  it("reads with GLM under its price ceiling on Wafer, then on Morph, then with Qwen when no host can serve GLM under either", async () => {
    const state = runState();
    const execute = stubExecute((args) => args.vision.modelUri === OCR_ESCALATION_GLM_MODEL
      ? new ProviderRoutingExclusionError(404, "No endpoints found matching your data policy and max_price")
      : "Qwen transcription");
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]);
    expect(await escalateOcrPages(outcome, reader, "doc-1")).toMatchObject({ replaced: 1, failed: 0 });
    expect(execute.mock.calls.map((call) => call[0].vision.modelUri)).toEqual([OCR_ESCALATION_GLM_MODEL, OCR_ESCALATION_GLM_MODEL, OCR_ESCALATION_QWEN_MODEL]);
    // Each GLM request carries its own ceiling and host; Qwen's carries none.
    for (const index of [0, 1]) {
      const ceiling = OCR_ESCALATION_ROUTES[index]!.priceCeiling!;
      expect(execute.mock.calls[index]![0].priceCeiling).toEqual({ inputUsdPerMillion: ceiling.inputUsdPerMTok, outputUsdPerMillion: ceiling.outputUsdPerMTok, imageUsd: 0, hosts: ceiling.hosts });
    }
    expect(execute.mock.calls[0]![0].priceCeiling!.hosts).toEqual(["wafer/us"]);
    expect(execute.mock.calls[1]![0].priceCeiling!.hosts).toEqual(["morph/fp8"]);
    expect(execute.mock.calls[2]![0].priceCeiling).toBeUndefined();
    expect(outcome.pages[0]!.text).toBe("Qwen transcription");
  });

  it("skips the read, never sending it to a pricier host, when no reader can be served under its ceiling", async () => {
    const state = runState();
    const execute = stubExecute(() => new ProviderRoutingExclusionError(503, "There is no available model provider that meets your routing requirements"));
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([1, 2].map((pageNumber) => ({ pageNumber, text: `ocr ${pageNumber}`, escalate: true })));
    expect(await escalateOcrPages(outcome, reader, "doc-1")).toMatchObject({ replaced: 0, failed: 0, skipped: { margin: 1 } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toEqual([]);
    expect(ocrEscalationStageStats(state.artifactLedger, "doc-1")).toMatchObject({ skippedPages: { "price-check": 2 } });
  });

  it("hands GLM's routing refusals back unbilled: 30 refused pages leave the breaker closed and the attempt budget whole", async () => {
    const state = runState();
    const env = { ...ON, DOCSLURP_OCR_ESCALATION_MAX_PAGES: "40" } as NodeJS.ProcessEnv;
    // As the runtime does: each request is admitted, a routing refusal is handed back unbilled, a Qwen read succeeds.
    const execute = vi.fn(async (args: ExecuteArgs): Promise<VisionExecutionResult> => {
      const gate = args.gate as VisionRequestGate;
      await gate.admit();
      if (args.vision.modelUri === OCR_ESCALATION_GLM_MODEL) {
        await gate.unbilled("routing", { provider: "openrouter", status: 404 });
        throw new ProviderRoutingExclusionError(404, "No endpoints found matching your data policy and max_price");
      }
      return { runtime: "openai-compatible", provider: "deepinfra", model: MODEL, prompt: "p", text: "Qwen read", raw: "", latencyMs: 5,
        inputTokens: 10, outputTokens: 10, usageSource: "provider", costCents: 0.01, baseUrl: ROUTE.baseUrl, fallbackUsed: false, route: { ...ROUTE } } as unknown as VisionExecutionResult;
    });
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env, execute });
    const outcome = await outcomeWith(Array.from({ length: 30 }, (_, index) => ({ pageNumber: index + 1, text: `ocr ${index + 1}`, escalate: true })));
    expect(await escalateOcrPages(outcome, reader, "doc-1")).toMatchObject({ attempted: 30, replaced: 30, failed: 0, skipped: {} });
    // Two GLM hosts refuse each page, Qwen reads it: 90 requests, none counted against the breaker or the budget.
    expect(execute).toHaveBeenCalledTimes(90);
    // The run's other vision reads are unaffected: the breaker is closed and a new call is admitted.
    expect(visionGuardFor(state).stop).toBeNull();
    await expect(withVisionCall(state, { documentId: "doc-2", pageNumber: 1, purpose: "page" }, async (gate) => { await gate.admit(); })).resolves.toBeUndefined();
  });

  it("a read that times out after it was sent is possibly billed: no fall-through to Qwen, recorded as unknown-billed", async () => {
    const state = runState();
    const execute = vi.fn(async (args: ExecuteArgs): Promise<VisionExecutionResult> => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      // Wafer refuses (routing, unbilled); Morph is sent and never answers within its timeout.
      if ((args as { priceCeiling?: { hosts: string[] } }).priceCeiling?.hosts.includes("wafer/us")) {
        await (args.gate as VisionRequestGate | null | undefined)?.unbilled("routing", { provider: "openrouter", status: 404 });
        throw new ProviderRoutingExclusionError(404, "No endpoints found matching your data policy and max_price");
      }
      if (args.vision.modelUri !== OCR_ESCALATION_GLM_MODEL) throw new Error("Qwen must not be called");
      await new Promise((_resolve, reject) => args.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      throw new Error("unreachable");
    });
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute, routeTimeoutMs: (route) => (route.timeoutMs ? 20 : undefined) });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]);
    expect(await escalateOcrPages(outcome, reader, "doc-1")).toMatchObject({ replaced: 0, skipped: { "unknown-billed": 1 } });
    expect(execute.mock.calls.map((call) => (call[0] as { priceCeiling?: { hosts: string[] } }).priceCeiling?.hosts)).toEqual([["wafer/us"], ["morph/fp8"]]);
    expect(outcome.pages[0]!.text).toBe("ocr 1");
  });

  it("does not fall back to Qwen after a GLM attempt of the page was billed: the read fails like any rejected read", async () => {
    const state = runState();
    const execute = stubExecute((args) => {
      if (args.vision.modelUri !== OCR_ESCALATION_GLM_MODEL) return "Qwen read";
      // Attempt 1 served and rejected (billed), the retry refused for routing.
      const error = new ProviderRoutingExclusionError(503, "There is no available model provider that meets your routing requirements");
      attachVisionBilledUsage(error, { inputTokens: 2_000, outputTokens: 8_000, costMetadata: {}, costCents: 0.3, usageSource: "provider" } as never);
      return error;
    });
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    expect(await escalateOcrPages(await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]), reader, "doc-1")).toMatchObject({ replaced: 0, failed: 1 });
    expect(execute.mock.calls.map((call) => call[0].vision.modelUri)).toEqual([OCR_ESCALATION_GLM_MODEL]);
    // The billed GLM attempt is recorded under the GLM reader's own id.
    const failedIds = state.usageLedger.snapshot().map((event) => event.id ?? "").filter((id) => id.includes(":failed:"));
    expect(failedIds.length).toBeGreaterThan(0);
    expect(failedIds.every((id) => id.includes(":scan-ocr/hosted-escalation-glm:failed:"))).toBe(true);
  });

  it("gates each reader on its own: a refused GLM falls back to Qwen, both refused skip the read", async () => {
    const state = runState();
    installTestPricing({ automaticCallValueUsd: (call) => (call.model.includes("glm") ? 0 : 1) });
    try {
      const execute = stubExecute();
      const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
      expect(await escalateOcrPages(await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]), reader, "doc-1")).toMatchObject({ replaced: 1 });
      expect(execute.mock.calls.map((call) => call[0].vision.modelUri)).toEqual([OCR_ESCALATION_QWEN_MODEL]);
      installTestPricing({ automaticCallValueUsd: () => 0 });
      const none = stubExecute();
      const refused = createHostedOcrReader({ state: runState(), cfg: CFG, runner: {} as CommandRunner, env: ON, execute: none });
      expect(await escalateOcrPages(await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]), refused, "doc-1")).toMatchObject({ skipped: { margin: 1 } });
      expect(none).not.toHaveBeenCalled();
    } finally {
      installTestPricing(DISTINCT_TEST_PRICING);
    }
  });

  it("keeps the per-document budget across an activity retry or a worker restart (a new state on the same attempt ledger)", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const env = { ...ON, DOCSLURP_OCR_ESCALATION_MAX_PAGES: "2" };
    const first = runState();
    first.visionAttempts = backend;
    const outcome = await outcomeWith([1, 2, 3].map((pageNumber) => ({ pageNumber, text: `ocr ${pageNumber}`, escalate: true })));
    const firstReader = createHostedOcrReader({ state: first, cfg: CFG, runner: {} as CommandRunner, env, execute: stubExecute() });
    for (const pageNumber of [1, 2]) await firstReader.read({ documentId: "doc-1", pageNumber, imagePath: outcome.pages[pageNumber - 1]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation");
    // The retried activity rebuilds its state; the in-process state is gone, the durable ledger is not.
    const retry = runState();
    retry.visionAttempts = backend;
    const retryReader = createHostedOcrReader({ state: retry, cfg: CFG, runner: {} as CommandRunner, env, execute: stubExecute() });
    await expect(retryReader.read({ documentId: "doc-1", pageNumber: 3, imagePath: outcome.pages[2]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).rejects.toMatchObject({ reason: "budget" });
    await expect(retryReader.read({ documentId: "doc-1", pageNumber: 1, imagePath: outcome.pages[0]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).resolves.toBeDefined();
  });

  it("skips for the run cost cap without calling the provider", async () => {
    const state = runState({ maxCostCents: 1 }, { spentCents: 5 });
    const execute = stubExecute();
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr", escalate: true }, { pageNumber: 2, text: "ocr 2", escalate: true }]);
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary).toMatchObject({ attempted: 1, replaced: 0, skipped: { "cost-cap": 1 } });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.pages.map((page) => page.text)).toEqual(["ocr", "ocr 2"]);
  });

  it("skips when privacy mode refuses the hosted route, without calling the provider", async () => {
    const state = runState({ privacyMode: "strict-privacy" });
    const execute = stubExecute();
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr", escalate: true }]);
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary.skipped).toEqual({ privacy: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.pages[0]!.text).toBe("ocr");
    expect(state.usageLedger.snapshot()).toEqual([]);
  });

  it("makes no call with DOCSLURP_OCR_ESCALATION=off, and is off by default without a DeepInfra key", async () => {
    for (const env of [{ DOCSLURP_OCR_ESCALATION: "off", DEEPINFRA_API_KEY: "k" }, {}] as NodeJS.ProcessEnv[]) {
      const execute = stubExecute();
      const reader = createHostedOcrReader({ state: runState(), cfg: CFG, runner: {} as CommandRunner, env, execute });
      const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr", escalate: true }]);
      expect((await escalateOcrPages(outcome, reader, "doc-1")).skipped).toEqual({ disabled: 1 });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("keeps the OCR text when the hosted read fails", async () => {
    const state = runState();
    const execute = stubExecute(() => new Error("provider 500"));
    const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }, { pageNumber: 2, text: "ocr 2", escalate: true }]);
    const summary = await escalateOcrPages(outcome, reader, "doc-1");
    expect(summary).toMatchObject({ attempted: 2, replaced: 0, failed: 2 });
    expect(outcome.pages.map((page) => page.text)).toEqual(["ocr 1", "ocr 2"]);
  });

  it("keeps the OCR text when the hosted read is empty", async () => {
    const reader = createHostedOcrReader({ state: runState(), cfg: CFG, runner: {} as CommandRunner, env: ON, execute: stubExecute(() => "   ") });
    const outcome = await outcomeWith([{ pageNumber: 1, text: "ocr 1", escalate: true }]);
    expect(await escalateOcrPages(outcome, reader, "doc-1")).toMatchObject({ attempted: 1, replaced: 0 });
    expect(outcome.pages[0]!.text).toBe("ocr 1");
  });

  it("refuses an image type that would need host decoding", async () => {
    const execute = stubExecute();
    const reader = createHostedOcrReader({ state: runState(), cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
    await expect(reader.read({ documentId: "doc-1", pageNumber: 1, imagePath: path.join(scratch, "x.tiff"), mimeType: "image/tiff" }, "ocr-escalation")).rejects.toThrow(/would need host decoding/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("DOCSLURP_OCR_MODE=hosted", () => {
  const HOSTED = { DOCSLURP_OCR_MODE: "hosted", DOCSLURP_OCR_ESCALATION: "off" } as NodeJS.ProcessEnv;
  const runner = {
    run: vi.fn(async () => { throw new Error("hosted mode runs nothing on the host"); }),
    sandboxedOcrRead: vi.fn(async () => { throw new Error("no VM in hosted mode"); }),
    localOcrRead: vi.fn(async () => { throw new Error("no local OCR in hosted mode"); }),
  };

  it("reads a stored PNG as is: the provider gets the exact stored path, no conversion", async () => {
    const source = path.join(scratch, "stored-upload.png");
    await writeFile(source, pngHeader(640, 480));
    const state = runState();
    const execute = stubExecute();
    const hostedReader = createHostedOcrReader({ state, cfg: CFG, runner: runner as unknown as CommandRunner, env: HOSTED, execute });
    const result = await ocrDocument({ runner, state, documentId: "doc-1", source, kind: "image", mimeType: "image/png", hostedReader, stage: "extract-markdown", env: HOSTED });
    expect(result).toMatchObject({ mode: "hosted", chargedPages: [1], pages: [{ pageNumber: 1, text: "Hosted transcription", reader: `hosted:${MODEL}` }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ imagePath: source, mimeType: "image/png" });
    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.sandboxedOcrRead).not.toHaveBeenCalled();
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "hosted-ocr")).toHaveLength(1);
    // The operator's hosted OCR model reads in the OCR engine's place: one flat OCR page, not Rich.
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-ocr").map((event) => event.id)).toEqual(["ocr:run-1:doc-1:1"]);
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toEqual([]);
  });

  it.each([
    ["image", "image/tiff"],
    ["image", "image/gif"],
    ["image", null],
    ["pdf", "application/pdf"],
    ["pdf", "image/png"],
  ] as const)("refuses kind=%s mime=%s without calling the provider", async (kind, mimeType) => {
    const source = path.join(scratch, "stored");
    await writeFile(source, "bytes");
    const state = runState();
    const execute = stubExecute();
    const hostedReader = createHostedOcrReader({ state, cfg: CFG, runner: runner as unknown as CommandRunner, env: HOSTED, execute });
    await expect(ocrDocument({ runner, state, documentId: "doc-1", source, kind, mimeType, hostedReader, stage: "extract-markdown", env: HOSTED }))
      .rejects.toMatchObject({ name: "OcrRefusedError", reason: "hosted-format" });
    expect(execute).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(state.usageLedger.snapshot()).toEqual([]);
  });

  it("refuses an image over the size bound, and a hosted read refused by privacy fails the page", async () => {
    const big = path.join(scratch, "big.png");
    await writeFile(big, pngHeader(10, 10));
    await truncate(big, HOSTED_OCR_MAX_BYTES + 1);
    const execute = stubExecute();
    const state = runState();
    const hostedReader = createHostedOcrReader({ state, cfg: CFG, runner: runner as unknown as CommandRunner, env: HOSTED, execute });
    await expect(ocrDocument({ runner, state, documentId: "doc-1", source: big, kind: "image", mimeType: "image/png", hostedReader, stage: "s", env: HOSTED })).rejects.toMatchObject({ reason: "hosted-size" });
    const small = path.join(scratch, "small.png");
    await writeFile(small, pngHeader(10, 10));
    const strict = runState({ privacyMode: "strict-privacy" });
    const strictReader = createHostedOcrReader({ state: strict, cfg: CFG, runner: runner as unknown as CommandRunner, env: HOSTED, execute });
    await expect(ocrDocument({ runner, state: strict, documentId: "doc-1", source: small, kind: "image", mimeType: "image/png", hostedReader: strictReader, stage: "s", env: HOSTED })).rejects.toMatchObject({ reason: "hosted-privacy" });
    await expect(ocrDocument({ runner, state, documentId: "doc-1", source: small, kind: "image", mimeType: "image/png", hostedReader: null, stage: "s", env: HOSTED })).rejects.toMatchObject({ reason: "hosted-unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("is not gated by the escalation switch (it is the reader, not a second opinion)", async () => {
    const source = path.join(scratch, "stored.webp");
    await writeFile(source, "webp bytes");
    const execute = stubExecute();
    const state = runState();
    const hostedReader = createHostedOcrReader({ state, cfg: CFG, runner: runner as unknown as CommandRunner, env: HOSTED, execute });
    await expect(hostedReader.read({ documentId: "doc-1", pageNumber: 1, imagePath: source, mimeType: "image/webp" }, "hosted-ocr")).resolves.toMatchObject({ text: "Hosted transcription" });
    await expect(hostedReader.read({ documentId: "doc-1", pageNumber: 2, imagePath: source, mimeType: "image/webp" }, "ocr-escalation")).rejects.toBeInstanceOf(HostedOcrSkipped);
  });
});

describe("OCR escalation model override", () => {
  it("takes any non-denylisted override, DeepSeek V4.1 Flash included: its reads pass the margin gate instead", () => {
    expect(isAutomaticSelectionDenied(DEFAULT_OCR_ESCALATION_MODEL)).toBe(false);
    for (const model of ["llm://openrouter/deepseek/deepseek-v4.1-flash-1017", "llm://openrouter/openai/gpt-6-luna"]) {
      expect(ocrEscalationModel({ DOCSLURP_OCR_ESCALATION_MODEL: model })).toBe(model);
    }
  });

  it("skips an escalation read the margin gate refuses, before anything is sent, and keeps the recogniser's text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A billed value the escalation route's list price cannot cover by the minimum margin.
    installTestPricing({ automaticCallValueUsd: () => 0.000001 });
    try {
      const state = runState();
      const execute = stubExecute();
      const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: ON, execute });
      const outcome = await outcomeWith([{ pageNumber: 1, text: "b1urry", escalate: true }]);
      const summary = await escalateOcrPages(outcome, reader, "doc-1");
      expect(summary).toMatchObject({ attempted: 1, replaced: 0, skipped: { margin: 1 } });
      expect(execute).not.toHaveBeenCalled();
      expect(outcome.pages[0]!.text).toBe("b1urry");
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[automatic-margin\] skipped label=ocr-escalation .*reason="below the minimum margin"/));
      // A value that covers it: the read goes ahead.
      installTestPricing({ automaticCallValueUsd: () => 1 });
      const allowed = await outcomeWith([{ pageNumber: 1, text: "b1urry", escalate: true }]);
      await escalateOcrPages(allowed, createHostedOcrReader({ state: runState(), cfg: CFG, runner: {} as CommandRunner, env: ON, execute }), "doc-1");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      resetPricingProviderForTests();
      warn.mockRestore();
    }
  });
});
