import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { decisionQuestionIds } from "@docslurp/shared";

import type { DecisionAnswer, DecisionCallResult, DecisionClient, DecisionQuestion, DecisionState } from "./decision-client.js";
import { catalogModel, makePage } from "./routing-test-fixtures.js";
import {
  TriageParseError,
  buildPageQuestions,
  createTriage,
  parseTriageAnswers,
  planTriageBatches,
  questionKey,
  shouldTriage,
  textFactsLine,
} from "./triage.js";

const pplx = catalogModel("perplexity/pplx-decider-v1.1-27b");
const jev = catalogModel("typesafe/jev-1.13");

// Answers vary per question like a healthy model's (identical answers are rejected as degenerate).
function answerAll(questions: Record<string, DecisionQuestion>, p = 0.7, vary = true): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, q], index) => [
      key,
      q.type === "noul"
        ? ({ type: "noul", noul: vary ? Math.min(0.99, 0.3 + (index % 7) * 0.08) : p } as DecisionAnswer)
        : ({ type: "choice", choice: "chart-graph", confidence: 0.6, probabilities: { "chart-graph": 0.6, none: 0.4, bogus: 0 } } as DecisionAnswer),
    ]),
  );
}

function fakeClient(mutate?: (answers: Record<string, DecisionAnswer>) => void) {
  const calls: Array<{ state: DecisionState; questions: Record<string, DecisionQuestion> }> = [];
  const client: DecisionClient = {
    async ask(model, state, questions) {
      calls.push({ state, questions });
      const answers = answerAll(questions);
      mutate?.(answers);
      const result: DecisionCallResult = {
        answers, usage: { inputTokens: 100, outputTokens: 0 }, latencyMs: 5, costCents: 0.0002, model: model.id, provider: "test",
      };
      return result;
    },
  };
  return { client, calls };
}

async function thumbs(pageNumbers: number[]) {
  const png = await sharp({ create: { width: 100, height: 140, channels: 3, background: "#aaa" } }).png().toBuffer();
  return new Map(pageNumbers.map((n) => [n, png]));
}

describe("facts lines", () => {
  it("formats text facts", () => {
    expect(textFactsLine(3, { wordCount: 412, imageCount: 0, imageCoverage: 0, textLayerStatus: "ok" })).toBe("P03: 412 words, 0 images, text layer ok");
    expect(textFactsLine(2, { wordCount: 35, imageCount: 1, imageCoverage: 0.4, textLayerStatus: "suspect" })).toBe("P02: 35 words, 1 image covering 40%, text layer suspect");
    expect(textFactsLine(5, { wordCount: 0, imageCount: 1, imageCoverage: 1, textLayerStatus: "absent" })).toBe("P05: unknown (no text layer)");
    expect(textFactsLine(6, { wordCount: null, imageCount: null, imageCoverage: null, textLayerStatus: "unknown" })).toBe("P06: unknown");
  });
});

describe("shouldTriage", () => {
  it("skips healthy text-only documents and records the reason", () => {
    expect(shouldTriage([makePage(1), makePage(2)])).toEqual({ triage: false, reason: "all-pages-healthy-text-no-images" });
  });
  it("triages when any page has images, a weak layer or math glyphs", () => {
    expect(shouldTriage([makePage(1), makePage(2, { images: 1 })])).toEqual({ triage: true, reason: "page-2-has-images" });
    expect(shouldTriage([makePage(1, { facts: { textLayerStatus: "absent" } })]).reason).toBe("page-1-text-layer-absent");
    const math = makePage(4);
    math.features.native.mathGlyphRatio = 0.2;
    expect(shouldTriage([math]).reason).toBe("page-4-math-glyphs");
    expect(shouldTriage([]).triage).toBe(false);
  });
});

describe("question sets", () => {
  it("asks all attributes and capabilities, keyed p07_<q>, plus per-image kind", () => {
    const q = buildPageQuestions(makePage(7, { images: 2 }));
    for (const id of decisionQuestionIds) expect(q[`p07_${id}`]).toMatchObject({ type: "noul" });
    expect(q.p07_image_kind_0).toMatchObject({ type: "choice" });
    expect(q.p07_image_kind_1).toMatchObject({ type: "choice" });
    expect(Object.keys(q)).toHaveLength(decisionQuestionIds.length + 2);
    expect(questionKey(123, "has_math")).toBe("p123_has_math");
  });
  it("no image_kind for pages known to have no images; page-level when unknown", () => {
    expect(Object.keys(buildPageQuestions(makePage(1)))).toHaveLength(decisionQuestionIds.length);
    const unknown = makePage(2, { facts: { imageCount: null } });
    expect(buildPageQuestions(unknown).p02_image_kind).toBeDefined();
  });
});

describe("request splitting", () => {
  it("never exceeds 128 questions per request and covers every page once", () => {
    const pages = Array.from({ length: 40 }, (_, i) => makePage(i + 1, { images: i % 3 === 0 ? 1 : 0 }));
    const batches = planTriageBatches(pages, pplx, "grid", { pagesPerCall: 16 });
    for (const b of batches) expect(Object.keys(b.questions).length).toBeLessThanOrEqual(128);
    expect(batches.flatMap((b) => b.pages.map((p) => p.features.pageNumber))).toEqual(pages.map((p) => p.features.pageNumber));
    expect(batches.length).toBeGreaterThan(Math.ceil(40 / 16));
    expect(planTriageBatches(pages.slice(0, 9), pplx, "named-images", { pagesPerCall: 4 })).toHaveLength(3);
    expect(planTriageBatches(pages.slice(0, 5), pplx, "per-page")).toHaveLength(5);
  });
  it("caps named-images requests at the model's image limit and rejects duplicate pages", () => {
    const liquid = catalogModel("liquid/d1:direct");
    const pages = Array.from({ length: 20 }, (_, i) => makePage(i + 1));
    for (const b of planTriageBatches(pages, liquid, "named-images", { pagesPerCall: 16 })) {
      expect(b.pages.length).toBeLessThanOrEqual(8);
      expect(Object.keys(b.questions).length).toBeLessThanOrEqual(64);
    }
    expect(() => planTriageBatches([makePage(1), makePage(1)], pplx, "grid")).toThrow(TriageParseError);
  });
});

describe("answer parsing", () => {
  const pages = [makePage(1, { images: 1 }), makePage(12)];
  const requested = { ...buildPageQuestions(pages[0]!), ...buildPageQuestions(pages[1]!) };

  it("round-trips keys back to per-page probabilities and image kinds", () => {
    const parsed = parseTriageAnswers(requested, answerAll(requested, 0.25, false));
    expect([...parsed.keys()]).toEqual([1, 12]);
    expect(parsed.get(12)!.probabilities.has_math).toBe(0.25);
    expect(Object.keys(parsed.get(1)!.probabilities)).toHaveLength(decisionQuestionIds.length);
    expect(parsed.get(1)!.imageKind).toEqual([{ imageIndex: 0, probabilities: { "chart-graph": 0.6, none: 0.4 } }]);
    expect(parsed.get(12)!.imageKind).toEqual([]);
  });
  it("rejects missing, unexpected and mistyped answers", () => {
    const missing = answerAll(requested);
    delete missing.p12_has_table;
    expect(() => parseTriageAnswers(requested, missing)).toThrow(/1 missing/);
    expect(() => parseTriageAnswers(requested, { ...answerAll(requested), p99_has_math: { type: "noul", noul: 0.1 } })).toThrow(/1 unexpected/);
    const wrong = answerAll(requested);
    wrong.p01_has_math = { type: "choice", choice: "x", confidence: 1, probabilities: { x: 1 } };
    expect(() => parseTriageAnswers(requested, wrong)).toThrow(/type mismatch/);
  });
});

describe("triagePages", () => {
  it("named images: facts + images in state, DecisionAnswers with source", async () => {
    const { client, calls } = fakeClient();
    const onCall = vi.fn();
    const pages = [makePage(1), makePage(2, { images: 1 }), makePage(3)];
    const out = await createTriage({ client, model: pplx }).triagePages(pages, {
      format: "named-images", pagesPerCall: 9, tileLongEdge: 256, thumbnails: await thumbs([1, 2, 3]), onCall,
    });
    expect(calls).toHaveLength(1);
    const state = calls[0]!.state as unknown[];
    expect(state[0]).toContain("P01: 412 words, 0 images, text layer ok");
    expect(state[0]).toContain("P02: 412 words, 1 image covering 40%, text layer ok");
    expect(state.slice(1).filter((s) => typeof s === "string")).toEqual(["Page P01:", "Page P02:", "Page P03:"]);
    expect(out.get(2)!.source).toEqual({ decisionModel: pplx.id, format: "named-images", pagesPerCall: 3, tilePx: 256 });
    expect(out.get(2)!.choices.image_kind).toHaveLength(1);
    expect(out.get(1)!.choices).toEqual({});
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("grid format sends one image per request", async () => {
    const { client, calls } = fakeClient();
    const pages = Array.from({ length: 9 }, (_, i) => makePage(i + 1));
    const out = await createTriage({ client, model: pplx }).triagePages(pages, { format: "grid", thumbnails: await thumbs(pages.map((p) => p.features.pageNumber)), tileLongEdge: 384 });
    expect(out.size).toBe(9);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.state as unknown[]).filter((s) => typeof s !== "string")).toHaveLength(1);
    expect(out.get(1)!.source).toMatchObject({ format: "grid", pagesPerCall: 9, tilePx: 384 });
  });

  it("text-only models get text-state with facts, features and excerpt, and no images", async () => {
    const { client, calls } = fakeClient();
    const out = await createTriage({ client, model: jev }).triagePages([makePage(1), makePage(2)], {
      textExcerpts: new Map([[1, "Abstract. We study attention."]]), format: "grid",
    });
    const state = calls[0]!.state as string[];
    expect(state.every((s) => typeof s === "string")).toBe(true);
    expect(state.join("\n")).toContain("TEXT FACTS");
    expect(state.join("\n")).toContain("P01 features:");
    expect(state.join("\n")).toContain("Abstract. We study attention.");
    expect(state.join("\n")).toContain("Page P02 text-layer excerpt:\n(none)");
    expect(out.get(1)!.source).toEqual({ decisionModel: jev.id, format: "text-state", pagesPerCall: 2, tilePx: null });
  });

  it("fails the run when the model drops an answer", async () => {
    const { client } = fakeClient((answers) => { delete answers.p01_handwriting; });
    await expect(createTriage({ client, model: jev }).triagePages([makePage(1)], {})).rejects.toBeInstanceOf(TriageParseError);
  });
});
