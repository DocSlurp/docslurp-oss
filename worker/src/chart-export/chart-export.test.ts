import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import {
  defaultChartExportConfig,
  defaultPipelineFeatures,
  extractionContractSchema,
  VISUAL_CANDIDATE_STATS_KEY,
  type ChartExportConfig,
  type ChartExportFormat,
  type RoutePlan,
} from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { mergePageText } from "../routing/executors/merge.js";
import { chartExportCallEstimate, estimateTargetCost } from "../routing/estimate.js";
import { createPolicyEstimator } from "../routing/policy.js";
import { createBaselineEstimator } from "../routing/routers/baseline.js";
import { makePage, testCatalog, testPack } from "../routing/testing.js";
import { chartExportActive, chartExportConfigOf, DETERMINISTIC_HIGH_CONFIDENCE } from "./config.js";
import { CHART_EXPORT_USAGE_METRIC, exportVisual, parseSpecAnswer, type ExportVisualArgs } from "./generator.js";
import { stripVisualGroups, visualBlock, visualBody, wrapVisualGroup } from "./markdown.js";
import { CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK, CHART_GENERATOR_CANDIDATES, DIAGRAM_GENERATOR_CANDIDATES, chartExportVisionConfig, selectGeneratorModel } from "./model-selection.js";
import { sanitizeCsv, sanitizeMermaid, sanitizePython, sanitizeVegaLite } from "./sanitize.js";
import { candidatesFromPlan, ChartExportSession, guardedScopesFromPlan, placementMatch } from "./session.js";
import { clearChartExport, finishChartExport, prepareChartExport, runChartExportPass } from "./stage.js";
import { setDeterministicVisualExtractor, type ChartModelClient, type ChartModelRequest, type DeterministicVisualPartial, type VisualCandidate } from "./types.js";

const BAR_SPEC = {
  kind: "chart",
  chartType: "bar",
  title: "Quarterly revenue",
  yAxis: { label: "Revenue", unit: "USD m", scale: "linear", min: null, max: null },
  series: [{ name: "Revenue", points: [{ x: "Q1", y: 10 }, { x: "Q2", y: 12.5 }, { x: "Q3", y: 15 }] }],
  summary: "Revenue grows every quarter, from 10 to 15.",
};

const config = (formats: ChartExportFormat[], extra: Partial<ChartExportConfig> = {}): ChartExportConfig => ({
  ...defaultChartExportConfig, enabled: true, formats, ...extra,
});

const candidate: VisualCandidate = { id: "p2-i0", pageNumber: 2, imageIndex: 0, bbox: { x: 10, y: 20, width: 300, height: 200 }, kind: "chart", detectedBy: "router-inset" };
const image = { path: "/nonexistent/chart.png", mimeType: "image/png" };

/** Fake model: answers by purpose/format from a script, records every request. */
function fakeClient(answers: Array<string | Error>): ChartModelClient & { requests: ChartModelRequest[] } {
  const requests: ChartModelRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error("no scripted answer");
      if (next instanceof Error) throw next;
      return { text: next, model: "google/gemini-3.1-flash-lite", provider: "openrouter", inputTokens: 1234, outputTokens: 321, costCents: 0.05, latencyMs: 900, finishReason: "stop" };
    },
  };
}

function args(overrides: Partial<ExportVisualArgs> & { client?: ChartModelClient | null }): ExportVisualArgs & { usage: WorkerAiUsageInput[] } {
  const usage: WorkerAiUsageInput[] = [];
  return {
    candidate,
    image,
    deterministic: null,
    config: config(["description", "mermaid", "vega-lite", "matplotlib", "csv"]),
    generatorModelUri: "llm://openrouter/google/gemini-3.1-flash-lite",
    client: null,
    recordUsage: (input) => usage.push(input),
    documentId: "doc-1",
    ...overrides,
    usage,
  };
}

describe("chart export ladder", () => {
  it("uses a confident deterministic spec without calling a model", async () => {
    const client = fakeClient([]);
    const partial: DeterministicVisualPartial = { source: "office-chart-xml", confidence: 0.99, spec: BAR_SPEC as never, digest: null };
    const a = args({ client, deterministic: partial });
    const { visual, calls } = await exportVisual(a);
    expect(calls).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
    expect(a.usage).toHaveLength(0);
    expect(visual?.source).toBe("office-chart-xml");
    expect(visual?.model).toBeNull();
    expect(visual?.outputs.csv).toContain("Q2,12.5");
    expect(visual?.outputs.mermaid).toMatch(/^xychart-beta/);
  });

  it("sends a middling partial with a digest as svg-assisted, and keeps the measured numbers", async () => {
    const modelSpec = { ...BAR_SPEC, series: [{ name: "Revenue", points: [{ x: "Q1", y: 9 }, { x: "Q2", y: 13 }, { x: "Q3", y: 14 }] }] };
    const client = fakeClient([JSON.stringify(modelSpec)]);
    const partial: DeterministicVisualPartial = { source: "svg-geometry", confidence: 0.6, spec: BAR_SPEC as never, digest: "x ticks: Q1 Q2 Q3; bars: 10, 12.5, 15" };
    const a = args({ client, deterministic: partial });
    const { visual } = await exportVisual(a);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.prompt).toContain("bars: 10, 12.5, 15");
    expect(visual?.source).toBe("svg-assisted");
    expect(visual?.spec?.kind === "chart" && visual.spec.series[0]!.points.map((p) => p.y)).toEqual([10, 12.5, 15]);
  });

  it("falls to vision when nothing deterministic is known, one call for every derived format", async () => {
    const client = fakeClient([`\`\`\`json\n${JSON.stringify(BAR_SPEC)}\n\`\`\``]);
    const a = args({ client });
    const { visual, calls } = await exportVisual(a);
    expect(calls).toHaveLength(1);
    expect(visual?.source).toBe("vision");
    expect(Object.keys(visual!.outputs).sort()).toEqual(["csv", "description", "matplotlib", "mermaid", "vega-lite"]);
    expect(visual?.confidence).toBeGreaterThan(0);
  });

  it("does not export when the model sees no visual", async () => {
    const client = fakeClient([`{"kind":"none"}`]);
    const { visual } = await exportVisual(args({ client, candidate: { ...candidate, kind: null } }));
    expect(visual).toBeNull();
  });

  it("uses a deterministic spec above the high threshold even without an image", async () => {
    const partial: DeterministicVisualPartial = { source: "embedded-spec", confidence: DETERMINISTIC_HIGH_CONFIDENCE, spec: BAR_SPEC as never, digest: null };
    const { visual } = await exportVisual(args({ image: null, deterministic: partial }));
    expect(visual?.source).toBe("embedded-spec");
  });

  it("drops an invalid deterministic spec from the guest instead of trusting it", async () => {
    const partial: DeterministicVisualPartial = { source: "office-chart-xml", confidence: 1, spec: { kind: "chart", series: [] } as never, digest: null };
    const { visual } = await exportVisual(args({ image: null, deterministic: partial }));
    expect(visual).toBeNull();
  });
});

describe("derived mode repair and fallback", () => {
  it("repairs invalid JSON once and applies the repair penalty", async () => {
    const client = fakeClient(["Here is the chart: {not json", JSON.stringify(BAR_SPEC)]);
    const a = args({ client });
    const { visual, calls } = await exportVisual(a);
    expect(calls.map((c) => c.purpose)).toEqual(["spec", "repair"]);
    expect(client.requests[1]!.prompt).toContain("Problem: no JSON object in the answer");
    expect(visual?.outputs.mermaid).toBeTruthy();
    expect(visual!.confidence).toBeLessThan(0.6);
    expect(a.usage.map((u) => u.metadata?.outcome)).toEqual(["invalid-output", "completed"]);
  });

  it("falls back to description only when the repair is invalid too", async () => {
    const bad = JSON.stringify({ kind: "chart", chartType: "sparkle", series: [], summary: "Revenue rises through the year." });
    const client = fakeClient([bad, bad]);
    const { visual } = await exportVisual(args({ client }));
    expect(visual?.outputs).toEqual({ description: "Revenue rises through the year." });
    expect(visual?.skipped.map((s) => s.reason)).toEqual(["invalid-spec", "invalid-spec", "invalid-spec", "invalid-spec"]);
  });

  it("never puts raw provider error text into skipped reasons", async () => {
    const client = fakeClient([new Error("upstream 502 from provider-x secret-route /v1/foo")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = args({ client, config: config(["description", "mermaid"]) });
    const { visual, calls } = await exportVisual(a);
    warn.mockRestore();
    expect(visual).toBeNull();
    expect(calls[0]!.ok).toBe(false);
    expect(JSON.stringify(visual)).not.toContain("upstream");
  });

  it("parses fenced and prefixed answers and rejects oversized specs", () => {
    expect("spec" in parseSpecAnswer(`Sure!\n${JSON.stringify(BAR_SPEC)}\nDone.`)).toBe(true);
    const huge = { ...BAR_SPEC, series: Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, points: [{ x: "a", y: 1 }] })) };
    expect("error" in parseSpecAnswer(JSON.stringify(huge))).toBe(true);
  });
});

describe("direct mode", () => {
  const direct = { description: "derived", mermaid: "direct", "vega-lite": "direct", matplotlib: "direct", csv: "derived" } as const;

  it("makes one call per direct format beside the shared spec call, validating each", async () => {
    const client = fakeClient([
      JSON.stringify(BAR_SPEC),
      "```mermaid\n%%{init: {'theme':'dark'}}%%\nxychart-beta\n  bar [1,2]\n```",
      JSON.stringify({ data: { url: "https://evil.example/data.json" }, mark: "bar" }),
      "```python\nimport matplotlib.pyplot as plt\nplt.bar(['Q1'], [10])\n```",
    ]);
    const { visual, calls } = await exportVisual(args({ client, modes: direct }));
    expect(calls.map((c) => `${c.purpose}:${c.format ?? ""}`)).toEqual(["spec:", "direct:mermaid", "direct:vega-lite", "direct:matplotlib"]);
    expect(client.requests[3]!.prompt).toContain("Python code block using matplotlib");
    expect(visual?.outputs.matplotlib).toContain("plt.bar");
    expect(visual?.outputs.mermaid).toBeUndefined();
    expect(visual?.outputs["vega-lite"]).toBeUndefined();
    expect(visual?.skipped).toEqual([
      { format: "mermaid", reason: "mermaid-init-directive" },
      { format: "vega-lite", reason: "vega-forbidden-url" },
    ]);
    expect(visual?.outputs.csv).toContain("Q1,10");
  });

  it("skips the spec call when every requested format is direct and the kind is known", async () => {
    const client = fakeClient(["Revenue climbs from 10 to 15 over three quarters."]);
    const { visual, calls } = await exportVisual(args({ client, config: config(["description"]), modes: { ...direct, description: "direct" } }));
    expect(calls.map((c) => c.purpose)).toEqual(["direct"]);
    expect(visual?.outputs.description).toContain("Revenue climbs");
  });
});

describe("sanitizers", () => {
  it("refuses Mermaid init directives, click handlers and HTML", () => {
    expect(sanitizeMermaid("flowchart TD\n  A --> B").ok).toBe(true);
    expect(sanitizeMermaid("%%{init: {}}%%\nflowchart TD\n A-->B")).toEqual({ ok: false, reason: "mermaid-init-directive" });
    expect(sanitizeMermaid("flowchart TD\n  A --> B\n  click A callback")).toEqual({ ok: false, reason: "mermaid-click" });
    expect(sanitizeMermaid('flowchart TD\n  A["<img src=x onerror=alert(1)>"]')).toEqual({ ok: false, reason: "mermaid-html" });
    expect(sanitizeMermaid("rm -rf /")).toEqual({ ok: false, reason: "mermaid-unknown-diagram" });
    expect(sanitizeMermaid("flowchart TD\n```\nA-->B").ok).toBe(false);
  });

  it("accepts only inline-data Vega-Lite", () => {
    const ok = sanitizeVegaLite(JSON.stringify({ $schema: "https://vega.github.io/schema/vega-lite/v5.json", data: { values: [{ a: 1 }] }, mark: "bar" }));
    expect(ok.ok).toBe(true);
    expect(sanitizeVegaLite("{bad").ok).toBe(false);
    expect(sanitizeVegaLite(JSON.stringify({ data: { values: [] }, mark: "bar", encoding: { href: { field: "a" } } }))).toEqual({ ok: false, reason: "vega-forbidden-href" });
    expect(sanitizeVegaLite(JSON.stringify({ layer: [{ data: { url: "x" } }] }))).toEqual({ ok: false, reason: "vega-forbidden-url" });
    expect(sanitizeVegaLite(JSON.stringify({ mark: "bar" }))).toEqual({ ok: false, reason: "vega-no-inline-data" });
  });

  it("treats Python as text and neutralises CSV formulas", () => {
    expect(sanitizePython("import os\nos.system('x')")).toEqual({ ok: false, reason: "python-no-matplotlib" });
    expect(sanitizeCsv("a,b\n=HYPERLINK(1),-5")).toEqual({ ok: true, text: "a,b\n'=HYPERLINK(1),-5" });
  });

  it("keeps quoted CSV cells intact and neutralises formulas inside them", () => {
    expect(sanitizeCsv('label,value\n"Paris, FR",12\n"say ""hi""",3')).toEqual({ ok: true, text: 'label,value\n"Paris, FR",12\n"say ""hi""",3' });
    expect(sanitizeCsv('label,value\n"=cmd|\' /C calc\'!A0, x",1')).toEqual({ ok: true, text: 'label,value\n"\'=cmd|\' /C calc\'!A0, x",1' });
    expect(sanitizeCsv('label,value\n"open,1')).toEqual({ ok: false, reason: "csv-unbalanced-quotes" });
  });

  it("refuses every Vega expression surface but keeps the renderer's field filters", () => {
    const spec = (extra: Record<string, unknown>) => JSON.stringify({ data: { values: [{ a: 1 }] }, mark: "bar", ...extra });
    expect(sanitizeVegaLite(spec({ encoding: { x: { field: "a", axis: { labelExpr: "datum.label" } } } }))).toEqual({ ok: false, reason: "vega-forbidden-expr" });
    expect(sanitizeVegaLite(spec({ encoding: { color: { condition: { test: "datum.a > 0", value: "red" } } } })).ok).toBe(false);
    expect(sanitizeVegaLite(spec({ params: [{ name: "p", select: "point" }] }))).toEqual({ ok: false, reason: "vega-forbidden-params" });
    expect(sanitizeVegaLite(spec({ transform: [{ filter: "datum.a > 0" }] }))).toEqual({ ok: false, reason: "vega-forbidden-transform" });
    expect(sanitizeVegaLite(spec({ transform: [{ calculate: "1", as: "b" }] }))).toEqual({ ok: false, reason: "vega-forbidden-transform" });
    expect(sanitizeVegaLite(spec({ encoding: { tooltip: { signal: "x" } } }))).toEqual({ ok: false, reason: "vega-forbidden-signal" });
    expect(sanitizeVegaLite(spec({ transform: [{ filter: { field: "series", equal: "Revenue" } }] })).ok).toBe(true);
    expect(sanitizeVegaLite(spec({ transform: [{ filter: { field: "series", equal: "x", param: "p" } }] })).ok).toBe(false);
  });
});

describe("usage recording", () => {
  it("records every call with actual tokens, cost and an explicit document scope", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const a = args({ client });
    await exportVisual(a);
    expect(a.usage).toHaveLength(1);
    expect(a.usage[0]).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      metric: CHART_EXPORT_USAGE_METRIC,
      inputTokens: 1234,
      outputTokens: 321,
      costCents: 0.05,
      metadata: { documentId: "doc-1", pageNumber: 2, imageIndex: 0, source: "vision", purpose: "spec", stage: "vision-extract" },
    });
  });

  it("stops calling the model once the cost cap trips", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const { visual, calls } = await exportVisual(args({ client, canCallModel: () => false }));
    expect(calls).toHaveLength(0);
    expect(visual).toBeNull();
  });
});

describe("merge output", () => {
  it("puts the searchable description first and fenced blocks after, under the routed heading", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const formats: ChartExportFormat[] = ["description", "mermaid", "csv"];
    const { visual } = await exportVisual(args({ client, config: config(formats) }));
    const body = visualBody(visual!, formats);
    expect(body.split("\n\n")[0]).toContain("Revenue grows every quarter");
    expect(body).toContain("```mermaid\nxychart-beta");
    expect(body).toContain("```csv\nx,Revenue");
    expect(body.indexOf("```mermaid")).toBeLessThan(body.indexOf("```csv"));
    const merged = mergePageText({
      prose: "Intro paragraph.",
      inserts: [{ assignmentIndex: 0, pageNumber: 2, role: "chart-data", scope: { kind: "image", imageIndex: 0 }, targetId: "t", text: body, model: "m", runtime: "chart-export", latencyMs: 1, inputTokens: 1, outputTokens: 1, costCents: 0 }],
    });
    expect(merged).toContain("**Chart data (image 1)**\n\nRevenue grows every quarter");
    expect(visualBlock(visual!, formats).startsWith("**Chart data (image 1)**")).toBe(true);
  });
});

describe("estimates", () => {
  const hosted = testCatalog().find((t) => t.id === "vlm:openrouter/google/gemini-3.1-flash-lite") ?? testCatalog().find((t) => t.kind === "hosted-vlm")!;
  const scope = { kind: "image", imageIndex: 0 } as const;

  it("prices chart roles as generator calls for the chosen formats and modes", () => {
    const off = estimateTargetCost(hosted, "chart-data", scope);
    const derived = estimateTargetCost(hosted, "chart-data", scope, undefined, undefined, { config: config(["description", "mermaid"]) });
    const allDirect = estimateTargetCost(hosted, "chart-data", scope, undefined, undefined, {
      config: config(["description", "mermaid", "vega-lite", "matplotlib", "csv"]),
      modes: { description: "direct", mermaid: "direct", "vega-lite": "direct", matplotlib: "direct", csv: "direct" },
    });
    expect(derived.costUsd).toBeGreaterThan(off.costUsd);
    expect(allDirect.costUsd).toBeGreaterThan(derived.costUsd);
    expect(chartExportCallEstimate("chart", { formats: ["mermaid", "csv"] }, { description: "derived", mermaid: "derived", "vega-lite": "derived", matplotlib: "derived", csv: "derived" }).calls).toBeCloseTo(1.1);
    // A diagram never asks for data formats.
    expect(chartExportCallEstimate("diagram", { formats: ["csv", "matplotlib"] }, { description: "direct", mermaid: "direct", "vega-lite": "direct", matplotlib: "direct", csv: "direct" }).calls).toBe(0);
    // Off, or diagrams opted out: the role's usual estimate.
    expect(estimateTargetCost(hosted, "diagram", scope, undefined, undefined, { config: config(["mermaid"], { diagrams: false }) }).costUsd)
      .toBe(estimateTargetCost(hosted, "diagram", scope).costUsd);
  });
});

describe("router estimators with chart export", () => {
  it("price chart roles as generator calls when the project exports charts", () => {
    const pack = testPack();
    const target = testCatalog().find((t) => t.kind === "hosted-vlm" && t.roles.includes("chart-data"))!;
    const ctx = { page: makePage({ pageNumber: 2, words: 300, images: [{ coverage: 0.3 }] }), role: "chart-data" as const, scope: { kind: "image", imageIndex: 0 } as const, target, probs: {} };
    const chartExport = { config: config(["description", "mermaid", "csv"]) };
    for (const [plain, exporting] of [
      [createPolicyEstimator(pack), createPolicyEstimator(pack, { chartExport })],
      [createBaselineEstimator(pack), createBaselineEstimator(pack, chartExport)],
    ] as const) {
      const before = plain(ctx as never);
      const after = exporting(ctx as never);
      expect(before).not.toBeNull();
      expect(after!.expectedCostUsd).toBeGreaterThan(before!.expectedCostUsd);
    }
  });
});

describe("generator model selection", () => {
  const catalog = testCatalog();

  it("picks the first admitted candidate in preference order and refuses overrides outside the allowlist or ceiling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The test catalog prices GPT-6 Luna at $10/M output: over the ceiling, so the next admitted candidate wins (the test
    // catalog has no DeepSeek 1017 target, so GLM).
    const chosen = selectGeneratorModel({ kind: "chart", catalog });
    expect(chosen).toMatchObject({ reason: "preferred-candidate", modelUri: "llm://openrouter/z-ai/glm-5.3-flash" });
    const live = catalog.map((t) => t.ref.modelUri === "llm://openrouter/openai/gpt-6-luna" ? { ...t, pricing: { ...t.pricing, inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 } } : t);
    expect(selectGeneratorModel({ kind: "diagram", catalog: live })?.modelUri).toBe("llm://openrouter/openai/gpt-6-luna");
    // The ceiling is $2/M output: a preferred candidate priced at $3/M is skipped.
    expect(CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK).toBe(2);
    const pricier = catalog.map((t) => t.ref.modelUri === "llm://openrouter/openai/gpt-6-luna" ? { ...t, pricing: { ...t.pricing, inputUsdPerMTok: 0.1, outputUsdPerMTok: 3 } } : t);
    expect(selectGeneratorModel({ kind: "chart", catalog: pricier })?.modelUri).toBe("llm://openrouter/z-ai/glm-5.3-flash");
    // Gemini 3.1 Flash Lite is admitted by the routing catalog but is no longer a chart generator (2026-11-13).
    expect(CHART_GENERATOR_CANDIDATES).not.toContain("llm://openrouter/google/gemini-3.1-flash-lite");
    expect(selectGeneratorModel({ kind: "chart", catalog, envModel: "google/gemini-3.1-flash-lite" })?.reason).toBe("preferred-candidate");
    const proOverride = selectGeneratorModel({ kind: "chart", catalog, projectModel: "llm://openrouter/openai/gpt-6-sol-pro" });
    expect(proOverride?.reason).toBe("preferred-candidate");
    // Admitted by the routing catalog, but not a chart generator: refused.
    expect(selectGeneratorModel({ kind: "chart", catalog, projectModel: "google/gemini-3.5-flash" })?.reason).toBe("preferred-candidate");
    // A candidate over the output-price ceiling is refused as an override too.
    expect(selectGeneratorModel({ kind: "chart", catalog, projectModel: "openai/gpt-6-luna" })?.reason).toBe("preferred-candidate");
    const env = selectGeneratorModel({ kind: "chart", catalog, envModel: "z-ai/glm-5.3-flash" });
    expect(env).toMatchObject({ reason: "env-override", modelUri: "llm://openrouter/z-ai/glm-5.3-flash" });
    // Not on the allowlist: not an eval finalist.
    expect(CHART_GENERATOR_CANDIDATES).not.toContain("llm://openrouter/google/gemini-3.5-flash-lite");
    expect(selectGeneratorModel({ kind: "chart", catalog, envModel: "google/gemini-3.5-flash-lite" })?.reason).toBe("preferred-candidate");
    expect(selectGeneratorModel({ kind: "chart", catalog: [] })).toBeNull();
    // Logged model strings carry no raw control characters (log injection).
    selectGeneratorModel({ kind: "chart", catalog, projectModel: "evil\n[ai-usage] forged line" });
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toMatch(/evil\n\[ai-usage\]/);
    expect(logged).toContain('model="evil?[ai-usage] forged line"');
    warn.mockRestore();
  });

  it("lists only candidates with a list price at or under the ceiling", () => {
    const prices = (JSON.parse(readFileSync(new URL("../../../scripts/lib/model-prices.json", import.meta.url), "utf8")) as { models: Record<string, { output: number; prohibited?: string }> }).models;
    for (const uri of [...CHART_GENERATOR_CANDIDATES, ...DIAGRAM_GENERATOR_CANDIDATES]) {
      const id = uri.replace(/^llm:\/\/openrouter\//, "");
      expect(prices[id], id).toBeDefined();
      expect(prices[id]!.prohibited, id).toBeUndefined();
      expect(prices[id]!.output, id).toBeLessThanOrEqual(CHART_EXPORT_MAX_OUTPUT_USD_PER_MTOK);
    }
  });

  it("strips the project's remote vision fallback from chart calls", () => {
    const vision = { ...defaultPipelineFeatures.vision, remoteFallbackModelUri: "llm://openrouter/google/gemini-3.5-flash" };
    const config = chartExportVisionConfig(vision as never, "llm://openrouter/openai/gpt-6-luna");
    expect(config.modelUri).toBe("llm://openrouter/openai/gpt-6-luna");
    expect(config.remoteFallbackModelUri).toBeNull();
  });

  it("reads the project option tolerantly", () => {
    expect(chartExportConfigOf({}).enabled).toBe(false);
    expect(chartExportConfigOf({ chartExport: { enabled: "yes" } }).enabled).toBe(false);
    expect(chartExportConfigOf({ chartExport: { enabled: true } }).formats).toEqual(["description", "mermaid"]);
  });

  it("is off everywhere while the DOCSLURP_CHART_EXPORT kill switch is off", () => {
    const pipeline = { chartExport: { enabled: true } };
    for (const flag of [undefined, "off", "false", "0", "no", ""]) {
      const env = { DOCSLURP_CHART_EXPORT: flag };
      expect(chartExportConfigOf(pipeline, env).enabled).toBe(false);
      expect(chartExportActive(pipeline, env)).toBe(false);
    }
    expect(chartExportConfigOf(pipeline, { DOCSLURP_CHART_EXPORT: "on" }).enabled).toBe(true);
    expect(chartExportActive(pipeline, { DOCSLURP_CHART_EXPORT: "on" })).toBe(true);
    expect(chartExportActive({ chartExport: { enabled: false } }, { DOCSLURP_CHART_EXPORT: "on" })).toBe(false);
  });
});

// ---- Document pass ------------------------------------------------------------------------------------------

function memoryStorage() {
  const objects = new Map<string, unknown>();
  const bucket = "test-bucket";
  return {
    objects,
    bucket,
    uri: (key: string) => `s3://${bucket}/${key}`,
    async getJson(key: string) {
      if (!objects.has(key)) throw new Error(`missing ${key}`);
      return structuredClone(objects.get(key));
    },
    async putJson(key: string, value: unknown) { objects.set(key, structuredClone(value)); },
    async putBytes(key: string, bytes: Buffer) { objects.set(key, bytes.toString("utf8")); },
    async deleteKeys() { /* unused */ },
  };
}

function seedDocument(storage: ReturnType<typeof memoryStorage>) {
  const markdown = "Page one text.\fPage two talks about revenue.\fPage three.";
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text: markdown, pageCount: 3, extractor: "test" });
  const contract = buildExtractionContract({ documentId: "doc-1", markdown, extractor: "test", strategy: "test", extractionTimeMs: 1, pageCount: 3, canonicalDocument: canonical });
  storage.objects.set("u/run/canonical.json", canonical);
  storage.objects.set("u/run/contract.json", contract);
  const ledger = DocumentArtifactLedger.create({});
  ledger.recordDocument("doc-1", "canonical-document", storage.uri("u/run/canonical.json"));
  ledger.recordDocument("doc-1", "extraction-contract", storage.uri("u/run/contract.json"));
  return ledger;
}

const plan = {
  assignments: [
    { pageNumber: 2, role: "chart-data", scope: { kind: "image", imageIndex: 0 }, targetId: "t", cascade: [] },
    { pageNumber: 3, role: "diagram", scope: { kind: "image", imageIndex: 1 }, targetId: "t", cascade: [] },
    { pageNumber: 1, role: "extract-text", scope: { kind: "page" }, targetId: "t", cascade: [] },
  ],
} as unknown as RoutePlan;

function figureIndexOn(pages: number[], format: "svg" | "png" = "png") {
  return {
    version: "docslurp-doppler-figures@1", documentId: "doc-1", markers: [],
    figures: pages.map((page, i) => ({
      id: `p${page}.g${i}`, page, bbox: [0, 0, 10, 10], kind: format === "svg" ? "vector" : "picture", fate: "kept", format,
      mediaType: format === "svg" ? "image/svg+xml" : "image/png", bytes: 100, sha256: "a".repeat(64), width: 10, height: 10, fileOf: `p${page}.g${i}`, slot: `doppler-figure:p${page}.g${i}`,
    })),
  };
}

describe("document pass", () => {
  it("records free candidate stats with export off, without calling a model or the extractor", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const client = fakeClient([]);
    const extractor = vi.fn(async () => ({ partials: [] }));
    const previous = setDeterministicVisualExtractor(extractor);
    try {
      const session = new ChartExportSession({ documentId: "doc-1", config: defaultChartExportConfig, catalog: () => testCatalog(), client, recordUsage: () => undefined });
      const result = await runChartExportPass({
        session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
        storage: storage as never, ledger, routedPlan: plan, legacyPages: [], pageImage: async () => null,
      });
      expect(result.stats).toEqual({ charts: 1, diagrams: 1, pagesWithUnexportedVisuals: [2, 3], exported: 0, bySource: {} });
      expect(client.requests).toHaveLength(0);
      expect(extractor).not.toHaveBeenCalled();
      expect(result.artifactUri).toBeNull();
    } finally {
      setDeterministicVisualExtractor(previous);
    }
  });

  it("counts keyword-only legacy chart pages as low confidence, never as priced candidates", async () => {
    const storage = memoryStorage();
    const session = new ChartExportSession({ documentId: "doc-1", config: defaultChartExportConfig, catalog: () => [], client: null, recordUsage: () => undefined });
    const result = await runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
      storage: storage as never, ledger: seedDocument(storage), routedPlan: null,
      legacyPages: [{ pageNumber: 1, route: "text-heavy" }, { pageNumber: 3, route: "chart-or-figure" }], pageImage: async () => null,
    });
    expect(result.stats.charts).toBe(0);
    expect(result.lowConfidence).toBe(1);
    expect(result.stats.pagesWithUnexportedVisuals).toEqual([]);
  });

  it("without routed vision, exports router candidates from page rasters, one per page, honouring the diagram opt-out", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const previous = setDeterministicVisualExtractor(async () => ({ partials: [] }));
    const rasters: number[] = [];
    try {
      const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "csv"], { diagrams: false }), catalog: () => testCatalog(), client, recordUsage: () => undefined });
      const result = await runChartExportPass({
        session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
        storage: storage as never, ledger, routedPlan: plan, legacyPages: [],
        pageImage: async (page) => { rasters.push(page); return { path: "/x.png", mimeType: "image/png", release: async () => undefined }; },
      });
      // Page 2 holds a chart (exported); page 3 only a diagram, which the project opted out of.
      expect(rasters).toEqual([2]);
      expect(client.requests).toHaveLength(1);
      expect(result.changedPages).toEqual([2]);
    } finally {
      setDeterministicVisualExtractor(previous);
    }
  });

  it("exports confirmed legacy pages and Office charts, appends Markdown and fills charts[]", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    // A Doppler figure on page 2 confirms its keyword route.
    storage.objects.set("u/run/figures.json", figureIndexOn([2]));
    ledger.recordDocument("doc-1", "doppler-figures", storage.uri("u/run/figures.json"));
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const usage: WorkerAiUsageInput[] = [];
    const previous = setDeterministicVisualExtractor(async () => ({
      partials: [{ source: "office-chart-xml", confidence: 1, spec: { ...BAR_SPEC, title: "Headcount" } as never, digest: null, pageNumber: 1 }],
      presence: { officeChartParts: 1 },
    }));
    const released: number[] = [];
    try {
      const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "csv"]), catalog: () => testCatalog(), client, recordUsage: (u) => usage.push(u) });
      const result = await runChartExportPass({
        session, document: { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 }, run: { id: "run", storagePrefix: "u/run" },
        storage: storage as never, ledger, routedPlan: null, legacyPages: [{ pageNumber: 2, route: "chart-or-figure" }],
        pageImage: async (page) => ({ path: "/x.png", mimeType: "image/png", release: async () => { released.push(page); } }),
      });
      expect(released).toEqual([2]);
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.prompt).toContain("may contain a chart or a diagram");
      expect(usage).toHaveLength(1);
      expect(result.changedPages).toEqual([1, 2]);
      expect(result.stats).toMatchObject({ charts: 2, exported: 2, bySource: { vision: 1, "office-chart-xml": 1 }, pagesWithUnexportedVisuals: [] });

      const contractKey = ledger.readDocument("doc-1", "extraction-contract")!.replace("s3://test-bucket/", "");
      const contract = extractionContractSchema.parse(storage.objects.get(contractKey));
      expect(contract.charts.map((c) => [c.pageNumber, (c.data as { source: string }).source])).toEqual([[2, "vision"], [1, "office-chart-xml"]]);
      expect(contract.markdown).toContain("Page two talks about revenue.");
      expect(contract.markdown).toContain("```csv\nx,Revenue (USD m)\nQ1,10");
      const markdownKey = ledger.readDocument("doc-1", "markdown")!.replace("s3://test-bucket/", "");
      expect(String(storage.objects.get(markdownKey))).toContain("Headcount");
      const artifact = storage.objects.get(ledger.readDocument("doc-1", "chart-export")!.replace("s3://test-bucket/", "")) as Record<string, unknown>;
      expect(artifact[VISUAL_CANDIDATE_STATS_KEY]).toEqual(result.stats);
    } finally {
      setDeterministicVisualExtractor(previous);
    }
  });

  it("routes chart crops through the generator and skips diagrams the project opted out of", async () => {
    const client = fakeClient([JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "mermaid"], { diagrams: false }), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const chart = await session.exportRouted({ assignment: plan.assignments[0]!, assignmentIndex: 0, image });
    expect(chart.result?.text).toContain("```mermaid");
    expect(chart.result?.text).toMatch(/^<!-- docslurp:visual p2-i0 [0-9a-f]{16} -->/);
    expect(chart.result?.inputTokens).toBe(1234);
    expect(chart.modelCalled).toBe(true);
    expect(session.routedIds.has("p2-i0")).toBe(true);
    const diagram = await session.exportRouted({ assignment: plan.assignments[1]!, assignmentIndex: 1, image });
    expect(diagram).toMatchObject({ result: null, modelCalled: false });
    expect(client.requests).toHaveLength(1);
  });
});

describe("routed crops whose generator call got no answer (council round 2, N3)", () => {
  it("falls through to the role's usual read when no call was answered; a `none` answer spends the crop", async () => {
    const unanswered = new ChartExportSession({ documentId: "doc-1", config: config(["description"]), catalog: () => testCatalog(), client: fakeClient([new Error("provider timeout")]), recordUsage: () => undefined });
    const failed = await unanswered.exportRouted({ assignment: plan.assignments[0]!, assignmentIndex: 0, image });
    expect(failed).toMatchObject({ result: null, modelCalled: false });
    expect(unanswered.modelReads.size).toBe(0);
    const none = new ChartExportSession({ documentId: "doc-1", config: config(["description"]), catalog: () => testCatalog(), client: fakeClient(['{"kind":"none"}']), recordUsage: () => undefined });
    const spent = await none.exportRouted({ assignment: plan.assignments[0]!, assignmentIndex: 0, image });
    expect(spent).toMatchObject({ result: null, modelCalled: true });
    expect([...none.modelReads.keys()]).toEqual(["p2-i0"]);
  });
});

// ---- Council fixes (F2): duplicates, reprocess idempotence, caps, stats --------------------------------------

const PDF_DOC = { id: "doc-1", userId: "u", mimeType: "application/pdf", pageCount: 3 };
const svgPartial = (page: number, confidence = 0.9): DeterministicVisualPartial => ({ source: "svg-geometry", confidence, spec: BAR_SPEC as never, digest: "bars: Q1=10", pageNumber: page, imageIndex: null, kind: "chart" });

async function withExtractor<T>(partials: DeterministicVisualPartial[], fn: () => Promise<T>, presence?: { officeChartParts?: number }): Promise<T> {
  const previous = setDeterministicVisualExtractor(async () => ({ partials, ...(presence ? { presence } : {}) }));
  try {
    return await fn();
  } finally {
    setDeterministicVisualExtractor(previous);
  }
}

const pageImageStub = (rendered: number[] = []) => async (page: number) => { rendered.push(page); return { path: `/page-${page}.png`, mimeType: "image/png", release: async () => undefined }; };

describe("duplicate visuals (council H2)", () => {
  it("a keyword page and an SVG partial on the same page export ONE visual, from the free spec, with no model call", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const client = fakeClient([]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "mermaid"]), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    await withExtractor([svgPartial(3)], () => runChartExportPass({
      session, document: PDF_DOC, run: { id: "run", storagePrefix: "u/run" }, storage: storage as never, ledger,
      routedPlan: null, legacyPages: [{ pageNumber: 3, route: "chart-or-figure" }], pageImage: pageImageStub(),
    }));
    expect(session.visuals.map((v) => `${v.id}/${v.source}/p${v.pageNumber}`)).toEqual(["p3-page/svg-geometry/p3"]);
    expect(client.requests).toHaveLength(0);
  });

  it("a routed crop sees the partial prepared before the body: one visual, no model call, not appended twice", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const client = fakeClient([]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "mermaid"]), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    const input = { session, document: PDF_DOC, run: { id: "run", storagePrefix: "u/run" }, storage: storage as never, ledger, routedPlan: null, legacyPages: [], pageImage: pageImageStub() };
    await withExtractor([svgPartial(3)], async () => {
      const prepared = await prepareChartExport(input);
      const routed = await session.exportRouted({ assignment: { role: "chart-data", scope: { kind: "image", imageIndex: 0 }, pageNumber: 3 }, assignmentIndex: 0, image });
      expect(routed.modelCalled).toBe(false);
      expect(routed.result?.text).toContain("```mermaid");
      const result = await finishChartExport(input, prepared);
      expect(result.stats).toMatchObject({ charts: 1, exported: 1, bySource: { "svg-geometry": 1 } });
    });
    expect(session.visuals.map((v) => `${v.id}/${v.source}`)).toEqual(["p3-i0/svg-geometry"]);
    expect(client.requests).toHaveLength(0);
    // The routed insert is the body's; nothing is appended for it.
    expect(ledger.readDocument("doc-1", "canonical-document")).toBe(storage.uri("u/run/canonical.json"));
  });

  it("the same image found by the router and by image routing counts once (placement or index)", () => {
    const session = new ChartExportSession({ documentId: "doc-1", config: defaultChartExportConfig, catalog: () => [], client: null, recordUsage: () => undefined });
    session.addCandidates([
      { id: "p2-i0", pageNumber: 2, imageIndex: 0, bbox: { x: 10, y: 10, width: 100, height: 80 }, kind: "chart", detectedBy: "router-inset" },
      { id: "p2-i1", pageNumber: 2, imageIndex: 1, bbox: null, kind: "diagram", detectedBy: "router-inset" },
    ]);
    session.addCandidates([
      { id: "p2-o0", pageNumber: 2, imageIndex: null, occurrence: 4, bbox: { x: 12, y: 11, width: 98, height: 80 }, kind: null, detectedBy: "image-routing" },
      { id: "p2-o1", pageNumber: 2, imageIndex: null, occurrence: 1, bbox: null, kind: null, detectedBy: "image-routing" },
      { id: "p3-o0", pageNumber: 3, imageIndex: null, occurrence: 0, bbox: null, kind: null, detectedBy: "image-routing" },
    ]);
    expect(session.stats()).toMatchObject({ charts: 2, diagrams: 1 });
  });
});

describe("pairing partials with candidates (council round 2, detail N1)", () => {
  const titled = (title: string, ys: number[]) => ({ ...BAR_SPEC, title, series: [{ name: title, points: ys.map((y, i) => ({ x: `Q${i + 1}`, y })) }], summary: title });
  const svg = (title: string, ys: number[], bbox: { x: number; y: number; width: number; height: number } | null): DeterministicVisualPartial =>
    ({ source: "svg-geometry", confidence: 0.95, spec: titled(title, ys) as never, digest: null, pageNumber: 3, imageIndex: null, kind: "chart", bbox });
  const insets: VisualCandidate[] = [
    { id: "p3-i0", pageNumber: 3, imageIndex: 0, bbox: { x: 50, y: 50, width: 200, height: 100 }, kind: "chart", detectedBy: "router-inset" },
    { id: "p3-i1", pageNumber: 3, imageIndex: 1, bbox: { x: 50, y: 400, width: 200, height: 100 }, kind: "chart", detectedBy: "router-inset" },
  ];
  const run = async (partials: DeterministicVisualPartial[], candidates: VisualCandidate[], answers: string[] = []) => {
    const client = fakeClient(answers);
    const session = new ChartExportSession({ documentId: "d", config: config(["description", "csv"]), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates(candidates);
    session.setDeterministic({ partials });
    for (const c of [...session.candidates]) await session.exportWithImage(c, image);
    await session.exportUnmatchedDeterministic();
    return { session, client, byId: Object.fromEntries(session.visuals.map((v) => [v.id, (v.spec as { title?: string } | null)?.title ?? null])) };
  };

  it("two charts on one page, figures listed bottom-first: each inset gets its own figure's data by placement", async () => {
    // Doppler figure boxes come from the figure index ([x0, y0, x1, y1] -> x, y, width, height), close to the insets.
    const { byId, client } = await run([svg("Bottom: Revenue", [7, 8, 9], { x: 52, y: 398, width: 198, height: 104 }), svg("Top: Bookings", [1, 2, 3], { x: 48, y: 52, width: 204, height: 96 })], insets);
    expect(byId).toEqual({ "p3-i0": "Top: Bookings", "p3-i1": "Bottom: Revenue" });
    expect(client.requests).toHaveLength(0);
  });

  it("without geometry two partials and two candidates are ambiguous: no pairing, partials stand alone, candidates go to the model", async () => {
    const { byId, client } = await run([svg("Bottom: Revenue", [7, 8, 9], null), svg("Top: Bookings", [1, 2, 3], null)], insets, [JSON.stringify(titled("Read top", [1, 2, 3])), JSON.stringify(titled("Read bottom", [7, 8, 9]))]);
    expect(byId).toEqual({ "p3-i0": "Read top", "p3-i1": "Read bottom", "p3-d1": "Bottom: Revenue", "p3-d2": "Top: Bookings" });
    expect(client.requests).toHaveLength(2);
  });

  it("a raster chart and an unrelated vector figure elsewhere on the page are not paired", async () => {
    const { byId, client } = await run([svg("Vector figure elsewhere", [5, 5], { x: 300, y: 600, width: 100, height: 80 })], [insets[0]!], [JSON.stringify(titled("Raster chart", [4, 6]))]);
    expect(byId).toEqual({ "p3-i0": "Raster chart", "p3-d1": "Vector figure elsewhere" });
    expect(client.requests).toHaveLength(1);
  });

  it("an exact image index wins; a one-to-one page without geometry still pairs", async () => {
    const indexed = { ...svg("Second inset", [2, 2], null), imageIndex: 1 };
    expect((await run([svg("Other", [1], null), indexed], insets, [JSON.stringify(titled("Read top", [1]))])).byId).toMatchObject({ "p3-i1": "Second inset" });
    // Neither side placed (a placement on one side only is not a match: council round 3, R3-1).
    expect((await run([svg("Only figure", [3, 4], null)], [{ ...insets[0]!, bbox: null }])).byId).toEqual({ "p3-i0": "Only figure" });
  });
});

describe("pairing partials with candidates (council round 3)", () => {
  const titled = (title: string) => ({ ...BAR_SPEC, title, series: [{ name: title, points: [{ x: "Q1", y: 1 }] }], summary: title });
  const partial = (title: string, extra: Partial<DeterministicVisualPartial>): DeterministicVisualPartial =>
    ({ source: "svg-geometry", confidence: 0.9, spec: titled(title) as never, digest: null, pageNumber: 5, imageIndex: null, kind: "chart", bbox: null, ...extra });
  const run = async (candidates: VisualCandidate[], partials: DeterministicVisualPartial[], answers: string[] = []) => {
    const client = fakeClient(answers);
    const session = new ChartExportSession({ documentId: "d", markerNonce: "0123456789abcdef", config: config(["description", "csv"]), catalog: () => testCatalog(), client, recordUsage: () => undefined });
    session.addCandidates(candidates);
    session.setDeterministic({ partials });
    for (const c of [...session.candidates]) await session.exportWithImage(c, image);
    await session.exportUnmatchedDeterministic();
    return { client, byId: Object.fromEntries(session.visuals.map((v) => [v.id, (v.spec as { title?: string } | null)?.title ?? null])) };
  };

  it("R3-1: an unplaced media-map image and a placed SVG figure on the same page are not paired", async () => {
    const { byId, client } = await run(
      [{ id: "p5-o0", pageNumber: 5, imageIndex: null, occurrence: 0, bbox: null, kind: "chart", detectedBy: "image-routing" }],
      [partial("Vector elsewhere", { bbox: { x: 300, y: 600, width: 100, height: 80 } })],
      [JSON.stringify(titled("Raster read"))],
    );
    expect(byId).toEqual({ "p5-o0": "Raster read", "p5-d1": "Vector elsewhere" });
    expect(client.requests).toHaveLength(1);
  });

  it("R3-1: a placed crop and an unplaced partial are not paired; neither is a media-map image and an unplaced SVG figure", async () => {
    const placed = await run([{ id: "p5-i0", pageNumber: 5, imageIndex: 0, bbox: { x: 50, y: 50, width: 200, height: 100 }, kind: "chart", detectedBy: "router-inset" }], [partial("Unplaced", {})], [JSON.stringify(titled("Crop read"))]);
    expect(placed.byId).toEqual({ "p5-i0": "Crop read", "p5-d1": "Unplaced" });
    const raster = await run([{ id: "p5-o0", pageNumber: 5, imageIndex: null, occurrence: 0, bbox: null, kind: null, detectedBy: "image-routing" }], [partial("Vector", {})], [JSON.stringify(titled("Raster read"))]);
    expect(raster.byId).toEqual({ "p5-o0": "Raster read", "p5-d1": "Vector" });
  });

  it("R3-2: a shifted router crop that includes the caption (IoU below 0.5) still pairs by containment", async () => {
    // 85% of the figure lies in the crop; the crop is about twice the figure's area; IoU is about 0.41.
    const crop = { x: 80, y: 30, width: 200, height: 190 };
    const { byId, client } = await run(
      [{ id: "p5-i0", pageNumber: 5, imageIndex: 0, bbox: crop, kind: "chart", detectedBy: "router-inset" }],
      [partial("Same chart", { bbox: { x: 50, y: 50, width: 200, height: 100 } })],
    );
    expect(byId).toEqual({ "p5-i0": "Same chart" });
    expect(client.requests).toHaveLength(0);
    expect(placementMatch(crop, { x: 50, y: 50, width: 200, height: 100 })).toBeGreaterThan(0);
    expect(placementMatch({ x: 50, y: 50, width: 200, height: 100 }, { x: 50, y: 500, width: 200, height: 100 })).toBe(0);
  });

  it("round 4, adv N1: a large region holding a small figure is not that figure; nor is a small crop inside a large figure", async () => {
    const region = { x: 0, y: 0, width: 600, height: 400 };
    const inset = { x: 20, y: 20, width: 120, height: 80 };
    // Fully contained, but 4% of the region's area.
    expect(placementMatch(region, inset)).toBe(0);
    expect(placementMatch(inset, region)).toBe(0);
    const big = await run(
      [{ id: "p5-a0", pageNumber: 5, imageIndex: null, bbox: region, kind: "chart", detectedBy: "router-region" }],
      [partial("Small vector inset", { bbox: inset })],
      [JSON.stringify(titled("Region read"))],
    );
    expect(big.byId).toEqual({ "p5-a0": "Region read", "p5-d1": "Small vector inset" });
    expect(big.client.requests).toHaveLength(1);
    const small = await run(
      [{ id: "p5-a0", pageNumber: 5, imageIndex: null, bbox: inset, kind: "chart", detectedBy: "router-region" }],
      [partial("Large vector figure", { bbox: region })],
      [JSON.stringify(titled("Inset read"))],
    );
    expect(small.byId).toEqual({ "p5-a0": "Inset read", "p5-d1": "Large vector figure" });
  });

  it("F3: an Office partial without a page does not pair with a page-1 candidate; it is exported on its own", async () => {
    const { byId, client } = await run(
      [{ id: "p1-i0", pageNumber: 1, imageIndex: 0, bbox: { x: 50, y: 50, width: 200, height: 100 }, kind: "chart", detectedBy: "router-inset" }],
      [partial("Office chart from page 7", { source: "office-chart-xml", confidence: 0.95, pageNumber: null })],
      [JSON.stringify(titled("Page 1 raster"))],
    );
    expect(byId).toEqual({ "p1-i0": "Page 1 raster", "u-d1": "Office chart from page 7" });
    expect(client.requests).toHaveLength(1);
    const unplaced = await run(
      [{ id: "p1-o0", pageNumber: 1, imageIndex: null, occurrence: 0, bbox: null, kind: "chart", detectedBy: "image-routing" }],
      [partial("Office chart", { source: "office-chart-xml", confidence: 0.95, pageNumber: undefined })],
      [JSON.stringify(titled("Page 1 raster"))],
    );
    expect(unplaced.byId).toEqual({ "p1-o0": "Page 1 raster", "u-d1": "Office chart" });
  });

  it("a whole-page legacy candidate still takes the page's only placed figure", async () => {
    const { byId, client } = await run(
      [{ id: "p5-page", pageNumber: 5, imageIndex: null, bbox: null, kind: null, detectedBy: "legacy-page-route" }],
      [partial("Vector figure", { bbox: { x: 50, y: 500, width: 200, height: 100 } })],
    );
    expect(byId).toEqual({ "p5-page": "Vector figure" });
    expect(client.requests).toHaveLength(0);
  });
});

describe("whole-page legacy candidates and middling figures (council round 4, adv N3 / detail N2)", () => {
  const spec = (title: string, series: string, points: Array<[string, number]>) => ({ ...BAR_SPEC, title, series: [{ name: series, points: points.map(([x, y]) => ({ x, y })) }], summary: title });
  const figureA = (confidence: number): DeterministicVisualPartial => ({
    source: "svg-geometry", confidence, spec: spec("A: vector", "A", [["Q1", 1], ["Q2", 2], ["Q3", 3]]) as never, digest: "bars: Q1=1 Q2=2 Q3=3",
    pageNumber: 5, imageIndex: null, kind: "chart", bbox: { x: 50, y: 500, width: 200, height: 100 },
  });
  // The whole page also shows chart B (same shape as A), which no other candidate covers.
  const answerB = JSON.stringify(spec("B: raster", "B revenue", [["Jan", 70], ["Feb", 80], ["Mar", 90]]));
  const pageCandidate = (): VisualCandidate => ({ id: "p5-page", pageNumber: 5, imageIndex: null, bbox: null, kind: null, detectedBy: "legacy-page-route" });
  const session = (client: ChartModelClient) => new ChartExportSession({ documentId: "d", markerNonce: "0123456789abcdef", config: config(["description", "csv"]), catalog: () => testCatalog(), client, recordUsage: () => undefined });
  const ys = (v: { spec: unknown }) => (v.spec as { series: Array<{ points: Array<{ y: number }> }> }).series[0]!.points.map((p) => p.y);

  it("a whole-page read never carries a middling figure's digest or numbers: the page is read alone, the figure stands alone", async () => {
    for (const confidence of [0.5, 0.7]) {
      const client = fakeClient([answerB]);
      const s = session(client);
      s.addCandidates([pageCandidate()]);
      s.setDeterministic({ partials: [figureA(confidence)] });
      s.resolveLegacyPages(new Set([5]));
      await s.exportWithImage(s.candidates[0]!, { path: "/page5-whole.png", mimeType: "image/png" }, undefined, { wholePage: true });
      await s.exportUnmatchedDeterministic();
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]!.prompt).not.toContain("Q1=1");
      const page = s.visuals.find((v) => v.id === "p5-page")!;
      expect(page).toMatchObject({ source: "vision" });
      expect(ys(page)).toEqual([70, 80, 90]);
      // The figure is exported on its own when confident enough to stand alone (0.6), never merged into B.
      const own = s.visuals.filter((v) => v.id !== "p5-page");
      if (confidence >= 0.6) {
        expect(own.map((v) => [v.id, v.source, ys(v)])).toEqual([["p5-d1", "svg-geometry", [1, 2, 3]]]);
      } else {
        expect(own).toEqual([]);
      }
    }
  });

  it("a confident figure is still paired with the whole page and used as is, with no model read", async () => {
    const client = fakeClient([]);
    const s = session(client);
    s.addCandidates([pageCandidate()]);
    s.setDeterministic({ partials: [figureA(DETERMINISTIC_HIGH_CONFIDENCE)] });
    s.resolveLegacyPages(new Set([5]));
    await s.exportWithImage(s.candidates[0]!, { path: "/page5-whole.png", mimeType: "image/png" }, undefined, { wholePage: true });
    await s.exportUnmatchedDeterministic();
    expect(client.requests).toHaveLength(0);
    expect(s.visuals.map((v) => [v.id, v.source, ys(v)])).toEqual([["p5-page", "svg-geometry", [1, 2, 3]]]);
  });

  it("the end pass crops a whole-page candidate to its middling figure for the assisted read; without a crop it reads the page alone", async () => {
    const run = async (crop: "ok" | "fails" | "none") => {
      const storage = memoryStorage();
      const ledger = seedDocument(storage);
      const client = fakeClient([JSON.stringify(spec("A: read", "A", [["Q1", 1.1], ["Q2", 2.1], ["Q3", 2.9]]))]);
      const s = session(client);
      s.addCandidates([pageCandidate()]);
      s.setDeterministic({ partials: [figureA(0.7)] });
      s.resolveLegacyPages(new Set([5]));
      const crops: string[] = [];
      await withExtractor([], () => finishChartExport({
        session: s, document: { ...PDF_DOC, pageCount: 5 }, run: { id: "run", storagePrefix: "u/run" }, storage: storage as never, ledger, routedPlan: null, legacyPages: [],
        pageImage: async (page) => ({ path: `/page-${page}.png`, mimeType: "image/png", release: async () => undefined }),
        ...(crop !== "none" ? { cropImage: async (page: { path: string }, bbox: { x: number; y: number }) => {
          crops.push(`${page.path}@${bbox.x},${bbox.y}`);
          return crop === "ok" ? { path: `${page.path}.crop.png`, mimeType: "image/png", release: async () => undefined } : null;
        } } : {}),
      }, { mediaMapUri: null, priorArtifactUri: null }));
      return { client, crops, visuals: s.visuals };
    };
    const cropped = await run("ok");
    expect(cropped.crops).toEqual(["/page-5.png@50,500"]);
    expect(cropped.client.requests.map((r) => r.image.path)).toEqual(["/page-5.png.crop.png"]);
    expect(cropped.client.requests[0]!.prompt).toContain("Q1=1");
    expect(cropped.visuals.map((v) => [v.id, v.source, ys(v)])).toEqual([["p5-page", "svg-assisted", [1, 2, 3]]]);
    for (const mode of ["none", "fails"] as const) {
      const whole = await run(mode);
      expect(whole.client.requests.map((r) => r.image.path)).toEqual(["/page-5.png"]);
      expect(whole.client.requests[0]!.prompt).not.toContain("Q1=1");
      expect(whole.visuals.map((v) => [v.id, v.source, v.bbox])).toEqual([["p5-page", "vision", null], ["p5-d1", "svg-geometry", [50, 500, 200, 100]]]);
    }
  });
});

describe("Office charts on documents without known pages (council round 4, detail N1)", () => {
  const office = (title: string, pageNumber: number | null): DeterministicVisualPartial =>
    ({ source: "office-chart-xml", confidence: 1, spec: { ...BAR_SPEC, title } as never, digest: null, pageNumber, imageIndex: null, kind: "chart" });
  const seed = (storage: ReturnType<typeof memoryStorage>, text: string, pageCount: number) => {
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text, pageCount, extractor: "pandoc" });
    const contract = buildExtractionContract({ documentId: "doc-1", markdown: text, extractor: "pandoc", strategy: "test", extractionTimeMs: 1, pageCount, canonicalDocument: canonical });
    storage.objects.set("u/run/canonical.json", canonical);
    storage.objects.set("u/run/contract.json", contract);
    const ledger = DocumentArtifactLedger.create({});
    ledger.recordDocument("doc-1", "canonical-document", storage.uri("u/run/canonical.json"));
    ledger.recordDocument("doc-1", "extraction-contract", storage.uri("u/run/contract.json"));
    return { ledger, canonical };
  };
  const read = <T,>(storage: ReturnType<typeof memoryStorage>, ledger: DocumentArtifactLedger, slot: string) => storage.objects.get(ledger.readDocument("doc-1", slot)!.replace("s3://test-bucket/", "")) as T;
  type Canonical = ReturnType<typeof buildCanonicalDocumentFromMarkdown>;
  const exportOnce = async (storage: ReturnType<typeof memoryStorage>, ledger: DocumentArtifactLedger, partials: DeterministicVisualPartial[], runId: string, mimeType: string, pageCount: number) => {
    const session = new ChartExportSession({ documentId: "doc-1", config: config(["description", "csv"]), catalog: () => testCatalog(), client: fakeClient([]), recordUsage: () => undefined });
    return await withExtractor(partials, () => runChartExportPass({
      session, document: { id: "doc-1", userId: "u", mimeType, pageCount }, run: { id: runId, storagePrefix: `u/${runId}` }, storage: storage as never, ledger, routedPlan: null, legacyPages: [], pageImage: async () => null,
    }));
  };
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  it("DOCX with unknown pages: the chart is appended unpaged; every other block keeps its page, id and provenance, across reprocesses", async () => {
    const storage = memoryStorage();
    const { ledger, canonical } = seed(storage, "# Intro\n\nAlpha para.\n\n# Section 2\n\nBeta para.\n\n# Section 3\n\nGamma para.", 3);
    expect(canonical.blocks.every((b) => b.pageNumber === null)).toBe(true);
    const original = canonical.blocks.map((b) => [b.id, b.pageNumber, b.text, JSON.stringify(b.metadata)]);
    for (const runId of ["run-1", "run-2"]) {
      const result = await exportOnce(storage, ledger, [office("Headcount", null)], runId, DOCX, 3);
      expect(result.changedPages).toEqual([]);
      const after = read<Canonical>(storage, ledger, "canonical-document");
      expect(after.blocks.slice(0, original.length).map((b) => [b.id, b.pageNumber, b.text, JSON.stringify(b.metadata)])).toEqual(original);
      const added = after.blocks.slice(original.length);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((b) => b.pageNumber === null && b.id.startsWith("doc-1:chart-export:u-d1:"))).toBe(true);
      expect(added.map((b) => b.text).join("\n")).toContain("Headcount");
      // One copy after a reprocess (the previous run's group is removed by its recorded id and nonce).
      expect(after.blocks.filter((b) => b.text.includes("Headcount")).length).toBe(added.filter((b) => b.text.includes("Headcount")).length);
      const contract = extractionContractSchema.parse(read(storage, ledger, "extraction-contract"));
      expect(contract.charts.map((c) => [c.id, c.pageNumber])).toEqual([["chart-u-d1", null]]);
      expect(contract.markdown.match(/Headcount/g)?.length).toBe(after.blocks.filter((b) => b.text.includes("Headcount")).length);
      const artifact = read<{ visuals: Array<{ id: string; pageNumber: number | null }> }>(storage, ledger, "chart-export");
      expect(artifact.visuals.map((v) => [v.id, v.pageNumber])).toEqual([["u-d1", null]]);
    }
    // Export turned off: the unpaged group goes, and the document is as it was.
    expect(await clearChartExport({ document: { id: "doc-1", userId: "u", mimeType: DOCX, pageCount: 3 }, run: { id: "run-3", storagePrefix: "u/run-3" }, storage: storage as never, ledger })).toBe(true);
    expect(read<Canonical>(storage, ledger, "canonical-document").blocks.map((b) => [b.id, b.pageNumber, b.text, JSON.stringify(b.metadata)])).toEqual(original);
  });

  it("PPTX: a slide chart goes on its page when slides map to pages, and is unpaged when they do not", async () => {
    const slides = "## S1\n\nA\n\f\n## S2\n\nB\n\f\n## S3\n\nC";
    const ok = memoryStorage();
    const mapped = seed(ok, slides, 3);
    const okResult = await exportOnce(ok, mapped.ledger, [office("Slide chart", 3)], "run", PPTX, 3);
    expect(okResult.changedPages).toEqual([3]);
    const okAfter = read<Canonical>(ok, mapped.ledger, "canonical-document");
    expect(okAfter.blocks.filter((b) => b.pageNumber !== 3).map((b) => b.id)).toEqual(mapped.canonical.blocks.filter((b) => b.pageNumber !== 3).map((b) => b.id));
    expect(okAfter.blocks.filter((b) => b.text.includes("Slide chart")).every((b) => b.pageNumber === 3)).toBe(true);

    // A text-heavy slide makes the measured page count exceed the slide count: no page is known.
    const mismatch = memoryStorage();
    const unmapped = seed(mismatch, slides, 5);
    expect(unmapped.canonical.blocks.every((b) => b.pageNumber === null)).toBe(true);
    const result = await exportOnce(mismatch, unmapped.ledger, [office("Slide chart", 3)], "run", PPTX, 5);
    expect(result.changedPages).toEqual([]);
    const after = read<Canonical>(mismatch, unmapped.ledger, "canonical-document");
    expect(after.blocks.every((b) => b.pageNumber === null)).toBe(true);
    expect(after.blocks.slice(0, unmapped.canonical.blocks.length).map((b) => b.id)).toEqual(unmapped.canonical.blocks.map((b) => b.id));
    const contract = extractionContractSchema.parse(read(mismatch, unmapped.ledger, "extraction-contract"));
    expect(contract.charts.map((c) => [c.id, c.pageNumber])).toEqual([["chart-p3-d1", null]]);
  });

  it("a pageless chart in a document with known pages is appended unpaged, never onto page 1", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const before = (storage.objects.get("u/run/canonical.json") as Canonical).blocks.map((b) => [b.id, b.pageNumber]);
    const result = await exportOnce(storage, ledger, [office("Sheet chart", null)], "run", PDF_DOC.mimeType, 3);
    expect(result.changedPages).toEqual([]);
    const after = read<Canonical>(storage, ledger, "canonical-document");
    expect(after.blocks.slice(0, before.length).map((b) => [b.id, b.pageNumber])).toEqual(before);
    expect(after.blocks.slice(before.length).every((b) => b.pageNumber === null)).toBe(true);
  });
});

describe("reprocess idempotence (council H3)", () => {
  async function runOnce(ledger: DocumentArtifactLedger, storage: ReturnType<typeof memoryStorage>, formats: ChartExportFormat[], runId: string) {
    const session = new ChartExportSession({ documentId: "doc-1", config: config(formats), catalog: () => testCatalog(), client: fakeClient([]), recordUsage: () => undefined });
    await withExtractor([{ source: "office-chart-xml", confidence: 1, spec: BAR_SPEC as never, digest: null, pageNumber: 2, kind: "chart" }], () => runChartExportPass({
      session, document: PDF_DOC, run: { id: runId, storagePrefix: `u/${runId}` }, storage: storage as never, ledger, routedPlan: null, legacyPages: [], pageImage: async () => null,
    }));
  }
  const reprocessLedger = (from: DocumentArtifactLedger) => DocumentArtifactLedger.create({ ...from.all() });
  const contractOf = (storage: ReturnType<typeof memoryStorage>, ledger: DocumentArtifactLedger) =>
    extractionContractSchema.parse(storage.objects.get(ledger.readDocument("doc-1", "extraction-contract")!.replace("s3://test-bucket/", "")));

  it("reprocessing twice keeps one copy; adding a format replaces the group; turning export off removes it", async () => {
    const storage = memoryStorage();
    const first = seedDocument(storage);
    await runOnce(first, storage, ["description", "csv"], "r1");
    const second = reprocessLedger(first);
    await runOnce(second, storage, ["description", "csv"], "r2");
    const third = reprocessLedger(second);
    await runOnce(third, storage, ["description", "csv"], "r3");
    let contract = contractOf(storage, third);
    expect(contract.markdown.match(/<!-- docslurp:visual p2-d1 [0-9a-f]{16} -->/g)).toHaveLength(1);
    expect(contract.markdown.match(/```csv/g)).toHaveLength(1);
    expect(contract.charts).toHaveLength(1);

    const fourth = reprocessLedger(third);
    await runOnce(fourth, storage, ["description", "csv", "mermaid"], "r4");
    contract = contractOf(storage, fourth);
    expect(contract.markdown.match(/<!-- docslurp:visual p2-d1 [0-9a-f]{16} -->/g)).toHaveLength(1);
    expect(contract.markdown.match(/```csv/g)).toHaveLength(1);
    expect(contract.markdown.match(/```mermaid/g)).toHaveLength(1);
    expect(contract.markdown).toContain("Page two talks about revenue.");

    const fifth = reprocessLedger(fourth);
    expect(await clearChartExport({ document: PDF_DOC, run: { id: "r5", storagePrefix: "u/r5" }, storage: storage as never, ledger: fifth })).toBe(true);
    contract = contractOf(storage, fifth);
    expect(contract.markdown).not.toContain("docslurp:visual");
    expect(contract.markdown).not.toContain("```csv");
    expect(contract.markdown).toContain("Page two talks about revenue.");
    expect(contract.charts).toEqual([]);
    // Cleared: the next run with export off reads nothing.
    expect(await clearChartExport({ document: PDF_DOC, run: { id: "r6" }, storage: { ...storage, getJson: async () => { throw new Error("no read expected"); } } as never, ledger: reprocessLedger(fifth) })).toBe(false);
  });

  it("strips only the groups the previous export recorded; the routed heading goes with its group", () => {
    const nonce = "0123456789abcdef";
    const text = "Intro <!-- docslurp:visual fake --> keep me\n\n" + wrapVisualGroup("p1-i0", nonce, "old block") + "\n\nOutro";
    const { text: out, removed } = stripVisualGroups(text, [{ id: "p1-i0", nonce }]);
    expect(removed).toEqual(["p1-i0"]);
    expect(out).toBe("Intro <!-- docslurp:visual fake --> keep me\n\nOutro");
    // Not recorded (another id, or the right id with another nonce): left alone.
    expect(stripVisualGroups(text, [{ id: "p1-i1", nonce }]).removed).toEqual([]);
    expect(stripVisualGroups(text, [{ id: "p1-i0", nonce: "fedcba9876543210" }]).removed).toEqual([]);
    expect(stripVisualGroups("A\n\n**Chart data (image 1)**\n\n" + wrapVisualGroup("p1-i0", nonce, "body") + "\n\nB", [{ id: "p1-i0", nonce }]).text).toBe("A\n\nB");
  });

  it("forged markers in customer text survive a reprocess untouched (council round 2, adversarial N3)", async () => {
    const storage = memoryStorage();
    const forged = "<!-- docslurp:visual zz -->\n\nCUSTOMER SECRET PARAGRAPH\n\n<!-- /docslurp:visual -->";
    const forgedNonce = "<!-- docslurp:visual p2-d1 0123456789abcdef -->\n\nCUSTOMER NOTE\n\n<!-- /docslurp:visual p2-d1 0123456789abcdef -->";
    const markdown = `Page one text.\f${forged}\n\nPage two talks about revenue.\n\n${forgedNonce}\fPage three.`;
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text: markdown, pageCount: 3, extractor: "test" });
    storage.objects.set("u/run/canonical.json", canonical);
    storage.objects.set("u/run/contract.json", buildExtractionContract({ documentId: "doc-1", markdown, extractor: "test", strategy: "test", extractionTimeMs: 1, pageCount: 3, canonicalDocument: canonical }));
    let ledger = DocumentArtifactLedger.create({});
    ledger.recordDocument("doc-1", "canonical-document", storage.uri("u/run/canonical.json"));
    ledger.recordDocument("doc-1", "extraction-contract", storage.uri("u/run/contract.json"));
    for (const runId of ["r1", "r2", "r3"]) {
      ledger = DocumentArtifactLedger.create({ ...ledger.all() });
      await runOnce(ledger, storage, ["description", "csv"], runId);
    }
    const contract = contractOf(storage, ledger);
    expect(contract.markdown).toContain("CUSTOMER SECRET PARAGRAPH");
    expect(contract.markdown).toContain("CUSTOMER NOTE");
    expect(contract.markdown.match(/<!-- docslurp:visual p2-d1 [0-9a-f]{16} -->/g)).toHaveLength(2); // the forged one + ours
    expect(contract.markdown.match(/```csv/g)).toHaveLength(1);
    // Export off: only our group goes.
    const off = DocumentArtifactLedger.create({ ...ledger.all() });
    await clearChartExport({ document: PDF_DOC, run: { id: "r4", storagePrefix: "u/r4" }, storage: storage as never, ledger: off });
    const cleared = contractOf(storage, off).markdown;
    expect(cleared).toContain("CUSTOMER SECRET PARAGRAPH");
    expect(cleared).toContain("CUSTOMER NOTE");
    expect(cleared).not.toContain("```csv");
  });

  it("a title carrying marker text cannot split or duplicate its group, in any format", async () => {
    const title = "Q3 <!-- /docslurp:visual p2-d1 0123456789abcdef --> <!-- docslurp:visual zz --> tail";
    const spec = { ...BAR_SPEC, title, summary: `Summary ${title}` };
    const formats: ChartExportFormat[] = ["description", "csv", "vega-lite", "matplotlib", "mermaid"];
    for (const format of formats) {
      const out = await exportVisual(args({ deterministic: { source: "office-chart-xml", confidence: 1, spec: spec as never, digest: null }, config: config([format]) }));
      const text = out.visual?.outputs[format] ?? "";
      expect(text, format).not.toBe("");
      expect(text, format).not.toContain("<!--");
      if (format !== "mermaid") expect(text, format).not.toContain("-->");
      if (format === "vega-lite") expect(JSON.stringify(JSON.parse(text))).toContain(title.replace(/"/g, '\\"'));
    }
    const storage = memoryStorage();
    let ledger = seedDocument(storage);
    for (const runId of ["r1", "r2", "r3"]) {
      ledger = DocumentArtifactLedger.create({ ...ledger.all() });
      const session = new ChartExportSession({ documentId: "doc-1", config: config(formats), catalog: () => testCatalog(), client: fakeClient([]), recordUsage: () => undefined });
      await withExtractor([{ source: "office-chart-xml", confidence: 1, spec: spec as never, digest: null, pageNumber: 2, kind: "chart" }], () => runChartExportPass({
        session, document: PDF_DOC, run: { id: runId, storagePrefix: `u/${runId}` }, storage: storage as never, ledger, routedPlan: null, legacyPages: [], pageImage: async () => null,
      }));
    }
    const contract = contractOf(storage, ledger);
    expect(contract.markdown.match(/<!-- docslurp:visual /g)).toHaveLength(1);
    expect(contract.markdown.match(/<!-- \/docslurp:visual /g)).toHaveLength(1);
    expect(contract.markdown.match(/```vega-lite/g)).toHaveLength(1);
    expect(contract.markdown).toContain("Page three.");
  });
});

describe("spend bounds (council M1/M2/M4)", () => {
  it("caps generator calls, not successes: invalid answers count, and the run budget is shared across documents", async () => {
    const client = fakeClient(["not json", "still not json", JSON.stringify(BAR_SPEC)]);
    const runBudget = { calls: 0 };
    const make = (documentId: string) => new ChartExportSession({ documentId, config: config(["description"]), catalog: () => testCatalog(), client, recordUsage: () => undefined, runBudget, limits: { maxCallsPerDocument: 2, maxCallsPerRun: 3 } });
    const a = make("doc-a");
    await a.exportWithImage(candidate, image);
    await a.exportWithImage({ ...candidate, id: "p2-i1", imageIndex: 1 }, image);
    // Spec + repair, both invalid: two calls, nothing exported, and the document cap holds for the next visual.
    expect(client.requests).toHaveLength(2);
    expect(a.visuals).toHaveLength(0);
    const b = make("doc-b");
    await b.exportWithImage(candidate, image);
    await b.exportWithImage({ ...candidate, id: "p2-i1", imageIndex: 1 }, image);
    // One call left in the run budget.
    expect(client.requests).toHaveLength(3);
    expect(runBudget.calls).toBe(3);
    expect(a.calls.every((c) => c.visualId === "p2-i0")).toBe(true);
  });

  it("exports image-routing candidates as crops at the end of the stage, and caps whole-page exports", async () => {
    const storage = memoryStorage();
    const ledger = seedDocument(storage);
    const client = fakeClient([JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC), JSON.stringify(BAR_SPEC)]);
    const session = new ChartExportSession({ documentId: "doc-1", config: config(["description"]), catalog: () => testCatalog(), client, recordUsage: () => undefined, limits: { maxPageExports: 1 } });
    session.addCandidates([
      { id: "p1-o0", pageNumber: 1, imageIndex: null, occurrence: 0, bbox: { x: 0, y: 0, width: 50, height: 50 }, kind: null, detectedBy: "image-routing" },
      { id: "p2-o0", pageNumber: 2, imageIndex: null, occurrence: 0, bbox: null, kind: null, detectedBy: "image-routing" },
      { id: "p3-o0", pageNumber: 3, imageIndex: null, occurrence: 0, bbox: null, kind: null, detectedBy: "image-routing" },
    ]);
    const crops: string[] = [];
    const rendered: number[] = [];
    await withExtractor([], () => finishChartExport({
      session, document: PDF_DOC, run: { id: "run", storagePrefix: "u/run" }, storage: storage as never, ledger, routedPlan: null, legacyPages: [],
      pageImage: pageImageStub(rendered),
      cropImage: async (page, bbox) => { crops.push(`${page.path}@${bbox.x},${bbox.y}`); return { path: `${page.path}.crop.png`, mimeType: "image/png", release: async () => undefined }; },
    }, { mediaMapUri: null, priorArtifactUri: null }));
    expect(crops).toEqual(["/page-1.png@0,0"]);
    expect(client.requests.map((r) => r.image.path)).toEqual(["/page-1.png.crop.png", "/page-2.png"]);
    // Page 3 has no placement and the whole-page cap is spent: no raster, no call.
    expect(rendered).toEqual([1, 2]);
    expect(session.visuals.map((v) => v.id)).toEqual(["p1-o0", "p2-o0"]);
  });

  it("a picture the budget guard downgraded or skipped is not re-read by the end pass, whichever signal lists it (council round 4)", () => {
    const tag = "budget(limit=$0.010000,floor=0.000100)";
    const box = { x: 10, y: 10, width: 200, height: 100 };
    const guardedPlan = { assignments: [
      { role: "chart-data", pageNumber: 2, scope: { kind: "image", imageIndex: 0, bbox: box }, reason: `chart; ${tag} downgraded from vlm:big`, targetId: "vlm:cheap" },
      { role: "skip", pageNumber: 3, scope: { kind: "image", imageIndex: 1 }, reason: `chart; ${tag} skipped chart-data`, targetId: "skip" },
      { role: "skip", pageNumber: 4, scope: { kind: "page" }, reason: `diagram; ${tag} skipped diagram`, targetId: "skip" },
    ] } as unknown as RoutePlan;
    const mediaMap = [
      // Same picture as the downgraded crop (placement), and as the skipped image (occurrence = image index).
      { id: "p2-o0", pageNumber: 2, imageIndex: null, occurrence: 0, bbox: { ...box }, kind: null, detectedBy: "image-routing" },
      { id: "p3-o1", pageNumber: 3, imageIndex: null, occurrence: 1, bbox: null, kind: null, detectedBy: "image-routing" },
      // Any picture on the page whose page-scope role was skipped.
      { id: "p4-o0", pageNumber: 4, imageIndex: null, occurrence: 0, bbox: null, kind: null, detectedBy: "image-routing" },
      // Unrelated pictures stay.
      { id: "p2-o1", pageNumber: 2, imageIndex: null, occurrence: 1, bbox: { x: 10, y: 400, width: 200, height: 100 }, kind: null, detectedBy: "image-routing" },
      { id: "p3-o2", pageNumber: 3, imageIndex: null, occurrence: 2, bbox: null, kind: null, detectedBy: "image-routing" },
    ] satisfies VisualCandidate[];
    const make = () => new ChartExportSession({ documentId: "d", config: config(["csv"]), catalog: () => testCatalog(), client: null, recordUsage: () => undefined });
    // Guarded scopes first (the stage's order), then the media map.
    const ordered = make();
    ordered.addGuardedScopes(guardedScopesFromPlan(guardedPlan));
    ordered.addCandidates(candidatesFromPlan(guardedPlan));
    ordered.addCandidates(mediaMap);
    expect(ordered.pendingCandidates().map((c) => c.id)).toEqual(["p2-o1", "p3-o2"]);
    // A candidate listed before the scopes arrive is dropped too.
    const late = make();
    late.addCandidates(mediaMap);
    late.addGuardedScopes(guardedScopesFromPlan(guardedPlan));
    expect(late.pendingCandidates().map((c) => c.id)).toEqual(["p2-o1", "p3-o2"]);
    expect(late.stats().charts).toBe(2);
  });

  it("Office chart parts seen with export off are priced as free", () => {
    const session = new ChartExportSession({ documentId: "doc-1", config: defaultChartExportConfig, catalog: () => [], client: null, recordUsage: () => undefined });
    session.setDeterministic({ partials: [], presence: { officeChartParts: 3 } });
    expect(session.stats()).toMatchObject({ charts: 3, exported: 0, bySource: { "office-chart-xml": 3 } });
  });
});

describe("chartExportReasoning", () => {
  it("pins the evaluated reasoning per generator and leaves others unset", async () => {
    const { chartExportReasoning } = await import("./model-selection.js");
    expect(chartExportReasoning("llm://openrouter/openai/gpt-6-luna")).toEqual({ effort: "none" });
    expect(chartExportReasoning("llm://openrouter/google/gemini-3.1-flash-lite")).toEqual({ effort: "minimal" });
    expect(chartExportReasoning("llm://openrouter/z-ai/glm-5.3-flash")).toBeUndefined();
  });
});
