import { describe, expect, it } from "vitest";
import {
  customerPipelineView,
  defaultPipelineFeatures,
  MANAGED_PIPELINE_MODEL_PATHS,
  normalizePipelineFeatures,
  resolveManagedPipeline,
  type ProjectRunProgressSnapshot,
} from "@docslurp/shared";
import { customerHiddenModelIds, customerHiddenModelNames, redactModelIdsInText, redactOperatorEvent, redactOperatorRun, redactOperatorRunFields } from "./progress-snapshot.js";

/**
 * Council round 3, N2: no catalog model id reaches a customer through a run, its stage stats, its events or its
 * snapshot. The payloads below carry what a default pipeline's stages write (the page router's note and decision
 * trace, page-embed's embeddingModel, a vision stage's served model, structured extraction's resolved model, a
 * provider error message), and then every catalog id again under neutral keys and inside free text, so a stage that
 * starts writing a new field is covered by the value scrub as well as by the key rule.
 */
const ids = customerHiddenModelIds();
const pipeline = resolveManagedPipeline(normalizePipelineFeatures(defaultPipelineFeatures), null, "test").pipeline;

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value).toLowerCase();
  return ids.filter((id) => text.includes(id));
}

function stageStats(): Record<string, Record<string, unknown>> {
  const everyId = ids.map((id, index) => ({ step: index, targetId: `ocr:${id}`, note: `fell back from ${id} after a timeout` }));
  return {
    "route-pages": {
      mode: "active", router: "decision-model", pages: 12, assignments: 12,
      routerNote: "decision-model-skipped:no-host-pixels:openai/gpt-6-luna-decisions decision-chain:typesafe/jev-1.13=served",
      decisionModel: "typesafe/jev-1.13",
      decisionChain: [{ model: "cloudflare/clef-flash", outcome: "fallback", reason: "clef-flash timed out" }],
      shadowComparison: { compared: 12, agree: 11 },
    },
    "page-embed": { pages: 12, vectors: 12, embeddingModel: "perplexity/pplx-embed-v1-0.6b", dimensions: 1024 },
    "vision-ocr": { pages: 3, servedModel: "Qwen/Qwen3-VL-30B-A3B-Instruct", servedProvider: "deepinfra", providerCostUsd: 0.01, modelCalled: 3 },
    "extract-structured": { fields: 7, resolvedModel: pipeline.structuredExtraction?.model ?? "qwen/qwen3.5-flash-02-23", resolvedProvider: "openrouter" },
    "figure-describe": { figures: 2, generatorModel: "z-ai/glm-5.3-flash", warnings: ["z-ai/glm-5.3-flash returned an empty caption; retried"] },
    walk: { attempts: everyId },
  };
}

function fullDefaultRun() {
  const stats = stageStats();
  return {
    id: "run-1",
    status: "failed",
    error: "Provider openai/gpt-6.1-sol refused the request",
    pipeline,
    stats: { pages: 12, costCents: 4, cpuUserMs: 5, stages: stats, lastModel: "anthropic/claude-haiku-5.5" },
  };
}

function fullDefaultSnapshot(): ProjectRunProgressSnapshot {
  const stats = stageStats();
  const events = Object.entries(stats).map(([stage, stageStat], index) => ({
    id: `e${index}`, type: "stage.completed", stage,
    message: `${stage} done on ${ids[index % ids.length]}`,
    stats: stageStat,
    progress: { pages: 12, note: `served by ${ids[(index + 1) % ids.length]}` },
    payload: { route: { model: ids[index % ids.length], pages: 12 }, detail: ids.join(", ") },
  }));
  return {
    run: fullDefaultRun(),
    stages: Object.entries(stats).map(([name, stageStat]) => ({ name, status: "completed", error: `retried after ${ids[0]} 429`, stats: stageStat })),
    recentEvents: events,
    temporal: null,
    artifacts: {},
    stats: { pages: 12, costCents: 4, cpuUserMs: 5, stageModels: Object.fromEntries(ids.map((id) => [id, 1])), note: ids.join(" ") },
    progress: {
      stageRollups: [{ stage: "route-pages", cpuMs: 40, peakRssBytes: 1000, durationMs: 90, note: `decision ${ids[1]}` }],
      usageTotals: { costCents: 4, workerClasses: ["perf-8x"], regions: ["iad"], models: ids },
      resourceTotals: { elapsedMs: 100, cpuUserMs: 5, cpuSystemMs: 6, cpuTotalMs: 11, rssDeltaBytes: 1, peakRssBytes: 9 },
    },
  } as unknown as ProjectRunProgressSnapshot;
}

describe("no catalog model id reaches a customer", () => {
  it("the fixtures do carry model ids (the test can fail)", () => {
    expect(ids.length).toBeGreaterThan(20);
    expect(leaks(fullDefaultSnapshot()).length).toBeGreaterThan(20);
    expect(MANAGED_PIPELINE_MODEL_PATHS.length).toBeGreaterThan(0);
    expect(leaks(pipeline).length).toBeGreaterThan(0);
  });

  it("run progress snapshot (GET /runs/:id/progress and its stream)", () => {
    const out = redactOperatorRunFields(fullDefaultSnapshot());
    expect(leaks(out)).toEqual([]);
    // Customer numbers survive the redaction.
    expect((out.stats as Record<string, unknown>).pages).toBe(12);
    expect(out.stages.find((stage) => (stage as { name?: string }).name === "page-embed")?.stats).toMatchObject({ pages: 12, vectors: 12, dimensions: 1024 });
  });

  it("run rows (GET /runs, GET /runs/:id, activity-run stream)", () => {
    const out = redactOperatorRun(fullDefaultRun());
    expect(leaks(out)).toEqual([]);
    expect(out.pipeline).toEqual(customerPipelineView(pipeline));
    expect(out.error).toBe("Provider managed-model refused the request");
    const routeStats = (out.stats as { stages: Record<string, Record<string, unknown>> }).stages["route-pages"]!;
    expect(routeStats).toMatchObject({ mode: "active", pages: 12, assignments: 12 });
    expect(routeStats).not.toHaveProperty("routerNote");
  });

  it("run events (GET /runs/:id/events, the event and activity streams)", () => {
    for (const event of fullDefaultSnapshot().recentEvents) expect(leaks(redactOperatorEvent(event))).toEqual([]);
  });
});

describe("free-text scrub (council round 4, R4-2)", () => {
  it("replaces display names, any model route (private ones too) and catalog ids", () => {
    expect(redactModelIdsInText("DeepSeek V4.1 Flash and GPT-6.1 Sol refused")).toBe("managed-model and managed-model refused");
    expect(redactModelIdsInText("deepseek  v4.1 flash timed out")).toBe("managed-model timed out");
    expect(redactModelIdsInText("route llm://private/acme-gpu/qwen/qwen3-vl failed")).toBe("route managed-model failed");
    expect(redactModelIdsInText("fell back to llm://openrouter/x-ai/grok-9, then stopped")).toBe("fell back to managed-model, then stopped");
    expect(redactModelIdsInText("Qwen3-VL 30B A3B (DeepInfra) was slow")).toBe("managed-model was slow");
    for (const name of customerHiddenModelNames()) expect(redactModelIdsInText(`x ${name} y`)).toBe("x managed-model y");
  });

  it("keeps ordinary text, mime types and customer tier words", () => {
    for (const text of ["application/pdf on page 3", "Balanced answer in 1.2 s", "Smart tier", "3 pages failed OCR"]) {
      expect(redactModelIdsInText(text)).toBe(text);
    }
  });
});

