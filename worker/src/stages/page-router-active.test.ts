import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENROUTER_VISION_MODEL, defaultPageRouterConfig, type Assignment, type PageRouterMode, type RoutePlan } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { HeuristicRouter } from "../routing/routers/heuristic.js";
import { buildRuntimeCatalog } from "../routing/runtime.js";
import { assemblePlan } from "../routing/planner.js";
import { BIG_BUDGET, makePage } from "../routing/testing.js";
import { RenderImagesStage } from "./render-images.js";
import { VisionExtractStage, type VisionPageOutput } from "./vision-extract.js";

vi.mock("../pipeline/checkpoints.js", () => ({
  runDocuments: async (documents: unknown[], _c: number, run: (doc: unknown) => Promise<void>) => {
    for (const document of documents) await run(document);
  },
  runDocumentStage: async (...args: unknown[]) => (args[5] as () => Promise<unknown>)(),
  completeDocumentPages: vi.fn(async () => undefined),
  skipCompletedPages: (_completed: Set<number>, pages: number[]) => pages,
  isCostCapExceeded: () => false,
  emitDocumentPageProgress: vi.fn(async () => undefined),
  DocumentStageError: class extends Error {},
}));

const document = { id: "doc", userId: "user", filename: "a.pdf", mimeType: "application/pdf", pageCount: 5, sourceKey: "a.pdf" } as Document;
const targets = buildRuntimeCatalog({ env: { OPENROUTER_API_KEY: "x" } as never }).allTargets;
const hostedVlms = targets.filter((t) => t.kind === "hosted-vlm" && t.ref.modelUri && t.roles.includes("extract-text"));

const asg = (pageNumber: number, targetId: string, role: Assignment["role"]): Assignment => ({
  pageNumber, scope: { kind: "page" }, targetId, role, reason: "test",
  estimate: { costUsd: 0.002, latencyMs: 1000, pPass: 0.9 }, cascade: [],
});

async function planWith(assignments: Assignment[], mode: "shadow" | "active" = "active"): Promise<RoutePlan> {
  const base = await new HeuristicRouter({ documentId: "doc", runId: "run" }).plan([makePage({ pageNumber: 1 })], targets, BIG_BUDGET, "cost-quality");
  return { ...base, mode, assignments };
}

function stateWith(plan: RoutePlan | null, mode: PageRouterMode | undefined, extra: Record<string, unknown> = {}) {
  const state = WorkflowState.create({
    id: "run", orgId: "org", spentCents: 0, artifacts: {}, stats: {},
    pipeline: {
      preserveImages: true, visionFallback: true, privacyMode: "standard", maxCostCents: null,
      vision: { modelUri: `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}` },
      // These execution tests deliberately exercise cost-only routing. Defaults are tested below.
      pageRouter: { ...defaultPageRouterConfig, marginFloor: 0, mode },
      ...extra,
    },
  } as unknown as WorkspaceRun, [document]);
  state.docConcurrency = 1;
  if (plan) state.artifactLedger.recordDocument("doc", "page-route-plan", "s3://bucket/user/run/page-route/doc.json");
  return state;
}

const storageFor = (plan: RoutePlan | null) => ({
  bucket: "bucket",
  getJson: vi.fn(async () => plan),
  putJson: vi.fn(async () => undefined),
  uri: (key: string) => `s3://bucket/${key}`,
}) as unknown as ArtifactStore & { putJson: ReturnType<typeof vi.fn> };

describe("render-images with the page router", () => {
  async function render(plan: RoutePlan | null, mode: PageRouterMode | undefined, env: PageRouterMode | undefined) {
    const renderSelectedPages = vi.fn(async () => []);
    const stage = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache, storageFor(plan), { pageRouterMode: env });
    vi.spyOn(stage as unknown as { loadRasterRequest(): Promise<null> }, "loadRasterRequest").mockResolvedValue(null);
    await stage.run(stateWith(plan, mode));
    return renderSelectedPages;
  }

  it("active: renders only the pages whose plan needs pixels", async () => {
    const plan = await planWith([
      asg(1, "native:accept-text-layer", "accept-text"),
      asg(2, hostedVlms[0]!.id, "extract-text"),
      asg(4, hostedVlms[0]!.id, "chart-data"),
    ]);
    const spy = await render(plan, "active", "active");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [2, 4] }));
  });

  it("shadow, off and an unset env keep the classification path (no pages from the plan)", async () => {
    const plan = await planWith([asg(2, hostedVlms[0]!.id, "extract-text")], "shadow");
    for (const [mode, env] of [["shadow", "shadow"], ["active", "shadow"], ["active", "off"], ["active", undefined], [undefined, "active"]] as const) {
      const spy = await render(plan, mode, env);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: [] }));
    }
  });
});

describe("vision-extract with the page router", () => {
  const cfg = { visionDensityThreshold: 0.25, pageRouterMode: "active" } as Config;
  const make = (plan: RoutePlan | null, mode: PageRouterMode | undefined = "active", config: Config = cfg, extra: Record<string, unknown> = {}) =>
    ({ stage: new VisionExtractStage({} as CommandRunner, storageFor(plan), config, {} as never), state: stateWith(plan, mode, extra) });

  const out = (pageNumber: number, model: string): VisionPageOutput => ({
    pageNumber, runtime: "openai-compatible", model, prompt: "p", baseUrl: null, latencyMs: 900, inputTokens: 10, outputTokens: 5,
    usageSource: "provider", fallbackUsed: false, fallbackReason: null, text: "t", costCents: 0.25,
  });

  it("active: runs each target group on its plan model, skips accept-text pages and computes the validation row", async () => {
    const [a, b] = hostedVlms as [typeof hostedVlms[number], typeof hostedVlms[number]];
    const plan = await planWith([
      asg(1, "native:accept-text-layer", "accept-text"),
      asg(2, a.id, "extract-text"),
      asg(3, b.id, "chart-data"),
    ]);
    const { stage, state } = make(plan);
    const internals = stage as unknown as {
      loadRoutedExecution(s: WorkflowState, d: Document): Promise<{ plan: RoutePlan; execution: { groups: Array<{ pages: number[] }> } } | null>;
      routedSelection(r: unknown): { needed: boolean; selectedPages: number[]; reason: string };
      extractRoutedPages(...args: unknown[]): Promise<{ outputs: VisionPageOutput[] }>;
      extractVisionPagesFromCache: (...args: unknown[]) => Promise<VisionPageOutput[]>;
      recordRoutedValidation(...args: unknown[]): Promise<{ chunk: { actual: { costUsd: number } } }>;
    };
    const calls: Array<{ uri: string; pages: number[] }> = [];
    vi.spyOn(internals, "extractVisionPagesFromCache").mockImplementation(async (...args: unknown[]) => {
      const [, , vision, pages, , , sink] = args as [unknown, unknown, { modelUri: string }, number[], unknown, unknown, (e: unknown, p: number) => void];
      calls.push({ uri: vision.modelUri, pages });
      for (const p of pages) sink({ costCents: 0.3 }, p);
      return pages.map((p) => out(p, vision.modelUri));
    });

    const routed = await internals.loadRoutedExecution(state, document);
    expect(routed).not.toBeNull();
    expect(internals.routedSelection(routed)).toMatchObject({ needed: true, selectedPages: [2, 3], reason: "page-router-plan" });
    const result = await internals.extractRoutedPages(state, document, state.run.pipeline.vision, routed, undefined, "user/run/vision/doc.json");
    expect(calls).toEqual([{ uri: a.ref.modelUri, pages: [2] }, { uri: b.ref.modelUri, pages: [3] }]);
    expect(result.outputs.map((o) => o.pageNumber)).toEqual([2, 3]);

    const storage = (stage as unknown as { storage: { putJson: ReturnType<typeof vi.fn> } }).storage;
    const validation = await internals.recordRoutedValidation(state, document, routed!.plan, routed!.execution, result, "user/run/vision/doc.json");
    expect(validation.chunk.actual.costUsd).toBeCloseTo(0.006 + routed!.plan.triage.costUsd, 10);
    const row = state.pendingPerformance.find((e) => e.metric === "page-route-validation")!;
    expect(row).toMatchObject({ scope: "document", documentId: "doc", unit: "usd" });
    expect((row.metadata as { assignments: unknown[] }).assignments).toHaveLength(3);
    expect(storage.putJson).toHaveBeenCalledWith("user/run/page-route/doc.validation.json", expect.objectContaining({ runId: "run" }));
  });

  it("does not route in off/shadow, without a plan, or when the workspace forces all pages", async () => {
    const plan = await planWith([asg(2, hostedVlms[0]!.id, "extract-text")]);
    const shadowPlan = { ...plan, mode: "shadow" as const };
    const load = (s: VisionExtractStage, st: WorkflowState) =>
      (s as unknown as { loadRoutedExecution(a: WorkflowState, b: Document): Promise<unknown> }).loadRoutedExecution(st, document);

    let { stage, state } = make(plan, "active", { ...cfg, pageRouterMode: "off" } as Config);
    expect(await load(stage, state)).toBeNull();
    ({ stage, state } = make(plan, "shadow"));
    expect(await load(stage, state)).toBeNull();
    ({ stage, state } = make(shadowPlan));
    expect(await load(stage, state)).toBeNull();
    ({ stage, state } = make(null));
    expect(await load(stage, state)).toBeNull();
    ({ stage, state } = make(plan));
    (state.run.pipeline as { quality: string }).quality = "good";
    expect(await load(stage, state)).toBeNull();
    ({ stage, state } = make(plan));
    (state.run.pipeline as { quality: string }).quality = "fast";
    expect(await load(stage, state)).toBeNull();
  });

  it("fans an active plan out as one task per single-group page on that group's model", async () => {
    const [a, b] = hostedVlms as [typeof hostedVlms[number], typeof hostedVlms[number]];
    const plan = await planWith([
      asg(1, "native:accept-text-layer", "accept-text"),
      asg(2, a.id, "extract-text"),
      asg(3, b.id, "chart-data"),
      asg(4, a.id, "extract-text"),
      asg(4, b.id, "table"),
      asg(5, "ocr:tesseract", "ocr"),
    ]);
    const { stage, state } = make(plan);
    vi.spyOn(stage as unknown as { visionAllowed(): Promise<boolean> }, "visionAllowed").mockResolvedValue(true);
    const tasks = await stage.planPageTasks(state);
    // Page 4 is served by two groups (cache is keyed by page) and page 5 by a local executor: both stay sequential.
    expect(tasks.map((t) => [t.pageNumber, t.vision.modelUri])).toEqual([[2, a.ref.modelUri], [3, b.ref.modelUri]]);
    expect(tasks.every((t) => t.pageCount === 2 && t.documentId === "doc")).toBe(true);
  });

  it("keeps active plans sequential under a cost cap, a single task, or a non-standard privacy mode", async () => {
    const plan = await planWith([asg(2, hostedVlms[0]!.id, "extract-text"), asg(3, hostedVlms[0]!.id, "extract-text")]);
    const spy = (s: VisionExtractStage) => vi.spyOn(s as unknown as { visionAllowed(): Promise<boolean> }, "visionAllowed").mockResolvedValue(true);
    let { stage, state } = make(plan, "active", cfg, { maxCostCents: 100 });
    spy(stage);
    expect(await stage.planPageTasks(state)).toEqual([]);
    ({ stage, state } = make(plan, "active", cfg, { privacyMode: "strict-privacy" }));
    spy(stage);
    expect(await stage.planPageTasks(state)).toEqual([]);
    const single = await planWith([asg(2, hostedVlms[0]!.id, "extract-text")]);
    ({ stage, state } = make(single));
    spy(stage);
    expect(await stage.planPageTasks(state)).toEqual([]);
  });
});

describe("default positive margin floor fails closed", () => {
  it.each(["extract-text", "math", "table"] as const)("refuses a budget-stripped %s plan before render or vision", async (role) => {
    const base = await planWith([asg(1, hostedVlms[0]!.id, role)]);
    // Exercise the real guard with the default .5 floor, rather than hand-editing assignments.
    const assignment = asg(1, hostedVlms[0]!.id, role);
    const primary = { targetId: assignment.targetId, costUsd: 0.002, billedUsd: 0, latencyMs: 1000, latencyP95Ms: 2000, pPass: 0.9, pPassLowerBound: 0.9 };
    const { plan, guard } = assemblePlan({
      documentId: "doc", runId: "run", routerId: base.routerId, routerKind: base.routerKind,
      mode: "active", objective: "cost-quality", policyVersion: base.policyVersion,
      planned: [{ assignment, billedUsd: 0, latencyP95Ms: 2000, primary, alternatives: [] }],
      budget: { limitUsd: 1, marginFloor: defaultPageRouterConfig.marginFloor }, catalog: targets,
    });
    expect(guard.deferred).toHaveLength(1);
    expect(plan.assignments).toEqual([]);
    const state = stateWith(plan, "active", { pageRouter: { ...defaultPageRouterConfig, mode: "active" } });
    const renderSelectedPages = vi.fn(async () => []);
    const render = new RenderImagesStage({ renderSelectedPages } as unknown as PdfRasterCache, storageFor(plan), { pageRouterMode: "active" });
    vi.spyOn(render as unknown as { loadRasterRequest(): Promise<null> }, "loadRasterRequest").mockResolvedValue(null);
    await expect(render.run(state)).rejects.toThrow("page-router-incomplete");
    expect(renderSelectedPages).not.toHaveBeenCalled();
    const vision = new VisionExtractStage({} as CommandRunner, storageFor(plan), { pageRouterMode: "active" } as Config, {} as never);
    await expect((vision as unknown as { loadRoutedExecution(s: WorkflowState, d: Document): Promise<unknown> }).loadRoutedExecution(state, document)).rejects.toThrow("page-router-incomplete");
    expect(state.usageLedger.pendingCount).toBe(0);
    // A resumed run with a zero floor must also reject the already stripped artifact.
    state.run.pipeline.pageRouter!.marginFloor = 0;
    plan.chunkEstimate.budget.marginFloor = 0;
    await expect(render.run(state)).rejects.toThrow("budget guard removed content");
    await expect((vision as unknown as { loadRoutedExecution(s: WorkflowState, d: Document): Promise<unknown> }).loadRoutedExecution(state, document)).rejects.toThrow("budget guard removed content");
    expect(state.usageLedger.pendingCount).toBe(0);
  });
});
