import type { PerformanceEvent, UsageEvent } from "../models.js";
import {
  buildAllocatedResourceObservation,
  calculateLocalComputeCost,
  type WorkerDeploymentProfile,
} from "../pipeline/local-compute-cost.js";

export const PARSER_POLICY_EVAL_SCHEMA_VERSION = "parser-policy-eval@v3";

/**
 * What a fixture's reference text actually is.
 *
 * "transcription" is the complete expected page text, so precision-bearing
 * metrics mean something. "anchors" is a short list of strings that must
 * appear, which is all most fixtures currently carry. Scoring anchors as if
 * they were a transcription made a correct full-page extraction look like a
 * near-total failure: every extra word on the page counted as a false
 * positive, so token F1 collapsed toward zero and the character error rate
 * exceeded 1000%. Those numbers then fed 35% of the composite.
 */
export type ParserEvalReferenceKind = "transcription" | "anchors";

export type ParserEvalFixture = {
  id: string;
  documentClass: string;
  tags: string[];
  pageCount: number;
  reference: {
    /** Defaults to "anchors", the conservative reading of a short reference. */
    kind?: ParserEvalReferenceKind;
    text: string;
    orderedAnchors?: string[];
    tableCells?: string[];
    headingCount?: number;
    listItemCount?: number;
    formulaTokens?: string[];
  };
};

export type ParserEvalObservation = {
  fixtureId: string;
  extractor: string;
  markdown: string;
  pageCount: number;
  bboxBackedBlockCount: number;
  blockCount: number;
  failed: boolean;
  timedOut: boolean;
  latencyMs: number;
  cpuSeconds: number;
  memoryGbSeconds: number;
  peakRssMb: number;
  effectiveCostCents: number;
  measuredCommandCostCents: number;
  artifactBytes: number;
  artifactBytesPerPage: number;
  warmth: "cold" | "warm" | "mixed" | "unmeasured";
  deploymentProfile: string;
  deploymentLane: string;
  workerClass: string;
  region: string;
};

export type ParserEvalScore = {
  schemaVersion: typeof PARSER_POLICY_EVAL_SCHEMA_VERSION;
  fixtureId: string;
  extractor: string;
  referenceKind: ParserEvalReferenceKind;
  quality: {
    /** Token F1 against a transcription, or reference-token recall for anchors. */
    normalizedTextF1: number;
    textMetric: "token-f1" | "anchor-token-recall";
    /** Null for anchor references: edit distance to a snippet is not an error rate. */
    characterErrorRate: number | null;
    wordErrorRate: number | null;
    readingOrderAgreement: number;
    tableCellF1: number;
    headingAgreement: number;
    listAgreement: number;
    formulaTokenAccuracy: number;
    structuralF1: number;
    bboxCoverage: number;
    composite: number;
  };
  cost: {
    effectiveCostCents: number;
    measuredCommandCostCents: number;
    artifactBytes: number;
    artifactBytesPerPage: number;
  };
  speed: {
    latencyMs: number;
    cpuSeconds: number;
    memoryGbSeconds: number;
    peakRssMb: number;
    warmth: ParserEvalObservation["warmth"];
  };
  deployment: {
    profile: string;
    lane: string;
    workerClass: string;
    region: string;
  };
  operational: {
    success: boolean;
    timedOut: boolean;
    pageCountAccurate: boolean;
  };
};

export function scoreParserEval(
  fixture: ParserEvalFixture,
  observation: ParserEvalObservation,
): ParserEvalScore {
  const referenceKind: ParserEvalReferenceKind = fixture.reference.kind ?? "anchors";
  const isTranscription = referenceKind === "transcription";

  // Against anchors, only recall is meaningful: the reference names what must
  // be present and says nothing about what else the page legitimately contains.
  const textScore = isTranscription
    ? tokenF1(fixture.reference.text, observation.markdown)
    : tokenRecall(fixture.reference.text, observation.markdown);

  const characterErrorRate = isTranscription
    ? normalizedEditRate(
        [...normalizeValue(fixture.reference.text)],
        [...normalizeValue(observation.markdown)],
      )
    : null;
  const wordErrorRate = isTranscription
    ? normalizedEditRate(
        normalizeTokens(fixture.reference.text),
        normalizeTokens(observation.markdown),
      )
    : null;
  const readingOrderAgreement = orderedAnchorAgreement(
    fixture.reference.orderedAnchors ?? [],
    observation.markdown,
  );
  const tableCellF1 = setF1(
    fixture.reference.tableCells ?? [],
    extractTableCells(observation.markdown),
  );
  const structure = structureAgreement(fixture, observation.markdown);
  const bboxCoverage =
    observation.blockCount === 0
      ? 0
      : Math.min(1, observation.bboxBackedBlockCount / observation.blockCount);
  const success = !observation.failed && !observation.timedOut;
  const composite = success
    ? weightedMean([
        [textScore, 0.35],
        [readingOrderAgreement, 0.2],
        [tableCellF1, 0.2],
        [structure.composite, 0.15],
        [bboxCoverage, 0.1],
      ])
    : 0;

  return {
    schemaVersion: PARSER_POLICY_EVAL_SCHEMA_VERSION,
    fixtureId: fixture.id,
    extractor: observation.extractor,
    referenceKind,
    quality: {
      normalizedTextF1: textScore,
      textMetric: isTranscription ? "token-f1" : "anchor-token-recall",
      characterErrorRate,
      wordErrorRate,
      readingOrderAgreement,
      tableCellF1,
      headingAgreement: structure.headingAgreement,
      listAgreement: structure.listAgreement,
      formulaTokenAccuracy: structure.formulaTokenAccuracy,
      structuralF1: structure.composite,
      bboxCoverage,
      composite,
    },
    cost: {
      effectiveCostCents: observation.effectiveCostCents,
      measuredCommandCostCents: observation.measuredCommandCostCents,
      artifactBytes: observation.artifactBytes,
      artifactBytesPerPage: observation.artifactBytesPerPage,
    },
    speed: {
      latencyMs: observation.latencyMs,
      cpuSeconds: observation.cpuSeconds,
      memoryGbSeconds: observation.memoryGbSeconds,
      peakRssMb: observation.peakRssMb,
      warmth: observation.warmth,
    },
    deployment: {
      profile: observation.deploymentProfile,
      lane: observation.deploymentLane,
      workerClass: observation.workerClass,
      region: observation.region,
    },
    operational: {
      success,
      timedOut: observation.timedOut,
      pageCountAccurate: observation.pageCount === fixture.pageCount,
    },
  };
}

export function summarizeParserEvalResources(args: {
  performanceEvents: PerformanceEvent[];
  usageEvents: UsageEvent[];
  latencyMs: number;
  artifactBytes: number;
  pageCount: number;
  profile: WorkerDeploymentProfile;
  artifactRetentionSeconds?: number;
}): Pick<
  ParserEvalObservation,
  | "cpuSeconds"
  | "memoryGbSeconds"
  | "peakRssMb"
  | "effectiveCostCents"
  | "measuredCommandCostCents"
  | "artifactBytes"
  | "artifactBytesPerPage"
  | "warmth"
  | "deploymentProfile"
  | "deploymentLane"
  | "workerClass"
  | "region"
> {
  const cpuSeconds = sumMetric(args.performanceEvents, "command-cpu-time", "second");
  const memoryGbSeconds = sumMetric(args.performanceEvents, "command-memory-time", "gb-second");
  const peakRssKb = maxMetric(args.performanceEvents, "command-rss-peak", "kb");
  const hasCold = args.performanceEvents.some((event) => event.tags.includes("cold"));
  const hasWarm = args.performanceEvents.some((event) => event.tags.includes("warm"));
  const warmth = hasCold && hasWarm
    ? "mixed"
    : hasCold
      ? "cold"
      : hasWarm
        ? "warm"
        : "unmeasured";
  const measuredCommandCostCents = args.usageEvents.reduce((sum, event) => {
    const value = event.metadata?.effectiveCostCents;
    return sum + (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);
  }, 0);
  const allocated = {
    ...buildAllocatedResourceObservation({
      profile: args.profile,
      wallTimeMs: args.latencyMs,
      pages: args.pageCount,
      cold: warmth === "cold",
    }),
    storageBytes: Math.max(0, args.artifactBytes),
    storageDurationSeconds: Math.max(0, args.artifactRetentionSeconds ?? 30 * 24 * 60 * 60),
  };

  return {
    cpuSeconds,
    memoryGbSeconds,
    peakRssMb: peakRssKb / 1024,
    effectiveCostCents: calculateLocalComputeCost(allocated, args.profile.rates).totalCents,
    measuredCommandCostCents,
    artifactBytes: Math.max(0, args.artifactBytes),
    artifactBytesPerPage: args.pageCount > 0 ? Math.max(0, args.artifactBytes) / args.pageCount : 0,
    warmth,
    deploymentProfile: args.profile.id,
    deploymentLane: args.profile.lane,
    workerClass: args.profile.workerClass,
    region: args.profile.region,
  };
}

function sumMetric(events: PerformanceEvent[], metric: string, unit: string): number {
  return events
    .filter((event) => event.metric === metric && event.unit === unit)
    .reduce((sum, event) => sum + Math.max(0, event.value), 0);
}

function maxMetric(events: PerformanceEvent[], metric: string, unit: string): number {
  return events
    .filter((event) => event.metric === metric && event.unit === unit)
    .reduce((maximum, event) => Math.max(maximum, event.value), 0);
}

export function selectorRegret(args: {
  selectedExtractor: string;
  scores: ParserEvalScore[];
}): number {
  const selected = args.scores.find(
    (score) => score.extractor === args.selectedExtractor,
  );
  if (!selected || args.scores.length === 0) return 1;
  const best = Math.max(...args.scores.map((score) => score.quality.composite));
  return Math.max(0, best - selected.quality.composite);
}

export function evaluatePairedParityGate(args: {
  pairs: Array<{
    documentClass: string;
    candidate: ParserEvalScore;
    baseline: ParserEvalScore;
  }>;
  qualityTolerance: number;
  simpleDocumentClasses: string[];
}): {
  passed: boolean;
  meanQualityDelta: number;
  lowerConfidenceBound: number;
  regressedClasses: string[];
  simpleCostPassed: boolean;
  operationalPassed: boolean;
} {
  const deltas = args.pairs.map(
    (pair) => pair.candidate.quality.composite - pair.baseline.quality.composite,
  );
  const meanQualityDelta = mean(deltas);
  const standardError = deltas.length <= 1
    ? 0
    : sampleStandardDeviation(deltas) / Math.sqrt(deltas.length);
  const lowerConfidenceBound = meanQualityDelta - 1.96 * standardError;
  const classDeltas = new Map<string, number[]>();
  for (const [index, pair] of args.pairs.entries()) {
    const values = classDeltas.get(pair.documentClass) ?? [];
    values.push(deltas[index]!);
    classDeltas.set(pair.documentClass, values);
  }
  const regressedClasses = [...classDeltas.entries()]
    .filter(([, values]) => mean(values) < -args.qualityTolerance)
    .map(([documentClass]) => documentClass);
  const simpleClasses = new Set(args.simpleDocumentClasses);
  const simplePairs = args.pairs.filter((pair) => simpleClasses.has(pair.documentClass));
  const simpleCostPassed = simplePairs.every(
    (pair) =>
      pair.candidate.cost.effectiveCostCents <=
      pair.baseline.cost.effectiveCostCents,
  );
  const operationalPassed = args.pairs.every(
    (pair) =>
      (!pair.baseline.operational.success || pair.candidate.operational.success) &&
      (!pair.baseline.operational.pageCountAccurate ||
        pair.candidate.operational.pageCountAccurate) &&
      (!pair.candidate.operational.timedOut || pair.baseline.operational.timedOut),
  );

  return {
    passed:
      lowerConfidenceBound >= -args.qualityTolerance &&
      regressedClasses.length === 0 &&
      simpleCostPassed &&
      operationalPassed,
    meanQualityDelta,
    lowerConfidenceBound,
    regressedClasses,
    simpleCostPassed,
    operationalPassed,
  };
}

function normalizeTokens(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenF1(reference: string, output: string): number {
  return multisetF1(normalizeTokens(reference), normalizeTokens(output));
}

/** Share of reference tokens present in the output. Ignores extra output. */
function tokenRecall(reference: string, output: string): number {
  const expected = normalizeTokens(reference);
  if (expected.length === 0) return 1;
  const remaining = new Map<string, number>();
  for (const token of normalizeTokens(output)) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }
  let matches = 0;
  for (const token of expected) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      matches += 1;
      remaining.set(token, count - 1);
    }
  }
  return matches / expected.length;
}

function setF1(reference: string[], output: string[]): number {
  if (reference.length === 0) return 1;
  return multisetF1(
    reference.map(normalizeValue),
    output.map(normalizeValue),
  );
}

function multisetF1(reference: string[], output: string[]): number {
  if (reference.length === 0) return output.length === 0 ? 1 : 0;
  const remaining = new Map<string, number>();
  for (const token of reference) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let matches = 0;
  for (const token of output) {
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      matches += 1;
      remaining.set(token, count - 1);
    }
  }
  const precision = output.length === 0 ? 0 : matches / output.length;
  const recall = matches / reference.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function orderedAnchorAgreement(anchors: string[], markdown: string): number {
  if (anchors.length < 2) return 1;
  const normalized = normalizeValue(markdown);
  const positions = anchors.map((anchor) => normalized.indexOf(normalizeValue(anchor)));
  let correct = 0;
  let total = 0;
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      total += 1;
      if (positions[left]! >= 0 && positions[right]! > positions[left]!) correct += 1;
    }
  }
  return total === 0 ? 1 : correct / total;
}

function extractTableCells(markdown: string): string[] {
  const pipeCells = markdown
    .split("\n")
    .filter((line) => line.includes("|") && !/^\s*\|?(?:\s*:?-+:?\s*\|)+/.test(line))
    .flatMap((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
  const htmlCells = [...markdown.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
    .map((match) => match[1]!.replace(/<[^>]+>/g, " ").trim())
    .filter(Boolean);
  return [...pipeCells, ...htmlCells];
}

function structureAgreement(
  fixture: ParserEvalFixture,
  markdown: string,
): {
  headingAgreement: number;
  listAgreement: number;
  formulaTokenAccuracy: number;
  composite: number;
} {
  const headingAgreement = countAgreement(
    fixture.reference.headingCount,
    (markdown.match(/^#{1,6}\s+/gm) ?? []).length,
  );
  const listAgreement = countAgreement(
    fixture.reference.listItemCount,
    (markdown.match(/^\s*(?:[-*+] |\d+\. )/gm) ?? []).length,
  );
  const formulaTokenAccuracy = fixture.reference.formulaTokens === undefined
    ? 1
    : fixture.reference.formulaTokens.length === 0
      ? 1
      : fixture.reference.formulaTokens.filter((token) => markdown.includes(token)).length /
        fixture.reference.formulaTokens.length;
  return {
    headingAgreement,
    listAgreement,
    formulaTokenAccuracy,
    composite: mean([headingAgreement, listAgreement, formulaTokenAccuracy]),
  };
}

function countAgreement(expected: number | undefined, actual: number): number {
  if (expected === undefined) return 1;
  if (expected === 0) return actual === 0 ? 1 : 0;
  return Math.max(0, 1 - Math.abs(actual - expected) / expected);
}

function normalizedEditRate<T>(reference: T[], output: T[]): number {
  if (reference.length === 0) return output.length === 0 ? 0 : 1;
  const previous = Array.from({ length: output.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= output.length; column += 1) {
      const above = previous[column]!;
      previous[column] = reference[row - 1] === output[column - 1]
        ? diagonal
        : Math.min(diagonal, above, previous[column - 1]!) + 1;
      diagonal = above;
    }
  }
  return previous[output.length]! / reference.length;
}

function normalizeValue(value: string): string {
  return normalizeTokens(value).join(" ");
}

function weightedMean(values: Array<[number, number]>): number {
  const totalWeight = values.reduce((sum, [, weight]) => sum + weight, 0);
  return values.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      Math.max(1, values.length - 1),
  );
}
