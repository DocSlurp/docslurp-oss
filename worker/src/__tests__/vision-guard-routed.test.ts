import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assignment, RoutePlan, RoutingTarget } from "@docslurp/shared";

const visionRuntime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../tools/vision-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/vision-runtime.js")>();
  return { ...actual, executeVisionRuntime: visionRuntime.execute };
});
// Executor edges without poppler or a canonical document; `vlm` goes through the stage's own call.
const rasterDir = vi.hoisted(() => ({ path: "" }));
vi.mock("../routing/executors/deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routing/executors/deps.js")>();
  const { visionConfigForModel } = await import("../routing/routed-vision.js");
  return {
    ...actual,
    createProductionExecutorDeps: (input: Parameters<typeof actual.createProductionExecutorDeps>[0]) => ({
      pageText: async () => null,
      nativePageText: async () => null,
      withRaster: async <T>(pageNumber: number, fn: (raster: { path: string; mimeType: string; pageNumber: number }) => Promise<T>) =>
        await fn({ path: path.join(rasterDir.path, `page-${pageNumber}.png`), mimeType: "image/png", pageNumber }),
      withCrop: async <T>(raster: { path: string; mimeType: string }, _box: unknown, fn: (crop: { path: string; mimeType: string }) => Promise<T>) =>
        await fn(raster),
      ocr: async () => { throw new Error("tesseract unavailable"); },
      label: async () => { throw new Error("labeler unavailable"); },
      vlm: async (args: { target: RoutingTarget; role: Assignment["role"]; raster: { path: string; mimeType: string }; pageNumber: number; signal?: AbortSignal }) =>
        await input.callVision(visionConfigForModel(input.selection, args.target.ref.modelUri!, 1, args.role),
          { imagePath: args.raster.path, mimeType: args.raster.mimeType, pageNumber: args.pageNumber }, args.signal),
      pageHeightPt: () => null,
      dispose: async () => undefined,
    }),
  };
});

import { VisionExtractStage, type VisionPageSkip } from "../stages/vision-extract.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { buildVisionPageFacts } from "../pipeline/page-facts.js";
import { MemoryVisionSpendBackend } from "../lib/vision-spend-guard.js";
import { HeuristicRouter } from "../routing/routers/heuristic.js";
import { groupAssignmentsByTarget } from "../routing/runtime.js";
import { BIG_BUDGET, makePage, testCatalog } from "../routing/testing.js";
import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";

const MODEL = "google/gemini-3.1-flash-lite";
const VISION = { target: "remote", modelUri: `llm://openrouter/${MODEL}`, maxPagesPerDocument: 1_000 } as const;
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;

const catalog = testCatalog();
const regionVlm = catalog.find((t) => t.kind === "hosted-vlm" && t.roles.includes("chart-data")) as RoutingTarget;
const tesseract = catalog.find((t) => t.id === "ocr:tesseract")!;
const estimate = { costUsd: 0.002, latencyMs: 1500, pPass: 0.9 };
const asg = (pageNumber: number, target: RoutingTarget, role: Assignment["role"], scope: Assignment["scope"] = { kind: "page" }): Assignment =>
  ({ pageNumber, scope, targetId: target.id, role, reason: "test", estimate, cascade: [] });

/**
 * Page 1: a region crop on a hosted VLM (executor). Pages 2-4: page-scope OCR that fails, so the
 * workspace model reads them as the fallback. Page 4 was already decided by a page task.
 */
async function routedPlan() {
  const base = await new HeuristicRouter({ documentId: "doc", runId: "run-1" }).plan([makePage({ pageNumber: 1 })], catalog, BIG_BUDGET, "cost-quality");
  const plan: RoutePlan = {
    ...base,
    mode: "active",
    assignments: [
      asg(1, regionVlm, "chart-data", { kind: "region", bbox: { x: 50, y: 400, width: 200, height: 100 } }),
      asg(2, tesseract, "extract-text"),
      asg(3, tesseract, "extract-text"),
      asg(4, tesseract, "extract-text"),
    ],
  };
  return { plan, execution: groupAssignmentsByTarget(plan, catalog), catalog };
}

function rejection(costCents = 2) {
  const error = new VisionOutputRejectedError("degenerate output after 2 attempts", [], 2_400, 640, costCents);
  error.route = { model: MODEL, provider: "openrouter" };
  return error;
}

function runState(pipeline: Record<string, unknown> = {}): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "vision-extract",
    pipeline: { vision: VISION, privacyMode: "standard", visionFallback: true, ...pipeline },
  } as unknown as WorkspaceRun, []);
  state.visionSpend = new MemoryVisionSpendBackend();
  return state;
}

describe("routed extraction under the vision guard", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "vision-routed-"));
    rasterDir.path = scratch;
    for (let page = 1; page <= 4; page += 1) await writeFile(path.join(scratch, `page-${page}.png`), "png");
    visionRuntime.execute.mockReset();
    // Page 3 reads; everything else is rejected after both attempts.
    visionRuntime.execute.mockImplementation(async ({ imagePath }: { imagePath: string }) => {
      if (!/page-3\.png$/.test(imagePath)) throw rejection();
      return {
        runtime: "openai-compatible", model: MODEL, prompt: "p", text: "page three read by vision", raw: "", costCents: 0.5,
        latencyMs: 1, inputTokens: 2_000, outputTokens: 400, usageSource: "provider", baseUrl: "https://openrouter.ai/api/v1",
        fallbackUsed: false, fallbackReason: null, provider: "openrouter",
      };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(scratch, { recursive: true, force: true });
  });

  function harness() {
    const rasters = {
      renderSelectedPages: vi.fn(async ({ pageNumbers }: { pageNumbers: number[] }) => pageNumbers.map((pageNumber) => ({
        pageNumber, artifactKey: `k/${pageNumber}`, artifactUri: `s3://bucket/k/${pageNumber}`, mimeType: "image/png",
        cacheHit: true, sizeBytes: 60_000, widthPx: null, heightPx: null,
      }))),
    };
    const storage = {
      downloadToTempFile: async (key: string) => {
        const dir = await mkdtemp(path.join(scratch, "download-"));
        const file = path.join(dir, `page-${key.split("/")[1]}.png`);
        await writeFile(file, "png");
        return file;
      },
      putJson: async () => undefined,
      uri: (key: string) => `s3://bucket/${key}`,
    };
    const stage = new VisionExtractStage({} as never, storage as never, CFG, rasters as never);
    const document = { id: "doc", userId: "user-1", filename: "upload.pdf", mimeType: "application/pdf", pageCount: 4 } as Document;
    const extractRouted = (stage as unknown as {
      extractRoutedPages(...a: unknown[]): Promise<{ outputs: Array<{ pageNumber: number }>; executorFailures: unknown[] }>;
    }).extractRoutedPages.bind(stage);
    return { stage, document, rasters, extractRouted };
  }

  it("records a rejected region call and its fallback once each, settles every reservation, and keeps each page's outcome", async () => {
    const { document, extractRouted } = harness();
    const state = runState();
    // A page task already stored page 4's outcome.
    state.distributedVisionPages.set("doc:4", { pageNumber: 4, outcome: "rejection-breaker", fallbackText: true });
    const skips = new Map<number, VisionPageSkip>();
    const result = await extractRouted(state, document, VISION, await routedPlan(), undefined, "runs/run-1/vision/doc.json", skips);

    expect(result.outputs.map((page) => page.pageNumber)).toEqual([3]);
    // Page 1's region and page 2's fallback were rejected: one rejected usage event each, with its cost.
    const rejected = state.usageLedger.snapshot().filter((event) => event.metadata?.outcome === "rejected");
    expect(rejected.map((event) => event.metadata?.pageNumber).sort()).toEqual([1, 2]);
    expect(rejected.every((event) => event.metadata?.providerCostCents === 2)).toBe(true);
    expect((state.visionSpend as MemoryVisionSpendBackend).inspect("run-1"))
      .toEqual({ costCents: 4.5, attemptedPages: 3, rejectedPages: 2, liveReservations: 0 });

    expect(Object.fromEntries([...skips].map(([page, skip]) => [page, skip.outcome])))
      .toEqual({ 1: "rejected", 2: "rejected", 4: "rejection-breaker" });
    const facts = buildVisionPageFacts({
      documentId: "doc", runId: "run-1", pageCount: 4, selected: [1, 2, 3, 4], processed: result.outputs, cap: 4, outcomes: skips,
    });
    // Without usable text a rejected page is a failure; the page task's guard stop stays a guard stop.
    expect(facts.map((fact) => fact.visionStatus)).toEqual(["failed", "failed", "extracted", "guarded"]);
  });

  it("a stopped guard refuses the region call and its fallback without a provider call, and reports why", async () => {
    const { document, rasters, extractRouted } = harness();
    const state = runState({ maxCostCents: 0.0001 });
    const skips = new Map<number, VisionPageSkip>();
    const result = await extractRouted(state, document, VISION, await routedPlan(), undefined, "runs/run-1/vision/doc.json", skips);

    expect(result.outputs).toEqual([]);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    // The fallback pages are refused before any render.
    expect(rasters.renderSelectedPages).not.toHaveBeenCalled();
    expect(Object.fromEntries([...skips].map(([page, skip]) => [page, skip.outcome])))
      .toEqual({ 1: "provider-budget", 2: "provider-budget", 3: "provider-budget", 4: "provider-budget" });
    const facts = buildVisionPageFacts({
      documentId: "doc", runId: "run-1", pageCount: 4, selected: [1, 2, 3, 4], processed: [], cap: 4, outcomes: skips,
    });
    expect(facts.map((fact) => fact.visionStatus)).toEqual(["guarded", "guarded", "guarded", "guarded"]);
    expect(state.usageLedger.snapshot().filter((event) => event.metric.startsWith("page-analysis"))).toEqual([]);
  });
});
