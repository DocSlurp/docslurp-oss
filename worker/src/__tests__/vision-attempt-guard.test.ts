import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

import { visionModelCatalog } from "@docslurp/shared";
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
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { drawnBytesPerPage, renderLooksBlank, totalEmbeddedImageBytes, type PageImageEvidence } from "../lib/page-image-evidence.js";
import {
  defaultOrgAttemptLimit,
  MemoryVisionAttemptBackend,
  recordVisionRead,
  resetVisionGuardWarningsForTest,
  resolveVisionGuardConfig,
  visionGuardFor,
  VisionRunGuard,
  type VisionCallGate,
  type VisionGuardConfig,
  type VisionGuardStop,
  type VisionRequestGate,
} from "../lib/vision-attempt-guard.js";
import { worstCaseVisionRequestCents } from "../lib/vision-pricing.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { PdfRasterCache, type PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { CommandRunner } from "../tools/runner.js";
import type { WorkspaceRun } from "../models.js";
import type { Config } from "../config.js";
import type { Document } from "../models.js";

const MODEL = "google/gemini-3.1-flash-lite";
const VISION = { target: "remote", modelUri: `llm://openrouter/${MODEL}`, maxPagesPerDocument: 1_000 } as const;
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;

/** A run state with its own attempt ledger (never the process-wide one other tests share). */
function runState(pipeline: Record<string, unknown> = {}, backend = new MemoryVisionAttemptBackend(), orgId: string | null = "org-1"): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId, workspaceId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "vision-extract",
    pipeline: { vision: VISION, privacyMode: "standard", visionFallback: true, ...pipeline },
  } as unknown as WorkspaceRun, []);
  state.visionAttempts = backend;
  return state;
}

function ledgerOf(state: WorkflowState): MemoryVisionAttemptBackend {
  return state.visionAttempts as MemoryVisionAttemptBackend;
}

describe("vision guard config", () => {
  beforeEach(() => resetVisionGuardWarningsForTest());

  it("defaults, overrides and clamped ranges", () => {
    expect(resolveVisionGuardConfig({})).toEqual({
      pageAttempts: 2, regionAttempts: 12, breakerMinFailures: 20, breakerFailureRate: 0.25, orgAttemptLimit: defaultOrgAttemptLimit({}),
    });
    expect(resolveVisionGuardConfig({ VISION_ORG_UNCHARGED_ATTEMPT_LIMIT: "800", VISION_REGION_ATTEMPTS_PER_PAGE: "4" }))
      .toMatchObject({ orgAttemptLimit: 800, regionAttempts: 4 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A typo never turns the guard off; an out-of-range value is clamped.
    expect(resolveVisionGuardConfig({
      VISION_PAGE_ATTEMPTS: "off", VISION_REGION_ATTEMPTS_PER_PAGE: "1000", VISION_BREAKER_MIN_FAILURES: "0",
      VISION_BREAKER_FAILURE_RATE: "2", VISION_ORG_UNCHARGED_ATTEMPT_LIMIT: "-5",
    })).toEqual({ pageAttempts: 2, regionAttempts: 64, breakerMinFailures: 1, breakerFailureRate: 1, orgAttemptLimit: 1 });
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });

  it("sizes the default org limit to about $40 of worst-case requests on the configured vision model", () => {
    const hosted = visionModelCatalog.filter((model) => model.target === "hosted" && model.tokenPricing);
    expect(hosted.length).toBeGreaterThan(2);
    for (const model of [null, ...hosted]) {
      const env = model ? { DOCSLURP_VISION_MODEL_URI: model.uri } : {};
      const worst = worstCaseVisionRequestCents(model?.id ?? "deepseek/deepseek-v4.1-flash-1017")!;
      const limit = defaultOrgAttemptLimit(env);
      // limit x worst-case price of one request: the most an org can cost us per day in uncharged requests.
      expect(limit * worst).toBeGreaterThanOrEqual(3_000);
      expect(limit * worst).toBeLessThanOrEqual(5_000);
    }
  });
});

describe("VisionRunGuard", () => {
  const config: VisionGuardConfig = {
    pageAttempts: 2, regionAttempts: 3, breakerMinFailures: 4, breakerFailureRate: 0.5, orgAttemptLimit: 1_000,
  };
  const guardOf = (backend: MemoryVisionAttemptBackend, run = "run-1", org: string | null = "org-1", overrides: Partial<VisionGuardConfig> = {}) =>
    new VisionRunGuard({ id: run, orgId: org }, { ...config, ...overrides }, backend);
  const target = (pageNumber: number, purpose: "page" | "region" | "critique" = "page") => ({ documentId: "doc", pageNumber, purpose });

  /** One call that sends `requests` requests, each failed or not, then settles. */
  async function call(guard: VisionRunGuard, pageNumber: number, requests: number, outcome: { failed?: boolean; charged?: boolean } = {},
    purpose: "page" | "region" | "critique" = "page") {
    const gate = guard.call(target(pageNumber, purpose));
    try {
      for (let n = 0; n < requests; n += 1) {
        await gate.admit();
        if (outcome.failed) gate.failed();
      }
      if (outcome.charged) gate.charged();
    } finally {
      await gate.finish();
    }
  }

  it("bounds requests per page and purpose, refusing only that page", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const guard = guardOf(backend);
    await call(guard, 1, 2);
    await expect(call(guard, 1, 1)).rejects.toMatchObject({ stop: { reason: "page-attempt-limit", sticky: false, pageAttempts: 2, pageLimit: 2 } });
    // Routed regions have their own bound; other pages keep theirs.
    await call(guard, 1, 3, {}, "region");
    await expect(call(guard, 1, 1, {}, "region")).rejects.toMatchObject({ stop: { reason: "page-attempt-limit", pageLimit: 3 } });
    await call(guard, 2, 2);
    expect(guard.stop).toBeNull();
  });

  it("trips the rejection breaker on failed and rejected requests, retries included", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const guard = guardOf(backend);
    // Two reads, then pages whose two requests each fail (an inline retry or the alternate route).
    await call(guard, 1, 1, { charged: true });
    await call(guard, 2, 1, { charged: true });
    await call(guard, 3, 2, { failed: true });
    // 2 failed of 4: rate 0.5 but below the minimum count of 4.
    await call(guard, 4, 2, { failed: true });
    // 4 failed of 6 (0.67): stop, sticky for the run.
    await expect(call(guard, 5, 1)).rejects.toMatchObject({ stop: { reason: "rejection-breaker", sticky: true, runFailures: 4, runAttempts: 6 } });
    expect(guard.stop?.reason).toBe("rejection-breaker");
  });

  it("many small runs of one org stop at the org's uncharged count; another org is unaffected", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const limit = 25;
    const stops: VisionGuardStop[] = [];
    let runs = 0;
    // Each run rejects 2 pages with 2 requests each (4 uncharged): under its own page bound and breaker.
    for (; runs < 20 && stops.length === 0; runs += 1) {
      const guard = guardOf(backend, `small-${runs}`, "org-1", { orgAttemptLimit: limit, breakerMinFailures: 1_000 });
      for (let page = 1; page <= 2; page += 1) {
        try {
          await call(guard, page, 2, { failed: true });
        } catch (error) {
          stops.push((error as VisionGuardStopError).stop);
          break;
        }
      }
    }
    // 25 uncharged requests: the seventh run's second request is refused, not sticky while its first is in flight.
    expect(stops.map((stop) => [stop.reason, stop.sticky])).toEqual([["org-attempt-limit", false]]);
    expect(runs).toBe(7);
    expect(backend.inspect("small-6", "org-1")).toMatchObject({ orgAttempts: 25, orgSettledAttempts: 25 });
    // Every request settled uncharged: the next run is refused and stays refused.
    const next = guardOf(backend, "small-next", "org-1", { orgAttemptLimit: limit });
    await expect(call(next, 1, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: true, orgAttempts: 25, orgLimit: 25 } });
    expect(next.stop?.reason).toBe("org-attempt-limit");
    // Another org starts from zero.
    await call(guardOf(backend, "other", "org-2", { orgAttemptLimit: limit }), 1, 2, { failed: true });
  });

  it("in-flight work never makes a refusal sticky", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const guard = guardOf(backend, "run-1", "org-1", { orgAttemptLimit: 2 });
    // Two calls in flight hold the org's whole count.
    const first = guard.call(target(1));
    const second = guard.call(target(2));
    await first.admit();
    await second.admit();
    const third = guard.call(target(3));
    await expect(third.admit()).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: false, orgAttempts: 2, orgSettledAttempts: 0 } });
    expect(guard.stop).toBeNull();
    // The first read charges its page: its request leaves the count, and page 3 is admitted.
    first.charged();
    await first.finish();
    await third.admit();
    await Promise.all([second.finish(), third.finish()]);
    // Now the limit is filled by finished uncharged requests: sticky.
    await expect(call(guard, 4, 1)).rejects.toMatchObject({ stop: { reason: "org-attempt-limit", sticky: true } });
    expect(guard.stop?.reason).toBe("org-attempt-limit");
  });

  it("a run with no org is refused, never unbounded", async () => {
    const guard = guardOf(new MemoryVisionAttemptBackend(), "orphan", null);
    await expect(call(guard, 1, 1)).rejects.toMatchObject({ stop: { reason: "unscoped-run", sticky: true } });
    expect(guard.stop?.reason).toBe("unscoped-run");
  });

  it("only a request that creates a new customer charge leaves the org count: critique and second reads stay uncharged", async () => {
    const backend = new MemoryVisionAttemptBackend();
    const guard = guardOf(backend);
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    const read = async (pageNumber: number, purpose: "page" | "region" | "critique", metric: string, l = ledger) => {
      const gate = guard.call(target(pageNumber, purpose));
      try {
        await gate.admit();
        recordVisionRead(l, gate, { documentId: "doc", pageNumber }, {
          provider: "openrouter", model: MODEL, metric, amount: 1, unit: "page", costCents: 0.5, inputTokens: 2_000, outputTokens: 400,
          metadata: { documentId: "doc", pageNumber },
        });
      } finally {
        await gate.finish();
      }
    };
    await read(1, "page", "page-analysis");
    expect(backend.inspect("run-1", "org-1").orgAttempts).toBe(0);
    // A routed region of the same page and a self-critique pass create no new charge.
    await read(1, "region", "page-analysis");
    await read(1, "critique", "self-critique");
    expect(backend.inspect("run-1", "org-1").orgAttempts).toBe(2);
    // A later activity of the run (a fresh ledger) re-reading the page: the run already charged it.
    const fresh = new PipelineUsageEventLedger();
    fresh.runId = "run-1";
    await read(1, "page", "page-analysis", fresh);
    expect(backend.inspect("run-1", "org-1").orgAttempts).toBe(3);
    expect(ledger.snapshot().filter((event) => event.metric === "ingest-page-rich")).toHaveLength(1);
  });
});

/** Emulates the requests of one vision call through the gate the stage passes (a rejection sends two). */
async function sendRequests(gate: VisionRequestGate | null, count: number, failed: boolean) {
  for (let n = 0; n < count; n += 1) {
    await gate?.admit();
    if (failed) gate?.failed();
  }
}

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
  visionRuntime.execute.mockImplementation(async ({ imagePath, gate }: { imagePath: string; gate: VisionRequestGate | null }) => {
    const pageNumber = Number(/page-(\d+)\.png$/.exec(imagePath)?.[1]);
    const answer = args.answer(pageNumber);
    if (answer instanceof Error) {
      await sendRequests(gate, answer instanceof VisionOutputRejectedError ? 2 : 1, true);
      throw answer;
    }
    await sendRequests(gate, 1, false);
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
    // Twenty failed requests (ten pages of two) trip the breaker; a page more may already be in flight.
    const { runAttempts } = ledgerOf(state).inspect("run-1", "org-1");
    expect(runAttempts).toBeGreaterThanOrEqual(20);
    expect(runAttempts).toBeLessThanOrEqual(22);
    const outcomes = [...skips.values()];
    const rejected = outcomes.filter((skip) => skip.outcome === "rejected").length;
    expect(rejected).toBeGreaterThanOrEqual(10);
    expect(outcomes.filter((skip) => skip.outcome === "rejection-breaker").length).toBe(40 - rejected);
    expect(visionGuardFor(state).stop?.reason).toBe("rejection-breaker");
    // Rejected spend is recorded for us (unbilled); nothing stored carries model text.
    const events = state.usageLedger.snapshot();
    expect(events.every((event) => event.metadata?.billable === false)).toBe(true);
    expect(JSON.stringify([...skips.values(), ...events])).not.toMatch(/"text"/);
  });

  it("stops at the org's uncharged-attempt limit, counting every rejected request", async () => {
    vi.stubEnv("VISION_ORG_UNCHARGED_ATTEMPT_LIMIT", "6");
    vi.stubEnv("VISION_BREAKER_MIN_FAILURES", "1000");
    const harness = await pageStage({ pages: 40, answer: () => rejection(undefined, 3) });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    // Three pages of two requests fill the limit; no page gets a request past it.
    expect(ledgerOf(state).inspect("run-1", "org-1")).toMatchObject({ orgAttempts: 6, orgSettledAttempts: 6 });
    expect([...skips.values()].filter((skip) => skip.outcome === "org-attempt-limit").length).toBeGreaterThanOrEqual(36);
    expect(visionGuardFor(state).stop?.reason).toBe("org-attempt-limit");
  });

  it("a stopped guard renders nothing and calls nothing; a run with no org is never skipped past the guard", async () => {
    const harness = await pageStage({ pages: 3, answer: () => ({ text: "x" }) });
    scratch = harness.scratch;
    const state = runState({}, new MemoryVisionAttemptBackend(), null);
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    // The unscoped run is refused at its first request: nothing reaches a provider.
    expect(visionRuntime.execute).toHaveBeenCalled();
    expect([...skips.values()].map((skip) => skip.outcome)).toEqual(["unscoped-run", "unscoped-run", "unscoped-run"]);
    const again = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, again);
    // Sticky: the second pass renders nothing.
    expect(harness.rasters.renderSelectedPages).toHaveBeenCalledTimes(1);
    expect([...again.values()].map((skip) => skip.outcome)).toEqual(["unscoped-run", "unscoped-run", "unscoped-run"]);
    expect(state.usageLedger.snapshot().filter((event) => event.metric.startsWith("page-analysis"))).toEqual([]);
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
    // The read page's request created its Rich charge and left the org count; the four rejected requests stay.
    expect(ledgerOf(state).inspect("run-1", "org-1")).toEqual({ runAttempts: 5, runFailures: 4, orgAttempts: 4, orgSettledAttempts: 4 });
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

  it("records a rejected page once and counts both of its requests failed and uncharged", async () => {
    const harness = await pageStage({ pages: 3, answer: () => rejection(undefined, 2) });
    scratch = harness.scratch;
    const state = runState();
    await harness.run(state, noHints, new Map());
    const rejected = state.usageLedger.snapshot().filter((event) => event.metadata?.outcome === "rejected");
    expect(rejected.map((event) => event.metadata?.pageNumber).sort()).toEqual([1, 2, 3]);
    expect(ledgerOf(state).inspect("run-1", "org-1")).toEqual({ runAttempts: 6, runFailures: 6, orgAttempts: 6, orgSettledAttempts: 6 });
  });

  it("records the billed usage of a failed, not rejected, call", async () => {
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
    expect(ledgerOf(state).inspect("run-1", "org-1")).toEqual({ runAttempts: 1, runFailures: 1, orgAttempts: 1, orgSettledAttempts: 1 });
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
    expect(ledgerOf(state).inspect("run-1", "org-1")).toEqual({ runAttempts: 2, runFailures: 2, orgAttempts: 2, orgSettledAttempts: 2 });
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
    const stop: VisionGuardStop = { reason: "rejection-breaker", sticky: true, pageAttempts: 0, pageLimit: 2, runAttempts: 40,
      runFailures: 20, orgAttempts: 20, orgSettledAttempts: 20, orgLimit: 2_000 };
    expect(shouldFailOpenVisionError(new VisionGuardStopError(stop))).toBe(true);
    expect(shouldFailOpenVisionError(new Error("routed", { cause: new VisionGuardStopError(stop) }))).toBe(true);
  });
});

describe("guardedVisionCall (document-map OCR, self-critique, materialization)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("records a rejected call's spend once and refuses the page past its attempt bound without sending", async () => {
    const state = runState();
    let sent = 0;
    const call = vi.fn(async (gate: VisionCallGate) => {
      for (let n = 0; n < 2; n += 1) {
        await gate.admit();
        sent += 1;
        gate.failed();
      }
      throw rejection(undefined, 2);
    });
    const guarded = () => guardedVisionCall({
      host: state, vision: VISION as never, cfg: CFG, target: { documentId: "doc", pageNumber: 1, purpose: "critique" },
      record: (input) => state.usageLedger.record(input), metadata: { critique: true }, call,
    });
    await expect(guarded()).rejects.toThrow(/degenerate/);
    const events = state.usageLedger.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metric: "page-analysis-attempt", metadata: { outcome: "rejected", critique: true, providerCostCents: 2 } });
    // Two critique requests used the page's bound: a second critique of page 1 is refused before sending.
    expect(await guarded()).toMatchObject({ admitted: false, stop: { reason: "page-attempt-limit" } });
    expect(sent).toBe(2);
    expect(ledgerOf(state).inspect("run-1", "org-1")).toEqual({ runAttempts: 2, runFailures: 2, orgAttempts: 2, orgSettledAttempts: 2 });
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
