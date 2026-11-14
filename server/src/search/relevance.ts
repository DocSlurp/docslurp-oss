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

/** How a content term is looked up in folded text. */
type TermKind = "cjk" | "exact" | "inflected";

interface PreparedTerm {
  term: string;
  kind: TermKind;
  /** Stem for inflected terms; the term itself otherwise. */
  root: string;
}

/** Everything about a query that does not depend on the chunk being scored. */
interface PreparedQuery {
  terms: PreparedTerm[];
  /** Three-word windows holding two or more content terms, in window order (computed on first phrase use). */
  windows?: PreparedTerm[][];
}

function prepareTerms(terms: string[]): PreparedTerm[] {
  return terms.map((term) => {
    if (hasCjk(term)) return { term, kind: "cjk", root: term };
    // Inflection is only modelled for ASCII-letter words; other scripts need the whole word.
    if (!/^[a-z]+$/.test(term)) return { term, kind: "exact", root: term };
    return { term, kind: "inflected", root: stem(term) };
  });
}

/**
 * Prepared queries by query string. Bounded: at most PREPARED_QUERY_CACHE_SIZE entries, none for queries over
 * PREPARED_QUERY_MAX_LENGTH characters, so the cache holds at most ~64 x 2 KB of query text plus its derived terms
 * (a few KB), and no chunk text. Query text is never logged.
 */
const PREPARED_QUERY_CACHE_SIZE = 64;
const PREPARED_QUERY_MAX_LENGTH = 2048;
const preparedQueries = new Map<string, PreparedQuery>();

function prepareQuery(query: string): PreparedQuery {
  const cached = preparedQueries.get(query);
  if (cached) {
    preparedQueries.delete(query);
    preparedQueries.set(query, cached);
    return cached;
  }
  const prepared: PreparedQuery = { terms: prepareTerms(contentTerms(query)) };
  if (query.length <= PREPARED_QUERY_MAX_LENGTH) {
    preparedQueries.set(query, prepared);
    if (preparedQueries.size > PREPARED_QUERY_CACHE_SIZE) preparedQueries.delete(preparedQueries.keys().next().value!);
  }
  return prepared;
}

function preparedWindows(prepared: PreparedQuery, query: string): PreparedTerm[][] {
  if (prepared.windows) return prepared.windows;
  const windows: PreparedTerm[][] = [];
  for (const window of queryPhraseWindows(query)) {
    const terms = contentTerms(window);
    if (terms.length >= 2) windows.push(prepareTerms(terms));
  }
  prepared.windows = windows;
  return windows;
}

const TOKEN_CHAR = /[\p{L}\p{N}\p{M}-]/u;

/** Length in UTF-16 units of the word character at `index` (the class the word split uses), or 0 when it is a separator. */
function tokenCharLength(text: string, index: number): number {
  if (index >= text.length) return 0;
  const unit = text.charCodeAt(index);
  if (unit < 128) return (unit >= 97 && unit <= 122) || (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || unit === 45 ? 1 : 0;
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return TOKEN_CHAR.test(text.slice(index, index + 2)) ? 2 : 0;
  }
  return TOKEN_CHAR.test(text[index]!) ? 1 : 0;
}

/** Whether a word starts at `index`: the character before it is a separator or the text starts there. */
function atWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const unit = text.charCodeAt(index - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return !TOKEN_CHAR.test(text.slice(index - 2, index));
  }
  return tokenCharLength(text, index - 1) === 0;
}

function wordEnd(text: string, from: number): number {
  let end = from;
  for (let length = tokenCharLength(text, end); length > 0; length = tokenCharLength(text, end)) end += length;
  return end;
}

/**
 * Whether the folded text holds a word equal to `term` (exact) or sharing its root (inflected), without
 * splitting the text: candidate positions come from indexOf, and only a position at a word start counts.
 */
function hasWord(folded: string, term: PreparedTerm): boolean {
  const { root } = term;
  const exact = term.kind === "exact";
  for (let from = 0; ;) {
    const index = folded.indexOf(root, from);
    if (index < 0) return false;
    if (atWordStart(folded, index)) {
      const rootEnd = index + root.length;
      const end = wordEnd(folded, rootEnd);
      if (end === rootEnd) return true;
      if (!exact) {
        const rest = folded.slice(rootEnd, end);
        if (INFLECTION.test(rest) || (rest[0] === root.at(-1) && INFLECTION.test(rest.slice(1)))) return true;
      }
    }
    from = index + 1;
  }
}

function termMatches(folded: string, term: PreparedTerm): boolean {
  // Unsegmented scripts have no word boundaries: a character pair is looked up in the running text.
  return term.kind === "cjk" ? folded.includes(term.term) : hasWord(folded, term);
}

function matchedCount(terms: PreparedTerm[], folded: string): number {
  let matched = 0;
  for (const term of terms) if (termMatches(folded, term)) matched += 1;
  return matched;
}

function coverageOf(terms: PreparedTerm[], folded: string): number {
  return terms.length === 0 ? 0 : matchedCount(terms, folded) / terms.length;
}

/** Same value as `lexicalRelevance`, stopping at the first term that makes a majority unreachable. */
function lexicalOf(terms: PreparedTerm[], folded: string): number {
  const total = terms.length;
  if (total === 0) return 0;
  let matched = 0;
  let missed = 0;
  for (const term of terms) {
    if (termMatches(folded, term)) matched += 1;
    else {
      missed += 1;
      if ((total - missed) / total <= LEXICAL_MIN_COVERAGE) return 0;
    }
  }
  const coverage = matched / total;
  return coverage > LEXICAL_MIN_COVERAGE ? coverage : 0;
}

/** Share of the query's distinct content terms present in the text (accent-insensitive, root plus inflection). */
export function termCoverage(query: string, text: string): number {
  const { terms } = prepareQuery(query);
  return terms.length === 0 ? 0 : coverageOf(terms, foldText(text));
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

/**
 * Relevance of a row that matched a phrase window. A window with two or more
 * content terms found in the chunk is an exact multi-word match (1). Otherwise
 * the row only shared a single word and gets the strict-majority score.
 */
export function phraseRelevance(query: string, text: string): number {
  const prepared = prepareQuery(query);
  const windows = preparedWindows(prepared, query);
  // The reference scored the text once per window and once more for the fallback; the folded text is the same each time.
  const folded = foldText(text);
  for (const terms of windows) if (matchedCount(terms, folded) === terms.length) return 1;
  return lexicalOf(prepared.terms, folded);
}

/** Coverage counts as lexical evidence only for a majority of the query's terms. */
export function lexicalRelevance(query: string, text: string): number {
  return lexicalOf(prepareQuery(query).terms, foldText(text));
}

interface ChunkRelevanceMemo {
  query: string;
  phrase: boolean;
  text: string;
  filename: string;
  headingPath: string[];
  headings: string[];
  value: number;
}

/**
 * Lexical relevance per chunk object for the query that scored it, so a second annotation pass over the same
 * chunks in one search is free. Weakly keyed: nothing outlives the chunk. An entry is reused only while the
 * chunk's text, filename and heading path are unchanged.
 */
const chunkRelevanceMemo = new WeakMap<SearchChunk, ChunkRelevanceMemo>();

function memoizedLexicalRelevance(query: string, chunk: SearchChunk): number {
  const phrase = chunk.lexicalMatch === "phrase";
  const memo = chunkRelevanceMemo.get(chunk);
  if (
    memo && memo.query === query && memo.phrase === phrase && memo.text === chunk.text && memo.filename === chunk.filename
    && memo.headingPath === chunk.headingPath && memo.headings.length === chunk.headingPath.length
    && memo.headings.every((heading, index) => heading === chunk.headingPath[index])
  ) return memo.value;
  const haystack = [chunk.text, chunk.headingPath.join(" "), chunk.filename].join("\n");
  const value = phrase ? phraseRelevance(query, haystack) : lexicalRelevance(query, haystack);
  chunkRelevanceMemo.set(chunk, {
    query, phrase, text: chunk.text, filename: chunk.filename, headingPath: chunk.headingPath, headings: [...chunk.headingPath], value,
  });
  return value;
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
  const relevanceFor = (adapter: EvidenceRetrievalResult["adapter"], chunk: SearchChunk): number => {
    if (adapter === "vector") return baseline === null ? 1 : vectorRelevance(chunk.score, baseline);
    if (adapter === "graph" || adapter === "community") return 1;
    // Strict full-text queries need every query term (Postgres stems and drops
    // stop words), so a hit is a full match. The OR backoff can match on one
    // incidental word and is judged by term coverage instead.
    // A keyword fan-out already scored the chunk against the queries that found it.
    if (chunk.queryRelevance !== undefined) return chunk.queryRelevance;
    if (chunk.lexicalMatch === undefined) return 1;
    return memoizedLexicalRelevance(args.query, chunk);
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
