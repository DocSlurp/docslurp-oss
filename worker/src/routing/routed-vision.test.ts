import { describe, expect, it, vi } from "vitest";
import type { Assignment, RoutePlan, RoutingTarget } from "@docslurp/shared";

import type { VisionPageOutput } from "../stages/vision-extract.js";
import { HeuristicRouter } from "./routers/heuristic.js";
import { runRoutedVision, type RoutedExtractResult } from "./routed-vision.js";
import {
  buildRoutedValidation,
  groupAssignmentsByTarget,
  pagesNeedingPixels,
} from "./runtime.js";
import { BIG_BUDGET, makePage, testCatalog } from "./testing.js";

const catalog = testCatalog();
const vlm = catalog.filter((t) => t.kind === "hosted-vlm" && t.ref.modelUri && t.roles.includes("extract-text"));
const [cheap, strong] = vlm as [RoutingTarget, RoutingTarget];

const estimate = { costUsd: 0.002, latencyMs: 1500, pPass: 0.9 };
function assignment(pageNumber: number, targetId: string, role: Assignment["role"], cascade: Assignment["cascade"] = []): Assignment {
  return { pageNumber, scope: { kind: "page" }, targetId, role, reason: "test", estimate, cascade };
}

async function basePlan(assignments: Assignment[]): Promise<RoutePlan> {
  const plan = await new HeuristicRouter({ documentId: "doc", runId: "run" }).plan(
    [makePage({ pageNumber: 1 })], catalog, BIG_BUDGET, "cost-quality",
  );
  return { ...plan, mode: "active", assignments };
}

const output = (pageNumber: number, model: string, text: string, costCents = 0.2, latencyMs = 1000): VisionPageOutput => ({
  pageNumber, runtime: "openai-compatible", model, prompt: "<OCR>", baseUrl: null, latencyMs, inputTokens: 100, outputTokens: 50,
  usageSource: "provider", fallbackUsed: false, fallbackReason: null, text, costCents,
});

describe("active plan execution", () => {
  it("groups extraction assignments by target and leaves accept-text pages without pixels", async () => {
    const plan = await basePlan([
      assignment(1, "native:accept-text-layer", "accept-text"),
      assignment(2, cheap.id, "extract-text"),
      assignment(3, strong.id, "chart-data"),
      assignment(4, cheap.id, "extract-text"),
      assignment(4, "native:accept-text-layer", "accept-text"),
      assignment(5, "skip", "skip"),
    ]);
    expect(pagesNeedingPixels(plan)).toEqual([2, 3, 4]);
    const execution = groupAssignmentsByTarget(plan, catalog);
    expect(execution.groups.map((g) => [g.targetId, g.pages])).toEqual([[cheap.id, [2, 4]], [strong.id, [3]]]);
    expect(execution.fallbackPages).toEqual([]);
    expect(execution.idleAssignmentIndexes).toEqual([0, 4, 5]);
  });

  it("runs each group on its own model and never touches accept-text pages", async () => {
    const plan = await basePlan([
      assignment(1, "native:accept-text-layer", "accept-text"),
      assignment(2, cheap.id, "extract-text"),
      assignment(3, strong.id, "chart-data"),
    ]);
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => ({
      outputs: pages.map((p) => output(p, vision.modelUri, `text ${p}`)),
      costCentsByPage: new Map(pages.map((p) => [p, 0.5])),
    }));
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, catalog), catalog,
      selection: { modelUri: "llm://openrouter/workspace/default" } as never,
      extract, allow: async () => true, canContinue: () => true,
    });
    expect(extract.mock.calls.map(([vision, pages]) => [vision.modelUri, pages])).toEqual([
      [cheap.ref.modelUri, [2]],
      [strong.ref.modelUri, [3]],
    ]);
    expect(result.outputs.map((o) => o.pageNumber)).toEqual([2, 3]);
    expect(result.actuals.map((a) => [a.pageNumber, a.servesTargetId, a.costUsd])).toEqual([
      [2, cheap.id, 0.005], [3, strong.id, 0.005],
    ]);
  });

  it("escalates an empty page at most once through the planned cascade target", async () => {
    const plan = await basePlan([
      assignment(2, cheap.id, "extract-text", [{ targetId: strong.id, trigger: "empty-output" }]),
    ]);
    const calls: string[] = [];
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => {
      calls.push(vision.modelUri);
      const empty = vision.modelUri === cheap.ref.modelUri;
      return { outputs: pages.map((p) => output(p, vision.modelUri, empty ? "  " : "rescued")), costCentsByPage: new Map([[2, empty ? 0.1 : 0.4]]) };
    });
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, catalog), catalog,
      selection: {} as never, extract, allow: async () => true, canContinue: () => true,
    });
    expect(calls).toEqual([cheap.ref.modelUri, strong.ref.modelUri]);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.text).toBe("rescued");
    expect(result.escalations).toEqual([{ pageNumber: 2, from: cheap.id, to: strong.id, trigger: "empty-output" }]);
    // Both legs are billed to the one assignment.
    const validation = buildRoutedValidation(plan, result.actuals);
    expect(validation.assignments).toHaveLength(1);
    expect(validation.assignments[0]!.actual.costUsd).toBeCloseTo(0.005, 10);
  });

  it("hands the verifier the page image path and releases it; free-check failures never load an image", async () => {
    const plan = await basePlan([
      assignment(2, cheap.id, "extract-text", [{ targetId: strong.id, trigger: "decision-model-verifier" }]),
      assignment(3, cheap.id, "extract-text", [{ targetId: strong.id, trigger: "empty-output" }]),
    ]);
    const requests: Array<{ pageNumber: number; imagePath?: string }> = [];
    const verifier = { verify: vi.fn(async (request: { pageNumber: number; imagePath?: string }) => { requests.push(request); return { pFail: 0.9, escalate: true, costUsd: 0.0003 }; }) };
    const released: string[] = [];
    const pageImage = vi.fn(async (page: number) => ({ path: `/tmp/page-${page}.png`, release: async () => { released.push(`/tmp/page-${page}.png`); } }));
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => ({
      outputs: pages.map((p) => output(p, vision.modelUri, vision.modelUri === cheap.ref.modelUri && p === 3 ? " " : "A clean paragraph of text.")),
      costCentsByPage: new Map(),
    }));
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, catalog), catalog,
      selection: {} as never, extract, allow: async () => true, canContinue: () => true, verifier, pageImage,
    });
    // Page 3 trips the empty-output free check, so only page 2 reaches the verifier.
    expect(requests).toEqual([{ pageNumber: 2, targetId: cheap.id, text: "A clean paragraph of text.", imagePath: "/tmp/page-2.png" }]);
    expect(pageImage).toHaveBeenCalledTimes(1);
    expect(released).toEqual(["/tmp/page-2.png"]);
    expect(result.verifier).toEqual({ calls: 1, costUsd: 0.0003 });
    expect(result.escalations.map((e) => [e.pageNumber, e.trigger])).toEqual([[2, "decision-model-verifier"], [3, "empty-output"]]);
  });

  it("falls back to the workspace model for extraction roles no vision target serves, and skips blocked groups", async () => {
    const plan = await basePlan([
      assignment(2, "ocr:private/lightonocr-3", "ocr"),
      assignment(3, strong.id, "chart-data"),
      assignment(4, "local:florence-2-small", "image-label"),
    ]);
    const execution = groupAssignmentsByTarget(plan, catalog);
    expect(execution.fallbackPages).toEqual([2]);
    // The labeler is a real executor now, not an idle enrichment role.
    expect(execution.requests.map((r) => r.index)).toEqual([2]);
    const extract = vi.fn(async (_vision, pages: number[]): Promise<RoutedExtractResult> => ({
      outputs: pages.map((p) => output(p, "workspace", "x")), costCentsByPage: new Map(),
    }));
    const result = await runRoutedVision({
      plan, execution, catalog, selection: { modelUri: "workspace" } as never,
      extract, allow: async (vision) => vision.modelUri !== strong.ref.modelUri, canContinue: () => true,
    });
    expect(result.skipped).toEqual([{ targetId: strong.id, pages: [3], reason: "privacy-mode" }]);
    expect(result.outputs.map((o) => o.pageNumber)).toEqual([2]);
  });

  it("stops launching groups once the cost cap is reached", async () => {
    const plan = await basePlan([assignment(2, cheap.id, "extract-text")]);
    const extract = vi.fn();
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, catalog), catalog,
      selection: {} as never, extract, allow: async () => true, canContinue: () => false,
    });
    expect(extract).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ reason: "cost-cap" });
  });
});

describe("buildRoutedValidation", () => {
  it("computes estimate error from actual usage and counts accept-text assignments as free", async () => {
    const plan = await basePlan([
      assignment(1, "native:accept-text-layer", "accept-text"),
      assignment(2, cheap.id, "extract-text"),
    ]);
    const validation = buildRoutedValidation(plan, [
      { pageNumber: 2, servesTargetId: cheap.id, costUsd: 0.004, latencyMs: 3000 },
    ]);
    const page2 = validation.assignments.find((a) => a.pageNumber === 2)!;
    expect(page2.error.costErrorUsd).toBeCloseTo(0.002, 10);
    expect(page2.error.costAbsPctError).toBeCloseTo(0.5, 10);
    expect(page2.error.latencyErrorMs).toBe(1500);
    const page1 = validation.assignments.find((a) => a.pageNumber === 1)!;
    expect(page1.actual).toMatchObject({ costUsd: 0, latencyMs: 0 });
    expect(validation.chunk.actual.costUsd).toBeCloseTo(0.004 + plan.triage.costUsd, 10);
  });

  it("splits a shared page call evenly across assignments so chunk cost stays exact", async () => {
    const plan = await basePlan([
      assignment(2, cheap.id, "extract-text"),
      assignment(2, cheap.id, "table"),
    ]);
    const validation = buildRoutedValidation(plan, [{ pageNumber: 2, servesTargetId: cheap.id, costUsd: 0.006, latencyMs: 1000 }]);
    expect(validation.assignments.map((a) => a.actual.costUsd)).toEqual([0.003, 0.003]);
  });
});

describe("content-filter refusal fallback", () => {
  const clone = (id: string, uri: string, output: number, extra: Partial<RoutingTarget> = {}): RoutingTarget => ({
    ...cheap, id, ref: { modelUri: uri }, roles: ["extract-text"], pricing: { ...cheap.pricing, outputUsdPerMTok: output }, ...extra,
  });
  const haiku = clone("vlm:openrouter/anthropic/claude-haiku-5.5", "llm://openrouter/anthropic/claude-haiku-5.5", 5);
  const sonnet = clone("vlm:openrouter/anthropic/claude-sonnet-5.5", "llm://openrouter/anthropic/claude-sonnet-5.5", 15, { escalationOnly: true });
  const pricey = clone("vlm:openrouter/google/gemini-pricey", "llm://openrouter/google/gemini-pricey", 12);
  const cheapG = clone("vlm:openrouter/google/gemini-cheap", "llm://openrouter/google/gemini-cheap", 0.4);
  const local = [haiku, sonnet, pricey, cheapG];
  const refused = (p: number, model: string): VisionPageOutput => ({ ...output(p, model, ""), finishReason: "content_filter" });

  it("never retries the refusing vendor: the planned Anthropic escalation is replaced by the next-best other vendor", async () => {
    const plan = await basePlan([assignment(2, haiku.id, "extract-text", [{ targetId: sonnet.id, trigger: "empty-output" }])]);
    const calls: string[] = [];
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => {
      calls.push(vision.modelUri);
      return {
        outputs: pages.map((p) => (vision.modelUri === haiku.ref.modelUri ? refused(p, vision.modelUri) : output(p, vision.modelUri, "rescued page"))),
        costCentsByPage: new Map(),
      };
    });
    const pack = { targets: [{ targetId: pricey.id, pass: { overall: { baseRate: 0.9 } } }, { targetId: cheapG.id, pass: { overall: { baseRate: 0.6 } } }] } as never;
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, local), catalog: local,
      selection: {} as never, extract, allow: async () => true, canContinue: () => true, pack,
    });
    expect(calls).toEqual([haiku.ref.modelUri, pricey.ref.modelUri]);
    expect(result.outputs[0]!.text).toBe("rescued page");
    expect(result.escalations).toEqual([{ pageNumber: 2, from: haiku.id, to: pricey.id, trigger: "empty-output", refusalFallback: true }]);
  });

  it("falls back for a refused page even when the plan has no cascade leg, preferring the cheaper target without a pack", async () => {
    const plan = await basePlan([assignment(2, haiku.id, "extract-text")]);
    const calls: string[] = [];
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => {
      calls.push(vision.modelUri);
      return { outputs: pages.map((p) => (vision.modelUri === haiku.ref.modelUri ? refused(p, vision.modelUri) : output(p, vision.modelUri, "ok text"))), costCentsByPage: new Map() };
    });
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, local), catalog: local,
      selection: {} as never, extract, allow: async () => true, canContinue: () => true,
    });
    expect(calls).toEqual([haiku.ref.modelUri, cheapG.ref.modelUri]);
    expect(result.escalations[0]).toMatchObject({ to: cheapG.id, refusalFallback: true });
  });

  it("keeps the planned leg for ordinary (non-refusal) failures", async () => {
    const plan = await basePlan([assignment(2, cheapG.id, "extract-text", [{ targetId: sonnet.id, trigger: "empty-output" }])]);
    const calls: string[] = [];
    const extract = vi.fn(async (vision, pages: number[]): Promise<RoutedExtractResult> => {
      calls.push(vision.modelUri);
      return { outputs: pages.map((p) => output(p, vision.modelUri, vision.modelUri === cheapG.ref.modelUri ? " " : "rescued")), costCentsByPage: new Map() };
    });
    const result = await runRoutedVision({
      plan, execution: groupAssignmentsByTarget(plan, local), catalog: local,
      selection: {} as never, extract, allow: async () => true, canContinue: () => true,
    });
    expect(calls).toEqual([cheapG.ref.modelUri, sonnet.ref.modelUri]);
    expect(result.escalations[0]!.refusalFallback).toBeUndefined();
  });
});
