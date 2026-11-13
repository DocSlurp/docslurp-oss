/**
 * Chart export on the real routed path: `extractRoutedPages` -> the production executor deps' `vlm` -> the stage's
 * `exportVisual` hook -> `ChartExportSession.exportRouted` -> the generator, with a fake chart model client. Only the
 * raster/crop/text edges of the deps are stubbed (no poppler, no canonical document); `vlm` is the real one.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLABLE_UNIT_METRICS,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  resetPricingProviderForTests,
  type Assignment,
  type RoutePlan,
  type RoutingTarget,
} from "@docslurp/shared";

const visionRuntime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../tools/vision-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/vision-runtime.js")>();
  return { ...actual, executeVisionRuntime: visionRuntime.execute };
});
const rasterDir = vi.hoisted(() => ({ path: "" }));
vi.mock("../routing/executors/deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routing/executors/deps.js")>();
  return {
    ...actual,
    createProductionExecutorDeps: (input: Parameters<typeof actual.createProductionExecutorDeps>[0]) => {
      const real = actual.createProductionExecutorDeps(input);
      return {
        ...real,
        pageText: async () => null,
        nativePageText: async () => null,
        withRaster: async <T>(pageNumber: number, fn: (raster: { path: string; mimeType: string; pageNumber: number }) => Promise<T>) =>
          await fn({ path: path.join(rasterDir.path, `page-${pageNumber}.png`), mimeType: "image/png", pageNumber }),
        withCrop: async <T>(raster: { path: string; mimeType: string; pageNumber: number }, _box: unknown, fn: (crop: { path: string; mimeType: string; pageNumber: number }) => Promise<T>) =>
          await fn({ ...raster, path: raster.path.replace(/\.png$/, ".crop.png") }),
        pageHeightPt: () => null,
        dispose: async () => undefined,
      };
    },
  };
});

import { ChartExportSession } from "../chart-export/session.js";
import type { ChartModelRequest } from "../chart-export/types.js";
import { MemoryVisionAttemptBackend } from "../lib/vision-attempt-guard.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { HeuristicRouter } from "../routing/routers/heuristic.js";
import { groupAssignmentsByTarget } from "../routing/runtime.js";
import { BIG_BUDGET, makePage, testCatalog } from "../routing/testing.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import type { Config } from "../config.js";
import type { Document, ProjectRun } from "../models.js";

const MODEL = "google/gemini-3.1-flash-lite";
const VISION = { target: "remote", modelUri: `llm://openrouter/${MODEL}`, maxPagesPerDocument: 1_000 } as const;
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const BAR = { kind: "chart", chartType: "bar", title: "Bookings", series: [{ name: "Bookings", points: [{ x: "Q1", y: 4 }, { x: "Q2", y: 6 }] }], summary: "Bookings rise from 4 to 6." };

const catalog = testCatalog();
const regionVlm = catalog.find((t) => t.kind === "hosted-vlm" && t.roles.includes("chart-data")) as RoutingTarget;
const estimate = { costUsd: 0.002, latencyMs: 1500, pPass: 0.9 };

async function routedPlan() {
  const base = await new HeuristicRouter({ documentId: "doc", runId: "run-1" }).plan([makePage({ pageNumber: 1 })], catalog, BIG_BUDGET, "cost-quality");
  const assignment: Assignment = {
    pageNumber: 1, scope: { kind: "region", bbox: { x: 50, y: 400, width: 200, height: 100 } }, targetId: regionVlm.id, role: "chart-data", reason: "test", estimate, cascade: [],
  };
  const plan: RoutePlan = { ...base, mode: "active", assignments: [assignment] };
  return { plan, execution: groupAssignmentsByTarget(plan, catalog), catalog };
}

describe("chart export on the routed executor path (council round 2, detail M5)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "chart-routed-"));
    rasterDir.path = scratch;
    await writeFile(path.join(scratch, "page-1.png"), "png");
    visionRuntime.execute.mockReset();
    visionRuntime.execute.mockImplementation(async () => { throw new Error("the role's vision read must not run for an exported chart"); });
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    installTestPricing(DISTINCT_TEST_PRICING);
    vi.spyOn(await import("../routing/runtime.js"), "buildRuntimeCatalog").mockReturnValue({ targets: catalog, allTargets: catalog } as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetPricingProviderForTests();
    await rm(scratch, { recursive: true, force: true });
  });

  it("sends the chart crop to the generator instead of the role's read, merges the marked group and charges the read", async () => {
    const state = WorkflowState.create({
      id: "run-1", orgId: "org-1", projectId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "vision-extract",
      pipeline: { vision: VISION, privacyMode: "standard", visionFallback: true, chartExport: { tier: "models", formats: ["description", "csv"], diagrams: true } },
    } as unknown as ProjectRun, []);
    state.visionAttempts = new MemoryVisionAttemptBackend();
    const stage = new VisionExtractStage({} as never, { bucket: "bucket", uri: (k: string) => `s3://bucket/${k}` } as never, CFG, { renderSelectedPages: vi.fn(async () => []) } as never);
    const requests: ChartModelRequest[] = [];
    vi.spyOn(stage as unknown as { chartModelClient: () => unknown }, "chartModelClient").mockReturnValue({
      async complete(request: ChartModelRequest) {
        requests.push(request);
        return { text: JSON.stringify(BAR), model: MODEL, provider: "openrouter", inputTokens: 800, outputTokens: 120, costCents: 0.02, latencyMs: 5 };
      },
    });
    const document = { id: "doc", userId: "user-1", filename: "deck.pdf", mimeType: "application/pdf", pageCount: 1 } as Document;
    const internals = stage as unknown as {
      chartExportSession: (s: WorkflowState, d: Document) => ChartExportSession;
      extractRoutedPages(...a: unknown[]): Promise<{ outputs: Array<{ pageNumber: number; text: string; runtime: string }>; executorFailures: unknown[] }>;
    };
    const session = internals.chartExportSession(state, document);
    const result = await internals.extractRoutedPages.call(stage, state, document, VISION, await routedPlan(), undefined, "runs/run-1/vision/doc.json", new Map(), session);

    // One generator call on the crop (not the page), and no vision read of the same crop.
    expect(requests.map((r) => [r.purpose, path.basename(r.image.path)])).toEqual([["spec", "page-1.crop.png"]]);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect(result.executorFailures).toEqual([]);
    const page = result.outputs.find((o) => o.pageNumber === 1);
    expect(page?.text).toContain("Bookings rise from 4 to 6.");
    expect(page?.text).toMatch(new RegExp(`<!-- docslurp:visual p1-a0 ${session.markerNonce} -->`));
    expect(page?.text).toContain("```csv");
    expect(session.routedIds.has("p1-a0")).toBe(true);
    // The read was charged as it completed, before any end-of-document sweep.
    const charges = state.usageLedger.snapshot().filter((e) => e.metric === BILLABLE_UNIT_METRICS.chartExport);
    expect(charges.map((e) => e.id)).toEqual(["chart-export:run-1:doc:p1-a0"]);
  });
});
