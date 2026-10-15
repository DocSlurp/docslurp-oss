import { describe, expect, it, vi } from "vitest";
import type { Assignment, RoutePlan, RoutingTarget } from "@docslurp/shared";

import type { VisionPageOutput } from "../../stages/vision-extract.js";
import { HeuristicRouter } from "../routers/heuristic.js";
import { runRoutedVision, type RoutedExtractResult } from "../routed-vision.js";
import { buildRoutedValidation, groupAssignmentsByTarget, pagesNeedingPixels } from "../runtime.js";
import { BIG_BUDGET, makePage, testCatalog } from "../testing.js";
import type { CascadeVerifier } from "../cascade.js";
import { mergePageText } from "./merge.js";
import { executorFor } from "./registry.js";
import { executeAssignments } from "./run.js";
import type { ExecutorDeps, ExecutorOutput } from "./types.js";

const catalog = testCatalog();
const byId = (id: string) => catalog.find((t) => t.id === id)!;
const hosted = catalog.filter((t) => t.kind === "hosted-vlm" && t.roles.includes("chart-data"));
const strong = hosted[0] as RoutingTarget;
const cheap = catalog.find((t) => t.kind === "hosted-vlm" && !t.roles.includes("chart-data")) as RoutingTarget;
const florence = byId("local:florence-2-small");
const tesseract = byId("ocr:tesseract");
const nativeText = byId("native:pdf-text");
const kreuzberg = byId("native:kreuzberg");
const accept = byId("native:accept-text-layer");

const estimate = { costUsd: 0.002, latencyMs: 1500, pPass: 0.9 };
const bbox = { x: 50, y: 400, width: 200, height: 100 };
function asg(
  pageNumber: number,
  targetId: string,
  role: Assignment["role"],
  scope: Assignment["scope"] = { kind: "page" },
  cascade: Assignment["cascade"] = [],
): Assignment {
  return { pageNumber, scope, targetId, role, reason: "test", estimate, cascade };
}

async function planOf(assignments: Assignment[]): Promise<RoutePlan> {
  const plan = await new HeuristicRouter({ documentId: "doc", runId: "run" }).plan([makePage({ pageNumber: 1 })], catalog, BIG_BUDGET, "cost-quality");
  return { ...plan, mode: "active", assignments };
}

const vlmOut = (pageNumber: number, text: string, costCents = 0.5, finishReason: string | null = "stop"): VisionPageOutput => ({
  pageNumber, runtime: "openai-compatible", model: "m", prompt: "p", baseUrl: null, latencyMs: 800, inputTokens: 10, outputTokens: 5,
  usageSource: "provider", fallbackUsed: false, fallbackReason: null, text, costCents, finishReason,
});

function fakeDeps(over: Partial<ExecutorDeps> = {}) {
  const calls: string[] = [];
  const deps: ExecutorDeps = {
    pageText: vi.fn(async (p) => (p === 9 ? null : `Paragraph one of page ${p}.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.`)),
    nativePageText: vi.fn(async (id, p) => (id === "native-pdf-text" ? `native page ${p} text` : null)),
    withRaster: vi.fn(async (p, fn) => (p === 8 ? null : await fn({ path: `/tmp/page-${p}.png`, mimeType: "image/png" }))),
    withCrop: vi.fn(async (r, box, fn) => {
      calls.push(`crop:${r.path}:${box.x},${box.y}`);
      return await fn({ path: `${r.path}.crop.png`, mimeType: "image/png" });
    }),
    ocr: vi.fn(async (r) => ({ text: `ocr of ${r.path}`, latencyMs: 40, model: "tesseract" })),
    label: vi.fn(async (r) => ({ text: `a photo (${r.path})`, latencyMs: 90, model: "florence" })),
    vlm: vi.fn(async ({ target, role, raster, pageNumber }) => vlmOut(pageNumber, `${role} via ${target.id} on ${raster.path}`)),
    ...over,
  };
  return { deps, calls };
}

describe("executor registry", () => {
  it("maps every seeded target kind to an executor and leaves unknown ids unexecutable", () => {
    for (const t of [accept, nativeText, kreuzberg, tesseract, florence, strong, cheap, byId("skip")]) {
      expect(executorFor(t), t.id).not.toBeNull();
    }
    expect(executorFor({ ...tesseract, id: "ocr:mystery", kind: "local-ocr" })).toBeNull();
    expect(executorFor(undefined)).toBeNull();
  });

  it("runs text executors without a raster and records fallback for document-level natives", async () => {
    const { deps } = fakeDeps();
    const res = await executeAssignments([
      { assignment: asg(1, accept.id, "accept-text"), index: 0, target: accept },
      { assignment: asg(2, nativeText.id, "extract-text"), index: 1, target: nativeText },
      { assignment: asg(3, kreuzberg.id, "table"), index: 2, target: kreuzberg },
    ], deps);
    expect(deps.withRaster).not.toHaveBeenCalled();
    const text = (i: number) => res.outputs.find((o) => o.assignmentIndex === i)!;
    expect(text(0).text).toContain("Paragraph one of page 1");
    expect(text(1).text).toBe("native page 2 text");
    expect(text(2)).toMatchObject({ fallback: "canonical-page-slice", model: "kreuzberg" });
    expect(text(2).text).toContain("page 3");
  });

  it("crops region and image scopes to the bbox and uses each assignment's own model", async () => {
    const { deps, calls } = fakeDeps();
    const res = await executeAssignments([
      { assignment: asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0, bbox }), index: 0, target: strong },
      { assignment: asg(2, florence.id, "image-label", { kind: "image", imageIndex: 1, bbox: { ...bbox, y: 100 } }), index: 1, target: florence },
      { assignment: asg(2, tesseract.id, "ocr", { kind: "region", bbox }), index: 2, target: tesseract },
      { assignment: asg(2, cheap.id, "extract-text"), index: 3, target: cheap },
    ], deps);
    expect(deps.withRaster).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["crop:/tmp/page-2.png:50,400", "crop:/tmp/page-2.png:50,100", "crop:/tmp/page-2.png:50,400"]);
    expect(vi.mocked(deps.vlm).mock.calls.map(([a]) => [a.target.id, a.role, a.raster.path])).toEqual([
      [strong.id, "chart-data", "/tmp/page-2.png.crop.png"],
      [cheap.id, "extract-text", "/tmp/page-2.png"],
    ]);
    expect(res.outputs.map((o) => o.model)).toEqual(expect.arrayContaining(["tesseract", "florence", "m"]));
    expect(res.failures).toEqual([]);
  });

  it("reports failures, missing rasters and cost-cap skips instead of throwing", async () => {
    const { deps } = fakeDeps({ ocr: vi.fn(async () => { throw new Error("tesseract unavailable"); }) });
    const res = await executeAssignments([
      { assignment: asg(2, tesseract.id, "ocr"), index: 0, target: tesseract },
      { assignment: asg(8, tesseract.id, "ocr"), index: 1, target: tesseract },
      { assignment: asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0 }), index: 2, target: strong },
      { assignment: asg(2, "ocr:mystery", "ocr"), index: 3, target: { ...tesseract, id: "ocr:mystery" } },
    ], deps, { canContinue: () => false });
    expect(res.failures.map((f) => [f.assignmentIndex, f.reason]).sort()).toEqual([
      [0, "tesseract unavailable"], [1, "no-raster"], [3, "no-executor"],
    ]);
    expect(res.skipped).toEqual([{ assignmentIndex: 2, pageNumber: 2, targetId: strong.id, reason: "cost-cap" }]);
  });
});

describe("mergePageText", () => {
  const out = (role: ExecutorOutput["role"], text: string, y: number | null, imageIndex = 0, assignmentIndex = 0): ExecutorOutput => ({
    assignmentIndex, pageNumber: 1, role, text, targetId: "t", model: "m", runtime: "r", latencyMs: 0, inputTokens: 0, outputTokens: 0, costCents: 0,
    scope: y === null ? { kind: "page" } : { kind: "image", imageIndex, bbox: { x: 0, y, width: 10, height: 10 } },
  });
  const prose = "A\n\nB\n\nC\n\nD";

  it("inserts scoped outputs near their vertical position", () => {
    const merged = mergePageText({
      prose, pageHeightPt: 800,
      inserts: [out("chart-data", "| x | y |", 600, 1, 1), out("image-label", "a cat", 100, 0, 0)],
    });
    expect(merged).toBe("A\n\n> **Image 1:** a cat\n\nB\n\nC\n\n**Chart data (image 2)**\n\n| x | y |\n\nD");
  });

  it("appends in bbox order without a page height and drops empty outputs", () => {
    const merged = mergePageText({ prose, inserts: [out("image-label", "later", 500, 1), out("image-label", "  ", 10, 2), out("image-label", "first", 20, 0)] });
    expect(merged.split("\n\n").slice(4)).toEqual(["> **Image 1:** first", "> **Image 2:** later"]);
  });
});

describe("runRoutedVision with executors", () => {
  async function run(assignments: Assignment[], opts: { deps?: ExecutorDeps; extract?: ReturnType<typeof vi.fn>; verifier?: CascadeVerifier; canContinue?: () => boolean } = {}) {
    const plan = await planOf(assignments);
    const execution = groupAssignmentsByTarget(plan, catalog);
    const extract = opts.extract ?? vi.fn(async (_v, pages: number[]): Promise<RoutedExtractResult> => ({
      outputs: pages.map((p) => vlmOut(p, `vlm page ${p} text that is long enough to be plausible. `.repeat(8))), costCentsByPage: new Map(),
    }));
    const result = await runRoutedVision({
      plan, execution, catalog, selection: { modelUri: "llm://openrouter/ws" } as never,
      extract: extract as never, allow: async () => true, canContinue: opts.canContinue ?? (() => true),
      ...(opts.deps ? { executorDeps: opts.deps } : {}), ...(opts.verifier ? { verifier: opts.verifier } : {}),
      pageHeightPt: () => 800,
    });
    return { plan, result, extract, execution };
  }

  it("merges accept-text prose with chart data and an image label into one page body, attributing cost per assignment", async () => {
    const { deps } = fakeDeps();
    const { plan, result } = await run([
      asg(2, accept.id, "accept-text"),
      asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0, bbox: { x: 10, y: 600, width: 100, height: 100 } }),
      asg(2, florence.id, "image-label", { kind: "image", imageIndex: 1, bbox: { x: 10, y: 50, width: 100, height: 100 } }),
      asg(3, accept.id, "accept-text"),
    ], { deps });
    // Page 3 is accept-text only: nothing to replace.
    expect(result.outputs.map((o) => o.pageNumber)).toEqual([2]);
    const body = result.outputs[0]!.text;
    expect(body).toContain("Paragraph one of page 2.");
    expect(body).toContain("> **Image 2:** a photo");
    expect(body).toContain("**Chart data (image 1)**");
    expect(body.indexOf("> **Image 2:**")).toBeLessThan(body.indexOf("Paragraph three"));
    expect(body.indexOf("**Chart data (image 1)**")).toBeGreaterThan(body.indexOf("Paragraph three"));

    const validation = buildRoutedValidation(plan, result.actuals, result.qualities);
    const byTarget = Object.fromEntries(validation.assignments.map((a) => [a.targetId, a]));
    expect(byTarget[strong.id]!.actual.costUsd).toBeCloseTo(0.005, 10);
    expect(byTarget[florence.id]!.actual.latencyMs).toBe(90);
    expect(byTarget[accept.id]!.actual.costUsd).toBe(0);
    expect(byTarget[strong.id]!.actual.qualityMethod).toBe("output-plausibility@v1");
    expect(byTarget[strong.id]!.actual.passed).toBe(true);
  });

  it("uses native extractors and OCR as page prose, and falls back to the workspace model when an executor fails", async () => {
    const { deps } = fakeDeps({ ocr: vi.fn(async () => { throw new Error("boom"); }) });
    const { result, extract } = await run([
      asg(1, nativeText.id, "extract-text"),
      asg(2, tesseract.id, "ocr"),
    ], { deps });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extract).mock.calls[0]![1]).toEqual([2]);
    expect(result.executorFailures).toHaveLength(1);
    expect(result.outputs.map((o) => [o.pageNumber, o.text.startsWith("native page 1") || o.text.startsWith("vlm page 2")])).toEqual([[1, true], [2, true]]);
    expect(result.actuals.find((a) => a.servesTargetId === tesseract.id)?.costUsd).toBe(0.005);
  });

  it("without executor deps, executor-only extraction pages fall back to the workspace model", async () => {
    const { result, extract } = await run([asg(2, tesseract.id, "ocr"), asg(2, florence.id, "image-label", { kind: "image", imageIndex: 0 })]);
    expect(vi.mocked(extract).mock.calls[0]![1]).toEqual([2]);
    expect(result.outputs).toHaveLength(1);
  });

  it("escalates once on a free check (truncation, invalid latex, ragged table) and bypasses the fan-out cache", async () => {
    const cascade = [{ targetId: strong.id, trigger: "empty-output" as const }];
    const cases: Array<[string, string | null, string]> = [
      ["length finish", "length", "fine text"],
      ["latex", "stop", "$$\\frac{1}{2$$"],
      ["ragged", "stop", "| a | b |\n|---|---|\n| 1 | 2 | 3 |"],
    ];
    for (const [name, finish, text] of cases) {
      const extract = vi.fn(async (vision: { modelUri: string }, pages: number[], options?: { bypassCache?: boolean }): Promise<RoutedExtractResult> => {
        const primary = vision.modelUri === cheap.ref.modelUri;
        return { outputs: pages.map((p) => vlmOut(p, primary ? text : "clean rescue text. ".repeat(20), 0.1, primary ? finish : "stop")), costCentsByPage: new Map(), ...(options ? {} : {}) };
      });
      const { result } = await run([asg(2, cheap.id, "extract-text", { kind: "page" }, cascade)], { extract });
      expect(extract.mock.calls.map(([v, , o]) => [v.modelUri, o?.bypassCache ?? false]), name).toEqual([[cheap.ref.modelUri, false], [strong.ref.modelUri, true]]);
      expect(result.escalations, name).toHaveLength(1);
      expect(result.outputs[0]!.text, name).toContain("clean rescue");
    }
  });

  it("does not escalate clean outputs and consults the verifier only after free checks pass", async () => {
    const cascade = [{ targetId: strong.id, trigger: "empty-output" as const }];
    const verify = vi.fn(async () => ({ pFail: 0.95, escalate: true, costUsd: 0.0002 }));
    const verifier: CascadeVerifier = { verify };
    const extract = vi.fn(async (vision: { modelUri: string }, pages: number[]): Promise<RoutedExtractResult> => ({
      outputs: pages.map((p) => vlmOut(p, vision.modelUri === cheap.ref.modelUri ? "looks fine but verifier doubts it. ".repeat(10) : "verified rescue. ".repeat(10))),
      costCentsByPage: new Map(),
    }));
    const { result } = await run([asg(2, cheap.id, "extract-text", { kind: "page" }, cascade)], { extract, verifier });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.escalations[0]).toMatchObject({ trigger: "decision-model-verifier" });
    expect(result.verifier).toEqual({ calls: 1, costUsd: 0.0002 });

    // Without a verifier a clean output is left alone.
    const plain = vi.fn(async (_v: unknown, pages: number[]): Promise<RoutedExtractResult> => ({ outputs: pages.map((p) => vlmOut(p, "clean enough text. ".repeat(20))), costCentsByPage: new Map() }));
    const { result: untouched } = await run([asg(2, cheap.id, "extract-text", { kind: "page" }, cascade)], { extract: plain });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(untouched.escalations).toEqual([]);
  });

  it("assigns pixels only to model-or-image assignments", async () => {
    const plan = await planOf([asg(1, accept.id, "accept-text"), asg(2, nativeText.id, "extract-text"), asg(3, tesseract.id, "ocr"), asg(4, florence.id, "image-label", { kind: "image", imageIndex: 0 })]);
    expect(pagesNeedingPixels(plan)).toEqual([3, 4]);
  });
});


describe("native clip rendering (PDF_RASTER_ENGINE)", () => {
  it("skips the full-page raster when every raster request is crop-scoped and the engine serves the clip", async () => {
    const { deps, calls } = fakeDeps();
    const clipped: string[] = [];
    deps.withPageClip = vi.fn(async (page, box, fn) => {
      clipped.push(`${page}:${box.x},${box.y}`);
      return await fn({ path: `/tmp/clip-${page}.png`, mimeType: "image/png", pageNumber: page });
    }) as never;
    const res = await executeAssignments([
      { assignment: asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0, bbox }), index: 0, target: strong },
      { assignment: asg(2, tesseract.id, "ocr", { kind: "region", bbox }), index: 1, target: tesseract },
    ], deps);
    expect(deps.withRaster).not.toHaveBeenCalled();
    expect(deps.withCrop).not.toHaveBeenCalled();
    expect(clipped).toHaveLength(2);
    expect(vi.mocked(deps.vlm).mock.calls[0]![0].raster.path).toBe("/tmp/clip-2.png");
    expect(res.failures).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("falls back to the full-page raster and sharp crop when the engine resolves null", async () => {
    const { deps, calls } = fakeDeps();
    deps.withPageClip = vi.fn(async () => null) as never;
    const res = await executeAssignments([
      { assignment: asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0, bbox }), index: 0, target: strong },
    ], deps);
    expect(deps.withRaster).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["crop:/tmp/page-2.png:50,400"]);
    expect(res.failures).toEqual([]);
  });

  it("keeps the full-page raster when a whole-page request shares the page", async () => {
    const { deps } = fakeDeps();
    deps.withPageClip = vi.fn(async () => null) as never;
    await executeAssignments([
      { assignment: asg(2, strong.id, "chart-data", { kind: "image", imageIndex: 0, bbox }), index: 0, target: strong },
      { assignment: asg(2, cheap.id, "extract-text"), index: 1, target: cheap },
    ], deps);
    expect(deps.withPageClip).not.toHaveBeenCalled();
    expect(deps.withRaster).toHaveBeenCalledTimes(1);
  });
});

describe("crop-scope content-filter refusal fallback", () => {
  const clone = (id: string, uri: string, output: number): RoutingTarget => ({
    ...strong, id, ref: { modelUri: uri }, roles: ["chart-data", "image-label"], pricing: { ...strong.pricing, outputUsdPerMTok: output },
  });
  const haiku = clone("vlm:openrouter/anthropic/claude-haiku-5.5", "llm://openrouter/anthropic/claude-haiku-5.5", 5);
  const sonnet = clone("vlm:openrouter/anthropic/claude-sonnet-5.5", "llm://openrouter/anthropic/claude-sonnet-5.5", 15);
  const gemini = clone("vlm:openrouter/google/gemini-crop", "llm://openrouter/google/gemini-crop", 1);
  const local = [haiku, sonnet, gemini];
  const chart = (index = 0) => ({ assignment: asg(2, haiku.id, "chart-data", { kind: "image", imageIndex: 0, bbox }), index, target: haiku });
  const refusingDeps = (over: Partial<ExecutorDeps> = {}) => fakeDeps({
    vlm: vi.fn(async ({ target, pageNumber }) =>
      target.id.includes("anthropic")
        ? { ...vlmOut(pageNumber, "", 0.3, "content_filter"), model: target.id }
        : { ...vlmOut(pageNumber, "| x | y |", 0.2), model: target.id }),
    ...over,
  });

  it("retries a refused crop once on the next-best other-vendor target, on the same crop, summing usage", async () => {
    const { deps } = refusingDeps();
    const res = await executeAssignments([chart()], deps, { refusalFallback: { catalog: local } });
    expect(vi.mocked(deps.vlm).mock.calls.map(([a]) => [a.target.id, a.raster.path])).toEqual([
      [haiku.id, "/tmp/page-2.png.crop.png"],
      [gemini.id, "/tmp/page-2.png.crop.png"],
    ]);
    expect(res.outputs[0]).toMatchObject({
      targetId: haiku.id, text: "| x | y |", model: gemini.id, finishReason: "stop", costCents: 0.5, inputTokens: 20, outputTokens: 10, latencyMs: 1600,
      refusalFallback: { fromTargetId: haiku.id, toTargetId: gemini.id, served: true },
    });
    expect(res.warnings).toEqual([]);
  });

  it("keeps the original outcome with a warning when no other vendor can serve the crop", async () => {
    const { deps } = refusingDeps();
    const res = await executeAssignments([chart()], deps, { refusalFallback: { catalog: [haiku, sonnet] } });
    expect(deps.vlm).toHaveBeenCalledTimes(1);
    expect(res.outputs[0]).toMatchObject({ text: "", finishReason: "content_filter", costCents: 0.3 });
    expect(res.outputs[0]!.refusalFallback).toBeUndefined();
    expect(res.warnings).toEqual([expect.stringContaining("refusal-no-fallback")]);
  });

  it("keeps the original outcome with a warning when the fallback leg fails (e.g. privacy refuses it)", async () => {
    const { deps } = refusingDeps();
    const inner = deps.vlm;
    deps.vlm = vi.fn(async (args) => {
      if (args.target.id === gemini.id) throw new Error(`privacy mode refuses ${gemini.id}`);
      return await inner(args);
    });
    const res = await executeAssignments([chart()], deps, { refusalFallback: { catalog: local } });
    expect(res.outputs[0]).toMatchObject({ text: "", finishReason: "content_filter" });
    expect(res.failures).toEqual([]);
    expect(res.warnings).toEqual([expect.stringContaining("refusal-fallback-failed")]);
  });

  it("leaves non-refusal failures and page-scope prose alone (the page path escalates those)", async () => {
    const { deps } = fakeDeps({
      vlm: vi.fn(async ({ pageNumber, role }) => vlmOut(pageNumber, role === "chart-data" ? "cut" : "", 0.3, role === "chart-data" ? "length" : "content_filter")),
    });
    const res = await executeAssignments([
      chart(0),
      { assignment: asg(3, haiku.id, "extract-text"), index: 1, target: haiku },
    ], deps, { refusalFallback: { catalog: local } });
    expect(deps.vlm).toHaveBeenCalledTimes(2);
    expect(res.outputs.every((o) => !o.refusalFallback)).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("records the fallback as a refusal escalation and attributes both calls to the planned assignment", async () => {
    const { deps } = refusingDeps();
    const assignments = [asg(2, accept.id, "accept-text"), asg(2, haiku.id, "chart-data", { kind: "image", imageIndex: 0, bbox })];
    const plan = { ...(await planOf(assignments)) };
    const all = [...catalog, ...local];
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, all), catalog: all, selection: { modelUri: "llm://openrouter/ws" } as never,
      extract: vi.fn() as never, allow: async () => true, canContinue: () => true, executorDeps: deps, pageHeightPt: () => 800,
    });
    expect(result.escalations).toEqual([{ pageNumber: 2, from: haiku.id, to: expect.any(String), trigger: "non-stop-finish", refusalFallback: true }]);
    expect(result.escalations[0]!.to).not.toContain("anthropic");
    expect(result.outputs[0]!.text).toContain("| x | y |");
    expect(result.actuals.find((a) => a.servesTargetId === haiku.id)?.costUsd).toBeCloseTo(0.005, 10);
    expect(result.executorWarnings).toEqual([]);
  });
});
