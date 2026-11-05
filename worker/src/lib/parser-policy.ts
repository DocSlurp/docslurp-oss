import { normalizeNfc, wordParts } from "./unicode-text.js";
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
  /** Dice overlap of the two candidates' word multisets (1 when there is one candidate). */
  similarity: number;
  /** Shorter over longer word count of the two candidates (1 when there is one candidate). */
  lengthRatio: number;
  /** Share of substantial pages on which the candidates agree; null when pages cannot be aligned. */
  pageAgreement: number | null;
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

  // A candidate with (almost) no words is a failed parse, not a rival reading
  // of the document: it is never selected while another candidate has text.
  const textual = eligible.filter((candidate) => wordTokens(candidate.sanitizedMarkdown).length >= NEAR_EMPTY_TOKENS);
  const usable = textual.length > 0 ? textual : eligible;
  const primary =
    usable.find((candidate) => candidate.extractor === args.primaryExtractor) ??
    usable[0]!;
  const secondary = usable.find((candidate) => candidate !== primary) ?? null;
  const emptyCandidateFailed = textual.length > 0 && textual.length < eligible.length;

  let selected = primary;
  let strategy: ParserPolicyDecision["strategy"] = "solo";
  let similarity = 1;
  let lengthRatio = 1;
  let pageAgreement: number | null = null;
  let needsEscalation = emptyCandidateFailed;
  if (emptyCandidateFailed) strategy = "divergent";

  if (secondary) {
    const agreement = compareCandidates(primary.sanitizedMarkdown, secondary.sanitizedMarkdown);
    similarity = agreement.similarity;
    lengthRatio = agreement.lengthRatio;
    pageAgreement = agreement.pageAgreement;
    const threshold = args.consensusThreshold ?? 0.6;
    if (
      similarity >= threshold &&
      lengthRatio >= MIN_LENGTH_RATIO &&
      (pageAgreement === null || pageAgreement >= MIN_PAGE_AGREEMENT)
    ) {
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
    lengthRatio,
    pageAgreement,
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

/** Fewer words than this is a failed parse. */
const NEAR_EMPTY_TOKENS = 3;
/** Two readings of one document have comparable length. */
const MIN_LENGTH_RATIO = 0.5;
/** Share of substantial pages that must agree for the candidates to count as one reading. */
const MIN_PAGE_AGREEMENT = 0.9;
/** A page counts when either candidate has this many words on it. */
const SUBSTANTIAL_PAGE_TOKENS = 10;
const PAGE_AGREEMENT_FLOOR = 0.4;

/** Lower-cased NFC words of any script; ideographic text is compared word by word as the dictionary segmenter splits it. */
export function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const part of wordParts(normalizeNfc(text).toLowerCase())) if (part.wordLike) tokens.push(part.text);
  return tokens;
}

function multiset(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function diceOfCounts(left: Map<string, number>, leftTotal: number, right: Map<string, number>, rightTotal: number): number {
  if (leftTotal === 0 && rightTotal === 0) return 1;
  let overlap = 0;
  for (const [token, count] of left) overlap += Math.min(count, right.get(token) ?? 0);
  return (2 * overlap) / (leftTotal + rightTotal);
}

/**
 * Overlap of two texts as word multisets (Dice): order-independent like a
 * layout difference between parsers, but a text that merely shares common words
 * with an unrelated one scores low, unlike character trigram sets.
 */
export function tokenSimilarity(left: string, right: string): number {
  const leftTokens = wordTokens(left);
  const rightTokens = wordTokens(right);
  return diceOfCounts(multiset(leftTokens), leftTokens.length, multiset(rightTokens), rightTokens.length);
}

function compareCandidates(left: string, right: string): { similarity: number; lengthRatio: number; pageAgreement: number | null } {
  const leftTokens = wordTokens(left);
  const rightTokens = wordTokens(right);
  const longer = Math.max(leftTokens.length, rightTokens.length);
  return {
    similarity: diceOfCounts(multiset(leftTokens), leftTokens.length, multiset(rightTokens), rightTokens.length),
    lengthRatio: longer === 0 ? 1 : Math.min(leftTokens.length, rightTokens.length) / longer,
    pageAgreement: pageAgreementOf(left, right),
  };
}

/** Page by page agreement when both texts have the same number of form-feed pages, else null (no alignment is invented). */
function pageAgreementOf(left: string, right: string): number | null {
  const leftPages = left.split("\f");
  const rightPages = right.split("\f");
  if (leftPages.length < 2 || leftPages.length !== rightPages.length) return null;
  let substantial = 0;
  let agreeing = 0;
  for (let index = 0; index < leftPages.length; index++) {
    const leftTokens = wordTokens(leftPages[index]!);
    const rightTokens = wordTokens(rightPages[index]!);
    if (Math.max(leftTokens.length, rightTokens.length) < SUBSTANTIAL_PAGE_TOKENS) continue;
    substantial++;
    if (diceOfCounts(multiset(leftTokens), leftTokens.length, multiset(rightTokens), rightTokens.length) >= PAGE_AGREEMENT_FLOOR) agreeing++;
  }
  return substantial === 0 ? null : agreeing / substantial;
}
