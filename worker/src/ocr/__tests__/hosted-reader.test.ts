import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { priceVisionResult } from "../../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend, type VisionRequestGate } from "../../lib/vision-attempt-guard.js";
import type { WorkspaceRun } from "../../models.js";
import { WorkflowState } from "../../pipeline/pipeline.js";
import { pngHeader } from "../../test/fake-ocr.js";
import type { CommandRunner } from "../../tools/runner.js";
import type { executeVisionRuntime, VisionExecutionResult } from "../../tools/vision-runtime.js";
import type { OcrPageRead, OcrReadOutcome } from "../engine.js";
import { escalateOcrPages } from "../escalation.js";
import { createHostedOcrReader, DEFAULT_OCR_ESCALATION_MODEL, HOSTED_OCR_MAX_BYTES, HostedOcrSkipped } from "../hosted-reader.js";
import { ocrDocument } from "../read-document.js";

const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const ROUTE = { runtime: "openai-compatible", baseUrl: "https://api.deepinfra.com/v1/openai", provider: "deepinfra", model: MODEL, billing: "deepinfra" } as const;

function runState(pipeline: Record<string, unknown> = {}, run: Record<string, unknown> = {}): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "extract-markdown", spentCents: 0,
    pipeline: { vision: { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", maxPagesPerDocument: 1_000 }, privacyMode: "standard", visionFallback: true, ...pipeline },
    ...run,
  } as unknown as WorkspaceRun, []);
  state.visionAttempts = new MemoryVisionAttemptBackend();
  state.usageLedger.runId = "run-1";
  return state;
}

type ExecuteArgs = Parameters<typeof executeVisionRuntime>[0];

function stubExecute(read: (args: ExecuteArgs) => string | Error = () => "Hosted transcription") {
  return vi.fn(async (args: ExecuteArgs): Promise<VisionExecutionResult> => {
    await (args.gate as VisionRequestGate | null | undefined)?.admit();
    const text = read(args);
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
    expect(summary).toEqual({ attempted: 1, replaced: 1, skipped: {}, failed: 0 });
    expect(outcome.pages[0]).toMatchObject({ text: "Hosted transcription", recogniser: `escalated:${MODEL}` });
    expect(outcome.pages[1]!.text).toBe("crisp");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ imagePath: outcome.pages[0]!.escalation!.imagePath, mimeType: "image/png", outputSchema: null });
    expect(execute.mock.calls[0]![0].vision.modelUri).toBe(DEFAULT_OCR_ESCALATION_MODEL);
    const events = state.usageLedger.snapshot().filter((event) => event.metric === "ocr-escalation");
    expect(events).toHaveLength(1);
    const expectedCost = priceVisionResult({ route: { ...ROUTE }, inputTokens: 1_234, outputTokens: 321, costCents: 0.42 } as never, CFG);
    expect(expectedCost).toBeGreaterThan(0);
    // Provider spend rides in metadata (the customer is charged the Rich page, not the provider's cost).
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
    expect(summary).toMatchObject({ attempted: 3, replaced: 2, skipped: { budget: 1 } });
    // The third read is refused at its first request's admission: nothing was sent and nothing is recorded for it.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ocr-escalation")).toHaveLength(2);
    expect(outcome.pages.map((page) => page.text)).toEqual(["Hosted transcription", "Hosted transcription", "ocr 3"]);
    // The budget is per document: another document of the run still gets its reads, and a re-read of a page already read is free.
    await expect(reader.read({ documentId: "doc-2", pageNumber: 1, imagePath: outcome.pages[0]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).resolves.toMatchObject({ text: "Hosted transcription" });
    await expect(reader.read({ documentId: "doc-1", pageNumber: 2, imagePath: outcome.pages[1]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).resolves.toBeDefined();
    await expect(reader.read({ documentId: "doc-1", pageNumber: 3, imagePath: outcome.pages[2]!.escalation!.imagePath, mimeType: "image/png" }, "ocr-escalation")).rejects.toMatchObject({ reason: "budget" });
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
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id)).toEqual(["rich:run-1:doc-1:1"]);
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
