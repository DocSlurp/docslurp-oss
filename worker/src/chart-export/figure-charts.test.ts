// Protocol 15 host side: the job asks for figure charts only when the run's chart tier does; charts.json leaves the
// figure folder without being followed; the answer is validated against the host's own figure index; the extractor
// reads it with no VM run, page and box from the index.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { genericBar } from "./extractors/__tests__/fixtures.js";
import { extractDeterministicVisuals } from "./extractors/index.js";
import {
  FIGURE_CHARTS_MAX_BYTES, FIGURE_CHARTS_SCHEMA, FIGURE_CHARTS_SLOT, figureChartsHaveWork, figureChartsObjectName, figureChartsRequest, figureChartsSlotHasWork,
  readStoredFigureCharts, takeFigureCharts, validateFigureCharts,
} from "./figure-charts.js";
import { createVmDeterministicVisualExtractor } from "./vm-extractor.js";

const ENV = { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_INLINE: "1" };
const provider = { figures: { charts: true } };
const svgFigure = (id: string, page: number) => ({
  id, page, bbox: [72, 100, 468, 400] as [number, number, number, number], kind: "vector", fate: "block", format: "svg", mediaType: "image/svg+xml",
  bytes: 100, sha256: "a".repeat(64), width: 396, height: 300, fileOf: id, slot: `doppler-figure:${id}`,
});
const INDEX = [svgFigure("p2.g1", 2), svgFigure("p3.g1", 3), { ...svgFigure("p3.g2", 3), format: "webp", mediaType: "image/webp" }];
const chart = extractDeterministicVisuals({ kind: "svg", text: genericBar(["London", "Tokyo"], [4, 6], 8) });
const empty = { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [] };
const answer = (figures: string[], results: unknown[], extra: Record<string, unknown> = {}) => ({
  raw: { schemaVersion: FIGURE_CHARTS_SCHEMA, status: "ok", figures, batch: { schemaVersion: "chart-export-deterministic-batch@v1", results }, ...extra },
});

describe("figureChartsRequest: opt-in only", () => {
  it("asks only with inline mode, an active tier under the switch, and a provider that declares figure charts", () => {
    expect(figureChartsRequest({ chartExport: { tier: "free" } }, provider, 7, ENV)).toEqual({ diagrams: true, pages: 7 });
    expect(figureChartsRequest({ chartExport: { tier: "models" } }, provider, 7, ENV)).toEqual({ diagrams: true, pages: 7 });
    expect(figureChartsRequest({ chartExport: { tier: "off" } }, provider, 7, ENV)).toBeNull();
    expect(figureChartsRequest({ chartExport: { tier: "free" } }, provider, 7, { DOCSLURP_CHART_EXPORT: "off", DOCSLURP_CHART_EXPORT_INLINE: "1" })).toBeNull();
    expect(figureChartsRequest({ chartExport: { tier: "free" } }, provider, 7, { DOCSLURP_CHART_EXPORT: "on" })).toBeNull();
    expect(figureChartsRequest({ chartExport: { tier: "free" } }, { figures: {} }, 7, ENV)).toBeNull();
    expect(figureChartsRequest({ chartExport: { tier: "free" } }, null, 7, ENV)).toBeNull();
  });
});

describe("takeFigureCharts", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "figure-charts-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const folder = async () => { const d = await mkdtemp(path.join(dir, "f-")); await writeFile(path.join(d, "manifest.jsonl"), "{}\n"); return d; };

  it("absent: null, folder untouched", async () => {
    const d = await folder();
    expect(await takeFigureCharts(d)).toBeNull();
    expect(await readFile(path.join(d, "manifest.jsonl"), "utf8")).toBe("{}\n");
  });
  it("a regular file is read and removed", async () => {
    const d = await folder();
    await writeFile(path.join(d, "charts.json"), JSON.stringify({ a: 1 }));
    expect(await takeFigureCharts(d)).toEqual({ raw: { a: 1 } });
    await expect(readFile(path.join(d, "charts.json"))).rejects.toThrow();
  });
  it("a link is removed, never followed; its target is untouched", async () => {
    const d = await folder();
    const target = path.join(dir, "secret.json");
    await writeFile(target, JSON.stringify({ secret: true }));
    await symlink(target, path.join(d, "charts.json"));
    expect(await takeFigureCharts(d)).toEqual({ refused: "not-a-file" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ secret: true });
  });
  it("a directory and an oversized file are refused and removed", async () => {
    const d = await folder();
    await mkdir(path.join(d, "charts.json"));
    expect(await takeFigureCharts(d)).toEqual({ refused: "not-a-file" });
    await writeFile(path.join(d, "charts.json"), Buffer.alloc(FIGURE_CHARTS_MAX_BYTES + 1, 0x20));
    expect(await takeFigureCharts(d)).toEqual({ refused: "result-too-large" });
    await expect(readFile(path.join(d, "charts.json"))).rejects.toThrow();
  });
  it("non-JSON is refused", async () => {
    const d = await folder();
    await writeFile(path.join(d, "charts.json"), "{nope");
    expect(await takeFigureCharts(d)).toEqual({ refused: "result-invalid" });
  });
});

describe("validateFigureCharts against the host's figure index", () => {
  it("keeps results for the document's own SVG figures, page and box from the index", () => {
    const out = validateFigureCharts(answer(["p2.g1", "p3.g1"], [chart, empty], { ms: 120 }), INDEX)!;
    expect(out).toMatchObject({ status: "ok", ms: 120 });
    expect(out.status === "ok" && out.figures.map((f) => [f.id, f.page, f.bbox])).toEqual([["p2.g1", 2, [72, 100, 468, 400]], ["p3.g1", 3, [72, 100, 468, 400]]]);
    expect(figureChartsHaveWork(out)).toBe(true);
    expect(readStoredFigureCharts(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
  it.each([
    ["an id that is not an own SVG figure (a WebP)", answer(["p3.g2"], [chart]), "unknown-figure"],
    ["an unknown id", answer(["p9.g9"], [chart]), "unknown-figure"],
    ["a repeated id", answer(["p2.g1", "p2.g1"], [chart, chart]), "unknown-figure"],
    ["fewer results than figures", answer(["p2.g1", "p3.g1"], [chart]), "result-invalid"],
    ["a malformed visual", answer(["p2.g1"], [{ ...chart, visuals: [{ source: "evil" }] }]), "result-invalid"],
    ["an extra key", answer(["p2.g1"], [chart], { note: "hi" }), "result-invalid"],
    ["a bad ms", answer(["p2.g1"], [chart], { ms: -1 }), "result-invalid"],
    ["another schema", { raw: { schemaVersion: "x", status: "ok" } }, "result-invalid"],
  ])("refuses %s, never throws", (_label, taken, reason) => {
    expect(validateFigureCharts(taken as never, INDEX)).toEqual({ schemaVersion: FIGURE_CHARTS_SCHEMA, status: "refused", reason });
  });
  it("passes on a guest refusal slug, refuses free text", () => {
    expect(validateFigureCharts({ raw: { schemaVersion: FIGURE_CHARTS_SCHEMA, status: "refused", reason: "node-unavailable" } }, INDEX)).toMatchObject({ status: "refused", reason: "node-unavailable" });
    expect(validateFigureCharts({ raw: { schemaVersion: FIGURE_CHARTS_SCHEMA, status: "refused", reason: "Error: secret text" } }, INDEX)).toMatchObject({ reason: "result-invalid" });
    expect(validateFigureCharts({ refused: "result-too-large" }, INDEX)).toMatchObject({ reason: "result-too-large" });
    expect(validateFigureCharts(null, INDEX)).toBeNull();
  });
  it("names the stored object by its work bit", () => {
    expect(figureChartsObjectName("doc", true)).toBe("doc.charts.work.json");
    expect(figureChartsSlotHasWork("s3://b/x/doc.charts.work.json")).toBe(true);
    expect(figureChartsSlotHasWork("s3://b/x/doc.charts.none.json")).toBe(false);
  });
});

describe("the extractor reads figure charts in inline mode, with no VM run", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("partials carry the index's page and box; deferred visuals are recorded per figure", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT_INLINE", "1");
    const stored = validateFigureCharts(answer(["p2.g1", "p3.g1"], [chart, { ...empty, deferred: [{ locator: "svg", reason: "svg-scene-budget" }] }], { ms: 90 }), INDEX)!;
    const runs: unknown[] = [];
    const usage: unknown[] = [];
    const extract = createVmDeterministicVisualExtractor({
      runner: { run: vi.fn(async (c: unknown) => { runs.push(c); throw new Error("no VM"); }) },
      storage: { bucket: "b", getJson: vi.fn(async (key: string) => (key.endsWith(".charts.work.json") ? stored : { figures: INDEX })), downloadToTempFile: vi.fn() },
      log: () => undefined,
    } as never);
    const out = await extract({
      document: { id: "d", mimeType: "application/pdf", pageCount: 3, sourceKey: "s" }, candidates: [], signals: {},
      artifacts: { dopplerFiguresIndexUri: "s3://b/f/index.json", mediaMapUri: null, artifactUri: (slot: string) => (slot === FIGURE_CHARTS_SLOT ? "s3://b/f/d.charts.work.json" : null) },
      recordUsage: (e: unknown) => usage.push(e),
    } as never);
    expect(runs).toEqual([]);
    expect(out.partials).toHaveLength(1);
    expect(out.partials[0]).toMatchObject({ pageNumber: 2, bbox: { x: 72, y: 100, width: 396, height: 300 } });
    expect(out.deferred).toEqual([{ input: "doppler-figure", locator: "svg", reason: "svg-scene-budget", pageNumber: 3, figureId: "p3.g1" }]);
    expect(usage).toHaveLength(1);
  });
});
