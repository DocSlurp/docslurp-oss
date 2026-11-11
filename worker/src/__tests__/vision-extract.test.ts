import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVisionPageFacts } from "../pipeline/page-facts.js";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharpForTest from "sharp";
import type { ChartExportSession } from "../chart-export/session.js";
import { testCatalog } from "../routing/testing.js";
import { BILLABLE_UNIT_METRICS, DEFAULT_OPENROUTER_VISION_MODEL, DISTINCT_TEST_PRICING, installTestPricing, isUnitChargeEvent, resetPricingProviderForTests, visionListPriceCents, visionModelCatalog } from "@docslurp/shared";
import { setDeterministicVisualExtractor } from "../chart-export/types.js";
import { chartExportVmUsageEvent } from "../chart-export/vm-extractor.js";

import {
  buildFailedVisionAttemptUsage,
  shouldFailOpenVisionError,
  visionPricingSource,
  VisionExtractStage,
} from "../stages/vision-extract.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { resolveVisionPromptTemplate } from "../tools/vision-runtime.js";
import { buildSchemaAwareVisionPrompt } from "../tools/vision-runtime.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { Config } from "../config.js";
import { attachVisionServedRoute, priceVisionServedUsage, visionRouteBilling } from "../lib/vision-pricing.js";

describe("shouldFailOpenVisionError", () => {
  it("uses provider vision charges including fractional cents and prices hosted router fallbacks", () => {
    const cfg = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
    const at = (model: string, baseUrl = "https://openrouter.ai/api/v1") =>
      ({ model, billing: visionRouteBilling({ runtime: "openai-compatible", baseUrl }, cfg) });
    const price = (route: ReturnType<typeof at>, usage: { inputTokens: number; outputTokens: number; costCents?: number }) =>
      priceVisionServedUsage(route, cfg, usage);
    const usage = { inputTokens: 100, outputTokens: 50 };
    expect(price(at("vendor/x"), { ...usage, costCents: 0.00321 })).toBe(0.00321);
    expect(price(at("vendor/x"), { ...usage, costCents: 0 })).toBe(0);
    expect(price(at("vendor/x"), usage)).toBeCloseTo(0.0025, 10);
    // Without a provider charge, cataloged hosted models use their own list price, not the generic fallback.
    const tokens = { inputTokens: 2_000, outputTokens: 1_000 };
    expect(price(at("nvidia/nemotron-3.5-super-vl"), tokens)).toBeCloseTo((2_000 * 0.15 + 1_000 * 0.5) / 1e4, 12);
    expect(price(at(DEFAULT_OPENROUTER_VISION_MODEL), tokens))
      .toBeCloseTo(visionListPriceCents(DEFAULT_OPENROUTER_VISION_MODEL, { inputTokens: 2_000, outputTokens: 1_000 })!, 12);
    expect(price(at("google/gemini-3.1-flash-lite"), tokens)).toBeCloseTo((2_000 * 0.25 + 1_000 * 1.5) / 1e4, 12);
    expect(price(at("vendor/uncataloged-vlm"), tokens)).toBeCloseTo(0.05, 10);
    expect(price(at("nvidia/nemotron-3.5-super-vl", "http://127.0.0.1:8000/v1"), tokens)).toBe(0);
  });

  it("prices a receipt-less cataloged hosted call at list price, not the generic fallback, and labels its pricing source", () => {
    const cfg = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
    const tokens = { inputTokens: 2_000, outputTokens: 1_000 };
    const fallback = (tokens.inputTokens / 1000) * cfg.costPer1kInputTokens + (tokens.outputTokens / 1000) * cfg.costPer1kOutputTokens;
    for (const entry of visionModelCatalog.filter((spec) => spec.target === "hosted")) {
      const billing = visionRouteBilling(entry.runtime === "remote-openai"
        ? { runtime: "remote-openai", baseUrl: cfg.openAiBaseUrl }
        : { runtime: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" }, cfg);
      const route = { runtime: entry.runtime, baseUrl: null, provider: "x", model: entry.id, billing };
      const cost = priceVisionServedUsage(route, cfg, tokens);
      expect(cost, entry.id).toBeGreaterThan(0);
      expect(cost, entry.id).toBeCloseTo(visionListPriceCents(entry.id, tokens)!, 12);
      // The generic fallback is a floor for every entry priced above it; only sub-fallback list prices go lower.
      if (entry.tokenPricing!.inputUsdPerMillion >= 0.1 && entry.tokenPricing!.outputUsdPerMillion >= 0.3) {
        expect(cost, entry.id).toBeGreaterThanOrEqual(fallback);
      }
      expect(visionPricingSource(route), entry.id).toBe("vision-catalog-list-price");
    }
    expect(visionPricingSource({ runtime: "openai-compatible", baseUrl: null, provider: "openrouter", model: "vendor/x", billing: "openrouter" }))
      .toBe("configured-fallback");
    expect(visionPricingSource({ runtime: "local-cli", baseUrl: null, provider: "vision-runtime", model: "microsoft/Florence-2-base-ft", billing: "local" }))
      .toBe("non-billable-runtime");
  });

  it("uses persisted triage without launching another source text extraction pass", async () => {
    let sourceTextCalls = 0;
    const runner = {
      extractText: async () => {
        sourceTextCalls += 1;
        throw new Error("duplicate source pass");
      },
    } as unknown as CommandRunner;
    const routing = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc-1",
      filename: "invoice.pdf",
      text: "Invoice #1042\nTotal: $42.00",
      pageCount: 1,
      evidence: {
        source: "canonical-document",
        artifactUri: "s3://bucket/canonical.json",
      },
      structuredComplexity: new Map([
        [
          1,
          {
            textLength: 28,
            textCoverage: 0.03,
            hasSubstantialImages: true,
            imageCoverage: 0.2,
            largestImageCoverage: 0.2,
            fullPageImage: false,
            uncoveredVectorArea: 0,
            isGarbled: false,
            pageArea: 100_000,
            needsOcr: true,
            reasons: ["sparse-text", "embedded-images"],
          },
        ],
      ]),
    });
    const storage = {
      bucket: "bucket",
      getJson: async () => routing,
    } as unknown as ArtifactStore;
    const stage = new VisionExtractStage(
      runner,
      storage,
      { visionDensityThreshold: 0.25 } as Config,
      {} as never,
    );
    const state = {
      artifactLedger: DocumentArtifactLedger.create({
        "doc-1:classification": "s3://bucket/classification.json",
      }),
      pendingPerformance: [],
      run: { pipeline: { quality: "auto", vision: {} } },
    } as unknown as WorkflowState;
    const document = {
      id: "doc-1",
      filename: "invoice.pdf",
      sourceKey: "source.pdf",
    } as Document;
    const result = await (
      stage as unknown as {
        checkNeedsVision(
          document: Document,
          pageCount: number,
          state: WorkflowState,
        ): Promise<{ needed: boolean; selectedPages: number[]; reason: string }>;
      }
    ).checkNeedsVision(document, 1, state);

    expect(sourceTextCalls).toBe(0);
    expect(result).toMatchObject({
      needed: false,
      selectedPages: [],
      reason: "calibrated-routing-skip",
    });
  });

  it("good quality sends every page through vision despite calibrated routing", async () => {
    const routing = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc-1",
      filename: "form.jpg",
      text: "Readable parser text",
      pageCount: 2,
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
    });
    const storage = {
      bucket: "bucket",
      getJson: async () => routing,
    } as unknown as ArtifactStore;
    const stage = new VisionExtractStage(
      {} as CommandRunner,
      storage,
      { visionDensityThreshold: 0.25 } as Config,
      {} as never,
    );
    const state = {
      artifactLedger: DocumentArtifactLedger.create({
        "doc-1:classification": "s3://bucket/classification.json",
      }),
      pendingPerformance: [],
      run: { pipeline: { quality: "good", vision: {} } },
    } as unknown as WorkflowState;

    const result = await (
      stage as unknown as {
        checkNeedsVision(
          document: Document,
          pageCount: number,
          state: WorkflowState,
        ): Promise<{ needed: boolean; selectedPages: number[]; reason: string }>;
      }
    ).checkNeedsVision({ id: "doc-1", filename: "form.jpg" } as Document, 2, state);

    expect(result).toMatchObject({
      needed: true,
      selectedPages: [1, 2],
      reason: "quality-good-all-pages",
    });
  });

  it("persists a non-billable Usage Event when an attempted page has no provider usage", () => {
    expect(
      buildFailedVisionAttemptUsage({
        documentId: "doc-1",
        pageNumber: 2,
        rasterArtifactUri: "s3://bucket/page-2.png",
        runtime: "openai-compatible",
        model: "test-vision",
        reason: "provider unavailable",
      }),
    ).toMatchObject({
      metric: "page-analysis-attempt",
      amount: 1,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      metadata: {
        pageNumber: 2,
        outcome: "failure",
        billable: false,
      },
    });
  });

  it("records the summed spend of a page rejected on every attempt through the usage ledger", () => {
    const stage = new VisionExtractStage({} as CommandRunner, {} as ArtifactStore,
      { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config, {} as never);
    const record = (stage as unknown as { recordFailedVisionAttempt(...args: unknown[]): void }).recordFailedVisionAttempt.bind(stage);
    const rejected = new VisionOutputRejectedError("rejected after 2 attempts", [], 2400, 640, 1.5);
    attachVisionServedRoute(rejected, { runtime: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter", model: "google/gemini-3.1-flash-lite", billing: "openrouter" });
    const state = { usageLedger: new PipelineUsageEventLedger(), pendingPerformance: [] } as unknown as WorkflowState;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const vision = { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite" };
    record(state, { id: "doc-1" }, vision, { pageNumber: 3, artifactUri: "s3://bucket/p3.png" }, rejected.message, new Error("wrapped", { cause: rejected }));
    const events = state.usageLedger.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      metric: "page-analysis-attempt", model: "google/gemini-3.1-flash-lite", inputTokens: 2400, outputTokens: 640,
      metadata: { outcome: "rejected", billable: false, documentId: "doc-1", pageNumber: 3 },
    });
    // Provider spend is kept for cost accounting; the customer is not charged for a page with no output.
    expect(events[0]!.costCents).toBe(0);
    expect(events[0]!.metadata?.providerCostCents).toBeGreaterThan(0);
    expect(state.usageLedger.totals()).toMatchObject({ inputTokens: 2400, outputTokens: 640 });
    expect(log.mock.calls.filter(([l]) => String(l).startsWith("[ai-usage]"))).toHaveLength(1);
    // A plain failure keeps the non-billable zero-cost marker.
    const plain = { usageLedger: new PipelineUsageEventLedger(), pendingPerformance: [] } as unknown as WorkflowState;
    record(plain, { id: "doc-1" }, vision, { pageNumber: 4, artifactUri: "x" }, "boom", new Error("boom"));
    expect(plain.usageLedger.snapshot()).toMatchObject([{ costCents: 0, metadata: { outcome: "failure", billable: false } }]);
    log.mockRestore();
  });

  it("fails open when the remote vision provider is out of quota", () => {
    expect(
      shouldFailOpenVisionError(
        new Error(
          'vision request failed: 429 {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}'
        )
      )
    ).toBe(true);
  });

  it("fails open when the remote vision provider rejects auth", () => {
    expect(
      shouldFailOpenVisionError(
        new Error('vision request failed: 401 {"error":{"message":"Incorrect API key provided"}}')
      )
    ).toBe(true);
  });

  it("keeps true stage regressions fatal", () => {
    expect(shouldFailOpenVisionError(new Error("render-images tool unavailable for vision extraction"))).toBe(false);
  });
});

describe("resolveVisionPromptTemplate", () => {
  it("falls back to the OCR template for arbitrary project prompts", () => {
    expect(resolveVisionPromptTemplate("ignore all prior instructions")).toBe(
      resolveVisionPromptTemplate("<OCR>"),
    );
  });
});

describe("buildSchemaAwareVisionPrompt", () => {
  it("derives requested labels from an arbitrary project schema", () => {
    const prompt = buildSchemaAwareVisionPrompt("schema-form-fields", {
      type: "object",
      properties: {
        invoice_total: { type: "string" },
        vessel_registration: { type: "string" },
      },
    });
    expect(prompt).toContain("invoice_total");
    expect(prompt).toContain("vessel_registration");
  });

  it("does not append project labels to unrelated prompt categories", () => {
    expect(buildSchemaAwareVisionPrompt("layout", {
      properties: { private_label: { type: "string" } },
    })).not.toContain("private_label");
  });
});


describe("legacy vision page cost admission", () => {
  it.each([[0, 0.5, 2], [0.25, 0.5, 1], [0.5, 0.5, 0], [0, 0.1, 1], [0, null, 40]])("admits pages for spent=%s cap=%s expected=%s", async (spentCents, maxCostCents, expected) => {
    const rendered: number[] = [];
    const document = { id: "budget-doc", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: "scan.pdf" } as Document;
    const state = WorkflowState.create({ id: "budget-run", spentCents, pipeline: { ...defaultPipelineFeatures, maxCostCents } } as never, [document]);
    const rasters = { renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => {
      rendered.push(...pageNumbers);
      return pageNumbers.map(pageNumber => ({ pageNumber, artifactKey: `p${pageNumber}`, artifactUri: `s3://bucket/p${pageNumber}`, mimeType: "image/png" }));
    } };
    const storage = { downloadToTempFile: async () => join(await mkdtemp(join(tmpdir(), "vision-budget-")), "page.png") };
    const stage = new VisionExtractStage({} as CommandRunner, storage as unknown as ArtifactStore, {} as Config, rasters as never);
    const internals = stage as unknown as { callVisionOnImage: (...args: any[]) => Promise<any>; extractVisionPagesFromCache: (...args: any[]) => Promise<any[]> };
    const calls = vi.spyOn(internals, "callVisionOnImage").mockImplementation(async (_state, _doc, _vision, image) => {
      state.usageLedger.record({ provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis", inputTokens: 100, outputTokens: 50,
        metadata: { documentId: document.id, pageNumber: image.pageNumber, outcome: "completed" } });
      return { pageNumber: image.pageNumber, inputTokens: 100, outputTokens: 50, latencyMs: 1, text: "read" };
    });
    const outputs = await internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, Array.from({ length: 40 }, (_, i) => i + 1));
    expect(calls).toHaveBeenCalledTimes(expected);
    expect(rendered).toHaveLength(expected);
    expect(outputs).toHaveLength(expected);
    expect(Number(spentCents) + state.usageLedger.pendingBillableCents).toBe(Number(spentCents) + Number(expected) * 0.25);
  });
});


it("preserves completed and nonselected facts when later selected pages hit the cap", () => {
  expect(buildVisionPageFacts({ documentId: "d", runId: "r", pageCount: 4,
    selected: [1, 2, 3], processed: [{ pageNumber: 1, text: "read" }, { pageNumber: 2, text: "read" }], costCapped: true,
  }).map(p => p.visionStatus)).toEqual(["extracted", "extracted", "cost-cap", "not-selected"]);
});


it("keeps earlier capped-page results in the partial manifest when a later page fails", async () => {
  const document = { id: "partial-doc", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: "scan.pdf" } as Document;
  const state = WorkflowState.create({ id: "partial-run", spentCents: 0, pipeline: { ...defaultPipelineFeatures, maxCostCents: 10 } } as never, [document]);
  const putJson = vi.fn(async () => {});
  const storage = { putJson, uri: (key: string) => `s3://bucket/${key}`,
    downloadToTempFile: async () => join(await mkdtemp(join(tmpdir(), "vision-partial-")), "page.png") };
  const rasters = { renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => pageNumbers.map(pageNumber => ({
    pageNumber, artifactKey: `p${pageNumber}`, artifactUri: `s3://bucket/p${pageNumber}`, mimeType: "image/png",
  })) };
  const stage = new VisionExtractStage({} as CommandRunner, storage as unknown as ArtifactStore, {} as Config, rasters as never);
  const internals = stage as unknown as { callVisionOnImage: (...args: any[]) => Promise<any>; extractVisionPagesFromCache: (...args: any[]) => Promise<any[]> };
  vi.spyOn(internals, "callVisionOnImage").mockImplementation(async (_state, _doc, _vision, image) => {
    if (image.pageNumber === 2) throw new Error("fatal renderer fault");
    return { pageNumber: image.pageNumber, inputTokens: 100, outputTokens: 50, latencyMs: 1, text: "retained result" };
  });
  await expect(internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, [1, 2, 3], undefined, "manifest.json"))
    .rejects.toMatchObject({ stats: { partial: true, processedPages: 1 } });
  expect(putJson).toHaveBeenLastCalledWith("manifest.json", expect.objectContaining({
    partial: true, processedPages: 1, pagesDetail: [expect.objectContaining({ pageNumber: 1, text: "retained result" })],
  }));
  const unavailable = Object.assign(new Error("storage unavailable"), { code: "STORAGE_READ_FAILED" });
  vi.spyOn(rasters, "renderSelectedPages").mockRejectedValue(unavailable);
  await expect(internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, [1, 2, 3]))
    .rejects.toBe(unavailable);
});

describe("chart export in vision-extract (real pass, fake model client)", () => {
  const BAR = { kind: "chart", chartType: "bar", title: "Bookings", series: [{ name: "Bookings", points: [{ x: "Q1", y: 4 }, { x: "Q2", y: 6 }] }], summary: "Bookings rise from 4 to 6." };
  const CHART_EXPORT = { enabled: true, formats: ["description", "csv"], diagrams: true, generatorModel: null };
  const estimate = { costUsd: 0, latencyMs: 0, pPass: 0.9 };
  const routePlan = {
    schemaVersion: "route-plan@v2", documentId: "doc-c", runId: "run-c", routerId: "baseline", routerKind: "baseline", mode: "shadow",
    objective: "cost-quality", policyVersion: "test", rejected: [], decisionModelCalls: [], attention: [],
    triage: { ran: false, decisionModel: null, format: null, pagesPerCall: null, costUsd: 0 },
    verifier: { decisionModel: null, calls: 0, escalations: 0, costUsd: 0 },
    chunkEstimate: { routerCostUsd: 0, extractionCostUsd: 0, totalCostUsd: 0, latencyP50Ms: 0, latencyP95Ms: 0, budget: { limitUsd: 1, marginFloor: 0.5 }, overBudgetActions: [] },
    assignments: [
      { pageNumber: 2, role: "chart-data", scope: { kind: "image", imageIndex: 0, bbox: { x: 72, y: 72, width: 144, height: 72 } }, targetId: "t", reason: "chart", estimate, cascade: [] },
      { pageNumber: 2, role: "chart-data", scope: { kind: "image", imageIndex: 1, bbox: { x: 72, y: 300, width: 144, height: 72 } }, targetId: "ocr", reason: "chart", estimate, cascade: [] },
    ],
  };

  function memoryStore() {
    const objects = new Map<string, unknown>();
    const reads: string[] = [];
    return {
      objects, reads, bucket: "b",
      uri: (key: string) => `s3://b/${key}`,
      async getJson(key: string) { reads.push(key); if (!objects.has(key)) throw new Error(`missing ${key}`); return structuredClone(objects.get(key)); },
      async putJson(key: string, value: unknown) { objects.set(key, structuredClone(value)); },
      async putBytes(key: string, bytes: Buffer) { objects.set(key, bytes.toString("utf8")); },
      async deleteKeys() { /* unused */ },
      async downloadToTempFile() {
        const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "docslurp-vision-chart-test-"));
        const file = join(dir, "page.png");
        await sharpForTest({ create: { width: 1275, height: 1650, channels: 3, background: "#fff" } }).png().toFile(file);
        return file;
      },
    };
  }

  async function setup(pipeline: Record<string, unknown>, options: { plan?: boolean } = {}) {
    const { buildCanonicalDocumentFromMarkdown } = await import("../lib/canonical-document.js");
    const { buildExtractionContract } = await import("../lib/extraction-contract.js");
    const document = { id: "doc-c", userId: "u", filename: "deck.pdf", mimeType: "application/pdf", pageCount: 2, sourceKey: "s.pdf" } as Document;
    const state = WorkflowState.create({ id: "run-c", orgId: "org", spentCents: 0, storagePrefix: "u/run-c", pipeline: { ...defaultPipelineFeatures, ...pipeline } } as never, [document]);
    const storage = memoryStore();
    const markdown = "Intro page.\fQuarterly bookings chart.";
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc-c", text: markdown, pageCount: 2, extractor: "test" });
    storage.objects.set("u/run-c/canonical.json", canonical);
    storage.objects.set("u/run-c/contract.json", buildExtractionContract({ documentId: "doc-c", markdown, extractor: "test", strategy: "test", extractionTimeMs: 1, pageCount: 2, canonicalDocument: canonical }));
    state.artifactLedger.recordDocument("doc-c", "canonical-document", storage.uri("u/run-c/canonical.json"));
    state.artifactLedger.recordDocument("doc-c", "extraction-contract", storage.uri("u/run-c/contract.json"));
    if (options.plan !== false) {
      storage.objects.set("u/run-c/plan.json", routePlan);
      state.artifactLedger.recordDocument("doc-c", "page-route-plan", storage.uri("u/run-c/plan.json"));
    }
    storage.reads.length = 0;
    const rendered: number[] = [];
    const rasters = { renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => { rendered.push(...pageNumbers); return pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `p${pageNumber}`, artifactUri: `s3://b/p${pageNumber}`, mimeType: "image/png", dpi: 150 })); } };
    const stage = new VisionExtractStage({} as CommandRunner, storage as unknown as ArtifactStore, {} as Config, rasters as never);
    const requests: Array<{ purpose: string; image: string }> = [];
    vi.spyOn(stage as unknown as { chartModelClient: () => unknown }, "chartModelClient").mockReturnValue({
      async complete(request: { purpose: string; image: { path: string } }) {
        requests.push({ purpose: request.purpose, image: request.image.path });
        return { text: JSON.stringify(BAR), model: "google/gemini-3.1-flash-lite", provider: "openrouter", inputTokens: 800, outputTokens: 120, costCents: 0.02, latencyMs: 5 };
      },
    });
    // The routing catalog is not under test: one admitted cheap generator.
    vi.spyOn(await import("../routing/runtime.js"), "buildRuntimeCatalog").mockReturnValue({ targets: testCatalog(), allTargets: testCatalog() } as never);
    return { stage, state, storage, document, rendered, requests };
  }

  const markdownOf = (storage: { objects: Map<string, unknown> }, state: WorkflowState) => {
    const contract = storage.objects.get(state.artifactLedger.readDocument("doc-c", "extraction-contract")!.replace("s3://b/", "")) as { markdown: string; charts: unknown[] };
    return contract;
  };

  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const chartCharges = (state: WorkflowState) => state.usageLedger.snapshot().filter((e) => e.metric === BILLABLE_UNIT_METRICS.chartExport);

  it("is inert with export off: no stage row, no storage read, no extra stats, no charge (kill switch or project option)", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    for (const [flag, enabled] of [["", true], ["off", true], ["0", true], ["on", false]] as const) {
      vi.stubEnv("DOCSLURP_CHART_EXPORT", flag);
      const { stage, state, storage, requests } = await setup({ visionFallback: false, quality: "fast", chartExport: { ...CHART_EXPORT, enabled } });
      await stage.run(state);
      expect(storage.reads).toEqual([]);
      expect(state.documentStage("doc-c", "vision-extract")).toBeUndefined();
      expect(requests).toEqual([]);
      expect(chartCharges(state)).toEqual([]);
    }
    resetPricingProviderForTests();
  });

  it("charges one unit per model-read visual on the real path, never twice on a retry, and reprocesses idempotently", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    try {
      for (const flag of ["on", "TRUE", "1", "yes"]) {
        vi.stubEnv("DOCSLURP_CHART_EXPORT", flag);
        const { stage, state, storage, document, requests } = await setup({ visionFallback: false, quality: "fast", chartExport: CHART_EXPORT });
        await stage.run(state);
        expect(requests).toHaveLength(2);
        const charges = chartCharges(state);
        expect(charges.map((e) => e.id).sort()).toEqual(["chart-export:run-c:doc-c:p2-i0", "chart-export:run-c:doc-c:p2-i1"]);
        expect(charges.every((e) => isUnitChargeEvent(e) && e.costCents > 0)).toBe(true);
        // A retried document stage (a fresh session over the same run) calls again but charges nothing new.
        const internals = stage as unknown as {
          chartExportSession: (s: WorkflowState, d: Document) => ChartExportSession;
          withChartExport: (s: WorkflowState, d: Document, session: ChartExportSession, signal: undefined, body: () => Promise<{ stats: Record<string, unknown> }>) => Promise<unknown>;
        };
        await internals.withChartExport(state, document, internals.chartExportSession(state, document), undefined, async () => ({ stats: { pages: 0 } }));
        expect(chartCharges(state)).toHaveLength(2);
        // The retry replaced the earlier blocks: still one block per visual.
        const contract = markdownOf(storage, state);
        expect(contract.markdown.match(/<!-- docslurp:visual p2-i\d [0-9a-f]{16} -->/g)).toHaveLength(2);
        expect(contract.charts).toHaveLength(2);
        vi.restoreAllMocks();
      }
    } finally {
      resetPricingProviderForTests();
    }
  });

  it("reprocess with export on replaces the earlier run's blocks instead of duplicating them", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const first = await setup({ visionFallback: false, quality: "fast", chartExport: CHART_EXPORT });
    await first.stage.run(first.state);
    const second = WorkflowState.create({ ...first.state.run, id: "run-d", storagePrefix: "u/run-d" } as never, first.state.documents);
    for (const [slot, uri] of Object.entries(first.state.artifactLedger.all())) second.artifactLedger.record(slot, uri);
    await first.stage.run(second);
    const contract = markdownOf(first.storage, second);
    expect(contract.markdown.match(/<!-- docslurp:visual p2-i\d [0-9a-f]{16} -->/g)).toHaveLength(2);
    expect(contract.markdown.match(/Bookings rise/g)?.length).toBeGreaterThan(0);
    expect(contract.charts).toHaveLength(2);
  });

  it("charges nothing for a visual exported from a free deterministic spec", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const previous = setDeterministicVisualExtractor(async (input) => {
      input.recordUsage?.(chartExportVmUsageEvent({ documentId: input.document.id, wallTimeMs: 1500, reason: "doppler-svg-figures", inputs: 2, outcome: "ok" }));
      return { partials: [0, 1].map((imageIndex) => ({ source: "svg-geometry" as const, confidence: 0.99, spec: BAR as never, digest: null, pageNumber: 2, imageIndex })) };
    });
    try {
      const { stage, state, requests } = await setup({ visionFallback: false, quality: "fast", chartExport: CHART_EXPORT });
      await stage.run(state);
      expect(requests).toEqual([]);
      const stats = state.documentStage("doc-c", "vision-extract")?.stats as Record<string, any>;
      expect(stats.visualCandidates).toMatchObject({ exported: 2 });
      expect(chartCharges(state)).toEqual([]);
      // The extractor's parser-VM time lands in the run's ledger as a cost-only event for the document.
      const vm = state.usageLedger.snapshot().filter((e) => e.metric === "chart-export-vm");
      expect(vm).toHaveLength(1);
      expect(vm[0]).toMatchObject({ costCents: 0, metadata: { documentId: "doc-c", billable: false } });
    } finally {
      setDeterministicVisualExtractor(previous);
      resetPricingProviderForTests();
    }
  });

  it("chart-only path: exports router candidates as crops, one call each, under the cost-cap concurrency rule", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const { stage, state, storage, rendered, requests } = await setup({ visionFallback: false, quality: "fast", maxCostCents: 100, chartExport: CHART_EXPORT });
    await stage.run(state);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.image.includes(".chart-crop-"))).toBe(true);
    // One page raster for both crops.
    expect(rendered).toEqual([2]);
    const stats = state.documentStage("doc-c", "vision-extract")?.stats as Record<string, any>;
    expect(stats.visualCandidates).toMatchObject({ charts: 2, exported: 2, bySource: { vision: 2 } });
    const contract = markdownOf(storage, state);
    expect(contract.charts).toHaveLength(2);
    expect(contract.markdown.match(/<!-- docslurp:visual p2-i\d [0-9a-f]{16} -->/g)).toHaveLength(2);
  });

  it("routed body + end pass: the body's routed crop is kept, the role sent to a non-VLM target is exported at the end", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const { stage, state, storage, document, requests } = await setup({ visionFallback: true, quality: "balanced", chartExport: CHART_EXPORT });
    const internals = stage as unknown as {
      chartExportSession: (s: WorkflowState, d: Document) => ChartExportSession;
      withChartExport: (s: WorkflowState, d: Document, session: ChartExportSession, signal: undefined, body: () => Promise<{ stats: Record<string, unknown> }>) => Promise<{ stats: Record<string, any> }>;
    };
    const session = internals.chartExportSession(state, document);
    const result = await internals.withChartExport(state, document, session, undefined, async () => {
      // What the routed executor does for the VLM-assigned chart (deps.vlm -> exportVisual).
      const routed = await session.exportRouted({ assignment: routePlan.assignments[0] as never, assignmentIndex: 0, image: { path: "/crop.png", mimeType: "image/png" } });
      expect(routed.result?.text).toContain("Bookings rise");
      return { stats: { pages: 2 } };
    });
    expect(requests.map((r) => r.image)).toEqual(["/crop.png", expect.stringContaining(".chart-crop-")]);
    expect(result.stats.visualCandidates).toMatchObject({ charts: 2, exported: 2 });
    const contract = markdownOf(storage, state);
    // Only the end-pass visual is appended; the routed one is the body's own insert.
    expect(contract.markdown).toMatch(/<!-- docslurp:visual p2-i1 [0-9a-f]{16} -->/);
    expect(contract.markdown).not.toMatch(/<!-- docslurp:visual p2-i0 /);
    expect(contract.charts).toHaveLength(2);
  });

  it("caps generator calls per document, failed answers included", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const { stage, state, document, requests } = await setup({ visionFallback: false, quality: "fast", chartExport: CHART_EXPORT });
    const internals = stage as unknown as { chartExportSession: (s: WorkflowState, d: Document) => ChartExportSession };
    const real = internals.chartExportSession.bind(stage);
    vi.spyOn(internals, "chartExportSession").mockImplementation((s, d) => {
      const session = real(s, d);
      (session as unknown as { limits: { maxCallsPerDocument: number } }).limits.maxCallsPerDocument = 1;
      return session;
    });
    await stage.run(state);
    expect(requests).toHaveLength(1);
    expect(document.id).toBe("doc-c");
  });

  it("export off on a reprocess removes the earlier run's blocks and charts[] without a stage row", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const first = await setup({ visionFallback: false, quality: "fast", chartExport: CHART_EXPORT });
    await first.stage.run(first.state);
    expect(markdownOf(first.storage, first.state).markdown).toContain("<!-- docslurp:visual ");
    // The reprocess seeds the earlier run's artifacts (canonical, contract, chart-export slot) and turns export off.
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "");
    const second = WorkflowState.create({ ...first.state.run, id: "run-d", storagePrefix: "u/run-d", pipeline: { ...first.state.run.pipeline, chartExport: { ...CHART_EXPORT, enabled: false } } } as never, first.state.documents);
    for (const [slot, uri] of Object.entries(first.state.artifactLedger.all())) second.artifactLedger.record(slot, uri);
    await first.stage.run(second);
    const contract = markdownOf(first.storage, second);
    expect(contract.markdown).not.toContain("docslurp:visual");
    expect(contract.markdown).not.toContain("Bookings rise");
    expect(contract.markdown).toContain("Quarterly bookings chart.");
    expect(contract.charts).toEqual([]);
    expect(second.documentStage("doc-c", "vision-extract")).toBeUndefined();
    // Cleared once: a later run reads nothing for it.
    first.storage.reads.length = 0;
    const third = WorkflowState.create({ ...second.run, id: "run-e" } as never, first.state.documents);
    for (const [slot, uri] of Object.entries(second.artifactLedger.all())) third.artifactLedger.record(slot, uri);
    await first.stage.run(third);
    expect(first.storage.reads).toEqual([]);
  });
});
