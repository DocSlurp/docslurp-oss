import { describe, expect, it } from "vitest";
import { buildDecisionModelCatalog, type DecisionAnswers, type ImageKind } from "@docslurp/shared";

import type { InsetGate } from "../inset-gate.js";
import type { InsetAssessment, InsetTriageResult } from "../inset-triage.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "../testing.js";
import { CONTENT_QUESTION_IDS, type Triage, type TriageOptions } from "../triage.js";
import { DecisionModelRouter } from "./decision-model.js";
import { isUncertain, type EmbeddingPageProbe } from "./embedding-prefilter.js";

const model = buildDecisionModelCatalog({ env: { OPENROUTER_API_KEY: true } }).models.find((m) => m.id === "cloudflare/clef-flash")!;
const src = { decisionModel: model.id, format: "per-page" as const, pagesPerCall: 1, tilePx: 384 };

function recordingTriage(answers: Record<number, DecisionAnswers["probabilities"]> = {}) {
  const seen: number[][] = [];
  const options: Array<Omit<TriageOptions, "onCall">> = [];
  const triage: Triage = {
    async triagePages(pages, opts) {
      seen.push(pages.map((p) => p.features.pageNumber));
      options.push({ ...opts });
      opts?.onCall?.(
        { answers: {}, usage: { inputTokens: 800, outputTokens: 0 }, latencyMs: 5, costCents: 0.003, model: model.id, provider: "mock" },
        { pages: pages.map((p) => p.features.pageNumber), format: "per-page", model },
      );
      return new Map(pages.map((p) => [p.features.pageNumber, { probabilities: answers[p.features.pageNumber] ?? {}, choices: {}, source: src }]));
    },
  };
  return { triage, seen, options };
}

function assessment(imageIndex: number, kind: ImageKind, needsTranscription: number): InsetAssessment {
  const roleOf: Record<string, InsetAssessment["role"]> = { "chart-graph": "chart-data", "scanned-text": "ocr", "decorative-photo": "image-label" };
  return {
    imageIndex, coverage: 0.2, bbox: { x: 0, y: 0, width: 20, height: 100 }, kind, kindProbabilities: { [kind]: 0.9 },
    flags: {}, needsTranscription, role: roleOf[kind] ?? "skip",
  };
}

function fakeGate(kindByPage: Record<number, InsetAssessment[]>, ask: number[] = []): InsetGate {
  return {
    model,
    async assess(page) {
      ask.push(page.features.pageNumber);
      const assessments = kindByPage[page.features.pageNumber];
      if (!assessments) return null;
      const result: InsetTriageResult = {
        assessments, skipped: [], calls: assessments.length, usage: { inputTokens: 380 * assessments.length, outputTokens: 0 },
        costCents: 0.0015, latencyMs: 4,
      };
      return result;
    },
  };
}

const rolesOf = (plan: Awaited<ReturnType<DecisionModelRouter["plan"]>>, n: number) =>
  plan.assignments.filter((a) => a.pageNumber === n).map((a) => `${a.role}:${a.scope.kind}`).sort();

describe("DecisionModelRouter trust cascade", () => {
  const pack = testPack();
  const catalog = testCatalog();
  const prose = (pageNumber: number, extra: Parameters<typeof makePage>[0] = {}) => makePage({ pageNumber, words: 500, ...extra });

  it("asks the minimal content questions, no image_kind choice, and never the trust question", async () => {
    const { triage, options } = recordingTriage({ 1: { plain_ocr_sufficient: 0.9, needs_math_extraction: 0.05, needs_table_structure: 0.05 } });
    await new DecisionModelRouter({ pack, model, triage }).plan([makePage({ pageNumber: 1, words: 40, textLayer: "suspect" })], catalog, BIG_BUDGET, "cost-quality");
    expect(options[0]!.questionIds).toEqual([...CONTENT_QUESTION_IDS]);
    expect(options[0]!.imageKindQuestions).toBe(false);
    expect(CONTENT_QUESTION_IDS).not.toContain("trust_text_layer");
  });

  it("clears a chart inset with the gate: accept-text plus an image-scoped chart assignment, no content call", async () => {
    const asked: number[] = [];
    const gate = fakeGate({ 1: [assessment(0, "chart-graph", 0.05)] }, asked);
    const { triage, seen } = recordingTriage();
    const plan = await new DecisionModelRouter({ pack, model, triage, insetGate: gate }).plan(
      [prose(1, { images: [{ coverage: 0.2 }] })], catalog, BIG_BUDGET, "cost-quality",
    );
    expect(asked).toEqual([1]);
    expect(seen).toEqual([]);
    expect(rolesOf(plan, 1)).toEqual(["accept-text:page", "chart-data:image"]);
    expect(plan.triage.ran).toBe(true);
    expect(plan.decisionModelCalls).toHaveLength(1);
    expect(plan.triage.costUsd).toBeCloseTo(0.000015);
  });

  it("a scanned-text inset removes accept-text-only and falls through to the content questions", async () => {
    const gate = fakeGate({ 1: [assessment(0, "scanned-text", 0.8)] });
    const { triage, seen } = recordingTriage({ 1: { plain_ocr_sufficient: 0.9, needs_math_extraction: 0.02, needs_table_structure: 0.02 } });
    const plan = await new DecisionModelRouter({ pack, model, triage, insetGate: gate }).plan(
      [prose(1, { images: [{ coverage: 0.2 }] })], catalog, BIG_BUDGET, "cost-quality",
    );
    expect(seen).toEqual([[1]]);
    const roles = rolesOf(plan, 1);
    expect(roles).not.toContain("accept-text:page");
    expect(roles).toContain("ocr:image");
  });

  it("does not ask the gate about untrusted pages or pages without 2-85% insets", async () => {
    const asked: number[] = [];
    const gate = fakeGate({}, asked);
    const { triage } = recordingTriage();
    await new DecisionModelRouter({ pack, model, triage, insetGate: gate }).plan(
      [prose(1), prose(2, { images: [{ coverage: 0.9 }] }), prose(3, { images: [{ coverage: 0.01 }] }), makePage({ pageNumber: 4, words: 40, textLayer: "suspect", images: [{ coverage: 0.3 }] })],
      catalog, BIG_BUDGET, "cost-quality",
    );
    expect(asked).toEqual([]);
  });

  it("a gate that cannot run (text-only model, failed render) withholds accept-text-only", async () => {
    const { triage } = recordingTriage({ 1: { plain_ocr_sufficient: 0.9, needs_math_extraction: 0.02, needs_table_structure: 0.02 } });
    const page = prose(1, { images: [{ coverage: 0.3 }] });
    const textOnly = await new DecisionModelRouter({ pack, model, triage, insetGate: null }).plan([page], catalog, BIG_BUDGET, "cost-quality");
    expect(rolesOf(textOnly, 1)).not.toContain("accept-text:page");
    const failed = await new DecisionModelRouter({ pack, model, triage, insetGate: fakeGate({}) }).plan([page], catalog, BIG_BUDGET, "cost-quality");
    expect(rolesOf(failed, 1)).not.toContain("accept-text:page");
  });

  it("verified OCR layers are accepted without any model call; unverified ones are not", async () => {
    const { triage, seen } = recordingTriage({ 2: { plain_ocr_sufficient: 0.9, needs_math_extraction: 0.02, needs_table_structure: 0.02 } });
    const plan = await new DecisionModelRouter({ pack, model, triage }).plan(
      [makePage({ pageNumber: 1, words: 400, textLayer: "ocr-layer", ocrAgreement: 0.9 }), makePage({ pageNumber: 2, words: 400, textLayer: "ocr-layer", ocrAgreement: 0.1 })],
      catalog, BIG_BUDGET, "cost-quality",
    );
    expect(seen).toEqual([[2]]);
    expect(rolesOf(plan, 1)).toEqual(["accept-text:page"]);
    expect(rolesOf(plan, 2)).not.toContain("accept-text:page");
  });

  it("the embedding pre-filter keeps confident pages away from the paid model", async () => {
    const { triage, seen } = recordingTriage({ 3: { plain_ocr_sufficient: 0.9, needs_math_extraction: 0.02, needs_table_structure: 0.02 } });
    const probes = new Map<number, EmbeddingPageProbe>([
      [2, { probabilities: { plain_ocr_sufficient: 0.97, needs_math_extraction: 0.01, needs_table_structure: 0.01 }, costUsd: 0.000001 }],
      [3, { probabilities: { plain_ocr_sufficient: 0.5, needs_math_extraction: 0.4, needs_table_structure: 0.02 } }],
    ]);
    const plan = await new DecisionModelRouter({
      pack, model, triage,
      prefilter: { provider: async () => probes, model: { id: "siglip2@probe", tilePx: 224 }, band: [0.15, 0.85] },
    }).plan(
      [makePage({ pageNumber: 2, words: 40, textLayer: "suspect" }), makePage({ pageNumber: 3, words: 40, textLayer: "suspect" })],
      catalog, BIG_BUDGET, "cost-quality",
    );
    expect(seen).toEqual([[3]]);
    expect(plan.assignments.map((a) => a.pageNumber).sort()).toEqual([2, 3]);
  });

  it("isUncertain: a content question inside the band is undecided", () => {
    const qs = ["needs_math_extraction", "needs_table_structure"] as const;
    expect(isUncertain({ needs_math_extraction: 0.5 }, [0.25, 0.75], qs)).toBe(true);
    expect(isUncertain({ needs_math_extraction: 0.97, needs_table_structure: 0.02 }, [0.25, 0.75], qs)).toBe(false);
    expect(isUncertain({ plain_ocr_sufficient: 0.5 }, [0.25, 0.75], qs)).toBe(false);
  });
});
