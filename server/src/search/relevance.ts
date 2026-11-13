/**
 * Relevance floor: a raw, query-independent "is this a real match" signal.
 *
 * Why not the reported `score`? After fusion every list is re-scored as
 * `1 / (1 + rank)`, and `calibrateSearchConfidence` then divides by the best
 * hit, so the top result always looks perfect no matter how weak it is. Rank
 * and relative scores cannot say "nothing here is relevant". The signals below
 * are measured on the retrieval branches before fusion and mean the same thing
 * for every query:
 *
 * - Vector branch: cosine similarity of the query and chunk embeddings (the
 *   embedding catalog L2-normalizes every vector, LanceDB reports squared L2
 *   distance d = 2 - 2cos, and the vector adapter reports 1 / (1 + d)).
 *   Models and pipelines differ in where "unrelated" sits, so the cosine is rescaled above the model's noise baseline:
 *   (cos - baseline) / (1 - baseline). 0 is indistinguishable from unrelated
 *   text, 1 is identical. Only an embedding pipeline with a measured baseline is
 *   filtered this way; any other pipeline's vector hits count as relevant (1).
 * - Lexical branches (full text, progressive and completed pages): a strict
 *   full-text match requires every query term, so it counts as a full match
 *   (1). When the strict query finds nothing, search ORs the terms, and a row
 *   can match on one incidental word; those rows are scored by the share of
 *   the query's content terms found in the chunk. Only a majority counts as
 *   evidence; a lone shared word contributes 0. Phrase rows (three-word windows
 *   of the query matched as phrases) are judged against the window they matched:
 *   a window with two or more content terms is strong evidence (1).
 * - Graph and community expansion: structural matches (an entity named in the
 *   query), trusted as-is.
 *
 * A chunk's relevance is the best signal from any branch that returned it.
 * The reranker is not used: it is local BM25 over the candidate pool, so its
 * scores are only meaningful relative to that pool.
 */
import type { SearchChunk } from "../services/search.js";
import type { EvidenceRetrievalResult } from "./retrieval-adapters.js";
import { flattenEvidenceResults } from "./retrieval-adapters.js";
import { stopWords } from "./rerank.js";
import { foldText, hasCjk, matchTerms } from "./text-fold.js";

/** Built-in floor, in the rescaled 0..1 relevance space. Overridden by SEARCH_MIN_SCORE, the project default or the request. */
export const DEFAULT_MIN_SCORE = 0.1;

/** A lexical hit only counts when more than this share of the query's content terms appear in the chunk (a strict majority). */
export const LEXICAL_MIN_COVERAGE = 0.5;

/**
 * Upper edge of the score that unrelated text reaches in this system, by
 * embedding pipeline, in the cosine units `cosineFromVectorScore` recovers.
 *
 * Only measured values belong here, and each is specific to one pipeline (see
 * `embeddingPipelineId`): the same model served by Ollama, vLLM or a private
 * route, or with reduced dimensions or without normalization, is a different
 * pipeline and is NOT covered. bge-m3 as run by the local transformers.js
 * pipeline with normalized full-size vectors (the default `good-fast-local`
 * profile) was measured through POST /v1/search on a small mixed corpus
 * (papers, an RFC, invoices, a 10-K): off-topic and keyboard-noise queries
 * peaked at 0.58-0.70, paraphrased on-topic queries with no shared keywords at
 * 0.69-0.80, so 0.65 sits at the noise median and the default floor passes every
 * on-topic probe while dropping most noise. These numbers are specific to that
 * pipeline's pooling and quantization, which is why a textbook value for the
 * model would be wrong here (it would be ~0.35). Re-measure with
 * `scripts/calibrate-relevance-floor.mjs` when adding a pipeline or changing
 * the embedding setup.
 *
 * A pipeline with no measured baseline gets NO vector-based dropping. A generic
 * guess is not safe in either direction: where unrelated text sits varies widely
 * (some models put on-topic cosines at only 0.2-0.3), so any fixed cutoff can
 * hide real hits. Such pipelines rely on lexical, graph and rank-based signals
 * only; their vector hits are treated as relevant.
 */
const NOISE_BASELINES: Readonly<Record<string, number>> = {
  "transformers.js/Xenova/bge-m3": 0.65,
};

/**
 * Identifies an embedding pipeline for baseline lookup, or null when the
 * pipeline differs from anything measured (reduced dimensions, no
 * normalization, or a missing route).
 */
export function embeddingPipelineId(route: {
  provider: string;
  model: string;
  /** Local pooling; baselines were measured with mean pooling. */
  pooling?: "mean" | "cls";
  requestedDimensions?: number;
  normalize?: boolean;
} | null | undefined): string | null {
  if (!route) return null;
  if (route.requestedDimensions !== undefined) return null;
  if (route.normalize === false) return null;
  const id = `${route.provider}/${route.model}`;
  return route.pooling === "cls" ? `${id}?pooling=cls` : id;
}

/** Measured noise baseline for the pipeline, or null when none was measured. */
export function embeddingNoiseBaseline(pipeline: string | null | undefined): number | null {
  if (!pipeline) return null;
  return NOISE_BASELINES[pipeline] ?? null;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Cosine similarity recovered from the vector adapter's `1 / (1 + squaredL2)` score. */
export function cosineFromVectorScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return 1 - (1 / score - 1) / 2;
}

/** Cosine rescaled above the model's noise baseline, 0..1. */
export function vectorRelevance(score: number, baseline: number): number {
  return clamp01((cosineFromVectorScore(score) - baseline) / (1 - baseline));
}

/**
 * Words that carry no subject in a question, so they do not count toward coverage. Negations ("not",
 * "no", "never", "without") are content: "refunds not allowed" is not "refunds allowed". "class" and
 * "course" are ordinary subjects ("class action settlement"), not stop words.
 */
const coverageStopWords = new Set([
  ...stopWords,
  ..."about can did do does give list me my please show tell could would should there here we they he she if but so than then also when where who why will may am been being had its our out up yes into over more most some any all just only get got make".split(" "),
]);

/** Suffixes that turn a root into an inflected form of the same word. */
const INFLECTION = /^(?:s|e|es|ed|d|ing|ings|er|ers|ation|ations|ion|ions|ive|ly|y|ies|al|ment|ments)?$/;

/** Drops common inflections so "taxes", "taxed" and "taxation" share the root "tax". */
function stem(term: string): string {
  if (term.length <= 4) return term;
  const stripped = term.replace(/(ations?|ings?|edly|ies|es|ed|s|ly)$/, "");
  return stripped.length >= 3 ? stripped : term;
}

/** Whether `word` is the root or the root plus an inflection, so "tax" meets "taxes" but never "taxi". */
function sharesRoot(word: string, root: string): boolean {
  if (word === root) return true;
  if (!word.startsWith(root)) return false;
  const rest = word.slice(root.length);
  // "run" -> "running": the final consonant doubles before the suffix.
  return INFLECTION.test(rest) || (rest[0] === root.at(-1) && INFLECTION.test(rest.slice(1)));
}

/** Distinct content terms of a query (stop words removed). Unsegmented CJK runs contribute character pairs. */
export function contentTerms(query: string): string[] {
  return [...new Set(matchTerms(query).filter((term) => !coverageStopWords.has(term)))];
}

/** A text folded and split into words once, so several coverage checks against it do not redo that work. */
interface PreparedText { folded: string; words: Set<string> }

function prepareText(text: string): PreparedText {
  const folded = foldText(text);
  return { folded, words: new Set(folded.split(/[^\p{L}\p{N}\p{M}-]+/u).filter(Boolean)) };
}

function coverageOf(terms: string[], text: PreparedText): number {
  if (terms.length === 0) return 0;
  const matched = terms.filter((term) => {
    // Unsegmented scripts have no word boundaries: a character pair is looked up in the running text.
    if (hasCjk(term)) return text.folded.includes(term);
    // Inflection is only modelled for ASCII-letter words; other scripts need the whole word.
    if (!/^[a-z]+$/.test(term)) return text.words.has(term);
    const root = stem(term);
    for (const word of text.words) if (sharesRoot(word, root)) return true;
    return false;
  });
  return matched.length / terms.length;
}

/** Share of the query's distinct content terms present in the text (accent-insensitive, root plus inflection). */
export function termCoverage(query: string, text: string): number {
  const terms = contentTerms(query);
  return terms.length === 0 ? 0 : coverageOf(terms, prepareText(text));
}

/**
 * Three-word windows of the query, as the phrase query in text search builds
 * them. Stop words inside a window are dropped by the database, so a window
 * with fewer than two content terms degenerates into a single-word match.
 */
export function queryPhraseWindows(query: string): string[] {
  const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
  return words.slice(2).map((_, index) => words.slice(index, index + 3).join(" "));
}

/** A query's content terms and its phrase windows' terms, computed once per search instead of once per chunk. */
interface PreparedQuery { terms: string[]; windows: string[][] }

function prepareQuery(query: string): PreparedQuery {
  return { terms: contentTerms(query), windows: queryPhraseWindows(query).map(contentTerms) };
}

function lexicalOf(query: PreparedQuery, text: PreparedText): number {
  const coverage = coverageOf(query.terms, text);
  return coverage > LEXICAL_MIN_COVERAGE ? coverage : 0;
}

function phraseOf(query: PreparedQuery, text: PreparedText): number {
  for (const terms of query.windows) {
    if (terms.length >= 2 && coverageOf(terms, text) === 1) return 1;
  }
  return lexicalOf(query, text);
}

/**
 * Relevance of a row that matched a phrase window. A window with two or more
 * content terms found in the chunk is an exact multi-word match (1). Otherwise
 * the row only shared a single word and gets the strict-majority score.
 */
export function phraseRelevance(query: string, text: string): number {
  return phraseOf(prepareQuery(query), prepareText(text));
}

/** Coverage counts as lexical evidence only for a majority of the query's terms. */
export function lexicalRelevance(query: string, text: string): number {
  return lexicalOf(prepareQuery(query), prepareText(text));
}

/**
 * Candidate lists in fusion order with each chunk's relevance from the branch
 * that returned it. Every chunk is annotated, so a chunk with no relevance is
 * one that never went through retrieval (it is never dropped by the floor).
 */
export function annotateEvidenceRelevance(
  results: EvidenceRetrievalResult[],
  args: { query: string; embeddingPipeline?: string | null },
): SearchChunk[][] {
  const baseline = embeddingNoiseBaseline(args.embeddingPipeline);
  const query = prepareQuery(args.query);
  const relevanceFor = (adapter: EvidenceRetrievalResult["adapter"], chunk: SearchChunk): number => {
    if (adapter === "vector") return baseline === null ? 1 : vectorRelevance(chunk.score, baseline);
    if (adapter === "graph" || adapter === "community") return 1;
    // Strict full-text queries need every query term (Postgres stems and drops
    // stop words), so a hit is a full match. The OR backoff can match on one
    // incidental word and is judged by term coverage instead.
    if (chunk.lexicalMatch === undefined) return 1;
    const haystack = prepareText([chunk.text, chunk.headingPath.join(" "), chunk.filename].join("\n"));
    return chunk.lexicalMatch === "phrase" ? phraseOf(query, haystack) : lexicalOf(query, haystack);
  };
  const annotated: EvidenceRetrievalResult[] = results.map((result) => ({
    adapter: result.adapter,
    chunks: result.chunks.map((chunk) => ({ ...chunk, relevance: relevanceFor(result.adapter, chunk) })),
  }));
  return flattenEvidenceResults(annotated);
}

/** Highest relevance seen for each chunk id across all candidate lists. */
export function bestRelevanceById(lists: SearchChunk[][]): Map<string, number> {
  const best = new Map<string, number>();
  for (const chunk of lists.flat()) {
    if (chunk.relevance === undefined) continue;
    best.set(chunk.id, Math.max(best.get(chunk.id) ?? 0, chunk.relevance));
  }
  return best;
}

/** Stamps fused chunks with the best relevance any branch gave them. */
export function withBestRelevance(chunks: SearchChunk[], lists: SearchChunk[][]): SearchChunk[] {
  const best = bestRelevanceById(lists);
  return chunks.map((chunk) => best.has(chunk.id) ? { ...chunk, relevance: best.get(chunk.id) } : chunk);
}

export interface RelevanceFloorOutcome {
  minScore: number;
  kept: SearchChunk[];
  /** Candidates removed for falling below the floor. */
  dropped: number;
}

/** Removes chunks whose measured relevance is below `minScore`. 0 disables; unmeasured chunks are kept. */
export function applyRelevanceFloor(chunks: SearchChunk[], minScore: number): RelevanceFloorOutcome {
  if (minScore <= 0) return { minScore, kept: chunks, dropped: 0 };
  const kept = chunks.filter((chunk) => chunk.relevance === undefined || chunk.relevance >= minScore);
  return { minScore, kept, dropped: chunks.length - kept.length };
}

/** Request value, else SEARCH_MIN_SCORE, else the built-in default; always within 0..1. */
export function resolveMinScore(requested: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (requested !== undefined && Number.isFinite(requested)) return clamp01(requested);
  const raw = env.SEARCH_MIN_SCORE?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clamp01(parsed);
  }
  return DEFAULT_MIN_SCORE;
}
