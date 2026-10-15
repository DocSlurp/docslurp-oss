import { describe, expect, it } from "vitest";

import {
  evaluatePairedParityGate,
  scoreParserEval,
  selectorRegret,
  summarizeParserEvalResources,
  type ParserEvalFixture,
  type ParserEvalObservation,
} from "../benchmarks/parser-policy-eval.js";

const fixture: ParserEvalFixture = {
  id: "table-1",
  documentClass: "born-digital-table",
  tags: ["table", "simple"],
  pageCount: 1,
  reference: {
    kind: "transcription",
    text: "Quarter Quarter Revenue Q1 10 Q2 12",
    orderedAnchors: ["Quarter", "Q1", "Q2"],
    tableCells: ["Quarter", "Revenue", "Q1", "10", "Q2", "12"],
    headingCount: 1,
    listItemCount: 0,
    formulaTokens: ["Q1", "Q2"],
  },
};

function observation(overrides: Partial<ParserEvalObservation> = {}): ParserEvalObservation {
  return {
    fixtureId: fixture.id,
    extractor: "candidate",
    markdown: "# Quarter\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | 10 |\n| Q2 | 12 |",
    pageCount: 1,
    bboxBackedBlockCount: 3,
    blockCount: 3,
    failed: false,
    timedOut: false,
    latencyMs: 100,
    cpuSeconds: 0.05,
    memoryGbSeconds: 0.1,
    peakRssMb: 80,
    effectiveCostCents: 0.01,
    measuredCommandCostCents: 0.008,
    artifactBytes: 1024,
    artifactBytesPerPage: 1024,
    warmth: "warm",
    deploymentProfile: "lean:test:local",
    deploymentLane: "lean",
    workerClass: "test",
    region: "local",
    ...overrides,
  };
}

const anchorFixture: ParserEvalFixture = {
  ...fixture,
  id: "anchors-1",
  reference: { ...fixture.reference, kind: "anchors" },
};

describe("parser policy eval", () => {
  it("scores anchor references on recall so extra page text is not a penalty", () => {
    // A correct extraction contains every anchor plus the rest of the page.
    const markdown = `${fixture.reference.text} ${Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")}`;
    const anchored = scoreParserEval(anchorFixture, observation({ markdown }));
    const asTranscription = scoreParserEval(fixture, observation({ markdown }));

    expect(anchored.referenceKind).toBe("anchors");
    expect(anchored.quality.textMetric).toBe("anchor-token-recall");
    expect(anchored.quality.normalizedTextF1).toBe(1);
    expect(asTranscription.quality.normalizedTextF1).toBeLessThan(0.1);
  });

  it("reports no error rate for anchor references instead of a meaningless one", () => {
    const markdown = `${fixture.reference.text} ${"filler ".repeat(200)}`;
    const anchored = scoreParserEval(anchorFixture, observation({ markdown }));

    expect(anchored.quality.characterErrorRate).toBeNull();
    expect(anchored.quality.wordErrorRate).toBeNull();
    // The same text scored as a transcription yields an "error rate" far above 1.
    expect(scoreParserEval(fixture, observation({ markdown })).quality.characterErrorRate).toBeGreaterThan(1);
  });

  it("still penalizes an anchor reference when anchors are missing", () => {
    const missing = scoreParserEval(anchorFixture, observation({ markdown: "unrelated content" }));
    expect(missing.quality.normalizedTextF1).toBeLessThan(0.2);
  });

  it("scores quality, cost, speed and operational behavior deterministically", () => {
    const score = scoreParserEval(fixture, observation());
    expect(score.quality.normalizedTextF1).toBe(1);
    expect(score.quality.characterErrorRate).toBe(0);
    expect(score.quality.wordErrorRate).toBe(0);
    expect(score.quality.readingOrderAgreement).toBe(1);
    expect(score.quality.tableCellF1).toBe(1);
    expect(score.quality.bboxCoverage).toBe(1);
    expect(score.quality.formulaTokenAccuracy).toBe(1);
    expect(score.operational).toEqual({
      success: true,
      timedOut: false,
      pageCountAccurate: true,
    });
    expect(score.cost).toMatchObject({
      effectiveCostCents: 0.01,
      measuredCommandCostCents: 0.008,
      artifactBytesPerPage: 1024,
    });
    expect(score.speed.warmth).toBe("warm");
    expect(score.deployment).toEqual({
      profile: "lean:test:local",
      lane: "lean",
      workerClass: "test",
      region: "local",
    });
  });

  it("detects substitutions, reading order, table, formula and bbox regressions", () => {
    const score = scoreParserEval(
      fixture,
      observation({
        markdown: "# Quarter\nQ2 12 Ql l0 Revenue",
        bboxBackedBlockCount: 1,
      }),
    );
    expect(score.quality.characterErrorRate).toBeGreaterThan(0);
    expect(score.quality.wordErrorRate).toBeGreaterThan(0);
    expect(score.quality.readingOrderAgreement).toBeLessThan(1);
    expect(score.quality.tableCellF1).toBeLessThan(1);
    expect(score.quality.formulaTokenAccuracy).toBeLessThan(1);
    expect(score.quality.bboxCoverage).toBeCloseTo(1 / 3);
  });

  it("makes failed or timed-out extraction quality zero", () => {
    expect(
      scoreParserEval(fixture, observation({ failed: true })).quality.composite,
    ).toBe(0);
  });

  it("measures selector regret against observed gold candidates", () => {
    const selected = scoreParserEval(fixture, observation({ extractor: "selected" }));
    const best = scoreParserEval(
      fixture,
      observation({ extractor: "best", markdown: selected.quality.composite > 0 ? observation().markdown : "" }),
    );
    selected.quality.composite = 0.6;
    best.quality.composite = 0.9;
    expect(selectorRegret({ selectedExtractor: "selected", scores: [selected, best] })).toBeCloseTo(0.3);
  });

  it("fails paired parity when a class regresses or simple cost increases", () => {
    const baseline = scoreParserEval(fixture, observation({ extractor: "baseline" }));
    const candidate = scoreParserEval(
      fixture,
      observation({ extractor: "candidate", effectiveCostCents: 0.02 }),
    );
    candidate.quality.composite = baseline.quality.composite - 0.1;
    const gate = evaluatePairedParityGate({
      pairs: [{ documentClass: fixture.documentClass, candidate, baseline }],
      qualityTolerance: 0.02,
      simpleDocumentClasses: [fixture.documentClass],
    });
    expect(gate.passed).toBe(false);
    expect(gate.regressedClasses).toEqual([fixture.documentClass]);
    expect(gate.simpleCostPassed).toBe(false);
  });

  it("fails parity on page-count and failure regressions", () => {
    const baseline = scoreParserEval(fixture, observation({ extractor: "baseline" }));
    const candidate = scoreParserEval(
      fixture,
      observation({ extractor: "candidate", failed: true, pageCount: 0 }),
    );
    const gate = evaluatePairedParityGate({
      pairs: [{ documentClass: fixture.documentClass, candidate, baseline }],
      qualityTolerance: 1,
      simpleDocumentClasses: [],
    });
    expect(gate.operationalPassed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it("summarizes measured runner resources and allocated effective cost", () => {
    const resources = summarizeParserEvalResources({
      performanceEvents: [
        { scope: "document", stageName: "eval", metric: "command-cpu-time", value: 1.25, unit: "second", tags: ["cold"] },
        { scope: "document", stageName: "eval", metric: "command-memory-time", value: 2.5, unit: "gb-second", tags: ["cold"] },
        { scope: "document", stageName: "eval", metric: "command-rss-peak", value: 262_144, unit: "kb", tags: [] },
      ],
      usageEvents: [{
        provider: "local-compute",
        model: "lean:test:local",
        metric: "parser-process",
        amount: 0.25,
        unit: "cent",
        costCents: 0,
        metadata: { effectiveCostCents: 0.25, costRollup: "included" },
      }],
      latencyMs: 2_000,
      artifactBytes: 4_096,
      pageCount: 2,
      artifactRetentionSeconds: 30 * 24 * 60 * 60,
      profile: {
        id: "lean:test:local",
        lane: "lean",
        workerClass: "test",
        region: "local",
        image: "test",
        allocatedVcpu: 2,
        allocatedMemoryGb: 4,
        rates: {
          cpuCentsPerSecond: 1,
          memoryCentsPerGbSecond: 0.5,
          gpuCentsPerSecond: 0,
          storageCentsPerGbMonth: 2,
          networkIngressCentsPerGb: 0,
          networkEgressCentsPerGb: 0,
        },
      },
    });

    expect(resources.cpuSeconds).toBe(1.25);
    expect(resources.memoryGbSeconds).toBe(2.5);
    expect(resources.peakRssMb).toBe(256);
    expect(resources.measuredCommandCostCents).toBe(0.25);
    expect(resources.effectiveCostCents).toBeGreaterThan(8);
    expect(resources.artifactBytesPerPage).toBe(2_048);
    expect(resources.warmth).toBe("cold");
    expect(resources.deploymentLane).toBe("lean");
  });
});
