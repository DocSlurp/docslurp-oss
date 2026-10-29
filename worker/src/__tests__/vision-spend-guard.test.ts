import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const visionRuntime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../tools/vision-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/vision-runtime.js")>();
  return { ...actual, executeVisionRuntime: visionRuntime.execute };
});

import { buildAdaptiveRoutingDecisionSurface, DRAWN_CONTENT_MIN_BYTES_PER_PAGE } from "../stages/classify-route.js";
import {
  legacyPageHints,
  shouldFailOpenVisionError,
  VisionExtractStage,
  VisionGuardStopError,
  type LegacyPageHints,
  type VisionPageSkip,
} from "../stages/vision-extract.js";
import { attachVisionBilledUsage, VisionOutputRejectedError } from "../tools/vision-stream.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { buildVisionPageFacts } from "../pipeline/page-facts.js";
import { drawnBytesPerPage, renderLooksBlank, totalEmbeddedImageBytes, type PageImageEvidence } from "../lib/page-image-evidence.js";
import {
  MemoryVisionSpendBackend,
  resetVisionGuardWarningsForTest,
  resolveVisionGuardConfig,
  visionInputTokenBound,
  VisionRunGuard,
  type VisionGuardConfig,
} from "../lib/vision-spend-guard.js";
import { visionReserveCents } from "../lib/vision-reserve.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { PdfRasterCache, type PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { CommandRunner } from "../tools/runner.js";
import type { UsageEvent, WorkspaceRun } from "../models.js";
import type { Config } from "../config.js";
import type { Document } from "../models.js";

const MODEL = "google/gemini-3.1-flash-lite";
const VISION = { target: "remote", modelUri: `llm://openrouter/${MODEL}`, maxPagesPerDocument: 1_000 } as const;
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;

/** A run state with its own vision ledger (never the process-wide one other tests share). */
function runState(pipeline: Record<string, unknown> = {}, backend = new MemoryVisionSpendBackend()): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "vision-extract",
    pipeline: { vision: VISION, privacyMode: "standard", visionFallback: true, ...pipeline },
  } as unknown as WorkspaceRun, []);
  state.visionSpend = backend;
  return state;
}

function ledgerOf(state: WorkflowState): MemoryVisionSpendBackend {
  return state.visionSpend as MemoryVisionSpendBackend;
}

describe("vision guard config", () => {
  beforeEach(() => resetVisionGuardWarningsForTest());

  it("defaults, the run cost cap and malformed values", () => {
    expect(resolveVisionGuardConfig({ pipeline: {} }, {})).toEqual({
      budgetCents: 2_500, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2, orgUnbilledLimitCents: 5_000, orgWindowHours: 24,
    });
    expect(resolveVisionGuardConfig({ pipeline: {} }, { VISION_ORG_UNBILLED_LIMIT_CENTS: "800", VISION_ORG_UNBILLED_WINDOW_HOURS: "6" }))
      .toMatchObject({ orgUnbilledLimitCents: 800, orgWindowHours: 6 });
    expect(resolveVisionGuardConfig({ pipeline: { maxCostCents: 300 } }, {}).budgetCents).toBe(300);
    expect(resolveVisionGuardConfig({ pipeline: { maxCostCents: 9_000 } }, { VISION_RUN_PROVIDER_BUDGET_CENTS: "4000" }).budgetCents)
      .toBe(4_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A typo never turns the guard off.
    expect(resolveVisionGuardConfig({ pipeline: {} }, {
      VISION_RUN_PROVIDER_BUDGET_CENTS: "off", VISION_REJECTION_BREAKER_MIN_PAGES: "0", VISION_REJECTION_BREAKER_RATE: "2",
      VISION_ORG_UNBILLED_LIMIT_CENTS: "0", VISION_ORG_UNBILLED_WINDOW_HOURS: "1000",
    })).toEqual({ budgetCents: 2_500, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2, orgUnbilledLimitCents: 5_000, orgWindowHours: 24 });
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });
});

describe("VisionRunGuard", () => {
  const config: VisionGuardConfig = {
    budgetCents: 100, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2, orgUnbilledLimitCents: 1_000, orgWindowHours: 24,
  };
  const run = (id = "run-1", orgId: string | null = "org-1") => ({ id, orgId });
  const page = (pageNumber: number, rejected = false) => ({ documentId: "doc", pageNumber, rejected });

  async function spend(guard: VisionRunGuard, cents: number, settlement: { billable: boolean; page?: ReturnType<typeof page> }) {
    const admission = await guard.admit(cents);
    if (!admission.admitted) throw new Error(`expected admission, got ${admission.stop.reason}`);
    await admission.settle({ costCents: cents, ...settlement });
  }

  it("counts rejected (unbilled) attempts toward the provider budget", async () => {
    const backend = new MemoryVisionSpendBackend();
    const guard = new VisionRunGuard(run(), config, backend);
    for (let n = 1; n <= 5; n += 1) await spend(guard, 19, { billable: false, page: page(n, true) });
    // 95 cents of rejected attempts + a 10 cent reservation passes 100.
    expect(await guard.admit(10)).toMatchObject({ admitted: false, stop: { reason: "provider-budget", providerCostCents: 95 } });
    // Sticky: no later call is admitted, even a free one.
    expect((await guard.admit(0)).admitted).toBe(false);
  });

  it("holds each concurrent call's own reservation across guards of the run and settles to actual cost", async () => {
    const backend = new MemoryVisionSpendBackend();
    // Two activities of one run (a page task and a shard), calling different models at once.
    const pageTask = new VisionRunGuard(run(), config, backend);
    const shard = new VisionRunGuard(run(), config, backend);
    const [expensive, cheap] = await Promise.all([pageTask.admit(60), shard.admit(30)]);
    expect(expensive.admitted && cheap.admitted).toBe(true);
    // 60 + 30 reserved: a third call of 20 does not fit, whoever asks.
    expect(await new VisionRunGuard(run(), config, backend).admit(20))
      .toMatchObject({ admitted: false, stop: { reason: "provider-budget", reservedCents: 110 } });
    if (!expensive.admitted || !cheap.admitted) throw new Error("expected admissions");
    // The expensive call actually cost 10: 10 + 30 reserved + 20 fits.
    await expensive.settle({ costCents: 10, billable: true, page: page(1) });
    // Settling twice is ignored.
    await expensive.settle({ costCents: 500, billable: true, page: page(1) });
    expect((await shard.admit(20)).admitted).toBe(true);
    expect(backend.inspect("run-1")).toMatchObject({ costCents: 10, liveReservations: 2 });
  });

  it("trips the rejection breaker at the minimum count and rate", async () => {
    const tripped = async (rejected: number, read: number) => {
      const guard = new VisionRunGuard(run(), config, new MemoryVisionSpendBackend());
      for (let n = 1; n <= read; n += 1) await spend(guard, 0, { billable: true, page: page(1_000 + n) });
      for (let n = 1; n <= rejected; n += 1) await spend(guard, 0, { billable: false, page: page(n, true) });
      return guard.admit(0);
    };
    // 10 rejected of 100 attempted (10%): below the rate, keep going.
    expect((await tripped(10, 90)).admitted).toBe(true);
    // 9 of 9: above the rate but below the minimum count.
    expect((await tripped(9, 0)).admitted).toBe(true);
    // 10 of 10: stop.
    expect(await tripped(10, 0))
      .toMatchObject({ admitted: false, stop: { reason: "rejection-breaker", rejectedPages: 10, attemptedPages: 10 } });
  });

  it("many small runs of one org stop at the org's unbilled limit; another org is unaffected", async () => {
    const backend = new MemoryVisionSpendBackend();
    const stops: string[] = [];
    let runs = 0;
    // Each run rejects 5 pages at 40 cents (200 cents): under its own budget of 2,500 and its breaker.
    const perRun = { ...config, budgetCents: 2_500 };
    for (; runs < 20; runs += 1) {
      const guard = new VisionRunGuard(run(`small-${runs}`), perRun, backend);
      for (let n = 1; n <= 5; n += 1) {
        const admission = await guard.admit(40);
        if (!admission.admitted) {
          stops.push(admission.stop.reason);
          break;
        }
        await admission.settle({ costCents: 40, billable: false, page: page(n, true) });
      }
      if (stops.length > 0) break;
    }
    // 1,000 cents of unbilled spend: the sixth run is refused at its first call.
    expect(stops).toEqual(["org-unbilled-limit"]);
    expect(runs).toBe(5);
    const stopped = await new VisionRunGuard(run("small-next"), perRun, backend).admit(1);
    expect(stopped).toMatchObject({ admitted: false, stop: { reason: "org-unbilled-limit", orgUnbilledCents: 1_000, orgLimitCents: 1_000 } });
    // Another org, and billable (read) pages of the same org, are not unbilled spend.
    expect((await new VisionRunGuard(run("other", "org-2"), perRun, backend).admit(40)).admitted).toBe(true);
  });

  it("billable reads do not count toward the org's unbilled limit; the limit window rolls", async () => {
    let now = 0;
    const backend = new MemoryVisionSpendBackend(() => now);
    const perRun = { ...config, budgetCents: 100_000, orgUnbilledLimitCents: 100 };
    for (let r = 0; r < 5; r += 1) await spend(new VisionRunGuard(run(`read-${r}`), perRun, backend), 90, { billable: true, page: page(1) });
    await spend(new VisionRunGuard(run("rejects"), perRun, backend), 90, { billable: false, page: page(1, true) });
    expect((await new VisionRunGuard(run("late"), perRun, backend).admit(20)).admitted).toBe(false);
    now += 25 * 3_600_000;
    expect((await new VisionRunGuard(run("next-day"), perRun, backend).admit(20)).admitted).toBe(true);
  });

  it("reserves at each call's own model price over a bounded input", () => {
    const flash = { ...VISION } as never;
    const cheaper = { ...VISION, modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } as never;
    const small = visionReserveCents(flash, CFG, { widthPx: 1275, heightPx: 1650 });
    const large = visionReserveCents(flash, CFG, { widthPx: 4000, heightPx: 4000 });
    const unknown = visionReserveCents(flash, CFG, null);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    // An unknown size reserves for the largest raster.
    expect(unknown).toBeCloseTo(large, 6);
    expect(visionReserveCents(cheaper, CFG, { widthPx: 1275, heightPx: 1650 })).toBeLessThan(small);
    expect(visionInputTokenBound({ widthPx: 1275, heightPx: 1650 })).toBeGreaterThanOrEqual(2_200);
  });
});

/** A stage whose pages all render as `render` and whose provider answers with `answer(page)`. */
async function pageStage(args: {
  pages: number;
  answer: (pageNumber: number) => { text: string } | Error;
  render?: { sizeBytes: number; widthPx: number | null; heightPx: number | null };
  /** Bytes of each downloaded render (default: not a PNG). */
  file?: Buffer;
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "vision-guard-test-"));
  const rasters = {
    renderSelectedPages: vi.fn(async ({ pageNumbers }: { pageNumbers: number[] }) => pageNumbers.map((pageNumber) => ({
      pageNumber, artifactKey: `k/${pageNumber}`, artifactUri: `s3://bucket/k/${pageNumber}`, mimeType: "image/png",
      cacheHit: false, ...(args.render ?? { sizeBytes: 60_000, widthPx: 1275, heightPx: 1650 }),
    }))),
  };
  const storage = {
    downloadToTempFile: async (key: string) => {
      const dir = await mkdtemp(path.join(scratch, "page-"));
      const file = path.join(dir, `page-${key.split("/")[1]}.png`);
      await writeFile(file, args.file ?? "png");
      return file;
    },
  };
  visionRuntime.execute.mockImplementation(async ({ imagePath }: { imagePath: string }) => {
    const pageNumber = Number(/page-(\d+)\.png$/.exec(imagePath)?.[1]);
    const answer = args.answer(pageNumber);
    if (answer instanceof Error) throw answer;
    return {
      runtime: "openai-compatible", model: MODEL, prompt: "p", text: answer.text, raw: "", costCents: 0.5,
      latencyMs: 1, inputTokens: 2_000, outputTokens: 400, usageSource: "provider", baseUrl: "https://openrouter.ai/api/v1",
      fallbackUsed: false, fallbackReason: null, provider: "openrouter",
    };
  });
  const stage = new VisionExtractStage({} as never, storage as never, CFG, rasters as never);
  const document = { id: "doc", userId: "user-1", filename: "upload.pdf", mimeType: "application/pdf", pageCount: args.pages } as Document;
  const extract = (stage as unknown as {
    extractVisionPagesFromCache(...a: unknown[]): Promise<Array<{ pageNumber: number; text: string }>>;
  }).extractVisionPagesFromCache.bind(stage);
  return {
    stage, document, rasters, scratch,
    run: (state: WorkflowState, hints: LegacyPageHints, skips: Map<number, VisionPageSkip>) =>
      extract(state, document, VISION, Array.from({ length: args.pages }, (_, index) => index + 1), undefined, undefined,
        undefined, false, { hints, skips }),
  };
}

function rejection(message = "degenerate output after 2 attempts", costCents = 1.5) {
  const error = new VisionOutputRejectedError(message, [], 2_400, 640, costCents);
  error.route = { model: MODEL, provider: "openrouter" };
  return error;
}

const noHints: LegacyPageHints = { inkCheckPages: new Set(), fallbackTextPages: new Set() };

describe("vision page loop under the guard", () => {
  let scratch: string | null = null;
  beforeEach(() => {
    visionRuntime.execute.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("stops repeated rejections at the breaker and keeps no model text", async () => {
    const harness = await pageStage({ pages: 40, answer: () => rejection() });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(state, noHints, skips);
    expect(outputs).toEqual([]);
    // Ten rejections trip the breaker; one more may already be in flight (two calls at a time).
    expect(visionRuntime.execute.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(visionRuntime.execute.mock.calls.length).toBeLessThanOrEqual(11);
    const outcomes = [...skips.values()];
    expect(outcomes.filter((skip) => skip.outcome === "rejected")).toHaveLength(visionRuntime.execute.mock.calls.length);
    expect(outcomes.filter((skip) => skip.outcome === "rejection-breaker").length)
      .toBe(40 - visionRuntime.execute.mock.calls.length);
    // Rejected spend is recorded for us (unbilled); nothing stored carries model text.
    const events = state.usageLedger.snapshot();
    expect(events.every((event) => event.metadata?.billable === false)).toBe(true);
    expect(JSON.stringify([...skips.values(), ...events])).not.toMatch(/"text"/);
  });

  it("stops at the provider budget, counting rejected attempts", async () => {
    vi.stubEnv("VISION_RUN_PROVIDER_BUDGET_CENTS", "20");
    vi.stubEnv("VISION_REJECTION_BREAKER_MIN_PAGES", "1000");
    const harness = await pageStage({ pages: 40, answer: () => rejection(undefined, 3) });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    const calls = visionRuntime.execute.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(40);
    expect([...skips.values()].filter((skip) => skip.outcome === "provider-budget")).toHaveLength(40 - calls);
    const spent = state.usageLedger.snapshot().reduce((sum, event) => sum + Number(event.metadata?.providerCostCents ?? 0), 0);
    expect(spent).toBe(calls * 3);
    expect(spent).toBeLessThanOrEqual(20);
  });

  it("a stopped guard renders nothing and calls nothing", async () => {
    const harness = await pageStage({ pages: 3, answer: () => ({ text: "x" }) });
    scratch = harness.scratch;
    const state = runState({ maxCostCents: 0.001 });
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect([...skips.values()].map((skip) => skip.outcome)).toEqual(["provider-budget", "provider-budget", "provider-budget"]);
    const again = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, again);
    expect(harness.rasters.renderSelectedPages).toHaveBeenCalledTimes(1);
    expect(again.size).toBe(3);
  });

  it("records mixed outcomes: read, rejected with text, rejected without text", async () => {
    const harness = await pageStage({
      pages: 3,
      answer: (page) => (page === 1 ? { text: "page one read by vision" } : rejection()),
    });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(state, { inkCheckPages: new Set(), fallbackTextPages: new Set([2]) }, skips);
    expect(outputs.map((page) => page.pageNumber)).toEqual([1]);
    const facts = buildVisionPageFacts({
      documentId: "doc", runId: "run-1", pageCount: 3, selected: [1, 2, 3], processed: outputs, cap: 3, outcomes: skips,
    });
    const statuses = facts.map((fact) => fact.visionStatus);
    expect(statuses.filter((status) => status === "extracted")).toHaveLength(1);
    // A rejected page with usable text keeps it (`rejected`); without any it is an explicit failure.
    expect(statuses).toEqual(["extracted", "rejected", "failed"]);
    expect(facts[1]!.visionTextBytes).toBeNull();
  });

  it("a page task stores the skip, not model text", async () => {
    const harness = await pageStage({ pages: 1, answer: () => rejection() });
    scratch = harness.scratch;
    const state = runState();
    state.documents.push(harness.document);
    const result = await harness.stage.runPageTask(state, {
      runId: "run-1", documentId: "doc", pageNumber: 1, pageCount: 1, vision: VISION as never, fallbackText: true,
    });
    expect(result).toEqual({ pageNumber: 1, outcome: "rejected", fallbackText: true });
    // The stage pass that assembles the document reads the stored outcome back.
    const assembled = runState();
    assembled.distributedVisionPages.set("doc:1", result);
    const skips = new Map<number, VisionPageSkip>();
    expect(await harness.run(assembled, noHints, skips)).toEqual([]);
    expect(skips.get(1)).toEqual({ pageNumber: 1, outcome: "rejected", fallbackText: true });
  });

  it("records a rejected page once and settles its reservation to the rejected cost", async () => {
    const harness = await pageStage({ pages: 3, answer: () => rejection(undefined, 2) });
    scratch = harness.scratch;
    const state = runState();
    await harness.run(state, noHints, new Map());
    const rejected = state.usageLedger.snapshot().filter((event) => event.metadata?.outcome === "rejected");
    expect(rejected.map((event) => event.metadata?.pageNumber).sort()).toEqual([1, 2, 3]);
    expect(ledgerOf(state).inspect("run-1")).toEqual({ costCents: 6, attemptedPages: 3, rejectedPages: 3, liveReservations: 0 });
  });

  it("records the billed cost of a failed, not rejected, call for the guard", async () => {
    const harness = await pageStage({
      pages: 1,
      answer: () => {
        // Fails open (the page keeps its text) after the provider billed an attempt.
        const error = new Error("insufficient_quota after a billed attempt");
        attachVisionBilledUsage(error, { inputTokens: 2_000, outputTokens: 300, costCents: 0.75 });
        return error;
      },
    });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    expect(skips.get(1)?.outcome).toBe("failed");
    const failures = state.usageLedger.snapshot().filter((event) => event.metric === "page-analysis-attempt");
    expect(failures).toHaveLength(1);
    // Unbilled: 0 credits, the provider cost kept for us.
    expect(failures[0]).toMatchObject({ costCents: 0, inputTokens: 2_000, metadata: { outcome: "failure", billable: false, providerCostCents: 0.75 } });
    expect(ledgerOf(state).inspect("run-1")).toMatchObject({ costCents: 0.75, liveReservations: 0 });
  });

  it("a sidecar cleanup failure neither replaces the call's error nor skips settlement", async () => {
    const harness = await pageStage({ pages: 1, answer: () => rejection(undefined, 2) });
    scratch = harness.scratch;
    const answer = visionRuntime.execute.getMockImplementation()!;
    visionRuntime.execute.mockImplementation(async (args: { outputPath: string }) => {
      // rm(force) cannot remove a non-empty directory where the sidecar should be.
      await mkdir(path.join(args.outputPath, "stuck"), { recursive: true });
      return answer(args);
    });
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    expect(skips.get(1)?.outcome).toBe("rejected");
    expect(ledgerOf(state).inspect("run-1")).toEqual({ costCents: 2, attemptedPages: 1, rejectedPages: 1, liveReservations: 0 });
  });

  it("an ink-check page whose render cannot be confirmed is never sent", async () => {
    // The downloaded render is not a PNG and the cache entry carried no dimensions.
    const harness = await pageStage({ pages: 1, answer: () => ({ text: "should not be called" }), render: { sizeBytes: 900, widthPx: null, heightPx: null } });
    scratch = harness.scratch;
    const skips = new Map<number, VisionPageSkip>();
    expect(await harness.run(runState(), { inkCheckPages: new Set([1]), fallbackTextPages: new Set() }, skips)).toEqual([]);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect(skips.get(1)?.outcome).toBe("unverified-render");
  });

  it("fails open on a guard stop", () => {
    const stop = { reason: "rejection-breaker" as const, providerCostCents: 1, reservedCents: 0, budgetCents: 10, attemptedPages: 10, rejectedPages: 10,
      orgUnbilledCents: 0, orgLimitCents: 5_000 };
    expect(shouldFailOpenVisionError(new VisionGuardStopError(stop))).toBe(true);
    expect(shouldFailOpenVisionError(new Error("routed", { cause: new VisionGuardStopError(stop) }))).toBe(true);
  });
});

describe("guardedVisionCall (document-map OCR, self-critique, materialization)", () => {
  beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("records a rejected call's spend once, settles it, and refuses once the run's budget is spent", async () => {
    // Room for one call's reservation (no image: the largest raster) plus a cent.
    const state = runState({ maxCostCents: visionReserveCents(VISION as never, CFG, null) + 1 });
    const call = vi.fn(async () => { throw rejection(undefined, 2); });
    const guarded = () => guardedVisionCall({
      host: state, vision: VISION as never, cfg: CFG, page: { documentId: "doc", pageNumber: 1 },
      record: (input) => state.usageLedger.record(input), metadata: { critique: true }, call, price: () => 0,
    });
    await expect(guarded()).rejects.toThrow(/degenerate/);
    const events = state.usageLedger.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metric: "page-analysis-attempt", metadata: { outcome: "rejected", critique: true, providerCostCents: 2 } });
    expect(ledgerOf(state).inspect("run-1")).toEqual({ costCents: 2, attemptedPages: 1, rejectedPages: 1, liveReservations: 0 });
    // 2 spent: a second call's reservation no longer fits the cap, so it is never made.
    expect(await guarded()).toMatchObject({ admitted: false, stop: { reason: "provider-budget" } });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("fallback text and drawn-content hints", () => {
  const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };
  const surface = (text: string, pageCount: number, evidence: PageImageEvidence[], drawn: number | null = null) => {
    const result = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "upload.pdf", text, pageCount,
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
      pageImageEvidence: new Map(evidence.map((page) => [page.pageNumber, page])),
      drawnBytesPerPage: drawn, routingV2: true,
    });
    if (result.status !== "ready") throw new Error("expected a ready surface");
    return result;
  };

  it("an empty document has no fallback text; drawn-content pages need an ink check", () => {
    const hints = legacyPageHints(surface("", 1, [empty], DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 4).pages);
    expect([...hints.inkCheckPages]).toEqual([1]);
    expect([...hints.fallbackTextPages]).toEqual([]);
  });

  it("garbled text is not usable fallback; readable text is", () => {
    const garbled = Array.from({ length: 20 }, () => "6FDOLQJDWWHQWLRQZLWKRXWORVLQJVLJQDO").join(" ");
    const prose = "A readable paragraph of native text that stays searchable when vision gives nothing back.";
    const hints = legacyPageHints(surface(`${garbled}\f${prose}`, 2, []).pages);
    expect([...hints.fallbackTextPages]).toEqual([2]);
  });
});

const PDFTOPPM = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function minimalPdf(content: string, trailer = ""): Buffer {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
      "/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>",
    `<</Length ${Buffer.byteLength(content)}>>stream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj${object}endobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(body), Buffer.from(trailer)]);
}

async function render(pdf: Buffer, dir: string, name: string) {
  const source = path.join(dir, `${name}.pdf`);
  await writeFile(source, pdf);
  execFileSync("pdftoppm", ["-r", "150", "-png", "-singlefile", source, path.join(dir, name)], { stdio: "ignore" });
  const png = await readFile(path.join(dir, `${name}.png`));
  return {
    fileBytes: (await stat(source)).size,
    png,
    raster: { sizeBytes: png.byteLength, widthPx: png.readUInt32BE(16), heightPx: png.readUInt32BE(20), mimeType: "image/png" },
  };
}

const execute = promisify(execFile);

describe.skipIf(!PDFTOPPM)("padded blank PDFs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "padded-pdf-"));
    visionRuntime.execute.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("a padded blank page is nominated by bytes but never sent to vision", async () => {
    // 400 KB of padding after %%EOF: no text, no images, nothing drawn.
    const padded = await render(minimalPdf("", `%${"x".repeat(400 * 1024)}\n`), dir, "padded");
    const drawn = drawnBytesPerPage(padded.fileBytes, totalEmbeddedImageBytes(""), 1);
    expect(drawn).toBeGreaterThan(DRAWN_CONTENT_MIN_BYTES_PER_PAGE);
    expect(renderLooksBlank(padded.raster)).toBe(true);

    const harness = await pageStage({ pages: 1, answer: () => ({ text: "should not be called" }), render: padded.raster, file: padded.png });
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(runState(), { inkCheckPages: new Set([1]), fallbackTextPages: new Set() }, skips);
    await rm(harness.scratch, { recursive: true, force: true });
    expect(outputs).toEqual([]);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect(skips.get(1)?.outcome).toBe("blank-render");
    expect(buildVisionPageFacts({ documentId: "doc", runId: "run-1", pageCount: 1, selected: [1], processed: [], cap: 1, outcomes: skips })[0]!
      .visionStatus).toBe("not-selected");
  });

  it("render-images renders, vision reads the cache hit, and the blank check still runs", async () => {
    const strokes = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => `${60 + column * 16} ${740 - row * 16} ${4 + ((row * column) % 9)} 6 re`).join(" "),
    ).join("\n") + "\nf";
    for (const [name, pdf, sent] of [
      ["padded", minimalPdf("", `%${"x".repeat(400 * 1024)}\n`), false],
      ["drawn", minimalPdf(strokes), true],
    ] as const) {
      visionRuntime.execute.mockReset();
      visionRuntime.execute.mockResolvedValue({
        runtime: "openai-compatible", model: MODEL, prompt: "p", text: "drawn page text", raw: "", costCents: 0.5,
        latencyMs: 1, inputTokens: 2_000, outputTokens: 400, usageSource: "provider", baseUrl: "https://openrouter.ai/api/v1",
        fallbackUsed: false, fallbackReason: null, provider: "openrouter",
      });
      const source = path.join(dir, `${name}.pdf`);
      await writeFile(source, pdf);
      const objects = new Map<string, Buffer>();
      const storage = {
        objectSize: async (key: string) => objects.get(key)?.byteLength ?? null,
        putBytes: async (key: string, bytes: Buffer) => { objects.set(key, Buffer.from(bytes)); },
        uri: (key: string) => `s3://bucket/${key}`,
        downloadToTempFile: async (key: string) => {
          const target = path.join(await mkdtemp(path.join(dir, "download-")), "page.png");
          await writeFile(target, objects.get(key)!);
          return target;
        },
      };
      const runner = new CommandRunner();
      vi.spyOn(runner, "isAvailable").mockResolvedValue(true);
      vi.spyOn(runner, "run").mockImplementation(async (plan) => {
        const result = await execute(plan.binary, plan.args, { timeout: 15_000, encoding: "utf8" });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 } as never;
      });
      const cache = new PdfRasterCache(runner, storage, { get: async () => ({ path: source }) } as unknown as PdfSourceCache, { engine: "pdftoppm" });
      const document = { id: "doc", userId: "user-1", filename: "upload.pdf", mimeType: "application/pdf", pageCount: 1 } as Document;
      // render-images renders the page first (the normal pipeline).
      const [rendered] = await cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1] });
      expect(rendered!.cacheHit).toBe(false);
      const render = vi.spyOn(cache, "renderSelectedPages");
      const stage = new VisionExtractStage({} as never, storage as never, CFG, cache as never);
      const skips = new Map<number, VisionPageSkip>();
      const outputs = await (stage as unknown as {
        extractVisionPagesFromCache(...a: unknown[]): Promise<Array<{ pageNumber: number }>>;
      }).extractVisionPagesFromCache(runState(), document, VISION, [1], undefined, undefined, undefined, false,
        { hints: { inkCheckPages: new Set([1]), fallbackTextPages: new Set() }, skips });
      // Vision got the cache hit, which carries no dimensions.
      const [hit] = await render.mock.results[0]!.value;
      expect(hit).toMatchObject({ cacheHit: true, widthPx: null, heightPx: null });
      expect(visionRuntime.execute).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect(outputs.map((page) => page.pageNumber)).toEqual(sent ? [1] : []);
      expect(skips.get(1)?.outcome).toBe(sent ? undefined : "blank-render");
      render.mockRestore();
    }
  });

  it("a page of drawn strokes renders with ink", async () => {
    const strokes = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => `${60 + column * 16} ${740 - row * 16} ${4 + ((row * column) % 9)} 6 re`).join(" "),
    ).join("\n") + "\nf";
    const drawn = await render(minimalPdf(strokes), dir, "drawn");
    expect(renderLooksBlank(drawn.raster)).toBe(false);
    // One short line of text is still ink.
    const line = await render(minimalPdf("BT /F1 11 Tf 50 740 Td (Hello world) Tj ET"), dir, "line");
    expect(renderLooksBlank(line.raster)).toBe(false);
  });
});
