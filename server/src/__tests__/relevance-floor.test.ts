import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(async () => []), { array: vi.fn(), json: vi.fn() }) }));
vi.mock("../services/search-controls.js", () => ({
  applySearchControls: ({ results }: { results: unknown }) => results,
  recordZeroResultDiagnostics: vi.fn(async () => undefined),
}));

const {
  DEFAULT_MIN_SCORE,
  annotateEvidenceRelevance,
  applyRelevanceFloor,
  cosineFromVectorScore,
  embeddingNoiseBaseline,
  embeddingPipelineId,
  lexicalRelevance,
  phraseRelevance,
  resolveMinScore,
  termCoverage,
  vectorRelevance,
} = await import("../search/relevance.js");
const { executeSearchSessionRetrieval, searchResultsToChunks } = await import("../search/session-execution.js");
import type { SearchAvailability, SearchChunk } from "../services/search.js";

/** The vector adapter reports 1 / (1 + squaredL2) and unit vectors give squaredL2 = 2 - 2cos. */
const scoreForCosine = (cosine: number) => 1 / (1 + 2 - 2 * cosine);

function chunk(id: string, overrides: Partial<SearchChunk> = {}): SearchChunk {
  return {
    id, documentId: `doc-${id}`, runId: "run-1", chunkIndex: 0, text: `text ${id}`, headingPath: [], pageNumber: 1,
    tokenEstimate: 4, score: 1, filename: `${id}.pdf`, pageNumbers: [1], blockIds: [], blockTypes: [], evidenceType: null,
    canonicalDocumentUri: null, tableGranularity: null, tableRowIndex: null, tableRowCount: null, tableColumnNames: [],
    tableColumnTypes: [], tableCells: [], tableCell: null, regionBoxes: [], regions: [], regionCoordinateSpace: null,
    sourceTrace: null, source: "document", retrievalStage: "full-index", ...overrides,
  };
}

const availability = (status: SearchAvailability["status"]): SearchAvailability => ({
  status, isPartial: status === "partial" || status === "pending", keywordOnly: false,
  scope: { workspaceId: "ws-1", runId: null },
  coverage: { totalDocuments: 1, indexedDocuments: 1, pageIndexedDocuments: 0, searchableDocuments: 1, pageOnlyDocuments: 0,
    keywordOnlyDocuments: 0, failedDocuments: 0, inProgressDocuments: 0, totalPages: 1, searchablePages: 1, indexedChunkCount: 1, queuedRuns: 0, processingRuns: 0 },
  resultBreakdown: { indexedResultCount: 0, pageResultCount: 0 }, message: null,
});

function session() {
  return {
    sessionId: "session-1", persist: vi.fn(async () => undefined), usageEvents: () => [], diagnostics: () => ({}),
    recordDiagnostic: vi.fn(), adoptUsage: vi.fn(),
  } as never;
}

async function run(args: {
  lists: SearchChunk[][]; minScore?: number; status?: SearchAvailability["status"];
  wholeCorpusFallback?: () => Promise<never[]>; limit?: number; candidateDepth?: number; resultOrder?: "relevance" | "prompt";
}) {
  return executeSearchSessionRetrieval({
    query: "q", userId: "user-1", session: session(), workspaceId: "ws-1", limit: args.limit ?? 10,
    options: { minScore: args.minScore, useRerank: false, useMmr: false, candidateDepth: args.candidateDepth, resultOrder: args.resultOrder },
    retrieveCandidateLists: async () => args.lists,
    buildAvailability: () => availability(args.status ?? "complete"),
    effectiveQuery: "q", filters: undefined, selfQueryReasons: [], privacyMode: "standard" as never,
    wholeCorpusFallback: args.wholeCorpusFallback,
  });
}

describe("relevance signals", () => {
  it("recovers cosine similarity from the vector adapter score", () => {
    for (const cosine of [0, 0.2, 0.5, 0.9, 1]) expect(cosineFromVectorScore(scoreForCosine(cosine))).toBeCloseTo(cosine, 10);
    expect(cosineFromVectorScore(0)).toBe(0);
    expect(cosineFromVectorScore(Number.NaN)).toBe(0);
  });

  it("rescales cosine above the embedding model's unrelated-text baseline", () => {
    expect(vectorRelevance(scoreForCosine(0.2), 0.2)).toBe(0);
    expect(vectorRelevance(scoreForCosine(0.1), 0.2)).toBe(0);
    expect(vectorRelevance(scoreForCosine(1), 0.2)).toBeCloseTo(1, 10);
    expect(vectorRelevance(scoreForCosine(0.6), 0.2)).toBeCloseTo(0.5, 10);
    // The same raw cosine is noise for a compressed-range model and signal for a wide-range one.
    expect(vectorRelevance(scoreForCosine(0.6), 0.65)).toBe(0);
    expect(vectorRelevance(scoreForCosine(0.6), 0.2)).toBeGreaterThan(0.45);
  });

  it("only the measured pipeline has a baseline; everything else is unmeasured", () => {
    const measured = embeddingPipelineId({ provider: "transformers.js", model: "Xenova/bge-m3" });
    expect(measured).toBe("transformers.js/Xenova/bge-m3");
    expect(embeddingNoiseBaseline(measured)).toBe(0.65);
    // Same model name on other runtimes, reduced dimensions or unnormalized vectors is a different pipeline.
    for (const route of [
      { provider: "ollama", model: "bge-m3" },
      { provider: "vllm", model: "BAAI/bge-m3" },
      { provider: "private", model: "bge-m3" },
      { provider: "transformers.js", model: "Xenova/bge-m3", requestedDimensions: 512 },
      { provider: "transformers.js", model: "Xenova/bge-m3", normalize: false },
      { provider: "openai", model: "text-embedding-3-small" },
    ]) {
      expect(embeddingNoiseBaseline(embeddingPipelineId(route))).toBeNull();
    }
    expect(embeddingPipelineId(null)).toBeNull();
    // The measured floor is for mean pooling; CLS cosines sit elsewhere, so CLS gets no floor until measured.
    expect(embeddingNoiseBaseline(embeddingPipelineId({ provider: "transformers.js", model: "Xenova/bge-m3", pooling: "cls" }))).toBeNull();
    expect(embeddingNoiseBaseline(embeddingPipelineId({ provider: "transformers.js", model: "Xenova/bge-m3", pooling: "mean" }))).toBe(0.65);
    expect(embeddingNoiseBaseline(undefined)).toBeNull();
    expect(embeddingNoiseBaseline("some-unknown-model")).toBeNull();
  });

  it("separates synthetic noise and signal score distributions at the default floor", () => {
    // Unrelated pairs sit at or below the baseline; real matches sit well above it.
    // Ranges follow the bge-m3 probe measurements documented in relevance.ts.
    const baseline = embeddingNoiseBaseline("transformers.js/Xenova/bge-m3")!;
    const noise = Array.from({ length: 50 }, (_, i) => 0.55 + (i / 49) * (baseline + 0.03 - 0.55));
    const signal = Array.from({ length: 50 }, (_, i) => 0.7 + (i / 49) * 0.2);
    const survivors = (cosines: number[]) => cosines.filter((cosine) => vectorRelevance(scoreForCosine(cosine), baseline) >= DEFAULT_MIN_SCORE).length;
    expect(survivors(noise)).toBe(0);
    expect(survivors(signal)).toBe(50);
  });

  it("measures query term coverage with light stemming and ignores filler words", () => {
    expect(termCoverage("tax clauses", "The taxation clause applies.")).toBe(1);
    expect(termCoverage("how do I reset my password", "To reset a password, open settings.")).toBe(1);
    expect(termCoverage("zxqvbn nonsense gibberish", "A nonsense clause about taxes.")).toBeCloseTo(1 / 3, 10);
    expect(termCoverage("the of and", "anything")).toBe(0);
    expect(termCoverage("税金", "この税金は")).toBe(1);
  });

  it("counts lexical evidence only for a majority of the query terms", () => {
    expect(lexicalRelevance("zxqvbn nonsense gibberish", "A nonsense clause about taxes.")).toBe(0);
    expect(lexicalRelevance("refund policy enterprise", "Our refund policy is simple.")).toBeCloseTo(2 / 3, 10);
    expect(lexicalRelevance("invoice", "Invoice 42")).toBe(1);
  });

  it("does not vector-filter an unmeasured pipeline, even for low cosines", () => {
    const lowCosine = chunk("a", { score: scoreForCosine(0.25) });
    const noise = chunk("b", { score: scoreForCosine(0.0) });
    const lists = (embeddingPipeline: string | null) => annotateEvidenceRelevance(
      [{ adapter: "vector", chunks: [lowCosine, noise] }],
      { query: "anything", embeddingPipeline },
    )[0]!.map((c) => c.relevance);
    expect(lists("openai/text-embedding-3-small")).toEqual([1, 1]);
    expect(lists(null)).toEqual([1, 1]);
    // The measured pipeline still drops the same cosines.
    expect(lists("transformers.js/Xenova/bge-m3")).toEqual([0, 0]);
  });

  it("scores phrase rows against the phrase they matched", () => {
    const query = "what is the capital of mongolia";
    // An exact multi-word phrase from a long question is strong evidence.
    expect(phraseRelevance(query, "Ulaanbaatar is the capital of Mongolia, home to half the country.")).toBe(1);
    // Incidental text on a single query word is not, even though the row came from the phrase query.
    expect(phraseRelevance(query, "Madrid is the capital of a different country.")).toBe(0);
    expect(phraseRelevance(query, "The capital markets desk opened.")).toBe(0);
    const phrase = chunk("p", { text: "Ulaanbaatar is the capital of Mongolia.", lexicalMatch: "phrase" });
    const incidental = chunk("q", { text: "Madrid is the capital of Spain.", lexicalMatch: "phrase" });
    const backoff = chunk("r", { text: "Ulaanbaatar is the capital of Mongolia.", lexicalMatch: "partial" });
    const backoffOneTerm = chunk("s", { text: "The capital markets desk opened.", lexicalMatch: "partial" });
    const [lexical] = annotateEvidenceRelevance(
      [{ adapter: "lexical", chunks: [phrase, incidental, backoff, backoffOneTerm] }],
      { query },
    );
    expect(lexical!.map((c) => c.relevance)).toEqual([1, 0, 1, 0]);
  });

  it("keeps the strict majority for OR-backoff rows on two-term queries", () => {
    expect(lexicalRelevance("capital mongolia", "The capital markets desk opened.")).toBe(0);
    expect(lexicalRelevance("capital mongolia", "Capital of Mongolia")).toBe(1);
  });

  it("scores each retrieval branch and keeps the best signal", () => {
    const strong = chunk("a", { score: scoreForCosine(0.8), text: "alpha" });
    const weak = chunk("b", { score: scoreForCosine(0.1), text: "beta" });
    const lexicalStrict = chunk("c", { text: "unrelated words" });
    const lexicalPartial = chunk("d", { text: "only nonsense here", lexicalMatch: "partial" });
    const graph = chunk("e", { text: "entity neighbour" });
    const [vector, lexical, graphList] = annotateEvidenceRelevance([
      { adapter: "vector", chunks: [strong, weak] },
      { adapter: "lexical", chunks: [lexicalStrict, lexicalPartial] },
      { adapter: "graph", chunks: [graph] },
    ], { query: "zxqvbn nonsense gibberish", embeddingPipeline: "transformers.js/Xenova/bge-m3" });
    expect(vector!.map((c) => c.relevance!.toFixed(2))).toEqual(["0.43", "0.00"]);
    expect(lexical!.map((c) => c.relevance)).toEqual([1, 0]);
    expect(graphList![0]!.relevance).toBe(1);
  });

  it("applies the floor, keeps unmeasured chunks, and treats 0 as disabled", () => {
    const chunks = [chunk("a", { relevance: 0.9 }), chunk("b", { relevance: 0.05 }), chunk("c")];
    expect(applyRelevanceFloor(chunks, 0.1).kept.map((c) => c.id)).toEqual(["a", "c"]);
    expect(applyRelevanceFloor(chunks, 0.1).dropped).toBe(1);
    expect(applyRelevanceFloor(chunks, 0.95).kept.map((c) => c.id)).toEqual(["c"]);
    const off = applyRelevanceFloor(chunks, 0);
    expect(off.kept).toHaveLength(3);
    expect(off.dropped).toBe(0);
  });

  it("resolves the floor from the request, then the environment, then the default", () => {
    expect(resolveMinScore(undefined, {})).toBe(DEFAULT_MIN_SCORE);
    expect(resolveMinScore(undefined, { SEARCH_MIN_SCORE: "0.3" })).toBe(0.3);
    expect(resolveMinScore(undefined, { SEARCH_MIN_SCORE: "nonsense" })).toBe(DEFAULT_MIN_SCORE);
    expect(resolveMinScore(undefined, { SEARCH_MIN_SCORE: "7" })).toBe(1);
    expect(resolveMinScore(0, { SEARCH_MIN_SCORE: "0.3" })).toBe(0);
    expect(resolveMinScore(0.6, { SEARCH_MIN_SCORE: "0.3" })).toBe(0.6);
  });
});

describe("relevance floor in the search session", () => {
  const weak = [chunk("w1", { relevance: 0, text: "formula fragment" }), chunk("w2", { relevance: 0.02, text: "tax clause" })];
  const strong = [chunk("s1", { relevance: 0.8 }), chunk("s2", { relevance: 0.5 })];

  it("returns no results and a no-match signal when only weak chunks were retrieved", async () => {
    const response = await run({ lists: [weak] });
    expect(response.results).toEqual([]);
    expect(response.relevanceFloor).toEqual({ minScore: DEFAULT_MIN_SCORE, dropped: 2, noMatch: true });
  });

  it("leaves strong results unchanged and reports each result's relevance", async () => {
    const response = await run({ lists: [strong] });
    expect(response.results.map((r) => r.citation.documentId)).toEqual(["doc-s1", "doc-s2"]);
    expect(response.results.map((r) => r.relevance)).toEqual([0.8, 0.5]);
    expect(response.relevanceFloor).toEqual({ minScore: DEFAULT_MIN_SCORE, dropped: 0, noMatch: false });
  });

  it("drops only the weak tail of a mixed result set", async () => {
    const response = await run({ lists: [[strong[0]!, weak[0]!, strong[1]!]] });
    expect(response.results.map((r) => r.citation.documentId)).toEqual(["doc-s1", "doc-s2"]);
    expect(response.relevanceFloor).toMatchObject({ dropped: 1, noMatch: false });
  });

  it("keeps the best relevance a chunk earned on any branch after fusion", async () => {
    const response = await run({ lists: [[chunk("x", { relevance: 0 })], [chunk("x", { relevance: 0.7 })]] });
    expect(response.results.map((r) => r.relevance)).toEqual([0.7]);
  });

  it("disables the floor with minScore 0", async () => {
    const response = await run({ lists: [weak], minScore: 0 });
    expect(response.results).toHaveLength(2);
    expect(response.relevanceFloor).toEqual({ minScore: 0, dropped: 0, noMatch: false });
  });

  it("honors a stricter request floor", async () => {
    const response = await run({ lists: [strong], minScore: 0.6 });
    expect(response.results.map((r) => r.citation.documentId)).toEqual(["doc-s1"]);
  });

  it("does not hand back the whole corpus when the floor rejected the candidates", async () => {
    const wholeCorpusFallback = vi.fn(async () => [] as never[]);
    await run({ lists: [weak], wholeCorpusFallback });
    expect(wholeCorpusFallback).not.toHaveBeenCalled();
  });

  it("still tries the whole-corpus fallback when nothing was retrieved at all", async () => {
    const wholeCorpusFallback = vi.fn(async () => [] as never[]);
    await run({ lists: [[]], wholeCorpusFallback });
    expect(wholeCorpusFallback).toHaveBeenCalledOnce();
  });

  it("leaves an empty or still-indexing corpus to availability instead of reporting no match", async () => {
    expect((await run({ lists: [weak], status: "pending" })).relevanceFloor?.noMatch).toBe(false);
    expect((await run({ lists: [[]], status: "empty" })).relevanceFloor?.noMatch).toBe(false);
  });

  it("carries relevance through recursive-plan result round trips", async () => {
    const response = await run({ lists: [strong] });
    expect(searchResultsToChunks(response.results).map((c) => c.relevance)).toEqual([0.8, 0.5]);
  });
});

describe("relevance floor across recursive search modes", () => {
  const emptyResponse = (dropped: number) => ({
    results: [], sessionId: "sub", availability: availability("complete"),
    relevanceFloor: { minScore: DEFAULT_MIN_SCORE, dropped, noMatch: true },
  });

  it("carries the sub-searches' floor rejections into the final response and blocks the corpus fallback", async () => {
    const { planRecursiveSearchMode } = await import("../search/session-planner.js");
    const runSearch = vi.fn(async (_q: string, _u: string, _o: unknown) => emptyResponse(3));
    const plan = await planRecursiveSearchMode({
      query: "zxqvbn nonsense gibberish and also another unrelated gibberish question",
      userId: "user-1", options: { queryDecompose: true } as never, session: session(),
      privacyMode: "standard" as never, runSearch: runSearch as never,
    });
    expect(plan).not.toBeNull();
    expect(runSearch.mock.calls.length).toBeGreaterThan(1);
    expect(plan!.chunks).toEqual([]);
    expect(plan!.relevanceFloorDropped).toBe(3 * runSearch.mock.calls.length);

    const { finalizeSearchSessionExecution } = await import("../search/session-execution.js");
    const wholeCorpusFallback = vi.fn(async () => [] as never[]);
    const response = await finalizeSearchSessionExecution({
      query: "q", userId: "user-1", session: session(), options: {}, workspaceId: "ws-1",
      availability: availability("complete"), chunks: plan!.chunks, effectiveQuery: "q", filters: undefined,
      selfQueryReasons: [], wholeCorpusFallback,
      relevanceFloor: { minScore: DEFAULT_MIN_SCORE, dropped: plan!.relevanceFloorDropped },
    } as never);
    expect(wholeCorpusFallback).not.toHaveBeenCalled();
    expect(response.relevanceFloor).toEqual({ minScore: DEFAULT_MIN_SCORE, dropped: plan!.relevanceFloorDropped, noMatch: true });
  });
});


describe("explicit candidate windows and ordering through session execution", () => {
  it("caps the fused pool independently of output size and does not refill floor removals", async () => {
    const xs = [chunk("a", { relevance: 0 }), chunk("b", { relevance: 1 }), chunk("c", { relevance: 1 })];
    const response = await run({ lists: [xs], candidateDepth: 2, resultOrder: "relevance", minScore: .5, limit: 10 });
    expect(response.results.map(r => r.citation.documentId)).toEqual(["doc-b"]);
    expect(response.relevanceFloor?.dropped).toBe(1);
  });

  it("uses fusion relevance rather than incomparable adapter scores and packs without reranking", async () => {
    const xs = Array.from({ length: 10 }, (_, i) => chunk(String(i), { score: i + 1, relevance: 1 }));
    const relevance = await run({ lists: [xs], candidateDepth: 10, resultOrder: "relevance", minScore: 0 });
    const prompt = await run({ lists: [xs], candidateDepth: 10, resultOrder: "prompt", minScore: 0 });
    expect(relevance.results[0].citation.documentId).toBe("doc-0");
    expect(prompt.results[9].citation.documentId).toBe("doc-1");
    expect(new Set(prompt.results.map(r => r.citation.documentId))).toEqual(new Set(relevance.results.map(r => r.citation.documentId)));
  });
});
