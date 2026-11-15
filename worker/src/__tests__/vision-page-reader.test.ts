import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLABLE_UNIT_METRICS, defaultPipelineFeatures, selectVisionTranscriptionRoute, bestHostedPageOcrScore, VISION_PAGE_READER_BALANCED_MARGIN,
} from "@docslurp/shared";

import {
  EXTRACTOR_PLUGIN_API_VERSION, PAGE_IMAGE_READ_FAILURES, registerExtractorPlugin, resetExtractorPluginsForTest,
  type PageImageReadJob, type PageImageReaderProvider,
} from "../extractors/plugins.js";
import type { Document } from "../models.js";
import { InMemoryPageReaderOrgBudget } from "../ocr/page-reader-budget.js";
import { assertVisionPageReaderConfiguration, visionPageReaderMode } from "../ocr/page-reader-mode.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { VisionExtractStage, legacyPageHints, type LegacyPageHints } from "../stages/vision-extract.js";
import { visionPageReaderDecision } from "../stages/vision-page-reader.js";
import { visionConfigForModel } from "../routing/routed-vision.js";
import { pngHeader } from "../test/fake-ocr.js";
import type { Config } from "../config.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-vision-page-reader-"));
  resetExtractorPluginsForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetExtractorPluginsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

type ReadImpl = PageImageReaderProvider["read"];

/** Every job's scope and the image file names it carried. */
type JobLog = Array<{ scope: PageImageReadJob["scope"]; files: string[] }>;

function reader(read: ReadImpl, overrides: Partial<PageImageReaderProvider> = {}) {
  const jobs: JobLog = [];
  const provider = {
    id: "test-page-reader", model: "test-reader-model", maxPagesPerJob: 8, maxImageBytes: 1 << 20, maxMarkdownBytes: 4096,
    maxLongEdgePx: 2048, evalScore: 0.925, evalRef: "tier-benchmark-v1/page-ocr/development/test",
    assertConfigured: vi.fn(), estimateJobCostCents: () => 0.01,
    read: vi.fn(async (job: PageImageReadJob, signal?: AbortSignal) => {
      jobs.push({ scope: { ...job.scope }, files: job.pages.map((page) => path.basename(page.imagePath)) });
      return await read(job, signal);
    }),
    ...overrides,
  } as PageImageReaderProvider & { read: ReturnType<typeof vi.fn> };
  return { provider, jobs };
}

/** Answers every page with Markdown naming its file, and one usage event for the job. */
const echo: ReadImpl = async (job) => ({
  results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: `# Read ${path.basename(page.imagePath)}\n\nInline $x^2$.`, inputTokens: 10, outputTokens: 5 })),
  usage: [{ provider: "test-vm", model: "x", metric: "anything", amount: job.pages.length, unit: "page", costCents: 0.3, inputTokens: 10 * job.pages.length, outputTokens: 5 * job.pages.length }],
});

function register(provider: PageImageReaderProvider) {
  registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "vision-reader-test", pageImageReader: provider });
}

function pdf(id = "doc-1"): Document {
  return { id, userId: "user-1", filename: `${id}.pdf`, mimeType: "application/pdf", pageCount: 6, sourceKey: `${id}.pdf` } as Document;
}

function runState(document: Document, run: Record<string, unknown> = {}, pipeline: Record<string, unknown> = {}): WorkflowState {
  const id = String(run.id ?? "run-1");
  const state = WorkflowState.create({
    id, orgId: "org-1", projectId: "proj-1", userId: "user-1", spentCents: 0, storagePrefix: `user-1/${id}`,
    pipeline: { ...defaultPipelineFeatures, privacyMode: "standard", ...pipeline },
    ...run,
  } as never, [document]);
  state.usageLedger.runId = id;
  state.pageReaderBudget = new InMemoryPageReaderOrgBudget();
  return state;
}

/**
 * A stage over fake rasters and storage: each render is a PNG (or `files[page]` bytes) in its own temp directory, named
 * `<runId>-p<page>.png`; hosted calls are recorded and answered.
 */
function harness(options: { files?: Record<number, Buffer>; renderEdge?: number[] } = {}) {
  const rendered: Array<{ runId: string; pages: number[]; maxLongEdgePx?: number }> = [];
  const rasters = {
    renderSelectedPages: async ({ runId, pageNumbers, maxLongEdgePx }: { runId: string; pageNumbers: number[]; maxLongEdgePx?: number }) => {
      rendered.push({ runId, pages: [...pageNumbers], ...(maxLongEdgePx !== undefined ? { maxLongEdgePx } : {}) });
      return pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `${runId}/p${pageNumber}`, artifactUri: `s3://b/${runId}/p${pageNumber}`, mimeType: "image/png" }));
    },
  };
  const storage = {
    async downloadToTempFile(key: string) {
      const dir = await mkdtemp(path.join(scratch, "dl-"));
      const [runId, page] = key.split("/");
      const file = path.join(dir, `${runId}-${page}.png`);
      const pageNumber = Number(page!.slice(1));
      await writeFile(file, options.files?.[pageNumber] ?? Buffer.concat([pngHeader(1414, 2000), Buffer.alloc(64)]));
      return file;
    },
  };
  const stage = new VisionExtractStage({} as CommandRunner, storage as unknown as ArtifactStore, {} as Config, rasters as never);
  const internals = stage as unknown as {
    callVisionOnImage: (...args: any[]) => Promise<any>;
    extractVisionPagesFromCache: (...args: any[]) => Promise<any[]>;
    checkNeedsVision: (...args: any[]) => Promise<any>;
    loadRoutedExecution: (...args: any[]) => Promise<any>;
    visionAllowed: (...args: any[]) => Promise<boolean>;
  };
  const hosted: Array<{ runId: string; page: number }> = [];
  vi.spyOn(internals, "callVisionOnImage").mockImplementation(async (state: WorkflowState, _doc, _vision, image) => {
    hosted.push({ runId: state.run.id, page: image.pageNumber });
    return { pageNumber: image.pageNumber, runtime: "openai-compatible", model: "hosted", inputTokens: 100, outputTokens: 50, latencyMs: 1, text: `hosted ${image.pageNumber}` };
  });
  return { stage, internals, rendered, hosted };
}

const NO_HINTS: LegacyPageHints = { inkCheckPages: new Set(), fallbackTextPages: new Set(), triaged: true };

/** The legacy whole-document read (run()), the only caller that may use the reader. */
async function extract(h: ReturnType<typeof harness>, state: WorkflowState, document: Document, pages: number[], hints: LegacyPageHints = NO_HINTS,
  options: { pageReader?: boolean; bypassCache?: boolean } = {}) {
  return await h.internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, pages, undefined, undefined, undefined,
    options.bypassCache ?? false, { hints, skips: new Map(), pageReader: options.pageReader ?? true });
}

const readerOutputs = (outputs: Array<{ pageNumber: number; runtime: string }>) => outputs.filter((output) => output.runtime === "page-reader").map((output) => output.pageNumber);

describe("tier vocabulary", () => {
  it("fastest picks a measured reader; balanced within the margin of the best hosted composite; smart only at or above it", () => {
    const best = bestHostedPageOcrScore()!;
    expect(best).toBeGreaterThan(0.9);
    const at = (score: number | null) => ({ pageReader: { evalScore: score } });
    for (const tier of ["fastest", "balanced", "smart"] as const) {
      expect(selectVisionTranscriptionRoute(tier, { pageReader: null }).pageReader).toBe(false);
      expect(selectVisionTranscriptionRoute(tier, at(null)).pageReader).toBe(false);
      expect(selectVisionTranscriptionRoute(tier, at(Number.NaN)).pageReader).toBe(false);
    }
    expect(selectVisionTranscriptionRoute("fastest", at(0.5)).pageReader).toBe(true);
    // Never a reader at or under the OCR recogniser alone (0.477), whatever the tier; and balanced needs a hosted score.
    expect(selectVisionTranscriptionRoute("fastest", at(0.4)).pageReader).toBe(false);
    expect(selectVisionTranscriptionRoute("balanced", at(0.99), []).pageReader).toBe(false);
    expect(selectVisionTranscriptionRoute("balanced", at(best - VISION_PAGE_READER_BALANCED_MARGIN)).pageReader).toBe(true);
    expect(selectVisionTranscriptionRoute("balanced", at(best - VISION_PAGE_READER_BALANCED_MARGIN - 0.001)).pageReader).toBe(false);
    expect(selectVisionTranscriptionRoute("smart", at(best - 0.001)).pageReader).toBe(false);
    expect(selectVisionTranscriptionRoute("smart", at(best)).pageReader).toBe(true);
  });

  it("parses DOCSLURP_VISION_PAGE_READER: off by default, all, tier words against the registered reader, anything else throws", () => {
    expect(visionPageReaderMode({})).toBe("off");
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "ALL" })).toBe("all");
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "balanced" })).toBe("off");
    register(reader(echo).provider);
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "balanced" })).toBe("all");
    expect(visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "smart" })).toBe("off");
    expect(() => visionPageReaderMode({ DOCSLURP_VISION_PAGE_READER: "escalation" })).toThrow(/DOCSLURP_VISION_PAGE_READER/);
  });

  it("refuses to start when on without a registered, ready reader", () => {
    expect(() => assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all" })).toThrow(/refusing to start/);
    expect(assertVisionPageReaderConfiguration({})).toBe("off");
    const { provider } = reader(echo, { assertConfigured: () => { throw new Error("reader not configured"); } });
    register(provider);
    expect(() => assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all" })).toThrow(/not configured/);
    resetExtractorPluginsForTest();
    register(reader(echo, { estimateJobCostCents: undefined }).provider);
    expect(() => assertVisionPageReaderConfiguration({ DOCSLURP_VISION_PAGE_READER: "all" })).toThrow(/estimateJobCostCents/);
  });

  it("refuses a provider whose maxLongEdgePx is out of range", () => {
    expect(() => register(reader(echo, { maxLongEdgePx: 100 }).provider)).toThrow(/maxLongEdgePx/);
    resetExtractorPluginsForTest();
    expect(() => register(reader(echo, { maxLongEdgePx: 2048.5 }).provider)).toThrow(/maxLongEdgePx/);
  });
});

describe("which pages the reader reads", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it("sends plain transcription pages in one batched job at the reader's long edge and keeps figure, drawn and table-rescue pages hosted", async () => {
    const { provider, jobs } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const hints: LegacyPageHints = { inkCheckPages: new Set([4]), fallbackTextPages: new Set(), figurePages: new Set([3]), tableRescuePages: new Set([5]), triaged: true };
    const outputs = await extract(h, state, document, [1, 2, 3, 4, 5, 6], hints);
    expect(jobs).toEqual([{ scope: { orgId: "org-1", runId: "run-1" }, files: ["run-1-p1.png", "run-1-p2.png", "run-1-p6.png"] }]);
    expect(h.rendered[0]).toEqual({ runId: "run-1", pages: [1, 2, 6], maxLongEdgePx: 2048 });
    expect(readerOutputs(outputs)).toEqual([1, 2, 6]);
    // Page 4 (drawn content) takes the hosted route's own ink check, which this fake render does not pass.
    expect(h.hosted.map((call) => call.page).sort()).toEqual([3, 5]);
    expect(h.rendered[1]).toEqual({ runId: "run-1", pages: [3, 4, 5] });
    expect(outputs.find((output) => output.pageNumber === 1)!.text).toBe("# Read run-1-p1.png\n\nInline $x^2$.");
  });

  it("derives figure pages from page triage routes", () => {
    const hints = legacyPageHints([
      { pageNumber: 1, textDensityScore: 0.5, signals: [], route: "chart-or-figure" },
      { pageNumber: 2, textDensityScore: 0.5, signals: [], route: "image-heavy" },
      { pageNumber: 3, textDensityScore: 0.5, signals: [], route: "handwriting-or-degraded" },
    ]);
    expect([...hints.figurePages!]).toEqual([1, 2]);
  });

  it.each([
    ["an output schema", {}, { outputSchema: { type: "object", properties: { total: { type: "number" } } } }],
    ["a task prompt template", {}, { vision: { ...defaultPipelineFeatures.vision, prompt: "Describe the chart's data series as JSON." } }],
    ["strict-privacy", {}, { privacyMode: "strict-privacy" }],
    ["local-only", {}, { privacyMode: "local-only" }],
    ["a run without an organization", { orgId: null }, {}],
  ])("never sends a page of a run with %s to the reader", async (_label, run, pipeline) => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document, run, pipeline);
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2]);
    expect(provider.read).not.toHaveBeenCalled();
    expect(readerOutputs(outputs)).toEqual([]);
    expect(h.hosted.map((call) => call.page).sort()).toEqual([1, 2]);
  });

  it("keeps a run pinned to a local or operator-private vision model on that model", () => {
    register(reader(echo).provider);
    const document = pdf();
    const local = runState(document, {}, { vision: { ...defaultPipelineFeatures.vision, runtime: "local-cli", modelUri: "vlm:local/florence", model: "microsoft/Florence-2-base-ft", provider: "vision-runtime", target: "local" } });
    expect(visionPageReaderDecision(local, local.run.pipeline.vision, { DOCSLURP_VISION_PAGE_READER: "all" })).toMatchObject({ refused: "configured-route" });
    const standard = runState(document);
    expect(visionPageReaderDecision(standard, standard.run.pipeline.vision, { DOCSLURP_VISION_PAGE_READER: "all" })).toHaveProperty("provider");
    expect(visionPageReaderDecision(standard, standard.run.pipeline.vision, {})).toEqual({ refused: "off" });
    expect(visionPageReaderDecision(standard, standard.run.pipeline.vision, { DOCSLURP_VISION_PAGE_READER: "bogus" })).toEqual({ refused: "off" });
  });

  it.each([
    ["a routed group or page task (not the legacy whole-document read)", { pageReader: false }],
    ["a cascade escalation leg (bypassCache)", { bypassCache: true }],
  ])("never sends %s to the reader", async (_label, options) => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1, 2], NO_HINTS, options);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted).toHaveLength(2);
  });

  it("keeps a document without page triage on the hosted route (no page is known not to be a figure)", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1, 2], { inkCheckPages: new Set(), fallbackTextPages: new Set() });
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted).toHaveLength(2);
  });

  it("keeps a run pinned to a loopback OpenAI-compatible model (vLLM, Ollama) on that model", async () => {
    register(reader(echo).provider);
    const document = pdf();
    for (const modelUri of ["llm://vllm/qwen/qwen3-vl-8b-instruct", "llm://ollama/qwen3-vl:8b"]) {
      const vision = visionConfigForModel(defaultPipelineFeatures.vision, modelUri);
      const state = runState(document, {}, { vision });
      expect(visionPageReaderDecision(state, vision, { DOCSLURP_VISION_PAGE_READER: "all" }), modelUri).toEqual({ refused: "configured-route" });
    }
  });

  it("keeps raster uploads (not PDF renders) on the hosted route", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = { ...pdf(), mimeType: "image/png", pageCount: 1 } as Document;
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1]);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted.map((call) => call.page)).toEqual([1]);
  });

  it("is off by default: no render at the reader edge, every page hosted", async () => {
    vi.unstubAllEnvs();
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1, 2]);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted).toHaveLength(2);
  });
});

describe("hosted fallback", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it.each(PAGE_IMAGE_READ_FAILURES)("sends a page the reader fails with %s to the hosted route, keeping the pages it read", async (reason) => {
    const { provider } = reader(async (job) => ({
      results: job.pages.map((page, index) => index === 1 ? { key: page.key, status: "failed" as const, reason } : { key: page.key, status: "read" as const, markdown: "ok" }),
      usage: [],
    }));
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2, 3]);
    expect(readerOutputs(outputs)).toEqual([1, 3]);
    expect(h.hosted.map((call) => call.page)).toEqual([2]);
    // The hosted page renders at its own route's size, not the reader's.
    expect(h.rendered.at(-1)).toEqual({ runId: "run-1", pages: [2] });
  });

  it.each([
    ["a job that throws", async () => { throw new Error("lease failed"); }],
    ["a refused job", async () => { throw Object.assign(new Error("refused"), { ocrRefused: true }); }],
    ["a timed-out job", async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }],
    ["a malformed response", async () => ({ results: "nope", usage: [] })],
    ["a response with an unknown key", async () => ({ results: [{ key: "someone-else", status: "read", markdown: "x" }], usage: [] })],
    ["a response missing pages", async () => ({ results: [], usage: [] })],
    ["empty Markdown", async (job: PageImageReadJob) => ({ results: job.pages.map((page) => ({ key: page.key, status: "read", markdown: " \u0000 " })), usage: [] })],
    ["Markdown over the provider's cap", async (job: PageImageReadJob) => ({ results: job.pages.map((page) => ({ key: page.key, status: "read", markdown: "x".repeat(5000) })), usage: [] })],
  ])("sends every page of %s to the hosted route", async (_label, impl) => {
    const { provider } = reader(impl as unknown as ReadImpl);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2]);
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(readerOutputs(outputs)).toEqual([]);
    expect(h.hosted.map((call) => call.page).sort()).toEqual([1, 2]);
  });

  it("propagates a render failure as the hosted route would, without reading anything", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const rasters = (h.stage as unknown as { rasters: { renderSelectedPages: (args: { maxLongEdgePx?: number }) => Promise<unknown> } }).rasters;
    const render = rasters.renderSelectedPages.bind(rasters);
    vi.spyOn(rasters, "renderSelectedPages").mockImplementation(async (args) => {
      if (args.maxLongEdgePx === 2048) throw new Error("renderer unavailable");
      return await render(args);
    });
    await expect(extract(h, state, document, [1, 2])).rejects.toThrow(/renderer unavailable/);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted).toHaveLength(0);
  });

  it("sends pages to the hosted route when the reader path throws past the job (a ledger write)", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    vi.spyOn(state.usageLedger, "chargeRichPage").mockImplementation(() => { throw new Error("ledger down"); });
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2]);
    // Page 1 was read (kept, never sent hosted too); page 2 goes hosted.
    expect(readerOutputs(outputs)).toEqual([1]);
    expect(h.hosted.map((call) => call.page)).toEqual([2]);
  });

  it("propagates an abort instead of falling back", async () => {
    const controller = new AbortController();
    const { provider } = reader(async () => { controller.abort(); throw new Error("aborted"); });
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await expect(h.internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, [1, 2], controller.signal, undefined, undefined, false, { hints: NO_HINTS, pageReader: true })).rejects.toThrow();
    expect(h.hosted).toEqual([]);
  });
});

describe("caps", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it("stops at the organization's daily reader cost cap, renders nothing more at the reader edge, and sends the rest hosted", async () => {
    vi.stubEnv("DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS", "1");
    const { provider } = reader(echo, { maxPagesPerJob: 2, estimateJobCostCents: () => 0.9 });
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2, 3, 4, 5, 6, 7, 8]);
    // One job (0.9 reserved) fits under the 1-cent cap; a second reservation does not.
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(readerOutputs(outputs)).toHaveLength(2);
    expect(h.hosted).toHaveLength(6);
    // Two batches in flight at most were rendered at the reader edge before the cap stopped the loop.
    expect(h.rendered.filter((render) => render.maxLongEdgePx === 2048).length).toBeLessThanOrEqual(3);
    const capped = runState(document, { id: "run-2" });
    capped.pageReaderBudget = state.pageReaderBudget;
    const h2 = harness();
    const second = await extract(h2, capped, document, [1, 2]);
    // 0.3 committed today plus a 0.9 reservation passes the 1-cent cap: nothing sent, every page hosted.
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(readerOutputs(second)).toEqual([]);
    expect(h2.hosted.map((call) => call.page).sort()).toEqual([1, 2]);
  });

  it("sends nothing when the organization spend ledger is unavailable (fail closed to hosted)", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    state.pageReaderBudget = null;
    const h = harness();
    await extract(h, state, document, [1, 2]);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted).toHaveLength(2);
  });

  it("shares the per-document reader page budget", async () => {
    vi.stubEnv("DOCSLURP_OCR_PAGE_READER_MAX_PAGES", "2");
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const outputs = await extract(h, state, document, [1, 2, 3]);
    expect(readerOutputs(outputs)).toEqual([1, 2]);
    expect(h.hosted.map((call) => call.page)).toEqual([3]);
    // A later batch of the same document in the same run gets nothing more, and is not even rendered at the reader edge.
    const renders = h.rendered.length;
    const again = await extract(h, state, document, [4]);
    expect(readerOutputs(again)).toEqual([]);
    expect(h.rendered.slice(renders).every((render) => render.maxLongEdgePx === undefined)).toBe(true);
  });

  it("sends nothing once the run cost cap is reached", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document, { spentCents: 100 }, { maxCostCents: 50 });
    const h = harness();
    await extract(h, state, document, [1]);
    expect(provider.read).not.toHaveBeenCalled();
  });
});

describe("tenant scope", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it("never mixes two organizations' pages in one job, even when their runs read concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    const { provider, jobs } = reader(async (job) => {
      entered += 1;
      if (entered === 2) release();
      await gate;
      return await echo(job);
    });
    register(provider);
    const a = pdf("doc-a");
    const b = pdf("doc-b");
    const stateA = runState(a, { id: "run-a", orgId: "org-a" });
    const stateB = runState(b, { id: "run-b", orgId: "org-b" });
    const h = harness();
    const [outA, outB] = await Promise.all([extract(h, stateA, a, [1, 2]), extract(h, stateB, b, [1, 2])]);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const run = job.scope.runId === "run-a" ? "run-a" : "run-b";
      expect(job.scope).toEqual({ orgId: run === "run-a" ? "org-a" : "org-b", runId: run });
      expect(job.files.every((file) => file.startsWith(`${run}-`))).toBe(true);
    }
    expect(outA.map((output) => output.text)).toEqual(["# Read run-a-p1.png\n\nInline $x^2$.", "# Read run-a-p2.png\n\nInline $x^2$."]);
    expect(outB.map((output) => output.text)).toEqual(["# Read run-b-p1.png\n\nInline $x^2$.", "# Read run-b-p2.png\n\nInline $x^2$."]);
    // Each run's usage is stamped with its own scope only.
    for (const [state, org] of [[stateA, "org-a"], [stateB, "org-b"]] as const) {
      const events = state.usageLedger.snapshot().filter((event) => event.metric === "vision-page-reader");
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.metadata?.orgId === org && event.metadata?.runId === state.run.id)).toBe(true);
    }
  });
});

describe("usage", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it("records provider cost at 0 credits, logs [ai-usage], and charges each read page one Rich page", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1, 2]);
    const events = state.usageLedger.snapshot();
    const usage = events.filter((event) => event.metric === "vision-page-reader");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: "test-reader-model", costCents: 0, inputTokens: 20, outputTokens: 10,
      metadata: expect.objectContaining({ providerCostCents: 0.3, billable: false, orgId: "org-1", runId: "run-1", projectId: "proj-1", documentId: "doc-1", reader: "test-page-reader" }),
    });
    const rich = events.filter((event) => event.metric === BILLABLE_UNIT_METRICS.richPage);
    expect(rich.map((event) => event.metadata?.pageNumber).sort()).toEqual([1, 2]);
    expect(rich.every((event) => event.metadata?.readBy === "vision-page-reader")).toBe(true);
    expect(vi.mocked(console.log).mock.calls.some(([line]) => String(line) === "[ai-usage] vision-page-reader model=test-reader-model input_tokens=20 output_tokens=10")).toBe(true);
  });

  it("records a failed job's incurred cost too", async () => {
    const { provider } = reader(async () => { throw Object.assign(new Error("vm lost"), { pageReaderUsage: [{ metric: "x", provider: "test-vm", model: "x", costCents: 0.2, amount: 1, unit: "page" }] }); });
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    await extract(h, state, document, [1]);
    const usage = state.usageLedger.snapshot().filter((event) => event.metric === "vision-page-reader");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.metadata).toMatchObject({ providerCostCents: 0.2, outcome: "failed" });
    expect(h.hosted).toHaveLength(1);
  });
});

describe("hostile images", () => {
  beforeEach(() => vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all"));

  it("never sends a non-PNG, a PNG over the long edge or pixel bound, or an oversized file; those pages go hosted", async () => {
    const { provider, jobs } = reader(echo, { maxImageBytes: 4096 });
    register(provider);
    const document = pdf();
    const state = runState(document);
    const files: Record<number, Buffer> = {
      1: Buffer.from("<svg onload=alert(1)></svg>".padEnd(64, " ")),
      2: Buffer.concat([pngHeader(50_000, 50_000), Buffer.alloc(64)]),
      3: Buffer.concat([pngHeader(2049, 1000), Buffer.alloc(64)]),
      4: Buffer.concat([pngHeader(1000, 1400), Buffer.alloc(8192)]),
      5: Buffer.concat([pngHeader(0, 1400), Buffer.alloc(64)]),
      6: Buffer.concat([pngHeader(2048, 1448), Buffer.alloc(64)]),
    };
    const h = harness({ files });
    const outputs = await extract(h, state, document, [1, 2, 3, 4, 5, 6]);
    expect(jobs).toEqual([{ scope: { orgId: "org-1", runId: "run-1" }, files: ["run-1-p6.png"] }]);
    expect(readerOutputs(outputs)).toEqual([6]);
    expect(h.hosted.map((call) => call.page).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("strips control characters from the reader's Markdown", async () => {
    const { provider } = reader(async (job) => ({ results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: "a\u0000b\u001bc\n" })), usage: [] }));
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    const outputs = await extract(h, state, document, [1]);
    expect(outputs[0]!.text).toBe("abc");
  });
});

describe("page task planning", () => {
  it("fans out only the pages the reader will not read; routed documents and page tasks never use it", async () => {
    const { provider } = reader(echo);
    register(provider);
    const document = pdf();
    const state = runState(document);
    const h = harness();
    vi.spyOn(h.internals, "visionAllowed").mockResolvedValue(true);
    vi.spyOn(h.internals, "loadRoutedExecution").mockResolvedValue(null);
    const hints: LegacyPageHints = { ...NO_HINTS, figurePages: new Set([2]), tableRescuePages: new Set([4]) };
    vi.spyOn(h.internals, "checkNeedsVision").mockResolvedValue({ needed: true, selectedPages: [1, 2, 3, 4, 5], hints });
    expect((await h.stage.planPageTasks(state)).map((task) => task.pageNumber)).toEqual([1, 2, 3, 4, 5]);
    vi.stubEnv("DOCSLURP_VISION_PAGE_READER", "all");
    const tasks = await h.stage.planPageTasks(state);
    expect(tasks.map((task) => task.pageNumber)).toEqual([2, 4]);
    // A page task reads on the hosted route even with the reader on.
    const task = tasks[0]!;
    await h.stage.runPageTask(state, task);
    expect(provider.read).not.toHaveBeenCalled();
    expect(h.hosted.map((call) => call.page)).toEqual([2]);
  });
});
