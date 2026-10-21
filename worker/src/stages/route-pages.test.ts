import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionModelCatalog,
  defaultPageRouterConfig,
  routePlanSchema,
  type PageRouterConfig,
  type PageRouterMode,
} from "@docslurp/shared";

import { WorkflowState } from "../pipeline/pipeline.js";
import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";
import type { RoutingLayoutObserver } from "../layout/routing-observer.js";
import type { PdfRasterCache } from "../pipeline/pdf-asset-cache.js";
import type { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import type { ArtifactStore } from "../tools/storage.js";
import { DecisionRequestError, type DecisionAnswer, type DecisionClient, type DecisionQuestion } from "../routing/decision-client.js";
import { DecisionModelHealthHistory, DecisionModelHealthRegistry } from "../routing/health/index.js";
import { loadRuntimePolicyPack } from "../routing/runtime.js";
import { testCatalog } from "../routing/testing.js";
import { RoutePagesStage, spreadSample } from "./route-pages.js";

vi.mock("../pipeline/checkpoints.js", () => ({
  runDocuments: async (documents: unknown[], _concurrency: number, run: (doc: unknown) => Promise<void>) => {
    for (const document of documents) await run(document);
  },
  runDocumentStage: async (...args: unknown[]) => {
    const result = await (args[5] as () => Promise<{ artifactUri?: string }>)();
    (args[0] as WorkflowState).artifactLedger.record(args[3] as string, result.artifactUri);
  },
  runSpentCents: (state: WorkflowState) => state.run.spentCents + state.usageLedger.pendingBillableCents,
  isCostCapExceeded: (state: WorkflowState) => {
    const cap = state.run.pipeline.maxCostCents;
    return !!cap && cap > 0 && state.run.spentCents + state.usageLedger.pendingBillableCents >= cap;
  },
}));

const row = (pageNumber: number, extra: Record<string, unknown> = {}) => ({
  pageNumber, pageCount: 2, charCount: 2400, wordCount: 412, textCoverage: 0.5, fontCount: 3,
  unmappedGlyphRatio: 0, mathGlyphRatio: 0, tableRuleScore: 0, imageCoverage: 0, largestImageCoverage: 0,
  fullPageImage: false, vectorDrawingCount: 0, uncoveredVectorRatio: 0, garbled: false, textLayerStatus: "ok",
  imageCount: 0, textFacts: { wordCount: 412, imageCount: 0, imageCoverage: 0, textLayerStatus: "ok" }, images: [],
  smallestFontPt: 9, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 3, ...extra,
});
const chartRow = row(2, {
  wordCount: 60, imageCount: 1, imageCoverage: 0.4, largestImageCoverage: 0.4,
  textFacts: { wordCount: 60, imageCount: 1, imageCoverage: 0.4, textLayerStatus: "ok" },
  images: [{ bbox: [10, 10, 300, 200], coverage: 0.4 }],
});
const probe = vi.fn(async () => [row(1), chartRow].map((r) => JSON.stringify(r)).join("\n"));

const document = { id: "doc", userId: "user", filename: "a.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "a.pdf" } as Document;
const sources = { get: async () => ({ path: "/tmp/a.pdf", sha256: "x", sizeBytes: 1, cacheHit: true }) } as unknown as PdfSourceCache;

function makeStorage() {
  return {
    bucket: "bucket",
    putJson: vi.fn(async () => undefined),
    getJson: vi.fn(async () => null),
    uri: (key: string) => `s3://bucket/${key}`,
  } as unknown as ArtifactStore & { putJson: ReturnType<typeof vi.fn> };
}

function makeState(options: { mode?: PageRouterMode; pageRouter?: Partial<PageRouterConfig>; privacyMode?: string; maxCostCents?: number | null } = {}) {
  const state = WorkflowState.create({
    id: "run", orgId: "org", spentCents: 0, artifacts: {}, stats: {},
    pipeline: {
      privacyMode: options.privacyMode ?? "standard",
      maxCostCents: options.maxCostCents ?? null,
      pageRouter: { ...defaultPageRouterConfig, router: "decision-model", triageFormat: "text-state", ...options.pageRouter, mode: options.mode },
    },
  } as unknown as WorkspaceRun, [document]);
  state.docConcurrency = 1;
  return state;
}

/** Answers a canary request like a healthy model; null when the request is not the canary. */
function canaryAnswers(questions: Record<string, DecisionQuestion>): Record<string, DecisionAnswer> | null {
  if (!("mentions_cat" in questions)) return null;
  return {
    has_math: { type: "noul", noul: 0.95 },
    mentions_cat: { type: "noul", noul: 0.02 },
    subject: { type: "choice", choice: "mathematics", confidence: 0.9, probabilities: { mathematics: 0.9, animals: 0.05, cooking: 0.05 } },
  };
}

function fakeClient() {
  const ask = vi.fn(async (model, _state, questions: Record<string, DecisionQuestion>) => ({
    answers: canaryAnswers(questions) ?? Object.fromEntries(Object.entries(questions).map(([key, q]) => [
      key,
      q.type === "noul"
        ? ({ type: "noul", noul: key.endsWith("trust_text_layer") ? 0.9 : 0.1 } as DecisionAnswer)
        : ({ type: "choice", choice: "chart-graph", confidence: 0.9, probabilities: { "chart-graph": 0.9, none: 0.1 } } as DecisionAnswer),
    ])),
    usage: { inputTokens: 1200, outputTokens: 0 },
    latencyMs: 4,
    costCents: 0.0024,
    model: model.id,
    provider: "perplexity",
  }));
  return { ask } satisfies DecisionClient & { ask: unknown };
}

const decisionModels = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true, OPENROUTER_API_KEY: true } }).models;
const catalog = () => ({ targets: testCatalog(), allTargets: testCatalog(), decisionModels });
const envCfg = (mode?: PageRouterMode) => ({ pageRouterMode: mode }) as Config;

beforeEach(() => probe.mockClear());

const fitted = { decisionModel: "cloudflare/clef-flash" } as const;
const health = () => new DecisionModelHealthRegistry();

describe("RoutePagesStage", () => {
  it("is a no-op when the env ceiling is off, even if the workspace opted in", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "active" });
    await new RoutePagesStage(storage, envCfg("off"), sources, undefined, { probe, catalog }).run(state);
    expect(probe).not.toHaveBeenCalled();
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(state.pendingPerformance).toEqual([]);
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("is a no-op when the workspace has not opted in", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: undefined });
    await new RoutePagesStage(storage, envCfg("active"), sources, undefined, { probe, catalog }).run(state);
    expect(probe).not.toHaveBeenCalled();
    expect(storage.putJson).not.toHaveBeenCalled();
  });

  it("table gate shadow logs ruled-grid-or-crop decisions without changing the plan; off by default", async () => {
    const tableProbe = vi.fn(async () => [row(1, { tableRuleScore: 3 }), row(2)].map((r) => JSON.stringify(r)).join("\n"));
    const spans = [["Item", 5, 5], ["Cost", 105, 5], ["Tea", 5, 25], ["12", 105, 25]].map(([text, x, y]) => ({
      text, bbox: [x, y, (x as number) + 20, (y as number) + 10], font: "", size: 10, renderMode: 0, invisible: false, unmapped: 0,
    }));
    const opened: string[] = [];
    const openNativePdf = vi.fn(async (pdfPath: string) => {
      opened.push(pdfPath);
      return {
        pageCount: async () => 2,
        metadata: async () => ({}),
        close: async () => undefined,
        page: () => ({
          tables: async (o?: { strategy?: string }) => (o?.strategy === "text" ? [{ bbox: [0, 0, 200, 40], rows: [["Item", "Cost"], ["Tea", "12"]] }] : []),
          spans: async () => spans,
        }),
      } as never;
    });
    const run = async (tableGate?: "off" | "shadow") => {
      const storage = makeStorage();
      const state = makeState({ mode: "shadow", pageRouter: { router: "baseline" } });
      await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
        probe: tableProbe, catalog, openNativePdf, ...(tableGate ? { tableGate } : {}),
      }).run(state);
      return { plan: routePlanSchema.parse(storage.putJson.mock.calls[0]![1]), state };
    };
    const off = await run();
    expect(openNativePdf).not.toHaveBeenCalled();
    expect(off.state.pendingPerformance.some((e) => e.metric === "page-route-table-gate")).toBe(false);

    const shadow = await run("shadow");
    expect(opened).toEqual(["/tmp/a.pdf"]);
    expect(shadow.plan.assignments).toEqual(off.plan.assignments);
    const rows = shadow.state.pendingPerformance.filter((e) => e.metric === "page-route-table-gate");
    expect(rows.map((r) => r.pageNumber)).toEqual([1]);
    expect(rows[0]!.metadata).toMatchObject({ mode: "shadow", rule: "ruled-grid-or-crop", accepted: 0, escalated: 1 });
  });

  it("table gate shadow fails open when the native engine is unavailable", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "shadow", pageRouter: { router: "baseline" } });
    await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
      probe: vi.fn(async () => JSON.stringify(row(1, { tableRuleScore: 3 }))), catalog, tableGate: "shadow", openNativePdf: async () => null,
    }).run(state);
    expect(storage.putJson).toHaveBeenCalledTimes(1);
    expect(state.pendingPerformance.some((e) => e.metric === "page-route-error")).toBe(false);
    expect(state.pendingPerformance.some((e) => e.metric === "page-route-table-gate")).toBe(false);
  });

  it("shadow writes the plan artifact, per-page decision rows and one chunk estimate, and records decision usage", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "shadow", pageRouter: fitted });
    const client = fakeClient();
    await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
      probe, catalog, health: health(), decisionClient: ({ onUsage }) => ({
        async ask(model, s, q) {
          const result = await client.ask(model, s, q);
          onUsage(model, result);
          return result;
        },
      }),
    }).run(state);

    expect(storage.putJson).toHaveBeenCalledTimes(1);
    const [key, written] = storage.putJson.mock.calls[0]!;
    expect(key).toBe("user/run/page-route/doc.json");
    const plan = routePlanSchema.parse(written);
    expect(plan).toMatchObject({ mode: "shadow", documentId: "doc", runId: "run", routerKind: "decision-model" });
    expect(plan.triage.ran).toBe(true);
    expect(state.artifactLedger.readDocument("doc", "page-route-plan")).toBe("s3://bucket/user/run/page-route/doc.json");

    const decisions = state.pendingPerformance.filter((e) => e.metric === "page-route-decision");
    expect(decisions.map((e) => e.pageNumber)).toEqual([1, 2]);
    expect(decisions[1]!.metadata).toMatchObject({
      routerId: plan.routerId,
      mode: "shadow",
      assignments: expect.arrayContaining([expect.objectContaining({ role: expect.any(String), targetId: expect.any(String) })]),
      estimates: expect.objectContaining({ costUsd: expect.any(Number) }),
      chunkEstimate: expect.objectContaining({ totalCostUsd: expect.any(Number) }),
    });
    const chunk = state.pendingPerformance.filter((e) => e.metric === "page-route-chunk-estimate");
    expect(chunk).toHaveLength(1);
    expect(chunk[0]).toMatchObject({ scope: "document", documentId: "doc", unit: "usd" });
    const timing = state.pendingPerformance.filter((e) => e.metric === "page-route-timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.metadata).toMatchObject({
      pages: 2,
      probeMs: expect.any(Number),
      triageMs: expect.any(Number),
      planningMs: expect.any(Number),
      perPageMs: { probe: expect.any(Number), triage: expect.any(Number), planning: expect.any(Number), total: expect.any(Number) },
    });
    expect((decisions[0]!.metadata as { timing: unknown }).timing).toMatchObject({ total: expect.any(Number) });
    expect((chunk[0]!.metadata as { timing: { triageMs: number } }).timing.triageMs).toBeGreaterThanOrEqual(0);

    const usage = state.usageLedger.snapshot();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.map((e) => e.metric).sort()).toEqual(["page-route-decision", "page-route-decision-canary"]);
    expect(decisions[1]!.metadata).toMatchObject({ decisionServedBy: "cloudflare/clef-flash", decisionChain: [{ model: "cloudflare/clef-flash", outcome: "served" }] });
    expect(state.usageLedger.pendingBillableCents).toBeGreaterThan(0);
  });

  it("does not touch rasters, vision selection or other artifacts in shadow", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "shadow", pageRouter: { router: "heuristic" } });
    await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, { probe, catalog }).run(state);
    // Only the plan slot is written; nothing for images/vision/classification.
    expect(Object.keys(state.artifactLedger.all())).toEqual(["doc:page-route-plan"]);
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("falls back to the baseline router without calling the decision model once the cost cap is reached", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "shadow", maxCostCents: 1 });
    state.run.spentCents = 5;
    const ask = vi.fn();
    await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
      probe, catalog, decisionClient: () => ({ ask }) as unknown as DecisionClient,
    }).run(state);
    expect(ask).not.toHaveBeenCalled();
    const plan = routePlanSchema.parse(storage.putJson.mock.calls[0]![1]);
    expect(plan.routerKind).toBe("baseline");
    const note = state.pendingPerformance.find((e) => e.metric === "page-route-decision")!.metadata as Record<string, unknown>;
    expect(note.routerNote).toBe("decision-model-skipped:cost-cap");
    expect(plan.chunkEstimate.budget.limitUsd).toBe(0);
  });

  it("never offers a hosted decision model under a local-only privacy mode", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "shadow", privacyMode: "local-only" });
    const ask = vi.fn();
    await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
      probe,
      catalog: () => ({ targets: testCatalog().filter((t) => t.availability.privacyClass !== "hosted"), allTargets: testCatalog(), decisionModels: [] }),
      decisionClient: () => ({ ask }) as unknown as DecisionClient,
    }).run(state);
    expect(ask).not.toHaveBeenCalled();
    const plan = routePlanSchema.parse(storage.putJson.mock.calls[0]![1]);
    expect(plan.routerKind).toBe("baseline");
    expect(plan.assignments.every((a) => !a.targetId.startsWith("vlm:"))).toBe(true);
  });

  it("fails open: a probe error records page-route-error and writes no plan", async () => {
    const storage = makeStorage();
    const state = makeState({ mode: "active", pageRouter: { router: "heuristic" } });
    await new RoutePagesStage(storage, envCfg("active"), sources, undefined, {
      probe: async () => { throw new Error("probe exploded"); }, catalog,
    }).run(state);
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(state.pendingPerformance.map((e) => e.metric)).toEqual(["page-route-error"]);
    expect(state.artifactLedger.readDocument("doc", "page-route-plan")).toBeUndefined();
  });

  describe("decision-model chain", () => {
    const ask = (impl: (questions: Record<string, DecisionQuestion>, modelId: string) => Record<string, DecisionAnswer> | Error) =>
      vi.fn(async (model: { id: string }, _state: unknown, questions: Record<string, DecisionQuestion>) => {
        const out = impl(questions, model.id);
        if (out instanceof Error) throw out;
        return { answers: out, usage: { inputTokens: 100, outputTokens: 0 }, latencyMs: 3, costCents: 0.001, model: model.id, provider: "openrouter" };
      });
    const run = async (askFn: ReturnType<typeof ask>, pageRouter: Partial<PageRouterConfig>, reg = health(), extra: Partial<ConstructorParameters<typeof RoutePagesStage>[4]> = {}) => {
      const storage = makeStorage();
      const state = makeState({ mode: "shadow", pageRouter });
      await new RoutePagesStage(storage, envCfg("shadow"), sources, undefined, {
        probe, catalog, health: reg, healthHistory: new DecisionModelHealthHistory(), ...extra,
        decisionClient: ({ onUsage }) => ({
          async ask(model, s, q) {
            const result = await askFn(model, s, q);
            onUsage(model, result as never);
            return result as never;
          },
        }),
      }).run(state);
      return { state, plan: routePlanSchema.parse(storage.putJson.mock.calls[0]![1]), reg };
    };
    const triageAnswers = (q: Record<string, DecisionQuestion>): Record<string, DecisionAnswer> =>
      Object.fromEntries(Object.entries(q).map(([key, qq]) => [
        key,
        qq.type === "noul"
          ? ({ type: "noul", noul: key.endsWith("trust_text_layer") ? 0.9 : 0.1 + (key.length % 5) * 0.1 } as DecisionAnswer)
          : ({ type: "choice", choice: "chart-graph", confidence: 0.9, probabilities: { "chart-graph": 0.9, none: 0.1 } } as DecisionAnswer),
      ]));

    it("falls back to the baseline router when the model degraded to a constant answer, and records why", async () => {
      const constant = ask((q) => Object.fromEntries(Object.entries(q).map(([k, qq]) => [
        k, qq.type === "noul" ? ({ type: "noul", noul: 0.29637396196437554 } as DecisionAnswer)
          : ({ type: "choice", choice: "mathematics", confidence: 0.3, probabilities: { mathematics: 0.3, animals: 0.3, cooking: 0.3 } } as DecisionAnswer)])));
      const { state, plan, reg } = await run(constant, fitted);
      expect(plan.routerKind).toBe("baseline");
      expect(plan.triage.ran).toBe(false);
      expect(plan.triage.skippedReason).toMatch(/decision-chain-exhausted: .*cloudflare\/clef-flash:failed\(.*degenerate/);
      expect(plan.decisionModelCalls.length).toBe(0); // only the canary was billed, and it failed before any triage call
      expect(reg.status("cloudflare/clef-flash")?.healthy).toBe(false);
      const meta = state.pendingPerformance.find((e) => e.metric === "page-route-decision")!.metadata as Record<string, unknown>;
      expect(meta.decisionServedBy).toBe("baseline");
      expect(meta.decisionChain).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "failed" })]));
      expect(state.usageLedger.snapshot().map((e) => e.metric)).toEqual(["page-route-decision-canary"]);
    });

    it("skips models the pack has no calibrations for and serves from the first calibrated healthy model", async () => {
      const fn = ask((q) => canaryAnswers(q) ?? triageAnswers(q));
      const { plan } = await run(fn, { decisionModel: ["perplexity/pplx-decider-v1.1-27b", "cloudflare/clef-flash"] });
      expect(plan.routerKind).toBe("decision-model");
      expect(plan.triage.decisionModel).toBe("cloudflare/clef-flash");
      const models = new Set(fn.mock.calls.map((c) => c[0].id));
      expect(models).toEqual(new Set(["cloudflare/clef-flash"]));
    });

    it("quarantines the Perplexity decider behind the multi-day health history even when its canary passes", async () => {
      const base = loadRuntimePolicyPack("decision-model");
      const pplx = "perplexity/pplx-decider-v1.1-27b";
      const clef = base.calibrations.filter((c) => c.decisionModel === "cloudflare/clef-flash");
      const policyPack = { ...base, calibrations: [...base.calibrations, ...clef.map((c) => ({ ...c, decisionModel: pplx }))] };
      const fn = ask((q) => canaryAnswers(q) ?? triageAnswers(q));
      const { plan } = await run(fn, { decisionModel: [pplx, "cloudflare/clef-flash"] }, health(), { policyPack });
      expect(plan.triage.decisionModel).toBe("cloudflare/clef-flash");
      // pplx answered its canary (healthy), but one clean day is not three: it never saw a triage question.
      const pplxCalls = fn.mock.calls.filter((c) => c[0].id === pplx);
      expect(pplxCalls.length).toBeGreaterThan(0);
      expect(pplxCalls.every((c) => "mentions_cat" in c[2])).toBe(true);
    });

    it("accepts a single string for backward compatibility", async () => {
      const fn = ask((q) => canaryAnswers(q) ?? triageAnswers(q));
      const { plan } = await run(fn, { decisionModel: "cloudflare/clef-flash" });
      expect(plan.triage.decisionModel).toBe("cloudflare/clef-flash");
    });

    it("canaries a model once per TTL across documents", async () => {
      const fn = ask((q) => canaryAnswers(q) ?? triageAnswers(q));
      const reg = health();
      await run(fn, fitted, reg);
      await run(fn, fitted, reg);
      const canaries = fn.mock.calls.filter((c) => "mentions_cat" in c[2]);
      expect(canaries).toHaveLength(1);
    });

    it("falls back to baseline on a 5xx from the canary and does not re-probe within the backoff", async () => {
      const fn = ask(() => new DecisionRequestError("cloudflare/clef-flash returned 503", 503));
      const reg = health();
      const first = await run(fn, fitted, reg);
      expect(first.plan.routerKind).toBe("baseline");
      await run(fn, fitted, reg);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});


describe("spreadSample", () => {
  it("covers every position band deterministically per seed", () => {
    const pool = Array.from({ length: 100 }, (_, i) => i);
    const picked = spreadSample(pool, 4, "doc-a");
    expect(picked.map((i) => Math.floor(i / 25))).toEqual([0, 1, 2, 3]);
    expect(spreadSample(pool, 4, "doc-a")).toEqual(picked);
    expect(spreadSample(pool, 0, "doc-a")).toEqual([]);
    expect(spreadSample([7], 3, "doc-a")).toEqual([7]);
  });
});

describe("layout shadow integration", () => {
  type Observer = Pick<RoutingLayoutObserver, "config" | "observe" | "hasCapacity">;
  const result = {
    schemaVersion: 1 as const, inferenceProfileSha256: "b".repeat(64), model: { id: "tiny", revision: "pinned" }, device: "cpu" as const,
    image: { width: 100, height: 200 }, coordinateSpace: "normalized-source" as const,
    supportedLabels: [], regions: [],
  };
  function fixtures(options: { hit?: boolean; maxPages?: number; timeoutMs?: number; healthy?: boolean; hourlyCostUsd?: number; auditPages?: number } = {}) {
    const storage = Object.assign(makeStorage(), { getBytes: vi.fn(async () => Buffer.from("raster")) });
    const observer: Observer = {
      config: { endpoint: "http://127.0.0.1:8080/layout", expectedModelId: "tiny", expectedRevision: "pinned",
        expectedArtifactSha256: "a".repeat(64), expectedInferenceProfileSha256: "b".repeat(64), device: "cpu", maxPages: options.maxPages ?? 1,
        timeoutMs: options.timeoutMs ?? 2000, maxBytes: 1024, concurrency: 1, queueCapacity: 8, queueMaxBytes: 1 << 20,
        auditPages: options.auditPages ?? 0, hourlyCostUsd: options.hourlyCostUsd ?? null },
      hasCapacity: vi.fn(() => true),
      observe: vi.fn(async ({ onRequest, payload }) => {
        onRequest?.({ inferenceKey: "request-1", inputBytes: payload.length });
        return { result, cacheHit: false, elapsedMs: 1, inputBytes: payload.length, inferencePerformed: true, inferenceKey: "request-1" };
      }),
    };
    const renderSelectedPages = vi.fn<PdfRasterCache["renderSelectedPages"]>(async (args) => {
      const pageNumber = args.pageNumbers[0]!;
      if (!options.hit) await args.onRenderedPage?.({ pageNumber, artifactKey: `raster-${pageNumber}`, bytes: Buffer.from("raster"), mimeType: "image/png", dpi: 150, engine: "pdftoppm" });
      return [{ pageNumber, artifactKey: `raster-${pageNumber}`, artifactUri: `s3://bucket/raster-${pageNumber}`,
        widthPx: null, heightPx: null, sizeBytes: 6, cacheHit: !!options.hit, mimeType: "image/png", dpi: 150, engine: "pdftoppm" }];
    });
    const rows = options.healthy ? [row(1), row(2), row(3)] : [row(1), ...[2, 3].map((n) => row(n, {
      charCount: 0, wordCount: 0, textCoverage: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1,
      fullPageImage: true, textLayerStatus: "absent", textFacts: { wordCount: 0, imageCount: 1, imageCoverage: 1, textLayerStatus: "absent" },
      images: [{ bbox: [0, 0, 612, 792], coverage: 1 }],
    }))];
    const localProbe = vi.fn(async () => rows.map((r) => JSON.stringify(r)).join("\n"));
    const state = makeState({ mode: "shadow", pageRouter: { router: "baseline" } });
    const run = (enabled = true, signal?: AbortSignal) => new RoutePagesStage(storage, envCfg("shadow"), sources, undefined,
      { probe: localProbe, catalog, ...(enabled ? { layoutObserver: observer, rasterCache: { renderSelectedPages } } : {}) }).run(state, signal);
    return { state, storage, observer, renderSelectedPages, run };
  }
  it("does no layout work by default and bypasses healthy native prose", async () => {
    for (const setup of [fixtures(), fixtures({ healthy: true })]) {
      await setup.run(false);
      expect(setup.renderSelectedPages).not.toHaveBeenCalled();
      expect(setup.observer.observe).not.toHaveBeenCalled();
    }
    const healthy = fixtures({ healthy: true });
    await healthy.run();
    expect(healthy.renderSelectedPages).not.toHaveBeenCalled();
    expect(healthy.state.usageLedger.pendingCount).toBe(0);
    expect(healthy.storage.putJson).toHaveBeenCalledTimes(1);
  });
  it("bounds selection, reuses fresh bytes, records scoped usage and preserves the plan", async () => {
    const off = fixtures();
    const shadow = fixtures();
    await off.run(false);
    await shadow.run();
    expect(shadow.storage.putJson.mock.calls[0]![1]).toEqual(off.storage.putJson.mock.calls[0]![1]);
    expect(shadow.renderSelectedPages).toHaveBeenCalledTimes(1);
    expect(shadow.renderSelectedPages.mock.calls[0]![0].pageNumbers).toEqual([2]);
    expect(shadow.storage.getBytes).not.toHaveBeenCalled();
    expect(shadow.state.artifactLedger.readDocument("doc", "page-route-layout-shadow")).toContain("page-route-layout-shadow/doc.json");
    expect(shadow.state.usageLedger.snapshot()).toEqual([expect.objectContaining({ metric: "layout-shadow", costCents: 0,
      amount: 1, unit: "request", metadata: expect.objectContaining({ documentId: "doc", pageNumber: 2, billable: false, costStatus: "unknown" }) })]);
    const evidence = shadow.storage.putJson.mock.calls[1]![1] as Record<string, unknown>;
    expect(evidence).toMatchObject({ sourceSha256: "x", pdfPointTransform: null, summary: { selected: 1, observed: 1, errors: 0 } });
    expect(shadow.state.pendingPerformance.find((p) => p.metric === "page-route-timing")?.metadata).toHaveProperty("layoutShadowMs");
  });
  it("loads a durable raster hit with a byte bound and does not charge observation cache hits", async () => {
    const setup = fixtures({ hit: true });
    setup.observer.observe = vi.fn(async ({ payload }) => ({ result, cacheHit: true, elapsedMs: 1, inputBytes: payload.length, inferencePerformed: false, inferenceKey: "prior" }));
    await setup.run();
    expect(setup.storage.getBytes).toHaveBeenCalledWith("raster-2", { maxBytes: 1024 });
    expect(setup.state.usageLedger.pendingCount).toBe(0);
  });
  it("fails open on service validation and artifact persistence errors", async () => {
    for (const failure of ["service", "persistence"]) {
      const setup = fixtures();
      if (failure === "service") setup.observer.observe = vi.fn(async () => { throw new Error("invalid model identity"); });
      else setup.storage.putJson.mockImplementation(async (key: string) => { if (key.includes("layout-shadow")) throw new Error("storage unavailable"); });
      await setup.run();
      expect(setup.state.artifactLedger.readDocument("doc", "page-route-plan")).toBeTruthy();
      expect(setup.state.pendingPerformance.some((p) => p.metric === "page-route-error")).toBe(false);
      expect(setup.state.pendingPerformance.some((p) => p.metric === "page-route-layout")).toBe(true);
    }
  });
  it("bounds a hung storage read and retains the baseline plan", async () => {
    const setup = fixtures({ hit: true, timeoutMs: 10 });
    setup.storage.getBytes.mockImplementation(() => new Promise(() => {}));
    await setup.run();
    expect(setup.observer.observe).not.toHaveBeenCalled();
    expect(setup.state.pendingPerformance.find((p) => p.metric === "page-route-layout" && p.scope === "document")?.metadata).toMatchObject({ budgetExhausted: true, errors: 1 });
  });
  it("retains failed dispatched usage without asserting service cost", async () => {
    const setup = fixtures();
    setup.observer.observe = vi.fn(async ({ onRequest }) => {
      onRequest?.({ inferenceKey: "failed", inputBytes: 6 });
      throw new Error("service timed out");
    });
    await setup.run();
    expect(setup.state.usageLedger.snapshot().find((e) => e.metric === "layout-shadow")).toMatchObject({
      amount: 1, costCents: 0, metadata: { status: "failed-or-cancelled", billable: false, costStatus: "unknown" },
    });
  });
  it("estimates only known service wall time and keeps it nonbillable", async () => {
    const setup = fixtures({ hourlyCostUsd: 1 });
    setup.observer.observe = vi.fn(async ({ onRequest, payload }) => {
      onRequest?.({ inferenceKey: "measured", inputBytes: payload.length });
      return { result: { ...result, diagnostics: { elapsedMs: 3600 } }, cacheHit: false, elapsedMs: 9000,
        inputBytes: payload.length, inferencePerformed: true, inferenceKey: "measured" };
    });
    await setup.run();
    expect(setup.state.usageLedger.snapshot()[0]).toMatchObject({ costCents: 0,
      metadata: { estimatedComputeCostCents: 0.1, billable: false, costStatus: "estimated-service-wall-time" } });
  });
  it("bounds accumulated result evidence without silently truncating regions", async () => {
    const setup = fixtures({ maxPages: 3 });
    setup.observer.observe = vi.fn(async () => ({ result: { ...result, diagnostics: { padding: "x".repeat(9 * 1024 * 1024) } },
      cacheHit: true, elapsedMs: 1, inputBytes: 6, inferencePerformed: false, inferenceKey: "cached" }));
    await setup.run();
    const artifact = setup.storage.putJson.mock.calls[1]![1] as { summary: Record<string, unknown>; pages: Record<string, unknown>[] };
    expect(artifact.summary.artifactBudgetExhausted).toBe(true);
    expect(artifact.pages[1]).toMatchObject({ resultOmitted: true, reason: "document-artifact-byte-budget" });
    expect(artifact.pages[1]).not.toHaveProperty("result");
    expect(Buffer.byteLength(JSON.stringify(artifact))).toBeLessThan(16 * 1024 * 1024);
  });
  it("persists earlier page evidence when a later page exhausts the document deadline", async () => {
    const setup = fixtures({ maxPages: 2, timeoutMs: 20 });
    setup.observer.observe = vi.fn(async ({ payload, signal }) => {
      if ((setup.observer.observe as ReturnType<typeof vi.fn>).mock.calls.length > 1) {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return { result, cacheHit: false, elapsedMs: 1, inputBytes: payload.length, inferencePerformed: true, inferenceKey: "first" };
    });
    await setup.run();
    const call = setup.storage.putJson.mock.calls.find(([key]) => String(key).includes("layout-shadow"));
    const artifact = call?.[1] as { summary: Record<string, unknown>; pages: Record<string, unknown>[] };
    expect(artifact.summary).toMatchObject({ observed: 1, budgetExhausted: true });
    expect(artifact.summary).not.toHaveProperty("persistenceError");
    expect(artifact.pages[0]).toMatchObject({ pageNumber: 2, result });
  });
  it("audits pages the router accepted, independently of the routing decision", async () => {
    const off = fixtures({ healthy: true });
    const setup = fixtures({ healthy: true, auditPages: 2 });
    await off.run(false);
    await setup.run();
    expect(setup.storage.putJson.mock.calls[0]![1]).toEqual(off.storage.putJson.mock.calls[0]![1]);
    const audited = setup.renderSelectedPages.mock.calls.map(([args]) => args.pageNumbers[0]);
    expect(audited).toHaveLength(2);
    expect(new Set(audited).size).toBe(2);
    const artifact = setup.storage.putJson.mock.calls[1]![1] as { summary: Record<string, unknown>; pages: Record<string, unknown>[] };
    expect(artifact.summary).toMatchObject({ selected: 0, auditSelected: 2, auditPool: 3 });
    expect(artifact.pages.every((p) => p.selection === "audit" && p.healthyTextLayer === true)).toBe(true);
  });
  it("runs audits on their own deadline after routed pages exhaust theirs", async () => {
    const setup = fixtures({ maxPages: 1, timeoutMs: 20, auditPages: 1 });
    setup.observer.observe = vi.fn(async ({ payload, signal }) => {
      if ((setup.observer.observe as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return { result, cacheHit: false, elapsedMs: 1, inputBytes: payload.length, inferencePerformed: true, inferenceKey: "audit" };
    });
    await setup.run();
    const artifact = setup.storage.putJson.mock.calls.find(([key]) => String(key).includes("layout-shadow"))![1] as
      { summary: Record<string, unknown>; pages: Record<string, unknown>[] };
    expect(artifact.summary).toMatchObject({ budgetExhausted: true, auditBudgetExhausted: false, auditObserved: 1 });
    expect(artifact.pages.map((p) => p.selection)).toEqual(["routed", "audit"]);
  });
  it("checks admission before rendering so saturation wastes no preprocessing", async () => {
    const setup = fixtures();
    setup.observer.hasCapacity = vi.fn(() => false);
    await setup.run();
    expect(setup.renderSelectedPages).not.toHaveBeenCalled();
    expect(setup.observer.observe).not.toHaveBeenCalled();
    expect(setup.state.pendingPerformance.find((p) => p.metric === "page-route-layout" && p.scope === "document")?.metadata)
      .toMatchObject({ admissionRejected: 1, errors: 1 });
  });
  it("propagates cancellation instead of turning it into successful routing", async () => {
    const setup = fixtures();
    const controller = new AbortController();
    setup.observer.observe = vi.fn(async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; });
    await expect(setup.run(true, controller.signal)).rejects.toThrow("cancelled");
  });
});
