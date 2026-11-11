import { afterEach, describe, expect, it } from "vitest";
import {
  BILLABLE_UNIT_METRICS,
  CHART_EXPORT_DOCUMENT_CAPS,
  DISTINCT_TEST_PRICING,
  compilePipelinePlan,
  defaultChartExportConfig,
  defaultPipelineFeatures,
  estimatePipelineWork,
  installTestPricing,
  isUnitChargeEvent,
  normalizePipelineFeatures,
  resetPricingProviderForTests,
  type ChartExportConfig,
  type PipelineFeatures,
} from "@docslurp/shared";

import { PipelineUsageEventLedger, billableCents } from "../pipeline/usage-ledger.js";
import { testCatalog } from "../routing/testing.js";
import { chargeChartExports, chargedFormats, chartExportChargeSlot, chartExportCharges } from "./billing.js";
import { chartCallCostCents } from "./generator.js";
import { ChartExportSession, DEFAULT_CHART_EXPORT_LIMITS } from "./session.js";
import type { ChartModelClient, DeterministicVisualPartial, VisualCandidate } from "./types.js";

afterEach(() => resetPricingProviderForTests());

const BAR_SPEC = {
  kind: "chart", chartType: "bar", title: "Revenue", summary: "Revenue rises each quarter.",
  x: { label: "Quarter", type: "category" }, y: { label: "USD m", type: "linear" },
  series: [{ name: "Revenue", points: [{ x: "Q1", y: 10 }, { x: "Q2", y: 12.5 }, { x: "Q3", y: 15 }] }],
};
const config: ChartExportConfig = { ...defaultChartExportConfig, enabled: true, formats: ["description", "mermaid", "csv"] };
const image = { path: "/nonexistent/chart.png", mimeType: "image/png" };
const cand = (page: number): VisualCandidate => ({ id: `p${page}-page`, pageNumber: page, imageIndex: null, bbox: null, kind: "chart", detectedBy: "legacy-page-route" });

function client(answers: string[], costCents = 0.05): ChartModelClient {
  return {
    async complete() {
      const next = answers.shift();
      if (next === undefined) throw new Error("no scripted answer");
      return { text: next, model: "google/gemini-3.1-flash-lite", provider: "openrouter", inputTokens: 1500, outputTokens: 400, costCents, latencyMs: 800 };
    },
  };
}

function runState(runId = "run-1") {
  const slots = new Map<string, string>();
  const usageLedger = new PipelineUsageEventLedger();
  usageLedger.runId = runId;
  return {
    run: { id: runId },
    usageLedger,
    artifactLedger: { read: (slot: string) => slots.get(slot), record: (slot: string, value: string | null | undefined) => { if (value) slots.set(slot, value); return value ?? undefined; } },
  } as never as Parameters<typeof chargeChartExports>[0] & { usageLedger: PipelineUsageEventLedger };
}

const chartUnits = (ledger: PipelineUsageEventLedger) => ledger.snapshot().filter((e) => e.metric === BILLABLE_UNIT_METRICS.chartExport);

describe("chart export billing (billing enforced)", () => {
  it("charges each model-read visual once, deterministic visuals nothing, and settles what the estimate quoted", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const session = new ChartExportSession({
      documentId: "doc-1", config, catalog: () => testCatalog(), recordUsage: () => undefined,
      client: client([JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC)]),
    });
    // One Office chart (free) and three charts read by the model from page rasters.
    const office: DeterministicVisualPartial = { source: "office-chart-xml", confidence: 0.99, spec: BAR_SPEC as never, digest: null, pageNumber: 9 };
    session.setDeterministic({ partials: [office] });
    for (const page of [2, 3, 4]) await session.exportWithImage(cand(page), image);
    await session.exportUnmatchedDeterministic();
    expect(session.visuals.map((v) => v.source).sort()).toEqual(["office-chart-xml", "vision", "vision", "vision"]);

    const state = runState();
    const attempts = () => [...session.modelReads.values()];
    const charged = chargeChartExports(state, { documentId: "doc-1", attempts: attempts(), calls: session.calls, config });
    const events = chartUnits(state.usageLedger);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(isUnitChargeEvent(event)).toBe(true);
      expect(event.id).toMatch(/^chart-export:run-1:doc-1:p[234]-page$/);
      expect(event.costCents).toBeCloseTo(0.07, 6);
    }
    expect(charged).toBeCloseTo(0.21, 6);
    expect(state.usageLedger.pendingBillableCents).toBeCloseTo(0.21, 6);

    // Retried stage / replayed pass: nothing is charged twice.
    expect(chargeChartExports(state, { documentId: "doc-1", attempts: attempts(), calls: session.calls, config })).toBe(0);
    expect(chartUnits(state.usageLedger)).toHaveLength(3);

    // The estimate from the recorded stats equals the settled charge.
    const features = { ...normalizePipelineFeatures(defaultPipelineFeatures), chartExport: config } as PipelineFeatures;
    const base = normalizePipelineFeatures(defaultPipelineFeatures);
    const env = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: "on" };
    const stages = compilePipelinePlan(base).stageOrder;
    const stats = session.stats();
    const on = estimatePipelineWork({ features, stages, pages: 10, documents: 1, env, visualStats: stats });
    const off = estimatePipelineWork({ features: base, stages, pages: 10, documents: 1, env });
    expect(on.credits!.high - off.credits!.high).toBeCloseTo(charged, 6);
    expect(on.credits!.low - off.credits!.low).toBeCloseTo(charged, 6);
  });

  it("charges nothing for a deterministic-only document", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const session = new ChartExportSession({ documentId: "doc-2", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: client([]) });
    session.setDeterministic({ partials: [{ source: "embedded-spec", confidence: 0.95, spec: BAR_SPEC as never, digest: null, pageNumber: 1 }] });
    await session.exportUnmatchedDeterministic();
    expect(session.visuals).toHaveLength(1);
    const state = runState();
    expect(session.modelReads.size).toBe(0);
    expect(chargeChartExports(state, { documentId: "doc-2", attempts: [...session.modelReads.values()], calls: session.calls, config })).toBe(0);
    expect(state.usageLedger.snapshot().reduce((sum, e) => sum + billableCents(e), 0)).toBe(0);
  });

  it("charges paid calls that fell back to a deterministic spec (calls, not the final source)", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    // Two unusable answers (spec, repair), then the middling deterministic spec is exported as svg-geometry.
    const session = new ChartExportSession({
      documentId: "doc-3", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: client(["not json", "still not json"]),
    });
    session.setDeterministic({ partials: [{ source: "svg-geometry", confidence: 0.7, spec: BAR_SPEC as never, digest: "bars: 10, 12.5, 15", pageNumber: 5, imageIndex: null }] });
    const visual = await session.exportWithImage(cand(5), image);
    expect(visual?.source).toBe("svg-geometry");
    expect(session.calls.filter((c) => c.responded)).toHaveLength(2);
    const charges = chartExportCharges({ attempts: [...session.modelReads.values()], calls: session.calls, config });
    expect(charges).toEqual([{ visualId: "p5-page", pageNumber: 5, credits: expect.closeTo(0.07, 6), paidCalls: 2, exported: true }]);
  });

  it("does not charge for calls that failed before the provider answered", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const attempts = [{ id: "p1-page", pageNumber: 1, kind: "chart" as const, exported: false }];
    expect(chartExportCharges({ attempts, calls: [{ visualId: "p1-page", responded: false }], config })).toEqual([]);
  });

  describe("charges every model read whatever its outcome (council round 2, N1)", () => {
    const unknown = (page: number): VisualCandidate => ({ ...cand(page), kind: null });
    const charge = async (answers: string[], candidate: VisualCandidate, cfg: ChartExportConfig = config) => {
      installTestPricing(DISTINCT_TEST_PRICING);
      const state = runState();
      const session: ChartExportSession = new ChartExportSession({
        documentId: "doc-n", config: cfg, catalog: () => testCatalog(), recordUsage: () => undefined, client: client(answers),
        onModelRead: (attempt) => { chargeChartExports(state, { documentId: "doc-n", attempts: [attempt], calls: session.calls, config: cfg }); },
      });
      const visual = await session.exportWithImage(candidate, image);
      return { visual, session, events: chartUnits(state.usageLedger), state };
    };

    it("a `none` answer: no visual, one unit", async () => {
      const { visual, events } = await charge(['{"kind":"none"}'], cand(1));
      expect(visual).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ visualId: "p1-page", paidCalls: 1, outcome: "not-exported" });
    });

    it("invalid after the repair, no summary: no visual, one unit for both calls", async () => {
      const { visual, events } = await charge(["not json", "still not json"], cand(2));
      expect(visual).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ paidCalls: 2, outcome: "not-exported" });
    });

    it("an unknown-kind candidate read as a diagram while diagrams are off: discarded, one unit", async () => {
      const diagram = { kind: "diagram", diagramType: "flowchart", title: null, direction: "TB", nodes: [{ id: "a", label: "A", shape: "box", group: null }, { id: "b", label: "B", shape: "box", group: null }], edges: [{ from: "a", to: "b", label: null, style: "solid", directed: true }], groups: [], summary: "A leads to B." };
      const { visual, session, events } = await charge([JSON.stringify(diagram)], unknown(3), { ...config, diagrams: false });
      expect(visual).toBeNull();
      expect(session.visuals).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ visualId: "p3-page", outcome: "not-exported" });
    });

    it("an exported visual: one unit; a call that never got an answer: nothing", async () => {
      const ok = await charge([JSON.stringify(BAR_SPEC)], cand(4));
      expect(ok.visual?.source).toBe("vision");
      expect(ok.events).toHaveLength(1);
      expect(ok.events[0]!.metadata).toMatchObject({ outcome: "exported" });
      const failed = await charge([], cand(5));
      expect(failed.visual).toBeNull();
      expect(failed.session.calls).toHaveLength(1);
      expect(failed.events).toEqual([]);
    });

    it("prices a read by the formats requested at call time, at least one unit (council round 3, F1)", async () => {
      installTestPricing(DISTINCT_TEST_PRICING);
      // Adversarial repro: a chart-data-only format set, reads answered as diagrams or of unknown kind.
      for (const formats of [["csv"], ["vega-lite", "csv"], ["description", "csv"]] as const) {
        const charges = chartExportCharges({
          attempts: [
            { id: "v", pageNumber: 1, kind: "diagram", exported: true },
            { id: "w", pageNumber: 1, kind: null, exported: false },
            { id: "x", pageNumber: 1, kind: "chart", exported: true },
          ],
          calls: [{ visualId: "v", responded: true }, { visualId: "w", responded: true }, { visualId: "x", responded: true }],
          config: { formats: [...formats] },
        });
        expect(charges.map((c) => [c.visualId, c.credits])).toEqual([["v", expect.closeTo(0.07, 6)], ["w", expect.closeTo(0.07, 6)], ["x", expect.closeTo(0.07, 6)]]);
      }
      expect(chargedFormats({ formats: ["csv"] }, "diagram")).toEqual(["description"]);
      expect(chargedFormats({ formats: ["csv", "mermaid"] }, "diagram")).toEqual(["mermaid"]);
      expect(chargedFormats({ formats: ["csv", "mermaid"] }, null)).toEqual(["csv", "mermaid"]);
    });

    it("a chart candidate answered as a diagram on a chart-data-only project is still charged one unit", async () => {
      const diagram = { kind: "diagram", diagramType: "flowchart", title: null, direction: "TB", nodes: [{ id: "a", label: "A", shape: "box", group: null }, { id: "b", label: "B", shape: "box", group: null }], edges: [{ from: "a", to: "b", label: null, style: "solid", directed: true }], groups: [], summary: "A leads to B." };
      for (const candidate of [cand(6), unknown(7)]) {
        const { session, events } = await charge([JSON.stringify(diagram)], candidate, { ...config, formats: ["csv"], diagrams: true });
        expect(session.modelReads.get(candidate.id)?.kind).toBe(candidate.kind);
        expect(events).toHaveLength(1);
        expect(events[0]!.costCents).toBeCloseTo(0.07, 6);
      }
    });

    it("keeps every charge in one ledger slot per document", async () => {
      installTestPricing(DISTINCT_TEST_PRICING);
      const state = runState();
      const attempts = [1, 2, 3].map((page) => ({ id: `p${page}-page`, pageNumber: page, kind: "chart" as const, exported: page !== 2 }));
      const calls = attempts.map((a) => ({ visualId: a.id, responded: true }));
      chargeChartExports(state, { documentId: "doc-s", attempts: attempts.slice(0, 1), calls, config });
      chargeChartExports(state, { documentId: "doc-s", attempts, calls, config });
      expect(chartUnits(state.usageLedger)).toHaveLength(3);
      const slots = (state.artifactLedger as unknown as { read: (s: string) => string | undefined });
      expect(JSON.parse(slots.read(chartExportChargeSlot("doc-s"))!)).toEqual({ "p1-page": expect.any(Number), "p2-page": expect.any(Number), "p3-page": expect.any(Number) });
    });
  });

  it("counts charged reads against the per-document read cap the estimate clamps to (council round 3, R3-4)", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const state = runState();
    const answers = Array.from({ length: 10 }, () => '{"kind":"none"}');
    const session: ChartExportSession = new ChartExportSession({
      documentId: "doc-cap", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: client(answers), limits: { maxModelReads: 2 },
      onModelRead: (attempt) => { chargeChartExports(state, { documentId: "doc-cap", attempts: [attempt], calls: session.calls, config }); },
    });
    for (let page = 1; page <= 5; page += 1) await session.exportWithImage(cand(page), image);
    expect(session.visuals).toEqual([]);
    expect(session.calls.filter((c) => c.responded)).toHaveLength(2);
    expect(chartUnits(state.usageLedger)).toHaveLength(2);
    expect(session.modelAvailable()).toBe(false);
    // The shipped read cap and the estimate's clamp are the same number.
    expect(DEFAULT_CHART_EXPORT_LIMITS.maxModelReads).toBe(CHART_EXPORT_DOCUMENT_CAPS.maxModelReadsPerDocument);
    expect(DEFAULT_CHART_EXPORT_LIMITS.maxVisuals).toBe(CHART_EXPORT_DOCUMENT_CAPS.maxVisualsPerDocument);
  });

  it("free deterministic exports are not crowded out by charged reads; only the output-size cap bounds them (council round 4, detail N4)", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const answers = Array.from({ length: 10 }, () => '{"kind":"none"}');
    const session = new ChartExportSession({
      documentId: "doc-free", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: client(answers), limits: { maxModelReads: 2, maxVisuals: 4 },
    });
    session.setDeterministic({ partials: Array.from({ length: 6 }, (_, i) => ({ source: "office-chart-xml" as const, confidence: 1, spec: BAR_SPEC as never, digest: null, pageNumber: 10 + i, kind: "chart" as const })) });
    for (let page = 1; page <= 3; page += 1) await session.exportWithImage(cand(page), image);
    expect(session.modelReads.size).toBe(2);
    await session.exportUnmatchedDeterministic();
    // Two reads charged (none exported), then four free exports up to the output cap.
    expect(session.visuals.map((v) => v.source)).toEqual(["office-chart-xml", "office-chart-xml", "office-chart-xml", "office-chart-xml"]);
  });

  it("reserves the read cap for concurrent reads, so crops in flight cannot overshoot it", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const slow: ChartModelClient = { complete: async (request) => { calls += 1; await gate; return await client(['{"kind":"none"}']).complete(request); } };
    const session = new ChartExportSession({ documentId: "doc-c", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: slow, limits: { maxModelReads: 2 } });
    const pending = [1, 2, 3, 4].map((page) => session.exportWithImage(cand(page), image));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all(pending);
    expect(calls).toBe(2);
    expect(session.modelReads.size).toBe(2);
  });

  it("charges each read as it completes, so the credit lease stops further calls within the document (N2)", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const state = runState();
    // A lease good for two reads (0.07 credits each under the distinct test pricing).
    const leaseExhausted = () => state.usageLedger.pendingBillableCents >= 0.14 - 1e-9;
    const answers = Array.from({ length: 10 }, () => JSON.stringify(BAR_SPEC));
    let calls = 0;
    const counting: ChartModelClient = { complete: async (request) => { calls += 1; return await client(answers).complete(request); } };
    const session: ChartExportSession = new ChartExportSession({
      documentId: "doc-l", config, catalog: () => testCatalog(), recordUsage: () => undefined, client: counting,
      canCallModel: () => !leaseExhausted(),
      onModelRead: (attempt) => { chargeChartExports(state, { documentId: "doc-l", attempts: [attempt], calls: session.calls, config }); },
    });
    for (const page of [1, 2, 3, 4, 5]) await session.exportWithImage(cand(page), image);
    expect(calls).toBe(2);
    expect(chartUnits(state.usageLedger)).toHaveLength(2);
    expect(session.visuals).toHaveLength(2);
  });

  it("prices a BYOK answer that reports zero cost from list token prices", () => {
    const byok = { model: "openai/gpt-6-luna", inputTokens: 1_000_000, outputTokens: 1_000_000, costCents: 0 };
    expect(chartCallCostCents(byok)).toBeGreaterThan(0);
    expect(chartCallCostCents({ ...byok, costCents: 12 })).toBe(12);
    expect(chartCallCostCents({ ...byok, inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
