/*
 * Warm start of the page image reader (ocr/page-reader-warm.ts): no page ever waits on a booting reader; small runs never
 * start one; a failed or refused start costs nothing but the start-up reservation; launches are capped.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import {
  EXTRACTOR_PLUGIN_API_VERSION, registerExtractorPlugin, resetExtractorPluginsForTest,
  type PageImageReadJob, type PageImageReaderProvider, type PageReaderWarmStatus,
} from "../extractors/plugins.js";
import type { Document, ProjectRun } from "../models.js";
import type { OcrPageRead, OcrReadOutcome } from "../ocr/engine.js";
import { readOcrPagesWithConfiguredReader } from "../ocr/page-reader.js";
import { InMemoryPageReaderOrgBudget } from "../ocr/page-reader-budget.js";
import { assertOcrPageReaderConfiguration, assertVisionPageReaderConfiguration } from "../ocr/page-reader-mode.js";
import {
  DEFAULT_PAGE_READER_WARM_MIN_PAGES, PAGE_READER_WARM_MAX_LAUNCHES, pageReaderWarmGate, pageReaderWarmMinPages, pageReaderWarmSnapshot, resetPageReaderWarmForTest,
} from "../ocr/page-reader-warm.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { VisionExtractStage, type LegacyPageHints } from "../stages/vision-extract.js";
import { pngHeader } from "../test/fake-ocr.js";
import type { Config } from "../config.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-reader-warm-"));
  resetExtractorPluginsForTest();
  resetPageReaderWarmForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetExtractorPluginsForTest();
  resetPageReaderWarmForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A reader whose VM boots slowly: `start` only marks it booting; the test calls `becomeReady()` (or `failBoot()`).
 * A job sent while it is not ready never settles, so any page waiting on the boot would hang the test.
 */
function slowBootingReader(options: { minPages?: number; startResult?: PageReaderWarmStatus["state"]; estimate?: number; lostAfterReady?: boolean } = {}) {
  const scopes = new Map<string, PageReaderWarmStatus["state"]>();
  const key = (scope: { orgId: string; runId: string }) => `${scope.orgId}/${scope.runId}`;
  const jobs: PageImageReadJob[] = [];
  const starts: Array<{ orgId: string; runId: string }> = [];
  let waitedOnBoot = 0;
  const provider: PageImageReaderProvider = {
    id: "slow-reader", model: "slow-reader-model", maxPagesPerJob: 8, maxImageBytes: 1 << 20, maxMarkdownBytes: 4096, maxLongEdgePx: 2048,
    hostCountry: "US", operatorCountry: "US", evalScore: 0.925, evalRef: "tier-benchmark-v1/page-ocr/development/test",
    assertConfigured: () => undefined,
    estimateJobCostCents: (pages: number) => (options.estimate ?? 30) + pages * 0.01,
    warm: {
      ...(options.minPages !== undefined ? { minPages: options.minPages } : {}),
      start(scope) {
        starts.push({ ...scope });
        const state = options.startResult ?? "booting";
        if (!scopes.has(key(scope)) || state !== "booting") scopes.set(key(scope), state);
        return { state: scopes.get(key(scope))! };
      },
      status(scope) {
        const state = scopes.get(key(scope)) ?? "none";
        return state === "ready" ? { state, bootMs: 900_000, bootCostCents: 25 } : { state };
      },
    },
    async read(job) {
      jobs.push(job);
      if (options.lostAfterReady) throw Object.assign(new Error("no ready VM"), { pageReaderUsage: [] });
      if (scopes.get(key(job.scope)) !== "ready") {
        waitedOnBoot += 1;
        return await new Promise<never>(() => undefined); // a job that waits for the boot never comes back
      }
      return {
        results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: `reader ${path.basename(page.imagePath)}`, inputTokens: 1, outputTokens: 1 })),
        usage: [{ provider: "slow-vm", model: "x", metric: "anything", amount: job.pages.length, unit: "page", costCents: 0.5, inputTokens: job.pages.length, outputTokens: job.pages.length }],
      };
    },
  };
  return {
    provider, jobs, starts,
    waitedOnBoot: () => waitedOnBoot,
    becomeReady: (scope = { orgId: "org-1", runId: "run-1" }) => scopes.set(key(scope), "ready"),
    failBoot: (scope = { orgId: "org-1", runId: "run-1" }) => scopes.set(key(scope), "failed"),
    refuseLater: (scope = { orgId: "org-1", runId: "run-1" }) => scopes.set(key(scope), "refused"),
  };
}

function register(provider: PageImageReaderProvider) {
  registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "warm-reader-test", pageImageReader: provider });
}

function pdf(pageCount: number, id = "doc-1"): Document {
  return { id, userId: "user-1", filename: `${id}.pdf`, mimeType: "application/pdf", pageCount, sourceKey: `${id}.pdf` } as Document;
}

function runState(documents: Document[], run: Record<string, unknown> = {}): WorkflowState {
  const id = String(run.id ?? "run-1");
  const state = WorkflowState.create({
    id, orgId: "org-1", projectId: "proj-1", userId: "user-1", spentCents: 0, storagePrefix: `user-1/${id}`, artifacts: {}, stats: {}, stage: "vision-extract",
    // Smartest: the page reader is refused on Fastest (no vision below the intelligent rung).
    pipeline: { ...defaultPipelineFeatures, privacyMode: "standard", ladder: { maxRung: "intelligent" } },
    ...run,
  } as unknown as ProjectRun, documents);
  state.usageLedger.runId = id;
  state.pageReaderBudget = new InMemoryPageReaderOrgBudget();
  return state;
}

/** vision-extract over fake rasters and storage; hosted calls are recorded. `onHosted` runs after each hosted page. */
function harness(onHosted?: (page: number) => void) {
  const rasters = {
    renderSelectedPages: async ({ runId, pageNumbers }: { runId: string; pageNumbers: number[] }) =>
      pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `${runId}/p${pageNumber}`, artifactUri: `s3://b/${runId}/p${pageNumber}`, mimeType: "image/png" })),
  };
  const storage = {
    async downloadToTempFile(key: string) {
      const dir = await mkdtemp(path.join(scratch, "dl-"));
      const [runId, page] = key.split("/");
      const file = path.join(dir, `${runId}-${page}.png`);
      await writeFile(file, Buffer.concat([pngHeader(1414, 2000), Buffer.alloc(64)]));
      return file;
    },
  };
  const stage = new VisionExtractStage({} as CommandRunner, storage as unknown as ArtifactStore, {} as Config, rasters as never);
  const internals = stage as unknown as {
    callVisionOnImage: (...args: any[]) => Promise<any>;
    extractVisionPagesFromCache: (...args: any[]) => Promise<any[]>;
    plannedReaderPages: (...args: any[]) => Promise<number[]>;
  };
  const hosted: number[] = [];
  vi.spyOn(internals, "callVisionOnImage").mockImplementation(async (_state, _doc, _vision, image) => {
    hosted.push(image.pageNumber);
    onHosted?.(image.pageNumber);
    return { pageNumber: image.pageNumber, runtime: "openai-compatible", model: "hosted", inputTokens: 100, outputTokens: 50, latencyMs: 1, text: `hosted ${image.pageNumber}` };
  });
  return { stage, internals, hosted };
}

const NO_HINTS: LegacyPageHints = { inkCheckPages: new Set(), fallbackTextPages: new Set(), triaged: true };
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

async function extract(h: ReturnType<typeof harness>, state: WorkflowState, document: Document, pages: number[]) {
  return await h.internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, pages, undefined, undefined, undefined, false,
    { hints: NO_HINTS, skips: new Map(), pageReader: true });
}

const byRuntime = (outputs: Array<{ pageNumber: number; runtime: string }>, runtime: string) => outputs.filter((o) => o.runtime === runtime).map((o) => o.pageNumber).sort((a, b) => a - b);

function enableVision(minPages: string | null = "10") {
  vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all");
  if (minPages !== null) vi.stubEnv("DOCSLURP_PAGE_READER_WARM_MIN_PAGES", minPages);
}

describe("configuration", () => {
  it("is off without a warm-capable provider, follows the provider's minPages, the setting, or the default, and refuses bad values", () => {
    const { provider } = slowBootingReader({ minPages: 321 });
    expect(pageReaderWarmMinPages(null, {})).toBeNull();
    expect(pageReaderWarmMinPages({}, {})).toBeNull();
    expect(pageReaderWarmMinPages(provider, {})).toBe(321);
    expect(pageReaderWarmMinPages(provider, { DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "40" })).toBe(40);
    expect(pageReaderWarmMinPages(provider, { DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "off" })).toBeNull();
    expect(pageReaderWarmMinPages(slowBootingReader().provider, {})).toBe(DEFAULT_PAGE_READER_WARM_MIN_PAGES);
    for (const bad of ["0", "-1", "1.5", "lots", "1000001"]) {
      expect(() => pageReaderWarmMinPages(provider, { DOCSLURP_PAGE_READER_WARM_MIN_PAGES: bad })).toThrow(/DOCSLURP_PAGE_READER_WARM_MIN_PAGES/);
    }
  });

  it("stops the worker at start on an invalid threshold, with the readers on or off", () => {
    const { provider } = slowBootingReader();
    register(provider);
    expect(() => assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "zero" })).toThrow(/WARM_MIN_PAGES/);
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "zero" }, "vm")).toThrow(/WARM_MIN_PAGES/);
    expect(assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all", DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "25" })).toBe("all");
  });

  it("refuses a provider whose warm capability is malformed", () => {
    const { provider } = slowBootingReader();
    expect(() => register({ ...provider, warm: { start: provider.warm!.start } as never })).toThrow(/warm needs start\(\) and status\(\)/);
    resetExtractorPluginsForTest();
    expect(() => register({ ...provider, warm: { ...provider.warm!, minPages: 0 } })).toThrow(/minPages/);
  });
});

describe("vision transcription", () => {
  it("never waits for a booting reader: pages go hosted while it boots, and later pages go to it once ready", async () => {
    enableVision("10");
    let readyAfterHosted = 6;
    const slow = slowBootingReader();
    const h = harness(() => { if (--readyAfterHosted === 0) slow.becomeReady(); });
    register(slow.provider);
    const document = pdf(40);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 40));

    expect(slow.starts).toEqual([{ orgId: "org-1", runId: "run-1" }]);
    expect(slow.waitedOnBoot()).toBe(0);
    const hostedPages = byRuntime(outputs, "openai-compatible");
    const readerPages = byRuntime(outputs, "page-reader");
    // Every page read exactly once: what went hosted while booting stayed hosted, the rest went to the ready reader.
    expect([...hostedPages, ...readerPages].sort((a, b) => a - b)).toEqual(range(1, 40));
    expect(new Set(h.hosted).size).toBe(h.hosted.length);
    expect(hostedPages.length).toBeGreaterThanOrEqual(6);
    expect(hostedPages.length).toBeLessThanOrEqual(16); // at most the chunks already in flight on four lanes
    expect(readerPages.length).toBeGreaterThanOrEqual(24);
    expect(slow.jobs.every((job) => job.requireReady === true && job.scope.orgId === "org-1" && job.scope.runId === "run-1")).toBe(true);
    const snapshot = pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!;
    expect(snapshot.pages.reader).toBe(readerPages.length);
    expect(snapshot.pages.hostedWhileWarming).toBe(hostedPages.length);
    expect(snapshot.bootMs).toBe(900_000);
    expect(snapshot.bootCostCents).toBe(25);
    // The first job carried the boot: the start-up reservation went back.
    expect(snapshot.reserved).toBe(false);
  });

  it("finishes a document wholly hosted when the reader never becomes ready, with no job sent", async () => {
    enableVision("10");
    const slow = slowBootingReader();
    const h = harness();
    register(slow.provider);
    const document = pdf(30);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 30));
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 30));
    expect(slow.jobs).toHaveLength(0);
    expect(slow.starts).toHaveLength(1);
    // The reader never served a job: the start-up reservation stands (fail closed).
    expect(pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!.reserved).toBe(true);
    expect(await state.pageReaderBudget!.committedCents("org-1")).toBeCloseTo(30, 3);
  });

  it("a run under the threshold never starts a reader and reads every page hosted", async () => {
    enableVision("50");
    const slow = slowBootingReader();
    const h = harness();
    register(slow.provider);
    const document = pdf(20);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 20));
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 20));
    expect(slow.starts).toHaveLength(0);
    expect(slow.jobs).toHaveLength(0);
    expect(pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!.pages.hostedBelowThreshold).toBe(20);
  });

  it("counts a run's demand across its documents: small documents start the reader once their sum reaches the threshold", async () => {
    enableVision("12");
    const slow = slowBootingReader();
    const h = harness();
    register(slow.provider);
    const documents = [pdf(5, "doc-a"), pdf(5, "doc-b"), pdf(5, "doc-c")];
    const state = runState(documents);
    for (const document of documents.slice(0, 2)) await extract(h, state, document, range(1, 5));
    expect(slow.starts).toHaveLength(0);
    await extract(h, state, documents[2]!, range(1, 5));
    expect(slow.starts).toHaveLength(1);
    expect(slow.jobs).toHaveLength(0);
    // Another run of the same organization keeps its own count and its own reader.
    const other = runState([pdf(5, "doc-x")], { id: "run-2" });
    await extract(h, other, other.documents[0]!, range(1, 5));
    expect(slow.starts).toHaveLength(1);
  });

  it("a failed boot sends every remaining page hosted, never a job, and is not retried while the reader read nothing", async () => {
    enableVision("10");
    let failAfterHosted = 4;
    const slow = slowBootingReader();
    const h = harness(() => { if (--failAfterHosted === 0) slow.failBoot(); });
    register(slow.provider);
    const document = pdf(24);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 24));
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 24));
    expect(slow.jobs).toHaveLength(0);
    const second = pdf(24, "doc-2");
    await extract(h, state, second, range(1, 24));
    expect(slow.starts).toHaveLength(1);
    expect(slow.jobs).toHaveLength(0);
  });

  it("a start the provider refuses (its own caps) gives the reservation back and reads hosted", async () => {
    enableVision("10");
    const slow = slowBootingReader({ startResult: "refused" });
    const h = harness();
    register(slow.provider);
    const document = pdf(16);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 16));
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 16));
    expect(slow.jobs).toHaveLength(0);
    expect(await state.pageReaderBudget!.committedCents("org-1")).toBe(0);
  });

  it("starts nothing when the organization's daily reader cap cannot admit the start-up estimate", async () => {
    enableVision("10");
    vi.stubEnv("DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS", "20");
    const slow = slowBootingReader({ estimate: 30 });
    const h = harness();
    register(slow.provider);
    const document = pdf(16);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 16));
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 16));
    expect(slow.starts).toHaveLength(0);
    expect(pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!.pages.hostedUnavailable).toBe(16);
  });

  it("a run without an organization never starts a reader", async () => {
    enableVision("1");
    const slow = slowBootingReader();
    expect(await pageReaderWarmGate(slow.provider, { state: { run: { id: "run-1", orgId: null } }, logTag: "t", minPages: 1, orgDailyMaxCostCents: 1000 }, 100)).toBe("unavailable");
    expect(slow.starts).toHaveLength(0);
  });

  it("caps launches per run: a reader that served pages may be restarted, at most PAGE_READER_WARM_MAX_LAUNCHES times", async () => {
    const slow = slowBootingReader();
    const state = runState([]);
    const ctx = { state, logTag: "t", minPages: 1, orgDailyMaxCostCents: 100_000 };
    const scope = { orgId: "org-1", runId: "run-1" };
    for (let launch = 1; launch <= PAGE_READER_WARM_MAX_LAUNCHES + 2; launch += 1) {
      await pageReaderWarmGate(slow.provider, ctx, 10);
      slow.becomeReady();
      expect(await pageReaderWarmGate(slow.provider, ctx, 0)).toBe("ready");
      // The reader read pages, then went away (idle).
      (await import("../ocr/page-reader-warm.js")).recordPageReaderWarmRouting(scope, "reader", 5);
      slow.failBoot();
      await pageReaderWarmGate(slow.provider, ctx, 0);
    }
    expect(slow.starts).toHaveLength(PAGE_READER_WARM_MAX_LAUNCHES);
  });

  it("concurrent documents of one run start one reader", async () => {
    const slow = slowBootingReader();
    const state = runState([]);
    const ctx = { state, logTag: "t", minPages: 5, orgDailyMaxCostCents: 100_000 };
    const gates = await Promise.all(Array.from({ length: 6 }, () => pageReaderWarmGate(slow.provider, ctx, 5)));
    expect(slow.starts).toHaveLength(1);
    expect(gates.every((gate) => gate === "warming")).toBe(true);
  });

  it("with DOCSLURP_PAGE_READER_WARM_MIN_PAGES=off the reader is used as before (jobs wait for it)", async () => {
    enableVision("off");
    const slow = slowBootingReader();
    slow.becomeReady();
    const h = harness();
    register(slow.provider);
    const document = pdf(10);
    const state = runState([document]);
    const outputs = await extract(h, state, document, range(1, 10));
    expect(byRuntime(outputs, "page-reader")).toEqual(range(1, 10));
    expect(slow.starts).toHaveLength(0);
    expect(slow.jobs.every((job) => job.requireReady === undefined)).toBe(true);
  });

  it("planning holds back only a document with the threshold of reader pages, which run() then warms for", async () => {
    enableVision("10");
    const slow = slowBootingReader();
    const h = harness();
    register(slow.provider);
    const documents = [pdf(6, "doc-a"), pdf(6, "doc-b"), pdf(12, "doc-c")];
    const state = runState(documents);
    const plan = (document: Document, pages: number) => h.internals.plannedReaderPages(state, document, state.run.pipeline.vision, range(1, pages), NO_HINTS);
    expect(await plan(documents[0]!, 6)).toEqual([]);
    expect(await plan(documents[1]!, 6)).toEqual([]);
    expect(await plan(documents[2]!, 12)).toEqual(range(1, 12));
    expect(slow.starts).toHaveLength(0); // planning never starts a reader (it may run in another worker)
    // run() in a fresh worker process sees exactly the held-back pages and reaches the same threshold.
    resetPageReaderWarmForTest();
    await extract(h, runState(documents), documents[2]!, range(1, 12));
    expect(slow.starts).toHaveLength(1);
  });

  it("a start the provider refuses later (its caps) gives the reservation back and is not counted as a launch", async () => {
    const slow = slowBootingReader();
    const state = runState([]);
    const ctx = { state, logTag: "t", minPages: 1, orgDailyMaxCostCents: 100_000 };
    expect(await pageReaderWarmGate(slow.provider, ctx, 5)).toBe("warming");
    expect(await state.pageReaderBudget!.committedCents("org-1")).toBeCloseTo(30, 3);
    slow.refuseLater();
    expect(await pageReaderWarmGate(slow.provider, ctx, 0)).not.toBe("ready");
    await new Promise((r) => setTimeout(r, 0));
    expect(await state.pageReaderBudget!.committedCents("org-1")).toBe(0);
    expect(pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!.launches).toBe(0);
  });

  it("keeps the start-up reservation when the first job after ready was not answered (the VM went away)", async () => {
    enableVision("10");
    const slow = slowBootingReader({ lostAfterReady: true });
    const h = harness();
    register(slow.provider);
    const document = pdf(16);
    const state = runState([document]);
    expect(await pageReaderWarmGate(slow.provider, { state, logTag: "t", minPages: 1, orgDailyMaxCostCents: 100_000 }, 1)).toBe("warming");
    slow.becomeReady();
    const outputs = await extract(h, state, document, range(1, 16));
    // Every page read exactly once, on the hosted route.
    expect(byRuntime(outputs, "openai-compatible")).toEqual(range(1, 16));
    expect(new Set(h.hosted).size).toBe(16);
    expect(slow.jobs.length).toBeGreaterThan(0);
    expect(pageReaderWarmSnapshot({ orgId: "org-1", runId: "run-1" })!.reserved).toBe(true);
  });

  it("a later launch never returns an earlier failed boot's reservation", async () => {
    const slow = slowBootingReader();
    const state = runState([]);
    const ctx = { state, logTag: "t", minPages: 1, orgDailyMaxCostCents: 100_000 };
    const scope = { orgId: "org-1", runId: "run-1" };
    await pageReaderWarmGate(slow.provider, ctx, 10);
    slow.becomeReady();
    await pageReaderWarmGate(slow.provider, ctx, 0);
    (await import("../ocr/page-reader-warm.js")).recordPageReaderWarmRouting(scope, "reader", 5);
    await (await import("../ocr/page-reader-warm.js")).releasePageReaderWarmReservation(scope);
    slow.failBoot();
    await pageReaderWarmGate(slow.provider, ctx, 0); // launch 2
    slow.failBoot(); // launch 2's boot failed after billing
    await pageReaderWarmGate(slow.provider, ctx, 0); // launch 3
    // Launch 2's and launch 3's reservations both stand.
    expect(await state.pageReaderBudget!.committedCents("org-1")).toBeCloseTo(60, 3);
  });

  it("never sends one run's pages to another run's ready reader", async () => {
    enableVision("10");
    const slow = slowBootingReader();
    slow.becomeReady({ orgId: "org-1", runId: "run-1" });
    const h = harness();
    register(slow.provider);
    const other = pdf(20, "doc-other");
    const otherOrg = runState([other], { id: "run-1", orgId: "org-2" });
    const otherRun = runState([other], { id: "run-2" });
    await extract(h, otherOrg, other, range(1, 20));
    await extract(h, otherRun, other, range(1, 20));
    expect(slow.jobs).toHaveLength(0);
    expect(slow.starts.map((scope) => `${scope.orgId}/${scope.runId}`).sort()).toEqual(["org-1/run-2", "org-2/run-1"]);
  });
});

describe("OCR page reader", () => {
  async function outcome(pages: number): Promise<OcrReadOutcome> {
    const reads: OcrPageRead[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const imagePath = path.join(scratch, `frame-${pageNumber}.png`);
      await writeFile(imagePath, pngHeader(100, 50));
      reads.push({ pageNumber, text: `recogniser ${pageNumber}`, meanConfidence: 0.5, recogniser: "multi", chars: 12, elapsedMs: 1, escalation: null, image: { imagePath, width: 100, height: 50 } });
    }
    return {
      mode: "vm", engine: "test-vm-ocr", language: { recognisers: ["multi"], unsupportedScript: false, setting: "auto" },
      pages: reads, truncatedFrames: false, unreadPages: [], wallMs: 1, cpuMs: 1, peakRssKb: 1, dispose: async () => undefined,
    };
  }

  it("keeps the recogniser's text (and escalation) while the reader boots, then reads with requireReady once ready", async () => {
    const slow = slowBootingReader();
    register(slow.provider);
    const state = runState([]);
    const env = { DOCSLURP_OCR_PAGE_READER: "all", DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "5" };
    const first = await outcome(6);
    const booting = await readOcrPagesWithConfiguredReader(first, { state, documentId: "doc-1" }, env);
    expect(booting!.skipped).toEqual({ "reader-warming": 6 });
    expect(first.pages.every((page) => page.recogniser === "multi")).toBe(true);
    expect(slow.jobs).toHaveLength(0);
    expect(slow.starts).toHaveLength(1);

    slow.becomeReady();
    const second = await outcome(3);
    const ready = await readOcrPagesWithConfiguredReader(second, { state, documentId: "doc-2" }, env);
    expect(ready!.replaced).toBe(3);
    expect(slow.jobs.every((job) => job.requireReady === true)).toBe(true);
    expect(slow.waitedOnBoot()).toBe(0);
  });

  it("a small OCR run never starts a reader", async () => {
    const slow = slowBootingReader();
    register(slow.provider);
    const state = runState([]);
    const result = await readOcrPagesWithConfiguredReader(await outcome(3), { state, documentId: "doc-1" }, { DOCSLURP_OCR_PAGE_READER: "all", DOCSLURP_PAGE_READER_WARM_MIN_PAGES: "5" });
    expect(result!.skipped).toEqual({ "reader-below-threshold": 3 });
    expect(slow.starts).toHaveLength(0);
  });
});
