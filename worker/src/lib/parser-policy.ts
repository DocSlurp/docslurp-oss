import {
  sanitizeExtractedMarkdown,
  scoreMarkdownCandidate,
  type ExtractionPlausibilitySignals,
} from "./extracted-markdown.js";

export type ParserPolicyCandidate = {
  extractor: string;
  markdown: string;
  latencyMs: number;
  eligibleForSelection: boolean;
};

export type ParserPolicyObservation = {
  extractor: string;
  eligibleForSelection: boolean;
  selected: boolean;
  latencyMs: number;
  charCount: number;
  strippedDataUriCount: number;
  strippedDataUriBytes: number;
  plausibilityScore: number;
  plausibilitySignals: ExtractionPlausibilitySignals;
  markdownTableCount: number;
  htmlTableCount: number;
  formattingScore: number;
};

export type ParserPolicyDecision = {
  selectedExtractor: string;
  selectedMarkdown: string;
  strategy: "solo" | "consensus" | "divergent";
  similarity: number;
  needsEscalation: boolean;
  observations: ParserPolicyObservation[];
};

type EvaluatedCandidate = ParserPolicyCandidate & {
  sanitizedMarkdown: string;
  strippedDataUriCount: number;
  strippedDataUriBytes: number;
  score: ReturnType<typeof scoreMarkdownCandidate>;
};

/**
 * The production decision policy. Benchmark callers may attach any number of
 * observation-only candidates; they are scored and reported but can never
 * alter the selected production result.
 */
export function evaluateParserPolicy(args: {
  candidates: ParserPolicyCandidate[];
  primaryExtractor: string;
  consensusThreshold?: number;
}): ParserPolicyDecision {
  const evaluated = args.candidates.map(evaluateCandidate);
  const eligible = evaluated.filter((candidate) => candidate.eligibleForSelection);
  if (eligible.length === 0) {
    throw new Error("parser policy received no selectable candidates");
  }

  const primary =
    eligible.find((candidate) => candidate.extractor === args.primaryExtractor) ??
    eligible[0]!;
  const secondary = eligible.find((candidate) => candidate !== primary) ?? null;

  let selected = primary;
  let strategy: ParserPolicyDecision["strategy"] = "solo";
  let similarity = 1;
  let needsEscalation = false;

  if (secondary) {
    similarity = trigramSimilarity(
      primary.sanitizedMarkdown,
      secondary.sanitizedMarkdown,
    );
    if (similarity >= (args.consensusThreshold ?? 0.6)) {
      strategy = "consensus";
    } else {
      strategy = "divergent";
      needsEscalation = true;
      // Divergence is uncertainty, not evidence that the longer candidate is
      // more correct. Retain the configured primary until a class-calibrated
      // benchmark rule explicitly earns the right to replace it.
      selected = primary;
    }
  }

  return {
    selectedExtractor: selected.extractor,
    selectedMarkdown: selected.sanitizedMarkdown,
    strategy,
    similarity,
    needsEscalation,
    observations: evaluated.map((candidate) => ({
      extractor: candidate.extractor,
      eligibleForSelection: candidate.eligibleForSelection,
      selected: candidate === selected,
      latencyMs: candidate.latencyMs,
      charCount: candidate.sanitizedMarkdown.length,
      strippedDataUriCount: candidate.strippedDataUriCount,
      strippedDataUriBytes: candidate.strippedDataUriBytes,
      plausibilityScore: candidate.score.plausibilityScore,
      plausibilitySignals: candidate.score.plausibilitySignals,
      markdownTableCount: candidate.score.markdownTableCount,
      htmlTableCount: candidate.score.htmlTableCount,
      formattingScore: candidate.score.formattingScore,
    })),
  };
}

function evaluateCandidate(candidate: ParserPolicyCandidate): EvaluatedCandidate {
  const sanitized = sanitizeExtractedMarkdown(candidate.markdown);
  return {
    ...candidate,
    sanitizedMarkdown: sanitized.markdown,
    strippedDataUriCount: sanitized.strippedDataUriCount,
    strippedDataUriBytes: sanitized.strippedDataUriBytes,
    score: scoreMarkdownCandidate({ markdown: sanitized.markdown }),
  };
}

export function trigramSimilarity(left: string, right: string): number {
  const leftSet = trigrams(left);
  const rightSet = trigrams(right);
  if (leftSet.size === 0 && rightSet.size === 0) {
    return 1;
  }

  let overlap = 0;
  for (const gram of leftSet) {
    if (rightSet.has(gram)) overlap += 1;
  }
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function trigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < text.length - 2; index += 1) {
    set.add(text.slice(index, index + 3).toLowerCase());
  }
  return set;
}
