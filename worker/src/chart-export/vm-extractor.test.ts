import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { barPlot, chartXml, genericBar, pptx } from "./extractors/__tests__/fixtures.js";
import { CHART_EXPORT_VM_USAGE_METRIC, createVmDeterministicVisualExtractor, deterministicSourceKind, presenceOf, sourceRunReason } from "./vm-extractor.js";
import type { UsageEvent } from "../models.js";
import { billableCents } from "../pipeline/usage-ledger.js";

afterEach(() => vi.unstubAllEnvs());

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SHA = "a".repeat(64);

/** Storage whose downloads write the given bytes to a private docslurp-* temp directory, like the real store. */
function storage(objects: Record<string, Uint8Array | string>, json: Record<string, unknown> = {}) {
  const downloads: string[] = [];
  return {
    downloads,
    bucket: "b",
    async getJson<T>(key: string): Promise<T> {
      if (!(key in json)) throw new Error("missing");
      return structuredClone(json[key]) as T;
    },
    async downloadToTempFile(key: string, pattern: string): Promise<string> {
      if (!(key in objects)) throw new Error(`missing ${key}`);
      const base = process.env.TMPDIR || tmpdir();
      await mkdir(base, { recursive: true });
      const dir = await mkdtemp(path.join(base, "docslurp-vm-extractor-test-"));
      const file = path.join(dir, pattern.replace("*", "x"));
      await writeFile(file, objects[key]!);
      downloads.push(key);
      return file;
    },
  };
}

const slideChart = chartXml({ title: "Revenue", plots: [barPlot([{ name: "Revenue", cats: ["Q1", "Q2"], vals: [10, 12] }])] });

const figureIndex = (figures: Array<{ id: string; page: number; format: "svg" | "png" }>) => ({
  version: "docslurp-doppler-figures@1",
  documentId: "doc",
  markers: [],
  figures: figures.map((f) => ({
    id: f.id, page: f.page, bbox: [0, 0, 10, 10], kind: f.format === "svg" ? "vector" : "picture", fate: "kept", format: f.format,
    mediaType: f.format === "svg" ? "image/svg+xml" : "image/png", bytes: 100, sha256: SHA, width: 10, height: 10, fileOf: f.id, slot: `doppler-figure:${f.id}`,
  })),
});

describe("VM deterministic extractor adapter", () => {
  it("maps document types to guest input kinds", () => {
    expect(deterministicSourceKind(PPTX)).toBe("office");
    expect(deterministicSourceKind("application/epub+zip")).toBe("epub");
    expect(deterministicSourceKind("text/html; charset=utf-8")).toBe("html");
    expect(deterministicSourceKind("image/svg+xml")).toBe("svg");
    expect(deterministicSourceKind("application/pdf")).toBeNull();
    expect(deterministicSourceKind("image/png")).toBeNull();
  });

  it("extracts Office charts from the staged source (in-process outside production) and maps slides to pages", async () => {
    const store = storage({ "src/deck.pptx": pptx([[3, slideChart]]) });
    const extract = createVmDeterministicVisualExtractor({ runner: { run: vi.fn() }, storage: store, log: () => {} });
    const result = await extract({
      document: { id: "doc", mimeType: PPTX, pageCount: 4, sourceKey: "src/deck.pptx" },
      candidates: [], artifacts: { dopplerFiguresIndexUri: null, mediaMapUri: null }, signals: { officeChartParts: 1 },
    });
    expect(result.partials).toHaveLength(1);
    expect(result.partials[0]).toMatchObject({ source: "office-chart-xml", kind: "chart", pageNumber: 3, imageIndex: null });
    expect(result.partials[0]!.spec).toMatchObject({ kind: "chart" });
    expect(result.presence).toEqual({ officeChartParts: 1, embeddedSpecs: 0, svgFigures: 0 });
  });

  it("refuses a source whose bytes do not match the recorded hash before any parsing", async () => {
    const store = storage({ "src/deck.pptx": pptx([[1, slideChart]]) });
    const run = vi.fn();
    const extract = createVmDeterministicVisualExtractor({ runner: { run }, storage: store, log: () => {} });
    await expect(extract({
      document: { id: "doc-hash", mimeType: PPTX, pageCount: 1, sourceKey: "src/deck.pptx", sourceSha256: SHA },
      candidates: [], artifacts: { dopplerFiguresIndexUri: null, mediaMapUri: null }, signals: { officeChartParts: 1 },
    })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("in production sends each input to the parser VM and fails closed (no host parsing) when the VM is down", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = storage(
      { "src/deck.pptx": pptx([[1, slideChart]]), "fig/a.svg": genericBar(["a", "b"], [1, 2], 4), "fig/b.svg": genericBar(["a"], [1], 2) },
      { "run/index.json": figureIndex([{ id: "p2.g0", page: 2, format: "svg" }, { id: "p2.g1", page: 2, format: "svg" }]) },
    );
    const logs: string[] = [];
    const usage: UsageEvent[] = [];
    const run = vi.fn(async () => { throw new Error("no parser VM provider"); });
    const extract = createVmDeterministicVisualExtractor({ runner: { run }, storage: store, log: (m) => logs.push(m) });
    const result = await extract({
      document: { id: "doc", mimeType: PPTX, pageCount: 2, sourceKey: "src/deck.pptx", parseSourceDecision: "original" },
      candidates: [],
      artifacts: { dopplerFiguresIndexUri: "s3://b/run/index.json", mediaMapUri: null, artifactUri: (slot) => (slot.endsWith("p2.g0") ? "s3://b/fig/a.svg" : "s3://b/fig/b.svg") },
      signals: { officeChartParts: 1 },
      recordUsage: (event) => usage.push(event),
    });
    expect(result.partials).toEqual([]);
    // One VM attempt: a guest that is down is not retried for every figure of the document.
    expect(run).toHaveBeenCalledOnce();
    // The refused run's VM time is still recorded, as cost only.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ metric: CHART_EXPORT_VM_USAGE_METRIC, costCents: 0, metadata: { documentId: "doc", outcome: "refused", reason: "office-chart-parts", billable: false } });
    // Refusal logs name the document and why the VM ran, never content.
    expect(logs.some((m) => m.includes("reason=guest-unavailable") && m.includes("document=doc"))).toBe(true);
    expect(logs.some((m) => m.includes("document=doc reason=office-chart-parts"))).toBe(true);
  });

  it("sends every Doppler SVG figure of a document to the guest in one batched VM run, with each figure's page", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = storage(
      { "fig/a.svg": genericBar(["a", "b"], [1, 2], 4), "fig/b.svg": genericBar(["c"], [3], 2), "fig/p.png": "png" },
      { "run/index.json": figureIndex([{ id: "p2.g0", page: 2, format: "svg" }, { id: "p3.g0", page: 3, format: "svg" }, { id: "p1.0", page: 1, format: "png" }]) },
    );
    const one = (x: string) => ({
      schemaVersion: "chart-export-deterministic@v1",
      visuals: [{ source: "svg-geometry", kind: "chart", confidence: 0.9, spec: { kind: "chart", chartType: "bar", series: [{ name: "s", points: [{ x, y: 1 }] }] }, digest: null, locator: "svg", slide: null, sheet: null, generator: null, reason: null }],
      refusals: [],
    });
    const plans: Array<{ args: string[]; timeoutMs?: number }> = [];
    const usage: UsageEvent[] = [];
    const run = vi.fn(async (plan: { args: string[]; timeoutMs?: number }) => {
      plans.push(plan);
      const request = JSON.parse(await readFile(plan.args[3]!, "utf8"));
      expect(request).toEqual({ kind: "svg", diagrams: true, batch: 2 });
      await writeFile(plan.args[4]!, JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: [one("a"), one("b")] }));
      return { stdout: "", stderr: "" };
    });
    const extract = createVmDeterministicVisualExtractor({ runner: { run } as never, storage: store, log: () => {} });
    const result = await extract({
      document: { id: "doc", mimeType: "application/pdf", pageCount: 3, sourceKey: "src/doc.pdf" },
      candidates: [],
      artifacts: { dopplerFiguresIndexUri: "s3://b/run/index.json", mediaMapUri: null, artifactUri: (slot) => ({ "doppler-figure:p2.g0": "s3://b/fig/a.svg", "doppler-figure:p3.g0": "s3://b/fig/b.svg" } as Record<string, string>)[slot] ?? null },
      recordUsage: (event) => usage.push(event),
    });
    // One cost-only VM event for the one guest run, scoped to the document and never billed.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: "local-compute", metric: CHART_EXPORT_VM_USAGE_METRIC, costCents: 0, metadata: { documentId: "doc", stage: "vision-extract", inputs: 2, outcome: "ok", billable: false } });
    expect(billableCents(usage[0]!)).toBe(0);
    // The PDF source is not a deterministic input; both SVG figures go in ONE guest run.
    expect(store.downloads).toEqual(["fig/a.svg", "fig/b.svg"]);
    expect(run).toHaveBeenCalledOnce();
    expect(plans[0]!.args).toHaveLength(6);
    expect(plans[0]!.args[0]).toBe("--disallow-code-generation-from-strings");
    expect(result.partials.map((p) => [p.pageNumber, (p.spec as { series: Array<{ points: Array<{ x: string }> }> }).series[0]!.points[0]!.x])).toEqual([[2, "a"], [3, "b"]]);
    expect(result.presence).toMatchObject({ svgFigures: 2 });
    // Each partial carries its figure's placement from the host's own index ([0, 0, 10, 10] in page points).
    expect(result.partials.map((p) => p.bbox)).toEqual([{ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }]);
  });

  it("records SVGs the guest deferred, with their figure id and page, instead of dropping them", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = storage(
      { "fig/a.svg": genericBar(["a", "b"], [1, 2], 4), "fig/b.svg": genericBar(["c"], [3], 2) },
      { "run/index.json": figureIndex([{ id: "p2.g0", page: 2, format: "svg" }, { id: "p3.g0", page: 3, format: "svg" }]) },
    );
    const done = { schemaVersion: "chart-export-deterministic@v1", visuals: [{ source: "svg-geometry", kind: "chart", confidence: 0.9, spec: { kind: "chart", chartType: "bar", series: [{ name: "s", points: [{ x: "a", y: 1 }] }] }, digest: null, locator: "svg", slide: null, sheet: null, generator: null, reason: null }], refusals: [] };
    const later = { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], deferred: [{ svgIndex: 0, reason: "svg-document-limit" }] };
    const run = vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args[4]!, JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: [done, later] })); return { stdout: "", stderr: "" }; });
    const logs: string[] = [];
    const extract = createVmDeterministicVisualExtractor({ runner: { run } as never, storage: store, log: (m) => logs.push(m) });
    const result = await extract({
      document: { id: "doc-d", mimeType: "application/pdf", pageCount: 3, sourceKey: "src/doc.pdf" },
      candidates: [],
      artifacts: { dopplerFiguresIndexUri: "s3://b/run/index.json", mediaMapUri: null, artifactUri: (slot) => ({ "doppler-figure:p2.g0": "s3://b/fig/a.svg", "doppler-figure:p3.g0": "s3://b/fig/b.svg" } as Record<string, string>)[slot] ?? null },
    });
    // The finished figure is kept; the deferred one is recorded for the later pass.
    expect(result.partials).toHaveLength(1);
    expect(result.deferred).toEqual([{ input: "doppler-figure", svgIndex: 0, reason: "svg-document-limit", pageNumber: 3, figureId: "p3.g0" }]);
    expect(logs.join("\n")).toContain("visuals deferred document=doc-d count=1");
  });

  it("reads a figure only from its own doppler-figure slot, never another artifact slot (adversarial L4)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const index = figureIndex([{ id: "p2.g0", page: 2, format: "svg" }, { id: "p3.g0", page: 3, format: "svg" }]);
    index.figures[0]!.slot = "canonical-document";
    index.figures[1]!.slot = "doppler-figure:p2.g0";
    const store = storage({ "fig/a.svg": genericBar(["a"], [1], 2) }, { "run/index.json": index });
    const run = vi.fn();
    const extract = createVmDeterministicVisualExtractor({ runner: { run } as never, storage: store, log: () => {} });
    const asked: string[] = [];
    const result = await extract({
      document: { id: "doc", mimeType: "application/pdf", pageCount: 3, sourceKey: "src/doc.pdf" },
      candidates: [],
      artifacts: { dopplerFiguresIndexUri: "s3://b/run/index.json", mediaMapUri: null, artifactUri: (slot) => { asked.push(slot); return "s3://b/fig/a.svg"; } },
    });
    expect(asked).toEqual([]);
    expect(store.downloads).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(result.partials).toEqual([]);
  });

  it("refuses a batch whose guest result does not hold exactly one valid result per input", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = storage(
      { "fig/a.svg": genericBar(["a"], [1], 2), "fig/b.svg": genericBar(["b"], [2], 2) },
      { "run/index.json": figureIndex([{ id: "p1.g0", page: 1, format: "svg" }, { id: "p1.g1", page: 1, format: "svg" }]) },
    );
    const empty = { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [] };
    for (const payload of [
      { schemaVersion: "chart-export-deterministic-batch@v1", results: [empty] },
      { schemaVersion: "chart-export-deterministic-batch@v1", results: [empty, { ...empty, extra: 1 }] },
      { schemaVersion: "chart-export-deterministic@v1", results: [empty, empty] },
    ]) {
      const logs: string[] = [];
      const run = vi.fn(async (plan: { args: string[] }) => { await writeFile(plan.args[4]!, JSON.stringify(payload)); return { stdout: "", stderr: "" }; });
      const extract = createVmDeterministicVisualExtractor({ runner: { run } as never, storage: store, log: (m) => logs.push(m) });
      const result = await extract({
        document: { id: "doc-b", mimeType: "application/pdf", pageCount: 1, sourceKey: "src/doc.pdf" },
        candidates: [],
        artifacts: { dopplerFiguresIndexUri: "s3://b/run/index.json", mediaMapUri: null, artifactUri: (slot) => (slot.endsWith("g0") ? "s3://b/fig/a.svg" : "s3://b/fig/b.svg") },
      });
      expect(result.partials).toEqual([]);
      expect(logs.join("\n")).toContain("document=doc-b reason=doppler-svg-figures");
      expect(logs.join("\n")).toContain("reason=invalid-guest-result");
    }
  });

  it("boots no parser VM for a source without a chart signal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const store = storage({ "src/deck.pptx": pptx([[1, slideChart]]), "src/page.html": "<html></html>" });
    const run = vi.fn();
    const logs: string[] = [];
    const extract = createVmDeterministicVisualExtractor({ runner: { run }, storage: store, log: (m) => logs.push(m) });
    await extract({ document: { id: "d1", mimeType: PPTX, pageCount: 1, sourceKey: "src/deck.pptx" }, candidates: [], artifacts: { dopplerFiguresIndexUri: null, mediaMapUri: null }, signals: { officeChartParts: 0 } });
    await extract({ document: { id: "d2", mimeType: "text/html", pageCount: 1, sourceKey: "src/page.html" }, candidates: [], artifacts: { dopplerFiguresIndexUri: null, mediaMapUri: null }, signals: { htmlEmbedHints: false, candidates: 0 } });
    expect(run).not.toHaveBeenCalled();
    expect(store.downloads).toEqual([]);
    expect(logs).toEqual([
      "[chart-export] parser VM skipped document=d1 kind=office reason=no-chart-signal",
      "[chart-export] parser VM skipped document=d2 kind=html reason=no-chart-signal",
    ]);
    expect(sourceRunReason("svg", {})).toBe("standalone-document");
    expect(sourceRunReason("html", { candidates: 1 })).toBe("candidates");
    expect(sourceRunReason("epub", { htmlEmbedHints: true })).toBe("embed-hints");
  });

  it("counts refused chart parts as present", () => {
    expect(presenceOf([{ schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "xl/charts/chart1.xml", reason: "too-large" }, { locator: "svg[0]", reason: "x" }] }], 0))
      .toEqual({ officeChartParts: 1, embeddedSpecs: 0, svgFigures: 0 });
  });
});
